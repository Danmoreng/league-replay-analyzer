import { describe, expect, it } from "vite-plus/test";

import { parseReplayBuffer } from "./replayParser";

describe("parseReplayBuffer", () => {
  it("extracts embedded replay metadata and player stats", () => {
    const text =
      "RIOT" +
      "\u0002\u0000" +
      "padding" +
      "16.5.752.7101" +
      "\u0000\u0000" +
      "noise" +
      '{"gameLength":123456,"lastGameChunkId":66,"lastKeyFrameId":32,"statsJson":"[{\\"TEAM\\":\\"100\\",\\"SKIN\\":\\"Ornn\\",\\"RIOT_ID_GAME_NAME\\":\\"TheBearinator\\",\\"RIOT_ID_TAG_LINE\\":\\"BABBA\\",\\"TEAM_POSITION\\":\\"TOP\\",\\"WIN\\":\\"Win\\",\\"CHAMPIONS_KILLED\\":\\"3\\",\\"NUM_DEATHS\\":\\"7\\",\\"ASSISTS\\":\\"6\\",\\"GOLD_EARNED\\":\\"10373\\",\\"TOTAL_DAMAGE_DEALT_TO_CHAMPIONS\\":\\"27239\\",\\"VISION_SCORE\\":\\"17\\"}]"}';

    const bytes = new Uint8Array(text.split("").map((char) => char.charCodeAt(0)));
    const summary = parseReplayBuffer(bytes.buffer);

    expect(summary.gameVersion).toBe("16.5.752.7101");
    expect(summary.gameLengthMillis).toBe(123456);
    expect(summary.lastGameChunkId).toBe(66);
    expect(summary.lastKeyFrameId).toBe(32);
    expect(summary.playerCount).toBe(1);
    expect(summary.players[0]).toMatchObject({
      champion: "Ornn",
      team: 100,
      kills: 3,
      deaths: 7,
      assists: 6,
      goldEarned: 10373,
      totalDamageToChampions: 27239,
      visionScore: 17,
    });
  });
});
