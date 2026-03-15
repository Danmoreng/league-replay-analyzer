#include <cstdlib>
#include <string>
#include <vector>

#include "rofl/core/replay_analyzer.hpp"

int main() {
    const std::string synthetic =
        std::string{"RIOT"} +
        std::string{"\x02\x00"} +
        std::string{"padding"} +
        std::string{"16.5.752.7101"} +
        std::string{"\x00\x00"} +
        std::string{"noise-before-json"} +
        std::string{"{\"gameLength\":123456,\"lastGameChunkId\":66,\"lastKeyFrameId\":32,\"statsJson\":\"[{\\\"TEAM\\\":\\\"100\\\",\\\"SKIN\\\":\\\"Ornn\\\",\\\"RIOT_ID_GAME_NAME\\\":\\\"TheBearinator\\\",\\\"RIOT_ID_TAG_LINE\\\":\\\"BABBA\\\",\\\"TEAM_POSITION\\\":\\\"TOP\\\",\\\"WIN\\\":\\\"Win\\\",\\\"CHAMPIONS_KILLED\\\":\\\"3\\\",\\\"NUM_DEATHS\\\":\\\"7\\\",\\\"ASSISTS\\\":\\\"6\\\",\\\"GOLD_EARNED\\\":\\\"10373\\\",\\\"TOTAL_DAMAGE_DEALT_TO_CHAMPIONS\\\":\\\"27239\\\",\\\"VISION_SCORE\\\":\\\"17\\\"}]\"}"};

    const std::vector<std::uint8_t> bytes(synthetic.begin(), synthetic.end());
    const auto summary = rofl::core::parse_replay_bytes(bytes);

    if (summary.game_version != "16.5.752.7101") {
        return EXIT_FAILURE;
    }
    if (summary.game_length_millis != 123456 || summary.last_game_chunk_id != 66 || summary.last_keyframe_id != 32) {
        return EXIT_FAILURE;
    }
    if (summary.players.size() != 1) {
        return EXIT_FAILURE;
    }

    const auto& player = summary.players.front();
    if (player.champion != "Ornn" || player.team != 100 || player.kills != 3 || player.deaths != 7 || player.assists != 6) {
        return EXIT_FAILURE;
    }
    if (player.gold_earned != 10373 || player.total_damage_to_champions != 27239 || player.vision_score != 17) {
        return EXIT_FAILURE;
    }

    const std::string json = rofl::core::replay_summary_to_json(summary);
    if (json.find("\"playerCount\":1") == std::string::npos) {
        return EXIT_FAILURE;
    }

    return EXIT_SUCCESS;
}
