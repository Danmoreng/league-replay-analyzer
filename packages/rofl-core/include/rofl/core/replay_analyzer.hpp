#pragma once

#include <cstddef>
#include <cstdint>
#include <string>
#include <string_view>
#include <vector>

namespace rofl::core {

struct BuildInfo {
    std::string version;
    std::string parser_state;
    std::string wasm_state;
};

struct PlayerSummary {
    std::string champion;
    std::string riot_id_game_name;
    std::string riot_id_tag_line;
    std::string team_position;
    std::string win;
    int team = 0;
    int kills = 0;
    int deaths = 0;
    int assists = 0;
    int gold_earned = 0;
    int total_damage_to_champions = 0;
    int vision_score = 0;
};

struct ReplaySegmentSummary {
    int id = 0;
    std::string type;
    int length = 0;
    int chunk_id = 0;
    int offset = 0;
    int header_offset = 0;
    int payload_offset = 0;
    int uncompressed_length = 0;
    std::string codec;
};

struct ReplayContainerSummary {
    std::string format;
    std::string metadata_source;
    std::size_t metadata_offset = 0;
    std::size_t metadata_size = 0;
    std::size_t payload_header_offset = 0;
    std::size_t payload_header_size = 0;
    std::size_t payload_offset = 0;
    std::uint64_t match_id = 0;
    int keyframe_count = 0;
    int chunk_count = 0;
    int startup_chunk_end_id = 0;
    int game_start_chunk_id = 0;
    int keyframe_interval_millis = 0;
    bool binary_header_present = false;
    bool payload_header_present = false;
    bool segment_table_present = false;
    std::vector<ReplaySegmentSummary> segments;
};

struct ReplayCapabilities {
    bool metadata_available = false;
    bool player_stats_available = false;
    bool binary_header_available = false;
    bool payload_header_available = false;
    bool segment_table_available = false;
    bool payload_decoding_available = false;
    bool movement_timeline_available = false;
};

struct ReplaySummary {
    std::string game_version;
    std::string metadata_json;
    std::size_t file_size = 0;
    int game_length_millis = 0;
    int last_game_chunk_id = 0;
    int last_keyframe_id = 0;
    ReplayContainerSummary container;
    ReplayCapabilities capabilities;
    std::vector<std::string> warnings;
    std::vector<PlayerSummary> players;
};

[[nodiscard]] BuildInfo get_build_info();
[[nodiscard]] std::string describe_scaffold();
[[nodiscard]] std::string normalize_version_label(std::string_view version);
[[nodiscard]] ReplaySummary parse_replay_bytes(const std::vector<std::uint8_t>& bytes);
[[nodiscard]] ReplaySummary parse_replay_file(const std::string& path);
[[nodiscard]] std::string probe_replay_bytes(const std::vector<std::uint8_t>& bytes);
[[nodiscard]] std::string probe_replay_file(const std::string& path);
[[nodiscard]] std::string replay_summary_to_json(const ReplaySummary& summary);

}  // namespace rofl::core



