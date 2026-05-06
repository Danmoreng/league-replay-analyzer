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
[[nodiscard]] std::string inspect_replay_bytes(const std::vector<std::uint8_t>& bytes);
[[nodiscard]] std::string inspect_replay_file(const std::string& path);
[[nodiscard]] std::string replay_summary_to_json(const ReplaySummary& summary);
[[nodiscard]] std::string scan_replay_families_json(const std::vector<std::uint8_t>& bytes, std::size_t minimum_length, std::size_t minimum_records, std::size_t top_families, std::string_view segment_type = "chunk");
[[nodiscard]] std::string scan_replay_families_file_json(const std::string& path, std::size_t minimum_length, std::size_t minimum_records, std::size_t top_families, std::string_view segment_type = "chunk");
[[nodiscard]] std::string analyze_sparse_family_json(const std::vector<std::uint8_t>& bytes, std::size_t target_length, std::uint8_t target_first_byte, std::size_t header_size, std::size_t stride, std::size_t top_slots, float move_epsilon, float smooth_threshold, std::string_view segment_type = "chunk");
[[nodiscard]] std::string analyze_scalar_family_json(const std::vector<std::uint8_t>& bytes, std::size_t target_length, std::uint8_t target_first_byte, std::size_t header_size, std::size_t stride, std::size_t top_slots, std::string_view segment_type = "chunk");
[[nodiscard]] std::string analyze_scalar_family_file_json(const std::string& path, std::size_t target_length, std::uint8_t target_first_byte, std::size_t header_size, std::size_t stride, std::size_t top_slots, std::string_view segment_type = "chunk");
[[nodiscard]] std::string analyze_entity_slab_json(const std::vector<std::uint8_t>& bytes, std::size_t target_length, std::uint8_t target_first_byte, std::size_t header_size, std::size_t stride, std::size_t top_slots, std::string_view segment_type = "chunk");
[[nodiscard]] std::string analyze_entity_slab_file_json(const std::string& path, std::size_t target_length, std::uint8_t target_first_byte, std::size_t header_size, std::size_t stride, std::size_t top_slots, std::string_view segment_type = "chunk");
[[nodiscard]] std::string analyze_row_offsets_json(const std::vector<std::uint8_t>& bytes, std::size_t target_length, std::uint8_t target_first_byte, std::size_t header_size, std::size_t stride, const std::vector<std::size_t>& slot_indices, std::size_t top_fields, std::string_view segment_type = "chunk");
[[nodiscard]] std::string analyze_row_offsets_file_json(const std::string& path, std::size_t target_length, std::uint8_t target_first_byte, std::size_t header_size, std::size_t stride, const std::vector<std::size_t>& slot_indices, std::size_t top_fields, std::string_view segment_type = "chunk");
[[nodiscard]] std::string analyze_clean_row_offsets_json(const std::vector<std::uint8_t>& bytes, std::size_t target_length, std::uint8_t target_first_byte, std::size_t header_size, std::size_t stride, const std::vector<std::size_t>& slot_indices, std::size_t top_fields, std::string_view segment_type = "chunk");
[[nodiscard]] std::string analyze_clean_row_offsets_file_json(const std::string& path, std::size_t target_length, std::uint8_t target_first_byte, std::size_t header_size, std::size_t stride, const std::vector<std::size_t>& slot_indices, std::size_t top_fields, std::string_view segment_type = "chunk");
[[nodiscard]] std::string analyze_handle_links_json(const std::vector<std::uint8_t>& bytes, std::size_t target_length, std::uint8_t target_first_byte, std::size_t header_size, std::size_t stride, const std::vector<std::size_t>& slot_indices, std::size_t top_links, std::size_t top_families, std::string_view segment_type = "chunk");
[[nodiscard]] std::string analyze_handle_links_file_json(const std::string& path, std::size_t target_length, std::uint8_t target_first_byte, std::size_t header_size, std::size_t stride, const std::vector<std::size_t>& slot_indices, std::size_t top_links, std::size_t top_families, std::string_view segment_type = "chunk");
[[nodiscard]] std::string analyze_token_bitfields_json(const std::vector<std::uint8_t>& bytes, std::size_t target_length, std::uint8_t target_first_byte, std::size_t header_size, std::size_t stride, const std::vector<std::size_t>& slot_indices, std::size_t top_slices, std::size_t top_families, std::string_view segment_type = "chunk");
[[nodiscard]] std::string analyze_token_bitfields_file_json(const std::string& path, std::size_t target_length, std::uint8_t target_first_byte, std::size_t header_size, std::size_t stride, const std::vector<std::size_t>& slot_indices, std::size_t top_slices, std::size_t top_families, std::string_view segment_type = "chunk");
[[nodiscard]] std::string analyze_table_descriptors_json(const std::vector<std::uint8_t>& bytes, std::size_t target_length, std::uint8_t target_first_byte, std::size_t header_size, std::size_t stride, const std::vector<std::size_t>& slot_indices, std::size_t top_matches, std::string_view segment_type = "chunk");
[[nodiscard]] std::string analyze_table_descriptors_file_json(const std::string& path, std::size_t target_length, std::uint8_t target_first_byte, std::size_t header_size, std::size_t stride, const std::vector<std::size_t>& slot_indices, std::size_t top_matches, std::string_view segment_type = "chunk");
[[nodiscard]] std::string analyze_bitfield_schema_json(const std::vector<std::uint8_t>& bytes, std::size_t target_length, std::uint8_t target_first_byte, std::size_t header_size, std::size_t stride, const std::vector<std::size_t>& slot_indices, std::size_t top_windows, std::string_view segment_type = "chunk");
[[nodiscard]] std::string analyze_bitfield_schema_file_json(const std::string& path, std::size_t target_length, std::uint8_t target_first_byte, std::size_t header_size, std::size_t stride, const std::vector<std::size_t>& slot_indices, std::size_t top_windows, std::string_view segment_type = "chunk");
[[nodiscard]] std::string analyze_artifact_bundle_file_json(const std::string& path, std::size_t minimum_length, std::size_t minimum_records, std::size_t top_families, std::size_t top_entity_slots, std::size_t top_scalar_slots, std::size_t dynamic_slot_count, std::size_t mixed_slot_count, std::size_t handle_slot_count, std::size_t top_windows, std::size_t top_fields, bool skip_scalar, std::string_view segment_type = "chunk");
[[nodiscard]] std::string dump_chunk_subrecords(const std::string& path, int chunk_id);
[[nodiscard]] std::string summarize_subrecord_families(const std::string& path, std::size_t minimum_length, std::size_t minimum_records, std::size_t top_families);
[[nodiscard]] std::string dump_subrecord_family(const std::string& path, std::size_t target_length, std::uint8_t target_first_byte);
[[nodiscard]] std::string dump_subrecord_family_json(const std::string& path, std::size_t target_length, std::uint8_t target_first_byte, std::string_view segment_type = "chunk", std::size_t max_records = 16);
[[nodiscard]] std::string compare_subrecord_family(const std::string& path, std::size_t target_length, std::uint8_t target_first_byte, std::size_t prefix_bytes);
[[nodiscard]] std::string guess_stride(const std::string& path, std::size_t target_length, std::uint8_t target_first_byte, std::size_t header_size);
[[nodiscard]] std::string analyze_sparse_family(const std::string& path, std::size_t target_length, std::uint8_t target_first_byte, std::size_t header_size, std::size_t stride, std::size_t top_elements);
[[nodiscard]] std::string trace_sparse_slot(const std::string& path, std::size_t target_length, std::uint8_t target_first_byte, std::size_t header_size, std::size_t stride, std::size_t slot_index, std::size_t max_records);
[[nodiscard]] std::string profile_position_slots(const std::string& path, std::size_t target_length, std::uint8_t target_first_byte, std::size_t header_size, std::size_t stride, std::size_t top_slots, float move_epsilon, float smooth_threshold);
[[nodiscard]] std::string compare_position_classes(const std::string& path, std::size_t target_length, std::uint8_t target_first_byte, std::size_t header_size, std::size_t stride, std::size_t top_slots, std::size_t top_classes, float move_epsilon, float smooth_threshold);
[[nodiscard]] std::string export_positions_json(const std::string& path, std::size_t target_length, std::uint8_t target_first_byte, std::size_t header_size, std::size_t stride, const std::vector<std::size_t>& slots);
[[nodiscard]] std::string export_keyframe_state_candidates_json(const std::string& path);
[[nodiscard]] std::string compare_positions_with_api(const std::string& replay_path, const std::string& api_positions_path, std::size_t target_length, std::uint8_t target_first_byte, std::size_t header_size, std::size_t stride, std::size_t top_slots, float move_epsilon, float smooth_threshold, int chunk_time_millis, int chunk_base_id, int max_time_offsets);
[[nodiscard]] std::string compare_raw_positions_with_api(const std::string& replay_path, const std::string& api_positions_path, std::size_t target_length, std::uint8_t target_first_byte, std::size_t header_size, std::size_t stride, std::size_t top_slots, float move_epsilon, float smooth_threshold, int chunk_time_millis, int chunk_base_id, int max_time_offsets);
[[nodiscard]] std::string match_event_window(const std::string& replay_path, std::size_t target_length, std::uint8_t target_first_byte, std::size_t header_size, std::size_t stride, double event_x, double event_y, int timestamp_millis, int chunk_time_millis, int chunk_base_id, int chunk_radius, std::size_t top_slots, float move_epsilon, float smooth_threshold);

}  // namespace rofl::core











