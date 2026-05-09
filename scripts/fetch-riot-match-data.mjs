#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import { basename, resolve, join } from "node:path";
import process from "node:process";

const platformToRegionalRoute = {
  BR1: "americas",
  EUN1: "europe",
  EUW1: "europe",
  JP1: "asia",
  KR: "asia",
  LA1: "americas",
  LA2: "americas",
  NA1: "americas",
  OC1: "sea",
  PH2: "sea",
  RU: "europe",
  SG2: "sea",
  TH2: "sea",
  TR1: "europe",
  TW2: "sea",
  VN2: "sea",
};

function printHelp() {
  console.log(`Usage:
  node ./scripts/fetch-riot-match-data.mjs --replay <path-to-rofl> [options]

Options:
  --replay <path>         Replay file path. Can be provided multiple times.
  --api-key <key>         Riot development API key. Defaults to RIOT_API_KEY env var.
  --out-dir <path>        Output root. Defaults to ./replays/api.
  --platform <id>         Override platform ID when filename does not contain it.
  --match-id <id>         Override full match ID, e.g. EUW1_7779216102.
  --fetch-accounts        Also fetch /riot/account/v1/accounts/by-puuid for participants.
  --force                 Overwrite existing files if they already exist.
  --help                  Show this help text.

Examples:
  $env:RIOT_API_KEY = "RGAPI-..."
  node ./scripts/fetch-riot-match-data.mjs --replay .\\replays\\EUW1-7779216102.rofl
  node ./scripts/fetch-riot-match-data.mjs --replay .\\replays\\EUW1-7779216102.rofl --fetch-accounts
`);
}

function parseArgs(argv) {
  const args = {
    replayPaths: [],
    apiKey: process.env.RIOT_API_KEY ?? "",
    outDir: resolve("replays", "api"),
    platform: "",
    matchId: "",
    fetchAccounts: false,
    force: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help") {
      printHelp();
      process.exit(0);
    }
    if (arg === "--replay") {
      const value = argv[++index];
      if (!value) {
        throw new Error("Missing value for --replay");
      }
      args.replayPaths.push(resolve(value));
      continue;
    }
    if (arg === "--api-key") {
      const value = argv[++index];
      if (!value) {
        throw new Error("Missing value for --api-key");
      }
      args.apiKey = value;
      continue;
    }
    if (arg === "--out-dir") {
      const value = argv[++index];
      if (!value) {
        throw new Error("Missing value for --out-dir");
      }
      args.outDir = resolve(value);
      continue;
    }
    if (arg === "--platform") {
      const value = argv[++index];
      if (!value) {
        throw new Error("Missing value for --platform");
      }
      args.platform = value.toUpperCase();
      continue;
    }
    if (arg === "--match-id") {
      const value = argv[++index];
      if (!value) {
        throw new Error("Missing value for --match-id");
      }
      args.matchId = value.toUpperCase();
      continue;
    }
    if (arg === "--fetch-accounts") {
      args.fetchAccounts = true;
      continue;
    }
    if (arg === "--force") {
      args.force = true;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  if (args.replayPaths.length === 0) {
    throw new Error("At least one --replay path is required.");
  }
  if (!args.apiKey) {
    throw new Error("Missing Riot API key. Pass --api-key or set RIOT_API_KEY.");
  }

  return args;
}

function deriveReplayIdentity(replayPath, platformOverride, matchIdOverride) {
  if (matchIdOverride) {
    const [platformId, gameId] = matchIdOverride.split("_");
    if (!platformId || !gameId) {
      throw new Error(`Invalid --match-id value: ${matchIdOverride}. Expected PLATFORM_GAMEID.`);
    }
    const regionalRoute = platformToRegionalRoute[platformId];
    if (!regionalRoute) {
      throw new Error(`Unsupported platform ID in --match-id: ${platformId}`);
    }
    return {
      replayPath,
      replayName: basename(replayPath),
      platformId,
      gameId,
      matchId: `${platformId}_${gameId}`,
      regionalRoute,
    };
  }

  const replayName = basename(replayPath);
  const filenameMatch = replayName.match(/^([A-Za-z0-9]+)-(\d+)\.rofl$/);
  const platformId = (platformOverride || filenameMatch?.[1] || "").toUpperCase();
  const gameId = filenameMatch?.[2] || "";
  if (!platformId || !gameId) {
    throw new Error(
      `Could not derive match identity from ${replayName}. Use --platform and --match-id if the filename does not match PLATFORM-GAMEID.rofl.`,
    );
  }

  const regionalRoute = platformToRegionalRoute[platformId];
  if (!regionalRoute) {
    throw new Error(`Unsupported platform ID: ${platformId}`);
  }

  return {
    replayPath,
    replayName,
    platformId,
    gameId,
    matchId: `${platformId}_${gameId}`,
    regionalRoute,
  };
}

async function sleep(ms) {
  await new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function requestJson(url, apiKey, retries = 2) {
  const response = await fetch(url, {
    headers: {
      "X-Riot-Token": apiKey,
      Accept: "application/json",
    },
  });

  if (response.status === 429 && retries > 0) {
    const retryAfterSeconds = Number(response.headers.get("Retry-After") || "1");
    await sleep(Math.max(1, retryAfterSeconds) * 1000);
    return requestJson(url, apiKey, retries - 1);
  }

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Request failed (${response.status}) for ${url}: ${body.slice(0, 400)}`);
  }

  return response.json();
}

async function maybeWriteJson(path, value, force) {
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  await writeFile(path, serialized, { encoding: "utf-8", flag: force ? "w" : "wx" });
}

async function fetchParticipantAccounts(match, regionalRoute, apiKey) {
  const participants = match?.metadata?.participants;
  if (!Array.isArray(participants) || participants.length === 0) {
    return [];
  }

  const accounts = [];
  for (const puuid of participants) {
    const url = `https://${regionalRoute}.api.riotgames.com/riot/account/v1/accounts/by-puuid/${encodeURIComponent(puuid)}`;
    const account = await requestJson(url, apiKey);
    accounts.push({ puuid, account });
    await sleep(120);
  }
  return accounts;
}

async function fetchReplayBundle(identity, options) {
  const baseUrl = `https://${identity.regionalRoute}.api.riotgames.com`;
  const matchUrl = `${baseUrl}/lol/match/v5/matches/${encodeURIComponent(identity.matchId)}`;
  const timelineUrl = `${baseUrl}/lol/match/v5/matches/${encodeURIComponent(identity.matchId)}/timeline`;

  const match = await requestJson(matchUrl, options.apiKey);
  await sleep(120);
  const timeline = await requestJson(timelineUrl, options.apiKey);
  const accounts = options.fetchAccounts
    ? await fetchParticipantAccounts(match, identity.regionalRoute, options.apiKey)
    : [];

  return {
    fetchedAt: new Date().toISOString(),
    identity,
    match,
    timeline,
    accounts,
    endpoints: {
      match: matchUrl,
      timeline: timelineUrl,
      accountByPuuid: options.fetchAccounts
        ? `${baseUrl}/riot/account/v1/accounts/by-puuid/{puuid}`
        : null,
    },
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  await mkdir(options.outDir, { recursive: true });

  for (const replayPath of options.replayPaths) {
    const identity = deriveReplayIdentity(replayPath, options.platform, options.matchId);
    const bundle = await fetchReplayBundle(identity, options);
    const matchDir = join(options.outDir, identity.matchId);
    await mkdir(matchDir, { recursive: true });

    const manifest = {
      replayPath: identity.replayPath,
      replayName: identity.replayName,
      platformId: identity.platformId,
      regionalRoute: identity.regionalRoute,
      gameId: identity.gameId,
      matchId: identity.matchId,
      fetchedAt: bundle.fetchedAt,
      files: {
        match: "match.json",
        timeline: "timeline.json",
        accounts: options.fetchAccounts ? "accounts.json" : null,
      },
      endpoints: bundle.endpoints,
    };

    await maybeWriteJson(join(matchDir, "manifest.json"), manifest, options.force);
    await maybeWriteJson(join(matchDir, "match.json"), bundle.match, options.force);
    await maybeWriteJson(join(matchDir, "timeline.json"), bundle.timeline, options.force);
    if (options.fetchAccounts) {
      await maybeWriteJson(join(matchDir, "accounts.json"), bundle.accounts, options.force);
    }

    console.log(`Fetched Riot API data for ${identity.matchId} -> ${matchDir}`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
