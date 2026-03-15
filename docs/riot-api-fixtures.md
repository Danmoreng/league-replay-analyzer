# Riot API Fixture Fetching

This repo includes a local helper for fetching official Riot match data that corresponds to a replay file.

## Why this exists

The replay parser still needs external anchors for event correlation and field validation.

Using official match and timeline data helps us:

- confirm that a replay is tied to the expected game
- align chunk and keyframe ordering against known objective and kill events
- build deterministic `replay + match + timeline` fixture bundles for reverse-engineering work

This helper is intended for local research and fixture generation. It is not part of the runtime product path.

## Input assumptions

The script derives the Riot match ID from replay filenames that follow the local naming pattern:

- `EUW1-7779216102.rofl` -> match ID `EUW1_7779216102`

That matches Riot's Match-V5 identifier format for standard LoL matches.

If a replay filename does not follow that convention, pass `--match-id` explicitly.

## Usage

PowerShell:

```powershell
$env:RIOT_API_KEY = "RGAPI-..."
npm run fetch:riot -- --replay .\replays\EUW1-7779216102.rofl
```

Multiple replays:

```powershell
$env:RIOT_API_KEY = "RGAPI-..."
npm run fetch:riot -- --replay .\replays\EUW1-7779216102.rofl --replay .\replays\EUW1-7689604967.rofl
```

Also fetch account records for all participant PUUIDs:

```powershell
$env:RIOT_API_KEY = "RGAPI-..."
npm run fetch:riot -- --replay .\replays\EUW1-7779216102.rofl --fetch-accounts
```

## Publishing To The Web App

The web data browser loads Riot fixture bundles from `apps/web/public/riot-api-fixtures/`.

After fetching or refreshing fixture data, publish it into the frontend assets with:

```powershell
npm run publish:riot-fixtures
```

That copies `replays/api/` into the web app's static asset directory so the browser can auto-load the matching `match.json` and `timeline.json` bundle from the replay filename.

## Output layout

By default the helper writes into `replays/api/<MATCH_ID>/`:

- `manifest.json`
- `match.json`
- `timeline.json`
- `accounts.json` when `--fetch-accounts` is enabled

Example:

- `replays/api/EUW1_7779216102/manifest.json`
- `replays/api/EUW1_7779216102/match.json`
- `replays/api/EUW1_7779216102/timeline.json`

## Notes

- Riot development keys expire quickly. Expect to refresh the key regularly.
- The helper uses Riot's regional routing values inferred from the replay platform prefix.
- The helper writes files locally and keeps the API key out of the web frontend.
- If files already exist, pass `--force` to overwrite them.
