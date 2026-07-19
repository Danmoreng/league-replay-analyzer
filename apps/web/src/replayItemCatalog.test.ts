import { describe, expect, it } from "vite-plus/test";

import {
  ReplayItemCatalogResolver,
  replayDataDragonVersion,
  replayPatchFamily,
  resolveReplayItem,
  type DataDragonFetch,
} from "./replayItemCatalog";

function response(payload: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => payload };
}

function catalogFixture(name = "Zhonyas Stundenglas") {
  return {
    data: {
      "3157": {
        name,
        description: "<mainText><stats>105 Ability Power</stats><br>Time Stop</mainText>",
        image: { full: "3157.png" },
      },
    },
  };
}

describe("replay patch-bound Data Dragon item catalog", () => {
  it("derives the Data Dragon patch family from the replay build", () => {
    expect(replayPatchFamily("16.14.794.5912")).toBe("16.14");
    expect(replayPatchFamily("16.14")).toBe("16.14");
    expect(replayPatchFamily("unknown")).toBeNull();
    expect(replayDataDragonVersion("16.14.794.5912")).toBe("16.14.1");
    expect(replayDataDragonVersion("16.14.1.1")).toBeNull();
  });

  it("uses the exact pinned static build and resolves item presentation fields", async () => {
    const calls: string[] = [];
    const fetch: DataDragonFetch = async (url) => {
      calls.push(url);
      return response(catalogFixture());
    };
    const resolver = new ReplayItemCatalogResolver({
      fetch,
      cdnBase: "https://static.example/cdn/",
    });

    const loaded = await resolver.load("16.14.794.5912");

    expect(loaded).toMatchObject({
      available: true,
      catalog: { patchFamily: "16.14", dataDragonVersion: "16.14.1", resolvedLocale: "de_DE" },
    });
    if (!loaded.available) {
      throw new Error(loaded.error);
    }
    expect(resolveReplayItem(loaded.catalog, 3157)).toEqual({
      id: 3157,
      name: "Zhonyas Stundenglas",
      rawDescription: "<mainText><stats>105 Ability Power</stats><br>Time Stop</mainText>",
      description: "105 Ability Power Time Stop",
      iconUrl: "https://static.example/cdn/16.14.1/img/item/3157.png",
    });
    expect(resolveReplayItem(loaded.catalog, 99_999)).toBeNull();
    expect(calls).toEqual(["https://static.example/cdn/16.14.1/data/de_DE/item.json"]);
  });

  it("falls back from unavailable German static data to en_US", async () => {
    const calls: string[] = [];
    const fetch: DataDragonFetch = async (url) => {
      calls.push(url);
      return url.includes("/de_DE/")
        ? response({ status: "missing" }, false, 404)
        : response(catalogFixture("Zhonyas Hourglass"));
    };

    const loaded = await new ReplayItemCatalogResolver({ fetch }).load("16.14.794.5912");

    expect(loaded).toMatchObject({
      available: true,
      catalog: { requestedLocale: "de_DE", resolvedLocale: "en_US" },
    });
    expect(calls).toHaveLength(2);
  });

  it("caches static data by Data Dragon version and locale", async () => {
    let itemCalls = 0;
    const fetch: DataDragonFetch = async () => {
      itemCalls += 1;
      return response(catalogFixture());
    };
    const resolver = new ReplayItemCatalogResolver({ fetch });

    await resolver.load("16.14.794.5912");
    await resolver.load("16.14.794.5912");
    await resolver.load("16.14.794.5912", "en_US");

    expect(itemCalls).toBe(2);
  });

  it("fails softly so unknown IDs and network failures remain displayable as IDs", async () => {
    const networkFailure: DataDragonFetch = async () => {
      throw new TypeError("Network unavailable");
    };
    const loaded = await new ReplayItemCatalogResolver({ fetch: networkFailure }).load(
      "16.14.794.5912",
    );

    expect(loaded).toMatchObject({
      available: false,
      patchFamily: "16.14",
      requestedLocale: "de_DE",
      error: "Network unavailable",
    });
    expect(resolveReplayItem(undefined, 3157)).toBeNull();
    expect(resolveReplayItem(null, 0)).toBeNull();
  });

  it("keeps the runtime source strictly replay-version plus static Data Dragon data", async () => {
    const fetch: DataDragonFetch = async () => response(catalogFixture());
    const loaded = await new ReplayItemCatalogResolver({ fetch }).load("16.14.794.5912");

    if (!loaded.available) {
      throw new Error(loaded.error);
    }
    expect(loaded.catalog.source).toEqual({
      runtimeInput: "replay-version-and-static-data-dragon-only",
      riotApiInput: false,
      matchInput: false,
      timelineInput: false,
    });
  });
});
