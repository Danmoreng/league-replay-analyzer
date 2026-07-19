/**
 * Patch-bound, static item presentation data for replay-decoded item IDs.
 *
 * This module only consumes a replay's gameVersion and Riot Data Dragon's
 * public static catalog. It deliberately has no Match-V5 or Timeline input
 * path, and it never turns static data into replay state.
 */

const DATA_DRAGON_CDN_BASE = "https://ddragon.leagueoflegends.com/cdn";

/**
 * Presentation-only mapping frozen alongside each productive replay build.
 * Never select a moving "latest" Data Dragon revision at runtime.
 */
const DATA_DRAGON_VERSION_BY_REPLAY_BUILD: Readonly<Record<string, string>> = {
  "16.14.794.5912": "16.14.1",
};

export type DataDragonItemLocale = "de_DE" | "en_US";

export interface DataDragonItemDefinition {
  id: number;
  name: string;
  /** Data Dragon's original description, which can contain markup. */
  rawDescription: string;
  /** A text-only description suitable for direct rendering. */
  description: string;
  iconUrl: string | null;
}

export interface ReplayItemCatalog {
  gameVersion: string;
  patchFamily: string;
  dataDragonVersion: string;
  requestedLocale: DataDragonItemLocale;
  resolvedLocale: DataDragonItemLocale;
  source: {
    runtimeInput: "replay-version-and-static-data-dragon-only";
    riotApiInput: false;
    matchInput: false;
    timelineInput: false;
  };
  items: ReadonlyMap<number, DataDragonItemDefinition>;
}

export type ReplayItemCatalogLoadResult =
  | { available: true; catalog: ReplayItemCatalog }
  | {
      available: false;
      gameVersion: string;
      patchFamily: string | null;
      requestedLocale: DataDragonItemLocale;
      error: string;
    };

interface FetchResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

export type DataDragonFetch = (url: string) => Promise<FetchResponse>;

export interface ReplayItemCatalogResolverOptions {
  fetch?: DataDragonFetch;
  cdnBase?: string;
}

interface DataDragonItemPayload {
  data?: Record<string, { name?: unknown; description?: unknown; image?: { full?: unknown } }>;
}

function defaultFetch(url: string): Promise<FetchResponse> {
  return fetch(url);
}

function normalizedBase(url: string): string {
  return url.replace(/\/+$/, "");
}

function toText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function toPlainText(rawDescription: string): string {
  return rawDescription
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

export function replayPatchFamily(gameVersion: string): string | null {
  const match = gameVersion.trim().match(/^(\d+)\.(\d+)(?:\.\d+){0,2}$/);
  return match ? `${match[1]}.${match[2]}` : null;
}

export function replayDataDragonVersion(gameVersion: string): string | null {
  return DATA_DRAGON_VERSION_BY_REPLAY_BUILD[gameVersion.trim()] ?? null;
}

export function resolveReplayItem(
  catalog: ReplayItemCatalog | null | undefined,
  itemId: number,
): DataDragonItemDefinition | null {
  return Number.isSafeInteger(itemId) && itemId > 0 ? catalog?.items.get(itemId) ?? null : null;
}

export class ReplayItemCatalogResolver {
  private readonly fetchImpl: DataDragonFetch;
  private readonly cdnBase: string;
  private readonly catalogPromises = new Map<
    string,
    Promise<ReadonlyMap<number, DataDragonItemDefinition>>
  >();

  constructor(options: ReplayItemCatalogResolverOptions = {}) {
    this.fetchImpl = options.fetch ?? defaultFetch;
    this.cdnBase = normalizedBase(options.cdnBase ?? DATA_DRAGON_CDN_BASE);
  }

  async load(
    gameVersion: string,
    requestedLocale: DataDragonItemLocale = "de_DE",
  ): Promise<ReplayItemCatalogLoadResult> {
    const patchFamily = replayPatchFamily(gameVersion);
    if (!patchFamily) {
      return this.unavailable(
        gameVersion,
        null,
        requestedLocale,
        "Replay gameVersion has no patch family.",
      );
    }

    const dataDragonVersion = replayDataDragonVersion(gameVersion);
    if (!dataDragonVersion) {
      return this.unavailable(
        gameVersion,
        patchFamily,
        requestedLocale,
        `No pinned Data Dragon version exists for replay build ${gameVersion}.`,
      );
    }

    try {
      try {
        const items = await this.loadCatalog(dataDragonVersion, requestedLocale);
        return this.available(
          gameVersion,
          patchFamily,
          dataDragonVersion,
          requestedLocale,
          requestedLocale,
          items,
        );
      } catch (error) {
        if (requestedLocale !== "de_DE") {
          throw error;
        }

        const items = await this.loadCatalog(dataDragonVersion, "en_US");
        return this.available(
          gameVersion,
          patchFamily,
          dataDragonVersion,
          requestedLocale,
          "en_US",
          items,
        );
      }
    } catch (error) {
      return this.unavailable(gameVersion, patchFamily, requestedLocale, this.errorMessage(error));
    }
  }

  private available(
    gameVersion: string,
    patchFamily: string,
    dataDragonVersion: string,
    requestedLocale: DataDragonItemLocale,
    resolvedLocale: DataDragonItemLocale,
    items: ReadonlyMap<number, DataDragonItemDefinition>,
  ): ReplayItemCatalogLoadResult {
    return {
      available: true,
      catalog: {
        gameVersion,
        patchFamily,
        dataDragonVersion,
        requestedLocale,
        resolvedLocale,
        source: {
          runtimeInput: "replay-version-and-static-data-dragon-only",
          riotApiInput: false,
          matchInput: false,
          timelineInput: false,
        },
        items,
      },
    };
  }

  private unavailable(
    gameVersion: string,
    patchFamily: string | null,
    requestedLocale: DataDragonItemLocale,
    error: string,
  ): ReplayItemCatalogLoadResult {
    return { available: false, gameVersion, patchFamily, requestedLocale, error };
  }

  private async loadCatalog(
    dataDragonVersion: string,
    locale: DataDragonItemLocale,
  ): Promise<ReadonlyMap<number, DataDragonItemDefinition>> {
    const cacheKey = `${dataDragonVersion}/${locale}`;
    const cached = this.catalogPromises.get(cacheKey);
    if (cached) {
      return cached;
    }

    const promise = this.fetchJson(
      `${this.cdnBase}/${dataDragonVersion}/data/${locale}/item.json`,
    ).then((payload) => this.parseCatalog(payload, dataDragonVersion));
    this.catalogPromises.set(cacheKey, promise);

    try {
      return await promise;
    } catch (error) {
      this.catalogPromises.delete(cacheKey);
      throw error;
    }
  }

  private async fetchJson(url: string): Promise<unknown> {
    const response = await this.fetchImpl(url);
    if (!response.ok) {
      throw new Error(`Data Dragon request failed (${response.status}).`);
    }
    return response.json();
  }

  private parseCatalog(
    payload: unknown,
    dataDragonVersion: string,
  ): ReadonlyMap<number, DataDragonItemDefinition> {
    const data = (payload as DataDragonItemPayload | null)?.data;
    if (!data || typeof data !== "object") {
      throw new Error("Data Dragon item response is invalid.");
    }

    const items = new Map<number, DataDragonItemDefinition>();
    for (const [rawId, rawItem] of Object.entries(data)) {
      const id = Number(rawId);
      if (!Number.isSafeInteger(id) || id <= 0 || !rawItem || typeof rawItem !== "object") {
        continue;
      }

      const rawDescription = toText(rawItem.description);
      const iconFile = toText(rawItem.image?.full);
      items.set(id, {
        id,
        name: toText(rawItem.name) || `Item ${id}`,
        rawDescription,
        description: toPlainText(rawDescription),
        iconUrl: iconFile ? `${this.cdnBase}/${dataDragonVersion}/img/item/${iconFile}` : null,
      });
    }
    return items;
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : "Data Dragon item catalog is unavailable.";
  }
}

const defaultResolver = new ReplayItemCatalogResolver();

export function loadReplayItemCatalog(
  gameVersion: string,
  requestedLocale: DataDragonItemLocale = "de_DE",
): Promise<ReplayItemCatalogLoadResult> {
  return defaultResolver.load(gameVersion, requestedLocale);
}
