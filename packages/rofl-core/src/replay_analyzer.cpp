#include "rofl/core/replay_analyzer.hpp"
#include "rofl/core/packet_blocks.hpp"
#include <array>
#include <bit>
#include <charconv>
#include <cmath>
#include <limits>
#include <numeric>

#include <algorithm>
#include <cctype>
#include <chrono>
#include <ctime>
#include <filesystem>
#include <fstream>
#include <future>
#include <functional>
#include <iomanip>
#include <map>
#include <set>
#include <sstream>
#include <stdexcept>
#include <string_view>

#include <zstd.h>

namespace rofl::core {
namespace {

constexpr std::string_view kMetadataMarker = "{\"gameLength\":";
constexpr std::size_t kKnownHeaderLength = 288;
constexpr std::size_t kKnownPayloadHeaderMinimumSize = 34;
constexpr std::size_t kKnownSegmentHeaderLength = 17;
constexpr std::size_t kFooterLengthFieldSize = 4;
constexpr std::size_t kFooterRecordHeaderLength = 17;

[[nodiscard]] std::string normalize_segment_type_filter(std::string_view value) {
    std::string normalized;
    normalized.reserve(value.size());
    for (const char ch : value) {
        if (ch == ' ' || ch == '\t' || ch == '\r' || ch == '\n') {
            continue;
        }
        normalized.push_back(static_cast<char>(std::tolower(static_cast<unsigned char>(ch))));
    }

    if (normalized.empty()) {
        return "chunk";
    }
    if (normalized == "chunks") {
        return "chunk";
    }
    if (normalized == "keyframes") {
        return "keyframe";
    }
    return normalized;
}

[[nodiscard]] bool segment_type_matches_filter(std::string_view segment_type, std::string_view filter) {
    const std::string normalized_filter = normalize_segment_type_filter(filter);
    if (normalized_filter == "all" || normalized_filter == "any") {
        return true;
    }

    std::size_t start = 0;
    while (start <= normalized_filter.size()) {
        const std::size_t end = normalized_filter.find(',', start);
        const std::string_view token(
            normalized_filter.data() + start,
            (end == std::string::npos ? normalized_filter.size() : end) - start
        );
        if (token == segment_type) {
            return true;
        }
        if (end == std::string::npos) {
            break;
        }
        start = end + 1;
    }

    return false;
}

struct KnownBinaryHeader {
    std::uint16_t header_length = 0;
    std::uint32_t metadata_offset = 0;
    std::uint32_t metadata_length = 0;
    std::uint32_t payload_header_offset = 0;
    std::uint32_t payload_header_length = 0;
    std::uint32_t payload_offset = 0;
};

struct KnownPayloadHeader {
    std::uint64_t match_id = 0;
    std::uint32_t match_length = 0;
    std::uint32_t keyframe_count = 0;
    std::uint32_t chunk_count = 0;
    std::uint32_t startup_chunk_end_id = 0;
    std::uint32_t game_start_chunk_id = 0;
    std::uint32_t keyframe_interval = 0;
    std::uint16_t encryption_key_length = 0;
};

struct MetadataRegion {
    std::size_t offset = 0;
    std::size_t size = 0;
    std::string source;
    std::string format;
    std::string json;
};

struct FooterZstdRecord {
    std::size_t header_offset = 0;
    std::size_t payload_offset = 0;
    std::uint8_t id = 0;
    std::uint8_t related_id = 0;
    std::uint8_t kind = 0;
    std::uint32_t uncompressed_length = 0;
    std::uint32_t compressed_length = 0;
};

[[nodiscard]] bool is_digit(char value) {
    return value >= '0' && value <= '9';
}

[[nodiscard]] std::string bool_to_json(bool value) {
    return value ? "true" : "false";
}

[[nodiscard]] std::string json_escape(std::string_view input) {
    std::string escaped;
    escaped.reserve(input.size() + 16);

    for (const char ch : input) {
        switch (ch) {
            case '\\':
                escaped += "\\\\";
                break;
            case '"':
                escaped += "\\\"";
                break;
            case '\n':
                escaped += "\\n";
                break;
            case '\r':
                escaped += "\\r";
                break;
            case '\t':
                escaped += "\\t";
                break;
            default:
                escaped += ch;
                break;
        }
    }

    return escaped;
}

struct ArtifactSelectedSlots {
    std::vector<std::size_t> selected_slots;
    std::vector<std::size_t> dynamic_slots;
    std::vector<std::size_t> mixed_slots;
    std::vector<std::size_t> handle_slots;
};

[[nodiscard]] std::string_view trim_json_whitespace(std::string_view input) {
    while (!input.empty() && std::isspace(static_cast<unsigned char>(input.front())) != 0) {
        input.remove_prefix(1);
    }
    while (!input.empty() && std::isspace(static_cast<unsigned char>(input.back())) != 0) {
        input.remove_suffix(1);
    }
    return input;
}

[[nodiscard]] std::vector<std::size_t> extract_named_slot_indices(std::string_view json, std::string_view field_name) {
    const std::string needle = "\"" + std::string(field_name) + "\":[";
    const std::size_t field_pos = json.find(needle);
    if (field_pos == std::string_view::npos) {
        return {};
    }

    const std::size_t array_start = json.find('[', field_pos + needle.size() - 1);
    if (array_start == std::string_view::npos) {
        return {};
    }

    std::size_t depth = 0;
    std::size_t array_end = std::string_view::npos;
    for (std::size_t index = array_start; index < json.size(); ++index) {
        if (json[index] == '[') {
            depth += 1;
        } else if (json[index] == ']') {
            depth -= 1;
            if (depth == 0) {
                array_end = index;
                break;
            }
        }
    }

    if (array_end == std::string_view::npos || array_end <= array_start) {
        return {};
    }

    const std::string_view array_json = json.substr(array_start, (array_end - array_start) + 1);
    const std::string slot_needle = "\"slotIndex\":";
    std::vector<std::size_t> slots;
    std::size_t scan = 0;
    while (scan < array_json.size()) {
        const std::size_t slot_pos = array_json.find(slot_needle, scan);
        if (slot_pos == std::string_view::npos) {
            break;
        }
        std::size_t value_pos = slot_pos + slot_needle.size();
        while (value_pos < array_json.size() && std::isspace(static_cast<unsigned char>(array_json[value_pos])) != 0) {
            value_pos += 1;
        }
        std::size_t value_end = value_pos;
        while (value_end < array_json.size() && std::isdigit(static_cast<unsigned char>(array_json[value_end])) != 0) {
            value_end += 1;
        }
        if (value_end > value_pos) {
            slots.push_back(static_cast<std::size_t>(std::stoull(std::string(array_json.substr(value_pos, value_end - value_pos)))));
        }
        scan = value_end;
    }
    return slots;
}

[[nodiscard]] std::vector<std::size_t> take_top_slot_indices(std::vector<std::size_t> slots, std::size_t count, bool sort_by_slot_index) {
    if (count == 0 || slots.empty()) {
        return {};
    }
    if (sort_by_slot_index) {
        std::sort(slots.begin(), slots.end());
    }
    if (slots.size() > count) {
        slots.resize(count);
    }
    return slots;
}

[[nodiscard]] ArtifactSelectedSlots select_candidate_slots_from_entity_slab_json(
    std::string_view entity_slab_json,
    std::size_t dynamic_slot_count,
    std::size_t mixed_slot_count,
    std::size_t handle_slot_count
) {
    ArtifactSelectedSlots result;
    result.dynamic_slots = take_top_slot_indices(
        extract_named_slot_indices(entity_slab_json, "topDynamicSlots"),
        dynamic_slot_count,
        true);
    result.mixed_slots = take_top_slot_indices(
        extract_named_slot_indices(entity_slab_json, "topMixedSlots"),
        mixed_slot_count,
        false);
    result.handle_slots = take_top_slot_indices(
        extract_named_slot_indices(entity_slab_json, "topHandleSlots"),
        handle_slot_count,
        false);

    std::set<std::size_t> selected(
        result.dynamic_slots.begin(),
        result.dynamic_slots.end());
    selected.insert(result.mixed_slots.begin(), result.mixed_slots.end());
    selected.insert(result.handle_slots.begin(), result.handle_slots.end());
    result.selected_slots.assign(selected.begin(), selected.end());
    return result;
}

template <typename Number>
void write_number_array(std::ostringstream& output, const std::vector<Number>& values) {
    output << '[';
    for (std::size_t index = 0; index < values.size(); ++index) {
        if (index > 0) {
            output << ',';
        }
        output << values[index];
    }
    output << ']';
}

[[nodiscard]] std::size_t find_subsequence(const std::vector<std::uint8_t>& bytes, std::string_view needle) {
    if (needle.empty() || bytes.size() < needle.size()) {
        return std::string::npos;
    }

    for (std::size_t offset = 0; offset + needle.size() <= bytes.size(); ++offset) {
        bool match = true;
        for (std::size_t index = 0; index < needle.size(); ++index) {
            if (bytes[offset + index] != static_cast<std::uint8_t>(needle[index])) {
                match = false;
                break;
            }
        }

        if (match) {
            return offset;
        }
    }

    return std::string::npos;
}

[[nodiscard]] std::string scan_game_version(const std::vector<std::uint8_t>& bytes) {
    const std::size_t limit = std::min<std::size_t>(bytes.size(), 256);
    for (std::size_t offset = 0; offset < limit; ++offset) {
        if (!is_digit(static_cast<char>(bytes[offset]))) {
            continue;
        }

        std::size_t cursor = offset;
        int dot_count = 0;
        while (cursor < limit) {
            const char ch = static_cast<char>(bytes[cursor]);
            if (is_digit(ch)) {
                ++cursor;
                continue;
            }
            if (ch == '.') {
                ++dot_count;
                ++cursor;
                continue;
            }
            break;
        }

        if (dot_count == 3 && cursor > offset) {
            return std::string(reinterpret_cast<const char*>(bytes.data() + offset), cursor - offset);
        }
    }

    return "unknown";
}

[[nodiscard]] std::string extract_balanced_json(const std::vector<std::uint8_t>& bytes, std::size_t start_offset) {
    bool in_string = false;
    bool escape = false;
    int depth = 0;

    for (std::size_t offset = start_offset; offset < bytes.size(); ++offset) {
        const char ch = static_cast<char>(bytes[offset]);

        if (in_string) {
            if (escape) {
                escape = false;
            } else if (ch == '\\') {
                escape = true;
            } else if (ch == '"') {
                in_string = false;
            }
            continue;
        }

        if (ch == '"') {
            in_string = true;
            continue;
        }
        if (ch == '{') {
            ++depth;
            continue;
        }
        if (ch == '}') {
            --depth;
            if (depth == 0) {
                return std::string(reinterpret_cast<const char*>(bytes.data() + start_offset), offset - start_offset + 1);
            }
        }
    }

    throw std::runtime_error("Could not extract balanced metadata JSON from replay bytes.");
}

[[nodiscard]] std::size_t find_key(std::string_view json, std::string_view key) {
    return json.find(std::string("\"") + std::string(key) + "\"");
}

[[nodiscard]] std::size_t find_value_start(std::string_view json, std::string_view key) {
    const std::size_t key_offset = find_key(json, key);
    if (key_offset == std::string::npos) {
        return std::string::npos;
    }

    const std::size_t colon_offset = json.find(':', key_offset + key.size() + 2);
    if (colon_offset == std::string::npos) {
        return std::string::npos;
    }

    std::size_t value_offset = colon_offset + 1;
    while (value_offset < json.size() && std::isspace(static_cast<unsigned char>(json[value_offset])) != 0) {
        ++value_offset;
    }

    return value_offset;
}

[[nodiscard]] int parse_int_field(std::string_view json, std::string_view key) {
    const std::size_t value_offset = find_value_start(json, key);
    if (value_offset == std::string::npos) {
        return 0;
    }

    std::size_t cursor = value_offset;
    if (cursor < json.size() && json[cursor] == '"') {
        ++cursor;
    }

    bool negative = false;
    if (cursor < json.size() && json[cursor] == '-') {
        negative = true;
        ++cursor;
    }

    int value = 0;
    bool found_digit = false;
    while (cursor < json.size() && is_digit(json[cursor])) {
        found_digit = true;
        value = (value * 10) + static_cast<int>(json[cursor] - '0');
        ++cursor;
    }

    if (!found_digit) {
        return 0;
    }

    return negative ? -value : value;
}

[[nodiscard]] bool try_parse_int_field(
    std::string_view json,
    std::string_view key,
    int& value
) {
    const std::size_t value_offset = find_value_start(json, key);
    if (value_offset == std::string::npos || value_offset >= json.size()) return false;

    const bool quoted = json[value_offset] == '"';
    const std::size_t number_offset = value_offset + (quoted ? 1 : 0);
    if (number_offset >= json.size()) return false;
    const char* begin = json.data() + number_offset;
    const char* end = json.data() + json.size();
    int parsed = 0;
    const auto [parsed_end, error] = std::from_chars(begin, end, parsed);
    if (error != std::errc{} || parsed_end == begin) return false;

    if (quoted) {
        if (parsed_end >= end || *parsed_end != '"') return false;
    } else {
        const char* cursor = parsed_end;
        while (cursor < end && std::isspace(static_cast<unsigned char>(*cursor)) != 0) {
            ++cursor;
        }
        if (cursor < end && *cursor != ',' && *cursor != '}') return false;
    }
    value = parsed;
    return true;
}

[[nodiscard]] std::string parse_string_field(std::string_view json, std::string_view key) {
    const std::size_t value_offset = find_value_start(json, key);
    if (value_offset == std::string::npos || value_offset >= json.size() || json[value_offset] != '"') {
        return {};
    }

    std::string result;
    bool escape = false;
    for (std::size_t cursor = value_offset + 1; cursor < json.size(); ++cursor) {
        const char ch = json[cursor];
        if (escape) {
            switch (ch) {
                case '"':
                case '\\':
                case '/':
                    result += ch;
                    break;
                case 'n':
                    result += '\n';
                    break;
                case 'r':
                    result += '\r';
                    break;
                case 't':
                    result += '\t';
                    break;
                default:
                    result += ch;
                    break;
            }
            escape = false;
            continue;
        }

        if (ch == '\\') {
            escape = true;
            continue;
        }
        if (ch == '"') {
            return result;
        }

        result += ch;
    }

    return result;
}

[[nodiscard]] std::vector<std::string> split_top_level_objects(std::string_view json_array) {
    std::vector<std::string> objects;
    bool in_string = false;
    bool escape = false;
    int depth = 0;
    std::size_t object_start = std::string::npos;

    for (std::size_t offset = 0; offset < json_array.size(); ++offset) {
        const char ch = json_array[offset];

        if (in_string) {
            if (escape) {
                escape = false;
            } else if (ch == '\\') {
                escape = true;
            } else if (ch == '"') {
                in_string = false;
            }
            continue;
        }

        if (ch == '"') {
            in_string = true;
            continue;
        }

        if (ch == '{') {
            if (depth == 0) {
                object_start = offset;
            }
            ++depth;
            continue;
        }

        if (ch == '}') {
            --depth;
            if (depth == 0 && object_start != std::string::npos) {
                objects.emplace_back(json_array.substr(object_start, offset - object_start + 1));
                object_start = std::string::npos;
            }
        }
    }

    return objects;
}

[[nodiscard]] std::vector<PlayerSummary> parse_players_from_stats_json(
    const std::string& stats_json,
    bool& validated_final_fields
) {
    std::vector<PlayerSummary> players;
    const std::vector<std::string> participant_objects = split_top_level_objects(stats_json);
    validated_final_fields = !participant_objects.empty();
    for (const std::string& object_json : participant_objects) {
        PlayerSummary player;
        player.champion = parse_string_field(object_json, "SKIN");
        player.riot_id_game_name = parse_string_field(object_json, "RIOT_ID_GAME_NAME");
        player.riot_id_tag_line = parse_string_field(object_json, "RIOT_ID_TAG_LINE");
        player.team_position = parse_string_field(object_json, "TEAM_POSITION");
        if (player.team_position.empty()) {
            player.team_position = parse_string_field(object_json, "INDIVIDUAL_POSITION");
        }
        player.win = parse_string_field(object_json, "WIN");
        player.team = parse_int_field(object_json, "TEAM");
        player.kills = parse_int_field(object_json, "CHAMPIONS_KILLED");
        player.deaths = parse_int_field(object_json, "NUM_DEATHS");
        player.assists = parse_int_field(object_json, "ASSISTS");
        player.gold_earned = parse_int_field(object_json, "GOLD_EARNED");
        player.total_damage_to_champions = parse_int_field(object_json, "TOTAL_DAMAGE_DEALT_TO_CHAMPIONS");
        player.vision_score = parse_int_field(object_json, "VISION_SCORE");
        validated_final_fields =
            try_parse_int_field(object_json, "LEVEL", player.level) &&
            validated_final_fields;
        validated_final_fields =
            try_parse_int_field(object_json, "EXP", player.experience) &&
            validated_final_fields;
        validated_final_fields =
            try_parse_int_field(object_json, "MINIONS_KILLED", player.lane_minions_killed) &&
            validated_final_fields;
        validated_final_fields =
            try_parse_int_field(
                object_json,
                "NEUTRAL_MINIONS_KILLED",
                player.neutral_minions_killed
            ) && validated_final_fields;
        for (std::size_t item_index = 0; item_index < player.items.size(); ++item_index) {
            validated_final_fields = try_parse_int_field(
                object_json,
                "ITEM" + std::to_string(item_index),
                player.items[item_index]
            ) && validated_final_fields;
        }
        validated_final_fields =
            try_parse_int_field(object_json, "WARD_PLACED", player.wards_placed) &&
            validated_final_fields;
        validated_final_fields =
            try_parse_int_field(object_json, "WARD_KILLED", player.wards_killed) &&
            validated_final_fields;
        players.push_back(std::move(player));
    }

    return players;
}

[[nodiscard]] std::string replay_version_group(std::string_view game_version) {
    const std::size_t first_dot = game_version.find('.');
    if (first_dot == std::string_view::npos) return std::string(game_version);
    const std::size_t second_dot = game_version.find('.', first_dot + 1);
    return std::string(second_dot == std::string_view::npos
        ? game_version
        : game_version.substr(0, second_dot));
}

[[nodiscard]] bool supports_validated_final_player_stats(std::string_view game_version) {
    const std::string group = replay_version_group(game_version);
    static constexpr std::array<std::string_view, 8> supported{{
        "15.22", "15.23", "15.24", "16.1", "16.5", "16.6", "16.7", "16.9",
    }};
    return std::find(supported.begin(), supported.end(), group) != supported.end();
}

[[nodiscard]] std::vector<std::uint8_t> read_file_bytes(const std::string& path) {
    std::ifstream input(path, std::ios::binary);
    if (!input) {
        throw std::runtime_error("Could not open replay file: " + path);
    }

    input.seekg(0, std::ios::end);
    const std::streamoff size = input.tellg();
    input.seekg(0, std::ios::beg);

    if (size < 0) {
        throw std::runtime_error("Could not determine replay file size: " + path);
    }

    std::vector<std::uint8_t> bytes(static_cast<std::size_t>(size));
    if (!bytes.empty()) {
        input.read(reinterpret_cast<char*>(bytes.data()), static_cast<std::streamsize>(bytes.size()));
    }

    return bytes;
}

[[nodiscard]] bool is_range_valid(std::size_t offset, std::size_t length, std::size_t total_size) {
    return offset <= total_size && length <= (total_size - offset);
}

[[nodiscard]] bool read_u16_le(const std::vector<std::uint8_t>& bytes, std::size_t offset, std::uint16_t& value) {
    if (!is_range_valid(offset, sizeof(std::uint16_t), bytes.size())) {
        return false;
    }

    value = static_cast<std::uint16_t>(bytes[offset]) |
            (static_cast<std::uint16_t>(bytes[offset + 1]) << 8U);
    return true;
}

[[nodiscard]] bool read_u32_le(const std::vector<std::uint8_t>& bytes, std::size_t offset, std::uint32_t& value) {
    if (!is_range_valid(offset, sizeof(std::uint32_t), bytes.size())) {
        return false;
    }

    value = static_cast<std::uint32_t>(bytes[offset]) |
            (static_cast<std::uint32_t>(bytes[offset + 1]) << 8U) |
            (static_cast<std::uint32_t>(bytes[offset + 2]) << 16U) |
            (static_cast<std::uint32_t>(bytes[offset + 3]) << 24U);
    return true;
}

[[nodiscard]] bool read_u64_le(const std::vector<std::uint8_t>& bytes, std::size_t offset, std::uint64_t& value) {
    std::uint32_t lo = 0;
    std::uint32_t hi = 0;
    if (!read_u32_le(bytes, offset, lo) || !read_u32_le(bytes, offset + sizeof(std::uint32_t), hi)) {
        return false;
    }

    value = static_cast<std::uint64_t>(lo) | (static_cast<std::uint64_t>(hi) << 32U);
    return true;
}

[[nodiscard]] bool parse_known_binary_header(const std::vector<std::uint8_t>& bytes, KnownBinaryHeader& header) {
    if (bytes.size() < kKnownHeaderLength) {
        return false;
    }

    if (std::string_view(reinterpret_cast<const char*>(bytes.data()), 4) != "RIOT") {
        return false;
    }

    if (!read_u16_le(bytes, 262, header.header_length) ||
        !read_u32_le(bytes, 268, header.metadata_offset) ||
        !read_u32_le(bytes, 272, header.metadata_length) ||
        !read_u32_le(bytes, 276, header.payload_header_offset) ||
        !read_u32_le(bytes, 280, header.payload_header_length) ||
        !read_u32_le(bytes, 284, header.payload_offset)) {
        return false;
    }

    if (header.header_length != kKnownHeaderLength || header.metadata_length == 0 ||
        header.payload_header_length < kKnownPayloadHeaderMinimumSize) {
        return false;
    }

    if (!is_range_valid(header.metadata_offset, header.metadata_length, bytes.size()) ||
        !is_range_valid(header.payload_header_offset, header.payload_header_length, bytes.size()) ||
        header.payload_offset > bytes.size()) {
        return false;
    }

    if (header.metadata_offset < header.header_length ||
        header.payload_header_offset < header.metadata_offset ||
        header.payload_offset < header.payload_header_offset + header.payload_header_length) {
        return false;
    }

    return true;
}

[[nodiscard]] bool parse_known_payload_header(
    const std::vector<std::uint8_t>& bytes,
    const KnownBinaryHeader& header,
    KnownPayloadHeader& payload
) {
    if (!read_u64_le(bytes, header.payload_header_offset, payload.match_id) ||
        !read_u32_le(bytes, header.payload_header_offset + 8, payload.match_length) ||
        !read_u32_le(bytes, header.payload_header_offset + 12, payload.keyframe_count) ||
        !read_u32_le(bytes, header.payload_header_offset + 16, payload.chunk_count) ||
        !read_u32_le(bytes, header.payload_header_offset + 20, payload.startup_chunk_end_id) ||
        !read_u32_le(bytes, header.payload_header_offset + 24, payload.game_start_chunk_id) ||
        !read_u32_le(bytes, header.payload_header_offset + 28, payload.keyframe_interval) ||
        !read_u16_le(bytes, header.payload_header_offset + 32, payload.encryption_key_length)) {
        return false;
    }

    return static_cast<std::size_t>(kKnownPayloadHeaderMinimumSize + payload.encryption_key_length) <=
           header.payload_header_length;
}

[[nodiscard]] bool parse_segment_table(
    const std::vector<std::uint8_t>& bytes,
    const KnownBinaryHeader& header,
    const KnownPayloadHeader& payload,
    std::vector<ReplaySegmentSummary>& segments
) {
    const std::size_t segment_count =
        static_cast<std::size_t>(payload.chunk_count) + static_cast<std::size_t>(payload.keyframe_count);
    const std::size_t table_size = segment_count * kKnownSegmentHeaderLength;
    if (!is_range_valid(header.payload_offset, table_size, bytes.size())) {
        return false;
    }

    segments.clear();
    segments.reserve(segment_count);
    for (std::size_t index = 0; index < segment_count; ++index) {
        const std::size_t offset = header.payload_offset + (index * kKnownSegmentHeaderLength);
        std::uint32_t id = 0;
        std::uint32_t length = 0;
        std::uint32_t chunk_id = 0;
        std::uint32_t data_offset = 0;
        if (!read_u32_le(bytes, offset, id) ||
            !read_u32_le(bytes, offset + 5, length) ||
            !read_u32_le(bytes, offset + 9, chunk_id) ||
            !read_u32_le(bytes, offset + 13, data_offset)) {
            return false;
        }

        const std::uint8_t type = bytes[offset + 4];
        ReplaySegmentSummary segment;
        segment.id = static_cast<int>(id);
        segment.type = type == 1 ? "chunk" : (type == 2 ? "keyframe" : "unknown");
        segment.length = static_cast<int>(length);
        segment.chunk_id = static_cast<int>(chunk_id);
        segment.offset = static_cast<int>(data_offset);
        segment.header_offset = static_cast<int>(offset);
        segment.payload_offset = static_cast<int>(header.payload_offset + table_size + data_offset);
        segment.uncompressed_length = 0;
        segment.codec = "unknown";
        segments.push_back(std::move(segment));
    }

    return true;
}

[[nodiscard]] bool try_extract_footer_metadata(const std::vector<std::uint8_t>& bytes, MetadataRegion& region) {
    if (bytes.size() <= kFooterLengthFieldSize) {
        return false;
    }

    std::uint32_t metadata_size = 0;
    if (!read_u32_le(bytes, bytes.size() - kFooterLengthFieldSize, metadata_size)) {
        return false;
    }

    const std::size_t metadata_length = static_cast<std::size_t>(metadata_size);
    if (!is_range_valid(bytes.size() - kFooterLengthFieldSize - metadata_length, metadata_length + kFooterLengthFieldSize, bytes.size())) {
        return false;
    }

    const std::size_t metadata_offset = bytes.size() - kFooterLengthFieldSize - metadata_length;
    if (bytes[metadata_offset] != '{') {
        return false;
    }

    const std::string json(
        reinterpret_cast<const char*>(bytes.data() + metadata_offset),
        metadata_length
    );

    if (json.rfind(std::string(kMetadataMarker), 0) != 0) {
        return false;
    }

    region.offset = metadata_offset;
    region.size = metadata_length;
    region.source = "footer-size";
    region.format = "rofl2-like-footer";
    region.json = json;
    return true;
}

[[nodiscard]] bool is_zstd_magic(const std::vector<std::uint8_t>& bytes, std::size_t offset) {
    return is_range_valid(offset, 4, bytes.size()) &&
           bytes[offset] == 0x28 &&
           bytes[offset + 1] == 0xB5 &&
           bytes[offset + 2] == 0x2F &&
           bytes[offset + 3] == 0xFD;
}

[[nodiscard]] bool parse_footer_zstd_record(
    const std::vector<std::uint8_t>& bytes,
    std::size_t header_offset,
    std::size_t metadata_offset,
    FooterZstdRecord& record
) {
    if (metadata_offset <= header_offset || !is_range_valid(header_offset, kFooterRecordHeaderLength, metadata_offset)) {
        return false;
    }

    if (bytes[header_offset + 1] != 0 || bytes[header_offset + 2] != 0 || bytes[header_offset + 3] != 0 ||
        bytes[header_offset + 5] != 0 || bytes[header_offset + 6] != 0 || bytes[header_offset + 7] != 0) {
        return false;
    }

    std::uint32_t uncompressed_length = 0;
    std::uint32_t compressed_length = 0;
    if (!read_u32_le(bytes, header_offset + 9, uncompressed_length) ||
        !read_u32_le(bytes, header_offset + 13, compressed_length)) {
        return false;
    }

    const std::uint8_t kind = bytes[header_offset + 8];
    const std::size_t payload_offset = header_offset + kFooterRecordHeaderLength;
    if ((kind != 1 && kind != 2 && kind != 3) || uncompressed_length == 0 || compressed_length == 0) {
        return false;
    }

    if (!is_range_valid(payload_offset, compressed_length, metadata_offset) || !is_zstd_magic(bytes, payload_offset)) {
        return false;
    }

    record.header_offset = header_offset;
    record.payload_offset = payload_offset;
    record.id = bytes[header_offset];
    record.related_id = bytes[header_offset + 4];
    record.kind = kind;
    record.uncompressed_length = uncompressed_length;
    record.compressed_length = compressed_length;
    return true;
}

[[nodiscard]] std::vector<FooterZstdRecord> find_footer_zstd_records(
    const std::vector<std::uint8_t>& bytes,
    std::size_t metadata_offset
) {
    std::vector<FooterZstdRecord> records;
    if (metadata_offset <= kFooterRecordHeaderLength + 4) {
        return records;
    }

    for (std::size_t payload_offset = kFooterRecordHeaderLength; payload_offset + 4 <= metadata_offset; ++payload_offset) {
        if (!is_zstd_magic(bytes, payload_offset)) {
            continue;
        }

        FooterZstdRecord record;
        if (parse_footer_zstd_record(bytes, payload_offset - kFooterRecordHeaderLength, metadata_offset, record)) {
            records.push_back(record);
        }
    }

    std::sort(records.begin(), records.end(), [](const FooterZstdRecord& left, const FooterZstdRecord& right) {
        return left.header_offset < right.header_offset;
    });

    records.erase(std::unique(records.begin(), records.end(), [](const FooterZstdRecord& left, const FooterZstdRecord& right) {
        return left.header_offset == right.header_offset;
    }), records.end());

    return records;
}

[[nodiscard]] bool populate_footer_zstd_segments(
    const std::vector<FooterZstdRecord>& records,
    ReplaySummary& summary
) {
    if (records.empty()) {
        return false;
    }

    int chunk_records = 0;
    int keyframe_records = 0;
    int startup_chunk_end_id = 0;
    int game_start_chunk_id = 0;
    int max_chunk_id = 0;
    int max_keyframe_id = 0;

    summary.container.segments.clear();
    summary.container.segments.reserve(records.size());
    summary.container.payload_offset = records.front().header_offset;

    for (const FooterZstdRecord& record : records) {
        ReplaySegmentSummary segment;
        segment.id = static_cast<int>(record.id);
        segment.length = static_cast<int>(record.compressed_length);
        segment.chunk_id = static_cast<int>(record.related_id);
        segment.offset = static_cast<int>(record.header_offset);
        segment.header_offset = static_cast<int>(record.header_offset);
        segment.payload_offset = static_cast<int>(record.payload_offset);
        segment.uncompressed_length = static_cast<int>(record.uncompressed_length);
        segment.codec = "zstd";

        if (record.kind == 1) {
            segment.type = "chunk";
            chunk_records += 1;
            max_chunk_id = std::max(max_chunk_id, static_cast<int>(record.id));
            if (game_start_chunk_id == 0) {
                game_start_chunk_id = static_cast<int>(record.id);
            }
        } else if (record.kind == 2) {
            segment.type = "keyframe";
            keyframe_records += 1;
            max_keyframe_id = std::max(max_keyframe_id, static_cast<int>(record.id));
        } else {
            segment.type = "startup";
            startup_chunk_end_id = std::max(startup_chunk_end_id, static_cast<int>(record.related_id));
        }

        summary.container.segments.push_back(std::move(segment));
    }

    if (summary.last_keyframe_id > 0 && keyframe_records != summary.last_keyframe_id) {
        return false;
    }
    if (summary.last_game_chunk_id > 0 && max_chunk_id > 0 && max_chunk_id != summary.last_game_chunk_id) {
        return false;
    }
    if (max_keyframe_id > 0 && summary.last_keyframe_id > 0 && max_keyframe_id != summary.last_keyframe_id) {
        return false;
    }

    summary.container.chunk_count = chunk_records;
    summary.container.keyframe_count = keyframe_records;
    summary.container.startup_chunk_end_id = startup_chunk_end_id;
    summary.container.game_start_chunk_id = game_start_chunk_id == 0 && startup_chunk_end_id > 0
        ? startup_chunk_end_id + 1
        : game_start_chunk_id;
    summary.container.segment_table_present = true;
    summary.capabilities.segment_table_available = true;
    return true;
}

struct SegmentTableCandidate {
    std::size_t offset = 0;
    int score = 0;
    int sample_entries = 0;
    int first_id = 0;
    int last_id = 0;
    int chunk_entries = 0;
    int keyframe_entries = 0;
    int first_data_offset = 0;
};

[[nodiscard]] std::string format_offset(std::size_t offset) {
    std::ostringstream output;
    output << offset << " (0x" << std::hex << std::uppercase << offset << std::nouppercase << std::dec << ")";
    return output.str();
}

[[nodiscard]] bool try_decompress_zstd_segment(
    const std::vector<std::uint8_t>& bytes,
    const ReplaySegmentSummary& segment,
    std::vector<std::uint8_t>& decompressed,
    std::string& error
) {
    if (segment.codec != "zstd") {
        error = "segment codec is not zstd";
        return false;
    }
    if (segment.length <= 0 || segment.uncompressed_length <= 0) {
        error = "segment lengths were not populated";
        return false;
    }

    const std::size_t payload_offset = static_cast<std::size_t>(segment.payload_offset);
    const std::size_t compressed_length = static_cast<std::size_t>(segment.length);
    const std::size_t uncompressed_length = static_cast<std::size_t>(segment.uncompressed_length);
    if (!is_range_valid(payload_offset, compressed_length, bytes.size())) {
        error = "segment payload range is out of bounds";
        return false;
    }

    decompressed.assign(uncompressed_length, 0);
    const std::size_t result = ZSTD_decompress(
        decompressed.data(),
        decompressed.size(),
        bytes.data() + payload_offset,
        compressed_length
    );
    if (ZSTD_isError(result) != 0) {
        error = ZSTD_getErrorName(result);
        decompressed.clear();
        return false;
    }

    decompressed.resize(result);
    return true;
}

[[nodiscard]] std::string format_hex_preview(const std::vector<std::uint8_t>& bytes, std::size_t limit) {
    std::ostringstream output;
    const std::size_t preview_size = std::min(limit, bytes.size());
    for (std::size_t index = 0; index < preview_size; ++index) {
        if (index > 0) {
            output << ' ';
        }
        output << std::hex << std::uppercase << std::setw(2) << std::setfill('0')
               << static_cast<int>(bytes[index]) << std::dec << std::nouppercase;
    }
    return output.str();
}

[[nodiscard]] std::string format_ascii_preview(const std::vector<std::uint8_t>& bytes, std::size_t limit) {
    std::string preview;
    const std::size_t preview_size = std::min(limit, bytes.size());
    preview.reserve(preview_size);
    for (std::size_t index = 0; index < preview_size; ++index) {
        const char ch = static_cast<char>(bytes[index]);
        preview.push_back(std::isprint(static_cast<unsigned char>(ch)) != 0 ? ch : '.');
    }
    return preview;
}

struct LengthPrefixCandidate {
    std::size_t width = 0;
    std::size_t start_offset = 0;
    std::size_t record_count = 0;
    std::size_t consumed = 0;
    std::size_t largest_record = 0;
};

struct FramedSubrecord {
    std::size_t offset = 0;
    std::size_t payload_offset = 0;
    std::size_t length = 0;
};

struct SubrecordGroup {
    std::size_t size = 0;
    std::uint8_t sig = 0;
    int count = 0;
    std::vector<std::vector<std::uint8_t>> examples;
};

[[nodiscard]] std::string format_percentage(std::size_t value, std::size_t total) {
    std::ostringstream output;
    const double percent = total == 0 ? 0.0 : (static_cast<double>(value) * 100.0) / static_cast<double>(total);
    output << std::fixed << std::setprecision(1) << percent << '%';
    return output.str();
}

[[nodiscard]] std::string format_u32_preview(const std::vector<std::uint8_t>& bytes, std::size_t limit) {
    const std::size_t value_count = std::min(limit, bytes.size() / sizeof(std::uint32_t));
    if (value_count == 0) {
        return "none";
    }

    std::ostringstream output;
    for (std::size_t index = 0; index < value_count; ++index) {
        std::uint32_t value = 0;
        if (!read_u32_le(bytes, index * sizeof(std::uint32_t), value)) {
            break;
        }
        if (index > 0) {
            output << ", ";
        }
        output << '[' << index << "]=" << value;
    }
    return output.str();
}

[[nodiscard]] std::string format_u16_preview(const std::vector<std::uint8_t>& bytes, std::size_t limit) {
    const std::size_t value_count = std::min(limit, bytes.size() / sizeof(std::uint16_t));
    if (value_count == 0) {
        return "none";
    }

    std::ostringstream output;
    for (std::size_t index = 0; index < value_count; ++index) {
        std::uint16_t value = 0;
        if (!read_u16_le(bytes, index * sizeof(std::uint16_t), value)) {
            break;
        }
        if (index > 0) {
            output << ", ";
        }
        output << '[' << index << "]=" << value;
    }
    return output.str();
}

[[nodiscard]] LengthPrefixCandidate analyze_le_length_prefix(const std::vector<std::uint8_t>& bytes, std::size_t width) {
    LengthPrefixCandidate best;
    best.width = width;

    if (width != 2 && width != 4) {
        return best;
    }

    for (std::size_t start_offset = 0; start_offset < width && start_offset < bytes.size(); ++start_offset) {
        std::size_t cursor = start_offset;
        std::size_t record_count = 0;
        std::size_t largest_record = 0;

        while (cursor + width <= bytes.size()) {
            std::size_t record_length = 0;
            if (width == 2) {
                std::uint16_t value = 0;
                if (!read_u16_le(bytes, cursor, value)) {
                    break;
                }
                record_length = value;
            } else {
                std::uint32_t value = 0;
                if (!read_u32_le(bytes, cursor, value)) {
                    break;
                }
                record_length = value;
            }

            if (record_length == 0 || record_length > (bytes.size() - cursor - width)) {
                break;
            }

            cursor += width + record_length;
            largest_record = std::max(largest_record, record_length);
            record_count += 1;
        }

        const bool better_candidate =
            record_count > best.record_count ||
            (record_count == best.record_count && cursor > best.consumed) ||
            (record_count == best.record_count && cursor == best.consumed && largest_record > best.largest_record);
        if (better_candidate) {
            best.start_offset = start_offset;
            best.record_count = record_count;
            best.consumed = cursor;
            best.largest_record = largest_record;
        }
    }

    return best;
}

[[nodiscard]] LengthPrefixCandidate choose_best_le_length_prefix(const std::vector<std::uint8_t>& bytes) {
    LengthPrefixCandidate best = analyze_le_length_prefix(bytes, 2);

    if (bytes.size() > 1) {
        LengthPrefixCandidate shifted_u16 = analyze_le_length_prefix(
            std::vector<std::uint8_t>(bytes.begin() + 1, bytes.end()),
            2
        );
        if (shifted_u16.record_count > 0) {
            shifted_u16.start_offset += 1;
            shifted_u16.consumed += 1;
        }
        const bool better_shifted =
            shifted_u16.consumed > best.consumed ||
            (shifted_u16.consumed == best.consumed && shifted_u16.record_count > best.record_count) ||
            (shifted_u16.record_count == best.record_count && shifted_u16.consumed == best.consumed && shifted_u16.largest_record > best.largest_record);
        if (better_shifted) {
            best = shifted_u16;
        }
    }

    const LengthPrefixCandidate best_u32 = analyze_le_length_prefix(bytes, 4);
    const bool better_u32 =
        best_u32.consumed > best.consumed ||
        (best_u32.consumed == best.consumed && best_u32.record_count > best.record_count) ||
        (best_u32.record_count == best.record_count && best_u32.consumed == best.consumed && best_u32.largest_record > best.largest_record);
    if (better_u32) {
        best = best_u32;
    }

    return best;
}

[[nodiscard]] std::string describe_length_prefix_candidate(const LengthPrefixCandidate& candidate, std::size_t total_size) {
    if (candidate.record_count < 2) {
        return "none";
    }

    std::ostringstream output;
    output << "start=" << candidate.start_offset
           << ", records=" << candidate.record_count
           << ", consumed=" << candidate.consumed << '/' << total_size
           << " (" << format_percentage(candidate.consumed, total_size) << ')'
           << ", largestRecord=" << candidate.largest_record;
    return output.str();
}

[[nodiscard]] std::vector<FramedSubrecord> extract_le_framed_subrecords(
    const std::vector<std::uint8_t>& bytes,
    std::size_t width,
    std::size_t start_offset,
    std::size_t max_records
) {
    std::vector<FramedSubrecord> records;
    if ((width != 2 && width != 4) || start_offset >= bytes.size()) {
        return records;
    }

    std::size_t cursor = start_offset;
    while (cursor + width <= bytes.size() && records.size() < max_records) {
        std::size_t record_length = 0;
        if (width == 2) {
            std::uint16_t value = 0;
            if (!read_u16_le(bytes, cursor, value)) {
                break;
            }
            record_length = value;
        } else {
            std::uint32_t value = 0;
            if (!read_u32_le(bytes, cursor, value)) {
                break;
            }
            record_length = value;
        }

        if (record_length == 0 || record_length > (bytes.size() - cursor - width)) {
            break;
        }

        FramedSubrecord record;
        record.offset = cursor;
        record.payload_offset = cursor + width;
        record.length = record_length;
        records.push_back(record);
        cursor += width + record_length;
    }

    return records;
}

[[nodiscard]] std::string describe_framed_subrecords(
    const std::vector<std::uint8_t>& bytes,
    const LengthPrefixCandidate& candidate,
    std::size_t width,
    std::size_t max_records
) {
    if (candidate.record_count < 2) {
        return "none";
    }

    const auto records = extract_le_framed_subrecords(bytes, width, candidate.start_offset, max_records);
    if (records.empty()) {
        return "none";
    }

    std::ostringstream output;
    for (std::size_t index = 0; index < records.size(); ++index) {
        const FramedSubrecord& record = records[index];
        const std::size_t preview_length = std::min(record.length, static_cast<std::size_t>(24));
        std::vector<std::uint8_t> preview(
            bytes.begin() + static_cast<std::ptrdiff_t>(record.payload_offset),
            bytes.begin() + static_cast<std::ptrdiff_t>(record.payload_offset + preview_length)
        );
        if (index > 0) {
            output << " | ";
        }
        output << '#' << index
               << " off=" << record.payload_offset
               << " len=" << record.length
               << " hex=" << format_hex_preview(preview, preview.size())
               << " ascii=\"" << format_ascii_preview(preview, preview.size()) << "\"";
    }
    return output.str();
}

[[nodiscard]] std::vector<std::string> collect_ascii_runs(
    const std::vector<std::uint8_t>& bytes,
    std::size_t minimum_length,
    std::size_t max_runs,
    std::size_t max_preview_length
) {
    std::vector<std::string> runs;
    std::size_t cursor = 0;
    while (cursor < bytes.size() && runs.size() < max_runs) {
        while (cursor < bytes.size() && std::isprint(static_cast<unsigned char>(bytes[cursor])) == 0) {
            ++cursor;
        }

        const std::size_t start = cursor;
        while (cursor < bytes.size() && std::isprint(static_cast<unsigned char>(bytes[cursor])) != 0) {
            ++cursor;
        }

        const std::size_t length = cursor - start;
        if (length >= minimum_length) {
            const std::size_t preview_length = std::min(length, max_preview_length);
            std::string run(reinterpret_cast<const char*>(bytes.data() + start), preview_length);
            if (preview_length < length) {
                run += "...";
            }
            runs.push_back(std::move(run));
        }
    }

    return runs;
}

[[nodiscard]] std::string inspect_decompressed_segment(
    const ReplaySegmentSummary& segment,
    const std::vector<std::uint8_t>& decompressed
) {
    std::ostringstream output;
    const std::size_t zero_bytes = static_cast<std::size_t>(std::count(decompressed.begin(), decompressed.end(), static_cast<std::uint8_t>(0)));
    std::size_t printable_bytes = 0;
    for (const std::uint8_t value : decompressed) {
        printable_bytes += std::isprint(static_cast<unsigned char>(value)) != 0 ? 1U : 0U;
    }

    const auto best_u16 = analyze_le_length_prefix(decompressed, 2);
    const auto best_u32 = analyze_le_length_prefix(decompressed, 4);
    const auto ascii_runs = collect_ascii_runs(decompressed, 4, 6, 48);
    const bool useful_u16_framing = best_u16.record_count >= 2 && best_u16.consumed >= (decompressed.size() / 2);
    const bool useful_u32_framing = best_u32.record_count >= 2 && best_u32.consumed >= (decompressed.size() / 2);
    const std::string u16_subrecords = useful_u16_framing
        ? describe_framed_subrecords(decompressed, best_u16, 2, 6)
        : "none";
    const std::string u32_subrecords = useful_u32_framing
        ? describe_framed_subrecords(decompressed, best_u32, 4, 6)
        : "none";

    output << "Segment " << segment.type << '#' << segment.id;
    if (segment.chunk_id > 0) {
        output << " (chunkId=" << segment.chunk_id << ')';
    }
    output << '\n';
    output << "  Offsets: header=" << segment.header_offset << ", payload=" << segment.payload_offset << '\n';
    output << "  Sizes: compressed=" << segment.length << ", uncompressed=" << decompressed.size() << '\n';
    output << "  Byte stats: zero=" << zero_bytes << " (" << format_percentage(zero_bytes, decompressed.size())
           << "), printable=" << printable_bytes << " (" << format_percentage(printable_bytes, decompressed.size()) << ")\n";
    output << "  First u32 values: " << format_u32_preview(decompressed, 8) << '\n';
    output << "  First u16 values: " << format_u16_preview(decompressed, 12) << '\n';
    output << "  Best u16 LE length framing: " << describe_length_prefix_candidate(best_u16, decompressed.size()) << '\n';
    output << "  Best u32 LE length framing: " << describe_length_prefix_candidate(best_u32, decompressed.size()) << '\n';
    output << "  Candidate u16 subrecords: " << u16_subrecords << '\n';
    output << "  Candidate u32 subrecords: " << u32_subrecords << '\n';
    output << "  Hex preview: " << format_hex_preview(decompressed, 32) << '\n';
    output << "  ASCII preview: \"" << format_ascii_preview(decompressed, 64) << "\"\n";
    output << "  ASCII runs: ";
    if (ascii_runs.empty()) {
        output << "none\n";
    } else {
        for (std::size_t index = 0; index < ascii_runs.size(); ++index) {
            if (index > 0) {
                output << ", ";
            }
            output << '\"' << ascii_runs[index] << '\"';
        }
        output << '\n';
    }

    return output.str();
}

[[nodiscard]] std::vector<std::size_t> find_signature_hits(
    const std::vector<std::uint8_t>& bytes,
    const std::vector<std::uint8_t>& signature,
    std::size_t max_hits
) {
    std::vector<std::size_t> hits;
    if (signature.empty() || bytes.size() < signature.size()) {
        return hits;
    }

    for (std::size_t offset = 0; offset + signature.size() <= bytes.size() && hits.size() < max_hits; ++offset) {
        bool match = true;
        for (std::size_t index = 0; index < signature.size(); ++index) {
            if (bytes[offset + index] != signature[index]) {
                match = false;
                break;
            }
        }
        if (match) {
            hits.push_back(offset);
        }
    }

    return hits;
}

[[nodiscard]] std::vector<SegmentTableCandidate> find_segment_table_candidates(
    const std::vector<std::uint8_t>& bytes,
    int expected_entries,
    std::size_t max_candidates
) {
    const std::size_t sample_entries = expected_entries > 0
        ? std::min<std::size_t>(12, static_cast<std::size_t>(expected_entries))
        : 12;
    const std::size_t minimum_span = sample_entries * kKnownSegmentHeaderLength;
    std::vector<SegmentTableCandidate> candidates;

    if (bytes.size() < minimum_span) {
        return candidates;
    }

    for (std::size_t offset = 0; offset + minimum_span <= bytes.size(); ++offset) {
        const std::uint8_t type = bytes[offset + 4];
        if (type != 1 && type != 2) {
            continue;
        }

        std::uint32_t first_id = 0;
        std::uint32_t first_length = 0;
        std::uint32_t first_chunk_id = 0;
        std::uint32_t first_data_offset = 0;
        if (!read_u32_le(bytes, offset, first_id) ||
            !read_u32_le(bytes, offset + 5, first_length) ||
            !read_u32_le(bytes, offset + 9, first_chunk_id) ||
            !read_u32_le(bytes, offset + 13, first_data_offset)) {
            continue;
        }

        if (first_id > 4 || first_length == 0 || first_length > bytes.size()) {
            continue;
        }

        SegmentTableCandidate candidate;
        candidate.offset = offset;
        candidate.first_id = static_cast<int>(first_id);
        candidate.first_data_offset = static_cast<int>(first_data_offset);

        std::uint32_t previous_id = first_id;
        std::uint32_t previous_data_offset = 0;
        for (std::size_t entry_index = 0; entry_index < sample_entries; ++entry_index) {
            const std::size_t entry_offset = offset + (entry_index * kKnownSegmentHeaderLength);
            const std::uint8_t entry_type = bytes[entry_offset + 4];
            if (entry_type != 1 && entry_type != 2) {
                break;
            }

            std::uint32_t id = 0;
            std::uint32_t length = 0;
            std::uint32_t chunk_id = 0;
            std::uint32_t data_offset = 0;
            if (!read_u32_le(bytes, entry_offset, id) ||
                !read_u32_le(bytes, entry_offset + 5, length) ||
                !read_u32_le(bytes, entry_offset + 9, chunk_id) ||
                !read_u32_le(bytes, entry_offset + 13, data_offset)) {
                break;
            }

            candidate.sample_entries += 1;
            candidate.score += 3;
            if (entry_index == 0) {
                candidate.score += id <= 4 ? 2 : 0;
            } else if (id == previous_id + 1) {
                candidate.score += 2;
            }
            if (length > 0 && length < bytes.size() / 2) {
                candidate.score += 1;
            }
            if (entry_index == 0 || data_offset >= previous_data_offset) {
                candidate.score += 1;
            }
            if (entry_type == 1) {
                candidate.chunk_entries += 1;
                if (chunk_id == 0) {
                    candidate.score += 1;
                }
            } else {
                candidate.keyframe_entries += 1;
            }

            candidate.last_id = static_cast<int>(id);
            previous_id = id;
            previous_data_offset = data_offset;
        }

        if (candidate.sample_entries >= 6 && candidate.score >= 28) {
            candidates.push_back(candidate);
        }
    }

    std::sort(candidates.begin(), candidates.end(), [](const SegmentTableCandidate& left, const SegmentTableCandidate& right) {
        if (left.score != right.score) {
            return left.score > right.score;
        }
        if (left.sample_entries != right.sample_entries) {
            return left.sample_entries > right.sample_entries;
        }
        return left.offset < right.offset;
    });

    std::vector<SegmentTableCandidate> filtered;
    for (const SegmentTableCandidate& candidate : candidates) {
        bool too_close = false;
        for (const SegmentTableCandidate& existing : filtered) {
            const std::size_t distance = candidate.offset > existing.offset
                ? candidate.offset - existing.offset
                : existing.offset - candidate.offset;
            if (distance < (kKnownSegmentHeaderLength * 4)) {
                too_close = true;
                break;
            }
        }

        if (!too_close) {
            filtered.push_back(candidate);
            if (filtered.size() >= max_candidates) {
                break;
            }
        }
    }

    return filtered;
}
[[nodiscard]] MetadataRegion extract_metadata_region(const std::vector<std::uint8_t>& bytes) {
    MetadataRegion region;
    if (try_extract_footer_metadata(bytes, region)) {
        return region;
    }

    const std::size_t metadata_offset = find_subsequence(bytes, kMetadataMarker);
    if (metadata_offset == std::string::npos) {
        throw std::runtime_error("Could not locate embedded metadata JSON in replay.");
    }

    region.offset = metadata_offset;
    region.json = extract_balanced_json(bytes, metadata_offset);
    region.size = region.json.size();
    region.source = "marker-scan";
    region.format = metadata_offset > (bytes.size() / 2) ? "footer-metadata-only" : "metadata-scanned";
    return region;
}

}  // namespace

BuildInfo get_build_info() {
    return {
        .version = "0.7.0-packet-block-framing",
        .parser_state = "footer-zstd-plus-packet-block-framing",
        .wasm_state = "packet-kill-bridge-ready"
    };
}

std::string describe_scaffold() {
    const BuildInfo info = get_build_info();
    return "league-replay-analyzer " + info.version +
           " | parser=" + info.parser_state +
           " | wasm=" + info.wasm_state;
}

std::string normalize_version_label(std::string_view version) {
    return version.empty() ? "unknown" : std::string(version);
}

[[nodiscard]] static ReplaySummary parse_replay_bytes_impl(
    const std::vector<std::uint8_t>& bytes,
    const DecoderProfileRegistry* decoder_profiles
) {
    ReplaySummary summary;
    summary.file_size = bytes.size();
    summary.game_version = scan_game_version(bytes);

    KnownBinaryHeader binary_header;
    KnownPayloadHeader payload_header;
    const bool has_classic_container = parse_known_binary_header(bytes, binary_header);

    if (has_classic_container) {
        summary.container.format = "classic-rofl";
        summary.container.metadata_source = "binary-header";
        summary.container.metadata_offset = binary_header.metadata_offset;
        summary.container.metadata_size = binary_header.metadata_length;
        summary.container.payload_header_offset = binary_header.payload_header_offset;
        summary.container.payload_header_size = binary_header.payload_header_length;
        summary.container.payload_offset = binary_header.payload_offset;
        summary.container.binary_header_present = true;
        summary.capabilities.binary_header_available = true;

        summary.metadata_json = std::string(
            reinterpret_cast<const char*>(bytes.data() + binary_header.metadata_offset),
            binary_header.metadata_length
        );

        if (parse_known_payload_header(bytes, binary_header, payload_header)) {
            summary.container.match_id = payload_header.match_id;
            summary.container.keyframe_count = static_cast<int>(payload_header.keyframe_count);
            summary.container.chunk_count = static_cast<int>(payload_header.chunk_count);
            summary.container.startup_chunk_end_id = static_cast<int>(payload_header.startup_chunk_end_id);
            summary.container.game_start_chunk_id = static_cast<int>(payload_header.game_start_chunk_id);
            summary.container.keyframe_interval_millis = static_cast<int>(payload_header.keyframe_interval);
            summary.container.payload_header_present = true;
            summary.capabilities.payload_header_available = true;

            if (parse_segment_table(bytes, binary_header, payload_header, summary.container.segments)) {
                summary.container.segment_table_present = true;
                summary.capabilities.segment_table_available = true;
            } else {
                summary.warnings.push_back(
                    "Known ROFL payload header parsed, but the segment table could not be validated from the advertised payload offsets."
                );
            }
        } else {
            summary.warnings.push_back(
                "Known ROFL binary header parsed, but the payload header did not match the expected classic layout."
            );
        }
    } else {
        const MetadataRegion metadata = extract_metadata_region(bytes);
        summary.metadata_json = metadata.json;
        summary.container.format = metadata.format;
        summary.container.metadata_source = metadata.source;
        summary.container.metadata_offset = metadata.offset;
        summary.container.metadata_size = metadata.size;

        if (metadata.source == "footer-size") {
            summary.warnings.push_back(
                "Metadata was recovered via footer size parsing after the known classic ROFL header layout did not validate."
            );
        } else {
            summary.warnings.push_back(
                "Known classic ROFL header fields were not recognized. Metadata was recovered by scanning for the embedded JSON block instead."
            );
        }
    }

    summary.capabilities.metadata_available = !summary.metadata_json.empty();

    try {
        summary.game_length_millis = parse_int_field(summary.metadata_json, "gameLength");
        summary.last_game_chunk_id = parse_int_field(summary.metadata_json, "lastGameChunkId");
        summary.last_keyframe_id = parse_int_field(summary.metadata_json, "lastKeyFrameId");

        if (summary.game_version == "unknown") {
            const std::string metadata_version = parse_string_field(summary.metadata_json, "gameVersion");
            if (!metadata_version.empty()) {
                summary.game_version = metadata_version;
            }
        }
    } catch (const std::exception& exception) {
        throw std::runtime_error("Failed while extracting embedded metadata JSON: " + std::string(exception.what()));
    }

    const DecoderVersionProfile* selected_decoder_profile = nullptr;
    summary.decoder_profile.version_group = replay_version_group(summary.game_version);
    if (decoder_profiles != nullptr) {
        const DecoderProfileProvenance& provenance =
            decoder_profile_provenance(*decoder_profiles);
        summary.decoder_profile.origin = "external";
        summary.decoder_profile.schema = provenance.schema;
        summary.decoder_profile.registry_id = provenance.registry_id;
        summary.decoder_profile.revision = provenance.revision;
        summary.decoder_profile.fingerprint = provenance.fingerprint;
        selected_decoder_profile =
            find_decoder_profile(*decoder_profiles, summary.game_version);
        summary.decoder_profile.matched = selected_decoder_profile != nullptr;
    } else {
        summary.decoder_profile.matched =
            supports_validated_final_player_stats(summary.game_version);
    }

    try {
        const std::string stats_json = parse_string_field(summary.metadata_json, "statsJson");
        if (!stats_json.empty()) {
            bool validated_final_fields = false;
            summary.players = parse_players_from_stats_json(stats_json, validated_final_fields);
            summary.capabilities.player_stats_available = true;
            summary.capabilities.validated_final_player_stats_available =
                (decoder_profiles == nullptr
                    ? supports_validated_final_player_stats(summary.game_version)
                    : selected_decoder_profile != nullptr &&
                        selected_decoder_profile->final_stats_validated.value_or(false)) &&
                validated_final_fields;
        }
    } catch (const std::exception& exception) {
        throw std::runtime_error("Failed while parsing statsJson from embedded metadata: " + std::string(exception.what()));
    }

    if (!has_classic_container && summary.container.metadata_source == "footer-size") {
        const auto footer_records = find_footer_zstd_records(bytes, summary.container.metadata_offset);
        if (populate_footer_zstd_segments(footer_records, summary)) {
            bool raw_footer_decompression_available = false;
            for (const ReplaySegmentSummary& segment : summary.container.segments) {
                if (segment.codec != "zstd") {
                    continue;
                }

                std::vector<std::uint8_t> decompressed;
                std::string error;
                if (try_decompress_zstd_segment(bytes, segment, decompressed, error)) {
                    raw_footer_decompression_available = true;
                    break;
                }
            }

            summary.capabilities.payload_decoding_available = raw_footer_decompression_available;
            if (raw_footer_decompression_available) {
                summary.warnings.push_back(
                    "Footer-style zstd records were indexed from the pre-metadata payload region, and exact packet-block framing is available. Semantic event and state decoding remains partial."
                );
            } else {
                summary.warnings.push_back(
                    "Footer-style zstd records were indexed from the pre-metadata payload region, but raw zstd decompression could not be verified, so packet-block framing is unavailable for this replay."
                );
            }
        } else {
            summary.warnings.push_back(
                "Payload header and segment table parsing are currently available only for the known classic ROFL layout. Payload decoding is not implemented yet."
            );
        }
    } else if (!has_classic_container) {
        summary.warnings.push_back(
            "Payload header and segment table parsing are currently available only for the known classic ROFL layout. Payload decoding is not implemented yet."
        );
    }

    return summary;
}

ReplaySummary parse_replay_bytes(const std::vector<std::uint8_t>& bytes) {
    return parse_replay_bytes_impl(bytes, nullptr);
}

ReplaySummary parse_replay_bytes(
    const std::vector<std::uint8_t>& bytes,
    const DecoderProfileRegistry& decoder_profiles
) {
    return parse_replay_bytes_impl(bytes, &decoder_profiles);
}
std::string probe_replay_bytes(const std::vector<std::uint8_t>& bytes) {
    std::ostringstream output;
    output << "Replay probe\n";
    output << "File size: " << bytes.size() << " bytes\n";
    output << "Scanned version: " << scan_game_version(bytes) << '\n';

    ReplaySummary summary;
    bool summary_available = false;
    std::string summary_error;
    try {
        summary = parse_replay_bytes(bytes);
        summary_available = true;
    } catch (const std::exception& exception) {
        summary_error = exception.what();
    }

    std::uint16_t raw_header_length = 0;
    std::uint32_t raw_file_length = 0;
    std::uint32_t raw_metadata_offset = 0;
    std::uint32_t raw_metadata_length = 0;
    std::uint32_t raw_payload_header_offset = 0;
    std::uint32_t raw_payload_header_length = 0;
    std::uint32_t raw_payload_offset = 0;
    const bool raw_classic_fields_available =
        read_u16_le(bytes, 262, raw_header_length) &&
        read_u32_le(bytes, 264, raw_file_length) &&
        read_u32_le(bytes, 268, raw_metadata_offset) &&
        read_u32_le(bytes, 272, raw_metadata_length) &&
        read_u32_le(bytes, 276, raw_payload_header_offset) &&
        read_u32_le(bytes, 280, raw_payload_header_length) &&
        read_u32_le(bytes, 284, raw_payload_offset);

    KnownBinaryHeader binary_header;
    const bool classic_header_valid = parse_known_binary_header(bytes, binary_header);
    output << "Classic header valid: " << (classic_header_valid ? "yes" : "no") << '\n';
    if (raw_classic_fields_available) {
        output << "Classic raw fields: "
               << "headerLength=" << raw_header_length
               << ", fileLength=" << raw_file_length
               << ", metadataOffset=" << raw_metadata_offset
               << ", metadataLength=" << raw_metadata_length
               << ", payloadHeaderOffset=" << raw_payload_header_offset
               << ", payloadHeaderLength=" << raw_payload_header_length
               << ", payloadOffset=" << raw_payload_offset << '\n';
    } else {
        output << "Classic raw fields: unavailable\n";
    }

    KnownPayloadHeader payload_header;
    const bool classic_payload_header_valid = classic_header_valid && parse_known_payload_header(bytes, binary_header, payload_header);
    output << "Classic payload header valid: " << (classic_payload_header_valid ? "yes" : "no") << '\n';
    if (classic_payload_header_valid) {
        output << "Classic payload counts: "
               << "chunks=" << payload_header.chunk_count
               << ", keyframes=" << payload_header.keyframe_count
               << ", startupChunkEndId=" << payload_header.startup_chunk_end_id
               << ", gameStartChunkId=" << payload_header.game_start_chunk_id
               << ", keyframeIntervalMillis=" << payload_header.keyframe_interval
               << ", encryptionKeyLength=" << payload_header.encryption_key_length << '\n';
    }

    std::uint32_t footer_metadata_size = 0;
    const bool footer_size_available = bytes.size() >= kFooterLengthFieldSize &&
        read_u32_le(bytes, bytes.size() - kFooterLengthFieldSize, footer_metadata_size);
    output << "Footer raw size field: ";
    if (footer_size_available) {
        output << footer_metadata_size;
        const std::size_t footer_metadata_length = static_cast<std::size_t>(footer_metadata_size);
        if (bytes.size() >= kFooterLengthFieldSize + footer_metadata_length) {
            output << " -> candidate offset " << format_offset(bytes.size() - kFooterLengthFieldSize - footer_metadata_length);
        } else {
            output << " -> out of range";
        }
        output << '\n';
    } else {
        output << "unavailable\n";
    }

    MetadataRegion footer_region;
    const bool footer_metadata_valid = try_extract_footer_metadata(bytes, footer_region);
    output << "Footer metadata valid: " << (footer_metadata_valid ? "yes" : "no") << '\n';
    if (footer_metadata_valid) {
        output << "Footer metadata region: offset=" << format_offset(footer_region.offset)
               << ", size=" << footer_region.size
               << ", format=" << footer_region.format << '\n';
    }

    output << "Parser summary available: " << (summary_available ? "yes" : "no") << '\n';
    if (summary_available) {
        output << "Container format: " << summary.container.format << '\n';
        output << "Metadata source: " << summary.container.metadata_source << '\n';
        output << "Metadata region: offset=" << format_offset(summary.container.metadata_offset)
               << ", size=" << summary.container.metadata_size << '\n';
        output << "Timeline hints: gameLengthMillis=" << summary.game_length_millis
               << ", lastGameChunkId=" << summary.last_game_chunk_id
               << ", lastKeyFrameId=" << summary.last_keyframe_id << '\n';
        output << "Capabilities: binaryHeader=" << (summary.capabilities.binary_header_available ? "yes" : "no")
               << ", payloadHeader=" << (summary.capabilities.payload_header_available ? "yes" : "no")
               << ", segmentTable=" << (summary.capabilities.segment_table_available ? "yes" : "no")
               << ", payloadDecoding=" << (summary.capabilities.payload_decoding_available ? "yes" : "no") << '\n';
    } else {
        output << "Parser error: " << summary_error << '\n';
    }

    const auto zlib_default_hits = find_signature_hits(bytes, {0x78, 0x9C}, 8);
    const auto zlib_best_hits = find_signature_hits(bytes, {0x78, 0xDA}, 8);
    const auto gzip_hits = find_signature_hits(bytes, {0x1F, 0x8B}, 8);
    const auto zstd_hits = find_signature_hits(bytes, {0x28, 0xB5, 0x2F, 0xFD}, 8);

    const auto print_hits = [&output](std::string_view label, const std::vector<std::size_t>& hits) {
        output << label << ": " << hits.size();
        if (!hits.empty()) {
            output << " [";
            for (std::size_t index = 0; index < hits.size(); ++index) {
                if (index > 0) {
                    output << ", ";
                }
                output << format_offset(hits[index]);
            }
            output << "]";
        }
        output << '\n';
    };

    print_hits("Signature hits (zlib 78 9C)", zlib_default_hits);
    print_hits("Signature hits (zlib 78 DA)", zlib_best_hits);
    print_hits("Signature hits (gzip 1F 8B)", gzip_hits);
    print_hits("Signature hits (zstd 28 B5 2F FD)", zstd_hits);

    int expected_entries = 0;
    if (summary_available) {
        expected_entries = std::max(expected_entries, summary.last_game_chunk_id + summary.last_keyframe_id);
        expected_entries = std::max(expected_entries, summary.container.chunk_count + summary.container.keyframe_count);
    }

    const auto candidates = find_segment_table_candidates(bytes, expected_entries, 5);
    output << "17-byte segment table candidates: " << candidates.size() << '\n';
    for (const SegmentTableCandidate& candidate : candidates) {
        output << "  - offset=" << format_offset(candidate.offset)
               << ", score=" << candidate.score
               << ", sampleEntries=" << candidate.sample_entries
               << ", firstId=" << candidate.first_id
               << ", lastId=" << candidate.last_id
               << ", chunkEntries=" << candidate.chunk_entries
               << ", keyframeEntries=" << candidate.keyframe_entries
               << ", firstDataOffset=" << candidate.first_data_offset << '\n';
    }

    if (summary_available && summary.capabilities.segment_table_available) {
        int decompressed_preview_count = 0;
        for (const ReplaySegmentSummary& segment : summary.container.segments) {
            if (segment.codec != "zstd") {
                continue;
            }

            std::vector<std::uint8_t> decompressed;
            std::string error;
            if (try_decompress_zstd_segment(bytes, segment, decompressed, error)) {
                output << "Decompressed segment: id=" << segment.id
                       << ", type=" << segment.type
                       << ", bytes=" << decompressed.size()
                       << ", hex=" << format_hex_preview(decompressed, 24)
                       << ", ascii=\"" << format_ascii_preview(decompressed, 48) << "\"" << '\n';
            } else {
                output << "Decompressed segment failed: id=" << segment.id
                       << ", type=" << segment.type
                       << ", error=" << error << '\n';
            }

            ++decompressed_preview_count;
            if (decompressed_preview_count >= 3) {
                break;
            }
        }
    }

    return output.str();
}

std::string probe_replay_file(const std::string& path) {
    return probe_replay_bytes(read_file_bytes(path));
}

std::string inspect_replay_bytes(const std::vector<std::uint8_t>& bytes) {
    std::ostringstream output;
    output << "Replay inspect\n";

    const ReplaySummary summary = parse_replay_bytes(bytes);
    output << "Container format: " << summary.container.format << '\n';
    output << "Metadata source: " << summary.container.metadata_source << '\n';
    output << "Timeline hints: gameLengthMillis=" << summary.game_length_millis
           << ", lastGameChunkId=" << summary.last_game_chunk_id
           << ", lastKeyFrameId=" << summary.last_keyframe_id << '\n';
    output << "Capabilities: segmentTable=" << (summary.capabilities.segment_table_available ? "yes" : "no")
           << ", payloadDecoding=" << (summary.capabilities.payload_decoding_available ? "yes" : "no") << '\n';

    if (!summary.capabilities.segment_table_available) {
        output << "No indexed payload records are available for inspection.\n";
        return output.str();
    }
    if (!summary.capabilities.payload_decoding_available) {
        output << "Payload decompression is not available for this replay.\n";
        return output.str();
    }

    bool inspected_startup = false;
    bool inspected_keyframe = false;
    int inspected_chunks = 0;
    int inspected_segments = 0;
    for (const ReplaySegmentSummary& segment : summary.container.segments) {
        if (segment.codec != "zstd") {
            continue;
        }

        bool inspect_segment = false;
        if (segment.type == "startup" && !inspected_startup) {
            inspected_startup = true;
            inspect_segment = true;
        } else if (segment.type == "keyframe" && !inspected_keyframe) {
            inspected_keyframe = true;
            inspect_segment = true;
        } else if (segment.type == "chunk" && inspected_chunks < 4) {
            inspected_chunks += 1;
            inspect_segment = true;
        }

        if (!inspect_segment) {
            continue;
        }

        std::vector<std::uint8_t> decompressed;
        std::string error;
        if (try_decompress_zstd_segment(bytes, segment, decompressed, error)) {
            output << inspect_decompressed_segment(segment, decompressed);
        } else {
            output << "Segment " << segment.type << '#' << segment.id << " failed to decompress: " << error << '\n';
        }

        output << '\n';
        inspected_segments += 1;
        if (inspected_segments >= 6) {
            break;
        }
    }

    if (inspected_segments == 0) {
        output << "No zstd-backed segments were selected for inspection.\n";
    }

    output << "--- Subrecord Grouping Analysis (Chunks 4-6) ---\n";
    std::vector<SubrecordGroup> groups;
    int total_subrecords = 0;

    for (const ReplaySegmentSummary& segment : summary.container.segments) {
        if (segment.codec != "zstd" || segment.type != "chunk") continue;
        if (segment.chunk_id >= 4 && segment.chunk_id <= 6) {
            std::vector<std::uint8_t> decompressed;
            std::string error;
            if (try_decompress_zstd_segment(bytes, segment, decompressed, error)) {
                const auto best_u16 = analyze_le_length_prefix(decompressed, 2);
                if (best_u16.record_count >= 2) {
                    auto records = extract_le_framed_subrecords(decompressed, 2, best_u16.start_offset, 1000000);
                    total_subrecords += static_cast<int>(records.size());
                    for (const auto& rec : records) {
                        if (rec.length == 0) continue;
                        std::uint8_t sig = decompressed[rec.payload_offset];
                        
                        auto it = std::find_if(groups.begin(), groups.end(), [&](const SubrecordGroup& g) {
                            return g.size == rec.length && g.sig == sig;
                        });
                        
                        if (it == groups.end()) {
                            SubrecordGroup g;
                            g.size = rec.length;
                            g.sig = sig;
                            g.count = 1;
                            std::vector<std::uint8_t> preview;
                            std::size_t p_len = std::min(rec.length, static_cast<std::size_t>(32));
                            preview.assign(decompressed.begin() + static_cast<std::ptrdiff_t>(rec.payload_offset), 
                                           decompressed.begin() + static_cast<std::ptrdiff_t>(rec.payload_offset + p_len));
                            g.examples.push_back(std::move(preview));
                            groups.push_back(std::move(g));
                        } else {
                            it->count++;
                            if (it->examples.size() < 3) {
                                std::vector<std::uint8_t> preview;
                                std::size_t p_len = std::min(rec.length, static_cast<std::size_t>(32));
                                preview.assign(decompressed.begin() + static_cast<std::ptrdiff_t>(rec.payload_offset), 
                                               decompressed.begin() + static_cast<std::ptrdiff_t>(rec.payload_offset + p_len));
                                it->examples.push_back(std::move(preview));
                            }
                        }
                    }
                }
            }
        }
    }

    std::sort(groups.begin(), groups.end(), [](const SubrecordGroup& a, const SubrecordGroup& b) {
        if (a.count != b.count) return a.count > b.count;
        if (a.size != b.size) return a.size > b.size;
        return a.sig > b.sig;
    });

    output << "Extracted " << total_subrecords << " subrecords from chunks 4-6.\n";
    output << "Distinct signature/size groups: " << groups.size() << "\n\n";

    for (const auto& g : groups) {
        output << "Group [sig=0x" << std::hex << std::uppercase << std::setw(2) << std::setfill('0') << static_cast<int>(g.sig) 
               << std::dec << std::nouppercase << " (ascii: " << (std::isprint(g.sig) ? std::string(1, static_cast<char>(g.sig)) : ".") 
               << "), size=" << g.size << "]: " << g.count << " records\n";
        for (std::size_t i = 0; i < g.examples.size(); ++i) {
            output << "  ex " << i + 1 << " hex: " << format_hex_preview(g.examples[i], g.examples[i].size()) << "\n";
            output << "  ex " << i + 1 << " asc: \"" << format_ascii_preview(g.examples[i], g.examples[i].size()) << "\"\n";
        }
    }

    return output.str();
}

std::string inspect_replay_file(const std::string& path) {
    return inspect_replay_bytes(read_file_bytes(path));
}

ReplaySummary parse_replay_file(const std::string& path) {
    return parse_replay_bytes(read_file_bytes(path));
}

ReplaySummary parse_replay_file(
    const std::string& path,
    const DecoderProfileRegistry& decoder_profiles
) {
    return parse_replay_bytes(read_file_bytes(path), decoder_profiles);
}

namespace {

constexpr std::size_t kPacketDumpHexLimit = 4096;

[[nodiscard]] PacketSegmentKind packet_segment_kind_from_name(std::string_view type) {
    if (type == "startup") return PacketSegmentKind::startup;
    if (type == "keyframe") return PacketSegmentKind::keyframe;
    if (type == "chunk") return PacketSegmentKind::chunk;
    return PacketSegmentKind::unknown;
}

[[nodiscard]] long long packet_timestamp_millis(double seconds) {
    return static_cast<long long>(std::llround(static_cast<double>(seconds) * 1000.0));
}

[[nodiscard]] std::string packet_version_group(std::string_view version) {
    const std::size_t first = version.find('.');
    if (first == std::string_view::npos) return version.empty() ? "unknown" : std::string(version);
    const std::size_t second = version.find('.', first + 1);
    return second == std::string_view::npos ? std::string(version) : std::string(version.substr(0, second));
}

[[nodiscard]] std::string packet_bytes_to_hex(std::span<const std::uint8_t> bytes) {
    static constexpr char digits[] = "0123456789abcdef";
    std::string output(bytes.size() * 2, '0');
    for (std::size_t i = 0; i < bytes.size(); ++i) {
        output[i * 2] = digits[(bytes[i] >> 4U) & 0x0FU];
        output[i * 2 + 1] = digits[bytes[i] & 0x0FU];
    }
    return output;
}

struct PacketScanError {
    ReplaySegmentSummary segment;
    std::string code;
    std::string message;
    bool has_parse_error = false;
    PacketBlockParseError parse_error;
};

struct PacketSegmentScanReport {
    ReplaySegmentSummary segment;
    bool decompressed = false;
    bool parse_ok = false;
    bool exactly_consumed = false;
    std::size_t input_bytes = 0;
    std::size_t consumed_bytes = 0;
    std::size_t packet_count = 0;
    long long first_timestamp_millis = 0;
    long long last_timestamp_millis = 0;
    bool has_timestamp = false;
    std::string error_code;
    std::string error_message;
    bool has_parse_error = false;
    PacketBlockParseError parse_error;
};

struct PacketFileScan {
    std::string segment_filter;
    std::size_t selected_segment_count = 0;
    std::size_t decompressed_segment_count = 0;
    std::size_t exact_segment_count = 0;
    std::size_t packet_count = 0;
    std::size_t input_bytes = 0;
    std::size_t consumed_bytes = 0;
    std::vector<PacketSegmentScanReport> segments;
    std::vector<PacketScanError> errors;
};

template <typename Visitor>
[[nodiscard]] PacketFileScan scan_packet_segments(
    const std::vector<std::uint8_t>& replay_bytes,
    const ReplaySummary& summary,
    std::string_view segment_type,
    Visitor&& visitor
) {
    PacketFileScan scan;
    scan.segment_filter = normalize_segment_type_filter(segment_type);
    for (const ReplaySegmentSummary& segment : summary.container.segments) {
        if (!segment_type_matches_filter(segment.type, scan.segment_filter)) continue;
        scan.selected_segment_count += 1;
        PacketSegmentScanReport report;
        report.segment = segment;
        if (segment.codec != "zstd") {
            report.error_code = "unsupported_codec";
            report.error_message = "Selected replay segment is not zstd-compressed.";
            scan.errors.push_back({segment, report.error_code, report.error_message});
            scan.segments.push_back(std::move(report));
            continue;
        }
        std::vector<std::uint8_t> decompressed;
        std::string decompression_error;
        if (!try_decompress_zstd_segment(replay_bytes, segment, decompressed, decompression_error)) {
            report.error_code = "zstd_decompression_failed";
            report.error_message = decompression_error;
            scan.errors.push_back({segment, report.error_code, report.error_message});
            scan.segments.push_back(std::move(report));
            continue;
        }
        report.decompressed = true;
        scan.decompressed_segment_count += 1;
        const PacketSegmentProvenance provenance{
            packet_segment_kind_from_name(segment.type),
            segment.id,
            segment.chunk_id,
            static_cast<std::size_t>(std::max(segment.header_offset, 0)),
            static_cast<std::size_t>(std::max(segment.payload_offset, 0)),
        };
        const PacketBlockParseResult result = parse_packet_blocks(
            std::span<const std::uint8_t>(decompressed.data(), decompressed.size()), provenance);
        report.parse_ok = result.ok();
        report.exactly_consumed = result.exactly_consumed();
        report.input_bytes = result.input_size;
        report.consumed_bytes = result.consumed_bytes;
        report.packet_count = result.blocks.size();
        scan.input_bytes += result.input_size;
        scan.consumed_bytes += result.consumed_bytes;
        scan.packet_count += result.blocks.size();
        if (result.exactly_consumed()) scan.exact_segment_count += 1;
        if (!result.blocks.empty()) {
            report.has_timestamp = true;
            report.first_timestamp_millis = packet_timestamp_millis(result.blocks.front().timestamp_seconds);
            report.last_timestamp_millis = packet_timestamp_millis(result.blocks.back().timestamp_seconds);
        }
        if (result.error.has_value()) {
            report.error_code = std::string(packet_block_parse_error_code_name(result.error->code));
            report.error_message = result.error->message;
            report.has_parse_error = true;
            report.parse_error = *result.error;
            PacketScanError error{segment, report.error_code, report.error_message};
            error.has_parse_error = true;
            error.parse_error = *result.error;
            scan.errors.push_back(std::move(error));
        }
        visitor(segment, decompressed, result);
        scan.segments.push_back(std::move(report));
    }
    return scan;
}

void write_packet_scan_error_json(std::ostringstream& output, const PacketScanError& error) {
    output << '{';
    output << "\"segmentType\":\"" << json_escape(error.segment.type) << "\",";
    output << "\"segmentId\":" << error.segment.id << ',';
    output << "\"chunkId\":" << error.segment.chunk_id << ',';
    output << "\"code\":\"" << json_escape(error.code) << "\",";
    output << "\"message\":\"" << json_escape(error.message) << "\"";
    if (error.has_parse_error) {
        output << ",\"blockIndex\":" << error.parse_error.block_index;
        output << ",\"blockOffset\":" << error.parse_error.block_offset;
        output << ",\"errorOffset\":" << error.parse_error.error_offset;
        output << ",\"expectedBytes\":" << error.parse_error.expected_bytes;
        output << ",\"availableBytes\":" << error.parse_error.available_bytes;
        output << ",\"declaredContentLength\":" << error.parse_error.declared_content_length;
    }
    output << '}';
}

struct PacketTypeSegmentAggregate {
    int segment_id = 0;
    int chunk_id = 0;
    std::size_t segment_header_offset = 0;
    std::size_t segment_payload_offset = 0;
    std::size_t count = 0;
    long long first_timestamp_millis = 0;
    long long last_timestamp_millis = 0;
};

struct PacketTypeKey {
    std::string segment_type;
    std::uint8_t channel = 0;
    std::uint16_t packet_type = 0;
    bool operator<(const PacketTypeKey& other) const {
        if (segment_type != other.segment_type) return segment_type < other.segment_type;
        if (channel != other.channel) return channel < other.channel;
        return packet_type < other.packet_type;
    }
};

struct PacketTypeAggregate {
    PacketTypeKey key;
    std::size_t count = 0;
    std::uint64_t total_content_bytes = 0;
    long long first_timestamp_millis = 0;
    long long last_timestamp_millis = 0;
    std::size_t nonzero_block_param_count = 0;
    std::size_t delta_timestamp_count = 0;
    std::size_t compact_length_count = 0;
    std::size_t inherited_packet_type_count = 0;
    std::size_t compact_block_param_count = 0;
    std::map<std::uint32_t, std::size_t> content_lengths;
    std::map<std::uint8_t, std::size_t> markers;
    std::map<std::uint32_t, std::size_t> block_params;
    std::map<std::pair<int, int>, PacketTypeSegmentAggregate> segments;
};

struct DumpedPacketBlock {
    ReplaySegmentSummary segment;
    std::size_t block_index = 0;
    std::uint8_t marker = 0;
    std::uint8_t channel = 0;
    long long timestamp_millis = 0;
    bool timestamp_is_delta = false;
    std::uint8_t timestamp_delta_milliseconds = 0;
    std::uint32_t content_length = 0;
    bool content_length_is_compact = false;
    std::uint16_t packet_type = 0;
    bool packet_type_is_inherited = false;
    std::uint32_t block_param = 0;
    bool block_param_is_compact = false;
    std::uint8_t block_param_delta = 0;
    std::int16_t block_param_signed_delta = 0;
    std::size_t header_offset = 0;
    std::size_t content_offset = 0;
    std::size_t end_offset = 0;
    std::size_t content_hex_bytes = 0;
    std::string content_hex;
};

[[nodiscard]] DumpedPacketBlock make_dumped_packet_block(
    const ReplaySegmentSummary& segment,
    const std::vector<std::uint8_t>& decompressed,
    const PacketBlock& block
) {
    DumpedPacketBlock entry;
    entry.segment = segment;
    entry.block_index = block.block_index;
    entry.marker = block.marker;
    entry.channel = block.channel;
    entry.timestamp_millis = packet_timestamp_millis(block.timestamp_seconds);
    entry.timestamp_is_delta = block.timestamp_is_delta;
    entry.timestamp_delta_milliseconds = block.timestamp_delta_milliseconds;
    entry.content_length = block.content_length;
    entry.content_length_is_compact = block.content_length_is_compact;
    entry.packet_type = block.packet_type;
    entry.packet_type_is_inherited = block.packet_type_is_inherited;
    entry.block_param = block.block_param;
    entry.block_param_is_compact = block.block_param_is_compact;
    entry.block_param_delta = block.block_param_delta;
    entry.block_param_signed_delta = block.block_param_signed_delta;
    entry.header_offset = block.header_offset;
    entry.content_offset = block.content_offset;
    entry.end_offset = block.end_offset;
    entry.content_hex_bytes = std::min<std::size_t>(block.content_length, kPacketDumpHexLimit);
    entry.content_hex = packet_bytes_to_hex(std::span<const std::uint8_t>(
        decompressed.data() + block.content_offset, entry.content_hex_bytes));
    return entry;
}

void write_dumped_packet_block_json(std::ostringstream& output, const DumpedPacketBlock& block) {
    output << '{';
    output << "\"segmentType\":\"" << json_escape(block.segment.type) << "\",";
    output << "\"segmentId\":" << block.segment.id << ',';
    output << "\"chunkId\":" << block.segment.chunk_id << ',';
    output << "\"segmentHeaderOffset\":" << block.segment.header_offset << ',';
    output << "\"segmentPayloadOffset\":" << block.segment.payload_offset << ',';
    output << "\"blockIndex\":" << block.block_index << ',';
    output << "\"sourceOffset\":" << block.header_offset << ',';
    output << "\"headerOffset\":" << block.header_offset << ',';
    output << "\"contentOffset\":" << block.content_offset << ',';
    output << "\"endOffset\":" << block.end_offset << ',';
    output << "\"marker\":" << static_cast<unsigned int>(block.marker) << ',';
    output << "\"channel\":" << static_cast<unsigned int>(block.channel) << ',';
    output << "\"timestampMillis\":" << block.timestamp_millis << ',';
    output << "\"timestampIsDelta\":" << bool_to_json(block.timestamp_is_delta) << ',';
    output << "\"timestampDeltaMilliseconds\":" << static_cast<unsigned int>(block.timestamp_delta_milliseconds) << ',';
    output << "\"packetType\":" << block.packet_type << ',';
    output << "\"packetTypeIsInherited\":" << bool_to_json(block.packet_type_is_inherited) << ',';
    output << "\"blockParam\":" << block.block_param << ',';
    output << "\"blockParamIsCompact\":" << bool_to_json(block.block_param_is_compact) << ',';
    output << "\"rawBlockParam\":" << (block.block_param_is_compact ? static_cast<std::uint32_t>(block.block_param_delta) : block.block_param) << ',';
    output << "\"blockParamDelta\":" << static_cast<unsigned int>(block.block_param_delta) << ',';
    output << "\"blockParamSignedDelta\":" << block.block_param_signed_delta << ',';
    output << "\"contentLength\":" << block.content_length << ',';
    output << "\"contentLengthIsCompact\":" << bool_to_json(block.content_length_is_compact) << ',';
    output << "\"contentHexBytes\":" << block.content_hex_bytes << ',';
    output << "\"contentHexTruncated\":" << bool_to_json(block.content_hex_bytes < block.content_length) << ',';
    output << "\"contentHex\":\"" << block.content_hex << "\"";
    output << '}';
}

}  // namespace

std::string validate_packet_framing_file_json(const std::string& path, std::string_view segment_type) {
    const std::vector<std::uint8_t> bytes = read_file_bytes(path);
    const ReplaySummary summary = parse_replay_bytes(bytes);
    const PacketFileScan scan = scan_packet_segments(
        bytes, summary, segment_type,
        [](const ReplaySegmentSummary&, const std::vector<std::uint8_t>&, const PacketBlockParseResult&) {});

    std::ostringstream output;
    output << '{';
    output << "\"schema\":\"packet-framing-validation.v1\",";
    output << "\"replayPath\":\"" << json_escape(path) << "\",";
    output << "\"gameVersion\":\"" << json_escape(summary.game_version) << "\",";
    output << "\"versionGroup\":\"" << json_escape(packet_version_group(summary.game_version)) << "\",";
    output << "\"segmentType\":\"" << json_escape(scan.segment_filter) << "\",";
    output << "\"selectedSegmentCount\":" << scan.selected_segment_count << ',';
    output << "\"decompressedSegmentCount\":" << scan.decompressed_segment_count << ',';
    output << "\"validSegmentCount\":" << scan.exact_segment_count << ',';
    output << "\"packetCount\":" << scan.packet_count << ',';
    output << "\"inputBytes\":" << scan.input_bytes << ',';
    output << "\"consumedBytes\":" << scan.consumed_bytes << ',';
    output << "\"valid\":" << bool_to_json(scan.selected_segment_count > 0 && scan.exact_segment_count == scan.selected_segment_count) << ',';
    output << "\"segments\":[";
    for (std::size_t index = 0; index < scan.segments.size(); ++index) {
        if (index > 0) output << ',';
        const PacketSegmentScanReport& report = scan.segments[index];
        output << '{';
        output << "\"segmentType\":\"" << json_escape(report.segment.type) << "\",";
        output << "\"segmentId\":" << report.segment.id << ',';
        output << "\"chunkId\":" << report.segment.chunk_id << ',';
        output << "\"segmentHeaderOffset\":" << report.segment.header_offset << ',';
        output << "\"segmentPayloadOffset\":" << report.segment.payload_offset << ',';
        output << "\"compressedLength\":" << report.segment.length << ',';
        output << "\"advertisedUncompressedLength\":" << report.segment.uncompressed_length << ',';
        output << "\"decompressed\":" << bool_to_json(report.decompressed) << ',';
        output << "\"parseOk\":" << bool_to_json(report.parse_ok) << ',';
        output << "\"exactlyConsumed\":" << bool_to_json(report.exactly_consumed) << ',';
        output << "\"inputBytes\":" << report.input_bytes << ',';
        output << "\"consumedBytes\":" << report.consumed_bytes << ',';
        output << "\"packetCount\":" << report.packet_count << ',';
        if (report.has_timestamp) {
            output << "\"firstTimestampMillis\":" << report.first_timestamp_millis << ',';
            output << "\"lastTimestampMillis\":" << report.last_timestamp_millis << ',';
        } else {
            output << "\"firstTimestampMillis\":null,\"lastTimestampMillis\":null,";
        }
        if (report.error_code.empty()) {
            output << "\"error\":null";
        } else {
            output << "\"error\":{";
            output << "\"code\":\"" << json_escape(report.error_code) << "\",";
            output << "\"message\":\"" << json_escape(report.error_message) << "\"";
            if (report.has_parse_error) {
                output << ",\"blockIndex\":" << report.parse_error.block_index;
                output << ",\"blockOffset\":" << report.parse_error.block_offset;
                output << ",\"errorOffset\":" << report.parse_error.error_offset;
                output << ",\"expectedBytes\":" << report.parse_error.expected_bytes;
                output << ",\"availableBytes\":" << report.parse_error.available_bytes;
                output << ",\"declaredContentLength\":" << report.parse_error.declared_content_length;
            }
            output << '}';
        }
        output << '}';
    }
    output << "],\"errors\":[";
    for (std::size_t index = 0; index < scan.errors.size(); ++index) {
        if (index > 0) output << ',';
        write_packet_scan_error_json(output, scan.errors[index]);
    }
    output << "]}";
    return output.str();
}

std::string summarize_packet_types_file_json(
    const std::string& path,
    std::string_view segment_type,
    std::size_t top_types
) {
    const std::vector<std::uint8_t> bytes = read_file_bytes(path);
    const ReplaySummary summary = parse_replay_bytes(bytes);
    std::map<PacketTypeKey, PacketTypeAggregate> groups;
    const PacketFileScan scan = scan_packet_segments(
        bytes, summary, segment_type,
        [&](const ReplaySegmentSummary& segment, const std::vector<std::uint8_t>&, const PacketBlockParseResult& result) {
            for (const PacketBlock& block : result.blocks) {
                const PacketTypeKey key{segment.type, block.channel, block.packet_type};
                auto [group_it, inserted] = groups.try_emplace(key);
                PacketTypeAggregate& group = group_it->second;
                if (inserted) group.key = key;
                const long long timestamp = packet_timestamp_millis(block.timestamp_seconds);
                if (group.count == 0) {
                    group.first_timestamp_millis = timestamp;
                    group.last_timestamp_millis = timestamp;
                } else {
                    group.first_timestamp_millis = std::min(group.first_timestamp_millis, timestamp);
                    group.last_timestamp_millis = std::max(group.last_timestamp_millis, timestamp);
                }
                group.count += 1;
                group.total_content_bytes += block.content_length;
                group.content_lengths[block.content_length] += 1;
                group.markers[block.marker] += 1;
                group.block_params[block.block_param] += 1;
                if (block.block_param != 0) group.nonzero_block_param_count += 1;
                if (block.timestamp_is_delta) group.delta_timestamp_count += 1;
                if (block.content_length_is_compact) group.compact_length_count += 1;
                if (block.packet_type_is_inherited) group.inherited_packet_type_count += 1;
                if (block.block_param_is_compact) group.compact_block_param_count += 1;

                const std::pair<int, int> segment_key{segment.id, segment.chunk_id};
                PacketTypeSegmentAggregate& segment_group = group.segments[segment_key];
                if (segment_group.count == 0) {
                    segment_group.segment_id = segment.id;
                    segment_group.chunk_id = segment.chunk_id;
                    segment_group.segment_header_offset = static_cast<std::size_t>(std::max(segment.header_offset, 0));
                    segment_group.segment_payload_offset = static_cast<std::size_t>(std::max(segment.payload_offset, 0));
                    segment_group.first_timestamp_millis = timestamp;
                    segment_group.last_timestamp_millis = timestamp;
                } else {
                    segment_group.first_timestamp_millis = std::min(segment_group.first_timestamp_millis, timestamp);
                    segment_group.last_timestamp_millis = std::max(segment_group.last_timestamp_millis, timestamp);
                }
                segment_group.count += 1;
            }
        });

    std::vector<const PacketTypeAggregate*> ranked;
    ranked.reserve(groups.size());
    for (const auto& entry : groups) ranked.push_back(&entry.second);
    std::sort(ranked.begin(), ranked.end(), [](const PacketTypeAggregate* left, const PacketTypeAggregate* right) {
        if (left->count != right->count) return left->count > right->count;
        if (left->key.segment_type != right->key.segment_type) return left->key.segment_type < right->key.segment_type;
        if (left->key.channel != right->key.channel) return left->key.channel < right->key.channel;
        return left->key.packet_type < right->key.packet_type;
    });
    if (top_types > 0 && ranked.size() > top_types) ranked.resize(top_types);

    std::ostringstream output;
    output << '{';
    output << "\"schema\":\"packet-type-catalog.v1\",";
    output << "\"replayPath\":\"" << json_escape(path) << "\",";
    output << "\"matchId\":" << summary.container.match_id << ',';
    output << "\"gameVersion\":\"" << json_escape(summary.game_version) << "\",";
    output << "\"versionGroup\":\"" << json_escape(packet_version_group(summary.game_version)) << "\",";
    output << "\"segmentType\":\"" << json_escape(scan.segment_filter) << "\",";
    output << "\"topTypes\":" << top_types << ',';
    output << "\"selectedSegmentCount\":" << scan.selected_segment_count << ',';
    output << "\"validSegmentCount\":" << scan.exact_segment_count << ',';
    output << "\"packetCount\":" << scan.packet_count << ',';
    output << "\"packetTypeGroupCount\":" << groups.size() << ',';
    output << "\"emittedPacketTypeGroupCount\":" << ranked.size() << ',';
    output << "\"valid\":" << bool_to_json(scan.selected_segment_count > 0 && scan.exact_segment_count == scan.selected_segment_count) << ',';
    output << "\"packetTypes\":[";
    for (std::size_t index = 0; index < ranked.size(); ++index) {
        if (index > 0) output << ',';
        const PacketTypeAggregate& group = *ranked[index];
        const std::size_t distinct_nonzero_params = group.block_params.size() - (group.block_params.contains(0) ? 1 : 0);
        output << '{';
        output << "\"segmentType\":\"" << json_escape(group.key.segment_type) << "\",";
        output << "\"channel\":" << static_cast<unsigned int>(group.key.channel) << ',';
        output << "\"packetType\":" << group.key.packet_type << ',';
        output << "\"count\":" << group.count << ',';
        output << "\"totalContentBytes\":" << group.total_content_bytes << ',';
        output << "\"minimumContentLength\":" << group.content_lengths.begin()->first << ',';
        output << "\"maximumContentLength\":" << group.content_lengths.rbegin()->first << ',';
        output << "\"firstTimestampMillis\":" << group.first_timestamp_millis << ',';
        output << "\"lastTimestampMillis\":" << group.last_timestamp_millis << ',';
        output << "\"nonzeroBlockParamCount\":" << group.nonzero_block_param_count << ',';
        output << "\"distinctBlockParamCount\":" << group.block_params.size() << ',';
        output << "\"distinctNonzeroBlockParamCount\":" << distinct_nonzero_params << ',';
        output << "\"deltaTimestampCount\":" << group.delta_timestamp_count << ',';
        output << "\"compactLengthCount\":" << group.compact_length_count << ',';
        output << "\"inheritedPacketTypeCount\":" << group.inherited_packet_type_count << ',';
        output << "\"compactBlockParamCount\":" << group.compact_block_param_count << ',';
        output << "\"contentLengths\":[";
        std::size_t item_index = 0;
        for (const auto& length : group.content_lengths) {
            if (item_index++ > 0) output << ',';
            output << "{\"contentLength\":" << length.first << ",\"count\":" << length.second << '}';
        }
        output << "],\"markers\":[";
        item_index = 0;
        for (const auto& marker : group.markers) {
            if (item_index++ > 0) output << ',';
            output << "{\"marker\":" << static_cast<unsigned int>(marker.first) << ",\"count\":" << marker.second << '}';
        }
        std::vector<std::pair<std::uint32_t, std::size_t>> top_params(group.block_params.begin(), group.block_params.end());
        std::sort(top_params.begin(), top_params.end(), [](const auto& left, const auto& right) {
            if (left.second != right.second) return left.second > right.second;
            return left.first < right.first;
        });
        if (top_params.size() > 16) top_params.resize(16);
        output << "],\"topBlockParams\":[";
        for (std::size_t param_index = 0; param_index < top_params.size(); ++param_index) {
            if (param_index > 0) output << ',';
            output << "{\"blockParam\":" << top_params[param_index].first << ",\"count\":" << top_params[param_index].second << '}';
        }
        output << "],\"segments\":[";
        item_index = 0;
        for (const auto& segment_entry : group.segments) {
            if (item_index++ > 0) output << ',';
            const PacketTypeSegmentAggregate& segment_group = segment_entry.second;
            output << '{';
            output << "\"segmentId\":" << segment_group.segment_id << ',';
            output << "\"chunkId\":" << segment_group.chunk_id << ',';
            output << "\"segmentHeaderOffset\":" << segment_group.segment_header_offset << ',';
            output << "\"segmentPayloadOffset\":" << segment_group.segment_payload_offset << ',';
            output << "\"count\":" << segment_group.count << ',';
            output << "\"firstTimestampMillis\":" << segment_group.first_timestamp_millis << ',';
            output << "\"lastTimestampMillis\":" << segment_group.last_timestamp_millis;
            output << '}';
        }
        output << "]}";
    }
    output << "],\"errors\":[";
    for (std::size_t index = 0; index < scan.errors.size(); ++index) {
        if (index > 0) output << ',';
        write_packet_scan_error_json(output, scan.errors[index]);
    }
    output << "]}";
    return output.str();
}

std::string dump_packet_type_file_json(
    const std::string& path,
    std::uint16_t packet_type,
    std::string_view segment_type,
    std::size_t max_blocks
) {
    const std::vector<std::uint8_t> bytes = read_file_bytes(path);
    const ReplaySummary summary = parse_replay_bytes(bytes);
    std::size_t matching_block_count = 0;
    std::vector<DumpedPacketBlock> dumped;
    const PacketFileScan scan = scan_packet_segments(
        bytes, summary, segment_type,
        [&](const ReplaySegmentSummary& segment, const std::vector<std::uint8_t>& decompressed, const PacketBlockParseResult& result) {
            for (const PacketBlock& block : result.blocks) {
                if (block.packet_type != packet_type) continue;
                matching_block_count += 1;
                if (max_blocks > 0 && dumped.size() >= max_blocks) continue;
                dumped.push_back(make_dumped_packet_block(segment, decompressed, block));
            }
        });

    std::ostringstream output;
    output << '{';
    output << "\"schema\":\"packet-type-dump.v1\",";
    output << "\"replayPath\":\"" << json_escape(path) << "\",";
    output << "\"matchId\":" << summary.container.match_id << ',';
    output << "\"gameVersion\":\"" << json_escape(summary.game_version) << "\",";
    output << "\"versionGroup\":\"" << json_escape(packet_version_group(summary.game_version)) << "\",";
    output << "\"segmentType\":\"" << json_escape(scan.segment_filter) << "\",";
    output << "\"packetType\":" << packet_type << ',';
    output << "\"maxBlocks\":" << max_blocks << ',';
    output << "\"matchingBlockCount\":" << matching_block_count << ',';
    output << "\"emittedBlockCount\":" << dumped.size() << ',';
    output << "\"truncated\":" << bool_to_json(dumped.size() < matching_block_count) << ',';
    output << "\"valid\":" << bool_to_json(scan.selected_segment_count > 0 && scan.exact_segment_count == scan.selected_segment_count) << ',';
    output << "\"blocks\":[";
    for (std::size_t index = 0; index < dumped.size(); ++index) {
        if (index > 0) output << ',';
        write_dumped_packet_block_json(output, dumped[index]);
    }
    output << "],\"errors\":[";
    for (std::size_t index = 0; index < scan.errors.size(); ++index) {
        if (index > 0) output << ',';
        write_packet_scan_error_json(output, scan.errors[index]);
    }
    output << "]}";
    return output.str();
}

std::string dump_packet_types_file_json(
    const std::string& path,
    const std::vector<std::uint16_t>& packet_types,
    std::string_view segment_type,
    std::size_t max_blocks_per_type
) {
    if (packet_types.empty()) {
        throw std::invalid_argument("At least one packet type is required");
    }

    const std::set<std::uint16_t> selected_types(packet_types.begin(), packet_types.end());
    const std::vector<std::uint8_t> bytes = read_file_bytes(path);
    const ReplaySummary summary = parse_replay_bytes(bytes);
    std::map<std::uint16_t, std::size_t> matching_block_counts;
    std::map<std::uint16_t, std::vector<DumpedPacketBlock>> dumped_by_type;
    for (const std::uint16_t packet_type : selected_types) {
        matching_block_counts.emplace(packet_type, 0);
        dumped_by_type.emplace(packet_type, std::vector<DumpedPacketBlock>{});
    }

    const PacketFileScan scan = scan_packet_segments(
        bytes, summary, segment_type,
        [&](const ReplaySegmentSummary& segment, const std::vector<std::uint8_t>& decompressed, const PacketBlockParseResult& result) {
            for (const PacketBlock& block : result.blocks) {
                const auto count_it = matching_block_counts.find(block.packet_type);
                if (count_it == matching_block_counts.end()) continue;
                count_it->second += 1;
                std::vector<DumpedPacketBlock>& dumped = dumped_by_type.at(block.packet_type);
                if (max_blocks_per_type > 0 && dumped.size() >= max_blocks_per_type) continue;
                dumped.push_back(make_dumped_packet_block(segment, decompressed, block));
            }
        });

    std::ostringstream output;
    output << '{';
    output << "\"schema\":\"packet-types-dump.v1\",";
    output << "\"replayPath\":\"" << json_escape(path) << "\",";
    output << "\"matchId\":" << summary.container.match_id << ',';
    output << "\"gameVersion\":\"" << json_escape(summary.game_version) << "\",";
    output << "\"versionGroup\":\"" << json_escape(packet_version_group(summary.game_version)) << "\",";
    output << "\"segmentType\":\"" << json_escape(scan.segment_filter) << "\",";
    output << "\"packetTypes\":[";
    std::size_t type_index = 0;
    for (const std::uint16_t packet_type : selected_types) {
        if (type_index++ > 0) output << ',';
        output << packet_type;
    }
    output << "],\"maxBlocksPerPacketType\":" << max_blocks_per_type << ',';
    output << "\"valid\":" << bool_to_json(scan.selected_segment_count > 0 && scan.exact_segment_count == scan.selected_segment_count) << ',';
    output << "\"packetTypeDumps\":[";
    type_index = 0;
    for (const std::uint16_t packet_type : selected_types) {
        if (type_index++ > 0) output << ',';
        const std::size_t matching_block_count = matching_block_counts.at(packet_type);
        const std::vector<DumpedPacketBlock>& dumped = dumped_by_type.at(packet_type);
        output << '{';
        output << "\"packetType\":" << packet_type << ',';
        output << "\"matchingBlockCount\":" << matching_block_count << ',';
        output << "\"emittedBlockCount\":" << dumped.size() << ',';
        output << "\"truncated\":" << bool_to_json(dumped.size() < matching_block_count) << ',';
        output << "\"blocks\":[";
        for (std::size_t block_index = 0; block_index < dumped.size(); ++block_index) {
            if (block_index > 0) output << ',';
            write_dumped_packet_block_json(output, dumped[block_index]);
        }
        output << "]}";
    }
    output << "],\"errors\":[";
    for (std::size_t index = 0; index < scan.errors.size(); ++index) {
        if (index > 0) output << ',';
        write_packet_scan_error_json(output, scan.errors[index]);
    }
    output << "]}";
    return output.str();
}

namespace {

struct KillPacketProfile {
    std::string version_group;
    std::uint8_t channel = 1;
    std::uint16_t owner_sequence_packet_type = 0;
    std::uint16_t death_marker_packet_type = 0;
    std::size_t death_marker_content_length = 5;
    std::uint32_t champion_network_id_base = 0;
    std::size_t timestamp_tolerance_millis = 1;
    std::string owner_order = "victim-assists-killer";
};

const std::array<KillPacketProfile, 8> kKillPacketProfiles{{
    {"15.22", 1, 0x0015, 0x01D4, 5, 0x40000099, 1},
    {"15.23", 1, 0x0105, 0x0343, 5, 0x400004CC, 1},
    {"15.24", 1, 0x01D8, 0x020E, 5, 0x40000147, 1},
    {"16.1", 1, 0x02D6, 0x0093, 5, 0x400000AD, 1},
    {"16.5", 1, 0x021A, 0x03EF, 5, 0x400000AD, 1},
    {"16.6", 1, 0x02EC, 0x001A, 5, 0x400000AD, 1},
    {"16.7", 1, 0x0052, 0x0452, 5, 0x400000AD, 1},
    {"16.9", 1, 0x0073, 0x02CB, 5, 0x400000AD, 1},
}};

struct KillRelevantBlock { PacketBlock block; long long timestamp_millis = 0; };

struct ReplayKillEvent {
    long long timestamp_millis = 0;
    int victim_participant_id = 0;
    int killer_participant_id = 0;
    std::vector<int> assisting_participant_ids;
    std::uint32_t victim_network_id = 0;
    std::uint32_t killer_network_id = 0;
    std::vector<std::uint32_t> assisting_network_ids;
    KillRelevantBlock death_marker;
    std::vector<KillRelevantBlock> owner_sequence;
};

struct KillDecodeResult {
    std::vector<ReplayKillEvent> events;
    std::vector<std::string> errors;
    std::vector<KillRelevantBlock> ignored_markers;
    std::size_t pending_owner_block_count = 0;
};

struct KillKdaRow {
    int participant_id = 0;
    int expected_kills = 0;
    int expected_deaths = 0;
    int expected_assists = 0;
    int decoded_kills = 0;
    int decoded_deaths = 0;
    int decoded_assists = 0;
    bool pass = false;
};

struct KillKdaValidation {
    std::vector<KillKdaRow> rows;
    std::size_t passing_participant_count = 0;
    bool pass = false;
};

struct KillSourceInfo {
    bool has_file = false;
    std::string replay_path;
    std::string replay_id;
    std::string match_id;
};

[[nodiscard]] const KillPacketProfile* find_kill_packet_profile(std::string_view version_group) {
    const auto found = std::find_if(kKillPacketProfiles.begin(), kKillPacketProfiles.end(),
        [version_group](const KillPacketProfile& profile) { return profile.version_group == version_group; });
    return found == kKillPacketProfiles.end() ? nullptr : &*found;
}

[[nodiscard]] KillPacketProfile adapt_kill_packet_profile(
    std::string_view version_group,
    const KillDecoderProfile& profile
) {
    return {
        std::string(version_group),
        profile.channel,
        profile.owner_sequence_packet_type,
        profile.death_marker_packet_type,
        profile.death_marker_content_length,
        profile.champion_network_id_base,
        profile.timestamp_tolerance_millis,
        profile.owner_order,
    };
}

[[nodiscard]] std::string fixed_hex(std::uint32_t value, int width) {
    std::ostringstream output;
    output << "0x" << std::uppercase << std::hex << std::setw(width) << std::setfill('0') << value;
    return output.str();
}

void write_decoder_profile_provenance_fields(
    std::ostringstream& output,
    const DecoderProfileRegistry* decoder_profiles
);

[[nodiscard]] std::string current_utc_iso8601() {
    const auto now = std::chrono::system_clock::now();
    const auto seconds = std::chrono::time_point_cast<std::chrono::seconds>(now);
    const auto milliseconds = std::chrono::duration_cast<std::chrono::milliseconds>(now - seconds).count();
    const std::time_t raw = std::chrono::system_clock::to_time_t(now);
    std::tm utc{};
#if defined(_WIN32)
    gmtime_s(&utc, &raw);
#else
    gmtime_r(&raw, &utc);
#endif
    std::ostringstream output;
    output << std::put_time(&utc, "%Y-%m-%dT%H:%M:%S") << '.'
           << std::setw(3) << std::setfill('0') << milliseconds << 'Z';
    return output.str();
}

[[nodiscard]] int owner_to_participant_id(std::uint32_t owner, const KillPacketProfile& profile) {
    if (owner <= profile.champion_network_id_base) return 0;
    const std::uint32_t participant_id = owner - profile.champion_network_id_base;
    return participant_id <= 10 ? static_cast<int>(participant_id) : 0;
}

void write_nullable_string(std::ostringstream& output, std::string_view value) {
    if (value.empty()) output << "null";
    else output << '"' << json_escape(value) << '"';
}

void write_kill_block_provenance_json(std::ostringstream& output, const KillRelevantBlock& relevant) {
    const PacketBlock& block = relevant.block;
    output << '{';
    output << "\"segmentType\":\"" << packet_segment_kind_name(block.provenance.kind) << "\",";
    output << "\"segmentId\":" << block.provenance.segment_id << ',';
    output << "\"chunkId\":" << block.provenance.chunk_id << ',';
    output << "\"segmentHeaderOffset\":" << block.provenance.segment_header_offset << ',';
    output << "\"segmentPayloadOffset\":" << block.provenance.segment_payload_offset << ',';
    output << "\"blockIndex\":" << block.block_index << ',';
    output << "\"decompressedHeaderOffset\":" << block.header_offset << ',';
    output << "\"decompressedContentOffset\":" << block.content_offset << ',';
    output << "\"decompressedEndOffset\":" << block.end_offset << '}';
}

[[nodiscard]] KillDecodeResult decode_kill_events(
    const std::vector<KillRelevantBlock>& relevant_blocks,
    const KillPacketProfile& profile
) {
    KillDecodeResult decoded;
    std::vector<KillRelevantBlock> pending_owner_blocks;
    for (const KillRelevantBlock& relevant : relevant_blocks) {
        if (relevant.block.packet_type == profile.owner_sequence_packet_type) {
            pending_owner_blocks.push_back(relevant);
            continue;
        }
        std::vector<KillRelevantBlock> owner_blocks;
        for (const KillRelevantBlock& owner : pending_owner_blocks) {
            const long long delta = owner.timestamp_millis >= relevant.timestamp_millis
                ? owner.timestamp_millis - relevant.timestamp_millis
                : relevant.timestamp_millis - owner.timestamp_millis;
            if (delta <= static_cast<long long>(profile.timestamp_tolerance_millis)) {
                owner_blocks.push_back(owner);
            }
        }
        if (relevant.block.content_length != profile.death_marker_content_length) {
            decoded.errors.push_back("unexpected-death-marker-length: Death marker length is " +
                std::to_string(relevant.block.content_length) + ", expected " +
                std::to_string(profile.death_marker_content_length) + ".");
        }
        if (owner_blocks.empty()) {
            decoded.ignored_markers.push_back(relevant);
            pending_owner_blocks.clear();
            continue;
        }
        std::vector<int> participant_ids;
        bool owner_outside_range = false;
        for (const KillRelevantBlock& owner : owner_blocks) {
            const int participant_id = owner_to_participant_id(owner.block.block_param, profile);
            participant_ids.push_back(participant_id);
            owner_outside_range = owner_outside_range || participant_id == 0;
        }
        if (owner_outside_range) {
            decoded.errors.push_back("owner-outside-champion-range: Owner sequence contains a network ID outside the profiled champion range.");
            pending_owner_blocks.clear();
            continue;
        }
        const int victim_participant_id = owner_to_participant_id(relevant.block.block_param, profile);
        if (victim_participant_id == 0 || participant_ids.front() != victim_participant_id) {
            decoded.errors.push_back("death-marker-victim-mismatch: Death marker owner does not equal the first owner-sequence champion.");
            pending_owner_blocks.clear();
            continue;
        }
        ReplayKillEvent event;
        event.timestamp_millis = relevant.timestamp_millis;
        event.victim_participant_id = victim_participant_id;
        event.victim_network_id = relevant.block.block_param;
        event.death_marker = relevant;
        event.owner_sequence = owner_blocks;
        if (participant_ids.size() == 1) {
            event.killer_participant_id = 0;
        } else {
            event.killer_participant_id = participant_ids.back();
            event.killer_network_id = owner_blocks.back().block.block_param;
            event.assisting_participant_ids.assign(participant_ids.begin() + 1, participant_ids.end() - 1);
            for (std::size_t index = 1; index + 1 < owner_blocks.size(); ++index) {
                event.assisting_network_ids.push_back(owner_blocks[index].block.block_param);
            }
        }
        decoded.events.push_back(std::move(event));
        pending_owner_blocks.clear();
    }
    decoded.pending_owner_block_count = pending_owner_blocks.size();
    return decoded;
}

[[nodiscard]] KillKdaValidation validate_kill_final_kda(
    const std::vector<PlayerSummary>& participants,
    const std::vector<ReplayKillEvent>& events
) {
    KillKdaValidation validation;
    for (std::size_t index = 0; index < participants.size(); ++index) {
        KillKdaRow row;
        row.participant_id = static_cast<int>(index + 1);
        row.expected_kills = participants[index].kills;
        row.expected_deaths = participants[index].deaths;
        row.expected_assists = participants[index].assists;
        for (const ReplayKillEvent& event : events) {
            if (event.killer_participant_id == row.participant_id) ++row.decoded_kills;
            if (event.victim_participant_id == row.participant_id) ++row.decoded_deaths;
            if (std::find(event.assisting_participant_ids.begin(), event.assisting_participant_ids.end(), row.participant_id)
                != event.assisting_participant_ids.end()) ++row.decoded_assists;
        }
        row.pass = row.decoded_kills == row.expected_kills && row.decoded_deaths == row.expected_deaths &&
                   row.decoded_assists == row.expected_assists;
        if (row.pass) ++validation.passing_participant_count;
        validation.rows.push_back(row);
    }
    validation.pass = validation.rows.size() == 10 && validation.passing_participant_count == validation.rows.size();
    return validation;
}

void write_kda_validation_json(std::ostringstream& output, const KillKdaValidation& validation) {
    output << "{\"source\":\"replay-metadata-statsJson\",\"runtimeInput\":\"rofl-only\",";
    output << "\"participantCount\":" << validation.rows.size() << ',';
    output << "\"passingParticipantCount\":" << validation.passing_participant_count << ',';
    output << "\"pass\":" << bool_to_json(validation.pass) << ",\"rows\":[";
    for (std::size_t index = 0; index < validation.rows.size(); ++index) {
        if (index > 0) output << ',';
        const KillKdaRow& row = validation.rows[index];
        output << "{\"participantId\":" << row.participant_id;
        output << ",\"expected\":{\"kills\":" << row.expected_kills << ",\"deaths\":" << row.expected_deaths
               << ",\"assists\":" << row.expected_assists << "}";
        output << ",\"decoded\":{\"kills\":" << row.decoded_kills << ",\"deaths\":" << row.decoded_deaths
               << ",\"assists\":" << row.decoded_assists << "}";
        output << ",\"pass\":" << bool_to_json(row.pass) << '}';
    }
    output << "]}";
}

[[nodiscard]] std::string extract_replay_kills_impl(
    const std::vector<std::uint8_t>& bytes,
    const KillSourceInfo& source,
    const DecoderProfileRegistry* decoder_profiles
) {
    const ReplaySummary summary = decoder_profiles == nullptr
        ? parse_replay_bytes(bytes)
        : parse_replay_bytes(bytes, *decoder_profiles);
    const std::string version_group = packet_version_group(summary.game_version);
    std::optional<KillPacketProfile> external_profile;
    const KillPacketProfile* profile = nullptr;
    if (decoder_profiles != nullptr) {
        const DecoderVersionProfile* selected =
            find_decoder_profile(*decoder_profiles, summary.game_version);
        if (selected == nullptr || !selected->kill.has_value()) {
            throw std::runtime_error(
                "Unsupported replay version " + summary.game_version +
                ": external decoder registry has no kill profile."
            );
        }
        external_profile = adapt_kill_packet_profile(version_group, *selected->kill);
        profile = &*external_profile;
    } else {
        profile = find_kill_packet_profile(version_group);
    }
    if (profile == nullptr) {
        throw std::runtime_error("Unsupported replay version " + summary.game_version +
            ". Supported groups: 15.22, 15.23, 15.24, 16.1, 16.5, 16.6, 16.7, 16.9.");
    }
    std::vector<KillRelevantBlock> relevant_blocks;
    const PacketFileScan scan = scan_packet_segments(bytes, summary, "chunk",
        [&](const ReplaySegmentSummary&, const std::vector<std::uint8_t>&, const PacketBlockParseResult& result) {
            for (const PacketBlock& block : result.blocks) {
                if (block.channel == profile->channel && (block.packet_type == profile->owner_sequence_packet_type ||
                    block.packet_type == profile->death_marker_packet_type)) {
                    relevant_blocks.push_back({block, packet_timestamp_millis(block.timestamp_seconds)});
                }
            }
        });
    if (scan.selected_segment_count == 0) throw std::runtime_error("Replay contains no footer-style chunk records.");
    if (scan.exact_segment_count != scan.selected_segment_count || !scan.errors.empty()) {
        const std::string detail = scan.errors.empty() ? "one or more chunks were not exactly consumed"
            : scan.errors.front().code + ": " + scan.errors.front().message;
        throw std::runtime_error("Replay chunk packet framing failed: " + detail);
    }
    const KillDecodeResult decoded = decode_kill_events(relevant_blocks, *profile);
    if (!decoded.errors.empty()) throw std::runtime_error("Kill decoding failed with " +
        std::to_string(decoded.errors.size()) + " error(s). " + decoded.errors.front());
    const KillKdaValidation validation = validate_kill_final_kda(summary.players, decoded.events);
    if (!validation.pass) throw std::runtime_error("Decoded kill events do not match replay metadata final K/D/A for " +
        std::to_string(validation.rows.size() - validation.passing_participant_count) + " participant(s).");
    const std::size_t owner_sequence_count = static_cast<std::size_t>(std::count_if(
        relevant_blocks.begin(), relevant_blocks.end(), [&](const KillRelevantBlock& relevant) {
            return relevant.block.packet_type == profile->owner_sequence_packet_type;
        }));
    const std::size_t death_marker_count = relevant_blocks.size() - owner_sequence_count;

    std::ostringstream output;
    output << "{\"schema\":\"rofl-replay-kills/v1\",\"generatedAtUtc\":\"" << current_utc_iso8601() << "\",";
    output << "\"source\":{\"replayPath\":";
    if (source.has_file) output << '"' << json_escape(source.replay_path) << '"'; else output << "null";
    output << ",\"replayId\":";
    if (source.has_file) output << '"' << json_escape(source.replay_id) << '"'; else output << "null";
    output << ",\"matchId\":";
    if (source.has_file) output << '"' << json_escape(source.match_id) << '"'; else output << "null";
    output << ",\"runtimeInput\":\"rofl-only\",\"riotApiInput\":false},";
    output << "\"gameVersion\":\"" << json_escape(summary.game_version) << "\",\"versionGroup\":\"" << version_group << "\",";
    output << "\"profile\":{\"channel\":" << static_cast<unsigned int>(profile->channel)
           << ",\"ownerSequencePacketType\":" << profile->owner_sequence_packet_type;
    output << ",\"ownerSequencePacketTypeHex\":\"" << fixed_hex(profile->owner_sequence_packet_type, 4) << "\"";
    output << ",\"deathMarkerPacketType\":" << profile->death_marker_packet_type;
    output << ",\"deathMarkerPacketTypeHex\":\"" << fixed_hex(profile->death_marker_packet_type, 4) << "\"";
    output << ",\"championNetworkIdBase\":" << profile->champion_network_id_base;
    output << ",\"championNetworkIdBaseHex\":\"" << fixed_hex(profile->champion_network_id_base, 8) << "\"";
    output << ",\"deathMarkerContentLength\":" << profile->death_marker_content_length;
    output << ",\"timestampToleranceMillis\":" << profile->timestamp_tolerance_millis;
    output << ",\"ownerOrder\":\"[victim, ...ordered assists, killer]\"";
    output << ",\"executionRule\":\"A one-owner sequence has killerParticipantId=0.\"";
    write_decoder_profile_provenance_fields(output, decoder_profiles);
    output << "},";
    output << "\"replay\":{\"gameLengthMillis\":";
    if (summary.game_length_millis > 0) output << summary.game_length_millis; else output << "null";
    output << ",\"lastGameChunkId\":";
    if (summary.last_game_chunk_id > 0) output << summary.last_game_chunk_id; else output << "null";
    output << ",\"lastKeyFrameId\":";
    if (summary.last_keyframe_id > 0) output << summary.last_keyframe_id; else output << "null";
    output << ",\"metadataOffset\":" << summary.container.metadata_offset << ",\"metadataLength\":" << summary.container.metadata_size << "},";
    output << "\"participants\":[";
    for (std::size_t index = 0; index < summary.players.size(); ++index) {
        if (index > 0) output << ',';
        const PlayerSummary& participant = summary.players[index];
        output << "{\"participantId\":" << index + 1 << ",\"championName\":";
        write_nullable_string(output, participant.champion);
        output << ",\"teamId\":";
        if (participant.team != 0) output << participant.team; else output << "null";
        output << ",\"teamPosition\":"; write_nullable_string(output, participant.team_position);
        output << ",\"riotIdGameName\":"; write_nullable_string(output, participant.riot_id_game_name);
        output << ",\"riotIdTagLine\":"; write_nullable_string(output, participant.riot_id_tag_line);
        output << ",\"finalKills\":" << participant.kills << ",\"finalDeaths\":" << participant.deaths
               << ",\"finalAssists\":" << participant.assists << '}';
    }
    output << "],\"events\":[";
    for (std::size_t index = 0; index < decoded.events.size(); ++index) {
        if (index > 0) output << ',';
        const ReplayKillEvent& event = decoded.events[index];
        output << "{\"type\":\"CHAMPION_KILL\",\"timestampMillis\":" << event.timestamp_millis;
        output << ",\"victimParticipantId\":" << event.victim_participant_id << ",\"killerParticipantId\":" << event.killer_participant_id;
        output << ",\"assistingParticipantIds\":[";
        for (std::size_t assist = 0; assist < event.assisting_participant_ids.size(); ++assist) {
            if (assist > 0) output << ','; output << event.assisting_participant_ids[assist];
        }
        output << "],\"victimNetworkId\":" << event.victim_network_id << ",\"victimNetworkIdHex\":\""
               << fixed_hex(event.victim_network_id, 8) << "\",\"killerNetworkId\":";
        if (event.killer_participant_id == 0) output << "null"; else output << event.killer_network_id;
        output << ",\"killerNetworkIdHex\":";
        if (event.killer_participant_id == 0) output << "null"; else output << '"' << fixed_hex(event.killer_network_id, 8) << '"';
        output << ",\"assistingNetworkIds\":[";
        for (std::size_t assist = 0; assist < event.assisting_network_ids.size(); ++assist) {
            if (assist > 0) output << ','; output << event.assisting_network_ids[assist];
        }
        output << "],\"provenance\":{\"deathMarker\":"; write_kill_block_provenance_json(output, event.death_marker);
        output << ",\"ownerSequence\":[";
        for (std::size_t owner = 0; owner < event.owner_sequence.size(); ++owner) {
            if (owner > 0) output << ','; write_kill_block_provenance_json(output, event.owner_sequence[owner]);
        }
        output << "]}}";
    }
    output << "],\"diagnostics\":{\"footerRecordCount\":" << summary.container.segments.size();
    output << ",\"chunkRecordCount\":" << scan.selected_segment_count << ",\"decompressedChunkBytes\":" << scan.input_bytes;
    output << ",\"packetBlockCount\":" << scan.packet_count << ",\"relevantPacketBlockCount\":" << relevant_blocks.size();
    output << ",\"ownerSequenceBlockCount\":" << owner_sequence_count << ",\"deathMarkerBlockCount\":" << death_marker_count;
    output << ",\"ignoredDeathMarkerBlockCount\":" << decoded.ignored_markers.size() << ",\"ignoredDeathMarkers\":[";
    for (std::size_t index = 0; index < decoded.ignored_markers.size(); ++index) {
        if (index > 0) output << ',';
        const KillRelevantBlock& marker = decoded.ignored_markers[index];
        output << "{\"timestampMillis\":" << marker.timestamp_millis << ",\"networkId\":" << marker.block.block_param;
        output << ",\"networkIdHex\":\"" << fixed_hex(marker.block.block_param, 8) << "\",\"provenance\":";
        write_kill_block_provenance_json(output, marker); output << '}';
    }
    output << "],\"decodedKillEventCount\":" << decoded.events.size() << ",\"pendingOwnerBlockCount\":" << decoded.pending_owner_block_count;
    output << ",\"exactPacketFraming\":true,\"signedCompactBlockParamDelta\":true,\"finalKdaValidation\":";
    write_kda_validation_json(output, validation); output << "}}";
    return output.str();
}

enum class EliteMonsterKind {
    dragon,
    atakhan,
    baron,
    herald,
    horde,
    unknown,
};

struct ObjectivePacketProfile {
    std::string version_group;
    std::uint8_t channel = 1;
    std::uint16_t packet_type = 0;
    std::size_t minimum_content_length = 0;
    std::size_t maximum_content_length = 0;
    PayloadOffsetOrigin discriminator_origin = PayloadOffsetOrigin::start;
    std::size_t discriminator_offset = 0;
    std::vector<ObjectiveDiscriminatorRule> discriminators;
    std::vector<ObjectiveContentLengthRule> content_length_classes;
};

const std::array<ObjectivePacketProfile, 8> kObjectivePacketProfiles{{
    {"15.22", 1, 0x02DE, 126, 126, PayloadOffsetOrigin::start, 124,
        {{149, ObjectiveMonsterClass::dragon}, {103, ObjectiveMonsterClass::atakhan},
         {241, ObjectiveMonsterClass::baron}, {82, ObjectiveMonsterClass::herald},
         {126, ObjectiveMonsterClass::horde}}, {}},
    {"15.23", 1, 0x026E, 126, 127, PayloadOffsetOrigin::start, 1,
        {{108, ObjectiveMonsterClass::dragon}, {134, ObjectiveMonsterClass::atakhan},
         {114, ObjectiveMonsterClass::baron}, {47, ObjectiveMonsterClass::herald},
         {42, ObjectiveMonsterClass::horde}}, {}},
    {"15.24", 1, 0x00FF, 126, 127, PayloadOffsetOrigin::start, 122,
        {{43, ObjectiveMonsterClass::dragon}, {62, ObjectiveMonsterClass::atakhan},
         {247, ObjectiveMonsterClass::herald}, {198, ObjectiveMonsterClass::horde}}, {}},
    {"16.1", 1, 0x03C3, 126, 127, PayloadOffsetOrigin::start, 122,
        {{111, ObjectiveMonsterClass::dragon}, {178, ObjectiveMonsterClass::baron},
         {204, ObjectiveMonsterClass::herald}, {170, ObjectiveMonsterClass::horde}}, {}},
    {"16.5", 1, 0x0328, 126, 127, PayloadOffsetOrigin::start, 3,
        {{184, ObjectiveMonsterClass::dragon}, {30, ObjectiveMonsterClass::baron},
         {222, ObjectiveMonsterClass::herald}},
        {{127, ObjectiveMonsterClass::horde}}},
    {"16.6", 1, 0x00F2, 126, 127, PayloadOffsetOrigin::start, 122,
        {{255, ObjectiveMonsterClass::dragon}, {12, ObjectiveMonsterClass::baron},
         {199, ObjectiveMonsterClass::herald}, {31, ObjectiveMonsterClass::horde}}, {}},
    {"16.7", 1, 0x03AE, 126, 127, PayloadOffsetOrigin::start, 1,
        {{71, ObjectiveMonsterClass::dragon}, {42, ObjectiveMonsterClass::baron},
         {8, ObjectiveMonsterClass::herald}, {170, ObjectiveMonsterClass::horde}}, {}},
    {"16.9", 1, 0x01EB, 132, 133, PayloadOffsetOrigin::start, 2,
        {{69, ObjectiveMonsterClass::dragon}, {172, ObjectiveMonsterClass::baron},
         {118, ObjectiveMonsterClass::herald}, {123, ObjectiveMonsterClass::horde}}, {}},
}};

struct ReplayObjectiveEvent {
    long long timestamp_millis = 0;
    EliteMonsterKind monster_kind = EliteMonsterKind::unknown;
    std::uint8_t discriminator = 0;
    PacketBlock block;
};

[[nodiscard]] const ObjectivePacketProfile* find_objective_packet_profile(std::string_view version_group) {
    const auto found = std::find_if(
        kObjectivePacketProfiles.begin(),
        kObjectivePacketProfiles.end(),
        [version_group](const ObjectivePacketProfile& profile) {
            return profile.version_group == version_group;
        }
    );
    return found == kObjectivePacketProfiles.end() ? nullptr : &*found;
}

[[nodiscard]] ObjectivePacketProfile adapt_objective_packet_profile(
    std::string_view version_group,
    const ObjectiveDecoderProfile& profile
) {
    return {
        std::string(version_group),
        profile.channel,
        profile.packet_type,
        profile.minimum_content_length,
        profile.maximum_content_length,
        profile.discriminator_origin,
        profile.discriminator_offset,
        profile.discriminators,
        profile.content_length_classes,
    };
}

[[nodiscard]] std::string_view elite_monster_kind_name(EliteMonsterKind kind) {
    switch (kind) {
        case EliteMonsterKind::dragon: return "DRAGON";
        case EliteMonsterKind::atakhan: return "ATAKHAN";
        case EliteMonsterKind::baron: return "BARON_NASHOR";
        case EliteMonsterKind::herald: return "RIFTHERALD";
        case EliteMonsterKind::horde: return "HORDE";
        case EliteMonsterKind::unknown: return "UNKNOWN";
    }
    return "UNKNOWN";
}

[[nodiscard]] std::optional<std::size_t> objective_discriminator_index(
    const ObjectivePacketProfile& profile,
    std::size_t payload_size
) {
    if (profile.discriminator_origin == PayloadOffsetOrigin::end) {
        if (profile.discriminator_offset == 0 ||
            profile.discriminator_offset > payload_size) {
            return std::nullopt;
        }
        return payload_size - profile.discriminator_offset;
    }
    if (profile.discriminator_offset >= payload_size) return std::nullopt;
    return profile.discriminator_offset;
}

[[nodiscard]] EliteMonsterKind classify_elite_monster(
    const ObjectivePacketProfile& profile,
    std::span<const std::uint8_t> payload
) {
    if (payload.size() < profile.minimum_content_length ||
        payload.size() > profile.maximum_content_length) {
        return EliteMonsterKind::unknown;
    }
    const auto to_elite_kind = [](ObjectiveMonsterClass monster_class) {
        switch (monster_class) {
            case ObjectiveMonsterClass::dragon: return EliteMonsterKind::dragon;
            case ObjectiveMonsterClass::atakhan: return EliteMonsterKind::atakhan;
            case ObjectiveMonsterClass::baron: return EliteMonsterKind::baron;
            case ObjectiveMonsterClass::herald: return EliteMonsterKind::herald;
            case ObjectiveMonsterClass::horde: return EliteMonsterKind::horde;
        }
        return EliteMonsterKind::unknown;
    };

    for (const ObjectiveContentLengthRule& rule : profile.content_length_classes) {
        if (rule.content_length == payload.size()) {
            return to_elite_kind(rule.monster_class);
        }
    }

    const std::optional<std::size_t> discriminator_index =
        objective_discriminator_index(profile, payload.size());
    if (!discriminator_index.has_value()) return EliteMonsterKind::unknown;

    const std::uint8_t discriminator = payload[*discriminator_index];
    for (const ObjectiveDiscriminatorRule& rule : profile.discriminators) {
        if (rule.value == discriminator) return to_elite_kind(rule.monster_class);
    }
    return EliteMonsterKind::unknown;
}

void write_objective_block_provenance_json(std::ostringstream& output, const PacketBlock& block) {
    output << '{';
    output << "\"segmentType\":\"" << packet_segment_kind_name(block.provenance.kind) << "\",";
    output << "\"segmentId\":" << block.provenance.segment_id << ',';
    output << "\"chunkId\":" << block.provenance.chunk_id << ',';
    output << "\"segmentHeaderOffset\":" << block.provenance.segment_header_offset << ',';
    output << "\"segmentPayloadOffset\":" << block.provenance.segment_payload_offset << ',';
    output << "\"blockIndex\":" << block.block_index << ',';
    output << "\"decompressedHeaderOffset\":" << block.header_offset << ',';
    output << "\"decompressedContentOffset\":" << block.content_offset << ',';
    output << "\"decompressedEndOffset\":" << block.end_offset << '}';
}

[[nodiscard]] std::string objective_profile_classifier_description(
    const ObjectivePacketProfile& profile
) {
    std::string description;
    if (!profile.content_length_classes.empty()) {
        description = "profiled content lengths are classified first; otherwise ";
    }
    if (profile.discriminator_origin == PayloadOffsetOrigin::end) {
        return description + "payload[length-" +
            std::to_string(profile.discriminator_offset) +
            "] identifies the monster class.";
    }
    return description + "payload[" + std::to_string(profile.discriminator_offset) +
        "] identifies the monster class.";
}

[[nodiscard]] std::string extract_replay_objectives_impl(
    const std::vector<std::uint8_t>& bytes,
    const KillSourceInfo& source,
    const DecoderProfileRegistry* decoder_profiles
) {
    const ReplaySummary summary = decoder_profiles == nullptr
        ? parse_replay_bytes(bytes)
        : parse_replay_bytes(bytes, *decoder_profiles);
    const std::string version_group = packet_version_group(summary.game_version);
    std::optional<ObjectivePacketProfile> external_profile;
    const ObjectivePacketProfile* profile = nullptr;
    if (decoder_profiles != nullptr) {
        const DecoderVersionProfile* selected =
            find_decoder_profile(*decoder_profiles, summary.game_version);
        if (selected == nullptr || !selected->objective.has_value()) {
            throw std::runtime_error(
                "Unsupported replay version " + summary.game_version +
                ": external decoder registry has no objective profile."
            );
        }
        external_profile =
            adapt_objective_packet_profile(version_group, *selected->objective);
        profile = &*external_profile;
    } else {
        profile = find_objective_packet_profile(version_group);
    }
    if (profile == nullptr) {
        throw std::runtime_error(
            "Unsupported replay version " + summary.game_version +
            ". Supported groups: 15.22, 15.23, 15.24, 16.1, 16.5, 16.6, 16.7, 16.9."
        );
    }

    std::vector<ReplayObjectiveEvent> events;
    std::size_t candidate_packet_block_count = 0;
    std::size_t rejected_content_length_block_count = 0;
    std::size_t unknown_monster_type_count = 0;
    const PacketFileScan scan = scan_packet_segments(
        bytes,
        summary,
        "chunk",
        [&](const ReplaySegmentSummary&, const std::vector<std::uint8_t>& decompressed,
            const PacketBlockParseResult& result) {
            for (const PacketBlock& block : result.blocks) {
                if (block.channel != profile->channel || block.packet_type != profile->packet_type) {
                    continue;
                }
                candidate_packet_block_count += 1;
                if (block.content_length < profile->minimum_content_length ||
                    block.content_length > profile->maximum_content_length) {
                    rejected_content_length_block_count += 1;
                    continue;
                }
                const std::span<const std::uint8_t> payload(
                    decompressed.data() + block.content_offset,
                    block.content_length
                );
                const EliteMonsterKind monster_kind = classify_elite_monster(*profile, payload);
                if (monster_kind == EliteMonsterKind::unknown) {
                    unknown_monster_type_count += 1;
                    continue;
                }
                const std::optional<std::size_t> discriminator_index =
                    objective_discriminator_index(*profile, payload.size());
                const std::uint8_t discriminator = discriminator_index.has_value()
                    ? payload[*discriminator_index]
                    : 0;
                events.push_back({
                    packet_timestamp_millis(block.timestamp_seconds),
                    monster_kind,
                    discriminator,
                    block,
                });
            }
        }
    );
    if (scan.selected_segment_count == 0) {
        throw std::runtime_error("Replay contains no footer-style chunk records.");
    }
    if (scan.exact_segment_count != scan.selected_segment_count || !scan.errors.empty()) {
        const std::string detail = scan.errors.empty()
            ? "one or more chunks were not exactly consumed"
            : scan.errors.front().code + ": " + scan.errors.front().message;
        throw std::runtime_error("Replay chunk packet framing failed: " + detail);
    }

    std::map<std::string_view, std::size_t> monster_counts;
    for (const ReplayObjectiveEvent& event : events) {
        const std::string_view name = elite_monster_kind_name(event.monster_kind);
        monster_counts[name] += 1;
    }

    std::ostringstream output;
    output << "{\"schema\":\"rofl-replay-objectives/v1\",\"generatedAtUtc\":\""
           << current_utc_iso8601() << "\",";
    output << "\"source\":{\"replayPath\":";
    if (source.has_file) output << '"' << json_escape(source.replay_path) << '"'; else output << "null";
    output << ",\"replayId\":";
    if (source.has_file) output << '"' << json_escape(source.replay_id) << '"'; else output << "null";
    output << ",\"matchId\":";
    if (source.has_file) output << '"' << json_escape(source.match_id) << '"'; else output << "null";
    output << ",\"runtimeInput\":\"rofl-only\",\"riotApiInput\":false},";
    output << "\"gameVersion\":\"" << json_escape(summary.game_version)
           << "\",\"versionGroup\":\"" << version_group << "\",";
    output << "\"profile\":{\"channel\":" << static_cast<unsigned int>(profile->channel)
           << ",\"packetType\":" << profile->packet_type;
    output << ",\"packetTypeHex\":\"" << fixed_hex(profile->packet_type, 4) << "\"";
    output << ",\"minimumContentLength\":" << profile->minimum_content_length;
    output << ",\"maximumContentLength\":" << profile->maximum_content_length;
    output << ",\"discriminatorOffset\":" << profile->discriminator_offset;
    output << ",\"discriminatorOrigin\":\""
           << (profile->discriminator_origin == PayloadOffsetOrigin::start ? "start" : "end")
           << "\"";
    output << ",\"classifier\":\""
           << json_escape(objective_profile_classifier_description(*profile)) << "\"";
    write_decoder_profile_provenance_fields(output, decoder_profiles);
    output << "},";
    output << "\"replay\":{\"gameLengthMillis\":";
    if (summary.game_length_millis > 0) output << summary.game_length_millis; else output << "null";
    output << ",\"lastGameChunkId\":";
    if (summary.last_game_chunk_id > 0) output << summary.last_game_chunk_id; else output << "null";
    output << ",\"lastKeyFrameId\":";
    if (summary.last_keyframe_id > 0) output << summary.last_keyframe_id; else output << "null";
    output << "},\"events\":[";
    for (std::size_t index = 0; index < events.size(); ++index) {
        if (index > 0) output << ',';
        const ReplayObjectiveEvent& event = events[index];
        output << "{\"type\":\"ELITE_MONSTER_KILL\",\"timestampMillis\":"
               << event.timestamp_millis;
        output << ",\"monsterType\":\"" << elite_monster_kind_name(event.monster_kind) << "\"";
        output << ",\"monsterSubtype\":null,\"killerParticipantId\":null,\"killerTeamId\":null";
        output << ",\"contentLength\":" << event.block.content_length;
        output << ",\"discriminator\":" << static_cast<unsigned int>(event.discriminator);
        output << ",\"provenance\":";
        write_objective_block_provenance_json(output, event.block);
        output << '}';
    }
    output << "],\"diagnostics\":{\"footerRecordCount\":" << summary.container.segments.size();
    output << ",\"chunkRecordCount\":" << scan.selected_segment_count;
    output << ",\"decompressedChunkBytes\":" << scan.input_bytes;
    output << ",\"packetBlockCount\":" << scan.packet_count;
    output << ",\"candidatePacketBlockCount\":" << candidate_packet_block_count;
    output << ",\"profileLengthPacketBlockCount\":"
           << candidate_packet_block_count - rejected_content_length_block_count;
    output << ",\"rejectedContentLengthBlockCount\":"
           << rejected_content_length_block_count;
    output << ",\"decodedObjectiveEventCount\":" << events.size();
    output << ",\"unknownMonsterTypeCount\":" << unknown_monster_type_count;
    output << ",\"monsterCounts\":{";
    bool first_count = true;
    for (const auto& [name, count] : monster_counts) {
        if (!first_count) output << ',';
        first_count = false;
        output << '"' << name << "\":" << count;
    }
    output << "},\"exactPacketFraming\":true";
    output << ",\"killerOwnershipAvailable\":false";
    output << ",\"elementalDragonSubtypeAvailable\":false}}";
    return output.str();
}

struct WardPacketProfile {
    std::string version_group;
    std::uint8_t channel = 1;
    std::uint16_t placement_marker_packet_type = 0;
    std::size_t placement_content_length = 3;
    std::size_t placement_discriminator_offset = 2;
    std::vector<std::uint8_t> placement_discriminator_values;
    std::uint16_t placement_owner_packet_type = 0;
    ContentLengthConstraint placement_owner_content_lengths;
    std::uint16_t removal_packet_type = 0;
    ContentLengthConstraint removal_content_lengths;
    std::uint16_t killer_owner_packet_type = 0;
    ContentLengthConstraint killer_owner_content_lengths;
    std::uint32_t champion_network_id_base = 0;
    std::uint16_t research_primary_spawn_packet_type = 0;
    std::uint16_t research_companion_spawn_packet_type = 0;
    std::size_t research_primary_minimum_content_length = 0;
    std::size_t research_primary_maximum_content_length = 0;
    std::size_t research_companion_content_length = 0;
    bool research_spawn_available = false;
};

const std::array<WardPacketProfile, 8> kWardPacketProfiles{{
    {"15.22", 1, 0x0308, 3, 2, {0x09}, 0x0420, {{2, 3, 4}, {}, {}},
        0x0017, {{21, 28, 29}, {}, {}}, 0x044E, {{6, 7}, {}, {}},
        0x40000099, 0x00DC, 0x00BC, 64, 73, 63, true},
    {"15.23", 1, 0x0368, 3, 2, {0xD5}, 0x01BF, {{2, 3, 4}, {}, {}},
        0x020A, {{28, 29}, {}, {}}, 0x028B, {{6, 7}, {}, {}},
        0x400004CC, 0x0393, 0x0060, 64, 73, 63, true},
    {"15.24", 1, 0x02CE, 3, 2, {0xE1}, 0x0227, {{2, 3, 4}, {}, {}},
        0x009C, {{28, 29}, {}, {}}, 0x0220, {{6, 7}, {}, {}},
        0x40000147, 0x0342, 0x0218, 63, 73, 63, true},
    {"16.1", 1, 0x037F, 3, 2, {0x01, 0x92}, 0x0335, {{2, 3, 4}, {}, {}},
        0x0059, {{28, 29}, {}, {}}, 0x021A, {{6, 7}, {}, {}},
        0x400000AD, 0x02CC, 0x0428, 63, 73, 63, true},
    {"16.5", 1, 0x03F8, 3, 2, {0x50}, 0x024F, {{2, 3, 4}, {}, {}},
        0x023F, {{28, 29}, {}, {}}, 0x01FE, {{6, 7}, {}, {}},
        0x400000AD, 0x0427, 0x01EE, 64, 73, 63, true},
    {"16.6", 1, 0x0311, 3, 2, {0x14}, 0x011D, {{2, 3, 4}, {}, {}},
        0x0271, {{21, 28, 29}, {}, {}}, 0x03FD, {{6, 7}, {}, {}},
        0x400000AD, 0x03D1, 0x034B, 63, 73, 63, true},
    {"16.7", 1, 0x0162, 3, 2, {0x80, 0xF4, 0xF7}, 0x033B, {{2, 3, 4}, {}, {}},
        0x039C, {{28, 29}, {}, {}}, 0x0301, {{6, 7}, {}, {}},
        0x400000AD, 0x0449, 0x0219, 63, 73, 63, true},
    {"16.9", 1, 0x0041, 3, 2, {0xB0}, 0x04AC, {{2, 3, 4}, {}, {}},
        0x02E6, {{28, 29}, {}, {}}, 0x02F6, {{6, 7}, {}, {}},
        0x400000AD, 0x00D6, 0x01AD, 62, 73, 63, true},
}};

constexpr long long kWardTimestampToleranceMillis = 1;
constexpr std::size_t kWardResearchMaximumPrecedingBlocks = 48;

struct WardRelevantBlock {
    PacketBlock block;
    long long timestamp_millis = 0;
};

struct WardPositionResearchPayloadBlock {
    WardRelevantBlock relevant;
    std::vector<std::uint8_t> payload;
};

struct WardPositionResearchPlacement {
    long long timestamp_millis = 0;
    std::uint32_t ward_entity_network_id = 0;
    int owner_participant_id = 0;
    std::uint32_t owner_network_id = 0;
    WardRelevantBlock marker;
    WardPositionResearchPayloadBlock primary;
    WardPositionResearchPayloadBlock companion;
};

struct WardPositionResearchHypothesis {
    std::string_view id;
    std::string_view label;
    std::string_view description;
    std::string_view x_source;
    std::string_view y_source;
};

struct WardPositionResearchCoordinate {
    double x = 0.0;
    double y = 0.0;
};

constexpr std::array<WardPositionResearchHypothesis, 8> kWardPositionResearchHypotheses{{
    {
        "CONTROL-U16-7-11",
        "Primary U16 cluster control",
        "Low-distinctness control for visually rejecting clustered non-position structure.",
        "N16(primary[7] | primary[8] << 8)",
        "N16(primary[11] | primary[12] << 8)",
    },
    {
        "P16-BE-FY",
        "Primary U16 BE, flip Y",
        "Big-endian primary shared-lane hypothesis with the Y axis mirrored.",
        "N16(primary[9] << 8 | primary[10])",
        "15000 - N16(primary[13] << 8 | primary[14])",
    },
    {
        "P16-BE-SWAP-FX",
        "Primary U16 BE, swap and flip X",
        "Redundant orientation probe using the same primary bytes with swapped axes.",
        "15000 - N16(primary[13] << 8 | primary[14])",
        "N16(primary[9] << 8 | primary[10])",
    },
    {
        "P16-LE",
        "Primary U16 LE",
        "Little-endian primary shared-lane hypothesis without axis transforms.",
        "N16(primary[9] | primary[10] << 8)",
        "N16(primary[13] | primary[14] << 8)",
    },
    {
        "C16A-LE",
        "Companion leading lanes U16 LE",
        "Leading two-byte lanes from the variable companion regions.",
        "N16(companion[34] | companion[36] << 8)",
        "N16(companion[42] | companion[44] << 8)",
    },
    {
        "C16B-BE",
        "Companion trailing lanes U16 BE",
        "Trailing two-byte lanes from the variable companion regions.",
        "N16(companion[36] << 8 | companion[38])",
        "N16(companion[44] << 8 | companion[46])",
    },
    {
        "C24-LE-SWAP-FY",
        "Companion U24 LE, swap and flip Y",
        "Three-byte companion lanes with swapped axes and the source X lane mirrored.",
        "N24(companion[42] | companion[44] << 8 | companion[46] << 16)",
        "15000 - N24(companion[34] | companion[36] << 8 | companion[38] << 16)",
    },
    {
        "C24-BE-FX",
        "Companion U24 BE, flip X",
        "Three-byte big-endian companion lanes with the X axis mirrored.",
        "15000 - N24(companion[34] << 16 | companion[36] << 8 | companion[38])",
        "N24(companion[42] << 16 | companion[44] << 8 | companion[46])",
    },
}};

struct ReplayWardPlacementEvent {
    long long timestamp_millis = 0;
    std::uint32_t ward_entity_network_id = 0;
    int owner_participant_id = 0;
    std::uint32_t owner_network_id = 0;
    WardRelevantBlock owner_block;
    WardRelevantBlock marker_block;
};

struct ReplayWardKillEvent {
    long long timestamp_millis = 0;
    std::uint32_t ward_entity_network_id = 0;
    int killer_participant_id = 0;
    std::uint32_t killer_network_id = 0;
    WardRelevantBlock killer_owner_block;
    WardRelevantBlock removal_block;
};

struct WardEventOrder {
    long long timestamp_millis = 0;
    int chunk_id = 0;
    std::size_t block_index = 0;
    bool placement = false;
    std::size_t event_index = 0;
};

[[nodiscard]] const WardPacketProfile* find_ward_packet_profile(std::string_view version_group) {
    const auto found = std::find_if(
        kWardPacketProfiles.begin(),
        kWardPacketProfiles.end(),
        [version_group](const WardPacketProfile& profile) {
            return profile.version_group == version_group;
        }
    );
    return found == kWardPacketProfiles.end() ? nullptr : &*found;
}

[[nodiscard]] WardPacketProfile adapt_ward_packet_profile(
    std::string_view version_group,
    const WardDecoderProfile& profile
) {
    WardPacketProfile adapted;
    adapted.version_group = version_group;
    adapted.channel = profile.channel;
    adapted.placement_marker_packet_type = profile.placement_marker_packet_type;
    adapted.placement_content_length = profile.placement_content_length;
    adapted.placement_discriminator_offset = profile.placement_discriminator_offset;
    adapted.placement_discriminator_values = profile.placement_discriminator_values;
    adapted.placement_owner_packet_type = profile.placement_owner_packet_type;
    adapted.placement_owner_content_lengths = profile.placement_owner_content_lengths;
    adapted.removal_packet_type = profile.removal_packet_type;
    adapted.removal_content_lengths = profile.removal_content_lengths;
    adapted.killer_owner_packet_type = profile.killer_owner_packet_type;
    adapted.killer_owner_content_lengths = profile.killer_owner_content_lengths;
    adapted.champion_network_id_base = profile.champion_network_id_base;
    if (profile.research_spawn.has_value()) {
        const WardResearchSpawnProfile& research = *profile.research_spawn;
        adapted.research_primary_spawn_packet_type = research.primary_spawn_packet_type;
        adapted.research_companion_spawn_packet_type = research.companion_spawn_packet_type;
        adapted.research_primary_minimum_content_length =
            research.primary_minimum_content_length;
        adapted.research_primary_maximum_content_length =
            research.primary_maximum_content_length;
        adapted.research_companion_content_length = research.companion_content_length;
        adapted.research_spawn_available = true;
    }
    return adapted;
}

[[nodiscard]] bool ward_length_is_profiled(
    std::size_t value,
    const ContentLengthConstraint& constraint
) {
    const bool exact = std::find(
        constraint.exact_values.begin(),
        constraint.exact_values.end(),
        value
    ) != constraint.exact_values.end();
    const bool in_range = constraint.minimum.has_value() &&
        constraint.maximum.has_value() &&
        value >= *constraint.minimum && value <= *constraint.maximum;
    return exact || in_range;
}

[[nodiscard]] bool ward_discriminator_is_profiled(
    std::uint8_t value,
    const WardPacketProfile& profile
) {
    return std::find(
        profile.placement_discriminator_values.begin(),
        profile.placement_discriminator_values.end(),
        value
    ) != profile.placement_discriminator_values.end();
}

[[nodiscard]] int ward_owner_to_participant_id(
    std::uint32_t owner,
    const WardPacketProfile& profile
) {
    if (owner <= profile.champion_network_id_base) return 0;
    const std::uint32_t participant_id = owner - profile.champion_network_id_base;
    return participant_id <= 10 ? static_cast<int>(participant_id) : 0;
}

[[nodiscard]] long long ward_timestamp_delta(long long left, long long right) {
    return left >= right ? left - right : right - left;
}

[[nodiscard]] std::vector<ReplayWardPlacementEvent> pair_ward_placements(
    const std::vector<WardRelevantBlock>& classified_placement_markers,
    const std::vector<WardRelevantBlock>& placement_owner_blocks,
    const WardPacketProfile& profile
) {
    std::vector<ReplayWardPlacementEvent> placements;
    for (std::size_t marker_index = 0;
         marker_index < classified_placement_markers.size();
         ++marker_index) {
        const WardRelevantBlock& marker =
            classified_placement_markers[marker_index];
        const WardRelevantBlock* owner = nullptr;
        for (const WardRelevantBlock& candidate : placement_owner_blocks) {
            if (candidate.block.provenance.chunk_id !=
                    marker.block.provenance.chunk_id ||
                candidate.block.block_index >= marker.block.block_index ||
                ward_timestamp_delta(
                    candidate.timestamp_millis,
                    marker.timestamp_millis
                ) > kWardTimestampToleranceMillis) {
                continue;
            }
            if (owner == nullptr ||
                candidate.block.block_index > owner->block.block_index) {
                owner = &candidate;
            }
        }
        if (owner == nullptr) continue;

        std::size_t first_marker_index =
            classified_placement_markers.size();
        std::size_t first_marker_block_index =
            std::numeric_limits<std::size_t>::max();
        for (std::size_t candidate_index = 0;
             candidate_index < classified_placement_markers.size();
             ++candidate_index) {
            const WardRelevantBlock& candidate =
                classified_placement_markers[candidate_index];
            if (candidate.block.provenance.chunk_id !=
                    owner->block.provenance.chunk_id ||
                candidate.block.block_index <= owner->block.block_index ||
                ward_timestamp_delta(
                    candidate.timestamp_millis,
                    owner->timestamp_millis
                ) > kWardTimestampToleranceMillis) {
                continue;
            }
            if (candidate.block.block_index < first_marker_block_index) {
                first_marker_block_index = candidate.block.block_index;
                first_marker_index = candidate_index;
            }
        }
        if (first_marker_index != marker_index) continue;

        placements.push_back({
            marker.timestamp_millis,
            marker.block.block_param,
            ward_owner_to_participant_id(owner->block.block_param, profile),
            owner->block.block_param,
            *owner,
            marker,
        });
    }
    return placements;
}

void write_ward_block_provenance_json(
    std::ostringstream& output,
    const WardRelevantBlock& relevant
) {
    write_objective_block_provenance_json(output, relevant.block);
}

void write_size_array_json(
    std::ostringstream& output,
    const ContentLengthConstraint& constraint
) {
    std::vector<std::size_t> values = constraint.exact_values;
    if (constraint.minimum.has_value() && constraint.maximum.has_value() &&
        *constraint.maximum - *constraint.minimum <= 255) {
        for (std::size_t value = *constraint.minimum;
             value <= *constraint.maximum;
             ++value) {
            if (std::find(values.begin(), values.end(), value) == values.end()) {
                values.push_back(value);
            }
        }
    }
    std::sort(values.begin(), values.end());
    output << '[';
    for (std::size_t index = 0; index < values.size(); ++index) {
        if (index > 0) output << ',';
        output << values[index];
    }
    output << ']';
}

void write_content_length_range_json(
    std::ostringstream& output,
    const ContentLengthConstraint& constraint
) {
    if (!constraint.minimum.has_value() || !constraint.maximum.has_value()) {
        output << "null";
        return;
    }
    output << '[' << *constraint.minimum << ',' << *constraint.maximum << ']';
}

[[nodiscard]] std::uint32_t ward_research_u16_le(
    const std::vector<std::uint8_t>& payload,
    std::size_t low_offset,
    std::size_t high_offset
) {
    return static_cast<std::uint32_t>(payload[low_offset]) |
        (static_cast<std::uint32_t>(payload[high_offset]) << 8U);
}

[[nodiscard]] std::uint32_t ward_research_u16_be(
    const std::vector<std::uint8_t>& payload,
    std::size_t high_offset,
    std::size_t low_offset
) {
    return (static_cast<std::uint32_t>(payload[high_offset]) << 8U) |
        static_cast<std::uint32_t>(payload[low_offset]);
}

[[nodiscard]] std::uint32_t ward_research_u24_le(
    const std::vector<std::uint8_t>& payload,
    std::size_t low_offset,
    std::size_t middle_offset,
    std::size_t high_offset
) {
    return static_cast<std::uint32_t>(payload[low_offset]) |
        (static_cast<std::uint32_t>(payload[middle_offset]) << 8U) |
        (static_cast<std::uint32_t>(payload[high_offset]) << 16U);
}

[[nodiscard]] std::uint32_t ward_research_u24_be(
    const std::vector<std::uint8_t>& payload,
    std::size_t high_offset,
    std::size_t middle_offset,
    std::size_t low_offset
) {
    return (static_cast<std::uint32_t>(payload[high_offset]) << 16U) |
        (static_cast<std::uint32_t>(payload[middle_offset]) << 8U) |
        static_cast<std::uint32_t>(payload[low_offset]);
}

[[nodiscard]] double ward_research_n16(std::uint32_t value) {
    return static_cast<double>(value) * 15000.0 / 65535.0;
}

[[nodiscard]] double ward_research_n24(std::uint32_t value) {
    return static_cast<double>(value) * 15000.0 / 16777215.0;
}

[[nodiscard]] WardPositionResearchCoordinate ward_research_coordinate(
    std::size_t hypothesis_index,
    const std::vector<std::uint8_t>& primary,
    const std::vector<std::uint8_t>& companion
) {
    if (primary.size() < 15 || companion.size() < 47) {
        return {
            std::numeric_limits<double>::quiet_NaN(),
            std::numeric_limits<double>::quiet_NaN(),
        };
    }
    switch (hypothesis_index) {
    case 0:
        return {
            ward_research_n16(ward_research_u16_le(primary, 7, 8)),
            ward_research_n16(ward_research_u16_le(primary, 11, 12)),
        };
    case 1:
        return {
            ward_research_n16(ward_research_u16_be(primary, 9, 10)),
            15000.0 - ward_research_n16(ward_research_u16_be(primary, 13, 14)),
        };
    case 2:
        return {
            15000.0 - ward_research_n16(ward_research_u16_be(primary, 13, 14)),
            ward_research_n16(ward_research_u16_be(primary, 9, 10)),
        };
    case 3:
        return {
            ward_research_n16(ward_research_u16_le(primary, 9, 10)),
            ward_research_n16(ward_research_u16_le(primary, 13, 14)),
        };
    case 4:
        return {
            ward_research_n16(ward_research_u16_le(companion, 34, 36)),
            ward_research_n16(ward_research_u16_le(companion, 42, 44)),
        };
    case 5:
        return {
            ward_research_n16(ward_research_u16_be(companion, 36, 38)),
            ward_research_n16(ward_research_u16_be(companion, 44, 46)),
        };
    case 6:
        return {
            ward_research_n24(ward_research_u24_le(companion, 42, 44, 46)),
            15000.0 - ward_research_n24(
                ward_research_u24_le(companion, 34, 36, 38)
            ),
        };
    case 7:
        return {
            15000.0 - ward_research_n24(
                ward_research_u24_be(companion, 34, 36, 38)
            ),
            ward_research_n24(ward_research_u24_be(companion, 42, 44, 46)),
        };
    default:
        return {
            std::numeric_limits<double>::quiet_NaN(),
            std::numeric_limits<double>::quiet_NaN(),
        };
    }
}

[[nodiscard]] std::string ward_research_payload_hex(
    const std::vector<std::uint8_t>& payload
) {
    std::ostringstream output;
    output << std::hex << std::setfill('0');
    for (const std::uint8_t byte : payload) {
        output << std::setw(2) << static_cast<unsigned int>(byte);
    }
    return output.str();
}

void write_decoder_profile_provenance_fields(
    std::ostringstream& output,
    const DecoderProfileRegistry* decoder_profiles
) {
    if (decoder_profiles == nullptr) {
        output << ",\"origin\":\"built-in\"";
        return;
    }
    const DecoderProfileProvenance& provenance =
        decoder_profile_provenance(*decoder_profiles);
    output << ",\"origin\":\"external\"";
    output << ",\"schema\":\"" << json_escape(provenance.schema) << "\"";
    output << ",\"registryId\":\"" << json_escape(provenance.registry_id) << "\"";
    output << ",\"revision\":\"" << json_escape(provenance.revision) << "\"";
    output << ",\"fingerprint\":\"" << json_escape(provenance.fingerprint) << "\"";
}

void write_ward_research_payload_block_json(
    std::ostringstream& output,
    std::string_view packet_role,
    const WardPositionResearchPayloadBlock& payload_block
) {
    const PacketBlock& block = payload_block.relevant.block;
    output << "{\"packetRole\":\"" << json_escape(packet_role) << "\"";
    output << ",\"packetType\":" << block.packet_type;
    output << ",\"packetTypeHex\":\"" << fixed_hex(block.packet_type, 4) << "\"";
    output << ",\"blockParam\":" << block.block_param;
    output << ",\"blockParamHex\":\"" << fixed_hex(block.block_param, 8) << "\"";
    output << ",\"contentLength\":" << block.content_length;
    output << ",\"payloadHex\":\""
           << ward_research_payload_hex(payload_block.payload) << "\"";
    output << ",\"provenance\":";
    write_ward_block_provenance_json(output, payload_block.relevant);
    output << '}';
}

struct WardPositionResearchExtraction {
    PacketFileScan scan;
    std::vector<WardRelevantBlock> classified_placement_markers;
    std::vector<ReplayWardPlacementEvent> productive_placements;
    std::vector<WardPositionResearchPayloadBlock> primary_blocks;
    std::vector<WardPositionResearchPayloadBlock> companion_blocks;
    std::vector<WardPositionResearchPlacement> research_placements;
    std::size_t candidate_placement_marker_block_count = 0;
    std::size_t rejected_placement_content_length_block_count = 0;
    std::size_t rejected_placement_classifier_block_count = 0;
    std::size_t rejected_primary_profile_length_count = 0;
    std::size_t rejected_companion_profile_length_count = 0;
    std::size_t rejected_primary_missing_count = 0;
    std::size_t rejected_primary_ambiguous_count = 0;
    std::size_t rejected_companion_missing_count = 0;
    std::size_t rejected_companion_ambiguous_count = 0;
    std::size_t rejected_spawn_order_count = 0;
    std::size_t rejected_payload_length_count = 0;
};

[[nodiscard]] WardPositionResearchExtraction
collect_ward_position_research(
    const std::vector<std::uint8_t>& bytes,
    const ReplaySummary& summary,
    const WardPacketProfile& profile,
    bool candidate_version_supported
) {
    WardPositionResearchExtraction extraction;
    std::vector<WardRelevantBlock> placement_owner_blocks;
    extraction.scan = scan_packet_segments(
        bytes,
        summary,
        "chunk",
        [&](const ReplaySegmentSummary&,
            const std::vector<std::uint8_t>& decompressed,
            const PacketBlockParseResult& result) {
            for (const PacketBlock& block : result.blocks) {
                if (block.channel != profile.channel) continue;
                const WardRelevantBlock relevant{
                    block,
                    packet_timestamp_millis(block.timestamp_seconds),
                };
                if (block.packet_type == profile.placement_marker_packet_type) {
                    extraction.candidate_placement_marker_block_count += 1;
                    if (block.content_length != profile.placement_content_length) {
                        extraction.rejected_placement_content_length_block_count += 1;
                    } else {
                        const std::uint8_t discriminator =
                            decompressed[
                                block.content_offset +
                                profile.placement_discriminator_offset
                            ];
                        if (ward_discriminator_is_profiled(
                                discriminator,
                                profile
                            )) {
                            extraction.classified_placement_markers.push_back(
                                relevant
                            );
                        } else {
                            extraction.rejected_placement_classifier_block_count += 1;
                        }
                    }
                }
                if (block.packet_type == profile.placement_owner_packet_type &&
                    ward_length_is_profiled(
                        block.content_length,
                        profile.placement_owner_content_lengths
                    ) &&
                    ward_owner_to_participant_id(
                        block.block_param,
                        profile
                    ) != 0) {
                    placement_owner_blocks.push_back(relevant);
                }
                if (!candidate_version_supported) {
                    continue;
                }
                if (block.packet_type !=
                        profile.research_primary_spawn_packet_type &&
                    block.packet_type !=
                        profile.research_companion_spawn_packet_type) {
                    continue;
                }
                if (block.packet_type ==
                        profile.research_primary_spawn_packet_type &&
                    (block.content_length <
                        profile.research_primary_minimum_content_length ||
                     block.content_length >
                        profile.research_primary_maximum_content_length)) {
                    extraction.rejected_primary_profile_length_count += 1;
                    continue;
                }
                if (block.packet_type ==
                        profile.research_companion_spawn_packet_type &&
                    block.content_length !=
                        profile.research_companion_content_length) {
                    extraction.rejected_companion_profile_length_count += 1;
                    continue;
                }

                WardPositionResearchPayloadBlock payload_block;
                payload_block.relevant = relevant;
                payload_block.payload.assign(
                    decompressed.begin() +
                        static_cast<std::ptrdiff_t>(block.content_offset),
                    decompressed.begin() +
                        static_cast<std::ptrdiff_t>(block.end_offset)
                );
                if (block.packet_type ==
                    profile.research_primary_spawn_packet_type) {
                    extraction.primary_blocks.push_back(
                        std::move(payload_block)
                    );
                } else {
                    extraction.companion_blocks.push_back(
                        std::move(payload_block)
                    );
                }
            }
        }
    );
    if (extraction.scan.selected_segment_count == 0) {
        throw std::runtime_error(
            "Replay contains no footer-style chunk records."
        );
    }
    if (extraction.scan.exact_segment_count !=
            extraction.scan.selected_segment_count ||
        !extraction.scan.errors.empty()) {
        const std::string detail = extraction.scan.errors.empty()
            ? "one or more chunks were not exactly consumed"
            : extraction.scan.errors.front().code + ": " +
                extraction.scan.errors.front().message;
        throw std::runtime_error(
            "Replay chunk packet framing failed: " + detail
        );
    }

    extraction.productive_placements = pair_ward_placements(
        extraction.classified_placement_markers,
        placement_owner_blocks,
        profile
    );
    if (!candidate_version_supported) {
        return extraction;
    }

    for (const ReplayWardPlacementEvent& placement :
         extraction.productive_placements) {
        const PacketBlock& marker = placement.marker_block.block;
        const auto matches_placement = [&](const auto& candidate) {
            const PacketBlock& block = candidate.relevant.block;
            return
                block.block_param == placement.ward_entity_network_id &&
                block.provenance.segment_id ==
                    marker.provenance.segment_id &&
                block.provenance.chunk_id == marker.provenance.chunk_id &&
                block.block_index < marker.block_index &&
                marker.block_index - block.block_index <=
                    kWardResearchMaximumPrecedingBlocks &&
                ward_timestamp_delta(
                    candidate.relevant.timestamp_millis,
                    placement.timestamp_millis
                ) <= kWardTimestampToleranceMillis;
        };

        const WardPositionResearchPayloadBlock* primary = nullptr;
        std::size_t primary_match_count = 0;
        for (const auto& candidate : extraction.primary_blocks) {
            if (!matches_placement(candidate)) continue;
            primary = &candidate;
            primary_match_count += 1;
        }
        const WardPositionResearchPayloadBlock* companion = nullptr;
        std::size_t companion_match_count = 0;
        for (const auto& candidate : extraction.companion_blocks) {
            if (!matches_placement(candidate)) continue;
            companion = &candidate;
            companion_match_count += 1;
        }

        if (primary_match_count == 0) {
            extraction.rejected_primary_missing_count += 1;
            continue;
        }
        if (primary_match_count > 1) {
            extraction.rejected_primary_ambiguous_count += 1;
            continue;
        }
        if (companion_match_count == 0) {
            extraction.rejected_companion_missing_count += 1;
            continue;
        }
        if (companion_match_count > 1) {
            extraction.rejected_companion_ambiguous_count += 1;
            continue;
        }
        if (primary == nullptr || companion == nullptr ||
            primary->relevant.block.block_index >=
                companion->relevant.block.block_index ||
            companion->relevant.block.block_index >= marker.block_index) {
            extraction.rejected_spawn_order_count += 1;
            continue;
        }
        if (primary->payload.size() < 15 ||
            companion->payload.size() < 47) {
            extraction.rejected_payload_length_count += 1;
            continue;
        }

        extraction.research_placements.push_back({
            placement.timestamp_millis,
            placement.ward_entity_network_id,
            placement.owner_participant_id,
            placement.owner_network_id,
            placement.marker_block,
            *primary,
            *companion,
        });
    }
    return extraction;
}

[[nodiscard]] std::string extract_replay_wards_impl(
    const std::vector<std::uint8_t>& bytes,
    const KillSourceInfo& source,
    const DecoderProfileRegistry* decoder_profiles
) {
    const ReplaySummary summary = decoder_profiles == nullptr
        ? parse_replay_bytes(bytes)
        : parse_replay_bytes(bytes, *decoder_profiles);
    const std::string version_group = packet_version_group(summary.game_version);
    std::optional<WardPacketProfile> external_profile;
    const WardPacketProfile* profile = nullptr;
    if (decoder_profiles != nullptr) {
        const DecoderVersionProfile* selected =
            find_decoder_profile(*decoder_profiles, summary.game_version);
        if (selected == nullptr || !selected->ward.has_value()) {
            throw std::runtime_error(
                "Unsupported replay version " + summary.game_version +
                ": external decoder registry has no ward profile."
            );
        }
        external_profile = adapt_ward_packet_profile(version_group, *selected->ward);
        profile = &*external_profile;
    } else {
        profile = find_ward_packet_profile(version_group);
    }
    if (profile == nullptr) {
        throw std::runtime_error(
            "Unsupported replay version " + summary.game_version +
            ". Supported groups: 15.22, 15.23, 15.24, 16.1, 16.5, 16.6, 16.7, 16.9."
        );
    }

    std::vector<WardRelevantBlock> classified_placement_markers;
    std::vector<WardRelevantBlock> placement_owner_blocks;
    std::vector<WardRelevantBlock> removal_blocks;
    std::vector<WardRelevantBlock> killer_owner_blocks;
    std::size_t candidate_placement_marker_block_count = 0;
    std::size_t rejected_placement_content_length_block_count = 0;
    std::size_t rejected_placement_classifier_block_count = 0;

    const PacketFileScan scan = scan_packet_segments(
        bytes,
        summary,
        "chunk",
        [&](const ReplaySegmentSummary&, const std::vector<std::uint8_t>& decompressed,
            const PacketBlockParseResult& result) {
            for (const PacketBlock& block : result.blocks) {
                if (block.channel != profile->channel) continue;
                const WardRelevantBlock relevant{
                    block,
                    packet_timestamp_millis(block.timestamp_seconds),
                };
                if (block.packet_type == profile->placement_marker_packet_type) {
                    candidate_placement_marker_block_count += 1;
                    if (block.content_length != profile->placement_content_length) {
                        rejected_placement_content_length_block_count += 1;
                    } else {
                        const std::uint8_t discriminator =
                            decompressed[
                                block.content_offset +
                                profile->placement_discriminator_offset
                            ];
                        if (ward_discriminator_is_profiled(discriminator, *profile)) {
                            classified_placement_markers.push_back(relevant);
                        } else {
                            rejected_placement_classifier_block_count += 1;
                        }
                    }
                }
                if (block.packet_type == profile->placement_owner_packet_type &&
                    ward_length_is_profiled(
                        block.content_length,
                        profile->placement_owner_content_lengths
                    ) &&
                    ward_owner_to_participant_id(block.block_param, *profile) != 0) {
                    placement_owner_blocks.push_back(relevant);
                }
                if (block.packet_type == profile->removal_packet_type) {
                    removal_blocks.push_back(relevant);
                }
                if (block.packet_type == profile->killer_owner_packet_type &&
                    ward_length_is_profiled(
                        block.content_length,
                        profile->killer_owner_content_lengths
                    ) &&
                    ward_owner_to_participant_id(block.block_param, *profile) != 0) {
                    killer_owner_blocks.push_back(relevant);
                }
            }
        }
    );
    if (scan.selected_segment_count == 0) {
        throw std::runtime_error("Replay contains no footer-style chunk records.");
    }
    if (scan.exact_segment_count != scan.selected_segment_count || !scan.errors.empty()) {
        const std::string detail = scan.errors.empty()
            ? "one or more chunks were not exactly consumed"
            : scan.errors.front().code + ": " + scan.errors.front().message;
        throw std::runtime_error("Replay chunk packet framing failed: " + detail);
    }

    const std::vector<ReplayWardPlacementEvent> placements =
        pair_ward_placements(
            classified_placement_markers,
            placement_owner_blocks,
            *profile
        );

    std::set<std::uint32_t> tracked_ward_entity_ids;
    for (const ReplayWardPlacementEvent& placement : placements) {
        tracked_ward_entity_ids.insert(placement.ward_entity_network_id);
    }

    std::vector<ReplayWardKillEvent> kills;
    std::size_t rejected_untracked_removal_block_count = 0;
    std::size_t rejected_tracked_unprofiled_removal_block_count = 0;
    std::size_t rejected_missing_killer_owner_block_count = 0;
    std::size_t killer_owner_candidate_collision_count = 0;
    for (const WardRelevantBlock& removal : removal_blocks) {
        if (!tracked_ward_entity_ids.contains(removal.block.block_param)) {
            rejected_untracked_removal_block_count += 1;
            continue;
        }
        if (!ward_length_is_profiled(
                removal.block.content_length,
                profile->removal_content_lengths
            )) {
            rejected_tracked_unprofiled_removal_block_count += 1;
            continue;
        }

        const WardRelevantBlock* killer_owner = nullptr;
        std::size_t killer_owner_candidate_count = 0;
        for (const WardRelevantBlock& candidate : killer_owner_blocks) {
            if (candidate.block.provenance.chunk_id != removal.block.provenance.chunk_id ||
                candidate.block.block_index >= removal.block.block_index ||
                ward_timestamp_delta(candidate.timestamp_millis, removal.timestamp_millis) >
                    kWardTimestampToleranceMillis) {
                continue;
            }
            killer_owner_candidate_count += 1;
            if (killer_owner == nullptr ||
                candidate.block.block_index > killer_owner->block.block_index) {
                killer_owner = &candidate;
            }
        }
        if (killer_owner == nullptr) {
            rejected_missing_killer_owner_block_count += 1;
            continue;
        }
        if (killer_owner_candidate_count > 1) {
            killer_owner_candidate_collision_count += 1;
        }
        kills.push_back({
            removal.timestamp_millis,
            removal.block.block_param,
            ward_owner_to_participant_id(killer_owner->block.block_param, *profile),
            killer_owner->block.block_param,
            *killer_owner,
            removal,
        });
    }

    std::vector<WardEventOrder> event_order;
    event_order.reserve(placements.size() + kills.size());
    for (std::size_t index = 0; index < placements.size(); ++index) {
        event_order.push_back({
            placements[index].timestamp_millis,
            placements[index].marker_block.block.provenance.chunk_id,
            placements[index].marker_block.block.block_index,
            true,
            index,
        });
    }
    for (std::size_t index = 0; index < kills.size(); ++index) {
        event_order.push_back({
            kills[index].timestamp_millis,
            kills[index].removal_block.block.provenance.chunk_id,
            kills[index].removal_block.block.block_index,
            false,
            index,
        });
    }
    std::sort(event_order.begin(), event_order.end(), [](const auto& left, const auto& right) {
        if (left.timestamp_millis != right.timestamp_millis) {
            return left.timestamp_millis < right.timestamp_millis;
        }
        if (left.chunk_id != right.chunk_id) return left.chunk_id < right.chunk_id;
        if (left.block_index != right.block_index) return left.block_index < right.block_index;
        return left.placement && !right.placement;
    });

    std::ostringstream output;
    output << "{\"schema\":\"rofl-replay-wards/v1\",\"generatedAtUtc\":\""
           << current_utc_iso8601() << "\",";
    output << "\"source\":{\"replayPath\":";
    if (source.has_file) output << '"' << json_escape(source.replay_path) << '"'; else output << "null";
    output << ",\"replayId\":";
    if (source.has_file) output << '"' << json_escape(source.replay_id) << '"'; else output << "null";
    output << ",\"matchId\":";
    if (source.has_file) output << '"' << json_escape(source.match_id) << '"'; else output << "null";
    output << ",\"runtimeInput\":\"rofl-only\",\"riotApiInput\":false},";
    output << "\"gameVersion\":\"" << json_escape(summary.game_version)
           << "\",\"versionGroup\":\"" << version_group << "\",";
    output << "\"profile\":{\"channel\":" << static_cast<unsigned int>(profile->channel);
    output << ",\"placementMarkerPacketType\":" << profile->placement_marker_packet_type;
    output << ",\"placementMarkerPacketTypeHex\":\"" << fixed_hex(profile->placement_marker_packet_type, 4) << "\"";
    output << ",\"placementContentLength\":" << profile->placement_content_length;
    output << ",\"placementDiscriminatorOffset\":" << profile->placement_discriminator_offset;
    output << ",\"placementDiscriminatorValues\":[";
    for (std::size_t index = 0; index < profile->placement_discriminator_values.size(); ++index) {
        if (index > 0) output << ',';
        output << static_cast<unsigned int>(profile->placement_discriminator_values[index]);
    }
    output << "],\"placementDiscriminatorValuesHex\":[";
    for (std::size_t index = 0; index < profile->placement_discriminator_values.size(); ++index) {
        if (index > 0) output << ',';
        output << '"' << fixed_hex(profile->placement_discriminator_values[index], 2) << '"';
    }
    output << ']';
    output << ",\"placementOwnerPacketType\":" << profile->placement_owner_packet_type;
    output << ",\"placementOwnerPacketTypeHex\":\"" << fixed_hex(profile->placement_owner_packet_type, 4) << "\"";
    output << ",\"placementOwnerContentLengths\":";
    write_size_array_json(output, profile->placement_owner_content_lengths);
    output << ",\"placementOwnerContentLengthRange\":";
    write_content_length_range_json(output, profile->placement_owner_content_lengths);
    output << ",\"removalPacketType\":" << profile->removal_packet_type;
    output << ",\"removalPacketTypeHex\":\"" << fixed_hex(profile->removal_packet_type, 4) << "\"";
    output << ",\"removalContentLengths\":";
    write_size_array_json(output, profile->removal_content_lengths);
    output << ",\"removalContentLengthRange\":";
    write_content_length_range_json(output, profile->removal_content_lengths);
    output << ",\"killerOwnerPacketType\":" << profile->killer_owner_packet_type;
    output << ",\"killerOwnerPacketTypeHex\":\"" << fixed_hex(profile->killer_owner_packet_type, 4) << "\"";
    output << ",\"killerOwnerContentLengths\":";
    write_size_array_json(output, profile->killer_owner_content_lengths);
    output << ",\"killerOwnerContentLengthRange\":";
    write_content_length_range_json(output, profile->killer_owner_content_lengths);
    output << ",\"championNetworkIdBase\":" << profile->champion_network_id_base;
    output << ",\"championNetworkIdBaseHex\":\"" << fixed_hex(profile->champion_network_id_base, 8) << "\"";
    output << ",\"timestampToleranceMillis\":" << kWardTimestampToleranceMillis;
    write_decoder_profile_provenance_fields(output, decoder_profiles);
    output << "},";
    output << "\"replay\":{\"gameLengthMillis\":";
    if (summary.game_length_millis > 0) output << summary.game_length_millis; else output << "null";
    output << ",\"lastGameChunkId\":";
    if (summary.last_game_chunk_id > 0) output << summary.last_game_chunk_id; else output << "null";
    output << ",\"lastKeyFrameId\":";
    if (summary.last_keyframe_id > 0) output << summary.last_keyframe_id; else output << "null";
    output << "},\"events\":[";
    for (std::size_t order_index = 0; order_index < event_order.size(); ++order_index) {
        if (order_index > 0) output << ',';
        const WardEventOrder& ordered = event_order[order_index];
        if (ordered.placement) {
            const ReplayWardPlacementEvent& event = placements[ordered.event_index];
            output << "{\"type\":\"WARD_PLACED\",\"timestampMillis\":" << event.timestamp_millis;
            output << ",\"wardEntityNetworkId\":" << event.ward_entity_network_id;
            output << ",\"wardEntityNetworkIdHex\":\"" << fixed_hex(event.ward_entity_network_id, 8) << "\"";
            output << ",\"ownerParticipantId\":" << event.owner_participant_id;
            output << ",\"ownerNetworkId\":" << event.owner_network_id;
            output << ",\"ownerNetworkIdHex\":\"" << fixed_hex(event.owner_network_id, 8) << "\"";
            output << ",\"wardType\":null,\"position\":null,\"provenance\":{\"ownerBlock\":";
            write_ward_block_provenance_json(output, event.owner_block);
            output << ",\"markerBlock\":";
            write_ward_block_provenance_json(output, event.marker_block);
            output << "}}";
        } else {
            const ReplayWardKillEvent& event = kills[ordered.event_index];
            output << "{\"type\":\"WARD_KILL\",\"timestampMillis\":" << event.timestamp_millis;
            output << ",\"wardEntityNetworkId\":" << event.ward_entity_network_id;
            output << ",\"wardEntityNetworkIdHex\":\"" << fixed_hex(event.ward_entity_network_id, 8) << "\"";
            output << ",\"killerParticipantId\":" << event.killer_participant_id;
            output << ",\"killerNetworkId\":" << event.killer_network_id;
            output << ",\"killerNetworkIdHex\":\"" << fixed_hex(event.killer_network_id, 8) << "\"";
            output << ",\"wardType\":null,\"position\":null,\"removalReason\":null,\"provenance\":{\"killerOwnerBlock\":";
            write_ward_block_provenance_json(output, event.killer_owner_block);
            output << ",\"removalBlock\":";
            write_ward_block_provenance_json(output, event.removal_block);
            output << "}}";
        }
    }
    output << "],\"diagnostics\":{\"footerRecordCount\":" << summary.container.segments.size();
    output << ",\"chunkRecordCount\":" << scan.selected_segment_count;
    output << ",\"decompressedChunkBytes\":" << scan.input_bytes;
    output << ",\"packetBlockCount\":" << scan.packet_count;
    output << ",\"candidatePlacementMarkerBlockCount\":" << candidate_placement_marker_block_count;
    output << ",\"classifiedPlacementMarkerBlockCount\":" << classified_placement_markers.size();
    output << ",\"rejectedPlacementContentLengthBlockCount\":" << rejected_placement_content_length_block_count;
    output << ",\"rejectedPlacementClassifierBlockCount\":" << rejected_placement_classifier_block_count;
    output << ",\"rejectedUnpairedPlacementMarkerBlockCount\":"
           << classified_placement_markers.size() - placements.size();
    output << ",\"decodedWardPlacementEventCount\":" << placements.size();
    output << ",\"candidateRemovalBlockCount\":" << removal_blocks.size();
    output << ",\"rejectedUntrackedRemovalBlockCount\":" << rejected_untracked_removal_block_count;
    output << ",\"rejectedTrackedUnprofiledRemovalBlockCount\":" << rejected_tracked_unprofiled_removal_block_count;
    output << ",\"rejectedMissingKillerOwnerBlockCount\":" << rejected_missing_killer_owner_block_count;
    output << ",\"killerOwnerCandidateCollisionCount\":" << killer_owner_candidate_collision_count;
    output << ",\"decodedWardKillEventCount\":" << kills.size();
    output << ",\"exactPacketFraming\":true";
    output << ",\"placementCoverage\":\"exact-on-validated-corpus\"";
    output << ",\"removalCoverage\":\"conservative-partial\"";
    output << ",\"wardTypeAvailable\":false";
    output << ",\"positionAvailable\":false";
    output << ",\"visionRadiusAvailable\":false";
    output << ",\"removalReasonAvailable\":false}}";
    return output.str();
}

[[nodiscard]] std::string
extract_replay_ward_position_candidates_impl(
    const std::vector<std::uint8_t>& bytes,
    const KillSourceInfo& source,
    const DecoderProfileRegistry* decoder_profiles
) {
    const ReplaySummary summary = decoder_profiles == nullptr
        ? parse_replay_bytes(bytes)
        : parse_replay_bytes(bytes, *decoder_profiles);
    const std::string version_group =
        packet_version_group(summary.game_version);
    std::optional<WardPacketProfile> external_profile;
    const WardPacketProfile* profile = nullptr;
    if (decoder_profiles != nullptr) {
        const DecoderVersionProfile* selected =
            find_decoder_profile(*decoder_profiles, summary.game_version);
        if (selected == nullptr || !selected->ward.has_value()) {
            throw std::runtime_error(
                "Unsupported replay version " + summary.game_version +
                ": external decoder registry has no ward profile."
            );
        }
        external_profile = adapt_ward_packet_profile(version_group, *selected->ward);
        profile = &*external_profile;
    } else {
        profile = find_ward_packet_profile(version_group);
    }
    if (profile == nullptr) {
        throw std::runtime_error(
            "Unsupported replay version " + summary.game_version +
            ". Supported groups: 15.22, 15.23, 15.24, 16.1, 16.5, "
            "16.6, 16.7, 16.9."
        );
    }
    const bool candidate_version_supported =
        version_group == "16.9" && profile->research_spawn_available;
    const WardPositionResearchExtraction extraction =
        collect_ward_position_research(
            bytes,
            summary,
            *profile,
            candidate_version_supported
        );

    std::ostringstream output;
    output << std::setprecision(12);
    output << "{\"schema\":"
           << "\"rofl-ward-position-candidates-research/v1\"";
    output << ",\"generatedAtUtc\":\""
           << current_utc_iso8601() << "\"";
    output << ",\"researchOnly\":true";
    output << ",\"promotionGate\":false";
    output << ",\"positionAvailable\":false";
    output << ",\"source\":{\"replayPath\":";
    if (source.has_file) {
        output << '"' << json_escape(source.replay_path) << '"';
    } else {
        output << "null";
    }
    output << ",\"replayId\":";
    if (source.has_file) {
        output << '"' << json_escape(source.replay_id) << '"';
    } else {
        output << "null";
    }
    output << ",\"matchId\":";
    if (source.has_file) {
        output << '"' << json_escape(source.match_id) << '"';
    } else {
        output << "null";
    }
    output << ",\"runtimeInput\":\"rofl-only\"";
    output << ",\"riotApiInput\":false";
    output << ",\"clientBinaryInput\":false}";
    output << ",\"gameVersion\":\""
           << json_escape(summary.game_version) << "\"";
    output << ",\"versionGroup\":\""
           << json_escape(version_group) << "\"";
    output << ",\"profile\":{\"channel\":" << static_cast<unsigned int>(profile->channel);
    output << ",\"primarySpawnPacketType\":"
           << profile->research_primary_spawn_packet_type;
    output << ",\"primarySpawnPacketTypeHex\":\""
           << fixed_hex(
                profile->research_primary_spawn_packet_type,
                4
              ) << "\"";
    output << ",\"companionSpawnPacketType\":"
           << profile->research_companion_spawn_packet_type;
    output << ",\"companionSpawnPacketTypeHex\":\""
           << fixed_hex(
                profile->research_companion_spawn_packet_type,
                4
              ) << "\"";
    output << ",\"primaryMinimumContentLength\":"
           << profile->research_primary_minimum_content_length;
    output << ",\"primaryMaximumContentLength\":"
           << profile->research_primary_maximum_content_length;
    output << ",\"companionContentLength\":"
           << profile->research_companion_content_length;
    output << ",\"placementMarkerPacketType\":"
           << profile->placement_marker_packet_type;
    output << ",\"placementMarkerPacketTypeHex\":\""
           << fixed_hex(profile->placement_marker_packet_type, 4)
           << "\"";
    output << ",\"timestampToleranceMillis\":"
           << kWardTimestampToleranceMillis;
    output << ",\"maximumPrecedingBlocks\":"
           << kWardResearchMaximumPrecedingBlocks;
    write_decoder_profile_provenance_fields(output, decoder_profiles);
    output << "}";

    output << ",\"hypotheses\":[";
    if (candidate_version_supported) {
        for (std::size_t index = 0;
             index < kWardPositionResearchHypotheses.size();
             ++index) {
            if (index > 0) output << ',';
            const auto& hypothesis =
                kWardPositionResearchHypotheses[index];
            output << "{\"id\":\""
                   << json_escape(hypothesis.id) << "\"";
            output << ",\"label\":\""
                   << json_escape(hypothesis.label) << "\"";
            output << ",\"description\":\""
                   << json_escape(hypothesis.description) << "\"}";
        }
    }
    output << "],\"placements\":[";
    std::size_t emitted_candidate_count = 0;
    std::size_t rejected_coordinate_candidate_count = 0;
    for (std::size_t placement_index = 0;
         placement_index < extraction.research_placements.size();
         ++placement_index) {
        if (placement_index > 0) output << ',';
        const auto& placement =
            extraction.research_placements[placement_index];
        output << "{\"timestampMillis\":"
               << placement.timestamp_millis;
        output << ",\"wardEntityNetworkId\":"
               << placement.ward_entity_network_id;
        output << ",\"wardEntityNetworkIdHex\":\""
               << fixed_hex(
                    placement.ward_entity_network_id,
                    8
                  ) << "\"";
        output << ",\"ownerParticipantId\":"
               << placement.owner_participant_id;
        output << ",\"ownerNetworkId\":"
               << placement.owner_network_id;
        output << ",\"ownerNetworkIdHex\":\""
               << fixed_hex(
                    placement.owner_network_id,
                    8
                  ) << "\"";
        output << ",\"spawnBlocks\":{\"primary\":";
        write_ward_research_payload_block_json(
            output,
            "primary",
            placement.primary
        );
        output << ",\"companion\":";
        write_ward_research_payload_block_json(
            output,
            "companion",
            placement.companion
        );
        output << "},\"candidates\":[";
        bool first_candidate = true;
        for (std::size_t hypothesis_index = 0;
             hypothesis_index <
                kWardPositionResearchHypotheses.size();
             ++hypothesis_index) {
            const auto& hypothesis =
                kWardPositionResearchHypotheses[hypothesis_index];
            const WardPositionResearchCoordinate coordinate =
                ward_research_coordinate(
                    hypothesis_index,
                    placement.primary.payload,
                    placement.companion.payload
                );
            if (!std::isfinite(coordinate.x) ||
                !std::isfinite(coordinate.y) ||
                coordinate.x < 0.0 || coordinate.x > 15000.0 ||
                coordinate.y < 0.0 || coordinate.y > 15000.0) {
                rejected_coordinate_candidate_count += 1;
                continue;
            }
            if (!first_candidate) output << ',';
            first_candidate = false;
            emitted_candidate_count += 1;
            output << "{\"hypothesisId\":\""
                   << json_escape(hypothesis.id) << "\"";
            output << ",\"label\":\""
                   << json_escape(hypothesis.label) << "\"";
            output << ",\"description\":\""
                   << json_escape(hypothesis.description) << "\"";
            output << ",\"xSource\":\""
                   << json_escape(hypothesis.x_source) << "\"";
            output << ",\"ySource\":\""
                   << json_escape(hypothesis.y_source) << "\"";
            output << ",\"x\":" << coordinate.x;
            output << ",\"y\":" << coordinate.y << '}';
        }
        output << "]}";
    }
    output << "],\"diagnostics\":{\"footerRecordCount\":"
           << summary.container.segments.size();
    output << ",\"chunkRecordCount\":"
           << extraction.scan.selected_segment_count;
    output << ",\"packetBlockCount\":"
           << extraction.scan.packet_count;
    output << ",\"candidateVersionSupported\":"
           << (candidate_version_supported ? "true" : "false");
    output << ",\"candidatePlacementMarkerBlockCount\":"
           << extraction.candidate_placement_marker_block_count;
    output << ",\"classifiedPlacementMarkerBlockCount\":"
           << extraction.classified_placement_markers.size();
    output << ",\"rejectedPlacementContentLengthBlockCount\":"
           << extraction.rejected_placement_content_length_block_count;
    output << ",\"rejectedPlacementClassifierBlockCount\":"
           << extraction.rejected_placement_classifier_block_count;
    output << ",\"rejectedPrimaryProfileLengthCount\":"
           << extraction.rejected_primary_profile_length_count;
    output << ",\"rejectedCompanionProfileLengthCount\":"
           << extraction.rejected_companion_profile_length_count;
    output << ",\"productivePlacementCount\":"
           << extraction.productive_placements.size();
    output << ",\"primarySpawnPacketBlockCount\":"
           << extraction.primary_blocks.size();
    output << ",\"companionSpawnPacketBlockCount\":"
           << extraction.companion_blocks.size();
    output << ",\"researchPlacementCount\":"
           << extraction.research_placements.size();
    output << ",\"emittedCandidateCount\":"
           << emitted_candidate_count;
    output << ",\"rejectedCoordinateCandidateCount\":"
           << rejected_coordinate_candidate_count;
    output << ",\"rejectedPrimaryMissingCount\":"
           << extraction.rejected_primary_missing_count;
    output << ",\"rejectedPrimaryAmbiguousCount\":"
           << extraction.rejected_primary_ambiguous_count;
    output << ",\"rejectedCompanionMissingCount\":"
           << extraction.rejected_companion_missing_count;
    output << ",\"rejectedCompanionAmbiguousCount\":"
           << extraction.rejected_companion_ambiguous_count;
    output << ",\"rejectedSpawnOrderCount\":"
           << extraction.rejected_spawn_order_count;
    output << ",\"rejectedPayloadLengthCount\":"
           << extraction.rejected_payload_length_count;
    output << ",\"exactPacketFraming\":true";
    output << ",\"coordinateClampingApplied\":false";
    output << ",\"positionAvailable\":false}}";
    return output.str();
}
}  // namespace

std::string extract_replay_kills_json(const std::vector<std::uint8_t>& bytes) {
    return extract_replay_kills_impl(bytes, {}, nullptr);
}

std::string extract_replay_kills_json(
    const std::vector<std::uint8_t>& bytes,
    const DecoderProfileRegistry& decoder_profiles
) {
    return extract_replay_kills_impl(bytes, {}, &decoder_profiles);
}

std::string extract_replay_kills_file_json(const std::string& path) {
    std::error_code error;
    std::filesystem::path absolute = std::filesystem::absolute(path, error);
    if (error) absolute = std::filesystem::path(path);
    absolute = absolute.lexically_normal();
    KillSourceInfo source;
    source.has_file = true;
    source.replay_path = absolute.string();
    source.replay_id = absolute.stem().string();
    source.match_id = source.replay_id;
    const std::size_t separator = source.match_id.find('-');
    if (separator != std::string::npos) source.match_id[separator] = '_';
    return extract_replay_kills_impl(read_file_bytes(source.replay_path), source, nullptr);
}

std::string extract_replay_kills_file_json(
    const std::string& path,
    const DecoderProfileRegistry& decoder_profiles
) {
    std::error_code error;
    std::filesystem::path absolute = std::filesystem::absolute(path, error);
    if (error) absolute = std::filesystem::path(path);
    absolute = absolute.lexically_normal();
    KillSourceInfo source;
    source.has_file = true;
    source.replay_path = absolute.string();
    source.replay_id = absolute.stem().string();
    source.match_id = source.replay_id;
    const std::size_t separator = source.match_id.find('-');
    if (separator != std::string::npos) source.match_id[separator] = '_';
    return extract_replay_kills_impl(
        read_file_bytes(source.replay_path),
        source,
        &decoder_profiles
    );
}

std::string extract_replay_objectives_json(const std::vector<std::uint8_t>& bytes) {
    return extract_replay_objectives_impl(bytes, {}, nullptr);
}

std::string extract_replay_objectives_json(
    const std::vector<std::uint8_t>& bytes,
    const DecoderProfileRegistry& decoder_profiles
) {
    return extract_replay_objectives_impl(bytes, {}, &decoder_profiles);
}

std::string extract_replay_objectives_file_json(const std::string& path) {
    std::error_code error;
    std::filesystem::path absolute = std::filesystem::absolute(path, error);
    if (error) absolute = std::filesystem::path(path);
    absolute = absolute.lexically_normal();
    KillSourceInfo source;
    source.has_file = true;
    source.replay_path = absolute.string();
    source.replay_id = absolute.stem().string();
    source.match_id = source.replay_id;
    const std::size_t separator = source.match_id.find('-');
    if (separator != std::string::npos) source.match_id[separator] = '_';
    return extract_replay_objectives_impl(read_file_bytes(source.replay_path), source, nullptr);
}

std::string extract_replay_objectives_file_json(
    const std::string& path,
    const DecoderProfileRegistry& decoder_profiles
) {
    std::error_code error;
    std::filesystem::path absolute = std::filesystem::absolute(path, error);
    if (error) absolute = std::filesystem::path(path);
    absolute = absolute.lexically_normal();
    KillSourceInfo source;
    source.has_file = true;
    source.replay_path = absolute.string();
    source.replay_id = absolute.stem().string();
    source.match_id = source.replay_id;
    const std::size_t separator = source.match_id.find('-');
    if (separator != std::string::npos) source.match_id[separator] = '_';
    return extract_replay_objectives_impl(
        read_file_bytes(source.replay_path),
        source,
        &decoder_profiles
    );
}

std::string extract_replay_wards_json(const std::vector<std::uint8_t>& bytes) {
    return extract_replay_wards_impl(bytes, {}, nullptr);
}

std::string extract_replay_wards_json(
    const std::vector<std::uint8_t>& bytes,
    const DecoderProfileRegistry& decoder_profiles
) {
    return extract_replay_wards_impl(bytes, {}, &decoder_profiles);
}

std::string extract_replay_wards_file_json(const std::string& path) {
    std::error_code error;
    std::filesystem::path absolute = std::filesystem::absolute(path, error);
    if (error) absolute = std::filesystem::path(path);
    absolute = absolute.lexically_normal();
    KillSourceInfo source;
    source.has_file = true;
    source.replay_path = absolute.string();
    source.replay_id = absolute.stem().string();
    source.match_id = source.replay_id;
    const std::size_t separator = source.match_id.find('-');
    if (separator != std::string::npos) source.match_id[separator] = '_';
    return extract_replay_wards_impl(read_file_bytes(source.replay_path), source, nullptr);
}

std::string extract_replay_wards_file_json(
    const std::string& path,
    const DecoderProfileRegistry& decoder_profiles
) {
    std::error_code error;
    std::filesystem::path absolute = std::filesystem::absolute(path, error);
    if (error) absolute = std::filesystem::path(path);
    absolute = absolute.lexically_normal();
    KillSourceInfo source;
    source.has_file = true;
    source.replay_path = absolute.string();
    source.replay_id = absolute.stem().string();
    source.match_id = source.replay_id;
    const std::size_t separator = source.match_id.find('-');
    if (separator != std::string::npos) source.match_id[separator] = '_';
    return extract_replay_wards_impl(
        read_file_bytes(source.replay_path),
        source,
        &decoder_profiles
    );
}

std::string extract_replay_ward_position_candidates_json(
    const std::vector<std::uint8_t>& bytes
) {
    return extract_replay_ward_position_candidates_impl(bytes, {}, nullptr);
}

std::string extract_replay_ward_position_candidates_json(
    const std::vector<std::uint8_t>& bytes,
    const DecoderProfileRegistry& decoder_profiles
) {
    return extract_replay_ward_position_candidates_impl(
        bytes,
        {},
        &decoder_profiles
    );
}

std::string extract_replay_ward_position_candidates_file_json(
    const std::string& path
) {
    std::error_code error;
    std::filesystem::path absolute =
        std::filesystem::absolute(path, error);
    if (error) absolute = std::filesystem::path(path);
    absolute = absolute.lexically_normal();
    KillSourceInfo source;
    source.has_file = true;
    source.replay_path = absolute.string();
    source.replay_id = absolute.stem().string();
    source.match_id = source.replay_id;
    const std::size_t separator = source.match_id.find('-');
    if (separator != std::string::npos) {
        source.match_id[separator] = '_';
    }
    return extract_replay_ward_position_candidates_impl(
        read_file_bytes(source.replay_path),
        source,
        nullptr
    );
}

std::string extract_replay_ward_position_candidates_file_json(
    const std::string& path,
    const DecoderProfileRegistry& decoder_profiles
) {
    std::error_code error;
    std::filesystem::path absolute =
        std::filesystem::absolute(path, error);
    if (error) absolute = std::filesystem::path(path);
    absolute = absolute.lexically_normal();
    KillSourceInfo source;
    source.has_file = true;
    source.replay_path = absolute.string();
    source.replay_id = absolute.stem().string();
    source.match_id = source.replay_id;
    const std::size_t separator = source.match_id.find('-');
    if (separator != std::string::npos) source.match_id[separator] = '_';
    return extract_replay_ward_position_candidates_impl(
        read_file_bytes(source.replay_path),
        source,
        &decoder_profiles
    );
}

namespace {

struct InventoryPurchaseRelevantBlock {
    PacketBlock block;
    long long timestamp_millis = 0;
    int participant_id = 0;
    InventoryPurchaseBundleFamily family = InventoryPurchaseBundleFamily::add;
    std::vector<std::uint8_t> payload;
};

[[nodiscard]] std::string_view inventory_purchase_family_name(InventoryPurchaseBundleFamily family) {
    switch (family) {
        case InventoryPurchaseBundleFamily::add: return "add";
        case InventoryPurchaseBundleFamily::removal: return "removal";
        case InventoryPurchaseBundleFamily::removal_context: return "removalContext";
        case InventoryPurchaseBundleFamily::undo_component: return "undoComponent";
    }
    return "unknown";
}

[[nodiscard]] bool inventory_purchase_length_is_profiled(
    std::size_t value, const ContentLengthConstraint& constraint
) {
    return std::find(constraint.exact_values.begin(), constraint.exact_values.end(), value) !=
        constraint.exact_values.end();
}

[[nodiscard]] int inventory_purchase_owner_to_participant_id(
    std::uint32_t owner, const InventoryPurchaseSubsetDecoderProfile& profile
) {
    if (owner <= profile.champion_network_id_base) return 0;
    const std::uint32_t participant_id = owner - profile.champion_network_id_base;
    return participant_id <= 10 ? static_cast<int>(participant_id) : 0;
}

[[nodiscard]] std::optional<InventoryPurchaseBundleFamily> classify_inventory_purchase_block(
    const PacketBlock& block, const InventoryPurchaseSubsetDecoderProfile& profile
) {
    if (block.packet_type == profile.add.packet_type &&
        inventory_purchase_length_is_profiled(block.content_length, profile.add.content_lengths)) {
        return InventoryPurchaseBundleFamily::add;
    }
    if (block.packet_type == profile.removal.packet_type &&
        inventory_purchase_length_is_profiled(block.content_length, profile.removal.content_lengths)) {
        return InventoryPurchaseBundleFamily::removal;
    }
    if (block.packet_type == profile.removal_context.packet_type &&
        inventory_purchase_length_is_profiled(block.content_length, profile.removal_context.content_lengths)) {
        return InventoryPurchaseBundleFamily::removal_context;
    }
    if (block.packet_type == profile.undo_component_packet_type) {
        return InventoryPurchaseBundleFamily::undo_component;
    }
    return std::nullopt;
}

[[nodiscard]] bool inventory_purchase_template_matches(
    const std::vector<InventoryPurchaseRelevantBlock>& group,
    const InventoryPurchaseTemplate& template_value
) {
    if (group.size() != template_value.tokens.size()) return false;
    for (std::size_t index = 0; index < group.size(); ++index) {
        if (group[index].family != template_value.tokens[index].family ||
            group[index].block.content_length != template_value.tokens[index].content_length) return false;
    }
    return true;
}

[[nodiscard]] std::string inventory_purchase_signature(
    const std::vector<InventoryPurchaseRelevantBlock>& group
) {
    std::ostringstream output;
    for (std::size_t index = 0; index < group.size(); ++index) {
        if (index > 0) output << '>';
        output << inventory_purchase_family_name(group[index].family) << ':' << group[index].block.content_length;
    }
    return output.str();
}

[[nodiscard]] std::uint8_t inventory_payload_bit(
    std::span<const std::uint8_t> payload, std::size_t bit
) {
    return static_cast<std::uint8_t>((payload[bit >> 3U] >> (bit & 7U)) & 1U);
}

[[nodiscard]] std::uint8_t inventory_input_code(
    std::span<const std::uint8_t> payload, std::initializer_list<std::size_t> bits
) {
    std::uint8_t code = 0;
    std::size_t index = 0;
    for (const std::size_t bit : bits) code |= static_cast<std::uint8_t>(inventory_payload_bit(payload, bit) << index++);
    return code;
}

// The two unseen input codes deliberately return unavailable rather than a
// Boolean extrapolation. This is the validated patch-16.14 grammar only.
[[nodiscard]] std::optional<std::uint16_t> decode_inventory_item_id_16_14(
    std::span<const std::uint8_t> payload
) {
    if (payload.size() < 10 || inventory_input_code(payload, {72, 73, 79}) == 0 ||
        inventory_input_code(payload, {73, 75, 76}) == 4) return std::nullopt;
    const auto bit = [&](std::size_t index) { return inventory_payload_bit(payload, index); };
    const std::array<std::uint8_t, 13> values{{
        bit(71), static_cast<std::uint8_t>(bit(66) ^ bit(71) ^ 1U),
        static_cast<std::uint8_t>(bit(65) ^ (bit(66) & bit(71))),
        static_cast<std::uint8_t>(1U ^ bit(65) ^ bit(68) ^ (bit(66) & bit(71)) ^ (bit(65) & bit(66) & bit(71))),
        static_cast<std::uint8_t>(1U ^ bit(67) ^ bit(68) ^ (bit(65) & bit(68)) ^ (bit(66) & bit(68) & bit(71)) ^ (bit(65) & bit(66) & bit(68) & bit(71))),
        static_cast<std::uint8_t>(bit(70) ^ 1U), static_cast<std::uint8_t>(bit(69) ^ bit(70) ^ 1U),
        static_cast<std::uint8_t>(bit(78) ^ bit(79)),
        static_cast<std::uint8_t>(1U ^ bit(74) ^ bit(79) ^ (bit(72) & bit(79))),
        static_cast<std::uint8_t>(bit(73) ^ (bit(73) & bit(79)) ^ (bit(72) & bit(73) & bit(79))),
        static_cast<std::uint8_t>(bit(73) ^ bit(76) ^ 1U),
        static_cast<std::uint8_t>(1U ^ bit(75) ^ bit(76) ^ (bit(73) & bit(76))),
        static_cast<std::uint8_t>(bit(78) ^ 1U),
    }};
    std::uint16_t item_id = 0;
    for (std::size_t index = 0; index < values.size(); ++index) {
        item_id |= static_cast<std::uint16_t>(values[index] << index);
    }
    return item_id;
}

void write_inventory_purchase_block_json(
    std::ostringstream& output, const InventoryPurchaseRelevantBlock& relevant
) {
    output << "{\"family\":\"" << inventory_purchase_family_name(relevant.family) << "\"";
    output << ",\"packetType\":" << relevant.block.packet_type;
    output << ",\"packetTypeHex\":\"" << fixed_hex(relevant.block.packet_type, 4) << "\"";
    output << ",\"contentLength\":" << relevant.block.content_length << ",\"provenance\":";
    write_objective_block_provenance_json(output, relevant.block);
    output << '}';
}

[[nodiscard]] std::string extract_replay_purchase_linked_item_updates_impl(
    const std::vector<std::uint8_t>& bytes, const KillSourceInfo& source,
    const DecoderProfileRegistry& decoder_profiles
) {
    const ReplaySummary summary = parse_replay_bytes(bytes, decoder_profiles);
    if (summary.game_version != "16.14.794.5912") {
        throw std::runtime_error("Inventory purchase subset decoder is restricted to exact build 16.14.794.5912.");
    }
    const DecoderVersionProfile* selected = find_decoder_profile(decoder_profiles, summary.game_version);
    if (selected == nullptr || !selected->inventory_purchase_subset.has_value()) {
        throw std::runtime_error("Unsupported replay version " + summary.game_version +
            ": external decoder registry has no inventory purchase subset profile.");
    }
    const InventoryPurchaseSubsetDecoderProfile& profile = *selected->inventory_purchase_subset;
    std::map<std::pair<int, long long>, std::vector<InventoryPurchaseRelevantBlock>> groups;
    std::size_t profiled_add_packet_count = 0;
    const PacketFileScan scan = scan_packet_segments(bytes, summary, profile.segment_type,
        [&](const ReplaySegmentSummary&, const std::vector<std::uint8_t>& decompressed,
            const PacketBlockParseResult& result) {
            for (const PacketBlock& block : result.blocks) {
                if (block.channel != profile.channel) continue;
                const int participant_id = inventory_purchase_owner_to_participant_id(block.block_param, profile);
                if (participant_id == 0) continue;
                const auto family = classify_inventory_purchase_block(block, profile);
                if (!family.has_value()) continue;
                InventoryPurchaseRelevantBlock relevant{block, packet_timestamp_millis(block.timestamp_seconds), participant_id, *family, {}};
                if (*family == InventoryPurchaseBundleFamily::add) {
                    ++profiled_add_packet_count;
                    relevant.payload.assign(decompressed.begin() + static_cast<std::ptrdiff_t>(block.content_offset),
                        decompressed.begin() + static_cast<std::ptrdiff_t>(block.end_offset));
                }
                groups[{participant_id, relevant.timestamp_millis}].push_back(std::move(relevant));
            }
        });
    if (scan.selected_segment_count == 0) throw std::runtime_error("Replay contains no footer-style chunk records.");
    if (scan.exact_segment_count != scan.selected_segment_count || !scan.errors.empty()) {
        const std::string detail = scan.errors.empty() ? "one or more chunks were not exactly consumed"
            : scan.errors.front().code + ": " + scan.errors.front().message;
        throw std::runtime_error("Replay chunk packet framing failed: " + detail);
    }

    struct EmittedEvent {
        long long timestamp_millis = 0;
        int participant_id = 0;
        std::uint16_t resulting_item_id = 0;
        std::size_t template_index = 0;
        std::string signature;
        std::vector<InventoryPurchaseRelevantBlock> group;
        std::size_t add_index = 0;
    };
    std::vector<EmittedEvent> events;
    std::size_t matched_template_group_count = 0;
    std::size_t rejected_nonmatching_group_count = 0;
    std::size_t rejected_missing_item_id_symbol_group_count = 0;
    for (auto& [key, group] : groups) {
        std::stable_sort(group.begin(), group.end(), [](const auto& left, const auto& right) {
            if (left.block.provenance.segment_payload_offset != right.block.provenance.segment_payload_offset) {
                return left.block.provenance.segment_payload_offset < right.block.provenance.segment_payload_offset;
            }
            if (left.block.header_offset != right.block.header_offset) return left.block.header_offset < right.block.header_offset;
            return left.block.block_index < right.block.block_index;
        });
        const auto matched = std::find_if(profile.templates.begin(), profile.templates.end(),
            [&](const InventoryPurchaseTemplate& template_value) { return inventory_purchase_template_matches(group, template_value); });
        if (matched == profile.templates.end()) {
            ++rejected_nonmatching_group_count;
            continue;
        }
        ++matched_template_group_count;
        const auto add = std::find_if(group.begin(), group.end(), [](const auto& block) {
            return block.family == InventoryPurchaseBundleFamily::add;
        });
        if (add == group.end()) throw std::runtime_error("Inventory purchase template invariant failed: matched group has no add block.");
        const auto item_id = decode_inventory_item_id_16_14(add->payload);
        if (!item_id.has_value()) {
            ++rejected_missing_item_id_symbol_group_count;
            continue;
        }
        events.push_back({key.second, key.first, *item_id,
            static_cast<std::size_t>(std::distance(profile.templates.begin(), matched)),
            inventory_purchase_signature(group), group,
            static_cast<std::size_t>(std::distance(group.begin(), add))});
    }
    std::sort(events.begin(), events.end(), [](const EmittedEvent& left, const EmittedEvent& right) {
        if (left.timestamp_millis != right.timestamp_millis) return left.timestamp_millis < right.timestamp_millis;
        if (left.participant_id != right.participant_id) return left.participant_id < right.participant_id;
        const PacketBlock& left_add = left.group[left.add_index].block;
        const PacketBlock& right_add = right.group[right.add_index].block;
        if (left_add.provenance.segment_payload_offset != right_add.provenance.segment_payload_offset) {
            return left_add.provenance.segment_payload_offset < right_add.provenance.segment_payload_offset;
        }
        if (left_add.header_offset != right_add.header_offset) return left_add.header_offset < right_add.header_offset;
        return left_add.block_index < right_add.block_index;
    });

    std::ostringstream output;
    output << "{\"schema\":\"rofl-replay-purchase-linked-item-updates/v1\",\"generatedAtUtc\":\"" << current_utc_iso8601() << "\",";
    output << "\"source\":{\"replayPath\":";
    if (source.has_file) output << '"' << json_escape(source.replay_path) << '"'; else output << "null";
    output << ",\"replayId\":";
    if (source.has_file) output << '"' << json_escape(source.replay_id) << '"'; else output << "null";
    output << ",\"matchId\":";
    if (source.has_file) output << '"' << json_escape(source.match_id) << '"'; else output << "null";
    output << ",\"runtimeInput\":\"rofl-only\",\"riotApiInput\":false},";
    output << "\"gameVersion\":\"" << json_escape(summary.game_version) << "\",\"versionGroup\":\"" << packet_version_group(summary.game_version) << "\",";
    output << "\"profile\":{\"segmentType\":\"" << profile.segment_type << "\",\"channel\":" << static_cast<unsigned int>(profile.channel)
           << ",\"championNetworkIdBase\":" << profile.champion_network_id_base << ",\"championNetworkIdBaseHex\":\"" << fixed_hex(profile.champion_network_id_base, 8) << "\""
           << ",\"addUpdatePacketType\":" << profile.add.packet_type << ",\"addUpdatePacketTypeHex\":\"" << fixed_hex(profile.add.packet_type, 4) << "\",\"contentLengths\":";
    write_size_array_json(output, profile.add.content_lengths);
    output << ",\"removalPacketType\":" << profile.removal.packet_type << ",\"removalPacketTypeHex\":\"" << fixed_hex(profile.removal.packet_type, 4) << "\",\"removalContentLengths\":";
    write_size_array_json(output, profile.removal.content_lengths);
    output << ",\"removalContextPacketType\":" << profile.removal_context.packet_type << ",\"removalContextPacketTypeHex\":\"" << fixed_hex(profile.removal_context.packet_type, 4) << "\",\"removalContextContentLengths\":";
    write_size_array_json(output, profile.removal_context.content_lengths);
    output << ",\"undoComponentPacketType\":" << profile.undo_component_packet_type << ",\"undoComponentPacketTypeHex\":\"" << fixed_hex(profile.undo_component_packet_type, 4) << "\",\"templateCount\":" << profile.templates.size();
    write_decoder_profile_provenance_fields(output, &decoder_profiles);
    output << "},\"events\":[";
    for (std::size_t index = 0; index < events.size(); ++index) {
        if (index > 0) output << ',';
        const EmittedEvent& event = events[index];
        output << "{\"type\":\"PURCHASE_LINKED_RESULTING_ITEM_UPDATE\",\"timestampMillis\":" << event.timestamp_millis
               << ",\"participantId\":" << event.participant_id << ",\"participantNetworkId\":"
               << profile.champion_network_id_base + static_cast<std::uint32_t>(event.participant_id)
               << ",\"participantNetworkIdHex\":\"" << fixed_hex(profile.champion_network_id_base + static_cast<std::uint32_t>(event.participant_id), 8)
               << "\",\"resultingItemId\":" << event.resulting_item_id
               << ",\"purchaseLinked\":true,\"matchedTemplateIndex\":" << event.template_index
               << ",\"matchedTemplateSignature\":\"" << event.signature << "\",\"provenance\":{\"addBlock\":";
        write_inventory_purchase_block_json(output, event.group[event.add_index]);
        output << ",\"groupBlocks\":[";
        for (std::size_t block_index = 0; block_index < event.group.size(); ++block_index) {
            if (block_index > 0) output << ',';
            write_inventory_purchase_block_json(output, event.group[block_index]);
        }
        output << "]}}";
    }
    output << "],\"diagnostics\":{\"footerRecordCount\":" << summary.container.segments.size()
           << ",\"chunkRecordCount\":" << scan.selected_segment_count << ",\"decompressedChunkBytes\":" << scan.input_bytes
           << ",\"packetBlockCount\":" << scan.packet_count << ",\"profiledAddUpdatePacketCount\":" << profiled_add_packet_count
           << ",\"profiledOwnerTimeGroupCount\":" << groups.size() << ",\"matchedTemplateGroupCount\":" << matched_template_group_count
           << ",\"rejectedNonmatchingGroupCount\":" << rejected_nonmatching_group_count
           << ",\"rejectedUnavailableItemIdGroupCount\":" << rejected_missing_item_id_symbol_group_count
           << ",\"emittedEventCount\":" << events.size()
           << ",\"unavailableAddUpdatePacketCount\":" << profiled_add_packet_count - events.size()
           << ",\"exactPacketFraming\":true,\"coverage\":\"strict-subset-not-complete\""
           << ",\"generalPurchaseClassificationAvailable\":false,\"automaticStateUpdateClassificationAvailable\":false"
           << ",\"consumedComponentIdentityAvailable\":false,\"removedItemIdentityAvailable\":false"
           << ",\"slotAvailable\":false,\"itemInstanceAvailable\":false,\"countOrChargesAvailable\":false"
           << ",\"priceAvailable\":false,\"goldStateAvailable\":false,\"undoAvailable\":false,\"inventoryStateAvailable\":false"
           << ",\"completePurchaseTimelineAvailable\":false,\"inventoryTimelineAvailable\":false,\"currentInventoryAvailable\":false}}";
    return output.str();
}

struct InventoryDirectPurchaseRelevantBlock {
    PacketBlock block;
    long long timestamp_millis = 0;
    int participant_id = 0;
    bool is_add_packet = false;
    std::vector<std::uint8_t> payload;
};

[[nodiscard]] int inventory_direct_purchase_owner_to_participant_id(
    std::uint32_t owner,
    const InventoryDirectPurchaseSubsetDecoderProfile& profile
) {
    if (owner <= profile.champion_network_id_base) return 0;
    const std::uint32_t participant_id = owner - profile.champion_network_id_base;
    return participant_id <= 10 ? static_cast<int>(participant_id) : 0;
}

[[nodiscard]] bool inventory_direct_purchase_is_known_operation(
    std::uint16_t packet_type,
    const InventoryDirectPurchaseSubsetDecoderProfile& profile
) {
    return packet_type == profile.add.packet_type ||
        std::find(
            profile.blocking_packet_types.begin(),
            profile.blocking_packet_types.end(),
            packet_type
        ) != profile.blocking_packet_types.end();
}

[[nodiscard]] bool inventory_direct_purchase_has_neighbor_operation(
    const std::map<std::pair<int, long long>, std::vector<InventoryDirectPurchaseRelevantBlock>>& groups,
    int participant_id,
    long long timestamp_millis,
    std::size_t tolerance_millis
) {
    for (std::size_t delta = 1; delta <= tolerance_millis; ++delta) {
        const long long signed_delta = static_cast<long long>(delta);
        if (timestamp_millis >= signed_delta &&
            groups.contains({participant_id, timestamp_millis - signed_delta})) return true;
        if (timestamp_millis <= std::numeric_limits<long long>::max() - signed_delta &&
            groups.contains({participant_id, timestamp_millis + signed_delta})) return true;
    }
    return false;
}

void write_inventory_direct_purchase_add_block_json(
    std::ostringstream& output,
    const InventoryDirectPurchaseRelevantBlock& relevant
) {
    output << "{\"family\":\"add\",\"channel\":"
           << static_cast<unsigned int>(relevant.block.channel)
           << ",\"packetType\":" << relevant.block.packet_type
           << ",\"packetTypeHex\":\"" << fixed_hex(relevant.block.packet_type, 4) << "\""
           << ",\"contentLength\":" << relevant.block.content_length
           << ",\"blockParam\":" << relevant.block.block_param
           << ",\"blockParamHex\":\"" << fixed_hex(relevant.block.block_param, 8) << "\""
           << ",\"provenance\":";
    write_objective_block_provenance_json(output, relevant.block);
    output << '}';
}

[[nodiscard]] std::string extract_replay_direct_item_purchases_impl(
    const std::vector<std::uint8_t>& bytes,
    const KillSourceInfo& source,
    const DecoderProfileRegistry& decoder_profiles
) {
    const ReplaySummary summary = parse_replay_bytes(bytes, decoder_profiles);
    if (summary.game_version != "16.14.794.5912") {
        throw std::runtime_error(
            "Inventory direct purchase subset decoder is restricted to exact build 16.14.794.5912."
        );
    }
    const DecoderVersionProfile* selected = find_decoder_profile(
        decoder_profiles, summary.game_version);
    if (selected == nullptr || !selected->inventory_direct_purchase_subset.has_value()) {
        throw std::runtime_error(
            "Unsupported replay version " + summary.game_version +
            ": external decoder registry has no inventory direct purchase subset profile."
        );
    }
    const InventoryDirectPurchaseSubsetDecoderProfile& profile =
        *selected->inventory_direct_purchase_subset;

    std::map<std::pair<int, long long>, std::vector<InventoryDirectPurchaseRelevantBlock>> groups;
    std::size_t known_inventory_operation_packet_count = 0;
    std::size_t profiled_add_update_packet_count = 0;
    const PacketFileScan scan = scan_packet_segments(
        bytes,
        summary,
        profile.segment_type,
        [&](const ReplaySegmentSummary&,
            const std::vector<std::uint8_t>& decompressed,
            const PacketBlockParseResult& result) {
            for (const PacketBlock& block : result.blocks) {
                if (block.channel != profile.channel ||
                    !inventory_direct_purchase_is_known_operation(block.packet_type, profile)) continue;
                const int participant_id = inventory_direct_purchase_owner_to_participant_id(
                    block.block_param, profile);
                if (participant_id == 0) continue;
                ++known_inventory_operation_packet_count;
                const bool is_add_packet = block.packet_type == profile.add.packet_type;
                InventoryDirectPurchaseRelevantBlock relevant{
                    block,
                    packet_timestamp_millis(block.timestamp_seconds),
                    participant_id,
                    is_add_packet,
                    {},
                };
                if (is_add_packet && inventory_purchase_length_is_profiled(
                        block.content_length, profile.add.content_lengths)) {
                    ++profiled_add_update_packet_count;
                    relevant.payload.assign(
                        decompressed.begin() + static_cast<std::ptrdiff_t>(block.content_offset),
                        decompressed.begin() + static_cast<std::ptrdiff_t>(block.end_offset)
                    );
                }
                groups[{participant_id, relevant.timestamp_millis}].push_back(
                    std::move(relevant));
            }
        }
    );
    if (scan.selected_segment_count == 0) {
        throw std::runtime_error("Replay contains no footer-style chunk records.");
    }
    if (scan.exact_segment_count != scan.selected_segment_count || !scan.errors.empty()) {
        const std::string detail = scan.errors.empty()
            ? "one or more chunks were not exactly consumed"
            : scan.errors.front().code + ": " + scan.errors.front().message;
        throw std::runtime_error("Replay chunk packet framing failed: " + detail);
    }

    struct EmittedEvent {
        long long timestamp_millis = 0;
        int participant_id = 0;
        std::uint16_t item_id = 0;
        bool component_item = false;
        InventoryDirectPurchaseRelevantBlock add;
    };
    std::vector<EmittedEvent> events;
    std::size_t profiled_single_add_only_group_count = 0;
    std::size_t rejected_non_singleton_group_count = 0;
    std::size_t rejected_non_add_or_length_group_count = 0;
    std::size_t rejected_neighbor_operation_group_count = 0;
    std::size_t rejected_unavailable_item_id_group_count = 0;
    std::size_t rejected_static_item_catalog_group_count = 0;
    std::size_t component_item_event_count = 0;

    for (auto& [key, group] : groups) {
        std::stable_sort(group.begin(), group.end(), [](const auto& left, const auto& right) {
            if (left.block.provenance.segment_payload_offset !=
                right.block.provenance.segment_payload_offset) {
                return left.block.provenance.segment_payload_offset <
                    right.block.provenance.segment_payload_offset;
            }
            if (left.block.header_offset != right.block.header_offset) {
                return left.block.header_offset < right.block.header_offset;
            }
            return left.block.block_index < right.block.block_index;
        });
        if (group.size() != 1) {
            ++rejected_non_singleton_group_count;
            continue;
        }
        InventoryDirectPurchaseRelevantBlock& candidate = group.front();
        if (!candidate.is_add_packet || !inventory_purchase_length_is_profiled(
                candidate.block.content_length, profile.add.content_lengths)) {
            ++rejected_non_add_or_length_group_count;
            continue;
        }
        ++profiled_single_add_only_group_count;
        if (inventory_direct_purchase_has_neighbor_operation(
                groups,
                key.first,
                key.second,
                profile.isolation_tolerance_millis)) {
            ++rejected_neighbor_operation_group_count;
            continue;
        }
        const auto item_id = decode_inventory_item_id_16_14(candidate.payload);
        if (!item_id.has_value()) {
            ++rejected_unavailable_item_id_group_count;
            continue;
        }
        const InventoryStaticItemCatalogProfile& catalog = profile.static_item_catalog;
        if (!std::binary_search(
                catalog.real_item_ids.begin(), catalog.real_item_ids.end(), *item_id)) {
            ++rejected_static_item_catalog_group_count;
            continue;
        }
        const bool component_item = std::binary_search(
            catalog.component_item_ids.begin(), catalog.component_item_ids.end(), *item_id);
        if (component_item) ++component_item_event_count;
        events.push_back({
            key.second,
            key.first,
            *item_id,
            component_item,
            candidate,
        });
    }
    std::sort(events.begin(), events.end(), [](const EmittedEvent& left, const EmittedEvent& right) {
        if (left.add.block.provenance.segment_payload_offset !=
            right.add.block.provenance.segment_payload_offset) {
            return left.add.block.provenance.segment_payload_offset <
                right.add.block.provenance.segment_payload_offset;
        }
        if (left.add.block.header_offset != right.add.block.header_offset) {
            return left.add.block.header_offset < right.add.block.header_offset;
        }
        return left.add.block.block_index < right.add.block.block_index;
    });

    std::ostringstream output;
    output << "{\"schema\":\"rofl-replay-direct-item-purchases/v1\",\"generatedAtUtc\":\""
           << current_utc_iso8601() << "\",\"source\":{\"replayPath\":";
    if (source.has_file) output << '"' << json_escape(source.replay_path) << '"';
    else output << "null";
    output << ",\"replayId\":";
    if (source.has_file) output << '"' << json_escape(source.replay_id) << '"';
    else output << "null";
    output << ",\"matchId\":";
    if (source.has_file) output << '"' << json_escape(source.match_id) << '"';
    else output << "null";
    output << ",\"runtimeInput\":\"rofl-only\",\"riotApiInput\":false}"
           << ",\"gameVersion\":\"" << json_escape(summary.game_version)
           << "\",\"versionGroup\":\"" << packet_version_group(summary.game_version)
           << "\",\"profile\":{\"segmentType\":\"" << profile.segment_type
           << "\",\"channel\":" << static_cast<unsigned int>(profile.channel)
           << ",\"championNetworkIdBase\":" << profile.champion_network_id_base
           << ",\"championNetworkIdBaseHex\":\""
           << fixed_hex(profile.champion_network_id_base, 8) << "\""
           << ",\"addUpdatePacketType\":" << profile.add.packet_type
           << ",\"addUpdatePacketTypeHex\":\"" << fixed_hex(profile.add.packet_type, 4)
           << "\",\"contentLengths\":";
    write_size_array_json(output, profile.add.content_lengths);
    output << ",\"blockingPacketTypes\":[";
    for (std::size_t index = 0; index < profile.blocking_packet_types.size(); ++index) {
        if (index > 0) output << ',';
        output << profile.blocking_packet_types[index];
    }
    output << "],\"blockingPacketTypesHex\":[";
    for (std::size_t index = 0; index < profile.blocking_packet_types.size(); ++index) {
        if (index > 0) output << ',';
        output << '"' << fixed_hex(profile.blocking_packet_types[index], 4) << '"';
    }
    const InventoryStaticItemCatalogProfile& catalog = profile.static_item_catalog;
    output << "],\"isolationToleranceMillis\":" << profile.isolation_tolerance_millis
           << ",\"staticItemCatalog\":{\"provider\":\"" << json_escape(catalog.provider)
           << "\",\"version\":\"" << json_escape(catalog.version)
           << "\",\"locale\":\"" << json_escape(catalog.locale)
           << "\",\"sourceUrl\":\"" << json_escape(catalog.source_url)
           << "\",\"sourceByteLength\":" << catalog.source_byte_length
           << ",\"sourceSha256\":\"" << json_escape(catalog.source_sha256)
           << "\",\"entryCount\":" << catalog.entry_count
           << ",\"realItemIdCount\":" << catalog.real_item_ids.size()
           << ",\"componentItemIdCount\":" << catalog.component_item_ids.size() << '}';
    write_decoder_profile_provenance_fields(output, &decoder_profiles);
    output << "},\"events\":[";
    for (std::size_t index = 0; index < events.size(); ++index) {
        if (index > 0) output << ',';
        const EmittedEvent& event = events[index];
        const std::uint32_t network_id = profile.champion_network_id_base +
            static_cast<std::uint32_t>(event.participant_id);
        output << "{\"type\":\"DIRECT_ADD_ONLY_ITEM_PURCHASE\",\"timestampMillis\":"
               << event.timestamp_millis << ",\"participantId\":" << event.participant_id
               << ",\"participantNetworkId\":" << network_id
               << ",\"participantNetworkIdHex\":\"" << fixed_hex(network_id, 8)
               << "\",\"itemId\":" << event.item_id
               << ",\"componentItem\":" << (event.component_item ? "true" : "false")
               << ",\"classification\":\"direct-add-only\""
               << ",\"availability\":{\"slot\":false,\"itemInstance\":false,"
                  "\"countOrCharges\":false,\"price\":false,\"goldState\":false,"
                  "\"inventoryState\":false},\"provenance\":{\"addBlock\":";
        write_inventory_direct_purchase_add_block_json(output, event.add);
        output << "}}";
    }
    output << "],\"diagnostics\":{\"footerRecordCount\":" << summary.container.segments.size()
           << ",\"chunkRecordCount\":" << scan.selected_segment_count
           << ",\"decompressedChunkBytes\":" << scan.input_bytes
           << ",\"packetBlockCount\":" << scan.packet_count
           << ",\"knownInventoryOperationPacketCount\":" << known_inventory_operation_packet_count
           << ",\"profiledAddUpdatePacketCount\":" << profiled_add_update_packet_count
           << ",\"knownOwnerTimeGroupCount\":" << groups.size()
           << ",\"profiledSingleAddOnlyGroupCount\":" << profiled_single_add_only_group_count
           << ",\"rejectedNonSingletonGroupCount\":" << rejected_non_singleton_group_count
           << ",\"rejectedNonAddOrLengthGroupCount\":" << rejected_non_add_or_length_group_count
           << ",\"rejectedNeighborOperationGroupCount\":" << rejected_neighbor_operation_group_count
           << ",\"rejectedUnavailableItemIdGroupCount\":" << rejected_unavailable_item_id_group_count
           << ",\"rejectedStaticItemCatalogGroupCount\":" << rejected_static_item_catalog_group_count
           << ",\"emittedEventCount\":" << events.size()
           << ",\"componentItemEventCount\":" << component_item_event_count
           << ",\"exactPacketFraming\":true,\"coverage\":\"strict-direct-add-only-subset-not-complete\""
           << ",\"generalPurchaseClassificationAvailable\":false"
           << ",\"slotAvailable\":false,\"itemInstanceAvailable\":false"
           << ",\"countOrChargesAvailable\":false,\"priceAvailable\":false"
           << ",\"goldStateAvailable\":false,\"inventoryStateAvailable\":false"
           << ",\"removedItemIdentityAvailable\":false,\"undoAvailable\":false}}";
    return output.str();
}

struct InventorySaleRelevantBlock {
    PacketBlock block;
    long long timestamp_millis = 0;
    int participant_id = 0;
    bool is_add_update = false;
    std::vector<std::uint8_t> payload;
};

[[nodiscard]] int inventory_sale_owner_to_participant_id(
    std::uint32_t owner,
    const InventorySaleSubsetDecoderProfile& profile
) {
    if (owner <= profile.champion_network_id_base) return 0;
    const std::uint32_t participant_id = owner - profile.champion_network_id_base;
    return participant_id <= 10 ? static_cast<int>(participant_id) : 0;
}

[[nodiscard]] bool inventory_sale_byte_is_allowed(
    std::uint8_t value,
    const std::vector<std::uint8_t>& allowed
) {
    return std::find(allowed.begin(), allowed.end(), value) != allowed.end();
}

void write_inventory_sale_removal_block_json(
    std::ostringstream& output,
    const InventorySaleRelevantBlock& relevant
) {
    output << "{\"family\":\"removal\",\"channel\":"
           << static_cast<unsigned int>(relevant.block.channel)
           << ",\"packetType\":" << relevant.block.packet_type
           << ",\"packetTypeHex\":\"" << fixed_hex(relevant.block.packet_type, 4) << "\""
           << ",\"contentLength\":" << relevant.block.content_length
           << ",\"blockParam\":" << relevant.block.block_param
           << ",\"blockParamHex\":\"" << fixed_hex(relevant.block.block_param, 8) << "\""
           << ",\"provenance\":";
    write_objective_block_provenance_json(output, relevant.block);
    output << '}';
}

[[nodiscard]] std::string extract_replay_item_sales_impl(
    const std::vector<std::uint8_t>& bytes,
    const KillSourceInfo& source,
    const DecoderProfileRegistry& decoder_profiles
) {
    const ReplaySummary summary = parse_replay_bytes(bytes, decoder_profiles);
    if (summary.game_version != "16.14.794.5912") {
        throw std::runtime_error(
            "Inventory sale subset decoder is restricted to exact build 16.14.794.5912."
        );
    }
    const DecoderVersionProfile* selected = find_decoder_profile(
        decoder_profiles, summary.game_version);
    if (selected == nullptr || !selected->inventory_sale_subset.has_value()) {
        throw std::runtime_error(
            "Unsupported replay version " + summary.game_version +
            ": external decoder registry has no inventory sale subset profile."
        );
    }
    const InventorySaleSubsetDecoderProfile& profile = *selected->inventory_sale_subset;

    std::map<std::pair<int, long long>, std::vector<InventorySaleRelevantBlock>> groups;
    std::size_t profiled_add_update_packet_count = 0;
    std::size_t profiled_removal_packet_count = 0;
    const PacketFileScan scan = scan_packet_segments(
        bytes,
        summary,
        profile.segment_type,
        [&](const ReplaySegmentSummary&,
            const std::vector<std::uint8_t>& decompressed,
            const PacketBlockParseResult& result) {
            for (const PacketBlock& block : result.blocks) {
                if (block.channel != profile.channel) continue;
                const bool is_add_update =
                    block.packet_type == profile.add.packet_type &&
                    inventory_purchase_length_is_profiled(
                        block.content_length, profile.add.content_lengths);
                const bool is_removal =
                    block.packet_type == profile.removal.packet_type &&
                    inventory_purchase_length_is_profiled(
                        block.content_length, profile.removal.content_lengths);
                if (!is_add_update && !is_removal) continue;
                const int participant_id = inventory_sale_owner_to_participant_id(
                    block.block_param, profile);
                if (participant_id == 0) continue;

                InventorySaleRelevantBlock relevant{
                    block,
                    packet_timestamp_millis(block.timestamp_seconds),
                    participant_id,
                    is_add_update,
                    {},
                };
                if (is_add_update) {
                    ++profiled_add_update_packet_count;
                } else {
                    ++profiled_removal_packet_count;
                    relevant.payload.assign(
                        decompressed.begin() + static_cast<std::ptrdiff_t>(block.content_offset),
                        decompressed.begin() + static_cast<std::ptrdiff_t>(block.end_offset)
                    );
                }
                groups[{participant_id, relevant.timestamp_millis}].push_back(
                    std::move(relevant));
            }
        }
    );
    if (scan.selected_segment_count == 0) {
        throw std::runtime_error("Replay contains no footer-style chunk records.");
    }
    if (scan.exact_segment_count != scan.selected_segment_count || !scan.errors.empty()) {
        const std::string detail = scan.errors.empty()
            ? "one or more chunks were not exactly consumed"
            : scan.errors.front().code + ": " + scan.errors.front().message;
        throw std::runtime_error("Replay chunk packet framing failed: " + detail);
    }

    struct EmittedEvent {
        long long timestamp_millis = 0;
        int participant_id = 0;
        InventorySaleRelevantBlock removal;
    };
    std::vector<EmittedEvent> events;
    std::size_t single_removal_no_add_group_count = 0;
    std::size_t rejected_group_shape_count = 0;
    std::size_t rejected_payload_predicate_group_count = 0;
    std::size_t rejected_unprofiled_sale_discriminator_group_count = 0;

    for (auto& [key, group] : groups) {
        std::stable_sort(group.begin(), group.end(), [](const auto& left, const auto& right) {
            if (left.block.provenance.segment_payload_offset !=
                right.block.provenance.segment_payload_offset) {
                return left.block.provenance.segment_payload_offset <
                    right.block.provenance.segment_payload_offset;
            }
            if (left.block.header_offset != right.block.header_offset) {
                return left.block.header_offset < right.block.header_offset;
            }
            return left.block.block_index < right.block.block_index;
        });
        const std::size_t add_update_count = static_cast<std::size_t>(std::count_if(
            group.begin(), group.end(), [](const auto& block) { return block.is_add_update; }));
        const std::size_t removal_count = group.size() - add_update_count;
        if (add_update_count != profile.required_add_update_count ||
            removal_count != profile.required_removal_count) {
            ++rejected_group_shape_count;
            continue;
        }
        ++single_removal_no_add_group_count;
        const auto removal = std::find_if(
            group.begin(), group.end(), [](const auto& block) { return !block.is_add_update; });
        if (removal == group.end()) {
            throw std::runtime_error(
                "Inventory sale profile invariant failed: accepted group has no removal block.");
        }
        const std::vector<std::uint8_t>& payload = removal->payload;
        if (payload.size() < 3 ||
            !inventory_sale_byte_is_allowed(
                static_cast<std::uint8_t>(payload[0] & 0x0FU),
                profile.payload0_low_nibble_values) ||
            (payload[2] & profile.payload2_low_bits_mask) ==
                profile.payload2_rejected_low_bits_value) {
            ++rejected_payload_predicate_group_count;
            continue;
        }
        if (!inventory_sale_byte_is_allowed(
                payload[2], profile.sale_payload_byte2_values)) {
            ++rejected_unprofiled_sale_discriminator_group_count;
            continue;
        }
        events.push_back({key.second, key.first, *removal});
    }

    std::sort(events.begin(), events.end(), [](const EmittedEvent& left, const EmittedEvent& right) {
        if (left.removal.block.provenance.segment_payload_offset !=
            right.removal.block.provenance.segment_payload_offset) {
            return left.removal.block.provenance.segment_payload_offset <
                right.removal.block.provenance.segment_payload_offset;
        }
        if (left.removal.block.header_offset != right.removal.block.header_offset) {
            return left.removal.block.header_offset < right.removal.block.header_offset;
        }
        return left.removal.block.block_index < right.removal.block.block_index;
    });

    std::ostringstream output;
    output << "{\"schema\":\"rofl-replay-item-sales/v1\",\"generatedAtUtc\":\""
           << current_utc_iso8601() << "\",\"source\":{\"replayPath\":";
    if (source.has_file) output << '"' << json_escape(source.replay_path) << '"';
    else output << "null";
    output << ",\"replayId\":";
    if (source.has_file) output << '"' << json_escape(source.replay_id) << '"';
    else output << "null";
    output << ",\"matchId\":";
    if (source.has_file) output << '"' << json_escape(source.match_id) << '"';
    else output << "null";
    output << ",\"runtimeInput\":\"rofl-only\",\"riotApiInput\":false}"
           << ",\"gameVersion\":\"" << json_escape(summary.game_version)
           << "\",\"versionGroup\":\"" << packet_version_group(summary.game_version)
           << "\",\"profile\":{\"segmentType\":\"" << json_escape(profile.segment_type)
           << "\",\"channel\":" << static_cast<unsigned int>(profile.channel)
           << ",\"championNetworkIdBase\":" << profile.champion_network_id_base
           << ",\"championNetworkIdBaseHex\":\""
           << fixed_hex(profile.champion_network_id_base, 8) << "\""
           << ",\"addUpdatePacketType\":" << profile.add.packet_type
           << ",\"addUpdatePacketTypeHex\":\"" << fixed_hex(profile.add.packet_type, 4)
           << "\",\"addUpdateContentLengths\":";
    write_size_array_json(output, profile.add.content_lengths);
    output << ",\"removalPacketType\":" << profile.removal.packet_type
           << ",\"removalPacketTypeHex\":\"" << fixed_hex(profile.removal.packet_type, 4)
           << "\",\"removalContentLengths\":";
    write_size_array_json(output, profile.removal.content_lengths);
    output << ",\"groupTimestampToleranceMillis\":"
           << profile.group_timestamp_tolerance_millis
           << ",\"requiredAddUpdateCount\":" << profile.required_add_update_count
           << ",\"requiredRemovalCount\":" << profile.required_removal_count
           << ",\"payload0LowNibbleValues\":[";
    for (std::size_t index = 0; index < profile.payload0_low_nibble_values.size(); ++index) {
        if (index > 0) output << ',';
        output << static_cast<unsigned int>(profile.payload0_low_nibble_values[index]);
    }
    output << "],\"payload2LowBitsMask\":"
           << static_cast<unsigned int>(profile.payload2_low_bits_mask)
           << ",\"payload2RejectedLowBitsValue\":"
           << static_cast<unsigned int>(profile.payload2_rejected_low_bits_value)
           << ",\"salePayloadByte2Values\":[";
    for (std::size_t index = 0; index < profile.sale_payload_byte2_values.size(); ++index) {
        if (index > 0) output << ',';
        output << static_cast<unsigned int>(profile.sale_payload_byte2_values[index]);
    }
    output << ']';
    write_decoder_profile_provenance_fields(output, &decoder_profiles);
    output << "},\"events\":[";
    for (std::size_t index = 0; index < events.size(); ++index) {
        if (index > 0) output << ',';
        const EmittedEvent& event = events[index];
        const std::uint32_t network_id = profile.champion_network_id_base +
            static_cast<std::uint32_t>(event.participant_id);
        output << "{\"type\":\"ITEM_SOLD_OPERATION\",\"timestampMillis\":"
               << event.timestamp_millis << ",\"participantId\":" << event.participant_id
               << ",\"participantNetworkId\":" << network_id
               << ",\"participantNetworkIdHex\":\"" << fixed_hex(network_id, 8)
               << "\",\"availability\":{\"soldItemId\":false,\"slot\":false,"
                  "\"itemInstance\":false,\"countOrCharges\":false,\"price\":false,"
                  "\"goldGain\":false,\"inventoryState\":false,\"undo\":false},"
                  "\"provenance\":{\"removalBlock\":";
        write_inventory_sale_removal_block_json(output, event.removal);
        output << "}}";
    }
    output << "],\"diagnostics\":{\"footerRecordCount\":"
           << summary.container.segments.size()
           << ",\"chunkRecordCount\":" << scan.selected_segment_count
           << ",\"decompressedChunkBytes\":" << scan.input_bytes
           << ",\"packetBlockCount\":" << scan.packet_count
           << ",\"profiledInventoryOperationPacketCount\":"
           << profiled_add_update_packet_count + profiled_removal_packet_count
           << ",\"profiledAddUpdatePacketCount\":" << profiled_add_update_packet_count
           << ",\"profiledRemovalPacketCount\":" << profiled_removal_packet_count
           << ",\"ownerTimestampGroupCount\":" << groups.size()
           << ",\"singleRemovalNoAddGroupCount\":" << single_removal_no_add_group_count
           << ",\"rejectedGroupShapeCount\":" << rejected_group_shape_count
           << ",\"rejectedPayloadPredicateGroupCount\":"
           << rejected_payload_predicate_group_count
           << ",\"rejectedUnprofiledSaleDiscriminatorGroupCount\":"
           << rejected_unprofiled_sale_discriminator_group_count
           << ",\"emittedEventCount\":" << events.size()
           << ",\"exactPacketFraming\":true,\"coverage\":\"exact-sale-operation-only\""
              ",\"soldItemIdAvailable\":false,\"slotAvailable\":false"
              ",\"itemInstanceAvailable\":false,\"countOrChargesAvailable\":false"
              ",\"priceAvailable\":false,\"goldGainAvailable\":false"
              ",\"inventoryStateAvailable\":false,\"undoAvailable\":false}}";
    return output.str();
}

struct ReplayParticipantStatSnapshot {
    long long timestamp_millis = 0;
    int participant_id = 0;
    float total_gold = 0.0F;
    float lane_minions_killed = 0.0F;
    PacketBlock block;
};

[[nodiscard]] bool keyframe_stat_profile_is_exact(
    const KeyframeParticipantStatsDecoderProfile& profile
) {
    return profile.segment_type == "keyframe" && profile.channel == 1 &&
           profile.packet_type == 0x02EB && profile.content_length == 1479 &&
           profile.champion_network_id_base == 1073741997;
}

[[nodiscard]] bool keyframe_stat_offsets_are_valid(
    const KeyframeParticipantStatsDecoderProfile& profile
) {
    const auto offsets_valid = [&](const std::array<std::size_t, 4>& offsets) {
        std::set<std::size_t> distinct;
        for (const std::size_t offset : offsets) {
            if (offset >= profile.content_length || !distinct.insert(offset).second) {
                return false;
            }
        }
        return true;
    };
    return offsets_valid(profile.total_gold_offsets) &&
           offsets_valid(profile.lane_minions_killed_offsets);
}

[[nodiscard]] bool keyframe_stat_cipher_is_bijective(
    const KeyframeParticipantStatsDecoderProfile& profile
) {
    std::array<bool, 256> seen{};
    for (const std::uint8_t plain : profile.cipher_to_plain) {
        if (seen[plain]) return false;
        seen[plain] = true;
    }
    return true;
}

[[nodiscard]] float decode_keyframe_stat_float32_le(
    const std::vector<std::uint8_t>& decompressed,
    const PacketBlock& block,
    const std::array<std::size_t, 4>& offsets,
    const KeyframeParticipantStatsDecoderProfile& profile
) {
    std::uint32_t bits = 0;
    for (std::size_t index = 0; index < offsets.size(); ++index) {
        const std::size_t payload_index = block.content_offset + offsets[index];
        if (payload_index >= decompressed.size() || payload_index >= block.end_offset) {
            throw std::runtime_error("Keyframe participant stats payload offset escaped packet bounds.");
        }
        bits |= static_cast<std::uint32_t>(
            profile.cipher_to_plain[decompressed[payload_index]]) << (index * 8U);
    }
    return std::bit_cast<float>(bits);
}

[[nodiscard]] int keyframe_stat_owner_to_participant_id(
    std::uint32_t owner,
    const KeyframeParticipantStatsDecoderProfile& profile
) {
    if (owner <= profile.champion_network_id_base) return 0;
    const std::uint32_t participant_id = owner - profile.champion_network_id_base;
    return participant_id <= 10 ? static_cast<int>(participant_id) : 0;
}

void write_participant_stat_snapshot_block_json(
    std::ostringstream& output,
    const PacketBlock& block
) {
    output << "{\"channel\":" << static_cast<unsigned int>(block.channel)
           << ",\"packetType\":" << block.packet_type
           << ",\"packetTypeHex\":\"" << fixed_hex(block.packet_type, 4) << "\""
           << ",\"contentLength\":" << block.content_length
           << ",\"blockParam\":" << block.block_param
           << ",\"blockParamHex\":\"" << fixed_hex(block.block_param, 8) << "\""
           << ",\"provenance\":";
    write_objective_block_provenance_json(output, block);
    output << '}';
}

[[nodiscard]] std::string extract_replay_participant_stat_snapshots_impl(
    const std::vector<std::uint8_t>& bytes,
    const KillSourceInfo& source,
    const DecoderProfileRegistry& decoder_profiles
) {
    const ReplaySummary summary = parse_replay_bytes(bytes, decoder_profiles);
    if (summary.game_version != "16.14.794.5912") {
        throw std::runtime_error(
            "Keyframe participant stats decoder is restricted to exact build 16.14.794.5912."
        );
    }
    const DecoderVersionProfile* selected = find_decoder_profile(
        decoder_profiles, summary.game_version);
    if (selected == nullptr || !selected->keyframe_participant_stats.has_value()) {
        throw std::runtime_error(
            "Unsupported replay version " + summary.game_version +
            ": external decoder registry has no keyframe participant stats profile."
        );
    }
    const KeyframeParticipantStatsDecoderProfile& profile =
        *selected->keyframe_participant_stats;
    if (!keyframe_stat_profile_is_exact(profile)) {
        throw std::runtime_error(
            "Keyframe participant stats profile must be keyframe/channel-1/0x02EB/content-length-1479."
        );
    }
    if (!keyframe_stat_offsets_are_valid(profile) || !keyframe_stat_cipher_is_bijective(profile)) {
        throw std::runtime_error(
            "Keyframe participant stats profile has invalid offsets or a non-bijective cipher table."
        );
    }

    std::vector<ReplayParticipantStatSnapshot> snapshots;
    std::size_t profiled_snapshot_packet_count = 0;
    std::size_t rejected_invalid_owner_packet_count = 0;
    std::size_t rejected_invalid_value_packet_count = 0;
    const PacketFileScan scan = scan_packet_segments(
        bytes,
        summary,
        profile.segment_type,
        [&](const ReplaySegmentSummary&, const std::vector<std::uint8_t>& decompressed,
            const PacketBlockParseResult& result) {
            for (const PacketBlock& block : result.blocks) {
                if (block.channel != profile.channel || block.packet_type != profile.packet_type ||
                    block.content_length != profile.content_length) {
                    continue;
                }
                ++profiled_snapshot_packet_count;
                const int participant_id = keyframe_stat_owner_to_participant_id(
                    block.block_param, profile);
                if (participant_id == 0) {
                    ++rejected_invalid_owner_packet_count;
                    continue;
                }
                const float total_gold = decode_keyframe_stat_float32_le(
                    decompressed, block, profile.total_gold_offsets, profile);
                const float lane_minions_killed = decode_keyframe_stat_float32_le(
                    decompressed, block, profile.lane_minions_killed_offsets, profile);
                const bool invalid_value = !std::isfinite(total_gold) || total_gold < 0.0F ||
                    !std::isfinite(lane_minions_killed) || lane_minions_killed < 0.0F ||
                    std::trunc(lane_minions_killed) != lane_minions_killed;
                if (invalid_value) {
                    ++rejected_invalid_value_packet_count;
                    continue;
                }
                snapshots.push_back({
                    packet_timestamp_millis(block.timestamp_seconds),
                    participant_id,
                    total_gold,
                    lane_minions_killed,
                    block,
                });
            }
        }
    );
    if (scan.selected_segment_count == 0) {
        throw std::runtime_error("Replay contains no footer-style keyframe records.");
    }
    if (scan.exact_segment_count != scan.selected_segment_count || !scan.errors.empty()) {
        const std::string detail = scan.errors.empty()
            ? "one or more keyframes were not exactly consumed"
            : scan.errors.front().code + ": " + scan.errors.front().message;
        throw std::runtime_error("Replay keyframe packet framing failed: " + detail);
    }
    std::sort(snapshots.begin(), snapshots.end(), [](const auto& left, const auto& right) {
        if (left.timestamp_millis != right.timestamp_millis) {
            return left.timestamp_millis < right.timestamp_millis;
        }
        if (left.participant_id != right.participant_id) {
            return left.participant_id < right.participant_id;
        }
        if (left.block.provenance.segment_id != right.block.provenance.segment_id) {
            return left.block.provenance.segment_id < right.block.provenance.segment_id;
        }
        if (left.block.provenance.segment_payload_offset !=
            right.block.provenance.segment_payload_offset) {
            return left.block.provenance.segment_payload_offset <
                right.block.provenance.segment_payload_offset;
        }
        if (left.block.header_offset != right.block.header_offset) {
            return left.block.header_offset < right.block.header_offset;
        }
        return left.block.block_index < right.block.block_index;
    });
    for (std::size_t index = 1; index < snapshots.size(); ++index) {
        const ReplayParticipantStatSnapshot& previous = snapshots[index - 1];
        const ReplayParticipantStatSnapshot& current = snapshots[index];
        if (current.timestamp_millis == previous.timestamp_millis &&
            current.participant_id == previous.participant_id) {
            throw std::runtime_error(
                "Keyframe participant stats decoder rejected duplicate participant snapshots at one timestamp."
            );
        }
    }
    std::array<std::optional<float>, 10> previous_gold;
    std::array<std::optional<float>, 10> previous_lane_minions;
    std::vector<ReplayParticipantStatSnapshot> monotonic_snapshots;
    monotonic_snapshots.reserve(snapshots.size());
    for (const ReplayParticipantStatSnapshot& snapshot : snapshots) {
        const std::size_t participant_index =
            static_cast<std::size_t>(snapshot.participant_id - 1);
        if ((previous_gold[participant_index].has_value() &&
                snapshot.total_gold < *previous_gold[participant_index]) ||
            (previous_lane_minions[participant_index].has_value() &&
                snapshot.lane_minions_killed < *previous_lane_minions[participant_index])) {
            ++rejected_invalid_value_packet_count;
            continue;
        }
        previous_gold[participant_index] = snapshot.total_gold;
        previous_lane_minions[participant_index] = snapshot.lane_minions_killed;
        monotonic_snapshots.push_back(snapshot);
    }
    snapshots = std::move(monotonic_snapshots);
    if (rejected_invalid_owner_packet_count != 0 || rejected_invalid_value_packet_count != 0) {
        throw std::runtime_error(
            "Keyframe participant stats decoder rejected invalid owner or value packets."
        );
    }
    std::size_t keyframe_group_count = 0;
    for (std::size_t start = 0; start < snapshots.size();) {
        const long long timestamp_millis = snapshots[start].timestamp_millis;
        if (keyframe_group_count > 0 &&
            timestamp_millis <= snapshots[start - 1].timestamp_millis) {
            throw std::runtime_error(
                "Keyframe participant stats decoder requires strictly increasing snapshot groups."
            );
        }
        for (int participant_id = 1; participant_id <= 10; ++participant_id) {
            const std::size_t index = start + static_cast<std::size_t>(participant_id - 1);
            if (index >= snapshots.size() || snapshots[index].timestamp_millis != timestamp_millis ||
                snapshots[index].participant_id != participant_id) {
                throw std::runtime_error(
                    "Keyframe participant stats decoder requires complete participant groups of 1 through 10."
                );
            }
        }
        start += 10;
        ++keyframe_group_count;
    }
    if (keyframe_group_count != scan.selected_segment_count) {
        throw std::runtime_error(
            "Keyframe participant stats decoder group count does not match keyframe segment count."
        );
    }

    std::ostringstream output;
    output << "{\"schema\":\"rofl-replay-participant-stat-snapshots/v1\",\"source\":{\"replayPath\":";
    if (source.has_file) output << '\"' << json_escape(source.replay_path) << '\"';
    else output << "null";
    output << ",\"replayId\":";
    if (source.has_file) output << '\"' << json_escape(source.replay_id) << '\"';
    else output << "null";
    output << ",\"matchId\":";
    if (source.has_file) output << '\"' << json_escape(source.match_id) << '\"';
    else output << "null";
    output << ",\"runtimeInput\":\"rofl-only\",\"riotApiInput\":false}"
           << ",\"gameVersion\":\"" << json_escape(summary.game_version)
           << "\",\"versionGroup\":\"" << packet_version_group(summary.game_version)
           << "\",\"profile\":{\"segmentType\":\"" << json_escape(profile.segment_type)
           << "\",\"channel\":" << static_cast<unsigned int>(profile.channel)
           << ",\"snapshotPacketType\":" << profile.packet_type
           << ",\"snapshotPacketTypeHex\":\"" << fixed_hex(profile.packet_type, 4)
           << "\",\"snapshotContentLength\":" << profile.content_length
           << ",\"championNetworkIdBase\":" << profile.champion_network_id_base
           << ",\"championNetworkIdBaseHex\":\""
           << fixed_hex(profile.champion_network_id_base, 8) << "\"";
    write_decoder_profile_provenance_fields(output, &decoder_profiles);
    output << "},\"snapshots\":[";
    for (std::size_t index = 0; index < snapshots.size(); ++index) {
        if (index > 0) output << ',';
        const ReplayParticipantStatSnapshot& snapshot = snapshots[index];
        output << "{\"timestampMillis\":" << snapshot.timestamp_millis
               << ",\"participantId\":" << snapshot.participant_id
               << ",\"totalGold\":" << std::setprecision(std::numeric_limits<float>::max_digits10)
               << snapshot.total_gold
               << ",\"laneMinionsKilled\":" << snapshot.lane_minions_killed
               << ",\"provenance\":{\"snapshotBlock\":";
        write_participant_stat_snapshot_block_json(output, snapshot.block);
        output << "}}";
    }
    const std::size_t keyframe_record_count = static_cast<std::size_t>(std::count_if(
        summary.container.segments.begin(), summary.container.segments.end(),
        [](const ReplaySegmentSummary& segment) { return segment.type == "keyframe"; }));
    output << "],\"diagnostics\":{\"keyframeRecordCount\":" << keyframe_record_count
           << ",\"keyframeSegmentCount\":" << scan.selected_segment_count
           << ",\"decompressedKeyframeBytes\":" << scan.input_bytes
           << ",\"packetBlockCount\":" << scan.packet_count
           << ",\"profiledSnapshotPacketCount\":" << profiled_snapshot_packet_count
           << ",\"rejectedInvalidOwnerPacketCount\":" << rejected_invalid_owner_packet_count
           << ",\"rejectedInvalidValuePacketCount\":" << rejected_invalid_value_packet_count
           << ",\"emittedSnapshotCount\":" << snapshots.size()
           << ",\"exactPacketFraming\":true,\"coverage\":\"profiled-keyframe-participant-stats-only\"}}";
    return output.str();
}

}  // namespace

std::string extract_replay_purchase_linked_item_updates_json(
    const std::vector<std::uint8_t>& bytes, const DecoderProfileRegistry& decoder_profiles
) {
    return extract_replay_purchase_linked_item_updates_impl(bytes, {}, decoder_profiles);
}

std::string extract_replay_purchase_linked_item_updates_file_json(
    const std::string& path, const DecoderProfileRegistry& decoder_profiles
) {
    std::error_code error;
    std::filesystem::path absolute = std::filesystem::absolute(path, error);
    if (error) absolute = std::filesystem::path(path);
    absolute = absolute.lexically_normal();
    KillSourceInfo source;
    source.has_file = true;
    source.replay_path = absolute.string();
    source.replay_id = absolute.stem().string();
    source.match_id = source.replay_id;
    const std::size_t separator = source.match_id.find('-');
    if (separator != std::string::npos) source.match_id[separator] = '_';
    return extract_replay_purchase_linked_item_updates_impl(read_file_bytes(source.replay_path), source, decoder_profiles);
}

std::string extract_replay_direct_item_purchases_json(
    const std::vector<std::uint8_t>& bytes,
    const DecoderProfileRegistry& decoder_profiles
) {
    return extract_replay_direct_item_purchases_impl(bytes, {}, decoder_profiles);
}

std::string extract_replay_direct_item_purchases_file_json(
    const std::string& path,
    const DecoderProfileRegistry& decoder_profiles
) {
    std::error_code error;
    std::filesystem::path absolute = std::filesystem::absolute(path, error);
    if (error) absolute = std::filesystem::path(path);
    absolute = absolute.lexically_normal();
    KillSourceInfo source;
    source.has_file = true;
    source.replay_path = absolute.string();
    source.replay_id = absolute.stem().string();
    source.match_id = source.replay_id;
    const std::size_t separator = source.match_id.find('-');
    if (separator != std::string::npos) source.match_id[separator] = '_';
    return extract_replay_direct_item_purchases_impl(
        read_file_bytes(source.replay_path), source, decoder_profiles);
}

std::string extract_replay_item_sales_json(
    const std::vector<std::uint8_t>& bytes,
    const DecoderProfileRegistry& decoder_profiles
) {
    return extract_replay_item_sales_impl(bytes, {}, decoder_profiles);
}

std::string extract_replay_item_sales_file_json(
    const std::string& path,
    const DecoderProfileRegistry& decoder_profiles
) {
    std::error_code error;
    std::filesystem::path absolute = std::filesystem::absolute(path, error);
    if (error) absolute = std::filesystem::path(path);
    absolute = absolute.lexically_normal();
    KillSourceInfo source;
    source.has_file = true;
    source.replay_path = absolute.string();
    source.replay_id = absolute.stem().string();
    source.match_id = source.replay_id;
    const std::size_t separator = source.match_id.find('-');
    if (separator != std::string::npos) source.match_id[separator] = '_';
    return extract_replay_item_sales_impl(
        read_file_bytes(source.replay_path), source, decoder_profiles);
}

std::string extract_replay_participant_stat_snapshots_json(
    const std::vector<std::uint8_t>& bytes,
    const DecoderProfileRegistry& decoder_profiles
) {
    return extract_replay_participant_stat_snapshots_impl(bytes, {}, decoder_profiles);
}

std::string extract_replay_participant_stat_snapshots_file_json(
    const std::string& path,
    const DecoderProfileRegistry& decoder_profiles
) {
    std::error_code error;
    std::filesystem::path absolute = std::filesystem::absolute(path, error);
    if (error) absolute = std::filesystem::path(path);
    absolute = absolute.lexically_normal();
    KillSourceInfo source;
    source.has_file = true;
    source.replay_path = absolute.string();
    source.replay_id = absolute.stem().string();
    source.match_id = source.replay_id;
    const std::size_t separator = source.match_id.find('-');
    if (separator != std::string::npos) source.match_id[separator] = '_';
    return extract_replay_participant_stat_snapshots_impl(
        read_file_bytes(source.replay_path), source, decoder_profiles);
}

std::string replay_summary_to_json(const ReplaySummary& summary) {
    std::ostringstream output;
    output << "{";
    output << "\"gameVersion\":\"" << json_escape(summary.game_version) << "\",";
    output << "\"fileSize\":" << summary.file_size << ",";
    output << "\"gameLengthMillis\":" << summary.game_length_millis << ",";
    output << "\"lastGameChunkId\":" << summary.last_game_chunk_id << ",";
    output << "\"lastKeyFrameId\":" << summary.last_keyframe_id << ",";
    output << "\"playerCount\":" << summary.players.size() << ",";

    output << "\"container\":{";
    output << "\"format\":\"" << json_escape(summary.container.format) << "\",";
    output << "\"metadataSource\":\"" << json_escape(summary.container.metadata_source) << "\",";
    output << "\"metadataOffset\":" << summary.container.metadata_offset << ",";
    output << "\"metadataSize\":" << summary.container.metadata_size << ",";
    output << "\"payloadHeaderOffset\":" << summary.container.payload_header_offset << ",";
    output << "\"payloadHeaderSize\":" << summary.container.payload_header_size << ",";
    output << "\"payloadOffset\":" << summary.container.payload_offset << ",";
    output << "\"matchId\":" << summary.container.match_id << ",";
    output << "\"keyframeCount\":" << summary.container.keyframe_count << ",";
    output << "\"chunkCount\":" << summary.container.chunk_count << ",";
    output << "\"startupChunkEndId\":" << summary.container.startup_chunk_end_id << ",";
    output << "\"gameStartChunkId\":" << summary.container.game_start_chunk_id << ",";
    output << "\"keyframeIntervalMillis\":" << summary.container.keyframe_interval_millis << ",";
    output << "\"binaryHeaderPresent\":" << bool_to_json(summary.container.binary_header_present) << ",";
    output << "\"payloadHeaderPresent\":" << bool_to_json(summary.container.payload_header_present) << ",";
    output << "\"segmentTablePresent\":" << bool_to_json(summary.container.segment_table_present) << ",";
    output << "\"segments\":[";
    for (std::size_t index = 0; index < summary.container.segments.size(); ++index) {
        const ReplaySegmentSummary& segment = summary.container.segments[index];
        if (index > 0) {
            output << ',';
        }

        output << '{';
        output << "\"id\":" << segment.id << ',';
        output << "\"type\":\"" << json_escape(segment.type) << "\",";
        output << "\"length\":" << segment.length << ',';
        output << "\"chunkId\":" << segment.chunk_id << ',';
        output << "\"offset\":" << segment.offset << ',';
        output << "\"headerOffset\":" << segment.header_offset << ',';
        output << "\"payloadOffset\":" << segment.payload_offset << ',';
        output << "\"uncompressedLength\":" << segment.uncompressed_length << ',';
        output << "\"codec\":\"" << json_escape(segment.codec) << "\"";
        output << '}';
    }
    output << "]},";

    output << "\"capabilities\":{";
    output << "\"metadataAvailable\":" << bool_to_json(summary.capabilities.metadata_available) << ',';
    output << "\"playerStatsAvailable\":" << bool_to_json(summary.capabilities.player_stats_available) << ',';
    output << "\"validatedFinalPlayerStatsAvailable\":"
           << bool_to_json(summary.capabilities.validated_final_player_stats_available) << ',';
    output << "\"binaryHeaderAvailable\":" << bool_to_json(summary.capabilities.binary_header_available) << ',';
    output << "\"payloadHeaderAvailable\":" << bool_to_json(summary.capabilities.payload_header_available) << ',';
    output << "\"segmentTableAvailable\":" << bool_to_json(summary.capabilities.segment_table_available) << ',';
    output << "\"payloadDecodingAvailable\":" << bool_to_json(summary.capabilities.payload_decoding_available) << ',';
    output << "\"movementTimelineAvailable\":" << bool_to_json(summary.capabilities.movement_timeline_available);
    output << "},";

    output << "\"decoderProfile\":{";
    output << "\"origin\":\"" << json_escape(summary.decoder_profile.origin) << "\",";
    output << "\"matched\":" << bool_to_json(summary.decoder_profile.matched) << ',';
    output << "\"schema\":\"" << json_escape(summary.decoder_profile.schema) << "\",";
    output << "\"registryId\":\"" << json_escape(summary.decoder_profile.registry_id) << "\",";
    output << "\"revision\":\"" << json_escape(summary.decoder_profile.revision) << "\",";
    output << "\"fingerprint\":\"" << json_escape(summary.decoder_profile.fingerprint) << "\",";
    output << "\"versionGroup\":\"" << json_escape(summary.decoder_profile.version_group) << "\"";
    output << "},";

    output << "\"warnings\":[";
    for (std::size_t index = 0; index < summary.warnings.size(); ++index) {
        if (index > 0) {
            output << ',';
        }
        output << '"' << json_escape(summary.warnings[index]) << '"';
    }
    output << "],";

    output << "\"players\":[";
    for (std::size_t index = 0; index < summary.players.size(); ++index) {
        const PlayerSummary& player = summary.players[index];
        if (index > 0) {
            output << ',';
        }

        output << '{';
        output << "\"champion\":\"" << json_escape(player.champion) << "\",";
        output << "\"riotIdGameName\":\"" << json_escape(player.riot_id_game_name) << "\",";
        output << "\"riotIdTagLine\":\"" << json_escape(player.riot_id_tag_line) << "\",";
        output << "\"teamPosition\":\"" << json_escape(player.team_position) << "\",";
        output << "\"win\":\"" << json_escape(player.win) << "\",";
        output << "\"team\":" << player.team << ',';
        output << "\"kills\":" << player.kills << ',';
        output << "\"deaths\":" << player.deaths << ',';
        output << "\"assists\":" << player.assists << ',';
        output << "\"goldEarned\":" << player.gold_earned << ',';
        output << "\"totalDamageToChampions\":" << player.total_damage_to_champions << ',';
        output << "\"visionScore\":" << player.vision_score << ',';
        output << "\"level\":" << player.level << ',';
        output << "\"experience\":" << player.experience << ',';
        output << "\"laneMinionsKilled\":" << player.lane_minions_killed << ',';
        output << "\"neutralMinionsKilled\":" << player.neutral_minions_killed << ',';
        output << "\"items\":[";
        for (std::size_t item_index = 0; item_index < player.items.size(); ++item_index) {
            if (item_index > 0) output << ',';
            output << player.items[item_index];
        }
        output << "],";
        output << "\"wardsPlaced\":" << player.wards_placed << ',';
        output << "\"wardsKilled\":" << player.wards_killed;
        output << '}';
    }
    output << "],";

    output << "\"metadataJson\":\"" << json_escape(summary.metadata_json) << "\"";
    output << '}';
    return output.str();
}

struct ExtractedSubrecord {
    int segment_id = 0;
    int chunk_id = 0;
    std::string segment_type;
    std::size_t chunk_offset = 0;
    std::vector<std::uint8_t> payload;
};

[[nodiscard]] std::string bytes_to_hex(const std::vector<std::uint8_t>& bytes);

struct KeyframeStateFieldSchema {
    std::string_view version_group;
    std::string_view family_key;
    std::size_t length = 0;
    std::uint8_t first_byte = 0;
    std::size_t header_size = 0;
    std::size_t stride = 16;
    std::size_t slot_index = 0;
    std::string_view metric;
    std::size_t offset = 0;
    std::size_t width = 0;
    std::string_view decode_label;
    double avg_score = 0.0;
    std::size_t support_replay_count = 0;
    double slope = 0.0;
    double intercept = 0.0;
    bool has_calibration = false;
};

struct KeyframeStateSchemaVersion {
    std::string_view schema_id;
    std::string_view generated_from;
    std::string_view note;
    std::vector<KeyframeStateFieldSchema> fields;
};

[[nodiscard]] std::string keyframe_schema_version_group(std::string_view version) {
    std::size_t first_dot = version.find('.');
    if (first_dot == std::string_view::npos) {
        return version.empty() ? std::string("unknown") : std::string(version);
    }
    std::size_t second_dot = version.find('.', first_dot + 1);
    if (second_dot == std::string_view::npos) {
        return std::string(version);
    }
    return std::string(version.substr(0, second_dot));
}

[[nodiscard]] KeyframeStateSchemaVersion keyframe_state_schema_v1() {
    return {
        "keyframe-state-schema.v1",
        "artifacts-keyframes/keyframe-parity-schema.json generated from the 47-replay corpus on 2026-05-06",
        "Promoted metric fields are API-supervised parity candidates. Participant identity and calibration are not solved in core yet.",
        {
            {"16.9", "24672-0x60-h16", 24672, 0x60, 16, 16, 86, "movementSpeed", 1, 4, "f32", 0.789, 4},
            {"16.9", "24672-0x60-h16", 24672, 0x60, 16, 16, 90, "movementSpeed", 11, 4, "f32", 0.813, 3},
            {"16.9", "24672-0x60-h16", 24672, 0x60, 16, 16, 91, "movementSpeed", 0, 4, "f32", 0.836, 2},
            {"16.9", "24672-0x60-h16", 24672, 0x60, 16, 16, 91, "movementSpeed", 4, 4, "f32", 0.830, 2},
            {"16.9", "24672-0x60-h16", 24672, 0x60, 16, 16, 94, "minionsKilled", 11, 4, "f32", 0.826, 2},
            {"16.9", "24672-0x60-h16", 24672, 0x60, 16, 16, 84, "movementSpeed", 1, 4, "f32", 0.826, 2},
            {"16.9", "24672-0x60-h16", 24672, 0x60, 16, 16, 84, "movementSpeed", 4, 4, "f32", 0.817, 2},
            {"16.9", "24672-0x60-h16", 24672, 0x60, 16, 16, 98, "movementSpeed", 3, 4, "f32", 0.812, 2},
            {"16.9", "24672-0x60-h16", 24672, 0x60, 16, 16, 102, "movementSpeed", 1, 4, "f32", 0.810, 2},
            {"16.9", "24672-0x60-h16", 24672, 0x60, 16, 16, 83, "movementSpeed", 1, 4, "f32", 0.809, 2},
            {"16.9", "24672-0x60-h16", 24672, 0x60, 16, 16, 83, "movementSpeed", 9, 4, "f32", 0.806, 2},
            {"16.9", "24672-0x60-h16", 24672, 0x60, 16, 16, 93, "movementSpeed", 6, 4, "f32", 0.805, 2},
            {"16.9", "24672-0x60-h16", 24672, 0x60, 16, 16, 490, "movementSpeed", 7, 4, "f32", 0.801, 2},
            {"16.9", "24672-0x60-h16", 24672, 0x60, 16, 16, 90, "movementSpeed", 5, 4, "f32", 0.785, 2},
            {"16.9", "24672-0x60-h16", 24672, 0x60, 16, 16, 89, "currentGold", 4, 4, "u32", 0.783, 2},
            {"16.9", "24672-0x60-h16", 24672, 0x60, 16, 16, 90, "currentGold", 7, 4, "i32", 0.772, 2},
            {"16.9", "24672-0x60-h16", 24672, 0x60, 16, 16, 86, "movementSpeed", 5, 4, "f32", 0.770, 2},
            {"16.9", "24672-0x60-h16", 24672, 0x60, 16, 16, 96, "health", 12, 2, "u16", 0.753, 2},
            {"16.9", "24672-0x60-h16", 24672, 0x60, 16, 16, 96, "health", 10, 4, "u32", 0.753, 2},
            {"16.9", "24672-0x60-h16", 24672, 0x60, 16, 16, 84, "currentGold", 14, 2, "u16", 0.729, 2},
            {"16.9", "24672-0x60-h16", 24672, 0x60, 16, 16, 84, "currentGold", 12, 4, "u32", 0.729, 2},
            {"16.9", "24672-0x60-h16", 24672, 0x60, 16, 16, 84, "currentGold", 10, 4, "f32", 0.718, 2},
        },
    };
}

[[nodiscard]] std::vector<ExtractedSubrecord> extract_subrecord_family(
    const std::vector<std::uint8_t>& bytes,
    const ReplaySummary& summary,
    std::size_t target_length,
    std::uint8_t target_first_byte,
    std::string_view target_segment_type = "chunk"
) {
    std::vector<ExtractedSubrecord> results;
    const std::string segment_filter = normalize_segment_type_filter(target_segment_type);

    for (const ReplaySegmentSummary& segment : summary.container.segments) {
        if (segment.codec != "zstd" || !segment_type_matches_filter(segment.type, segment_filter)) continue;

        std::vector<std::uint8_t> decompressed;
        std::string error;
        if (try_decompress_zstd_segment(bytes, segment, decompressed, error)) {
            const auto framing = choose_best_le_length_prefix(decompressed);
            if (framing.record_count >= 2) {
                auto records = extract_le_framed_subrecords(decompressed, framing.width, framing.start_offset, 1000000);
                for (const auto& rec : records) {
                    if (rec.length == target_length && decompressed[rec.payload_offset] == target_first_byte) {
                        ExtractedSubrecord extracted;
                        extracted.segment_id = segment.id;
                        extracted.chunk_id = segment.chunk_id;
                        extracted.segment_type = segment.type;
                        extracted.chunk_offset = rec.payload_offset;
                        extracted.payload.assign(
                            decompressed.begin() + static_cast<std::ptrdiff_t>(rec.payload_offset),
                            decompressed.begin() + static_cast<std::ptrdiff_t>(rec.payload_offset + target_length)
                        );
                        results.push_back(std::move(extracted));
                    }
                }
            }
        }
    }

    return results;
}

[[nodiscard]] int subrecord_api_frame_index(const ExtractedSubrecord& record) {
    if (record.segment_type == "keyframe" && record.segment_id > 0) {
        return record.segment_id - 1;
    }
    return -1;
}

[[nodiscard]] int subrecord_sample_timestamp_millis(
    const ExtractedSubrecord& record,
    const ReplaySummary& summary,
    std::size_t record_index,
    std::size_t max_record_index
) {
    const int api_frame_index = subrecord_api_frame_index(record);
    if (api_frame_index >= 0) {
        return api_frame_index * 60000;
    }

    if (summary.game_length_millis > 0) {
        return static_cast<int>(std::llround(
            (static_cast<double>(summary.game_length_millis) * static_cast<double>(record_index)) /
            static_cast<double>(max_record_index)
        ));
    }

    return static_cast<int>(record_index * 1000);
}

std::string dump_chunk_subrecords(const std::string& path, int chunk_id) {
    std::ostringstream output;
    const std::vector<std::uint8_t> bytes = read_file_bytes(path);
    const ReplaySummary summary = parse_replay_bytes(bytes);

    const auto it = std::find_if(summary.container.segments.begin(), summary.container.segments.end(), [&](const ReplaySegmentSummary& s) {
        return s.type == "chunk" && s.chunk_id == chunk_id;
    });

    if (it == summary.container.segments.end()) {
        throw std::runtime_error("Chunk ID " + std::to_string(chunk_id) + " not found in replay.");
    }

    const ReplaySegmentSummary& segment = *it;
    std::vector<std::uint8_t> decompressed;
    std::string error;
    if (!try_decompress_zstd_segment(bytes, segment, decompressed, error)) {
        throw std::runtime_error("Failed to decompress chunk: " + error);
    }

    const auto best_u16 = analyze_le_length_prefix(decompressed, 2);
    if (best_u16.record_count < 2) {
        output << "No LE-u16 framed subrecords found in chunk " << chunk_id << ".\n";
        return output.str();
    }

    auto records = extract_le_framed_subrecords(decompressed, 2, best_u16.start_offset, 1000000);
    output << "Found " << records.size() << " subrecords in chunk " << chunk_id << " (decompressed size=" << decompressed.size() << " bytes)\n\n";

    for (std::size_t i = 0; i < records.size(); ++i) {
        const auto& rec = records[i];
        if (rec.length == 0) continue;
        
        std::vector<std::uint8_t> payload(
            decompressed.begin() + static_cast<std::ptrdiff_t>(rec.payload_offset),
            decompressed.begin() + static_cast<std::ptrdiff_t>(rec.payload_offset + rec.length)
        );

        output << "Subrecord #" << i + 1 << " (offset=" << rec.payload_offset << ", length=" << rec.length << ")\n";
        output << "  Hex: " << format_hex_preview(payload, 128) << "\n";
        output << "  Ascii: \"" << format_ascii_preview(payload, 128) << "\"\n\n";
    }

    return output.str();
}

std::string summarize_subrecord_families(
    const std::string& path,
    std::size_t minimum_length,
    std::size_t minimum_records,
    std::size_t top_families
) {
    struct FamilyAggregate {
        std::size_t length = 0;
        std::uint8_t first_byte = 0;
        std::size_t record_count = 0;
        std::set<int> chunk_ids;
    };

    std::ostringstream output;
    const std::vector<std::uint8_t> bytes = read_file_bytes(path);
    const ReplaySummary summary = parse_replay_bytes(bytes);
    std::map<std::pair<std::size_t, std::uint8_t>, FamilyAggregate> families;
    std::size_t chunk_count = 0;

    for (const ReplaySegmentSummary& segment : summary.container.segments) {
        if (segment.codec != "zstd" || segment.type != "chunk") {
            continue;
        }

        std::vector<std::uint8_t> decompressed;
        std::string error;
        if (!try_decompress_zstd_segment(bytes, segment, decompressed, error)) {
            continue;
        }

        const auto framing = choose_best_le_length_prefix(decompressed);
        if (framing.record_count < 2) {
            continue;
        }

        const auto records = extract_le_framed_subrecords(decompressed, framing.width, framing.start_offset, 1000000);
        if (records.empty()) {
            continue;
        }

        chunk_count += 1;
        for (const FramedSubrecord& record : records) {
            if (record.length < minimum_length || record.payload_offset >= decompressed.size()) {
                continue;
            }

            const auto key = std::make_pair(record.length, decompressed[record.payload_offset]);
            auto& aggregate = families[key];
            aggregate.length = record.length;
            aggregate.first_byte = decompressed[record.payload_offset];
            aggregate.record_count += 1;
            aggregate.chunk_ids.insert(segment.chunk_id);
        }
    }

    std::vector<FamilyAggregate> ranked;
    ranked.reserve(families.size());
    for (const auto& entry : families) {
        if (entry.second.record_count >= minimum_records) {
            ranked.push_back(entry.second);
        }
    }

    std::sort(ranked.begin(), ranked.end(), [](const FamilyAggregate& left, const FamilyAggregate& right) {
        if (left.chunk_ids.size() != right.chunk_ids.size()) {
            return left.chunk_ids.size() > right.chunk_ids.size();
        }
        if (left.record_count != right.record_count) {
            return left.record_count > right.record_count;
        }
        if (left.length != right.length) {
            return left.length > right.length;
        }
        return left.first_byte < right.first_byte;
    });

    output << "Recurring subrecord families\n\n";
    output << "Replay chunks scanned: " << chunk_count << "\n";
    output << "Minimum length filter: " << minimum_length << "\n";
    output << "Minimum records filter: " << minimum_records << "\n";
    output << "Matching families: " << ranked.size() << "\n\n";

    if (ranked.empty()) {
        output << "No recurring families met the filters.\n";
        return output.str();
    }

    if (top_families == 0) {
        top_families = 20;
    }
    const std::size_t shown = std::min<std::size_t>(top_families, ranked.size());
    for (std::size_t index = 0; index < shown; ++index) {
        const FamilyAggregate& family = ranked[index];
        output << "#" << index + 1
               << " | len=" << family.length
               << " | first=0x" << std::hex << std::uppercase << std::setw(2) << std::setfill('0') << static_cast<int>(family.first_byte)
               << std::dec << std::nouppercase << std::setfill(' ')
               << " | records=" << family.record_count
               << " | chunks=" << family.chunk_ids.size();
        if (!family.chunk_ids.empty()) {
            output << " | span=" << *family.chunk_ids.begin() << '-' << *family.chunk_ids.rbegin();
        }

        std::vector<std::string> stride_candidates;
        for (std::size_t header_size = 0; header_size <= 8; ++header_size) {
            if (family.length > header_size && ((family.length - header_size) % 16) == 0) {
                std::ostringstream label;
                label << 'h' << header_size << "=" << ((family.length - header_size) / 16);
                stride_candidates.push_back(label.str());
            }
        }
        if (!stride_candidates.empty()) {
            output << " | stride16=";
            for (std::size_t candidate_index = 0; candidate_index < stride_candidates.size(); ++candidate_index) {
                if (candidate_index > 0) {
                    output << ',';
                }
                output << stride_candidates[candidate_index];
            }
        }
        output << '\n';
    }

    output << "\nInterpretation note:\n";
    output << "  Families that recur across many chunks and partition cleanly into 16-byte elements after a tiny header are the best world-state candidates.\n";
    output << "  Families that only appear once or a handful of times are more likely chunk-local deltas, metadata, or event packets.\n";
    return output.str();
}

std::string dump_subrecord_family(const std::string& path, std::size_t target_length, std::uint8_t target_first_byte) {
    std::ostringstream output;
    const std::vector<std::uint8_t> bytes = read_file_bytes(path);
    const ReplaySummary summary = parse_replay_bytes(bytes);
    
    auto records = extract_subrecord_family(bytes, summary, target_length, target_first_byte);
    output << "Found " << records.size() << " records of size " << target_length 
           << " starting with 0x" << std::hex << std::uppercase << std::setw(2) << std::setfill('0') << static_cast<int>(target_first_byte) << std::dec << "\n\n";

    for (std::size_t i = 0; i < records.size(); ++i) {
        output << "Record #" << i + 1 << " (chunkId=" << records[i].chunk_id << ", offset=" << records[i].chunk_offset << ")\n";
        output << "  Hex: " << format_hex_preview(records[i].payload, 64) << "\n";
        output << "  Ascii: \"" << format_ascii_preview(records[i].payload, 64) << "\"\n\n";
    }

    return output.str();
}

std::string dump_subrecord_family_json(
    const std::string& path,
    std::size_t target_length,
    std::uint8_t target_first_byte,
    std::string_view segment_type,
    std::size_t max_records
) {
    std::ostringstream output;
    const std::vector<std::uint8_t> bytes = read_file_bytes(path);
    const ReplaySummary summary = parse_replay_bytes(bytes);

    auto records = extract_subrecord_family(bytes, summary, target_length, target_first_byte, segment_type);
    if (max_records > 0 && records.size() > max_records) {
        records.resize(max_records);
    }

    output << '{';
    output << "\"segmentType\":\"" << json_escape(std::string(segment_type)) << "\",";
    output << "\"length\":" << target_length << ',';
    output << "\"firstByte\":" << static_cast<int>(target_first_byte) << ',';
    output << "\"recordCount\":" << records.size() << ',';
    output << "\"records\":[";
    for (std::size_t index = 0; index < records.size(); ++index) {
        if (index > 0) {
            output << ',';
        }
        const auto& record = records[index];
        output << '{';
        output << "\"segmentId\":" << record.segment_id << ',';
        output << "\"segmentType\":\"" << json_escape(record.segment_type) << "\",";
        output << "\"chunkId\":" << record.chunk_id << ',';
        output << "\"offset\":" << record.chunk_offset << ',';
        output << "\"length\":" << record.payload.size() << ',';
        output << "\"hex\":\"" << bytes_to_hex(record.payload) << "\"";
        output << '}';
    }
    output << "]}";
    return output.str();
}

std::string compare_subrecord_family(const std::string& path, std::size_t target_length, std::uint8_t target_first_byte, std::size_t prefix_bytes) {
    std::ostringstream output;
    const std::vector<std::uint8_t> bytes = read_file_bytes(path);
    const ReplaySummary summary = parse_replay_bytes(bytes);
    
    auto records = extract_subrecord_family(bytes, summary, target_length, target_first_byte);
    output << "Comparing " << records.size() << " records of size " << target_length 
           << " starting with 0x" << std::hex << std::uppercase << std::setw(2) << std::setfill('0') << static_cast<int>(target_first_byte) << std::dec << "\n\n";

    if (records.empty()) return output.str();

    std::size_t compare_len = std::min<std::size_t>(target_length, prefix_bytes);
    
    output << "Stability Map (len=" << compare_len << "):\n";
    output << ". = constant, * = low variance, X = high variance\n\n";

    std::string stability_map;
    stability_map.reserve(compare_len);

    for (std::size_t offset = 0; offset < compare_len; ++offset) {
        std::vector<std::uint8_t> seen;
        for (std::size_t i = 0; i < records.size(); ++i) {
            std::uint8_t v = records[i].payload[offset];
            if (std::find(seen.begin(), seen.end(), v) == seen.end()) {
                seen.push_back(v);
            }
        }
        
        if (seen.size() == 1) {
            stability_map += '.';
        } else if (seen.size() <= 3) {
            stability_map += '*';
        } else {
            stability_map += 'X';
        }
    }
    
    for (std::size_t i = 0; i < stability_map.size(); i += 32) {
        std::string chunk = stability_map.substr(i, 32);
        output << std::setw(4) << std::setfill('0') << i << " | " << chunk << "\n";
    }
    
    output << "\nU32 Columns (first " << std::min<std::size_t>(compare_len / 4, 16) << " fields, across up to 10 records):\n";
    std::size_t u32_count = std::min<std::size_t>(compare_len / 4, 16);
    
    for (std::size_t i = 0; i < std::min<std::size_t>(records.size(), 10); ++i) {
        output << "Rec #" << std::setw(2) << std::setfill('0') << i << " | ";
        for (std::size_t f = 0; f < u32_count; ++f) {
            std::uint32_t val = 0;
            const bool has_u32 = read_u32_le(records[i].payload, f * 4, val);
            if (!has_u32) {
                continue;
            }
            output << std::setw(11) << std::setfill(' ') << val << " ";
        }
        output << "\n";
    }

    return output.str();
}

std::string guess_stride(const std::string& path, std::size_t target_length, std::uint8_t target_first_byte, std::size_t header_size) {
    std::ostringstream output;
    const std::vector<std::uint8_t> bytes = read_file_bytes(path);
    const ReplaySummary summary = parse_replay_bytes(bytes);
    const std::uint8_t padding_byte = static_cast<std::uint8_t>(target_length & 0xFFu);

    auto records = extract_subrecord_family(bytes, summary, target_length, target_first_byte);
    output << "Guessing stride for " << records.size() << " records of size " << target_length
           << " starting with 0x" << std::hex << std::uppercase << std::setw(2) << std::setfill('0') << static_cast<int>(target_first_byte) << std::dec
           << " (header_size=" << header_size << ")\n\n";

    output << "Derived padding byte from length: 0x" << std::hex << std::uppercase << std::setw(2)
           << std::setfill('0') << static_cast<int>(padding_byte) << std::dec;
    if (padding_byte != target_first_byte) {
        output << " (selection byte differs from padding byte)";
    }
    output << "\n\n";

    if (records.empty()) {
        return output.str();
    }
    if (header_size >= target_length) {
        output << "Header size must be smaller than the target record length.\n";
        return output.str();
    }

    std::size_t total_non_padding = 0;
    std::size_t min_non_padding = target_length;
    std::size_t max_non_padding = 0;
    std::vector<std::size_t> non_padding_offsets;
    for (const auto& rec : records) {
        std::size_t rec_non_padding = 0;
        for (std::size_t offset = header_size; offset < rec.payload.size(); ++offset) {
            if (rec.payload[offset] != padding_byte) {
                non_padding_offsets.push_back(offset);
                rec_non_padding++;
            }
        }
        total_non_padding += rec_non_padding;
        min_non_padding = std::min(min_non_padding, rec_non_padding);
        max_non_padding = std::max(max_non_padding, rec_non_padding);
    }

    output << "Density Analysis (after header, padding=0x" << std::hex << std::uppercase << std::setw(2) << std::setfill('0') << static_cast<int>(padding_byte) << std::dec << "):\n";
    output << "  Average: " << (total_non_padding / records.size()) << " (" << format_percentage(total_non_padding / records.size(), target_length - header_size) << ")\n";
    output << "  Min:     " << min_non_padding << " (" << format_percentage(min_non_padding, target_length - header_size) << ")\n";
    output << "  Max:     " << max_non_padding << " (" << format_percentage(max_non_padding, target_length - header_size) << ")\n\n";

    for (std::size_t stride : {8, 16}) {
        const std::size_t num_elements = (target_length - header_size) / stride;
        const std::size_t total_elements = num_elements * records.size();
        std::size_t active_elements = 0;
        std::size_t fully_active_elements = 0;
        std::size_t partially_active_elements = 0;

        for (const auto& rec : records) {
            for (std::size_t i = 0; i < num_elements; ++i) {
                const std::size_t start = header_size + (i * stride);
                std::size_t non_padding_count = 0;
                for (std::size_t j = 0; j < stride; ++j) {
                    if (rec.payload[start + j] != padding_byte) {
                        non_padding_count++;
                    }
                }

                if (non_padding_count > 0) {
                    active_elements++;
                    if (non_padding_count == stride) {
                        fully_active_elements++;
                    } else {
                        partially_active_elements++;
                    }
                }
            }
        }

        output << "Element Analysis (stride " << stride << "):\n";
        output << "  Total Elements:    " << total_elements << "\n";
        output << "  Active Elements:   " << active_elements << " (" << format_percentage(active_elements, total_elements) << ")\n";
        output << "  Fully Active:      " << fully_active_elements << " (" << format_percentage(fully_active_elements, active_elements) << " of active)\n";
        output << "  Partially Active:  " << partially_active_elements << " (" << format_percentage(partially_active_elements, active_elements) << " of active)\n\n";
    }

    std::map<std::uint8_t, std::size_t> freq;
    for (const auto& rec : records) {
        for (std::uint8_t b : rec.payload) {
            freq[b]++;
        }
    }
    std::vector<std::pair<std::uint8_t, std::size_t>> sorted_freq(freq.begin(), freq.end());
    std::sort(sorted_freq.begin(), sorted_freq.end(), [](const auto& a, const auto& b) {
        return a.second > b.second;
    });

    output << "Top 10 Byte Frequencies:\n";
    for (std::size_t i = 0; i < 10 && i < sorted_freq.size(); ++i) {
        output << "  0x" << std::hex << std::uppercase << std::setw(2) << std::setfill('0') << static_cast<int>(sorted_freq[i].first) << std::dec
               << ": " << sorted_freq[i].second << " (" << format_percentage(sorted_freq[i].second, records.size() * target_length) << ")\n";
    }
    output << "\n";

    const std::size_t stab_stride = 16;
    const std::size_t num_elements_16 = (target_length - header_size) / stab_stride;
    output << "Element Stability (stride 16, first 64 elements):\n";
    for (std::size_t i = 0; i < 64 && i < num_elements_16; ++i) {
        std::map<std::uint32_t, std::size_t> first_u32_freq;
        std::size_t active_count = 0;
        for (const auto& rec : records) {
            const std::size_t start = header_size + (i * stab_stride);
            bool active = false;
            for (std::size_t j = 0; j < stab_stride; ++j) {
                if (rec.payload[start + j] != padding_byte) {
                    active = true;
                    break;
                }
            }
            if (active) {
                std::uint32_t val = 0;
                const bool has_u32 = read_u32_le(rec.payload, start, val);
                if (!has_u32) {
                    continue;
                }
                active_count++;
                first_u32_freq[val]++;
            }
        }
        if (active_count > 0) {
            output << "  Elem #" << std::setw(2) << i << " | Active: " << std::setw(3) << active_count
                   << " | Top U32: ";
            std::vector<std::pair<std::uint32_t, std::size_t>> sorted_u32(first_u32_freq.begin(), first_u32_freq.end());
            std::sort(sorted_u32.begin(), sorted_u32.end(), [](const auto& a, const auto& b) {
                return a.second > b.second;
            });
            for (std::size_t k = 0; k < 2 && k < sorted_u32.size(); ++k) {
                output << "0x" << std::hex << std::uppercase << std::setw(8) << std::setfill('0') << sorted_u32[k].first << std::dec
                       << " (" << sorted_u32[k].second << ") ";
            }
            output << "\n";
        }
    }
    output << "\n";

    std::map<std::uint8_t, std::size_t> first_byte_freq_off0;
    std::map<std::size_t, std::size_t> elem_active_freq;
    for (const auto& rec : records) {
        for (std::size_t i = 0; i < num_elements_16; ++i) {
            const std::size_t start = header_size + (i * stab_stride);
            const std::size_t off0_start = i * stab_stride;
            if (off0_start < rec.payload.size()) {
                first_byte_freq_off0[rec.payload[off0_start]]++;
            }

            bool active = false;
            for (std::size_t j = 0; j < stab_stride; ++j) {
                if (rec.payload[start + j] != padding_byte) {
                    active = true;
                    break;
                }
            }
            if (active) {
                elem_active_freq[i]++;
            }
        }
    }

    std::vector<std::pair<std::size_t, std::size_t>> sorted_elem_act(elem_active_freq.begin(), elem_active_freq.end());
    std::sort(sorted_elem_act.begin(), sorted_elem_act.end(), [](const auto& a, const auto& b) {
        return a.second > b.second;
    });

    output << "Top 10 Most Active Element Indices (stride 16):\n";
    for (std::size_t i = 0; i < 10 && i < sorted_elem_act.size(); ++i) {
        output << "  Elem #" << std::setw(4) << sorted_elem_act[i].first << ": " << sorted_elem_act[i].second << " records (" << format_percentage(sorted_elem_act[i].second, records.size()) << ")\n";
    }
    output << "\n";

    std::vector<std::pair<std::uint8_t, std::size_t>> sorted_fb_off0(first_byte_freq_off0.begin(), first_byte_freq_off0.end());
    std::sort(sorted_fb_off0.begin(), sorted_fb_off0.end(), [](const auto& a, const auto& b) {
        return a.second > b.second;
    });
    output << "Top 10 First-Byte-of-Element Frequencies (stride 16, start=0):\n";
    for (std::size_t i = 0; i < 10 && i < sorted_fb_off0.size(); ++i) {
        output << "  0x" << std::hex << std::uppercase << std::setw(2) << std::setfill('0') << static_cast<int>(sorted_fb_off0[i].first) << std::dec
               << ": " << sorted_fb_off0[i].second << " (" << format_percentage(sorted_fb_off0[i].second, records.size() * num_elements_16) << ")\n";
    }
    output << "\n";

    if (non_padding_offsets.empty()) {
        output << "No non-padding bytes found in records (after header).\n";
        return output.str();
    }

    std::sort(non_padding_offsets.begin(), non_padding_offsets.end());
    non_padding_offsets.erase(std::unique(non_padding_offsets.begin(), non_padding_offsets.end()), non_padding_offsets.end());

    output << "Found " << non_padding_offsets.size() << " unique non-padding byte offsets.\n";

    std::map<std::size_t, std::size_t> distance_freq;
    for (const auto& rec : records) {
        std::size_t last_off = 0;
        bool first = true;
        for (std::size_t off = header_size; off < rec.payload.size(); ++off) {
            if (rec.payload[off] != padding_byte) {
                if (!first) {
                    distance_freq[off - last_off]++;
                }
                last_off = off;
                first = false;
            }
        }
    }
    std::vector<std::pair<std::size_t, std::size_t>> sorted_dist(distance_freq.begin(), distance_freq.end());
    std::sort(sorted_dist.begin(), sorted_dist.end(), [](const auto& a, const auto& b) {
        return a.second > b.second;
    });
    output << "\nTop 10 Distances between consecutive non-padding bytes:\n";
    for (std::size_t i = 0; i < 10 && i < sorted_dist.size(); ++i) {
        output << "  " << std::setw(2) << sorted_dist[i].first << " bytes: " << sorted_dist[i].second << "\n";
    }

    const std::vector<std::size_t> strides = {4, 8, 12, 16, 20, 24, 32, 48, 64};
    output << "\nStride analysis (offsets - header_size) % stride:\n";
    for (std::size_t stride : strides) {
        std::map<std::size_t, std::size_t> distribution;
        for (std::size_t off : non_padding_offsets) {
            distribution[(off - header_size) % stride]++;
        }

        output << "Stride " << std::setw(2) << stride << " | unique mods: " << std::setw(2) << distribution.size() << " | mods: ";
        for (auto const& [mod, count] : distribution) {
            output << mod << " (" << count << ") ";
        }
        output << "\n";
    }

    output << "\nNon-padding Heatmap (first 256 bytes):\n";
    for (std::size_t i = 0; i < 256 && i < target_length; i += 32) {
        output << std::setw(4) << std::setfill('0') << i << " | ";
        for (std::size_t j = 0; j < 32 && (i + j) < target_length; ++j) {
            const std::size_t off = i + j;
            const bool active = std::find(non_padding_offsets.begin(), non_padding_offsets.end(), off) != non_padding_offsets.end();
            output << (active ? '#' : '.');
        }
        output << "\n";
    }

    return output.str();
}

std::string analyze_sparse_family(
    const std::string& path,
    std::size_t target_length,
    std::uint8_t target_first_byte,
    std::size_t header_size,
    std::size_t stride,
    std::size_t top_elements
) {
    std::ostringstream output;
    const std::vector<std::uint8_t> bytes = read_file_bytes(path);
    const ReplaySummary summary = parse_replay_bytes(bytes);
    const std::uint8_t padding_byte = static_cast<std::uint8_t>(target_length & 0xFFu);
    const std::uint32_t padding_u32 = static_cast<std::uint32_t>(padding_byte) |
                                      (static_cast<std::uint32_t>(padding_byte) << 8U) |
                                      (static_cast<std::uint32_t>(padding_byte) << 16U) |
                                      (static_cast<std::uint32_t>(padding_byte) << 24U);

    auto records = extract_subrecord_family(bytes, summary, target_length, target_first_byte);
    output << "Sparse family analysis for " << records.size() << " records of size " << target_length
           << " starting with 0x" << std::hex << std::uppercase << std::setw(2) << std::setfill('0')
           << static_cast<int>(target_first_byte) << std::dec << "\n\n";
    output << "Derived padding byte: 0x" << std::hex << std::uppercase << std::setw(2) << std::setfill('0')
           << static_cast<int>(padding_byte) << std::dec << "\n";
    output << "Header size: " << header_size << " bytes\n";
    output << "Stride:      " << stride << " bytes\n";

    if (records.empty()) {
        return output.str();
    }
    if (header_size >= target_length) {
        output << "Header size must be smaller than the target record length.\n";
        return output.str();
    }
    if (stride == 0 || (stride % 4) != 0) {
        output << "Stride must be a non-zero multiple of 4 for lane analysis.\n";
        return output.str();
    }

    const std::size_t usable_bytes = target_length - header_size;
    const std::size_t element_count = usable_bytes / stride;
    const std::size_t trailing_bytes = usable_bytes % stride;
    const std::size_t lane_count = std::min<std::size_t>(4, stride / 4);
    output << "Element count: " << element_count << "\n";
    output << "Trailing bytes after stride partition: " << trailing_bytes << "\n\n";

    struct LaneAggregate {
        std::size_t non_padding_instances = 0;
        std::size_t zero_u32_count = 0;
        std::size_t finite_float_count = 0;
        std::size_t coordinate_like_count = 0;
        std::size_t unit_float_count = 0;
        float coord_min = std::numeric_limits<float>::infinity();
        float coord_max = -std::numeric_limits<float>::infinity();
    };

    struct PairAggregate {
        std::size_t non_padding_pairs = 0;
        std::size_t coordinate_like_pairs = 0;
        float left_min = std::numeric_limits<float>::infinity();
        float left_max = -std::numeric_limits<float>::infinity();
        float right_min = std::numeric_limits<float>::infinity();
        float right_max = -std::numeric_limits<float>::infinity();
    };

    struct PairDefinition {
        std::size_t left_lane = 0;
        std::size_t right_lane = 0;
        std::string label;
    };

    struct TopElementProfile {
        std::size_t index = 0;
        std::size_t active_count = 0;
        std::vector<std::size_t> lane_non_padding_counts;
        std::map<std::uint8_t, std::size_t> first_byte_freq;
    };

    const auto is_coordinate_like = [](float value) {
        return std::isfinite(value) && std::fpclassify(value) == FP_NORMAL && value >= -5000.0F && value <= 20000.0F;
    };

    auto format_top_byte_counts = [](const std::map<std::uint8_t, std::size_t>& freq, std::size_t limit) {
        std::vector<std::pair<std::uint8_t, std::size_t>> sorted(freq.begin(), freq.end());
        std::sort(sorted.begin(), sorted.end(), [](const auto& left, const auto& right) {
            return left.second > right.second;
        });

        std::ostringstream line;
        for (std::size_t i = 0; i < limit && i < sorted.size(); ++i) {
            if (i > 0) {
                line << ", ";
            }
            line << "0x" << std::hex << std::uppercase << std::setw(2) << std::setfill('0')
                 << static_cast<int>(sorted[i].first) << std::dec << '=' << sorted[i].second;
        }
        if (sorted.empty()) {
            line << "none";
        }
        return line.str();
    };

    std::vector<PairDefinition> pair_defs;
    if (lane_count >= 2) {
        pair_defs.push_back({0, 1, "+0/+4"});
    }
    if (lane_count >= 3) {
        pair_defs.push_back({1, 2, "+4/+8"});
        pair_defs.push_back({0, 2, "+0/+8"});
    }
    if (lane_count >= 4) {
        pair_defs.push_back({2, 3, "+8/+12"});
        pair_defs.push_back({0, 3, "+0/+12"});
    }

    std::vector<LaneAggregate> lane_stats(lane_count);
    std::vector<PairAggregate> pair_stats(pair_defs.size());
    std::vector<std::size_t> element_active_counts(element_count, 0);
    std::vector<std::size_t> active_elements_per_record;
    active_elements_per_record.reserve(records.size());
    std::map<std::uint8_t, std::size_t> active_first_byte_freq;
    std::map<std::uint8_t, std::size_t> lane_mask_freq;
    std::map<std::uint16_t, std::size_t> signature_freq;
    std::size_t total_active_elements = 0;

    for (const auto& rec : records) {
        std::size_t record_active = 0;
        for (std::size_t element_index = 0; element_index < element_count; ++element_index) {
            const std::size_t start = header_size + (element_index * stride);
            if (start + stride > rec.payload.size()) {
                break;
            }

            bool active = false;
            for (std::size_t byte_index = 0; byte_index < stride; ++byte_index) {
                if (rec.payload[start + byte_index] != padding_byte) {
                    active = true;
                    break;
                }
            }
            if (!active) {
                continue;
            }

            record_active++;
            total_active_elements++;
            element_active_counts[element_index]++;
            active_first_byte_freq[rec.payload[start]]++;

            std::vector<float> lane_floats(lane_count, 0.0F);
            std::vector<bool> lane_has_non_padding(lane_count, false);
            std::vector<bool> lane_is_coordinate(lane_count, false);
            std::uint8_t lane_mask = 0;
            for (std::size_t lane_index = 0; lane_index < lane_count; ++lane_index) {
                const std::size_t lane_offset = start + (lane_index * 4);
                std::uint32_t value = 0;
                if (!read_u32_le(rec.payload, lane_offset, value) || value == padding_u32) {
                    continue;
                }

                lane_has_non_padding[lane_index] = true;
                lane_mask |= static_cast<std::uint8_t>(1U << lane_index);
                lane_stats[lane_index].non_padding_instances++;
                if (value == 0) {
                    lane_stats[lane_index].zero_u32_count++;
                }

                const float as_float = std::bit_cast<float>(value);
                if (!std::isfinite(as_float)) {
                    continue;
                }

                lane_stats[lane_index].finite_float_count++;
                if (std::fpclassify(as_float) == FP_NORMAL && as_float >= -1.0F && as_float <= 1.0F) {
                    lane_stats[lane_index].unit_float_count++;
                }
                if (is_coordinate_like(as_float)) {
                    lane_stats[lane_index].coordinate_like_count++;
                    lane_stats[lane_index].coord_min = std::min(lane_stats[lane_index].coord_min, as_float);
                    lane_stats[lane_index].coord_max = std::max(lane_stats[lane_index].coord_max, as_float);
                    lane_floats[lane_index] = as_float;
                    lane_is_coordinate[lane_index] = true;
                }
            }

            lane_mask_freq[lane_mask]++;
            signature_freq[static_cast<std::uint16_t>((static_cast<std::uint16_t>(lane_mask) << 8U) | rec.payload[start])]++;

            for (std::size_t pair_index = 0; pair_index < pair_defs.size(); ++pair_index) {
                const auto& pair = pair_defs[pair_index];
                auto& stats = pair_stats[pair_index];
                if (!lane_has_non_padding[pair.left_lane] || !lane_has_non_padding[pair.right_lane]) {
                    continue;
                }

                stats.non_padding_pairs++;
                if (!lane_is_coordinate[pair.left_lane] || !lane_is_coordinate[pair.right_lane]) {
                    continue;
                }

                stats.coordinate_like_pairs++;
                stats.left_min = std::min(stats.left_min, lane_floats[pair.left_lane]);
                stats.left_max = std::max(stats.left_max, lane_floats[pair.left_lane]);
                stats.right_min = std::min(stats.right_min, lane_floats[pair.right_lane]);
                stats.right_max = std::max(stats.right_max, lane_floats[pair.right_lane]);
            }
        }

        active_elements_per_record.push_back(record_active);
    }

    const std::size_t min_active = active_elements_per_record.empty()
        ? 0
        : *std::min_element(active_elements_per_record.begin(), active_elements_per_record.end());
    const std::size_t max_active = active_elements_per_record.empty()
        ? 0
        : *std::max_element(active_elements_per_record.begin(), active_elements_per_record.end());
    const std::size_t avg_active = active_elements_per_record.empty()
        ? 0
        : std::accumulate(active_elements_per_record.begin(), active_elements_per_record.end(), std::size_t{0}) / active_elements_per_record.size();
    const std::size_t unique_active_indices = std::count_if(
        element_active_counts.begin(),
        element_active_counts.end(),
        [](std::size_t count) { return count > 0; }
    );

    output << "Activity profile:\n";
    output << "  Active elements per record: avg=" << avg_active << ", min=" << min_active << ", max=" << max_active << "\n";
    output << "  Active element instances:   " << total_active_elements << "\n";
    output << "  Unique active indices:      " << unique_active_indices << " / " << element_count
           << " (" << format_percentage(unique_active_indices, element_count) << ")\n\n";

    output << "Global first-byte signatures among active elements:\n";
    output << "  " << format_top_byte_counts(active_first_byte_freq, 8) << "\n\n";

    output << "Lane profile:\n";
    for (std::size_t lane_index = 0; lane_index < lane_count; ++lane_index) {
        const auto& lane = lane_stats[lane_index];
        output << "  Lane +" << (lane_index * 4) << " | non-padding=" << lane.non_padding_instances
               << " (" << format_percentage(lane.non_padding_instances, total_active_elements) << " of active)"
               << ", zero-u32=" << lane.zero_u32_count
               << " (" << format_percentage(lane.zero_u32_count, lane.non_padding_instances) << " of non-padding)"
               << ", finite-f32=" << lane.finite_float_count
               << " (" << format_percentage(lane.finite_float_count, lane.non_padding_instances) << " of non-padding)"
               << ", coord-like=" << lane.coordinate_like_count
               << " (" << format_percentage(lane.coordinate_like_count, lane.non_padding_instances) << " of non-padding)"
               << ", unit-f32=" << lane.unit_float_count
               << " (" << format_percentage(lane.unit_float_count, lane.non_padding_instances) << " of non-padding)";
        if (lane.coordinate_like_count > 0) {
            output << ", coord-range=[" << std::fixed << std::setprecision(2) << lane.coord_min << ", " << lane.coord_max << "]";
        }
        output << "\n";
    }
    output << "\n";

    output << "Coordinate-pair candidates:\n";
    if (pair_defs.empty()) {
        output << "  none\n\n";
    } else {
        for (std::size_t pair_index = 0; pair_index < pair_defs.size(); ++pair_index) {
            const auto& pair = pair_defs[pair_index];
            const auto& stats = pair_stats[pair_index];
            output << "  " << pair.label << " | non-padding-pairs=" << stats.non_padding_pairs
                   << " (" << format_percentage(stats.non_padding_pairs, total_active_elements) << " of active)"
                   << ", coord-like-pairs=" << stats.coordinate_like_pairs
                   << " (" << format_percentage(stats.coordinate_like_pairs, stats.non_padding_pairs) << " of non-padding pairs)";
            if (stats.coordinate_like_pairs > 0) {
                output << ", left-range=[" << std::fixed << std::setprecision(2) << stats.left_min << ", " << stats.left_max
                       << "]"
                       << ", right-range=[" << stats.right_min << ", " << stats.right_max << "]";
            }
            output << "\n";
        }
        output << "\n";
    }

    auto append_top_masks = [&](const std::map<std::uint8_t, std::size_t>& freq, std::size_t limit) {
        std::vector<std::pair<std::uint8_t, std::size_t>> sorted(freq.begin(), freq.end());
        std::sort(sorted.begin(), sorted.end(), [](const auto& left, const auto& right) {
            return left.second > right.second;
        });
        for (std::size_t i = 0; i < limit && i < sorted.size(); ++i) {
            output << "  mask=";
            for (int bit = static_cast<int>(lane_count) - 1; bit >= 0; --bit) {
                output << (((sorted[i].first >> bit) & 1U) != 0U ? '1' : '0');
            }
            output << " count=" << sorted[i].second
                   << " (" << format_percentage(sorted[i].second, total_active_elements) << ")\n";
        }
        if (sorted.empty()) {
            output << "  none\n";
        }
    };

    auto append_top_signatures = [&](const std::map<std::uint16_t, std::size_t>& freq, std::size_t limit) {
        std::vector<std::pair<std::uint16_t, std::size_t>> sorted(freq.begin(), freq.end());
        std::sort(sorted.begin(), sorted.end(), [](const auto& left, const auto& right) {
            return left.second > right.second;
        });
        for (std::size_t i = 0; i < limit && i < sorted.size(); ++i) {
            const std::uint8_t mask = static_cast<std::uint8_t>(sorted[i].first >> 8U);
            const std::uint8_t first = static_cast<std::uint8_t>(sorted[i].first & 0xFFu);
            output << "  mask=";
            for (int bit = static_cast<int>(lane_count) - 1; bit >= 0; --bit) {
                output << (((mask >> bit) & 1U) != 0U ? '1' : '0');
            }
            output << " first=0x" << std::hex << std::uppercase << std::setw(2) << std::setfill('0')
                   << static_cast<int>(first) << std::dec << std::setfill(' ')
                   << " count=" << sorted[i].second
                   << " (" << format_percentage(sorted[i].second, total_active_elements) << ")\n";
        }
        if (sorted.empty()) {
            output << "  none\n";
        }
    };

    output << "Top lane masks:\n";
    append_top_masks(lane_mask_freq, 8);
    output << "\n";

    output << "Top mask + first-byte signatures:\n";
    append_top_signatures(signature_freq, 10);
    output << "\n";

    std::vector<std::pair<std::size_t, std::size_t>> sorted_indices;
    sorted_indices.reserve(element_active_counts.size());
    for (std::size_t index = 0; index < element_active_counts.size(); ++index) {
        if (element_active_counts[index] > 0) {
            sorted_indices.push_back({index, element_active_counts[index]});
        }
    }
    std::sort(sorted_indices.begin(), sorted_indices.end(), [](const auto& left, const auto& right) {
        return left.second > right.second;
    });

    if (top_elements == 0) {
        top_elements = 12;
    }
    const std::size_t top_count = std::min<std::size_t>(top_elements, sorted_indices.size());
    std::vector<TopElementProfile> top_profiles;
    top_profiles.reserve(top_count);
    std::map<std::size_t, std::size_t> top_index_lookup;
    for (std::size_t i = 0; i < top_count; ++i) {
        TopElementProfile profile;
        profile.index = sorted_indices[i].first;
        profile.active_count = sorted_indices[i].second;
        profile.lane_non_padding_counts.assign(lane_count, 0);
        top_index_lookup[profile.index] = i;
        top_profiles.push_back(std::move(profile));
    }

    for (const auto& rec : records) {
        for (const auto& [element_index, profile_index] : top_index_lookup) {
            const std::size_t start = header_size + (element_index * stride);
            if (start + stride > rec.payload.size()) {
                continue;
            }

            bool active = false;
            for (std::size_t byte_index = 0; byte_index < stride; ++byte_index) {
                if (rec.payload[start + byte_index] != padding_byte) {
                    active = true;
                    break;
                }
            }
            if (!active) {
                continue;
            }

            auto& profile = top_profiles[profile_index];
            profile.first_byte_freq[rec.payload[start]]++;
            for (std::size_t lane_index = 0; lane_index < lane_count; ++lane_index) {
                std::uint32_t value = 0;
                if (!read_u32_le(rec.payload, start + (lane_index * 4), value) || value == padding_u32) {
                    continue;
                }
                profile.lane_non_padding_counts[lane_index]++;
            }
        }
    }

    output << "Top active element indices:\n";
    for (const auto& profile : top_profiles) {
        output << "  Elem #" << std::setw(4) << std::setfill('0') << profile.index << std::setfill(' ')
               << " | active=" << profile.active_count << '/' << records.size()
               << " (" << format_percentage(profile.active_count, records.size()) << ")"
               << " | first-bytes=" << format_top_byte_counts(profile.first_byte_freq, 3)
               << " | lane-non-padding=";
        for (std::size_t lane_index = 0; lane_index < profile.lane_non_padding_counts.size(); ++lane_index) {
            if (lane_index > 0) {
                output << ", ";
            }
            output << '+' << (lane_index * 4) << '=' << format_percentage(profile.lane_non_padding_counts[lane_index], profile.active_count);
        }
        output << "\n";
    }

    return output.str();
}
std::string profile_position_slots(
    const std::string& path,
    std::size_t target_length,
    std::uint8_t target_first_byte,
    std::size_t header_size,
    std::size_t stride,
    std::size_t top_slots,
    float move_epsilon,
    float smooth_threshold
) {
    std::ostringstream output;
    const std::vector<std::uint8_t> bytes = read_file_bytes(path);
    const ReplaySummary summary = parse_replay_bytes(bytes);
    const std::uint8_t padding_byte = static_cast<std::uint8_t>(target_length & 0xFFu);
    const std::uint32_t padding_u32 = static_cast<std::uint32_t>(padding_byte) |
                                      (static_cast<std::uint32_t>(padding_byte) << 8U) |
                                      (static_cast<std::uint32_t>(padding_byte) << 16U) |
                                      (static_cast<std::uint32_t>(padding_byte) << 24U);

    auto records = extract_subrecord_family(bytes, summary, target_length, target_first_byte);
    output << "Position-like slot profiler for " << records.size() << " records of size " << target_length
           << " starting with 0x" << std::hex << std::uppercase << std::setw(2) << std::setfill('0')
           << static_cast<int>(target_first_byte) << std::dec << "\n\n";
    output << "Derived padding byte: 0x" << std::hex << std::uppercase << std::setw(2) << std::setfill('0')
           << static_cast<int>(padding_byte) << std::dec << "\n";
    output << "Header size:       " << header_size << " bytes\n";
    output << "Stride:            " << stride << " bytes\n";
    output << "Move epsilon:      " << std::fixed << std::setprecision(2) << move_epsilon << "\n";
    output << "Smooth threshold:  " << smooth_threshold << "\n";

    if (records.empty()) {
        return output.str();
    }
    if (header_size >= target_length) {
        output << "Header size must be smaller than the target record length.\n";
        return output.str();
    }
    if (stride == 0 || (stride % 4) != 0) {
        output << "Stride must be a non-zero multiple of 4 for lane analysis.\n";
        return output.str();
    }
    if (smooth_threshold <= 0.0F) {
        output << "Smooth threshold must be positive.\n";
        return output.str();
    }
    if (move_epsilon < 0.0F) {
        output << "Move epsilon must be non-negative.\n";
        return output.str();
    }

    const std::size_t usable_bytes = target_length - header_size;
    const std::size_t element_count = usable_bytes / stride;
    const std::size_t trailing_bytes = usable_bytes % stride;
    const std::size_t lane_count = std::min<std::size_t>(4, stride / 4);
    output << "Element count:     " << element_count << "\n";
    output << "Trailing bytes:    " << trailing_bytes << "\n\n";

    if (lane_count < 2) {
        output << "Need at least two 32-bit lanes to profile position-like pairs.\n";
        return output.str();
    }

    struct PairDefinition {
        std::size_t left_lane = 0;
        std::size_t right_lane = 0;
        std::string label;
    };

    struct PreviousSample {
        bool valid = false;
        std::size_t record_index = 0;
        float x = 0.0F;
        float y = 0.0F;
    };

    struct SlotPairProfile {
        std::size_t slot_index = 0;
        std::size_t pair_index = 0;
        std::size_t coordinate_samples = 0;
        std::size_t transitions = 0;
        std::size_t smooth_transitions = 0;
        std::size_t moving_transitions = 0;
        std::size_t active_records = 0;
        double total_distance = 0.0;
        float max_distance = 0.0F;
        float min_x = std::numeric_limits<float>::infinity();
        float max_x = -std::numeric_limits<float>::infinity();
        float min_y = std::numeric_limits<float>::infinity();
        float max_y = -std::numeric_limits<float>::infinity();
        int min_chunk_id = std::numeric_limits<int>::max();
        int max_chunk_id = 0;
        std::map<std::uint8_t, std::size_t> first_byte_freq;
        std::map<std::uint8_t, std::size_t> mask_freq;
    };

    struct RankedCandidate {
        std::size_t profile_index = 0;
        double score = 0.0;
        double smooth_ratio = 0.0;
        double moving_ratio = 0.0;
        float x_range = 0.0F;
        float y_range = 0.0F;
    };

    std::vector<PairDefinition> pair_defs;
    pair_defs.push_back({0, 1, "+0/+4"});
    if (lane_count >= 3) {
        pair_defs.push_back({1, 2, "+4/+8"});
        pair_defs.push_back({0, 2, "+0/+8"});
    }
    if (lane_count >= 4) {
        pair_defs.push_back({2, 3, "+8/+12"});
        pair_defs.push_back({0, 3, "+0/+12"});
    }

    const auto is_coordinate_like = [](float value) {
        return std::isfinite(value) && std::fpclassify(value) == FP_NORMAL && value >= -5000.0F && value <= 20000.0F;
    };

    const auto format_mask = [lane_count](std::uint8_t mask) {
        std::ostringstream line;
        for (int bit = static_cast<int>(lane_count) - 1; bit >= 0; --bit) {
            line << (((mask >> bit) & 1U) != 0U ? '1' : '0');
        }
        return line.str();
    };

    const auto top_freq_entry = [](const std::map<std::uint8_t, std::size_t>& freq) {
        if (freq.empty()) {
            return std::pair<std::uint8_t, std::size_t>{0, 0};
        }
        const auto it = std::max_element(freq.begin(), freq.end(), [](const auto& left, const auto& right) {
            if (left.second != right.second) {
                return left.second < right.second;
            }
            return left.first > right.first;
        });
        return std::pair<std::uint8_t, std::size_t>{it->first, it->second};
    };

    const std::size_t profile_count = element_count * pair_defs.size();
    std::vector<SlotPairProfile> profiles(profile_count);
    std::vector<PreviousSample> previous_samples(profile_count);
    for (std::size_t slot_index = 0; slot_index < element_count; ++slot_index) {
        for (std::size_t pair_index = 0; pair_index < pair_defs.size(); ++pair_index) {
            auto& profile = profiles[(slot_index * pair_defs.size()) + pair_index];
            profile.slot_index = slot_index;
            profile.pair_index = pair_index;
        }
    }

    for (std::size_t record_index = 0; record_index < records.size(); ++record_index) {
        const auto& rec = records[record_index];
        for (std::size_t slot_index = 0; slot_index < element_count; ++slot_index) {
            const std::size_t start = header_size + (slot_index * stride);
            if (start + stride > rec.payload.size()) {
                break;
            }

            std::array<bool, 4> lane_has_non_padding = {false, false, false, false};
            std::array<bool, 4> lane_is_coordinate = {false, false, false, false};
            std::array<float, 4> lane_floats = {0.0F, 0.0F, 0.0F, 0.0F};
            std::uint8_t mask = 0;
            bool active = false;

            for (std::size_t lane_index = 0; lane_index < lane_count; ++lane_index) {
                const std::size_t lane_offset = start + (lane_index * 4);
                std::uint32_t value = 0;
                if (!read_u32_le(rec.payload, lane_offset, value) || value == padding_u32) {
                    continue;
                }

                active = true;
                lane_has_non_padding[lane_index] = true;
                mask |= static_cast<std::uint8_t>(1U << lane_index);
                const float as_float = std::bit_cast<float>(value);
                if (is_coordinate_like(as_float)) {
                    lane_is_coordinate[lane_index] = true;
                    lane_floats[lane_index] = as_float;
                }
            }

            if (!active) {
                continue;
            }

            for (std::size_t pair_index = 0; pair_index < pair_defs.size(); ++pair_index) {
                const auto& pair = pair_defs[pair_index];
                auto& profile = profiles[(slot_index * pair_defs.size()) + pair_index];
                profile.active_records++;

                if (!lane_is_coordinate[pair.left_lane] || !lane_is_coordinate[pair.right_lane]) {
                    continue;
                }

                profile.coordinate_samples++;
                profile.first_byte_freq[rec.payload[start]]++;
                profile.mask_freq[mask]++;
                profile.min_x = std::min(profile.min_x, lane_floats[pair.left_lane]);
                profile.max_x = std::max(profile.max_x, lane_floats[pair.left_lane]);
                profile.min_y = std::min(profile.min_y, lane_floats[pair.right_lane]);
                profile.max_y = std::max(profile.max_y, lane_floats[pair.right_lane]);
                profile.min_chunk_id = std::min(profile.min_chunk_id, rec.chunk_id);
                profile.max_chunk_id = std::max(profile.max_chunk_id, rec.chunk_id);

                auto& previous = previous_samples[(slot_index * pair_defs.size()) + pair_index];
                if (previous.valid && previous.record_index + 1 == record_index) {
                    const float dx = lane_floats[pair.left_lane] - previous.x;
                    const float dy = lane_floats[pair.right_lane] - previous.y;
                    const float distance = std::hypot(dx, dy);
                    profile.transitions++;
                    profile.total_distance += distance;
                    profile.max_distance = std::max(profile.max_distance, distance);
                    if (distance <= smooth_threshold) {
                        profile.smooth_transitions++;
                        if (distance >= move_epsilon) {
                            profile.moving_transitions++;
                        }
                    }
                }

                previous.valid = true;
                previous.record_index = record_index;
                previous.x = lane_floats[pair.left_lane];
                previous.y = lane_floats[pair.right_lane];
            }
        }
    }

    std::vector<RankedCandidate> ranked_candidates;
    ranked_candidates.reserve(profile_count);
    for (std::size_t profile_index = 0; profile_index < profiles.size(); ++profile_index) {
        const auto& profile = profiles[profile_index];
        if (profile.coordinate_samples < 8 || profile.transitions < 4 || profile.smooth_transitions == 0) {
            continue;
        }

        const float x_range = std::isfinite(profile.min_x) && std::isfinite(profile.max_x)
            ? profile.max_x - profile.min_x
            : 0.0F;
        const float y_range = std::isfinite(profile.min_y) && std::isfinite(profile.max_y)
            ? profile.max_y - profile.min_y
            : 0.0F;
        const double smooth_ratio = static_cast<double>(profile.smooth_transitions) / static_cast<double>(profile.transitions);
        const double moving_ratio = static_cast<double>(profile.moving_transitions) / static_cast<double>(profile.transitions);
        const double coverage = static_cast<double>(profile.coordinate_samples) / static_cast<double>(records.size());
        const double range_score = std::min<double>(3.0, static_cast<double>(x_range + y_range) / 4000.0);
        const double score = (static_cast<double>(profile.moving_transitions) + 0.5 * static_cast<double>(profile.smooth_transitions))
            * (0.5 + smooth_ratio)
            * (0.25 + coverage)
            * (0.25 + range_score);

        ranked_candidates.push_back({profile_index, score, smooth_ratio, moving_ratio, x_range, y_range});
    }

    std::sort(ranked_candidates.begin(), ranked_candidates.end(), [&](const auto& left, const auto& right) {
        if (left.score != right.score) {
            return left.score > right.score;
        }
        if (left.moving_ratio != right.moving_ratio) {
            return left.moving_ratio > right.moving_ratio;
        }
        if (left.smooth_ratio != right.smooth_ratio) {
            return left.smooth_ratio > right.smooth_ratio;
        }
        return profiles[left.profile_index].coordinate_samples > profiles[right.profile_index].coordinate_samples;
    });

    output << "Candidate slot/pair profiles: " << ranked_candidates.size() << "\n";
    output << "Pair labels: ";
    for (std::size_t pair_index = 0; pair_index < pair_defs.size(); ++pair_index) {
        if (pair_index > 0) {
            output << ", ";
        }
        output << pair_defs[pair_index].label;
    }
    output << "\n\n";

    if (ranked_candidates.empty()) {
        output << "No position-like candidates met the minimum sample/transition thresholds.\n";
        return output.str();
    }

    if (top_slots == 0) {
        top_slots = 20;
    }
    const std::size_t shown = std::min<std::size_t>(top_slots, ranked_candidates.size());

    struct ClassAggregate {
        std::size_t count = 0;
        double best_score = 0.0;
        std::size_t total_moving_transitions = 0;
        std::size_t total_coordinate_samples = 0;
    };

    std::map<std::string, ClassAggregate> class_counts;

    output << "Top candidate slots:\n";
    for (std::size_t rank_index = 0; rank_index < shown; ++rank_index) {
        const auto& ranked = ranked_candidates[rank_index];
        const auto& profile = profiles[ranked.profile_index];
        const auto& pair = pair_defs[profile.pair_index];
        const auto top_first = top_freq_entry(profile.first_byte_freq);
        const auto top_mask = top_freq_entry(profile.mask_freq);
        const double avg_distance = profile.transitions == 0
            ? 0.0
            : profile.total_distance / static_cast<double>(profile.transitions);
        const std::string class_key = pair.label + "|first=0x" + [&]() {
            std::ostringstream line;
            line << std::hex << std::uppercase << std::setw(2) << std::setfill('0') << static_cast<int>(top_first.first);
            return line.str();
        }() + "|mask=" + format_mask(top_mask.first);

        auto& class_aggregate = class_counts[class_key];
        class_aggregate.count++;
        class_aggregate.best_score = std::max(class_aggregate.best_score, ranked.score);
        class_aggregate.total_moving_transitions += profile.moving_transitions;
        class_aggregate.total_coordinate_samples += profile.coordinate_samples;

        output << "  #" << rank_index + 1
               << " | slot=" << std::setw(4) << std::setfill('0') << profile.slot_index << std::setfill(' ')
               << " | pair=" << pair.label
               << " | score=" << std::fixed << std::setprecision(2) << ranked.score
               << " | coordSamples=" << profile.coordinate_samples
               << " (" << format_percentage(profile.coordinate_samples, records.size()) << ")"
               << " | transitions=" << profile.transitions
               << " | smooth=" << profile.smooth_transitions
               << " (" << format_percentage(profile.smooth_transitions, profile.transitions) << ")"
               << " | moving=" << profile.moving_transitions
               << " (" << format_percentage(profile.moving_transitions, profile.transitions) << ")"
               << " | avgDist=" << avg_distance
               << " | maxDist=" << profile.max_distance
               << " | rangeX=" << ranked.x_range
               << " | rangeY=" << ranked.y_range
               << " | chunks=" << profile.min_chunk_id << '-' << profile.max_chunk_id
               << " | first=0x" << std::hex << std::uppercase << std::setw(2) << std::setfill('0') << static_cast<int>(top_first.first)
               << std::dec << std::setfill(' ') << "(" << top_first.second << ")"
               << " | mask=" << format_mask(top_mask.first) << "(" << top_mask.second << ")"
               << "\n";
    }

    output << "\nCandidate classes from top slots:\n";
    std::vector<std::pair<std::string, ClassAggregate>> sorted_classes(class_counts.begin(), class_counts.end());
    std::sort(sorted_classes.begin(), sorted_classes.end(), [](const auto& left, const auto& right) {
        if (left.second.count != right.second.count) {
            return left.second.count > right.second.count;
        }
        if (left.second.best_score != right.second.best_score) {
            return left.second.best_score > right.second.best_score;
        }
        return left.first < right.first;
    });

    for (const auto& [class_key, aggregate] : sorted_classes) {
        output << "  " << class_key
               << " | slots=" << aggregate.count
               << " | bestScore=" << std::fixed << std::setprecision(2) << aggregate.best_score
               << " | movingTransitions=" << aggregate.total_moving_transitions
               << " | coordSamples=" << aggregate.total_coordinate_samples
               << "\n";
    }

    output << "\nInterpretation note:\n";
    output << "  Higher-ranked slots are good candidates for entity position/state lanes, not proof of champion identity yet.\n";
    output << "  The next step is to compare top-ranked slots against known champion counts, ward timings, and keyframe boundaries.\n";

    return output.str();
}
std::string compare_position_classes(
    const std::string& path,
    std::size_t target_length,
    std::uint8_t target_first_byte,
    std::size_t header_size,
    std::size_t stride,
    std::size_t top_slots,
    std::size_t top_classes,
    float move_epsilon,
    float smooth_threshold
) {
    std::ostringstream output;
    const std::vector<std::uint8_t> bytes = read_file_bytes(path);
    const ReplaySummary summary = parse_replay_bytes(bytes);
    const std::uint8_t padding_byte = static_cast<std::uint8_t>(target_length & 0xFFu);
    const std::uint32_t padding_u32 = static_cast<std::uint32_t>(padding_byte) |
                                      (static_cast<std::uint32_t>(padding_byte) << 8U) |
                                      (static_cast<std::uint32_t>(padding_byte) << 16U) |
                                      (static_cast<std::uint32_t>(padding_byte) << 24U);

    auto records = extract_subrecord_family(bytes, summary, target_length, target_first_byte);
    output << "Position class comparer for " << records.size() << " records of size " << target_length
           << " starting with 0x" << std::hex << std::uppercase << std::setw(2) << std::setfill('0')
           << static_cast<int>(target_first_byte) << std::dec << "\n\n";
    output << "Header size:      " << header_size << " bytes\n";
    output << "Stride:           " << stride << " bytes\n";
    output << "Move epsilon:     " << std::fixed << std::setprecision(2) << move_epsilon << "\n";
    output << "Smooth threshold: " << smooth_threshold << "\n";

    if (records.empty()) {
        return output.str();
    }
    if (header_size >= target_length) {
        output << "Header size must be smaller than the target record length.\n";
        return output.str();
    }
    if (stride == 0 || (stride % 4) != 0) {
        output << "Stride must be a non-zero multiple of 4 for lane analysis.\n";
        return output.str();
    }
    if (smooth_threshold <= 0.0F) {
        output << "Smooth threshold must be positive.\n";
        return output.str();
    }
    if (move_epsilon < 0.0F) {
        output << "Move epsilon must be non-negative.\n";
        return output.str();
    }

    const std::size_t usable_bytes = target_length - header_size;
    const std::size_t element_count = usable_bytes / stride;
    const std::size_t lane_count = std::min<std::size_t>(4, stride / 4);
    if (lane_count < 2) {
        output << "Need at least two 32-bit lanes to compare position-like classes.\n";
        return output.str();
    }

    struct PairDefinition {
        std::size_t left_lane = 0;
        std::size_t right_lane = 0;
        std::string label;
    };

    struct PreviousSample {
        bool valid = false;
        std::size_t record_index = 0;
        float x = 0.0F;
        float y = 0.0F;
    };

    struct SlotPairProfile {
        std::size_t slot_index = 0;
        std::size_t pair_index = 0;
        std::size_t coordinate_samples = 0;
        std::size_t transitions = 0;
        std::size_t smooth_transitions = 0;
        std::size_t moving_transitions = 0;
        std::size_t active_records = 0;
        double total_distance = 0.0;
        float max_distance = 0.0F;
        float min_x = std::numeric_limits<float>::infinity();
        float max_x = -std::numeric_limits<float>::infinity();
        float min_y = std::numeric_limits<float>::infinity();
        float max_y = -std::numeric_limits<float>::infinity();
        int min_chunk_id = std::numeric_limits<int>::max();
        int max_chunk_id = 0;
        std::map<std::uint8_t, std::size_t> first_byte_freq;
        std::map<std::uint8_t, std::size_t> mask_freq;
    };

    struct RankedCandidate {
        std::size_t profile_index = 0;
        double score = 0.0;
        double smooth_ratio = 0.0;
        double moving_ratio = 0.0;
        double coverage = 0.0;
        float x_range = 0.0F;
        float y_range = 0.0F;
        std::size_t chunk_span = 0;
    };

    struct ClassAggregate {
        std::string key;
        std::string pair_label;
        std::size_t members = 0;
        double best_score = 0.0;
        double total_score = 0.0;
        double total_smooth_ratio = 0.0;
        double total_moving_ratio = 0.0;
        double total_coverage = 0.0;
        double total_x_range = 0.0;
        double total_y_range = 0.0;
        double total_chunk_span = 0.0;
        std::size_t champion_votes = 0;
        std::size_t stationary_votes = 0;
        std::size_t transient_votes = 0;
        std::vector<std::size_t> example_slots;
    };

    std::vector<PairDefinition> pair_defs;
    pair_defs.push_back({0, 1, "+0/+4"});
    if (lane_count >= 3) {
        pair_defs.push_back({1, 2, "+4/+8"});
        pair_defs.push_back({0, 2, "+0/+8"});
    }
    if (lane_count >= 4) {
        pair_defs.push_back({2, 3, "+8/+12"});
        pair_defs.push_back({0, 3, "+0/+12"});
    }

    const auto is_coordinate_like = [](float value) {
        return std::isfinite(value) && std::fpclassify(value) == FP_NORMAL && value >= -5000.0F && value <= 20000.0F;
    };

    const auto format_mask = [lane_count](std::uint8_t mask) {
        std::ostringstream line;
        for (int bit = static_cast<int>(lane_count) - 1; bit >= 0; --bit) {
            line << (((mask >> bit) & 1U) != 0U ? '1' : '0');
        }
        return line.str();
    };

    const auto top_freq_entry = [](const std::map<std::uint8_t, std::size_t>& freq) {
        if (freq.empty()) {
            return std::pair<std::uint8_t, std::size_t>{0, 0};
        }
        const auto it = std::max_element(freq.begin(), freq.end(), [](const auto& left, const auto& right) {
            if (left.second != right.second) {
                return left.second < right.second;
            }
            return left.first > right.first;
        });
        return std::pair<std::uint8_t, std::size_t>{it->first, it->second};
    };

    const std::size_t profile_count = element_count * pair_defs.size();
    std::vector<SlotPairProfile> profiles(profile_count);
    std::vector<PreviousSample> previous_samples(profile_count);
    for (std::size_t slot_index = 0; slot_index < element_count; ++slot_index) {
        for (std::size_t pair_index = 0; pair_index < pair_defs.size(); ++pair_index) {
            auto& profile = profiles[(slot_index * pair_defs.size()) + pair_index];
            profile.slot_index = slot_index;
            profile.pair_index = pair_index;
        }
    }

    for (std::size_t record_index = 0; record_index < records.size(); ++record_index) {
        const auto& rec = records[record_index];
        for (std::size_t slot_index = 0; slot_index < element_count; ++slot_index) {
            const std::size_t start = header_size + (slot_index * stride);
            if (start + stride > rec.payload.size()) {
                break;
            }

            std::array<bool, 4> lane_is_coordinate = {false, false, false, false};
            std::array<float, 4> lane_floats = {0.0F, 0.0F, 0.0F, 0.0F};
            std::uint8_t mask = 0;
            bool active = false;

            for (std::size_t lane_index = 0; lane_index < lane_count; ++lane_index) {
                const std::size_t lane_offset = start + (lane_index * 4);
                std::uint32_t value = 0;
                if (!read_u32_le(rec.payload, lane_offset, value) || value == padding_u32) {
                    continue;
                }

                active = true;
                mask |= static_cast<std::uint8_t>(1U << lane_index);
                const float as_float = std::bit_cast<float>(value);
                if (is_coordinate_like(as_float)) {
                    lane_is_coordinate[lane_index] = true;
                    lane_floats[lane_index] = as_float;
                }
            }

            if (!active) {
                continue;
            }

            for (std::size_t pair_index = 0; pair_index < pair_defs.size(); ++pair_index) {
                const auto& pair = pair_defs[pair_index];
                auto& profile = profiles[(slot_index * pair_defs.size()) + pair_index];
                profile.active_records++;

                if (!lane_is_coordinate[pair.left_lane] || !lane_is_coordinate[pair.right_lane]) {
                    continue;
                }

                profile.coordinate_samples++;
                profile.first_byte_freq[rec.payload[start]]++;
                profile.mask_freq[mask]++;
                profile.min_x = std::min(profile.min_x, lane_floats[pair.left_lane]);
                profile.max_x = std::max(profile.max_x, lane_floats[pair.left_lane]);
                profile.min_y = std::min(profile.min_y, lane_floats[pair.right_lane]);
                profile.max_y = std::max(profile.max_y, lane_floats[pair.right_lane]);
                profile.min_chunk_id = std::min(profile.min_chunk_id, rec.chunk_id);
                profile.max_chunk_id = std::max(profile.max_chunk_id, rec.chunk_id);

                auto& previous = previous_samples[(slot_index * pair_defs.size()) + pair_index];
                if (previous.valid && previous.record_index + 1 == record_index) {
                    const float dx = lane_floats[pair.left_lane] - previous.x;
                    const float dy = lane_floats[pair.right_lane] - previous.y;
                    const float distance = std::hypot(dx, dy);
                    profile.transitions++;
                    profile.total_distance += distance;
                    profile.max_distance = std::max(profile.max_distance, distance);
                    if (distance <= smooth_threshold) {
                        profile.smooth_transitions++;
                        if (distance >= move_epsilon) {
                            profile.moving_transitions++;
                        }
                    }
                }

                previous.valid = true;
                previous.record_index = record_index;
                previous.x = lane_floats[pair.left_lane];
                previous.y = lane_floats[pair.right_lane];
            }
        }
    }

    std::vector<RankedCandidate> ranked_candidates;
    ranked_candidates.reserve(profile_count);
    for (std::size_t profile_index = 0; profile_index < profiles.size(); ++profile_index) {
        const auto& profile = profiles[profile_index];
        if (profile.coordinate_samples < 8 || profile.transitions < 4 || profile.smooth_transitions == 0) {
            continue;
        }

        const float x_range = std::isfinite(profile.min_x) && std::isfinite(profile.max_x)
            ? profile.max_x - profile.min_x
            : 0.0F;
        const float y_range = std::isfinite(profile.min_y) && std::isfinite(profile.max_y)
            ? profile.max_y - profile.min_y
            : 0.0F;
        const double smooth_ratio = static_cast<double>(profile.smooth_transitions) / static_cast<double>(profile.transitions);
        const double moving_ratio = static_cast<double>(profile.moving_transitions) / static_cast<double>(profile.transitions);
        const double coverage = static_cast<double>(profile.coordinate_samples) / static_cast<double>(records.size());
        const double range_score = std::min<double>(3.0, static_cast<double>(x_range + y_range) / 4000.0);
        const double score = (static_cast<double>(profile.moving_transitions) + 0.5 * static_cast<double>(profile.smooth_transitions))
            * (0.5 + smooth_ratio)
            * (0.25 + coverage)
            * (0.25 + range_score);
        const std::size_t chunk_span = profile.max_chunk_id >= profile.min_chunk_id
            ? static_cast<std::size_t>(profile.max_chunk_id - profile.min_chunk_id + 1)
            : 0;

        ranked_candidates.push_back({profile_index, score, smooth_ratio, moving_ratio, coverage, x_range, y_range, chunk_span});
    }

    std::sort(ranked_candidates.begin(), ranked_candidates.end(), [&](const auto& left, const auto& right) {
        if (left.score != right.score) {
            return left.score > right.score;
        }
        if (left.moving_ratio != right.moving_ratio) {
            return left.moving_ratio > right.moving_ratio;
        }
        if (left.smooth_ratio != right.smooth_ratio) {
            return left.smooth_ratio > right.smooth_ratio;
        }
        return profiles[left.profile_index].coordinate_samples > profiles[right.profile_index].coordinate_samples;
    });

    output << "Candidate slot/pair profiles: " << ranked_candidates.size() << "\n";
    if (ranked_candidates.empty()) {
        output << "No position-like candidates met the minimum sample/transition thresholds.\n";
        return output.str();
    }

    if (top_slots == 0) {
        top_slots = 120;
    }
    if (top_classes == 0) {
        top_classes = 12;
    }
    const std::size_t shown_slots = std::min<std::size_t>(top_slots, ranked_candidates.size());

    std::map<std::string, ClassAggregate> class_map;
    for (std::size_t rank_index = 0; rank_index < shown_slots; ++rank_index) {
        const auto& ranked = ranked_candidates[rank_index];
        const auto& profile = profiles[ranked.profile_index];
        const auto& pair = pair_defs[profile.pair_index];
        const auto top_first = top_freq_entry(profile.first_byte_freq);
        const auto top_mask = top_freq_entry(profile.mask_freq);
        std::ostringstream key_builder;
        key_builder << pair.label << "|first=0x" << std::hex << std::uppercase << std::setw(2) << std::setfill('0')
                    << static_cast<int>(top_first.first) << std::dec << std::setfill(' ')
                    << "|mask=" << format_mask(top_mask.first);
        const std::string class_key = key_builder.str();

        auto& aggregate = class_map[class_key];
        aggregate.key = class_key;
        aggregate.pair_label = pair.label;
        aggregate.members++;
        aggregate.best_score = std::max(aggregate.best_score, ranked.score);
        aggregate.total_score += ranked.score;
        aggregate.total_smooth_ratio += ranked.smooth_ratio;
        aggregate.total_moving_ratio += ranked.moving_ratio;
        aggregate.total_coverage += ranked.coverage;
        aggregate.total_x_range += ranked.x_range;
        aggregate.total_y_range += ranked.y_range;
        aggregate.total_chunk_span += static_cast<double>(ranked.chunk_span);
        if (aggregate.example_slots.size() < 6) {
            aggregate.example_slots.push_back(profile.slot_index);
        }

        const bool champion_like_vote = ranked.coverage >= 0.12 && ranked.smooth_ratio >= 0.90 && ranked.moving_ratio >= 0.05 && ranked.moving_ratio <= 0.35 && ranked.chunk_span >= 20 && (ranked.x_range + ranked.y_range) >= 2500.0F;
        const bool stationary_vote = ranked.coverage >= 0.10 && ranked.smooth_ratio >= 0.90 && ranked.moving_ratio <= 0.08 && ranked.chunk_span >= 20;
        const bool transient_vote = ranked.moving_ratio >= 0.25 && ranked.chunk_span <= 12;
        if (champion_like_vote) {
            aggregate.champion_votes++;
        }
        if (stationary_vote) {
            aggregate.stationary_votes++;
        }
        if (transient_vote) {
            aggregate.transient_votes++;
        }
    }

    struct ClassSummary {
        std::string key;
        std::string label;
        std::size_t members = 0;
        std::size_t champion_distance = 0;
        double best_score = 0.0;
        double avg_score = 0.0;
        double avg_smooth_ratio = 0.0;
        double avg_moving_ratio = 0.0;
        double avg_coverage = 0.0;
        double avg_x_range = 0.0;
        double avg_y_range = 0.0;
        double avg_chunk_span = 0.0;
        std::size_t champion_votes = 0;
        std::size_t stationary_votes = 0;
        std::size_t transient_votes = 0;
        std::vector<std::size_t> example_slots;
    };

    std::vector<ClassSummary> classes;
    classes.reserve(class_map.size());
    for (const auto& [key, aggregate] : class_map) {
        const double member_count = static_cast<double>(aggregate.members);
        const double avg_score = aggregate.total_score / member_count;
        const double avg_smooth_ratio = aggregate.total_smooth_ratio / member_count;
        const double avg_moving_ratio = aggregate.total_moving_ratio / member_count;
        const double avg_coverage = aggregate.total_coverage / member_count;
        const double avg_x_range = aggregate.total_x_range / member_count;
        const double avg_y_range = aggregate.total_y_range / member_count;
        const double avg_chunk_span = aggregate.total_chunk_span / member_count;
        std::string label = "mixed state candidate";
        if (aggregate.champion_votes * 2 >= aggregate.members && aggregate.members >= 6 && aggregate.members <= 18) {
            label = "champion-like candidate";
        } else if (aggregate.stationary_votes * 2 >= aggregate.members) {
            label = "stationary/object-like candidate";
        } else if (aggregate.transient_votes * 2 >= aggregate.members) {
            label = "transient/mobile candidate";
        }

        classes.push_back({
            key,
            label,
            aggregate.members,
            aggregate.members > 10 ? aggregate.members - 10 : 10 - aggregate.members,
            aggregate.best_score,
            avg_score,
            avg_smooth_ratio,
            avg_moving_ratio,
            avg_coverage,
            avg_x_range,
            avg_y_range,
            avg_chunk_span,
            aggregate.champion_votes,
            aggregate.stationary_votes,
            aggregate.transient_votes,
            aggregate.example_slots
        });
    }

    auto render_examples = [](const std::vector<std::size_t>& example_slots) {
        std::ostringstream line;
        for (std::size_t index = 0; index < example_slots.size(); ++index) {
            if (index > 0) {
                line << ',';
            }
            line << example_slots[index];
        }
        return line.str();
    };

    auto render_class = [&](const ClassSummary& cls) {
        output << "  " << cls.key
               << " | label=" << cls.label
               << " | slots=" << cls.members
               << " | championDistance=" << cls.champion_distance
               << " | bestScore=" << std::fixed << std::setprecision(2) << cls.best_score
               << " | avgScore=" << cls.avg_score
               << " | avgCoverage=" << cls.avg_coverage
               << " | avgSmooth=" << cls.avg_smooth_ratio
               << " | avgMoving=" << cls.avg_moving_ratio
               << " | avgChunkSpan=" << cls.avg_chunk_span
               << " | votes C/S/T=" << cls.champion_votes << '/' << cls.stationary_votes << '/' << cls.transient_votes
               << " | exampleSlots=" << render_examples(cls.example_slots)
               << "\n";
    };

    std::vector<ClassSummary> champion_sorted = classes;
    std::sort(champion_sorted.begin(), champion_sorted.end(), [](const auto& left, const auto& right) {
        const bool left_champion = left.label == "champion-like candidate";
        const bool right_champion = right.label == "champion-like candidate";
        if (left_champion != right_champion) {
            return left_champion > right_champion;
        }
        if (left.champion_distance != right.champion_distance) {
            return left.champion_distance < right.champion_distance;
        }
        if (left.champion_votes != right.champion_votes) {
            return left.champion_votes > right.champion_votes;
        }
        return left.best_score > right.best_score;
    });

    std::vector<ClassSummary> stationary_sorted = classes;
    std::sort(stationary_sorted.begin(), stationary_sorted.end(), [](const auto& left, const auto& right) {
        if (left.stationary_votes != right.stationary_votes) {
            return left.stationary_votes > right.stationary_votes;
        }
        if (left.avg_moving_ratio != right.avg_moving_ratio) {
            return left.avg_moving_ratio < right.avg_moving_ratio;
        }
        return left.avg_coverage > right.avg_coverage;
    });

    std::vector<ClassSummary> transient_sorted = classes;
    std::sort(transient_sorted.begin(), transient_sorted.end(), [](const auto& left, const auto& right) {
        if (left.transient_votes != right.transient_votes) {
            return left.transient_votes > right.transient_votes;
        }
        if (left.avg_moving_ratio != right.avg_moving_ratio) {
            return left.avg_moving_ratio > right.avg_moving_ratio;
        }
        return left.avg_chunk_span < right.avg_chunk_span;
    });

    output << "Top slot/pair candidates considered: " << shown_slots << "\n";
    output << "Discovered classes in that window: " << classes.size() << "\n\n";

    output << "Classes nearest champion-count shape (10 slots):\n";
    for (std::size_t index = 0; index < std::min<std::size_t>(top_classes, champion_sorted.size()); ++index) {
        render_class(champion_sorted[index]);
    }

    output << "\nMost stationary/object-like classes:\n";
    for (std::size_t index = 0; index < std::min<std::size_t>(std::min<std::size_t>(top_classes, 6), stationary_sorted.size()); ++index) {
        render_class(stationary_sorted[index]);
    }

    output << "\nMost transient/mobile classes:\n";
    for (std::size_t index = 0; index < std::min<std::size_t>(std::min<std::size_t>(top_classes, 6), transient_sorted.size()); ++index) {
        render_class(transient_sorted[index]);
    }

    output << "\nInterpretation note:\n";
    output << "  These labels are heuristic comparisons, not decoded semantics.\n";
    output << "  A champion-like class should converge toward roughly 10 persistent slots with broad chunk coverage and smooth motion.\n";
    output << "  Stationary classes are better candidates for wards, static objects, or anchor state.\n";
    output << "  Transient classes are better candidates for missiles, short-lived deltas, or burst-only entities.\n";

    return output.str();
}
std::string trace_sparse_slot(
    const std::string& path,
    std::size_t target_length,
    std::uint8_t target_first_byte,
    std::size_t header_size,
    std::size_t stride,
    std::size_t slot_index,
    std::size_t max_records
) {
    std::ostringstream output;
    const std::vector<std::uint8_t> bytes = read_file_bytes(path);
    const ReplaySummary summary = parse_replay_bytes(bytes);
    const std::uint8_t padding_byte = static_cast<std::uint8_t>(target_length & 0xFFu);
    const std::uint32_t padding_u32 = static_cast<std::uint32_t>(padding_byte) |
                                      (static_cast<std::uint32_t>(padding_byte) << 8U) |
                                      (static_cast<std::uint32_t>(padding_byte) << 16U) |
                                      (static_cast<std::uint32_t>(padding_byte) << 24U);

    auto records = extract_subrecord_family(bytes, summary, target_length, target_first_byte);
    output << "Sparse slot trace for slot #" << slot_index << " across " << records.size() << " records\n\n";
    output << "Record length: " << target_length << " bytes\n";
    output << "Header size:   " << header_size << " bytes\n";
    output << "Stride:        " << stride << " bytes\n";

    if (records.empty()) {
        return output.str();
    }
    if (header_size >= target_length) {
        output << "Header size must be smaller than the target record length.\n";
        return output.str();
    }
    if (stride == 0 || (stride % 4) != 0) {
        output << "Stride must be a non-zero multiple of 4.\n";
        return output.str();
    }

    const std::size_t element_count = (target_length - header_size) / stride;
    if (slot_index >= element_count) {
        output << "Slot index " << slot_index << " is out of range for " << element_count << " elements.\n";
        return output.str();
    }

    const auto is_coordinate_like = [](float value) {
        return std::isfinite(value) && std::fpclassify(value) == FP_NORMAL && value >= -5000.0F && value <= 20000.0F;
    };

    auto describe_lane = [&](const std::vector<std::uint8_t>& payload, std::size_t offset) {
        std::ostringstream line;
        std::uint32_t value = 0;
        if (!read_u32_le(payload, offset, value)) {
            line << "oob";
            return line.str();
        }
        if (value == padding_u32) {
            line << "padding";
            return line.str();
        }

        line << "u32=0x" << std::hex << std::uppercase << std::setw(8) << std::setfill('0') << value << std::dec << std::setfill(' ');
        const float as_float = std::bit_cast<float>(value);
        if (std::isfinite(as_float)) {
            line << ", f32=" << std::fixed << std::setprecision(2) << as_float;
            if (is_coordinate_like(as_float)) {
                line << " [coord-like]";
            } else if (std::fpclassify(as_float) == FP_NORMAL && as_float >= -1.0F && as_float <= 1.0F) {
                line << " [unit-like]";
            }
        } else {
            line << ", f32=non-finite";
        }
        return line.str();
    };

    std::size_t active_count = 0;
    std::size_t shown = 0;
    for (std::size_t record_index = 0; record_index < records.size(); ++record_index) {
        const auto& rec = records[record_index];
        const std::size_t start = header_size + (slot_index * stride);
        if (start + stride > rec.payload.size()) {
            continue;
        }

        bool active = false;
        for (std::size_t byte_index = 0; byte_index < stride; ++byte_index) {
            if (rec.payload[start + byte_index] != padding_byte) {
                active = true;
                break;
            }
        }
        if (!active) {
            continue;
        }

        active_count++;
        if (shown >= max_records) {
            continue;
        }

        std::uint8_t mask = 0;
        for (std::size_t lane_index = 0; lane_index < std::min<std::size_t>(4, stride / 4); ++lane_index) {
            std::uint32_t value = 0;
            if (read_u32_le(rec.payload, start + (lane_index * 4), value) && value != padding_u32) {
                mask |= static_cast<std::uint8_t>(1U << lane_index);
            }
        }

        output << "rec#" << std::setw(3) << std::setfill('0') << record_index << std::setfill(' ')
               << " chunk=" << rec.chunk_id
               << " offset=" << rec.chunk_offset
               << " first=0x" << std::hex << std::uppercase << std::setw(2) << std::setfill('0')
               << static_cast<int>(rec.payload[start]) << std::dec << std::setfill(' ')
               << " mask=";
        for (int bit = static_cast<int>(std::min<std::size_t>(4, stride / 4)) - 1; bit >= 0; --bit) {
            output << (((mask >> bit) & 1U) != 0U ? '1' : '0');
        }
        output << "\n";

        for (std::size_t lane_index = 0; lane_index < std::min<std::size_t>(4, stride / 4); ++lane_index) {
            output << "  +" << (lane_index * 4) << ": " << describe_lane(rec.payload, start + (lane_index * 4)) << "\n";
        }
        output << "\n";
        shown++;
    }

    output << "Active records for slot: " << active_count << " / " << records.size()
           << " (" << format_percentage(active_count, records.size()) << ")\n";
    if (active_count > shown) {
        output << "Trace output truncated to first " << shown << " active records.\n";
    }

    return output.str();
}

std::string export_positions_json(
    const std::string& path,
    std::size_t target_length,
    std::uint8_t target_first_byte,
    std::size_t header_size,
    std::size_t stride,
    const std::vector<std::size_t>& slots
) {
    std::ostringstream output;
    const std::vector<std::uint8_t> bytes = read_file_bytes(path);
    const ReplaySummary summary = parse_replay_bytes(bytes);
    const std::uint8_t padding_byte = static_cast<std::uint8_t>(target_length & 0xFFu);
    const std::uint32_t padding_u32 = static_cast<std::uint32_t>(padding_byte) |
                                      (static_cast<std::uint32_t>(padding_byte) << 8U) |
                                      (static_cast<std::uint32_t>(padding_byte) << 16U) |
                                      (static_cast<std::uint32_t>(padding_byte) << 24U);

    auto records = extract_subrecord_family(bytes, summary, target_length, target_first_byte);

    output << "[\n";
    for (std::size_t i = 0; i < slots.size(); ++i) {
        std::size_t slot_index = slots[i];
        output << "  {\n";
        output << "    \"slot\": " << slot_index << ",\n";
        output << "    \"positions\": [\n";

        bool first_pos = true;
        for (std::size_t record_index = 0; record_index < records.size(); ++record_index) {
            const auto& rec = records[record_index];
            const std::size_t start = header_size + (slot_index * stride);
            if (start + stride > rec.payload.size()) {
                continue;
            }

            bool active = false;
            for (std::size_t byte_index = 0; byte_index < stride; ++byte_index) {
                if (rec.payload[start + byte_index] != padding_byte) {
                    active = true;
                    break;
                }
            }
            if (!active) {
                continue;
            }

            std::array<float, 4> lane_floats = {0.0F, 0.0F, 0.0F, 0.0F};
            std::array<bool, 4> lane_valid = {false, false, false, false};
            for (std::size_t lane_index = 0; lane_index < std::min<std::size_t>(4, stride / 4); ++lane_index) {
                std::uint32_t value = 0;
                if (read_u32_le(rec.payload, start + (lane_index * 4), value) && value != padding_u32) {
                    const float as_float = std::bit_cast<float>(value);
                    if (std::isfinite(as_float)) {
                        lane_floats[lane_index] = as_float;
                        lane_valid[lane_index] = true;
                    }
                }
            }
            
            if (first_pos) {
                first_pos = false;
            } else {
                output << ",\n";
            }
            output << "      { \"chunk\": " << rec.chunk_id;
            for (std::size_t lane_index = 0; lane_index < std::min<std::size_t>(4, stride / 4); ++lane_index) {
                if (lane_valid[lane_index]) {
                    output << ", \"lane" << lane_index << "\": " << std::fixed << std::setprecision(2) << lane_floats[lane_index];
                }
            }
            output << " }";
        }
        output << "\n    ]\n";
        output << "  }";
        if (i < slots.size() - 1) {
            output << ",";
        }
        output << "\n";
    }
    output << "]\n";

    return output.str();
}

std::string export_keyframe_state_candidates_json(const std::string& path) {
    const std::vector<std::uint8_t> bytes = read_file_bytes(path);
    const ReplaySummary summary = parse_replay_bytes(bytes);
    const std::string version_group = keyframe_schema_version_group(summary.game_version);
    const KeyframeStateSchemaVersion schema = keyframe_state_schema_v1();

    std::vector<KeyframeStateFieldSchema> candidates;
    for (const auto& candidate : schema.fields) {
        if (version_group == candidate.version_group) {
            candidates.push_back(candidate);
        }
    }

    std::ostringstream output;
    output << '{';
    output << "\"schema\":\"keyframe-state-timeline.v1\",";
    output << "\"schemaId\":\"" << json_escape(schema.schema_id) << "\",";
    output << "\"schemaSource\":\"" << json_escape(schema.generated_from) << "\",";
    output << "\"replayPath\":\"" << json_escape(path) << "\",";
    output << "\"gameVersion\":\"" << json_escape(summary.game_version) << "\",";
    output << "\"versionGroup\":\"" << json_escape(version_group) << "\",";
    output << "\"supervisedSchema\":true,";
    output << "\"participantIdentity\":\"unassigned\",";
    output << "\"calibration\":\"none\",";
    output << "\"note\":\"" << json_escape(schema.note) << "\",";

    if (candidates.empty()) {
        output << "\"supported\":false,\"candidateCount\":0,\"records\":[],\"participants\":[],\"series\":[]}";
        return output.str();
    }

    const auto family = candidates.front();
    const auto records = extract_subrecord_family(bytes, summary, family.length, family.first_byte, "keyframe");
    output << "\"supported\":true,";
    output << "\"family\":{";
    output << "\"length\":" << family.length << ',';
    output << "\"firstByte\":" << static_cast<int>(family.first_byte) << ',';
    output << "\"headerSize\":" << family.header_size << ',';
    output << "\"stride\":" << family.stride << ',';
    output << "\"recordCount\":" << records.size();
    output << "},";

    const auto read_candidate_value = [](const std::vector<std::uint8_t>& payload, std::size_t offset, std::size_t width, std::string_view decode_label, std::uint64_t& raw_value, double& decoded_value) -> bool {
        if (offset + width > payload.size()) {
            return false;
        }
        if (width == 2) {
            const std::uint16_t raw = static_cast<std::uint16_t>(payload[offset]) |
                                      (static_cast<std::uint16_t>(payload[offset + 1]) << 8U);
            raw_value = raw;
            decoded_value = static_cast<double>(raw);
            return true;
        }
        if (width != 4) {
            return false;
        }
        std::uint32_t raw = 0;
        if (!read_u32_le(payload, offset, raw)) {
            return false;
        }
        raw_value = raw;
        if (decode_label == "u32") {
            decoded_value = static_cast<double>(raw);
            return true;
        }
        if (decode_label == "i32") {
            decoded_value = static_cast<double>(static_cast<std::int32_t>(raw));
            return true;
        }
        if (decode_label == "f32") {
            const float value = std::bit_cast<float>(raw);
            if (!std::isfinite(value)) {
                return false;
            }
            decoded_value = static_cast<double>(value);
            return true;
        }
        return false;
    };

    const auto raw_hex = [](std::uint64_t value, std::size_t width) {
        std::ostringstream stream;
        stream << "0x" << std::hex << std::uppercase << std::setw(static_cast<int>(width * 2)) << std::setfill('0') << value;
        return stream.str();
    };

    output << "\"records\":[";
    for (std::size_t index = 0; index < records.size(); ++index) {
        if (index > 0) {
            output << ',';
        }
        const auto& record = records[index];
        output << '{';
        output << "\"recordIndex\":" << index << ',';
        output << "\"segmentId\":" << record.segment_id << ',';
        output << "\"chunkId\":" << record.chunk_id << ',';
        output << "\"apiFrameIndex\":" << subrecord_api_frame_index(record) << ',';
        output << "\"timestamp\":" << subrecord_sample_timestamp_millis(record, summary, index, records.size() > 1 ? records.size() - 1 : 1);
        output << '}';
    }
    output << "],";

    output << "\"series\":[";
    for (std::size_t candidate_index = 0; candidate_index < candidates.size(); ++candidate_index) {
        if (candidate_index > 0) {
            output << ',';
        }
        const auto& candidate = candidates[candidate_index];
        output << '{';
        output << "\"slotIndex\":" << candidate.slot_index << ',';
        output << "\"participantId\":null,";
        output << "\"metric\":\"" << json_escape(candidate.metric) << "\",";
        output << "\"familyKey\":\"" << json_escape(candidate.family_key) << "\",";
        output << "\"offset\":" << candidate.offset << ',';
        output << "\"width\":" << candidate.width << ',';
        output << "\"decodeLabel\":\"" << json_escape(candidate.decode_label) << "\",";
        output << "\"avgScore\":" << candidate.avg_score << ',';
        output << "\"supportReplayCount\":" << candidate.support_replay_count << ',';
        output << "\"confidence\":{";
        output << "\"kind\":\"promotedMetricCandidate\",";
        output << "\"stableParticipantAssignment\":false,";
        output << "\"avgScore\":" << candidate.avg_score << ',';
        output << "\"supportReplayCount\":" << candidate.support_replay_count;
        output << "},";
        output << "\"calibration\":";
        if (candidate.has_calibration) {
            output << "{\"slope\":" << candidate.slope << ",\"intercept\":" << candidate.intercept << '}';
        } else {
            output << "null";
        }
        output << ',';
        output << "\"points\":[";
        bool first_point = true;
        for (std::size_t record_index = 0; record_index < records.size(); ++record_index) {
            const auto& record = records[record_index];
            const std::size_t field_offset = candidate.header_size + (candidate.slot_index * candidate.stride) + candidate.offset;
            std::uint64_t raw_value = 0;
            double decoded_value = 0.0;
            if (!read_candidate_value(record.payload, field_offset, candidate.width, candidate.decode_label, raw_value, decoded_value)) {
                continue;
            }
            if (!first_point) {
                output << ',';
            }
            first_point = false;
            output << '{';
            output << "\"recordIndex\":" << record_index << ',';
            output << "\"segmentId\":" << record.segment_id << ',';
            output << "\"chunkId\":" << record.chunk_id << ',';
            output << "\"apiFrameIndex\":" << subrecord_api_frame_index(record) << ',';
            output << "\"timestamp\":" << subrecord_sample_timestamp_millis(record, summary, record_index, records.size() > 1 ? records.size() - 1 : 1) << ',';
            output << "\"rawValue\":" << raw_value << ',';
            output << "\"rawHex\":\"" << raw_hex(raw_value, candidate.width) << "\",";
            output << "\"decodedValue\":" << decoded_value << ',';
            if (candidate.has_calibration) {
                output << "\"calibratedValue\":" << ((candidate.slope * decoded_value) + candidate.intercept);
            } else {
                output << "\"calibratedValue\":null";
            }
            output << '}';
        }
        output << "]}";
    }
    output << "]}";
    return output.str();
}

std::string scan_keyframe_handle_graph_json(
    const std::string& path,
    std::size_t minimum_length,
    std::size_t top_families,
    std::size_t max_records_per_family,
    std::string_view focus_family_key,
    const std::vector<std::size_t>& focus_slots,
    std::size_t focus_neighbor_radius
) {
    struct HandleFamily {
        std::size_t length = 0;
        std::uint8_t first_byte = 0;
        std::size_t header_size = 0;
        std::size_t stride = 16;
        std::size_t row_count = 0;
        std::string key;
        std::vector<ExtractedSubrecord> records;
    };
    struct HeaderFinding {
        std::string family_key;
        std::size_t length = 0;
        std::uint8_t first_byte = 0;
        std::size_t header_size = 0;
        std::size_t stride = 16;
        std::size_t record_count = 0;
        std::string first16_hex;
        std::uint16_t u16le0 = 0;
        std::uint32_t u32le0 = 0;
        bool u16le0_equals_length = false;
        bool u32le0_equals_length = false;
        bool first_two_bytes_same_as_first_byte = false;
        std::size_t h0_element_count = 0;
        std::size_t h16_element_count = 0;
    };
    struct RowReferenceKey {
        std::size_t source_family = 0;
        std::size_t source_offset = 0;
        std::size_t target_family = 0;
        std::uint8_t width = 0;

        bool operator<(const RowReferenceKey& other) const {
            return std::tie(source_family, source_offset, target_family, width) <
                   std::tie(other.source_family, other.source_offset, other.target_family, other.width);
        }
    };
    struct RowReferenceAggregate {
        std::size_t count = 0;
        std::set<int> segment_ids;
        std::set<std::size_t> source_rows;
        std::set<std::size_t> target_rows;
        std::vector<std::string> examples;
    };
    struct LocalFamilyAggregate {
        std::size_t length = 0;
        std::uint8_t first_byte = 0;
        std::size_t record_count = 0;
        std::set<int> segment_ids;
    };

    const std::vector<std::uint8_t> bytes = read_file_bytes(path);
    const ReplaySummary summary = parse_replay_bytes(bytes);

    std::map<std::pair<std::size_t, std::uint8_t>, LocalFamilyAggregate> family_map;
    for (const ReplaySegmentSummary& segment : summary.container.segments) {
        if (segment.codec != "zstd" || segment.type != "keyframe") {
            continue;
        }
        std::vector<std::uint8_t> decompressed;
        std::string error;
        if (!try_decompress_zstd_segment(bytes, segment, decompressed, error)) {
            continue;
        }
        const auto framing = choose_best_le_length_prefix(decompressed);
        if (framing.record_count < 2) {
            continue;
        }
        const auto records = extract_le_framed_subrecords(decompressed, framing.width, framing.start_offset, 1000000);
        for (const FramedSubrecord& record : records) {
            if (record.length < minimum_length || record.payload_offset >= decompressed.size()) {
                continue;
            }
            const auto key = std::make_pair(record.length, decompressed[record.payload_offset]);
            auto& aggregate = family_map[key];
            aggregate.length = record.length;
            aggregate.first_byte = decompressed[record.payload_offset];
            aggregate.record_count += 1;
            aggregate.segment_ids.insert(segment.id);
        }
    }
    std::vector<LocalFamilyAggregate> ranked_families;
    for (const auto& [_, aggregate] : family_map) {
        if (aggregate.record_count >= 2) {
            ranked_families.push_back(aggregate);
        }
    }
    std::sort(ranked_families.begin(), ranked_families.end(), [](const LocalFamilyAggregate& left, const LocalFamilyAggregate& right) {
        if (left.segment_ids.size() != right.segment_ids.size()) {
            return left.segment_ids.size() > right.segment_ids.size();
        }
        if (left.record_count != right.record_count) {
            return left.record_count > right.record_count;
        }
        if (left.length != right.length) {
            return left.length > right.length;
        }
        return left.first_byte < right.first_byte;
    });

    auto family_key = [](std::size_t length, std::uint8_t first_byte, std::size_t header_size) {
        std::ostringstream key;
        key << length << "-0x" << std::hex << std::uppercase << std::setw(2) << std::setfill('0')
            << static_cast<int>(first_byte) << std::dec << "-h" << header_size;
        return key.str();
    };
    auto recommended_header_size = [](std::size_t length) -> std::size_t {
        if (length > 16 && ((length - 16) % 16) == 0) {
            return 16;
        }
        for (std::size_t header_size = 0; header_size <= 15; ++header_size) {
            if (length > header_size && ((length - header_size) % 16) == 0) {
                return header_size;
            }
        }
        return 0;
    };
    auto hex_prefix = [](const std::vector<std::uint8_t>& payload, std::size_t byte_count) {
        std::ostringstream stream;
        const std::size_t count = std::min(byte_count, payload.size());
        for (std::size_t index = 0; index < count; ++index) {
            stream << std::hex << std::uppercase << std::setw(2) << std::setfill('0')
                   << static_cast<int>(payload[index]);
        }
        return stream.str();
    };

    std::vector<HandleFamily> families;
    std::vector<HeaderFinding> header_findings;
    const std::size_t family_limit = top_families == 0 ? ranked_families.size() : std::min(top_families, ranked_families.size());
    for (std::size_t index = 0; index < family_limit; ++index) {
        const auto& ranked = ranked_families[index];
        HandleFamily family;
        family.length = ranked.length;
        family.first_byte = ranked.first_byte;
        family.header_size = recommended_header_size(family.length);
        family.stride = 16;
        family.key = family_key(family.length, family.first_byte, family.header_size);
        if (family.length > family.header_size) {
            family.row_count = (family.length - family.header_size) / family.stride;
        }
        family.records = extract_subrecord_family(bytes, summary, family.length, family.first_byte, "keyframe");
        if (max_records_per_family > 0 && family.records.size() > max_records_per_family) {
            family.records.resize(max_records_per_family);
        }
        if (family.records.empty()) {
            continue;
        }

        HeaderFinding finding;
        finding.family_key = family.key;
        finding.length = family.length;
        finding.first_byte = family.first_byte;
        finding.header_size = family.header_size;
        finding.stride = family.stride;
        finding.record_count = family.records.size();
        finding.first16_hex = hex_prefix(family.records.front().payload, 16);
        (void)read_u16_le(family.records.front().payload, 0, finding.u16le0);
        (void)read_u32_le(family.records.front().payload, 0, finding.u32le0);
        finding.u16le0_equals_length = finding.u16le0 == family.length;
        finding.u32le0_equals_length = finding.u32le0 == family.length;
        finding.first_two_bytes_same_as_first_byte =
            family.records.front().payload.size() >= 2 &&
            family.records.front().payload[0] == family.first_byte &&
            family.records.front().payload[1] == family.first_byte;
        finding.h0_element_count = (family.length % 16) == 0 ? family.length / 16 : 0;
        finding.h16_element_count = family.length > 16 && ((family.length - 16) % 16) == 0 ? (family.length - 16) / 16 : 0;
        header_findings.push_back(finding);
        families.push_back(std::move(family));
    }

    std::map<RowReferenceKey, RowReferenceAggregate> row_references;
    std::set<std::size_t> expanded_focus_slots;
    for (const std::size_t slot : focus_slots) {
        const std::size_t first = slot > focus_neighbor_radius ? slot - focus_neighbor_radius : 0;
        const std::size_t last = slot + focus_neighbor_radius;
        for (std::size_t expanded = first; expanded <= last; ++expanded) {
            expanded_focus_slots.insert(expanded);
            if (expanded == std::numeric_limits<std::size_t>::max()) {
                break;
            }
        }
    }
    auto read_value = [](const std::vector<std::uint8_t>& payload, std::size_t offset, std::uint8_t width, std::uint64_t& value) {
        if (width == 2) {
            std::uint16_t raw = 0;
            if (!read_u16_le(payload, offset, raw)) {
                return false;
            }
            value = raw;
            return true;
        }
        if (width == 4) {
            std::uint32_t raw = 0;
            if (!read_u32_le(payload, offset, raw)) {
                return false;
            }
            value = raw;
            return true;
        }
        if (width == 8) {
            std::uint64_t raw = 0;
            if (!read_u64_le(payload, offset, raw)) {
                return false;
            }
            value = raw;
            return true;
        }
        return false;
    };

    for (std::size_t source_family_index = 0; source_family_index < families.size(); ++source_family_index) {
        const auto& source_family = families[source_family_index];
        const bool use_focus =
            !expanded_focus_slots.empty() &&
            !focus_family_key.empty() &&
            source_family.key == focus_family_key;
        if (!expanded_focus_slots.empty() && !use_focus) {
            continue;
        }
        for (const auto& record : source_family.records) {
            for (std::size_t row = 0; row < source_family.row_count; ++row) {
                if (use_focus && expanded_focus_slots.find(row) == expanded_focus_slots.end()) {
                    continue;
                }
                const std::size_t row_offset = source_family.header_size + (row * source_family.stride);
                if (row_offset + source_family.stride > record.payload.size()) {
                    continue;
                }
                for (const std::uint8_t width : {std::uint8_t{2}, std::uint8_t{4}, std::uint8_t{8}}) {
                    for (std::size_t offset = 0; offset + width <= source_family.stride; offset += width) {
                        std::uint64_t value = 0;
                        if (!read_value(record.payload, row_offset + offset, width, value)) {
                            continue;
                        }
                        if (value <= 10 || value > 4096) {
                            continue;
                        }
                        for (std::size_t target_family_index = 0; target_family_index < families.size(); ++target_family_index) {
                            const auto& target_family = families[target_family_index];
                            if (value >= target_family.row_count) {
                                continue;
                            }
                            RowReferenceKey key{source_family_index, offset, target_family_index, width};
                            auto& aggregate = row_references[key];
                            aggregate.count += 1;
                            aggregate.segment_ids.insert(record.segment_id);
                            if (aggregate.source_rows.size() < 4096) {
                                aggregate.source_rows.insert(row);
                            }
                            if (aggregate.target_rows.size() < 4096) {
                                aggregate.target_rows.insert(static_cast<std::size_t>(value));
                            }
                            if (aggregate.examples.size() < 6) {
                                std::ostringstream example;
                                example << "{\"segmentId\":" << record.segment_id
                                        << ",\"chunkId\":" << record.chunk_id
                                        << ",\"sourceRowIndex\":" << row
                                        << ",\"targetRowIndex\":" << value
                                        << ",\"rawHex\":\"0x" << std::hex << std::uppercase << value << std::dec << "\"}";
                                aggregate.examples.push_back(example.str());
                            }
                        }
                    }
                }
            }
        }
    }

    std::vector<std::pair<RowReferenceKey, RowReferenceAggregate>> ranked_refs(row_references.begin(), row_references.end());
    std::sort(ranked_refs.begin(), ranked_refs.end(), [](const auto& left, const auto& right) {
        const auto& a = left.second;
        const auto& b = right.second;
        if (a.segment_ids.size() != b.segment_ids.size()) {
            return a.segment_ids.size() > b.segment_ids.size();
        }
        if (a.source_rows.size() != b.source_rows.size()) {
            return a.source_rows.size() > b.source_rows.size();
        }
        if (a.target_rows.size() != b.target_rows.size()) {
            return a.target_rows.size() > b.target_rows.size();
        }
        return a.count > b.count;
    });

    std::ostringstream output;
    output << '{';
    output << "\"schema\":\"keyframe-handle-graph-scan.v1\",";
    output << "\"replayPath\":\"" << json_escape(path) << "\",";
    output << "\"gameVersion\":\"" << json_escape(summary.game_version) << "\",";
    output << "\"versionGroup\":\"" << json_escape(keyframe_schema_version_group(summary.game_version)) << "\",";
    output << "\"minimumLength\":" << minimum_length << ',';
    output << "\"topFamilies\":" << family_limit << ',';
    output << "\"maxRecordsPerFamily\":" << max_records_per_family << ',';
    output << "\"focusFamilyKey\":\"" << json_escape(std::string(focus_family_key)) << "\",";
    output << "\"focusNeighborRadius\":" << focus_neighbor_radius << ',';
    output << "\"focusSlots\":";
    write_number_array(output, focus_slots);
    output << ',';
    output << "\"expandedFocusSlots\":";
    std::vector<std::size_t> expanded_focus_slot_values(expanded_focus_slots.begin(), expanded_focus_slots.end());
    write_number_array(output, expanded_focus_slot_values);
    output << ',';
    output << "\"families\":[";
    for (std::size_t index = 0; index < families.size(); ++index) {
        if (index > 0) {
            output << ',';
        }
        const auto& family = families[index];
        output << "{\"familyKey\":\"" << json_escape(family.key) << "\",";
        output << "\"length\":" << family.length << ',';
        output << "\"firstByte\":" << static_cast<int>(family.first_byte) << ',';
        output << "\"headerSize\":" << family.header_size << ',';
        output << "\"stride\":" << family.stride << ',';
        output << "\"rowCount\":" << family.row_count << ',';
        output << "\"recordCount\":" << family.records.size() << '}';
    }
    output << "],\"headerFindings\":[";
    for (std::size_t index = 0; index < header_findings.size(); ++index) {
        if (index > 0) {
            output << ',';
        }
        const auto& finding = header_findings[index];
        output << "{\"familyKey\":\"" << json_escape(finding.family_key) << "\",";
        output << "\"length\":" << finding.length << ',';
        output << "\"firstByte\":" << static_cast<int>(finding.first_byte) << ',';
        output << "\"headerSize\":" << finding.header_size << ',';
        output << "\"recordCount\":" << finding.record_count << ',';
        output << "\"first16Hex\":\"" << finding.first16_hex << "\",";
        output << "\"u16le0\":" << finding.u16le0 << ',';
        output << "\"u32le0\":" << finding.u32le0 << ',';
        output << "\"u16le0EqualsLength\":" << bool_to_json(finding.u16le0_equals_length) << ',';
        output << "\"u32le0EqualsLength\":" << bool_to_json(finding.u32le0_equals_length) << ',';
        output << "\"firstTwoBytesSameAsFirstByte\":" << bool_to_json(finding.first_two_bytes_same_as_first_byte) << ',';
        output << "\"h0ElementCount\":" << finding.h0_element_count << ',';
        output << "\"h16ElementCount\":" << finding.h16_element_count << '}';
    }
    output << "],\"rowReferencePatterns\":[";
    const std::size_t shown = std::min<std::size_t>(200, ranked_refs.size());
    for (std::size_t index = 0; index < shown; ++index) {
        if (index > 0) {
            output << ',';
        }
        const auto& [key, aggregate] = ranked_refs[index];
        output << "{\"sourceFamilyKey\":\"" << json_escape(families[key.source_family].key) << "\",";
        output << "\"sourceOffset\":" << key.source_offset << ',';
        output << "\"width\":" << static_cast<int>(key.width) << ',';
        output << "\"targetFamilyKey\":\"" << json_escape(families[key.target_family].key) << "\",";
        output << "\"targetRowCount\":" << families[key.target_family].row_count << ',';
        output << "\"count\":" << aggregate.count << ',';
        output << "\"segmentCount\":" << aggregate.segment_ids.size() << ',';
        output << "\"sourceRowCount\":" << aggregate.source_rows.size() << ',';
        output << "\"targetRowCountObserved\":" << aggregate.target_rows.size() << ',';
        output << "\"sourceRows\":";
        std::vector<std::size_t> source_rows(aggregate.source_rows.begin(), aggregate.source_rows.end());
        write_number_array(output, source_rows);
        output << ',';
        output << "\"targetRowsObserved\":";
        std::vector<std::size_t> target_rows(aggregate.target_rows.begin(), aggregate.target_rows.end());
        write_number_array(output, target_rows);
        output << ',';
        output << "\"examples\":[";
        for (std::size_t example_index = 0; example_index < aggregate.examples.size(); ++example_index) {
            if (example_index > 0) {
                output << ',';
            }
            output << aggregate.examples[example_index];
        }
        output << "]}";
    }
    output << "]}";
    return output.str();
}

std::string compare_positions_with_api(
    const std::string& replay_path,
    const std::string& api_positions_path,
    std::size_t target_length,
    std::uint8_t target_first_byte,
    std::size_t header_size,
    std::size_t stride,
    std::size_t top_slots,
    float move_epsilon,
    float smooth_threshold,
    int chunk_time_millis,
    int chunk_base_id,
    int max_time_offsets
) {
    std::ostringstream output;
    const std::vector<std::uint8_t> bytes = read_file_bytes(replay_path);
    const ReplaySummary summary = parse_replay_bytes(bytes);
    const std::uint8_t padding_byte = static_cast<std::uint8_t>(target_length & 0xFFu);
    const std::uint32_t padding_u32 = static_cast<std::uint32_t>(padding_byte) |
                                      (static_cast<std::uint32_t>(padding_byte) << 8U) |
                                      (static_cast<std::uint32_t>(padding_byte) << 16U) |
                                      (static_cast<std::uint32_t>(padding_byte) << 24U);
    const auto records = extract_subrecord_family(bytes, summary, target_length, target_first_byte);

    output << "ROFL/API position comparer for " << records.size() << " records of size " << target_length
           << " starting with 0x" << std::hex << std::uppercase << std::setw(2) << std::setfill('0')
           << static_cast<int>(target_first_byte) << std::dec << "\n\n";
    output << "Header size:      " << header_size << " bytes\n";
    output << "Stride:           " << stride << " bytes\n";
    output << "Move epsilon:     " << std::fixed << std::setprecision(2) << move_epsilon << "\n";
    output << "Smooth threshold: " << smooth_threshold << "\n";
    output << "Chunk time:       " << chunk_time_millis << " ms\n";
    output << "Chunk base id:    " << chunk_base_id << " (negative means auto)\n";
    output << "Max time offsets: " << max_time_offsets << " chunk steps\n";

    if (records.empty()) {
        output << "No matching sparse-family records were found.\n";
        return output.str();
    }
    if (header_size >= target_length) {
        output << "Header size must be smaller than the target record length.\n";
        return output.str();
    }
    if (stride == 0 || (stride % 4) != 0) {
        output << "Stride must be a non-zero multiple of 4 for lane analysis.\n";
        return output.str();
    }
    if (smooth_threshold <= 0.0F) {
        output << "Smooth threshold must be positive.\n";
        return output.str();
    }
    if (move_epsilon < 0.0F) {
        output << "Move epsilon must be non-negative.\n";
        return output.str();
    }
    if (chunk_time_millis <= 0) {
        output << "Chunk time must be positive.\n";
        return output.str();
    }

    const std::size_t usable_bytes = target_length - header_size;
    const std::size_t element_count = usable_bytes / stride;
    const std::size_t lane_count = std::min<std::size_t>(4, stride / 4);
    if (lane_count < 2) {
        output << "Need at least two 32-bit lanes to compare position-like tracks.\n";
        return output.str();
    }

    struct PairDefinition {
        std::size_t left_lane = 0;
        std::size_t right_lane = 0;
        std::string label;
    };
    struct PreviousSample {
        bool valid = false;
        std::size_t record_index = 0;
        float x = 0.0F;
        float y = 0.0F;
    };
    struct SlotPairProfile {
        std::size_t slot_index = 0;
        std::size_t pair_index = 0;
        std::size_t coordinate_samples = 0;
        std::size_t transitions = 0;
        std::size_t smooth_transitions = 0;
        std::size_t moving_transitions = 0;
        std::size_t active_records = 0;
        float min_x = std::numeric_limits<float>::infinity();
        float max_x = -std::numeric_limits<float>::infinity();
        float min_y = std::numeric_limits<float>::infinity();
        float max_y = -std::numeric_limits<float>::infinity();
        int min_chunk_id = std::numeric_limits<int>::max();
        int max_chunk_id = std::numeric_limits<int>::min();
        std::map<std::uint8_t, std::size_t> first_byte_freq;
        std::map<std::uint8_t, std::size_t> mask_freq;
    };
    struct RankedCandidate {
        std::size_t profile_index = 0;
        double score = 0.0;
        double smooth_ratio = 0.0;
        double moving_ratio = 0.0;
        double coverage = 0.0;
    };
    struct ApiPoint {
        double timestamp = 0.0;
        double x = 0.0;
        double y = 0.0;
    };
    struct ApiParticipant {
        int participant_id = 0;
        std::vector<ApiPoint> positions;
    };
    struct TrackPoint {
        int chunk_id = 0;
        double timestamp = 0.0;
        double x = 0.0;
        double y = 0.0;
    };
    struct CandidateTrack {
        const SlotPairProfile* profile = nullptr;
        std::vector<TrackPoint> points;
        std::uint8_t top_first = 0;
        std::uint8_t top_mask = 0;
    };
    struct MatchScore {
        std::size_t slot_index = 0;
        std::string pair_label;
        int participant_id = 0;
        int offset_ms = 0;
        double rmse = 0.0;
        double mean_distance = 0.0;
        std::size_t overlap = 0;
        std::size_t chunk_points = 0;
        double internal_score = 0.0;
        double smooth_ratio = 0.0;
        double moving_ratio = 0.0;
        double coverage = 0.0;
        std::uint8_t top_first = 0;
        std::uint8_t top_mask = 0;
    };

    std::vector<PairDefinition> pair_defs = {{0, 1, "+0/+4"}};
    if (lane_count >= 3) {
        pair_defs.push_back({1, 2, "+4/+8"});
        pair_defs.push_back({0, 2, "+0/+8"});
    }
    if (lane_count >= 4) {
        pair_defs.push_back({2, 3, "+8/+12"});
        pair_defs.push_back({0, 3, "+0/+12"});
    }

    const auto is_coordinate_like = [](float value) {
        return std::isfinite(value) && std::fpclassify(value) == FP_NORMAL && value >= -5000.0F && value <= 20000.0F;
    };
    const auto format_mask = [lane_count](std::uint8_t mask) {
        std::ostringstream line;
        for (int bit = static_cast<int>(lane_count) - 1; bit >= 0; --bit) {
            line << (((mask >> bit) & 1U) != 0U ? '1' : '0');
        }
        return line.str();
    };
    const auto top_freq_entry = [](const std::map<std::uint8_t, std::size_t>& freq) {
        if (freq.empty()) {
            return std::pair<std::uint8_t, std::size_t>{0, 0};
        }
        const auto it = std::max_element(freq.begin(), freq.end(), [](const auto& left, const auto& right) {
            if (left.second != right.second) {
                return left.second < right.second;
            }
            return left.first > right.first;
        });
        return std::pair<std::uint8_t, std::size_t>{it->first, it->second};
    };
    const auto extract_number = [](const std::string& line) {
        const std::size_t colon = line.find(':');
        if (colon == std::string::npos) {
            return 0.0;
        }
        const std::size_t start = line.find_first_of("-0123456789", colon + 1);
        if (start == std::string::npos) {
            return 0.0;
        }
        const std::size_t end = line.find_first_not_of("-+0123456789.eE", start);
        return std::stod(line.substr(start, end == std::string::npos ? std::string::npos : end - start));
    };
    const auto median = [](std::vector<float> values) {
        if (values.empty()) {
            return 0.0;
        }
        std::sort(values.begin(), values.end());
        const std::size_t middle = values.size() / 2;
        if ((values.size() % 2U) != 0U) {
            return static_cast<double>(values[middle]);
        }
        return (static_cast<double>(values[middle - 1]) + static_cast<double>(values[middle])) / 2.0;
    };

    const std::size_t profile_count = element_count * pair_defs.size();
    std::vector<SlotPairProfile> profiles(profile_count);
    std::vector<PreviousSample> previous_samples(profile_count);
    for (std::size_t slot_index = 0; slot_index < element_count; ++slot_index) {
        for (std::size_t pair_index = 0; pair_index < pair_defs.size(); ++pair_index) {
            auto& profile = profiles[(slot_index * pair_defs.size()) + pair_index];
            profile.slot_index = slot_index;
            profile.pair_index = pair_index;
        }
    }

    for (std::size_t record_index = 0; record_index < records.size(); ++record_index) {
        const auto& rec = records[record_index];
        for (std::size_t slot_index = 0; slot_index < element_count; ++slot_index) {
            const std::size_t start = header_size + (slot_index * stride);
            if (start + stride > rec.payload.size()) {
                break;
            }
            std::array<bool, 4> lane_is_coordinate = {false, false, false, false};
            std::array<float, 4> lane_floats = {0.0F, 0.0F, 0.0F, 0.0F};
            std::uint8_t mask = 0;
            bool active = false;
            for (std::size_t lane_index = 0; lane_index < lane_count; ++lane_index) {
                std::uint32_t value = 0;
                if (!read_u32_le(rec.payload, start + (lane_index * 4), value) || value == padding_u32) {
                    continue;
                }
                active = true;
                mask |= static_cast<std::uint8_t>(1U << lane_index);
                const float as_float = std::bit_cast<float>(value);
                if (is_coordinate_like(as_float)) {
                    lane_is_coordinate[lane_index] = true;
                    lane_floats[lane_index] = as_float;
                }
            }
            if (!active) {
                continue;
            }
            for (std::size_t pair_index = 0; pair_index < pair_defs.size(); ++pair_index) {
                const auto& pair = pair_defs[pair_index];
                auto& profile = profiles[(slot_index * pair_defs.size()) + pair_index];
                profile.active_records++;
                if (!lane_is_coordinate[pair.left_lane] || !lane_is_coordinate[pair.right_lane]) {
                    continue;
                }
                profile.coordinate_samples++;
                profile.first_byte_freq[rec.payload[start]]++;
                profile.mask_freq[mask]++;
                profile.min_x = std::min(profile.min_x, lane_floats[pair.left_lane]);
                profile.max_x = std::max(profile.max_x, lane_floats[pair.left_lane]);
                profile.min_y = std::min(profile.min_y, lane_floats[pair.right_lane]);
                profile.max_y = std::max(profile.max_y, lane_floats[pair.right_lane]);
                profile.min_chunk_id = std::min(profile.min_chunk_id, rec.chunk_id);
                profile.max_chunk_id = std::max(profile.max_chunk_id, rec.chunk_id);
                auto& previous = previous_samples[(slot_index * pair_defs.size()) + pair_index];
                if (previous.valid && previous.record_index + 1 == record_index) {
                    const float distance = std::hypot(lane_floats[pair.left_lane] - previous.x, lane_floats[pair.right_lane] - previous.y);
                    profile.transitions++;
                    if (distance <= smooth_threshold) {
                        profile.smooth_transitions++;
                        if (distance >= move_epsilon) {
                            profile.moving_transitions++;
                        }
                    }
                }
                previous.valid = true;
                previous.record_index = record_index;
                previous.x = lane_floats[pair.left_lane];
                previous.y = lane_floats[pair.right_lane];
            }
        }
    }

    std::vector<RankedCandidate> ranked_candidates;
    for (std::size_t profile_index = 0; profile_index < profiles.size(); ++profile_index) {
        const auto& profile = profiles[profile_index];
        if (profile.coordinate_samples < 8 || profile.transitions < 4 || profile.smooth_transitions == 0) {
            continue;
        }
        const double smooth_ratio = static_cast<double>(profile.smooth_transitions) / static_cast<double>(profile.transitions);
        const double moving_ratio = static_cast<double>(profile.moving_transitions) / static_cast<double>(profile.transitions);
        const double coverage = static_cast<double>(profile.coordinate_samples) / static_cast<double>(records.size());
        const float x_range = std::isfinite(profile.min_x) && std::isfinite(profile.max_x) ? profile.max_x - profile.min_x : 0.0F;
        const float y_range = std::isfinite(profile.min_y) && std::isfinite(profile.max_y) ? profile.max_y - profile.min_y : 0.0F;
        const double score = (static_cast<double>(profile.moving_transitions) + (0.5 * static_cast<double>(profile.smooth_transitions))) * (0.5 + smooth_ratio) * (0.25 + coverage) * (0.25 + std::min<double>(3.0, static_cast<double>(x_range + y_range) / 4000.0));
        ranked_candidates.push_back({profile_index, score, smooth_ratio, moving_ratio, coverage});
    }
    std::sort(ranked_candidates.begin(), ranked_candidates.end(), [&](const auto& left, const auto& right) {
        if (left.score != right.score) {
            return left.score > right.score;
        }
        return profiles[left.profile_index].coordinate_samples > profiles[right.profile_index].coordinate_samples;
    });
    output << "Candidate slot/pair profiles: " << ranked_candidates.size() << "\n";
    if (ranked_candidates.empty()) {
        output << "No position-like candidates met the minimum sample/transition thresholds.\n";
        return output.str();
    }
    if (top_slots == 0) {
        top_slots = 120;
    }
    const std::size_t shown_slots = std::min<std::size_t>(top_slots, ranked_candidates.size());
    output << "Top internal candidates compared: " << shown_slots << "\n";

    const std::vector<std::uint8_t> api_bytes = read_file_bytes(api_positions_path);
    std::istringstream api_stream(std::string(api_bytes.begin(), api_bytes.end()));
    std::vector<ApiParticipant> participants;
    ApiParticipant current_participant;
    for (std::string line; std::getline(api_stream, line); ) {
        if (line.find("\"participantId\"") != std::string::npos) {
            if (current_participant.participant_id != 0 && !current_participant.positions.empty()) {
                participants.push_back(current_participant);
                current_participant = {};
            }
            current_participant.participant_id = static_cast<int>(std::lround(extract_number(line)));
        } else if (line.find("\"timestamp\"") != std::string::npos) {
            ApiPoint point;
            point.timestamp = extract_number(line);
            if (!std::getline(api_stream, line)) {
                break;
            }
            point.x = extract_number(line);
            if (!std::getline(api_stream, line)) {
                break;
            }
            point.y = extract_number(line);
            current_participant.positions.push_back(point);
        }
    }
    if (current_participant.participant_id != 0 && !current_participant.positions.empty()) {
        participants.push_back(current_participant);
    }
    output << "API participants loaded: " << participants.size() << "\n";
    if (participants.empty()) {
        output << "No participant positions were found in the API positions JSON.\n";
        return output.str();
    }

    int derived_chunk_base_id = chunk_base_id;
    if (derived_chunk_base_id < 0) {
        derived_chunk_base_id = summary.container.game_start_chunk_id > 0 ? summary.container.game_start_chunk_id : profiles[ranked_candidates.front().profile_index].min_chunk_id;
    }
    output << "Derived chunk base id: " << derived_chunk_base_id << "\n\n";

    const auto interpolate_api = [](const ApiParticipant& participant, double timestamp, double& x, double& y) {
        if (participant.positions.empty()) {
            return false;
        }
        if (timestamp <= participant.positions.front().timestamp) {
            x = participant.positions.front().x;
            y = participant.positions.front().y;
            return true;
        }
        if (timestamp >= participant.positions.back().timestamp) {
            x = participant.positions.back().x;
            y = participant.positions.back().y;
            return true;
        }
        for (std::size_t index = 1; index < participant.positions.size(); ++index) {
            const auto& left = participant.positions[index - 1];
            const auto& right = participant.positions[index];
            if (timestamp <= right.timestamp) {
                const double ratio = (timestamp - left.timestamp) / (right.timestamp - left.timestamp);
                x = left.x + ((right.x - left.x) * ratio);
                y = left.y + ((right.y - left.y) * ratio);
                return true;
            }
        }
        return false;
    };
    const auto build_track = [&](const SlotPairProfile& profile) {
        std::map<int, std::pair<std::vector<float>, std::vector<float>>> per_chunk;
        const auto& pair = pair_defs[profile.pair_index];
        for (const auto& rec : records) {
            const std::size_t start = header_size + (profile.slot_index * stride);
            if (start + stride > rec.payload.size()) {
                continue;
            }
            std::uint32_t left_value = 0;
            std::uint32_t right_value = 0;
            if (!read_u32_le(rec.payload, start + (pair.left_lane * 4), left_value) || left_value == padding_u32) {
                continue;
            }
            if (!read_u32_le(rec.payload, start + (pair.right_lane * 4), right_value) || right_value == padding_u32) {
                continue;
            }
            const float left_float = std::bit_cast<float>(left_value);
            const float right_float = std::bit_cast<float>(right_value);
            if (!is_coordinate_like(left_float) || !is_coordinate_like(right_float)) {
                continue;
            }
            auto& bucket = per_chunk[rec.chunk_id];
            bucket.first.push_back(left_float);
            bucket.second.push_back(right_float);
        }
        std::vector<TrackPoint> points;
        for (const auto& [chunk_id, coords] : per_chunk) {
            points.push_back({chunk_id, static_cast<double>(chunk_id - derived_chunk_base_id) * static_cast<double>(chunk_time_millis), median(coords.first), median(coords.second)});
        }
        return points;
    };

    std::vector<CandidateTrack> candidate_tracks;
    for (std::size_t rank_index = 0; rank_index < shown_slots; ++rank_index) {
        const auto& ranked = ranked_candidates[rank_index];
        const auto& profile = profiles[ranked.profile_index];
        auto points = build_track(profile);
        if (points.size() < 8) {
            continue;
        }
        const auto top_first = top_freq_entry(profile.first_byte_freq);
        const auto top_mask = top_freq_entry(profile.mask_freq);
        candidate_tracks.push_back({&profile, std::move(points), top_first.first, top_mask.first});
    }
    output << "Candidate tracks with chunk-collapsed coordinates: " << candidate_tracks.size() << "\n";
    if (candidate_tracks.empty()) {
        output << "No candidate tracks survived chunk collapsing.\n";
        return output.str();
    }

    std::vector<MatchScore> matches;
    for (std::size_t rank_index = 0; rank_index < candidate_tracks.size(); ++rank_index) {
        const auto& track = candidate_tracks[rank_index];
        const auto& profile = *track.profile;
        const auto& pair = pair_defs[profile.pair_index];
        const auto& ranked = ranked_candidates[rank_index];
        for (const auto& participant : participants) {
            for (int offset_step = -max_time_offsets; offset_step <= max_time_offsets; ++offset_step) {
                const int offset_ms = offset_step * chunk_time_millis;
                double sum_distance = 0.0;
                double sum_square_distance = 0.0;
                std::size_t overlap = 0;
                for (const auto& point : track.points) {
                    double api_x = 0.0;
                    double api_y = 0.0;
                    if (!interpolate_api(participant, point.timestamp + static_cast<double>(offset_ms), api_x, api_y)) {
                        continue;
                    }
                    const double distance = std::hypot(point.x - api_x, point.y - api_y);
                    sum_distance += distance;
                    sum_square_distance += distance * distance;
                    overlap++;
                }
                if (overlap == 0) {
                    continue;
                }
                matches.push_back({profile.slot_index, pair.label, participant.participant_id, offset_ms, std::sqrt(sum_square_distance / static_cast<double>(overlap)), sum_distance / static_cast<double>(overlap), overlap, track.points.size(), ranked.score, ranked.smooth_ratio, ranked.moving_ratio, ranked.coverage, track.top_first, track.top_mask});
            }
        }
    }
    std::sort(matches.begin(), matches.end(), [](const auto& left, const auto& right) {
        if (left.rmse != right.rmse) {
            return left.rmse < right.rmse;
        }
        if (left.mean_distance != right.mean_distance) {
            return left.mean_distance < right.mean_distance;
        }
        if (left.overlap != right.overlap) {
            return left.overlap > right.overlap;
        }
        return left.internal_score > right.internal_score;
    });
    output << "Total candidate/API comparisons: " << matches.size() << "\n\n";
    if (matches.empty()) {
        output << "No candidate/API comparisons were possible.\n";
        return output.str();
    }

    output << "Best overall matches:\n";
    for (std::size_t index = 0; index < std::min<std::size_t>(25, matches.size()); ++index) {
        const auto& match = matches[index];
        output << "  #" << index + 1
               << " | slot=" << std::setw(4) << std::setfill('0') << match.slot_index << std::setfill(' ')
               << " | pair=" << match.pair_label
               << " | participant=" << match.participant_id
               << " | offsetMs=" << match.offset_ms
               << " | rmse=" << std::fixed << std::setprecision(2) << match.rmse
               << " | mean=" << match.mean_distance
               << " | overlap=" << match.overlap << '/' << match.chunk_points
               << " | internalScore=" << match.internal_score
               << " | smooth=" << match.smooth_ratio
               << " | moving=" << match.moving_ratio
               << " | coverage=" << match.coverage
               << " | first=0x" << std::hex << std::uppercase << std::setw(2) << std::setfill('0') << static_cast<int>(match.top_first)
               << std::dec << std::setfill(' ') << " | mask=" << format_mask(match.top_mask)
               << "\n";
    }

    std::set<int> used_participants;
    std::set<std::string> used_candidates;
    output << "\nGreedy participant assignment:\n";
    for (const auto& match : matches) {
        std::ostringstream candidate_key;
        candidate_key << match.slot_index << '|' << match.pair_label;
        if (used_participants.find(match.participant_id) != used_participants.end()) {
            continue;
        }
        if (used_candidates.find(candidate_key.str()) != used_candidates.end()) {
            continue;
        }
        used_participants.insert(match.participant_id);
        used_candidates.insert(candidate_key.str());
        output << "  P" << match.participant_id
               << " -> slot=" << std::setw(4) << std::setfill('0') << match.slot_index << std::setfill(' ')
               << " pair=" << match.pair_label
               << " offsetMs=" << match.offset_ms
               << " rmse=" << std::fixed << std::setprecision(2) << match.rmse
               << " mean=" << match.mean_distance
               << " overlap=" << match.overlap << '/' << match.chunk_points
               << " first=0x" << std::hex << std::uppercase << std::setw(2) << std::setfill('0') << static_cast<int>(match.top_first)
               << std::dec << std::setfill(' ') << " mask=" << format_mask(match.top_mask)
               << "\n";
        if (used_participants.size() >= participants.size()) {
            break;
        }
    }

    output << "\nInterpretation note:\n";
    output << "  Lower RMSE means the chunk-collapsed sparse slot track stays closer to the Riot timeline path.\n";
    output << "  If the best RMSE values remain in the several-thousand range, the current slot/pair extraction is still not decoding champion world positions cleanly.\n";
    return output.str();
}

std::string compare_raw_positions_with_api(
    const std::string& replay_path,
    const std::string& api_positions_path,
    std::size_t target_length,
    std::uint8_t target_first_byte,
    std::size_t header_size,
    std::size_t stride,
    std::size_t top_slots,
    float move_epsilon,
    float smooth_threshold,
    int chunk_time_millis,
    int chunk_base_id,
    int max_time_offsets
) {
    std::ostringstream output;
    const std::vector<std::uint8_t> bytes = read_file_bytes(replay_path);
    const ReplaySummary summary = parse_replay_bytes(bytes);
    const std::uint8_t padding_byte = static_cast<std::uint8_t>(target_length & 0xFFu);
    const std::uint32_t padding_u32 = static_cast<std::uint32_t>(padding_byte) |
                                      (static_cast<std::uint32_t>(padding_byte) << 8U) |
                                      (static_cast<std::uint32_t>(padding_byte) << 16U) |
                                      (static_cast<std::uint32_t>(padding_byte) << 24U);
    const auto records = extract_subrecord_family(bytes, summary, target_length, target_first_byte);

    output << "ROFL/API raw-sample comparer for " << records.size() << " records of size " << target_length
           << " starting with 0x" << std::hex << std::uppercase << std::setw(2) << std::setfill('0')
           << static_cast<int>(target_first_byte) << std::dec << "\n\n";
    output << "Header size:      " << header_size << " bytes\n";
    output << "Stride:           " << stride << " bytes\n";
    output << "Move epsilon:     " << std::fixed << std::setprecision(2) << move_epsilon << "\n";
    output << "Smooth threshold: " << smooth_threshold << "\n";
    output << "Chunk time:       " << chunk_time_millis << " ms\n";
    output << "Chunk base id:    " << chunk_base_id << " (negative means auto)\n";
    output << "Max time offsets: " << max_time_offsets << " chunk steps\n";

    if (records.empty()) {
        output << "No matching sparse-family records were found.\n";
        return output.str();
    }
    if (header_size >= target_length) {
        output << "Header size must be smaller than the target record length.\n";
        return output.str();
    }
    if (stride == 0 || (stride % 4) != 0) {
        output << "Stride must be a non-zero multiple of 4 for lane analysis.\n";
        return output.str();
    }
    if (smooth_threshold <= 0.0F) {
        output << "Smooth threshold must be positive.\n";
        return output.str();
    }
    if (move_epsilon < 0.0F) {
        output << "Move epsilon must be non-negative.\n";
        return output.str();
    }
    if (chunk_time_millis <= 0) {
        output << "Chunk time must be positive.\n";
        return output.str();
    }

    const std::size_t usable_bytes = target_length - header_size;
    const std::size_t element_count = usable_bytes / stride;
    const std::size_t lane_count = std::min<std::size_t>(4, stride / 4);
    if (lane_count < 2) {
        output << "Need at least two 32-bit lanes to compare raw position-like tracks.\n";
        return output.str();
    }

    struct PairDefinition {
        std::size_t left_lane = 0;
        std::size_t right_lane = 0;
        std::string label;
    };
    struct PreviousSample {
        bool valid = false;
        std::size_t record_index = 0;
        float x = 0.0F;
        float y = 0.0F;
    };
    struct SlotPairProfile {
        std::size_t slot_index = 0;
        std::size_t pair_index = 0;
        std::size_t coordinate_samples = 0;
        std::size_t transitions = 0;
        std::size_t smooth_transitions = 0;
        std::size_t moving_transitions = 0;
        std::size_t active_records = 0;
        float min_x = std::numeric_limits<float>::infinity();
        float max_x = -std::numeric_limits<float>::infinity();
        float min_y = std::numeric_limits<float>::infinity();
        float max_y = -std::numeric_limits<float>::infinity();
        int min_chunk_id = std::numeric_limits<int>::max();
        int max_chunk_id = std::numeric_limits<int>::min();
        std::map<std::uint8_t, std::size_t> first_byte_freq;
        std::map<std::uint8_t, std::size_t> mask_freq;
    };
    struct RankedCandidate {
        std::size_t profile_index = 0;
        double score = 0.0;
        double smooth_ratio = 0.0;
        double moving_ratio = 0.0;
        double coverage = 0.0;
    };
    struct ApiPoint {
        double timestamp = 0.0;
        double x = 0.0;
        double y = 0.0;
    };
    struct ApiParticipant {
        int participant_id = 0;
        std::vector<ApiPoint> positions;
    };
    struct RawPoint {
        int chunk_id = 0;
        double timestamp = 0.0;
        double x = 0.0;
        double y = 0.0;
    };
    struct CandidateTrack {
        const SlotPairProfile* profile = nullptr;
        std::vector<RawPoint> points;
        std::uint8_t top_first = 0;
        std::uint8_t top_mask = 0;
    };
    struct LineFit {
        bool valid = false;
        double slope = 1.0;
        double intercept = 0.0;
    };
    struct MatchScore {
        std::size_t slot_index = 0;
        std::string pair_label;
        int participant_id = 0;
        int offset_ms = 0;
        double identity_rmse = 0.0;
        double affine_rmse = 0.0;
        std::size_t overlap = 0;
        std::size_t raw_points = 0;
        double internal_score = 0.0;
        double smooth_ratio = 0.0;
        double moving_ratio = 0.0;
        double coverage = 0.0;
        std::uint8_t top_first = 0;
        std::uint8_t top_mask = 0;
        double x_slope = 1.0;
        double x_intercept = 0.0;
        double y_slope = 1.0;
        double y_intercept = 0.0;
        bool affine_valid = false;
    };

    std::vector<PairDefinition> pair_defs = {{0, 1, "+0/+4"}};
    if (lane_count >= 3) {
        pair_defs.push_back({1, 2, "+4/+8"});
        pair_defs.push_back({0, 2, "+0/+8"});
    }
    if (lane_count >= 4) {
        pair_defs.push_back({2, 3, "+8/+12"});
        pair_defs.push_back({0, 3, "+0/+12"});
    }

    const auto is_coordinate_like = [](float value) {
        return std::isfinite(value) && std::fpclassify(value) == FP_NORMAL && value >= -5000.0F && value <= 20000.0F;
    };
    const auto format_mask = [lane_count](std::uint8_t mask) {
        std::ostringstream line;
        for (int bit = static_cast<int>(lane_count) - 1; bit >= 0; --bit) {
            line << (((mask >> bit) & 1U) != 0U ? '1' : '0');
        }
        return line.str();
    };
    const auto top_freq_entry = [](const std::map<std::uint8_t, std::size_t>& freq) {
        if (freq.empty()) {
            return std::pair<std::uint8_t, std::size_t>{0, 0};
        }
        const auto it = std::max_element(freq.begin(), freq.end(), [](const auto& left, const auto& right) {
            if (left.second != right.second) {
                return left.second < right.second;
            }
            return left.first > right.first;
        });
        return std::pair<std::uint8_t, std::size_t>{it->first, it->second};
    };
    const auto extract_number = [](const std::string& line) {
        const std::size_t colon = line.find(':');
        if (colon == std::string::npos) {
            return 0.0;
        }
        const std::size_t start = line.find_first_of("-0123456789", colon + 1);
        if (start == std::string::npos) {
            return 0.0;
        }
        const std::size_t end = line.find_first_not_of("-+0123456789.eE", start);
        return std::stod(line.substr(start, end == std::string::npos ? std::string::npos : end - start));
    };
    const auto fit_line = [](const std::vector<double>& source, const std::vector<double>& target) {
        LineFit fit;
        if (source.size() != target.size() || source.size() < 2) {
            return fit;
        }
        double sum_source = 0.0;
        double sum_target = 0.0;
        for (std::size_t index = 0; index < source.size(); ++index) {
            sum_source += source[index];
            sum_target += target[index];
        }
        const double mean_source = sum_source / static_cast<double>(source.size());
        const double mean_target = sum_target / static_cast<double>(target.size());
        double numerator = 0.0;
        double denominator = 0.0;
        for (std::size_t index = 0; index < source.size(); ++index) {
            const double centered_source = source[index] - mean_source;
            numerator += centered_source * (target[index] - mean_target);
            denominator += centered_source * centered_source;
        }
        if (denominator < 1e-6) {
            return fit;
        }
        fit.valid = true;
        fit.slope = numerator / denominator;
        fit.intercept = mean_target - (fit.slope * mean_source);
        return fit;
    };

    const std::size_t profile_count = element_count * pair_defs.size();
    std::vector<SlotPairProfile> profiles(profile_count);
    std::vector<PreviousSample> previous_samples(profile_count);
    for (std::size_t slot_index = 0; slot_index < element_count; ++slot_index) {
        for (std::size_t pair_index = 0; pair_index < pair_defs.size(); ++pair_index) {
            auto& profile = profiles[(slot_index * pair_defs.size()) + pair_index];
            profile.slot_index = slot_index;
            profile.pair_index = pair_index;
        }
    }

    for (std::size_t record_index = 0; record_index < records.size(); ++record_index) {
        const auto& rec = records[record_index];
        for (std::size_t slot_index = 0; slot_index < element_count; ++slot_index) {
            const std::size_t start = header_size + (slot_index * stride);
            if (start + stride > rec.payload.size()) {
                break;
            }
            std::array<bool, 4> lane_is_coordinate = {false, false, false, false};
            std::array<float, 4> lane_floats = {0.0F, 0.0F, 0.0F, 0.0F};
            std::uint8_t mask = 0;
            bool active = false;
            for (std::size_t lane_index = 0; lane_index < lane_count; ++lane_index) {
                std::uint32_t value = 0;
                if (!read_u32_le(rec.payload, start + (lane_index * 4), value) || value == padding_u32) {
                    continue;
                }
                active = true;
                mask |= static_cast<std::uint8_t>(1U << lane_index);
                const float as_float = std::bit_cast<float>(value);
                if (is_coordinate_like(as_float)) {
                    lane_is_coordinate[lane_index] = true;
                    lane_floats[lane_index] = as_float;
                }
            }
            if (!active) {
                continue;
            }
            for (std::size_t pair_index = 0; pair_index < pair_defs.size(); ++pair_index) {
                const auto& pair = pair_defs[pair_index];
                auto& profile = profiles[(slot_index * pair_defs.size()) + pair_index];
                profile.active_records++;
                if (!lane_is_coordinate[pair.left_lane] || !lane_is_coordinate[pair.right_lane]) {
                    continue;
                }
                profile.coordinate_samples++;
                profile.first_byte_freq[rec.payload[start]]++;
                profile.mask_freq[mask]++;
                profile.min_x = std::min(profile.min_x, lane_floats[pair.left_lane]);
                profile.max_x = std::max(profile.max_x, lane_floats[pair.left_lane]);
                profile.min_y = std::min(profile.min_y, lane_floats[pair.right_lane]);
                profile.max_y = std::max(profile.max_y, lane_floats[pair.right_lane]);
                profile.min_chunk_id = std::min(profile.min_chunk_id, rec.chunk_id);
                profile.max_chunk_id = std::max(profile.max_chunk_id, rec.chunk_id);
                auto& previous = previous_samples[(slot_index * pair_defs.size()) + pair_index];
                if (previous.valid && previous.record_index + 1 == record_index) {
                    const float distance = std::hypot(lane_floats[pair.left_lane] - previous.x, lane_floats[pair.right_lane] - previous.y);
                    profile.transitions++;
                    if (distance <= smooth_threshold) {
                        profile.smooth_transitions++;
                        if (distance >= move_epsilon) {
                            profile.moving_transitions++;
                        }
                    }
                }
                previous.valid = true;
                previous.record_index = record_index;
                previous.x = lane_floats[pair.left_lane];
                previous.y = lane_floats[pair.right_lane];
            }
        }
    }

    std::vector<RankedCandidate> ranked_candidates;
    for (std::size_t profile_index = 0; profile_index < profiles.size(); ++profile_index) {
        const auto& profile = profiles[profile_index];
        if (profile.coordinate_samples < 12 || profile.transitions < 6 || profile.smooth_transitions == 0) {
            continue;
        }
        const double smooth_ratio = static_cast<double>(profile.smooth_transitions) / static_cast<double>(profile.transitions);
        const double moving_ratio = static_cast<double>(profile.moving_transitions) / static_cast<double>(profile.transitions);
        const double coverage = static_cast<double>(profile.coordinate_samples) / static_cast<double>(records.size());
        const float x_range = std::isfinite(profile.min_x) && std::isfinite(profile.max_x) ? profile.max_x - profile.min_x : 0.0F;
        const float y_range = std::isfinite(profile.min_y) && std::isfinite(profile.max_y) ? profile.max_y - profile.min_y : 0.0F;
        const double score = (static_cast<double>(profile.moving_transitions) + (0.5 * static_cast<double>(profile.smooth_transitions))) * (0.5 + smooth_ratio) * (0.25 + coverage) * (0.25 + std::min<double>(3.0, static_cast<double>(x_range + y_range) / 4000.0));
        ranked_candidates.push_back({profile_index, score, smooth_ratio, moving_ratio, coverage});
    }
    std::sort(ranked_candidates.begin(), ranked_candidates.end(), [&](const auto& left, const auto& right) {
        if (left.score != right.score) {
            return left.score > right.score;
        }
        return profiles[left.profile_index].coordinate_samples > profiles[right.profile_index].coordinate_samples;
    });
    output << "Candidate slot/pair profiles: " << ranked_candidates.size() << "\n";
    if (ranked_candidates.empty()) {
        output << "No position-like candidates met the minimum sample/transition thresholds.\n";
        return output.str();
    }
    if (top_slots == 0) {
        top_slots = 120;
    }
    const std::size_t shown_slots = std::min<std::size_t>(top_slots, ranked_candidates.size());
    output << "Top internal candidates compared: " << shown_slots << "\n";

    const std::vector<std::uint8_t> api_bytes = read_file_bytes(api_positions_path);
    std::istringstream api_stream(std::string(api_bytes.begin(), api_bytes.end()));
    std::vector<ApiParticipant> participants;
    ApiParticipant current_participant;
    for (std::string line; std::getline(api_stream, line); ) {
        if (line.find("\"participantId\"") != std::string::npos) {
            if (current_participant.participant_id != 0 && !current_participant.positions.empty()) {
                participants.push_back(current_participant);
                current_participant = {};
            }
            current_participant.participant_id = static_cast<int>(std::lround(extract_number(line)));
        } else if (line.find("\"timestamp\"") != std::string::npos) {
            ApiPoint point;
            point.timestamp = extract_number(line);
            if (!std::getline(api_stream, line)) {
                break;
            }
            point.x = extract_number(line);
            if (!std::getline(api_stream, line)) {
                break;
            }
            point.y = extract_number(line);
            current_participant.positions.push_back(point);
        }
    }
    if (current_participant.participant_id != 0 && !current_participant.positions.empty()) {
        participants.push_back(current_participant);
    }
    output << "API participants loaded: " << participants.size() << "\n";
    if (participants.empty()) {
        output << "No participant positions were found in the API positions JSON.\n";
        return output.str();
    }

    int derived_chunk_base_id = chunk_base_id;
    if (derived_chunk_base_id < 0) {
        derived_chunk_base_id = summary.container.game_start_chunk_id > 0 ? summary.container.game_start_chunk_id : profiles[ranked_candidates.front().profile_index].min_chunk_id;
    }
    output << "Derived chunk base id: " << derived_chunk_base_id << "\n\n";

    const auto interpolate_api = [](const ApiParticipant& participant, double timestamp, double& x, double& y) {
        if (participant.positions.empty()) {
            return false;
        }
        if (timestamp <= participant.positions.front().timestamp) {
            x = participant.positions.front().x;
            y = participant.positions.front().y;
            return true;
        }
        if (timestamp >= participant.positions.back().timestamp) {
            x = participant.positions.back().x;
            y = participant.positions.back().y;
            return true;
        }
        for (std::size_t index = 1; index < participant.positions.size(); ++index) {
            const auto& left = participant.positions[index - 1];
            const auto& right = participant.positions[index];
            if (timestamp <= right.timestamp) {
                const double ratio = (timestamp - left.timestamp) / (right.timestamp - left.timestamp);
                x = left.x + ((right.x - left.x) * ratio);
                y = left.y + ((right.y - left.y) * ratio);
                return true;
            }
        }
        return false;
    };

    std::map<int, std::size_t> chunk_sizes;
    for (const auto& rec : records) {
        chunk_sizes[rec.chunk_id]++;
    }
    const auto build_track = [&](const SlotPairProfile& profile) {
        std::map<int, std::size_t> chunk_seen;
        std::vector<RawPoint> points;
        points.reserve(profile.coordinate_samples);
        const auto& pair = pair_defs[profile.pair_index];
        for (const auto& rec : records) {
            const std::size_t start = header_size + (profile.slot_index * stride);
            if (start + stride > rec.payload.size()) {
                continue;
            }
            const std::size_t sample_index = chunk_seen[rec.chunk_id]++;
            std::uint32_t left_value = 0;
            std::uint32_t right_value = 0;
            if (!read_u32_le(rec.payload, start + (pair.left_lane * 4), left_value) || left_value == padding_u32) {
                continue;
            }
            if (!read_u32_le(rec.payload, start + (pair.right_lane * 4), right_value) || right_value == padding_u32) {
                continue;
            }
            const float left_float = std::bit_cast<float>(left_value);
            const float right_float = std::bit_cast<float>(right_value);
            if (!is_coordinate_like(left_float) || !is_coordinate_like(right_float)) {
                continue;
            }
            const auto count_it = chunk_sizes.find(rec.chunk_id);
            const double chunk_count = count_it == chunk_sizes.end() || count_it->second == 0 ? 1.0 : static_cast<double>(count_it->second);
            const double intra_chunk_ratio = (static_cast<double>(sample_index) + 0.5) / chunk_count;
            const double timestamp = (static_cast<double>(rec.chunk_id - derived_chunk_base_id) + intra_chunk_ratio) * static_cast<double>(chunk_time_millis);
            points.push_back({rec.chunk_id, timestamp, left_float, right_float});
        }
        return points;
    };

    std::vector<CandidateTrack> candidate_tracks;
    for (std::size_t rank_index = 0; rank_index < shown_slots; ++rank_index) {
        const auto& ranked = ranked_candidates[rank_index];
        const auto& profile = profiles[ranked.profile_index];
        auto points = build_track(profile);
        if (points.size() < 16) {
            continue;
        }
        const auto top_first = top_freq_entry(profile.first_byte_freq);
        const auto top_mask = top_freq_entry(profile.mask_freq);
        candidate_tracks.push_back({&profile, std::move(points), top_first.first, top_mask.first});
    }
    output << "Candidate tracks with raw coordinates: " << candidate_tracks.size() << "\n";
    if (candidate_tracks.empty()) {
        output << "No candidate tracks survived raw-sample extraction.\n";
        return output.str();
    }

    std::vector<MatchScore> matches;
    for (std::size_t rank_index = 0; rank_index < candidate_tracks.size(); ++rank_index) {
        const auto& track = candidate_tracks[rank_index];
        const auto& profile = *track.profile;
        const auto& pair = pair_defs[profile.pair_index];
        const auto& ranked = ranked_candidates[rank_index];
        for (const auto& participant : participants) {
            for (int offset_step = -max_time_offsets; offset_step <= max_time_offsets; ++offset_step) {
                const int offset_ms = offset_step * chunk_time_millis;
                double identity_sum_square = 0.0;
                std::vector<double> raw_x;
                std::vector<double> raw_y;
                std::vector<double> api_x;
                std::vector<double> api_y;
                raw_x.reserve(track.points.size());
                raw_y.reserve(track.points.size());
                api_x.reserve(track.points.size());
                api_y.reserve(track.points.size());
                for (const auto& point : track.points) {
                    double interpolated_x = 0.0;
                    double interpolated_y = 0.0;
                    if (!interpolate_api(participant, point.timestamp + static_cast<double>(offset_ms), interpolated_x, interpolated_y)) {
                        continue;
                    }
                    const double dx = point.x - interpolated_x;
                    const double dy = point.y - interpolated_y;
                    identity_sum_square += (dx * dx) + (dy * dy);
                    raw_x.push_back(point.x);
                    raw_y.push_back(point.y);
                    api_x.push_back(interpolated_x);
                    api_y.push_back(interpolated_y);
                }
                const std::size_t overlap = raw_x.size();
                if (overlap < 12) {
                    continue;
                }

                const double identity_rmse = std::sqrt(identity_sum_square / static_cast<double>(overlap));
                const auto x_fit = fit_line(raw_x, api_x);
                const auto y_fit = fit_line(raw_y, api_y);
                double affine_rmse = identity_rmse;
                if (x_fit.valid && y_fit.valid) {
                    double affine_sum_square = 0.0;
                    for (std::size_t index = 0; index < overlap; ++index) {
                        const double fitted_x = (x_fit.slope * raw_x[index]) + x_fit.intercept;
                        const double fitted_y = (y_fit.slope * raw_y[index]) + y_fit.intercept;
                        const double dx = fitted_x - api_x[index];
                        const double dy = fitted_y - api_y[index];
                        affine_sum_square += (dx * dx) + (dy * dy);
                    }
                    affine_rmse = std::sqrt(affine_sum_square / static_cast<double>(overlap));
                }

                matches.push_back({
                    profile.slot_index,
                    pair.label,
                    participant.participant_id,
                    offset_ms,
                    identity_rmse,
                    affine_rmse,
                    overlap,
                    track.points.size(),
                    ranked.score,
                    ranked.smooth_ratio,
                    ranked.moving_ratio,
                    ranked.coverage,
                    track.top_first,
                    track.top_mask,
                    x_fit.slope,
                    x_fit.intercept,
                    y_fit.slope,
                    y_fit.intercept,
                    x_fit.valid && y_fit.valid
                });
            }
        }
    }

    std::sort(matches.begin(), matches.end(), [](const MatchScore& left, const MatchScore& right) {
        if (left.affine_valid != right.affine_valid) {
            return left.affine_valid > right.affine_valid;
        }
        if (left.affine_rmse != right.affine_rmse) {
            return left.affine_rmse < right.affine_rmse;
        }
        if (left.identity_rmse != right.identity_rmse) {
            return left.identity_rmse < right.identity_rmse;
        }
        if (left.overlap != right.overlap) {
            return left.overlap > right.overlap;
        }
        return left.internal_score > right.internal_score;
    });
    output << "Total raw candidate/API comparisons: " << matches.size() << "\n\n";
    if (matches.empty()) {
        output << "No raw candidate/API comparisons were possible.\n";
        return output.str();
    }

    output << "Best raw-sample matches:\n";
    for (std::size_t index = 0; index < std::min<std::size_t>(25, matches.size()); ++index) {
        const auto& match = matches[index];
        output << "  #" << index + 1
               << " | slot=" << std::setw(4) << std::setfill('0') << match.slot_index << std::setfill(' ')
               << " | pair=" << match.pair_label
               << " | participant=" << match.participant_id
               << " | offsetMs=" << match.offset_ms
               << " | identityRmse=" << std::fixed << std::setprecision(2) << match.identity_rmse
               << " | affineRmse=" << match.affine_rmse
               << " | overlap=" << match.overlap << '/' << match.raw_points
               << " | affine=" << (match.affine_valid ? "yes" : "no")
               << " | x=(" << match.x_slope << " * raw + " << match.x_intercept << ")"
               << " | y=(" << match.y_slope << " * raw + " << match.y_intercept << ")"
               << " | smooth=" << match.smooth_ratio
               << " | moving=" << match.moving_ratio
               << " | coverage=" << match.coverage
               << " | first=0x" << std::hex << std::uppercase << std::setw(2) << std::setfill('0') << static_cast<int>(match.top_first)
               << std::dec << std::setfill(' ') << " | mask=" << format_mask(match.top_mask)
               << "\n";
    }

    output << "\nInterpretation note:\n";
    output << "  identityRmse compares raw ROFL coordinates directly against API coordinates using pseudo-timestamps within each chunk.\n";
    output << "  affineRmse additionally fits x' = a*x + b and y' = c*y + d to test whether the ROFL path is a scaled or shifted version of the API path.\n";
    output << "  If affineRmse drops sharply while identityRmse stays large, the warp hypothesis becomes much more plausible.\n";
    return output.str();
}
struct JsonFamilyAggregate {
    std::size_t length = 0;
    std::uint8_t first_byte = 0;
    std::size_t record_count = 0;
    std::set<int> chunk_ids;
    std::set<int> segment_ids;
};

struct JsonFamilyScanResult {
    std::string segment_type = "chunk";
    std::size_t scanned_segment_count = 0;
    std::size_t scanned_chunk_count = 0;
    std::vector<JsonFamilyAggregate> ranked_families;
};

[[nodiscard]] JsonFamilyScanResult collect_ranked_chunk_families(
    const std::vector<std::uint8_t>& bytes,
    std::size_t minimum_length,
    std::size_t minimum_records,
    std::string_view segment_type = "chunk"
) {
    const ReplaySummary summary = parse_replay_bytes(bytes);
    const std::string segment_filter = normalize_segment_type_filter(segment_type);
    std::map<std::pair<std::size_t, std::uint8_t>, JsonFamilyAggregate> families;
    std::size_t scanned_segment_count = 0;
    std::size_t scanned_chunk_count = 0;

    for (const ReplaySegmentSummary& segment : summary.container.segments) {
        if (segment.codec != "zstd" || !segment_type_matches_filter(segment.type, segment_filter)) {
            continue;
        }

        std::vector<std::uint8_t> decompressed;
        std::string error;
        if (!try_decompress_zstd_segment(bytes, segment, decompressed, error)) {
            continue;
        }

        const auto framing = choose_best_le_length_prefix(decompressed);
        if (framing.record_count < 2) {
            continue;
        }

        const auto records = extract_le_framed_subrecords(decompressed, framing.width, framing.start_offset, 1000000);
        if (records.empty()) {
            continue;
        }

        scanned_segment_count += 1;
        if (segment.type == "chunk") {
            scanned_chunk_count += 1;
        }
        for (const FramedSubrecord& record : records) {
            if (record.length < minimum_length || record.payload_offset >= decompressed.size()) {
                continue;
            }

            const auto key = std::make_pair(record.length, decompressed[record.payload_offset]);
            auto& aggregate = families[key];
            aggregate.length = record.length;
            aggregate.first_byte = decompressed[record.payload_offset];
            aggregate.record_count += 1;
            aggregate.chunk_ids.insert(segment.chunk_id);
            aggregate.segment_ids.insert(segment.id);
        }
    }

    std::vector<JsonFamilyAggregate> ranked;
    ranked.reserve(families.size());
    for (const auto& entry : families) {
        if (entry.second.record_count >= minimum_records) {
            ranked.push_back(entry.second);
        }
    }

    std::sort(ranked.begin(), ranked.end(), [](const JsonFamilyAggregate& left, const JsonFamilyAggregate& right) {
        if (left.segment_ids.size() != right.segment_ids.size()) {
            return left.segment_ids.size() > right.segment_ids.size();
        }
        if (left.record_count != right.record_count) {
            return left.record_count > right.record_count;
        }
        if (left.length != right.length) {
            return left.length > right.length;
        }
        return left.first_byte < right.first_byte;
    });

    return {segment_filter, scanned_segment_count, scanned_chunk_count, ranked};
}

[[nodiscard]] std::string u32_hex(std::uint32_t value) {
    std::ostringstream output;
    output << "0x" << std::hex << std::uppercase << std::setw(8) << std::setfill('0') << value;
    return output.str();
}

[[nodiscard]] std::string bytes_to_hex(const std::vector<std::uint8_t>& bytes) {
    std::ostringstream output;
    output << std::hex << std::uppercase << std::setfill('0');
    for (const std::uint8_t value : bytes) {
        output << std::setw(2) << static_cast<int>(value);
    }
    return output.str();
}

std::string scan_replay_families_json(
    const std::vector<std::uint8_t>& bytes,
    std::size_t minimum_length,
    std::size_t minimum_records,
    std::size_t top_families,
    std::string_view segment_type
) {
    const auto scan = collect_ranked_chunk_families(bytes, minimum_length, minimum_records, segment_type);

    if (top_families == 0) {
        top_families = 20;
    }
    const std::size_t shown = std::min<std::size_t>(top_families, scan.ranked_families.size());

    std::ostringstream output;
    output << '{';
    output << "\"segmentType\":\"" << json_escape(scan.segment_type) << "\",";
    output << "\"scannedSegmentCount\":" << scan.scanned_segment_count << ',';
    output << "\"scannedChunkCount\":" << scan.scanned_chunk_count << ',';
    output << "\"minimumLength\":" << minimum_length << ',';
    output << "\"minimumRecords\":" << minimum_records << ',';
    output << "\"families\":[";
    for (std::size_t index = 0; index < shown; ++index) {
        const JsonFamilyAggregate& family = scan.ranked_families[index];
        if (index > 0) {
            output << ',';
        }
        output << '{';
        output << "\"length\":" << family.length << ',';
        output << "\"firstByte\":" << static_cast<int>(family.first_byte) << ',';
        output << "\"paddingByte\":" << static_cast<int>(family.length & 0xFFu) << ',';
        output << "\"recordCount\":" << family.record_count << ',';
        output << "\"segmentCount\":" << family.segment_ids.size() << ',';
        output << "\"chunkCount\":" << family.chunk_ids.size() << ',';
        output << "\"segmentSpanStart\":" << (family.segment_ids.empty() ? 0 : *family.segment_ids.begin()) << ',';
        output << "\"segmentSpanEnd\":" << (family.segment_ids.empty() ? 0 : *family.segment_ids.rbegin()) << ',';
        output << "\"chunkSpanStart\":" << (family.chunk_ids.empty() ? 0 : *family.chunk_ids.begin()) << ',';
        output << "\"chunkSpanEnd\":" << (family.chunk_ids.empty() ? 0 : *family.chunk_ids.rbegin()) << ',';
        output << "\"recommendedStride\":16,";
        output << "\"headerSizeCandidates\":[";
        bool first_candidate = true;
        int recommended_header_size = -1;
        for (std::size_t header_size = 0; header_size <= 16; ++header_size) {
            if (family.length <= header_size || ((family.length - header_size) % 16) != 0) {
                continue;
            }
            if (!first_candidate) {
                output << ',';
            }
            first_candidate = false;
            if (recommended_header_size < 0) {
                recommended_header_size = static_cast<int>(header_size);
            }
            output << '{';
            output << "\"headerSize\":" << header_size << ',';
            output << "\"elementCount\":" << ((family.length - header_size) / 16);
            output << '}';
        }
        output << "],";
        output << "\"recommendedHeaderSize\":" << recommended_header_size;
        output << '}';
    }
    output << "]}";
    return output.str();
}

std::string scan_replay_families_file_json(
    const std::string& path,
    std::size_t minimum_length,
    std::size_t minimum_records,
    std::size_t top_families,
    std::string_view segment_type
) {
    const auto bytes = read_file_bytes(path);
    return scan_replay_families_json(bytes, minimum_length, minimum_records, top_families, segment_type);
}

std::string analyze_sparse_family_json(
    const std::vector<std::uint8_t>& bytes,
    std::size_t target_length,
    std::uint8_t target_first_byte,
    std::size_t header_size,
    std::size_t stride,
    std::size_t top_slots,
    float move_epsilon,
    float smooth_threshold,
    std::string_view segment_type
) {
    struct PairDefinition {
        std::size_t left_lane = 0;
        std::size_t right_lane = 0;
        std::string label;
    };

    struct PreviousSample {
        bool valid = false;
        std::size_t record_index = 0;
        float x = 0.0F;
        float y = 0.0F;
    };

    struct SlotPairProfile {
        std::size_t slot_index = 0;
        std::size_t pair_index = 0;
        std::size_t coordinate_samples = 0;
        std::size_t transitions = 0;
        std::size_t smooth_transitions = 0;
        std::size_t moving_transitions = 0;
        std::size_t active_records = 0;
        double total_distance = 0.0;
        float max_distance = 0.0F;
        float min_x = std::numeric_limits<float>::infinity();
        float max_x = -std::numeric_limits<float>::infinity();
        float min_y = std::numeric_limits<float>::infinity();
        float max_y = -std::numeric_limits<float>::infinity();
        int min_chunk_id = std::numeric_limits<int>::max();
        int max_chunk_id = std::numeric_limits<int>::min();
        std::map<std::uint8_t, std::size_t> first_byte_freq;
        std::map<std::uint8_t, std::size_t> mask_freq;
    };

    struct RankedCandidate {
        std::size_t profile_index = 0;
        double score = 0.0;
        double smooth_ratio = 0.0;
        double moving_ratio = 0.0;
        double coverage = 0.0;
        float x_range = 0.0F;
        float y_range = 0.0F;
    };

    struct TrackPoint {
        int chunk_id = 0;
        std::size_t record_index = 0;
        int timestamp = 0;
        float x = 0.0F;
        float y = 0.0F;
        std::uint8_t mask = 0;
        std::uint8_t first_byte = 0;
    };

    struct ClassAggregate {
        std::size_t members = 0;
        double best_score = 0.0;
        std::size_t total_coordinate_samples = 0;
        std::size_t total_moving_transitions = 0;
    };

    const ReplaySummary summary = parse_replay_bytes(bytes);
    const std::string segment_filter = normalize_segment_type_filter(segment_type);
    const auto records = extract_subrecord_family(bytes, summary, target_length, target_first_byte, segment_filter);
    std::ostringstream output;

    output << '{';
    output << "\"segmentType\":\"" << json_escape(segment_filter) << "\",";
    output << "\"length\":" << target_length << ',';
    output << "\"firstByte\":" << static_cast<int>(target_first_byte) << ',';
    output << "\"recordCount\":" << records.size() << ',';
    output << "\"headerSize\":" << header_size << ',';
    output << "\"stride\":" << stride << ',';
    output << "\"gameLengthMillis\":" << summary.game_length_millis << ',';
    output << "\"chunkBaseId\":" << (summary.container.game_start_chunk_id > 0 ? summary.container.game_start_chunk_id : 0) << ',';

    if (records.empty()) {
        output << "\"elementCount\":0,";
        output << "\"laneCount\":0,";
        output << "\"candidates\":[],";
        output << "\"classes\":[]}";
        return output.str();
    }
    if (header_size >= target_length) {
        output << "\"error\":\"Header size must be smaller than the target record length.\"}";
        return output.str();
    }
    if (stride == 0 || (stride % 4) != 0) {
        output << "\"error\":\"Stride must be a non-zero multiple of 4 for lane analysis.\"}";
        return output.str();
    }
    if (smooth_threshold <= 0.0F) {
        output << "\"error\":\"Smooth threshold must be positive.\"}";
        return output.str();
    }
    if (move_epsilon < 0.0F) {
        output << "\"error\":\"Move epsilon must be non-negative.\"}";
        return output.str();
    }

    const std::uint8_t padding_byte = static_cast<std::uint8_t>(target_length & 0xFFu);
    const std::uint32_t padding_u32 = static_cast<std::uint32_t>(padding_byte) |
                                      (static_cast<std::uint32_t>(padding_byte) << 8U) |
                                      (static_cast<std::uint32_t>(padding_byte) << 16U) |
                                      (static_cast<std::uint32_t>(padding_byte) << 24U);
    const std::size_t usable_bytes = target_length - header_size;
    const std::size_t element_count = usable_bytes / stride;
    const std::size_t lane_count = std::min<std::size_t>(4, stride / 4);

    output << "\"elementCount\":" << element_count << ',';
    output << "\"laneCount\":" << lane_count << ',';

    if (lane_count < 2) {
        output << "\"error\":\"Need at least two 32-bit lanes to compare coordinate pairs.\",\"candidates\":[],\"classes\":[]}";
        return output.str();
    }

    std::vector<PairDefinition> pair_defs = {{0, 1, "+0/+4"}};
    if (lane_count >= 3) {
        pair_defs.push_back({1, 2, "+4/+8"});
        pair_defs.push_back({0, 2, "+0/+8"});
    }
    if (lane_count >= 4) {
        pair_defs.push_back({2, 3, "+8/+12"});
        pair_defs.push_back({0, 3, "+0/+12"});
    }

    const auto is_coordinate_like = [](float value) {
        return std::isfinite(value) && std::fpclassify(value) == FP_NORMAL && value >= -5000.0F && value <= 20000.0F;
    };
    const auto top_freq_entry = [](const std::map<std::uint8_t, std::size_t>& freq) {
        if (freq.empty()) {
            return std::pair<std::uint8_t, std::size_t>{0, 0};
        }
        const auto it = std::max_element(freq.begin(), freq.end(), [](const auto& left, const auto& right) {
            if (left.second != right.second) {
                return left.second < right.second;
            }
            return left.first > right.first;
        });
        return std::pair<std::uint8_t, std::size_t>{it->first, it->second};
    };
    const auto mask_string = [lane_count](std::uint8_t mask) {
        std::string bits;
        bits.reserve(lane_count);
        for (int bit = static_cast<int>(lane_count) - 1; bit >= 0; --bit) {
            bits += (((mask >> bit) & 1U) != 0U) ? '1' : '0';
        }
        return bits;
    };

    const std::size_t profile_count = element_count * pair_defs.size();
    std::vector<SlotPairProfile> profiles(profile_count);
    std::vector<PreviousSample> previous_samples(profile_count);
    for (std::size_t slot_index = 0; slot_index < element_count; ++slot_index) {
        for (std::size_t pair_index = 0; pair_index < pair_defs.size(); ++pair_index) {
            auto& profile = profiles[(slot_index * pair_defs.size()) + pair_index];
            profile.slot_index = slot_index;
            profile.pair_index = pair_index;
        }
    }

    for (std::size_t record_index = 0; record_index < records.size(); ++record_index) {
        const auto& rec = records[record_index];
        for (std::size_t slot_index = 0; slot_index < element_count; ++slot_index) {
            const std::size_t start = header_size + (slot_index * stride);
            if (start + stride > rec.payload.size()) {
                break;
            }

            std::array<bool, 4> lane_is_coordinate = {false, false, false, false};
            std::array<float, 4> lane_floats = {0.0F, 0.0F, 0.0F, 0.0F};
            std::uint8_t mask = 0;
            bool active = false;

            for (std::size_t lane_index = 0; lane_index < lane_count; ++lane_index) {
                std::uint32_t value = 0;
                if (!read_u32_le(rec.payload, start + (lane_index * 4), value) || value == padding_u32) {
                    continue;
                }
                active = true;
                mask |= static_cast<std::uint8_t>(1U << lane_index);
                const float as_float = std::bit_cast<float>(value);
                if (is_coordinate_like(as_float)) {
                    lane_is_coordinate[lane_index] = true;
                    lane_floats[lane_index] = as_float;
                }
            }

            if (!active) {
                continue;
            }

            for (std::size_t pair_index = 0; pair_index < pair_defs.size(); ++pair_index) {
                const auto& pair = pair_defs[pair_index];
                auto& profile = profiles[(slot_index * pair_defs.size()) + pair_index];
                profile.active_records++;
                if (!lane_is_coordinate[pair.left_lane] || !lane_is_coordinate[pair.right_lane]) {
                    continue;
                }

                profile.coordinate_samples++;
                profile.first_byte_freq[rec.payload[start]]++;
                profile.mask_freq[mask]++;
                profile.min_x = std::min(profile.min_x, lane_floats[pair.left_lane]);
                profile.max_x = std::max(profile.max_x, lane_floats[pair.left_lane]);
                profile.min_y = std::min(profile.min_y, lane_floats[pair.right_lane]);
                profile.max_y = std::max(profile.max_y, lane_floats[pair.right_lane]);
                profile.min_chunk_id = std::min(profile.min_chunk_id, rec.chunk_id);
                profile.max_chunk_id = std::max(profile.max_chunk_id, rec.chunk_id);

                auto& previous = previous_samples[(slot_index * pair_defs.size()) + pair_index];
                if (previous.valid && previous.record_index + 1 == record_index) {
                    const float distance = std::hypot(lane_floats[pair.left_lane] - previous.x, lane_floats[pair.right_lane] - previous.y);
                    profile.transitions++;
                    profile.total_distance += distance;
                    profile.max_distance = std::max(profile.max_distance, distance);
                    if (distance <= smooth_threshold) {
                        profile.smooth_transitions++;
                        if (distance >= move_epsilon) {
                            profile.moving_transitions++;
                        }
                    }
                }

                previous.valid = true;
                previous.record_index = record_index;
                previous.x = lane_floats[pair.left_lane];
                previous.y = lane_floats[pair.right_lane];
            }
        }
    }

    std::vector<RankedCandidate> ranked_candidates;
    ranked_candidates.reserve(profile_count);
    for (std::size_t profile_index = 0; profile_index < profiles.size(); ++profile_index) {
        const auto& profile = profiles[profile_index];
        if (profile.coordinate_samples < 8 || profile.transitions < 4 || profile.smooth_transitions == 0) {
            continue;
        }

        const float x_range = std::isfinite(profile.min_x) && std::isfinite(profile.max_x) ? profile.max_x - profile.min_x : 0.0F;
        const float y_range = std::isfinite(profile.min_y) && std::isfinite(profile.max_y) ? profile.max_y - profile.min_y : 0.0F;
        const double smooth_ratio = static_cast<double>(profile.smooth_transitions) / static_cast<double>(profile.transitions);
        const double moving_ratio = static_cast<double>(profile.moving_transitions) / static_cast<double>(profile.transitions);
        const double coverage = static_cast<double>(profile.coordinate_samples) / static_cast<double>(records.size());
        const double range_score = std::min<double>(3.0, static_cast<double>(x_range + y_range) / 4000.0);
        const double score = (static_cast<double>(profile.moving_transitions) + (0.5 * static_cast<double>(profile.smooth_transitions))) *
                             (0.5 + smooth_ratio) *
                             (0.25 + coverage) *
                             (0.25 + range_score);
        ranked_candidates.push_back({profile_index, score, smooth_ratio, moving_ratio, coverage, x_range, y_range});
    }

    std::sort(ranked_candidates.begin(), ranked_candidates.end(), [&](const RankedCandidate& left, const RankedCandidate& right) {
        if (left.score != right.score) {
            return left.score > right.score;
        }
        if (left.moving_ratio != right.moving_ratio) {
            return left.moving_ratio > right.moving_ratio;
        }
        if (left.smooth_ratio != right.smooth_ratio) {
            return left.smooth_ratio > right.smooth_ratio;
        }
        return profiles[left.profile_index].coordinate_samples > profiles[right.profile_index].coordinate_samples;
    });

    if (top_slots == 0) {
        top_slots = 24;
    }
    const std::size_t shown = std::min<std::size_t>(top_slots, ranked_candidates.size());
    std::map<std::size_t, std::vector<TrackPoint>> tracks_by_profile;
    std::vector<std::size_t> selected_profiles;
    selected_profiles.reserve(shown);
    for (std::size_t index = 0; index < shown; ++index) {
        selected_profiles.push_back(ranked_candidates[index].profile_index);
        tracks_by_profile.emplace(ranked_candidates[index].profile_index, std::vector<TrackPoint>{});
    }

    const std::size_t max_record_index = records.size() > 1 ? (records.size() - 1) : 1;
    for (std::size_t record_index = 0; record_index < records.size(); ++record_index) {
        const auto& rec = records[record_index];
        const int timestamp = summary.game_length_millis > 0
            ? static_cast<int>(std::llround((static_cast<double>(summary.game_length_millis) * static_cast<double>(record_index)) / static_cast<double>(max_record_index)))
            : static_cast<int>(record_index * 1000);

        for (const std::size_t profile_index : selected_profiles) {
            const auto& profile = profiles[profile_index];
            const auto& pair = pair_defs[profile.pair_index];
            const std::size_t start = header_size + (profile.slot_index * stride);
            if (start + stride > rec.payload.size()) {
                continue;
            }

            std::array<bool, 4> lane_is_coordinate = {false, false, false, false};
            std::array<float, 4> lane_floats = {0.0F, 0.0F, 0.0F, 0.0F};
            std::uint8_t mask = 0;
            for (std::size_t lane_index = 0; lane_index < lane_count; ++lane_index) {
                std::uint32_t value = 0;
                if (!read_u32_le(rec.payload, start + (lane_index * 4), value) || value == padding_u32) {
                    continue;
                }
                mask |= static_cast<std::uint8_t>(1U << lane_index);
                const float as_float = std::bit_cast<float>(value);
                if (is_coordinate_like(as_float)) {
                    lane_is_coordinate[lane_index] = true;
                    lane_floats[lane_index] = as_float;
                }
            }
            if (!lane_is_coordinate[pair.left_lane] || !lane_is_coordinate[pair.right_lane]) {
                continue;
            }

            tracks_by_profile[profile_index].push_back({
                rec.chunk_id,
                record_index,
                timestamp,
                lane_floats[pair.left_lane],
                lane_floats[pair.right_lane],
                mask,
                rec.payload[start]
            });
        }
    }

    std::map<std::string, ClassAggregate> class_counts;
    output << "\"candidates\":[";
    for (std::size_t rank_index = 0; rank_index < shown; ++rank_index) {
        const auto& ranked = ranked_candidates[rank_index];
        const auto& profile = profiles[ranked.profile_index];
        const auto& pair = pair_defs[profile.pair_index];
        const auto top_first = top_freq_entry(profile.first_byte_freq);
        const auto top_mask = top_freq_entry(profile.mask_freq);
        const double avg_distance = profile.transitions == 0 ? 0.0 : (profile.total_distance / static_cast<double>(profile.transitions));
        std::ostringstream class_key_builder;
        class_key_builder << pair.label << "|first=0x" << std::hex << std::uppercase << std::setw(2) << std::setfill('0') << static_cast<int>(top_first.first) << std::dec << std::setfill(' ') << "|mask=" << mask_string(top_mask.first);
        const std::string class_key = class_key_builder.str();

        auto& aggregate = class_counts[class_key];
        aggregate.members++;
        aggregate.best_score = std::max(aggregate.best_score, ranked.score);
        aggregate.total_coordinate_samples += profile.coordinate_samples;
        aggregate.total_moving_transitions += profile.moving_transitions;

        if (rank_index > 0) {
            output << ',';
        }
        output << '{';
        output << "\"rank\":" << (rank_index + 1) << ',';
        output << "\"slotIndex\":" << profile.slot_index << ',';
        output << "\"pairLabel\":\"" << json_escape(pair.label) << "\",";
        output << "\"leftLane\":" << pair.left_lane << ',';
        output << "\"rightLane\":" << pair.right_lane << ',';
        output << "\"classKey\":\"" << json_escape(class_key) << "\",";
        output << "\"score\":" << std::fixed << std::setprecision(4) << ranked.score << ',';
        output << "\"coordinateSamples\":" << profile.coordinate_samples << ',';
        output << "\"transitions\":" << profile.transitions << ',';
        output << "\"smoothTransitions\":" << profile.smooth_transitions << ',';
        output << "\"movingTransitions\":" << profile.moving_transitions << ',';
        output << "\"smoothRatio\":" << ranked.smooth_ratio << ',';
        output << "\"movingRatio\":" << ranked.moving_ratio << ',';
        output << "\"coverage\":" << ranked.coverage << ',';
        output << "\"avgDistance\":" << avg_distance << ',';
        output << "\"maxDistance\":" << profile.max_distance << ',';
        output << "\"xRange\":" << ranked.x_range << ',';
        output << "\"yRange\":" << ranked.y_range << ',';
        output << "\"topFirstByte\":" << static_cast<int>(top_first.first) << ',';
        output << "\"topFirstByteCount\":" << top_first.second << ',';
        output << "\"topMask\":" << static_cast<int>(top_mask.first) << ',';
        output << "\"topMaskBits\":\"" << mask_string(top_mask.first) << "\",";
        output << "\"topMaskCount\":" << top_mask.second << ',';
        output << "\"chunkSpanStart\":" << (profile.min_chunk_id == std::numeric_limits<int>::max() ? 0 : profile.min_chunk_id) << ',';
        output << "\"chunkSpanEnd\":" << (profile.max_chunk_id == std::numeric_limits<int>::min() ? 0 : profile.max_chunk_id) << ',';
        output << "\"samples\":[";
        const auto& track_points = tracks_by_profile[ranked.profile_index];
        for (std::size_t point_index = 0; point_index < track_points.size(); ++point_index) {
            const auto& point = track_points[point_index];
            if (point_index > 0) {
                output << ',';
            }
            output << '{';
            output << "\"chunkId\":" << point.chunk_id << ',';
            output << "\"recordIndex\":" << point.record_index << ',';
            output << "\"timestamp\":" << point.timestamp << ',';
            output << "\"x\":" << std::fixed << std::setprecision(2) << point.x << ',';
            output << "\"y\":" << std::fixed << std::setprecision(2) << point.y << ',';
            output << "\"mask\":" << static_cast<int>(point.mask) << ',';
            output << "\"maskBits\":\"" << mask_string(point.mask) << "\",";
            output << "\"firstByte\":" << static_cast<int>(point.first_byte);
            output << '}';
        }
        output << "]}";
    }
    output << "],";

    output << "\"classes\":[";
    std::vector<std::pair<std::string, ClassAggregate>> sorted_classes(class_counts.begin(), class_counts.end());
    std::sort(sorted_classes.begin(), sorted_classes.end(), [](const auto& left, const auto& right) {
        if (left.second.members != right.second.members) {
            return left.second.members > right.second.members;
        }
        if (left.second.best_score != right.second.best_score) {
            return left.second.best_score > right.second.best_score;
        }
        return left.first < right.first;
    });
    for (std::size_t index = 0; index < sorted_classes.size(); ++index) {
        const auto& [key, aggregate] = sorted_classes[index];
        if (index > 0) {
            output << ',';
        }
        output << '{';
        output << "\"key\":\"" << json_escape(key) << "\",";
        output << "\"members\":" << aggregate.members << ',';
        output << "\"bestScore\":" << std::fixed << std::setprecision(4) << aggregate.best_score << ',';
        output << "\"totalCoordinateSamples\":" << aggregate.total_coordinate_samples << ',';
        output << "\"totalMovingTransitions\":" << aggregate.total_moving_transitions;
        output << '}';
    }
    output << "]}";
    return output.str();
}
std::string analyze_scalar_family_json(
    const std::vector<std::uint8_t>& bytes,
    std::size_t target_length,
    std::uint8_t target_first_byte,
    std::size_t header_size,
    std::size_t stride,
    std::size_t top_slots,
    std::string_view segment_type
) {
    struct SlotSummary {
        std::size_t slot_index = 0;
        std::size_t active_records = 0;
        std::size_t total_lane_samples = 0;
        std::size_t max_active_lanes = 0;
        int min_chunk_id = std::numeric_limits<int>::max();
        int max_chunk_id = std::numeric_limits<int>::min();
        std::map<std::uint8_t, std::size_t> first_byte_freq;
        std::map<std::uint8_t, std::size_t> mask_freq;
    };

    struct RankedSlot {
        std::size_t slot_index = 0;
        double score = 0.0;
    };

    struct LaneSample {
        int segment_id = 0;
        std::string segment_type;
        int chunk_id = 0;
        std::size_t record_index = 0;
        int api_frame_index = -1;
        int timestamp = 0;
        std::uint32_t raw_u32 = 0;
        std::uint8_t first_byte = 0;
        std::uint8_t mask = 0;
    };

    const ReplaySummary summary = parse_replay_bytes(bytes);
    const std::string segment_filter = normalize_segment_type_filter(segment_type);
    const auto records = extract_subrecord_family(bytes, summary, target_length, target_first_byte, segment_filter);
    std::ostringstream output;

    output << '{';
    output << "\"segmentType\":\"" << json_escape(segment_filter) << "\",";
    output << "\"length\":" << target_length << ',';
    output << "\"firstByte\":" << static_cast<int>(target_first_byte) << ',';
    output << "\"recordCount\":" << records.size() << ',';
    output << "\"headerSize\":" << header_size << ',';
    output << "\"stride\":" << stride << ',';
    output << "\"gameLengthMillis\":" << summary.game_length_millis << ',';
    output << "\"chunkBaseId\":" << (summary.container.game_start_chunk_id > 0 ? summary.container.game_start_chunk_id : 0) << ',';

    if (records.empty()) {
        output << "\"elementCount\":0,";
        output << "\"laneCount\":0,";
        output << "\"slots\":[]}";
        return output.str();
    }
    if (header_size >= target_length) {
        output << "\"error\":\"Header size must be smaller than the target record length.\"}";
        return output.str();
    }
    if (stride == 0 || (stride % 4) != 0) {
        output << "\"error\":\"Stride must be a non-zero multiple of 4 for scalar lane analysis.\"}";
        return output.str();
    }

    const std::uint8_t padding_byte = static_cast<std::uint8_t>(target_length & 0xFFu);
    const std::uint32_t padding_u32 = static_cast<std::uint32_t>(padding_byte) |
                                      (static_cast<std::uint32_t>(padding_byte) << 8U) |
                                      (static_cast<std::uint32_t>(padding_byte) << 16U) |
                                      (static_cast<std::uint32_t>(padding_byte) << 24U);
    const std::size_t usable_bytes = target_length - header_size;
    const std::size_t element_count = usable_bytes / stride;
    const std::size_t lane_count = std::min<std::size_t>(4, stride / 4);

    output << "\"elementCount\":" << element_count << ',';
    output << "\"laneCount\":" << lane_count << ',';

    if (lane_count == 0) {
        output << "\"error\":\"Need at least one 32-bit lane to compare scalar values.\",\"slots\":[]}";
        return output.str();
    }

    const auto top_freq_entry = [](const std::map<std::uint8_t, std::size_t>& freq) {
        if (freq.empty()) {
            return std::pair<std::uint8_t, std::size_t>{0, 0};
        }
        const auto it = std::max_element(freq.begin(), freq.end(), [](const auto& left, const auto& right) {
            if (left.second != right.second) {
                return left.second < right.second;
            }
            return left.first > right.first;
        });
        return std::pair<std::uint8_t, std::size_t>{it->first, it->second};
    };
    const auto mask_string = [lane_count](std::uint8_t mask) {
        std::string bits;
        bits.reserve(lane_count);
        for (int bit = static_cast<int>(lane_count) - 1; bit >= 0; --bit) {
            bits += (((mask >> bit) & 1U) != 0U) ? '1' : '0';
        }
        return bits;
    };

    std::vector<SlotSummary> slots(element_count);
    for (std::size_t slot_index = 0; slot_index < element_count; ++slot_index) {
        slots[slot_index].slot_index = slot_index;
    }

    for (const auto& rec : records) {
        for (std::size_t slot_index = 0; slot_index < element_count; ++slot_index) {
            const std::size_t start = header_size + (slot_index * stride);
            if (start + stride > rec.payload.size()) {
                break;
            }

            std::uint8_t mask = 0;
            std::size_t active_lanes = 0;
            for (std::size_t lane_index = 0; lane_index < lane_count; ++lane_index) {
                std::uint32_t value = 0;
                if (!read_u32_le(rec.payload, start + (lane_index * 4), value) || value == padding_u32) {
                    continue;
                }
                mask |= static_cast<std::uint8_t>(1U << lane_index);
                active_lanes++;
            }
            if (active_lanes == 0) {
                continue;
            }

            auto& slot = slots[slot_index];
            slot.active_records++;
            slot.total_lane_samples += active_lanes;
            slot.max_active_lanes = std::max(slot.max_active_lanes, active_lanes);
            slot.min_chunk_id = std::min(slot.min_chunk_id, rec.chunk_id);
            slot.max_chunk_id = std::max(slot.max_chunk_id, rec.chunk_id);
            slot.first_byte_freq[rec.payload[start]]++;
            slot.mask_freq[mask]++;
        }
    }

    std::vector<RankedSlot> ranked_slots;
    ranked_slots.reserve(slots.size());
    for (const auto& slot : slots) {
        if (slot.active_records < 4) {
            continue;
        }
        const double average_active_lanes = slot.active_records > 0
            ? static_cast<double>(slot.total_lane_samples) / static_cast<double>(slot.active_records)
            : 0.0;
        const double chunk_span = (slot.min_chunk_id == std::numeric_limits<int>::max() || slot.max_chunk_id == std::numeric_limits<int>::min())
            ? 0.0
            : static_cast<double>(slot.max_chunk_id - slot.min_chunk_id + 1);
        const double score = static_cast<double>(slot.active_records) * (0.5 + average_active_lanes) * (1.0 + (chunk_span / 32.0));
        ranked_slots.push_back({slot.slot_index, score});
    }

    std::sort(ranked_slots.begin(), ranked_slots.end(), [&](const RankedSlot& left, const RankedSlot& right) {
        if (left.score != right.score) {
            return left.score > right.score;
        }
        const auto& left_slot = slots[left.slot_index];
        const auto& right_slot = slots[right.slot_index];
        if (left_slot.active_records != right_slot.active_records) {
            return left_slot.active_records > right_slot.active_records;
        }
        if (left_slot.total_lane_samples != right_slot.total_lane_samples) {
            return left_slot.total_lane_samples > right_slot.total_lane_samples;
        }
        return left.slot_index < right.slot_index;
    });

    if (top_slots == 0) {
        top_slots = 24;
    }
    const std::size_t shown = std::min<std::size_t>(top_slots, ranked_slots.size());
    const std::size_t max_record_index = records.size() > 1 ? (records.size() - 1) : 1;

    output << "\"slots\":[";
    for (std::size_t rank_index = 0; rank_index < shown; ++rank_index) {
        const auto& ranked = ranked_slots[rank_index];
        const auto& slot_summary = slots[ranked.slot_index];
        const auto top_first = top_freq_entry(slot_summary.first_byte_freq);
        const auto top_mask = top_freq_entry(slot_summary.mask_freq);
        std::vector<std::vector<LaneSample>> lane_samples(lane_count);
        std::vector<std::size_t> non_zero_samples(lane_count, 0);
        std::vector<std::size_t> changed_transitions(lane_count, 0);
        std::vector<std::size_t> transitions(lane_count, 0);
        std::vector<std::uint32_t> min_u32(lane_count, std::numeric_limits<std::uint32_t>::max());
        std::vector<std::uint32_t> max_u32(lane_count, 0);
        std::vector<float> min_f32(lane_count, std::numeric_limits<float>::infinity());
        std::vector<float> max_f32(lane_count, -std::numeric_limits<float>::infinity());
        std::vector<std::map<std::uint32_t, std::size_t>> unique_values(lane_count);
        std::vector<bool> previous_valid(lane_count, false);
        std::vector<std::uint32_t> previous_values(lane_count, 0);

        for (std::size_t record_index = 0; record_index < records.size(); ++record_index) {
            const auto& rec = records[record_index];
            const std::size_t start = header_size + (ranked.slot_index * stride);
            if (start + stride > rec.payload.size()) {
                continue;
            }

            const int timestamp = subrecord_sample_timestamp_millis(rec, summary, record_index, max_record_index);

            std::uint8_t mask = 0;
            std::array<std::uint32_t, 4> lane_values = {0, 0, 0, 0};
            for (std::size_t lane_index = 0; lane_index < lane_count; ++lane_index) {
                std::uint32_t value = 0;
                if (!read_u32_le(rec.payload, start + (lane_index * 4), value) || value == padding_u32) {
                    continue;
                }
                mask |= static_cast<std::uint8_t>(1U << lane_index);
                lane_values[lane_index] = value;
            }

            for (std::size_t lane_index = 0; lane_index < lane_count; ++lane_index) {
                const std::uint32_t value = lane_values[lane_index];
                if (((mask >> lane_index) & 1U) == 0U) {
                    continue;
                }

                lane_samples[lane_index].push_back({
                    rec.segment_id,
                    rec.segment_type,
                    rec.chunk_id,
                    record_index,
                    subrecord_api_frame_index(rec),
                    timestamp,
                    value,
                    rec.payload[start],
                    mask,
                });
                unique_values[lane_index][value]++;
                if (value != 0) {
                    non_zero_samples[lane_index]++;
                }
                min_u32[lane_index] = std::min(min_u32[lane_index], value);
                max_u32[lane_index] = std::max(max_u32[lane_index], value);
                const float as_float = std::bit_cast<float>(value);
                if (std::isfinite(as_float)) {
                    min_f32[lane_index] = std::min(min_f32[lane_index], as_float);
                    max_f32[lane_index] = std::max(max_f32[lane_index], as_float);
                }
                if (previous_valid[lane_index]) {
                    transitions[lane_index]++;
                    if (previous_values[lane_index] != value) {
                        changed_transitions[lane_index]++;
                    }
                }
                previous_valid[lane_index] = true;
                previous_values[lane_index] = value;
            }
        }

        if (rank_index > 0) {
            output << ',';
        }
        output << '{';
        output << "\"rank\":" << (rank_index + 1) << ',';
        output << "\"slotIndex\":" << ranked.slot_index << ',';
        output << "\"score\":" << std::fixed << std::setprecision(4) << ranked.score << ',';
        output << "\"activeRecords\":" << slot_summary.active_records << ',';
        output << "\"totalLaneSamples\":" << slot_summary.total_lane_samples << ',';
        output << "\"maxActiveLanes\":" << slot_summary.max_active_lanes << ',';
        output << "\"topFirstByte\":" << static_cast<int>(top_first.first) << ',';
        output << "\"topFirstByteCount\":" << top_first.second << ',';
        output << "\"topMask\":" << static_cast<int>(top_mask.first) << ',';
        output << "\"topMaskBits\":\"" << mask_string(top_mask.first) << "\",";
        output << "\"topMaskCount\":" << top_mask.second << ',';
        output << "\"chunkSpanStart\":" << (slot_summary.min_chunk_id == std::numeric_limits<int>::max() ? 0 : slot_summary.min_chunk_id) << ',';
        output << "\"chunkSpanEnd\":" << (slot_summary.max_chunk_id == std::numeric_limits<int>::min() ? 0 : slot_summary.max_chunk_id) << ',';
        output << "\"lanes\":[";
        for (std::size_t lane_index = 0; lane_index < lane_count; ++lane_index) {
            if (lane_index > 0) {
                output << ',';
            }
            output << '{';
            output << "\"laneIndex\":" << lane_index << ',';
            output << "\"activeSamples\":" << lane_samples[lane_index].size() << ',';
            output << "\"nonZeroSamples\":" << non_zero_samples[lane_index] << ',';
            output << "\"uniqueValues\":" << unique_values[lane_index].size() << ',';
            output << "\"transitions\":" << transitions[lane_index] << ',';
            output << "\"changedTransitions\":" << changed_transitions[lane_index] << ',';
            output << "\"minU32\":" << (lane_samples[lane_index].empty() ? 0 : min_u32[lane_index]) << ',';
            output << "\"maxU32\":" << (lane_samples[lane_index].empty() ? 0 : max_u32[lane_index]) << ',';
            output << "\"minFiniteF32\":" << (std::isfinite(min_f32[lane_index]) ? min_f32[lane_index] : 0.0F) << ',';
            output << "\"maxFiniteF32\":" << (std::isfinite(max_f32[lane_index]) ? max_f32[lane_index] : 0.0F) << ',';
            output << "\"samples\":[";
            for (std::size_t sample_index = 0; sample_index < lane_samples[lane_index].size(); ++sample_index) {
                const auto& sample = lane_samples[lane_index][sample_index];
                if (sample_index > 0) {
                    output << ',';
                }
                output << '{';
                output << "\"segmentId\":" << sample.segment_id << ',';
                output << "\"segmentType\":\"" << json_escape(sample.segment_type) << "\",";
                output << "\"chunkId\":" << sample.chunk_id << ',';
                output << "\"recordIndex\":" << sample.record_index << ',';
                output << "\"apiFrameIndex\":" << sample.api_frame_index << ',';
                output << "\"timestamp\":" << sample.timestamp << ',';
                output << "\"rawU32\":" << sample.raw_u32 << ',';
                output << "\"firstByte\":" << static_cast<int>(sample.first_byte) << ',';
                output << "\"mask\":" << static_cast<int>(sample.mask) << ',';
                output << "\"maskBits\":\"" << mask_string(sample.mask) << "\"";
                output << '}';
            }
            output << "]}";
        }
        output << "]}";
    }
    output << "]}";
    return output.str();
}

std::string analyze_scalar_family_file_json(
    const std::string& path,
    std::size_t target_length,
    std::uint8_t target_first_byte,
    std::size_t header_size,
    std::size_t stride,
    std::size_t top_slots,
    std::string_view segment_type
) {
    const auto bytes = read_file_bytes(path);
    return analyze_scalar_family_json(bytes, target_length, target_first_byte, header_size, stride, top_slots, segment_type);
}


std::string analyze_entity_slab_json(
    const std::vector<std::uint8_t>& bytes,
    std::size_t target_length,
    std::uint8_t target_first_byte,
    std::size_t header_size,
    std::size_t stride,
    std::size_t top_slots,
    std::string_view segment_type
) {
    struct LaneAggregate {
        std::size_t active_samples = 0;
        std::size_t transitions = 0;
        std::size_t changed_transitions = 0;
        std::array<std::size_t, 4> family_byte_hits = {0, 0, 0, 0};
        std::map<std::uint32_t, std::size_t> value_freq;
        bool previous_valid = false;
        std::uint32_t previous_value = 0;
        std::string archetype = "opaque";
        double handle_score = 0.0;
        double dynamic_score = 0.0;
    };

    struct SlotAggregate {
        std::size_t slot_index = 0;
        std::size_t active_records = 0;
        std::size_t total_lane_samples = 0;
        std::size_t max_active_lanes = 0;
        int min_chunk_id = std::numeric_limits<int>::max();
        int max_chunk_id = std::numeric_limits<int>::min();
        std::size_t handle_like_lanes = 0;
        std::size_t dynamic_like_lanes = 0;
        std::size_t mixed_lanes = 0;
        std::size_t opaque_lanes = 0;
        double handle_score = 0.0;
        double dynamic_score = 0.0;
        std::string archetype = "opaque";
        std::vector<LaneAggregate> lanes;
    };

    const ReplaySummary summary = parse_replay_bytes(bytes);
    const std::string segment_filter = normalize_segment_type_filter(segment_type);
    const auto records = extract_subrecord_family(bytes, summary, target_length, target_first_byte, segment_filter);
    std::ostringstream output;

    output << '{';
    output << "\"segmentType\":\"" << json_escape(segment_filter) << "\",";
    output << "\"length\":" << target_length << ',';
    output << "\"firstByte\":" << static_cast<int>(target_first_byte) << ',';
    output << "\"recordCount\":" << records.size() << ',';
    output << "\"headerSize\":" << header_size << ',';
    output << "\"stride\":" << stride << ',';
    output << "\"gameLengthMillis\":" << summary.game_length_millis << ',';
    output << "\"chunkBaseId\":" << (summary.container.game_start_chunk_id > 0 ? summary.container.game_start_chunk_id : 0) << ',';

    if (records.empty()) {
        output << "\"elementCount\":0,";
        output << "\"laneCount\":0,";
        output << "\"knownFirstBytes\":[],";
        output << "\"recurringFamilies\":[],";
        output << "\"archetypeCounts\":{},";
        output << "\"topHandleSlots\":[],";
        output << "\"topDynamicSlots\":[],";
        output << "\"topMixedSlots\":[]}";
        return output.str();
    }
    if (header_size >= target_length) {
        output << "\"error\":\"Header size must be smaller than the target record length.\"}";
        return output.str();
    }
    if (stride == 0 || (stride % 4) != 0) {
        output << "\"error\":\"Stride must be a non-zero multiple of 4 for entity slab analysis.\"}";
        return output.str();
    }

    const std::size_t usable_bytes = target_length - header_size;
    const std::size_t element_count = usable_bytes / stride;
    const std::size_t lane_count = std::min<std::size_t>(4, stride / 4);
    output << "\"elementCount\":" << element_count << ',';
    output << "\"laneCount\":" << lane_count << ',';
    if (lane_count == 0) {
        output << "\"error\":\"Need at least one 32-bit lane to analyze the slab.\",";
        output << "\"knownFirstBytes\":[],";
        output << "\"recurringFamilies\":[],";
        output << "\"archetypeCounts\":{},";
        output << "\"topHandleSlots\":[],";
        output << "\"topDynamicSlots\":[],";
        output << "\"topMixedSlots\":[]}";
        return output.str();
    }

    const auto family_scan = collect_ranked_chunk_families(bytes, 256, 2, segment_filter);
    std::set<std::uint8_t> known_first_bytes;
    for (const auto& family : family_scan.ranked_families) {
        known_first_bytes.insert(family.first_byte);
    }

    output << "\"knownFirstBytes\":[";
    std::size_t known_index = 0;
    for (const std::uint8_t value : known_first_bytes) {
        if (known_index++ > 0) {
            output << ',';
        }
        output << static_cast<int>(value);
    }
    output << "],";

    const std::size_t recurring_shown = std::min<std::size_t>(12, family_scan.ranked_families.size());
    output << "\"recurringFamilies\":[";
    for (std::size_t family_index = 0; family_index < recurring_shown; ++family_index) {
        const auto& family = family_scan.ranked_families[family_index];
        if (family_index > 0) {
            output << ',';
        }
        output << '{';
        output << "\"length\":" << family.length << ',';
        output << "\"firstByte\":" << static_cast<int>(family.first_byte) << ',';
        output << "\"recordCount\":" << family.record_count << ',';
        output << "\"segmentCount\":" << family.segment_ids.size() << ',';
        output << "\"chunkCount\":" << family.chunk_ids.size();
        output << '}';
    }
    output << "],";

    const std::uint8_t padding_byte = static_cast<std::uint8_t>(target_length & 0xFFu);
    const std::uint32_t padding_u32 = static_cast<std::uint32_t>(padding_byte) |
                                      (static_cast<std::uint32_t>(padding_byte) << 8U) |
                                      (static_cast<std::uint32_t>(padding_byte) << 16U) |
                                      (static_cast<std::uint32_t>(padding_byte) << 24U);

    std::vector<SlotAggregate> slots(element_count);
    for (std::size_t slot_index = 0; slot_index < element_count; ++slot_index) {
        auto& slot = slots[slot_index];
        slot.slot_index = slot_index;
        slot.lanes.resize(lane_count);
    }

    for (const auto& rec : records) {
        for (std::size_t slot_index = 0; slot_index < element_count; ++slot_index) {
            const std::size_t start = header_size + (slot_index * stride);
            if (start + stride > rec.payload.size()) {
                break;
            }

            std::size_t active_lanes = 0;
            for (std::size_t lane_index = 0; lane_index < lane_count; ++lane_index) {
                std::uint32_t value = 0;
                if (!read_u32_le(rec.payload, start + (lane_index * 4), value) || value == padding_u32) {
                    continue;
                }

                auto& lane = slots[slot_index].lanes[lane_index];
                lane.active_samples++;
                lane.value_freq[value]++;
                if (lane.previous_valid) {
                    lane.transitions++;
                    if (lane.previous_value != value) {
                        lane.changed_transitions++;
                    }
                }
                lane.previous_valid = true;
                lane.previous_value = value;

                const std::size_t lane_offset = start + (lane_index * 4);
                for (std::size_t byte_index = 0; byte_index < 4; ++byte_index) {
                    if (known_first_bytes.find(rec.payload[lane_offset + byte_index]) != known_first_bytes.end()) {
                        lane.family_byte_hits[byte_index]++;
                    }
                }
                active_lanes++;
            }

            if (active_lanes == 0) {
                continue;
            }

            auto& slot = slots[slot_index];
            slot.active_records++;
            slot.total_lane_samples += active_lanes;
            slot.max_active_lanes = std::max(slot.max_active_lanes, active_lanes);
            slot.min_chunk_id = std::min(slot.min_chunk_id, rec.chunk_id);
            slot.max_chunk_id = std::max(slot.max_chunk_id, rec.chunk_id);
        }
    }

    const auto top_count_for_lane = [](const LaneAggregate& lane) -> std::size_t {
        if (lane.value_freq.empty()) {
            return 0;
        }
        return std::max_element(lane.value_freq.begin(), lane.value_freq.end(), [](const auto& left, const auto& right) {
            if (left.second != right.second) {
                return left.second < right.second;
            }
            return left.first > right.first;
        })->second;
    };

    auto classify_lane = [&](LaneAggregate& lane) {
        if (lane.active_samples < 4) {
            lane.archetype = "opaque";
            lane.handle_score = 0.0;
            lane.dynamic_score = 0.0;
            return;
        }

        const std::size_t unique_values = lane.value_freq.size();
        const std::size_t repeated_count = top_count_for_lane(lane);
        const double repeated_ratio = lane.active_samples > 0
            ? static_cast<double>(repeated_count) / static_cast<double>(lane.active_samples)
            : 0.0;
        const double unique_ratio = lane.active_samples > 0
            ? static_cast<double>(unique_values) / static_cast<double>(lane.active_samples)
            : 0.0;
        const double change_ratio = lane.transitions > 0
            ? static_cast<double>(lane.changed_transitions) / static_cast<double>(lane.transitions)
            : 0.0;
        const std::size_t total_family_hits = std::accumulate(lane.family_byte_hits.begin(), lane.family_byte_hits.end(), static_cast<std::size_t>(0));
        const double family_hit_ratio = lane.active_samples > 0
            ? static_cast<double>(total_family_hits) / static_cast<double>(lane.active_samples * 4)
            : 0.0;

        lane.handle_score = (repeated_ratio * 2.0) + family_hit_ratio + (1.0 - change_ratio);
        lane.dynamic_score = (change_ratio * 2.0) + unique_ratio + (1.0 - repeated_ratio);

        const bool handle_like = repeated_ratio >= 0.5 &&
                                 unique_values <= std::max<std::size_t>(4, (lane.active_samples + 1) / 2) &&
                                 family_hit_ratio >= 0.10;
        const bool dynamic_like = change_ratio >= 0.60 &&
                                  unique_values >= std::max<std::size_t>(4, lane.active_samples / 2);
        if (handle_like && dynamic_like) {
            lane.archetype = "mixed";
        } else if (handle_like) {
            lane.archetype = "static_handle_like";
        } else if (dynamic_like) {
            lane.archetype = "dynamic_state_like";
        } else {
            lane.archetype = "opaque";
        }
    };

    std::map<std::string, std::size_t> archetype_counts = {
        {"static_handle_like", 0},
        {"dynamic_state_like", 0},
        {"mixed", 0},
        {"opaque", 0},
    };
    for (auto& slot : slots) {
        if (slot.active_records < 4) {
            slot.archetype = "opaque";
            archetype_counts[slot.archetype]++;
            continue;
        }
        for (auto& lane : slot.lanes) {
            classify_lane(lane);
            slot.handle_score += lane.handle_score;
            slot.dynamic_score += lane.dynamic_score;
            if (lane.archetype == "static_handle_like") {
                slot.handle_like_lanes++;
            } else if (lane.archetype == "dynamic_state_like") {
                slot.dynamic_like_lanes++;
            } else if (lane.archetype == "mixed") {
                slot.mixed_lanes++;
            } else {
                slot.opaque_lanes++;
            }
        }

        if (slot.handle_like_lanes > 0 && slot.dynamic_like_lanes > 0) {
            slot.archetype = "mixed";
        } else if (slot.handle_like_lanes >= std::max<std::size_t>(1, lane_count / 2)) {
            slot.archetype = "static_handle_like";
        } else if (slot.dynamic_like_lanes >= std::max<std::size_t>(1, lane_count / 2)) {
            slot.archetype = "dynamic_state_like";
        } else {
            slot.archetype = "opaque";
        }
        archetype_counts[slot.archetype]++;
    }

    auto slot_sort_key = [](const SlotAggregate& left, const SlotAggregate& right, bool handle_mode) {
        const double left_primary = handle_mode ? left.handle_score : left.dynamic_score;
        const double right_primary = handle_mode ? right.handle_score : right.dynamic_score;
        if (left_primary != right_primary) {
            return left_primary > right_primary;
        }
        if (left.active_records != right.active_records) {
            return left.active_records > right.active_records;
        }
        if (left.total_lane_samples != right.total_lane_samples) {
            return left.total_lane_samples > right.total_lane_samples;
        }
        return left.slot_index < right.slot_index;
    };

    std::vector<const SlotAggregate*> handle_slots;
    std::vector<const SlotAggregate*> dynamic_slots;
    std::vector<const SlotAggregate*> mixed_slots;
    for (const auto& slot : slots) {
        if (slot.active_records < 4) {
            continue;
        }
        if (slot.archetype == "static_handle_like") {
            handle_slots.push_back(&slot);
        } else if (slot.archetype == "dynamic_state_like") {
            dynamic_slots.push_back(&slot);
        } else if (slot.archetype == "mixed") {
            mixed_slots.push_back(&slot);
        }
    }

    std::sort(handle_slots.begin(), handle_slots.end(), [&](const SlotAggregate* left, const SlotAggregate* right) {
        return slot_sort_key(*left, *right, true);
    });
    std::sort(dynamic_slots.begin(), dynamic_slots.end(), [&](const SlotAggregate* left, const SlotAggregate* right) {
        return slot_sort_key(*left, *right, false);
    });
    std::sort(mixed_slots.begin(), mixed_slots.end(), [&](const SlotAggregate* left, const SlotAggregate* right) {
        const double left_score = left->handle_score + left->dynamic_score;
        const double right_score = right->handle_score + right->dynamic_score;
        if (left_score != right_score) {
            return left_score > right_score;
        }
        if (left->active_records != right->active_records) {
            return left->active_records > right->active_records;
        }
        return left->slot_index < right->slot_index;
    });

    output << "\"archetypeCounts\":{";
    output << "\"staticHandleLike\":" << archetype_counts["static_handle_like"] << ',';
    output << "\"dynamicStateLike\":" << archetype_counts["dynamic_state_like"] << ',';
    output << "\"mixed\":" << archetype_counts["mixed"] << ',';
    output << "\"opaque\":" << archetype_counts["opaque"];
    output << "},";

    const auto emit_slots = [&](std::ostringstream& stream, const std::vector<const SlotAggregate*>& ranked_slots) {
        const std::size_t shown = std::min<std::size_t>(top_slots == 0 ? 24 : top_slots, ranked_slots.size());
        stream << '[';
        for (std::size_t rank_index = 0; rank_index < shown; ++rank_index) {
            const SlotAggregate& slot = *ranked_slots[rank_index];
            if (rank_index > 0) {
                stream << ',';
            }
            stream << '{';
            stream << "\"rank\":" << (rank_index + 1) << ',';
            stream << "\"slotIndex\":" << slot.slot_index << ',';
            stream << "\"archetype\":\"" << json_escape(slot.archetype) << "\",";
            stream << "\"activeRecords\":" << slot.active_records << ',';
            stream << "\"totalLaneSamples\":" << slot.total_lane_samples << ',';
            stream << "\"maxActiveLanes\":" << slot.max_active_lanes << ',';
            stream << "\"chunkSpanStart\":" << (slot.min_chunk_id == std::numeric_limits<int>::max() ? 0 : slot.min_chunk_id) << ',';
            stream << "\"chunkSpanEnd\":" << (slot.max_chunk_id == std::numeric_limits<int>::min() ? 0 : slot.max_chunk_id) << ',';
            stream << "\"handleScore\":" << std::fixed << std::setprecision(4) << slot.handle_score << ',';
            stream << "\"dynamicScore\":" << std::fixed << std::setprecision(4) << slot.dynamic_score << ',';
            stream << "\"handleLikeLanes\":" << slot.handle_like_lanes << ',';
            stream << "\"dynamicLikeLanes\":" << slot.dynamic_like_lanes << ',';
            stream << "\"mixedLanes\":" << slot.mixed_lanes << ',';
            stream << "\"opaqueLanes\":" << slot.opaque_lanes << ',';
            stream << "\"lanes\":[";
            for (std::size_t lane_index = 0; lane_index < slot.lanes.size(); ++lane_index) {
                const auto& lane = slot.lanes[lane_index];
                if (lane_index > 0) {
                    stream << ',';
                }
                const std::size_t repeated_count = top_count_for_lane(lane);
                const std::size_t total_family_hits = std::accumulate(lane.family_byte_hits.begin(), lane.family_byte_hits.end(), static_cast<std::size_t>(0));
                const double repeated_ratio = lane.active_samples > 0
                    ? static_cast<double>(repeated_count) / static_cast<double>(lane.active_samples)
                    : 0.0;
                const double change_ratio = lane.transitions > 0
                    ? static_cast<double>(lane.changed_transitions) / static_cast<double>(lane.transitions)
                    : 0.0;
                const double family_hit_ratio = lane.active_samples > 0
                    ? static_cast<double>(total_family_hits) / static_cast<double>(lane.active_samples * 4)
                    : 0.0;

                std::vector<std::pair<std::uint32_t, std::size_t>> top_values(lane.value_freq.begin(), lane.value_freq.end());
                std::sort(top_values.begin(), top_values.end(), [](const auto& left, const auto& right) {
                    if (left.second != right.second) {
                        return left.second > right.second;
                    }
                    return left.first < right.first;
                });

                stream << '{';
                stream << "\"laneIndex\":" << lane_index << ',';
                stream << "\"archetype\":\"" << json_escape(lane.archetype) << "\",";
                stream << "\"activeSamples\":" << lane.active_samples << ',';
                stream << "\"uniqueValues\":" << lane.value_freq.size() << ',';
                stream << "\"transitions\":" << lane.transitions << ',';
                stream << "\"changedTransitions\":" << lane.changed_transitions << ',';
                stream << "\"repeatedRatio\":" << std::fixed << std::setprecision(4) << repeated_ratio << ',';
                stream << "\"changeRatio\":" << std::fixed << std::setprecision(4) << change_ratio << ',';
                stream << "\"familyByteHitRatio\":" << std::fixed << std::setprecision(4) << family_hit_ratio << ',';
                stream << "\"familyByteHitsByOffset\":[";
                for (std::size_t byte_index = 0; byte_index < lane.family_byte_hits.size(); ++byte_index) {
                    if (byte_index > 0) {
                        stream << ',';
                    }
                    stream << lane.family_byte_hits[byte_index];
                }
                stream << "],";
                stream << "\"topValues\":[";
                const std::size_t top_value_limit = std::min<std::size_t>(3, top_values.size());
                for (std::size_t value_index = 0; value_index < top_value_limit; ++value_index) {
                    const auto& [value, count] = top_values[value_index];
                    if (value_index > 0) {
                        stream << ',';
                    }
                    stream << '{';
                    stream << "\"rawU32\":" << value << ',';
                    stream << "\"hex\":\"" << u32_hex(value) << "\",";
                    stream << "\"count\":" << count;
                    stream << '}';
                }
                stream << "]}";
            }
            stream << "]}";
        }
        stream << ']';
    };

    output << "\"topHandleSlots\":";
    emit_slots(output, handle_slots);
    output << ',';
    output << "\"topDynamicSlots\":";
    emit_slots(output, dynamic_slots);
    output << ',';
    output << "\"topMixedSlots\":";
    emit_slots(output, mixed_slots);
    output << '}';
    return output.str();
}

std::string analyze_entity_slab_file_json(
    const std::string& path,
    std::size_t target_length,
    std::uint8_t target_first_byte,
    std::size_t header_size,
    std::size_t stride,
    std::size_t top_slots,
    std::string_view segment_type
) {
    const auto bytes = read_file_bytes(path);
    return analyze_entity_slab_json(bytes, target_length, target_first_byte, header_size, stride, top_slots, segment_type);
}

std::string analyze_row_offsets_json(
    const std::vector<std::uint8_t>& bytes,
    std::size_t target_length,
    std::uint8_t target_first_byte,
    std::size_t header_size,
    std::size_t stride,
    const std::vector<std::size_t>& slot_indices,
    std::size_t top_fields,
    std::string_view segment_type,
    std::size_t min_active_samples
) {
    struct FieldProfile {
        std::size_t offset = 0;
        std::size_t width = 0;
        std::string decode_label;
        std::size_t active_samples = 0;
        std::size_t non_zero_samples = 0;
        std::size_t transitions = 0;
        std::size_t changed_transitions = 0;
        std::size_t increasing_transitions = 0;
        std::size_t decreasing_transitions = 0;
        std::size_t stable_transitions = 0;
        double min_value = std::numeric_limits<double>::infinity();
        double max_value = -std::numeric_limits<double>::infinity();
        bool previous_valid = false;
        std::uint64_t previous_raw = 0;
        double previous_value = 0.0;
        std::map<std::uint64_t, std::size_t> value_freq;
        double score = 0.0;
    };

    const ReplaySummary summary = parse_replay_bytes(bytes);
    const std::string segment_filter = normalize_segment_type_filter(segment_type);
    const auto records = extract_subrecord_family(bytes, summary, target_length, target_first_byte, segment_filter);
    std::ostringstream output;

    output << '{';
    output << "\"segmentType\":\"" << json_escape(segment_filter) << "\",";
    output << "\"length\":" << target_length << ',';
    output << "\"firstByte\":" << static_cast<int>(target_first_byte) << ',';
    output << "\"recordCount\":" << records.size() << ',';
    output << "\"headerSize\":" << header_size << ',';
    output << "\"stride\":" << stride << ',';
    output << "\"minActiveSamples\":" << min_active_samples << ',';
    output << "\"gameLengthMillis\":" << summary.game_length_millis << ',';
    output << "\"chunkBaseId\":" << (summary.container.game_start_chunk_id > 0 ? summary.container.game_start_chunk_id : 0) << ',';
    output << "\"selectedSlots\":[";
    for (std::size_t index = 0; index < slot_indices.size(); ++index) {
        if (index > 0) {
            output << ',';
        }
        output << slot_indices[index];
    }
    output << "],";

    if (records.empty()) {
        output << "\"elementCount\":0,\"slots\":[]}";
        return output.str();
    }
    if (slot_indices.empty()) {
        output << "\"error\":\"At least one slot must be provided.\",\"slots\":[]}";
        return output.str();
    }
    if (header_size >= target_length) {
        output << "\"error\":\"Header size must be smaller than the target record length.\",\"slots\":[]}";
        return output.str();
    }
    if (stride == 0) {
        output << "\"error\":\"Stride must be positive.\",\"slots\":[]}";
        return output.str();
    }

    const std::uint8_t padding_byte = static_cast<std::uint8_t>(target_length & 0xFFu);
    const std::uint32_t padding_u32 = static_cast<std::uint32_t>(padding_byte) |
                                      (static_cast<std::uint32_t>(padding_byte) << 8U) |
                                      (static_cast<std::uint32_t>(padding_byte) << 16U) |
                                      (static_cast<std::uint32_t>(padding_byte) << 24U);
    const std::size_t usable_bytes = target_length - header_size;
    const std::size_t element_count = usable_bytes / stride;
    output << "\"elementCount\":" << element_count << ',';

    const auto value_hex = [](std::uint64_t value, std::size_t width) {
        std::ostringstream stream;
        stream << "0x" << std::hex << std::uppercase << std::setw(static_cast<int>(width * 2)) << std::setfill('0') << value;
        return stream.str();
    };

    auto update_profile = [](FieldProfile& profile, std::uint64_t raw_value, double decoded_value) {
        profile.active_samples++;
        profile.value_freq[raw_value]++;
        if (raw_value != 0) {
            profile.non_zero_samples++;
        }
        profile.min_value = std::min(profile.min_value, decoded_value);
        profile.max_value = std::max(profile.max_value, decoded_value);
        if (profile.previous_valid) {
            profile.transitions++;
            if (profile.previous_raw != raw_value) {
                profile.changed_transitions++;
            }
            if (decoded_value > profile.previous_value) {
                profile.increasing_transitions++;
            } else if (decoded_value < profile.previous_value) {
                profile.decreasing_transitions++;
            } else {
                profile.stable_transitions++;
            }
        }
        profile.previous_valid = true;
        profile.previous_raw = raw_value;
        profile.previous_value = decoded_value;
    };

    if (top_fields == 0) {
        top_fields = 24;
    }

    output << "\"slots\":[";
    bool first_slot_output = true;
    for (const std::size_t slot_index : slot_indices) {
        if (!first_slot_output) {
            output << ',';
        }
        first_slot_output = false;

        output << '{';
        output << "\"slotIndex\":" << slot_index;
        if (slot_index >= element_count) {
            output << ",\"error\":\"Slot index exceeds element count.\",\"fields\":[]}";
            continue;
        }

        std::vector<FieldProfile> profiles;
        profiles.reserve((stride * 1) + ((stride > 1 ? stride - 1 : 0) * 2) + ((stride > 3 ? stride - 3 : 0) * 3));
        for (std::size_t offset = 0; offset < stride; ++offset) {
            profiles.push_back({offset, 1, "u8"});
        }
        for (std::size_t offset = 0; offset + 2 <= stride; ++offset) {
            profiles.push_back({offset, 2, "u16"});
            profiles.push_back({offset, 2, "i16"});
        }
        for (std::size_t offset = 0; offset + 4 <= stride; ++offset) {
            profiles.push_back({offset, 4, "u32"});
            profiles.push_back({offset, 4, "i32"});
            profiles.push_back({offset, 4, "f32"});
        }

        std::size_t row_active_records = 0;
        int min_chunk_id = std::numeric_limits<int>::max();
        int max_chunk_id = std::numeric_limits<int>::min();

        for (std::size_t record_index = 0; record_index < records.size(); ++record_index) {
            const auto& rec = records[record_index];
            const std::size_t start = header_size + (slot_index * stride);
            if (start + stride > rec.payload.size()) {
                continue;
            }

            bool row_active = false;
            if ((stride % 4) == 0) {
                for (std::size_t lane_offset = 0; lane_offset + 4 <= stride; lane_offset += 4) {
                    std::uint32_t lane_value = 0;
                    if (read_u32_le(rec.payload, start + lane_offset, lane_value) && lane_value != padding_u32) {
                        row_active = true;
                        break;
                    }
                }
            } else {
                for (std::size_t byte_offset = 0; byte_offset < stride; ++byte_offset) {
                    if (rec.payload[start + byte_offset] != padding_byte) {
                        row_active = true;
                        break;
                    }
                }
            }
            if (!row_active) {
                continue;
            }

            row_active_records++;
            min_chunk_id = std::min(min_chunk_id, rec.chunk_id);
            max_chunk_id = std::max(max_chunk_id, rec.chunk_id);

            for (auto& profile : profiles) {
                const std::size_t field_offset = start + profile.offset;
                if (profile.width == 1) {
                    const std::uint8_t raw = rec.payload[field_offset];
                    update_profile(profile, raw, static_cast<double>(raw));
                } else if (profile.width == 2) {
                    const std::uint16_t raw = static_cast<std::uint16_t>(rec.payload[field_offset]) |
                                              (static_cast<std::uint16_t>(rec.payload[field_offset + 1]) << 8U);
                    if (profile.decode_label == "u16") {
                        update_profile(profile, raw, static_cast<double>(raw));
                    } else {
                        const std::int16_t signed_value = static_cast<std::int16_t>(raw);
                        update_profile(profile, raw, static_cast<double>(signed_value));
                    }
                } else {
                    std::uint32_t raw = 0;
                    if (!read_u32_le(rec.payload, field_offset, raw)) {
                        continue;
                    }
                    if (profile.decode_label == "u32") {
                        update_profile(profile, raw, static_cast<double>(raw));
                    } else if (profile.decode_label == "i32") {
                        const std::int32_t signed_value = static_cast<std::int32_t>(raw);
                        update_profile(profile, raw, static_cast<double>(signed_value));
                    } else {
                        const float as_float = std::bit_cast<float>(raw);
                        if (!std::isfinite(as_float)) {
                            continue;
                        }
                        update_profile(profile, raw, static_cast<double>(as_float));
                    }
                }
            }
        }

        for (auto& profile : profiles) {
            if (profile.active_samples < min_active_samples) {
                profile.score = 0.0;
                continue;
            }
            const double unique_ratio = static_cast<double>(profile.value_freq.size()) / static_cast<double>(profile.active_samples);
            const double change_ratio = profile.transitions > 0
                ? static_cast<double>(profile.changed_transitions) / static_cast<double>(profile.transitions)
                : 0.0;
            const double monotonic_ratio = profile.transitions > 0
                ? static_cast<double>(std::max(profile.increasing_transitions, profile.decreasing_transitions)) / static_cast<double>(profile.transitions)
                : 0.0;
            const double coverage = records.empty()
                ? 0.0
                : static_cast<double>(profile.active_samples) / static_cast<double>(records.size());
            profile.score = static_cast<double>(profile.active_samples) *
                            (0.15 + unique_ratio) *
                            (0.20 + change_ratio) *
                            (0.25 + coverage) *
                            (0.25 + monotonic_ratio);
        }

        std::sort(profiles.begin(), profiles.end(), [](const FieldProfile& left, const FieldProfile& right) {
            if (left.score != right.score) {
                return left.score > right.score;
            }
            if (left.active_samples != right.active_samples) {
                return left.active_samples > right.active_samples;
            }
            if (left.width != right.width) {
                return left.width > right.width;
            }
            if (left.offset != right.offset) {
                return left.offset < right.offset;
            }
            return left.decode_label < right.decode_label;
        });

        output << ",\"activeRecords\":" << row_active_records << ',';
        output << "\"chunkSpanStart\":" << (min_chunk_id == std::numeric_limits<int>::max() ? 0 : min_chunk_id) << ',';
        output << "\"chunkSpanEnd\":" << (max_chunk_id == std::numeric_limits<int>::min() ? 0 : max_chunk_id) << ',';
        output << "\"fields\":[";
        std::size_t emitted = 0;
        for (const auto& profile : profiles) {
            if (emitted >= top_fields) {
                break;
            }
            if (profile.active_samples < min_active_samples || profile.score <= 0.0) {
                continue;
            }
            if (emitted++ > 0) {
                output << ',';
            }
            const double unique_ratio = static_cast<double>(profile.value_freq.size()) / static_cast<double>(profile.active_samples);
            const double change_ratio = profile.transitions > 0
                ? static_cast<double>(profile.changed_transitions) / static_cast<double>(profile.transitions)
                : 0.0;
            const double monotonic_ratio = profile.transitions > 0
                ? static_cast<double>(std::max(profile.increasing_transitions, profile.decreasing_transitions)) / static_cast<double>(profile.transitions)
                : 0.0;
            const char* direction = "mixed";
            if (profile.increasing_transitions > profile.decreasing_transitions && monotonic_ratio >= 0.6) {
                direction = "increasing";
            } else if (profile.decreasing_transitions > profile.increasing_transitions && monotonic_ratio >= 0.6) {
                direction = "decreasing";
            }

            std::vector<std::pair<std::uint64_t, std::size_t>> top_values(profile.value_freq.begin(), profile.value_freq.end());
            std::sort(top_values.begin(), top_values.end(), [](const auto& left, const auto& right) {
                if (left.second != right.second) {
                    return left.second > right.second;
                }
                return left.first < right.first;
            });

            output << '{';
            output << "\"offset\":" << profile.offset << ',';
            output << "\"width\":" << profile.width << ',';
            output << "\"decodeLabel\":\"" << json_escape(profile.decode_label) << "\",";
            output << "\"score\":" << std::fixed << std::setprecision(4) << profile.score << ',';
            output << "\"activeSamples\":" << profile.active_samples << ',';
            output << "\"nonZeroSamples\":" << profile.non_zero_samples << ',';
            output << "\"uniqueValues\":" << profile.value_freq.size() << ',';
            output << "\"transitions\":" << profile.transitions << ',';
            output << "\"changedTransitions\":" << profile.changed_transitions << ',';
            output << "\"increasingTransitions\":" << profile.increasing_transitions << ',';
            output << "\"decreasingTransitions\":" << profile.decreasing_transitions << ',';
            output << "\"stableTransitions\":" << profile.stable_transitions << ',';
            output << "\"uniqueRatio\":" << unique_ratio << ',';
            output << "\"changeRatio\":" << change_ratio << ',';
            output << "\"monotonicRatio\":" << monotonic_ratio << ',';
            output << "\"directionHint\":\"" << direction << "\",";
            output << "\"minValue\":" << (std::isfinite(profile.min_value) ? profile.min_value : 0.0) << ',';
            output << "\"maxValue\":" << (std::isfinite(profile.max_value) ? profile.max_value : 0.0) << ',';
            output << "\"topValues\":[";
            const std::size_t top_value_limit = std::min<std::size_t>(3, top_values.size());
            for (std::size_t value_index = 0; value_index < top_value_limit; ++value_index) {
                const auto& [raw_value, count] = top_values[value_index];
                if (value_index > 0) {
                    output << ',';
                }
                output << '{';
                output << "\"raw\":" << raw_value << ',';
                output << "\"hex\":\"" << value_hex(raw_value, profile.width) << "\",";
                output << "\"count\":" << count;
                output << '}';
            }
            output << "]}";
        }
        output << "]}";
    }
    output << "]}";
    return output.str();
}

std::string analyze_row_offsets_file_json(
    const std::string& path,
    std::size_t target_length,
    std::uint8_t target_first_byte,
    std::size_t header_size,
    std::size_t stride,
    const std::vector<std::size_t>& slot_indices,
    std::size_t top_fields,
    std::string_view segment_type,
    std::size_t min_active_samples
) {
    const auto bytes = read_file_bytes(path);
    return analyze_row_offsets_json(bytes, target_length, target_first_byte, header_size, stride, slot_indices, top_fields, segment_type, min_active_samples);
}


std::string analyze_clean_row_offsets_json(
    const std::vector<std::uint8_t>& bytes,
    std::size_t target_length,
    std::uint8_t target_first_byte,
    std::size_t header_size,
    std::size_t stride,
    const std::vector<std::size_t>& slot_indices,
    std::size_t top_fields,
    std::string_view segment_type,
    std::size_t min_active_samples
) {
    struct FieldSample {
        int segment_id = 0;
        std::string segment_type;
        int chunk_id = 0;
        std::size_t record_index = 0;
        int api_frame_index = -1;
        int timestamp = 0;
        std::uint64_t raw_value = 0;
        double decoded_value = 0.0;
    };
    struct FieldProfile {
        std::size_t offset = 0;
        std::size_t width = 0;
        std::string decode_label;
        std::size_t active_samples = 0;
        std::size_t non_zero_samples = 0;
        std::size_t transitions = 0;
        std::size_t changed_transitions = 0;
        std::size_t increasing_transitions = 0;
        std::size_t decreasing_transitions = 0;
        std::size_t stable_transitions = 0;
        double min_value = std::numeric_limits<double>::infinity();
        double max_value = -std::numeric_limits<double>::infinity();
        bool previous_valid = false;
        std::uint64_t previous_raw = 0;
        double previous_value = 0.0;
        std::map<std::uint64_t, std::size_t> value_freq;
        std::vector<FieldSample> samples;
        double score = 0.0;
    };
    struct WindowStats {
        std::size_t offset = 0;
        std::size_t active_samples = 0;
        std::size_t descriptor_sample_hits = 0;
        std::size_t multi_match_samples = 0;
        std::size_t total_exact_hits = 0;
        std::map<std::size_t, std::size_t> bit_start_freq;
        std::map<std::size_t, std::size_t> target_count_freq;
        std::map<std::uint32_t, std::size_t> token_freq;
        std::map<std::uint32_t, std::size_t> signature_token_freq;
        std::size_t signature_samples = 0;
        std::size_t top_signature_token_count = 0;
        bool descriptor_like = false;
        bool signature_dominated = false;
        double signature_ratio = 0.0;
    };
    struct GlobalSignatureToken {
        std::uint32_t raw_value = 0;
        std::size_t count = 0;
    };

    const ReplaySummary summary = parse_replay_bytes(bytes);
    const std::string segment_filter = normalize_segment_type_filter(segment_type);
    const auto records = extract_subrecord_family(bytes, summary, target_length, target_first_byte, segment_filter);
    std::ostringstream output;

    output << '{';
    output << "\"segmentType\":\"" << json_escape(segment_filter) << "\",";
    output << "\"length\":" << target_length << ',';
    output << "\"firstByte\":" << static_cast<int>(target_first_byte) << ',';
    output << "\"recordCount\":" << records.size() << ',';
    output << "\"headerSize\":" << header_size << ',';
    output << "\"stride\":" << stride << ',';
    output << "\"minActiveSamples\":" << min_active_samples << ',';
    output << "\"gameLengthMillis\":" << summary.game_length_millis << ',';
    output << "\"chunkBaseId\":" << (summary.container.game_start_chunk_id > 0 ? summary.container.game_start_chunk_id : 0) << ',';
    output << "\"selectedSlots\":[";
    for (std::size_t index = 0; index < slot_indices.size(); ++index) {
        if (index > 0) {
            output << ',';
        }
        output << slot_indices[index];
    }
    output << "],";

    if (records.empty()) {
        output << "\"elementCount\":0,\"signatureBytes\":[],\"targetCounts\":[],\"signatureCatalog\":[],\"slots\":[]}";
        return output.str();
    }
    if (slot_indices.empty()) {
        output << "\"error\":\"At least one slot must be provided.\",\"slots\":[]}";
        return output.str();
    }
    if (header_size >= target_length) {
        output << "\"error\":\"Header size must be smaller than the target record length.\",\"slots\":[]}";
        return output.str();
    }
    if (stride == 0) {
        output << "\"error\":\"Stride must be positive.\",\"slots\":[]}";
        return output.str();
    }

    const std::uint8_t padding_byte = static_cast<std::uint8_t>(target_length & 0xFFu);
    const std::uint32_t padding_u32 = static_cast<std::uint32_t>(padding_byte) |
                                      (static_cast<std::uint32_t>(padding_byte) << 8U) |
                                      (static_cast<std::uint32_t>(padding_byte) << 16U) |
                                      (static_cast<std::uint32_t>(padding_byte) << 24U);
    const std::size_t usable_bytes = target_length - header_size;
    const std::size_t element_count = usable_bytes / stride;
    output << "\"elementCount\":" << element_count << ',';

    const auto family_scan = collect_ranked_chunk_families(bytes, 256, 2, segment_filter);
    std::map<std::size_t, std::vector<std::string>> target_map;
    std::set<std::uint8_t> signature_bytes;
    for (const auto& family : family_scan.ranked_families) {
        if (family.record_count < 4 || family.segment_ids.size() < 4 || family.length < 16000) {
            continue;
        }
        if (family.first_byte != 0) {
            signature_bytes.insert(family.first_byte);
        }
        for (std::size_t candidate_header = 0; candidate_header <= 16; ++candidate_header) {
            if (family.length <= candidate_header || ((family.length - candidate_header) % 16) != 0) {
                continue;
            }
            const std::size_t count = (family.length - candidate_header) / 16;
            if (count < 512 || count > 0xFFFu) {
                continue;
            }
            std::ostringstream label;
            label << family.length << " / 0x" << std::hex << std::uppercase << std::setw(2) << std::setfill('0') << static_cast<int>(family.first_byte);
            target_map[count].push_back(label.str());
            const std::uint8_t count_byte = static_cast<std::uint8_t>((count >> 4U) & 0xFFu);
            if (count_byte != 0) {
                signature_bytes.insert(count_byte);
            }
        }
    }

    for (auto& [count, labels] : target_map) {
        std::sort(labels.begin(), labels.end());
        labels.erase(std::unique(labels.begin(), labels.end()), labels.end());
    }

    output << "\"signatureBytes\":[";
    bool first_signature_byte = true;
    for (const std::uint8_t byte_value : signature_bytes) {
        if (!first_signature_byte) {
            output << ',';
        }
        first_signature_byte = false;
        output << static_cast<int>(byte_value);
    }
    output << "],";

    output << "\"targetCounts\":[";
    bool first_target_count = true;
    for (const auto& [count, labels] : target_map) {
        if (!first_target_count) {
            output << ',';
        }
        first_target_count = false;
        output << '{';
        output << "\"elementCount\":" << count << ',';
        output << "\"familyLabels\":[";
        for (std::size_t index = 0; index < labels.size(); ++index) {
            if (index > 0) {
                output << ',';
            }
            output << '"' << json_escape(labels[index]) << '"';
        }
        output << "]}";
    }
    output << "],";

    const auto value_hex = [](std::uint64_t value, std::size_t width) {
        std::ostringstream stream;
        stream << "0x" << std::hex << std::uppercase << std::setw(static_cast<int>(width * 2)) << std::setfill('0') << value;
        return stream.str();
    };
    const auto extract_12 = [](std::uint32_t raw_value, std::size_t bit_start) -> std::uint32_t {
        return (raw_value >> bit_start) & 0xFFFu;
    };
    const auto count_zero_bytes = [](std::uint32_t raw_value) -> std::size_t {
        std::size_t zeros = 0;
        for (std::size_t index = 0; index < 4; ++index) {
            if (((raw_value >> (index * 8U)) & 0xFFu) == 0) {
                zeros++;
            }
        }
        return zeros;
    };
    const auto count_unique_bytes = [](std::uint32_t raw_value) -> std::size_t {
        std::set<std::uint8_t> unique_bytes;
        for (std::size_t index = 0; index < 4; ++index) {
            unique_bytes.insert(static_cast<std::uint8_t>((raw_value >> (index * 8U)) & 0xFFu));
        }
        return unique_bytes.size();
    };
    const auto count_signature_bytes_for_token = [&](std::uint32_t raw_value) -> std::size_t {
        std::size_t count = 0;
        for (std::size_t index = 0; index < 4; ++index) {
            const auto byte_value = static_cast<std::uint8_t>((raw_value >> (index * 8U)) & 0xFFu);
            if (signature_bytes.find(byte_value) != signature_bytes.end()) {
                count++;
            }
        }
        return count;
    };
    const auto exact_hit_count_for_token = [&](std::uint32_t raw_value) -> std::size_t {
        std::size_t exact_hits = 0;
        for (std::size_t bit_start = 0; bit_start <= 20; ++bit_start) {
            if (target_map.find(extract_12(raw_value, bit_start)) != target_map.end()) {
                exact_hits++;
            }
        }
        return exact_hits;
    };
    const auto token_matches_signature_shape = [&](std::uint32_t raw_value) -> bool {
        const std::size_t exact_hits = exact_hit_count_for_token(raw_value);
        const std::size_t signature_byte_count = count_signature_bytes_for_token(raw_value);
        const std::size_t zero_byte_count = count_zero_bytes(raw_value);
        const std::size_t unique_byte_count = count_unique_bytes(raw_value);
        return exact_hits >= 1 ||
               signature_byte_count >= 2 ||
               (signature_byte_count >= 1 && zero_byte_count >= 1 && unique_byte_count <= 3);
    };
    auto update_profile = [](FieldProfile& profile, const ExtractedSubrecord& record, std::size_t record_index, int timestamp, std::uint64_t raw_value, double decoded_value) {
        profile.active_samples++;
        profile.value_freq[raw_value]++;
        profile.samples.push_back({
            record.segment_id,
            record.segment_type,
            record.chunk_id,
            record_index,
            subrecord_api_frame_index(record),
            timestamp,
            raw_value,
            decoded_value,
        });
        if (raw_value != 0) {
            profile.non_zero_samples++;
        }
        profile.min_value = std::min(profile.min_value, decoded_value);
        profile.max_value = std::max(profile.max_value, decoded_value);
        if (profile.previous_valid) {
            profile.transitions++;
            if (profile.previous_raw != raw_value) {
                profile.changed_transitions++;
            }
            if (decoded_value > profile.previous_value) {
                profile.increasing_transitions++;
            } else if (decoded_value < profile.previous_value) {
                profile.decreasing_transitions++;
            } else {
                profile.stable_transitions++;
            }
        }
        profile.previous_valid = true;
        profile.previous_raw = raw_value;
        profile.previous_value = decoded_value;
    };

    if (top_fields == 0) {
        top_fields = 24;
    }

    std::map<std::uint32_t, std::size_t> global_signature_shapes;
    for (const std::size_t slot_index : slot_indices) {
        if (slot_index >= element_count) {
            continue;
        }
        for (const auto& rec : records) {
            const std::size_t start = header_size + (slot_index * stride);
            if (start + stride > rec.payload.size()) {
                continue;
            }

            bool row_active = false;
            if ((stride % 4) == 0) {
                for (std::size_t lane_offset = 0; lane_offset + 4 <= stride; lane_offset += 4) {
                    std::uint32_t lane_value = 0;
                    if (read_u32_le(rec.payload, start + lane_offset, lane_value) && lane_value != padding_u32) {
                        row_active = true;
                        break;
                    }
                }
            } else {
                for (std::size_t byte_offset = 0; byte_offset < stride; ++byte_offset) {
                    if (rec.payload[start + byte_offset] != padding_byte) {
                        row_active = true;
                        break;
                    }
                }
            }
            if (!row_active) {
                continue;
            }

            for (std::size_t offset = 0; offset + 4 <= stride; ++offset) {
                std::uint32_t raw_value = 0;
                if (!read_u32_le(rec.payload, start + offset, raw_value)) {
                    continue;
                }
                if (!token_matches_signature_shape(raw_value)) {
                    continue;
                }
                global_signature_shapes[raw_value]++;
            }
        }
    }

    std::set<std::uint32_t> global_signature_motifs;
    for (const auto& [raw_value, count] : global_signature_shapes) {
        if (count >= 2) {
            global_signature_motifs.insert(raw_value);
        }
    }

    std::map<std::uint32_t, std::size_t> global_signature_freq;
    output << "\"slots\":[";
    bool first_slot_output = true;
    for (const std::size_t slot_index : slot_indices) {
        if (!first_slot_output) {
            output << ',';
        }
        first_slot_output = false;

        output << '{';
        output << "\"slotIndex\":" << slot_index;
        if (slot_index >= element_count) {
            output << ",\"error\":\"Slot index exceeds element count.\",\"excludedWindows\":[],\"fields\":[]}";
            continue;
        }

        std::vector<WindowStats> windows;
        for (std::size_t offset = 0; offset + 4 <= stride; ++offset) {
            windows.push_back({offset});
        }

        std::size_t row_active_records = 0;
        int min_chunk_id = std::numeric_limits<int>::max();
        int max_chunk_id = std::numeric_limits<int>::min();
        for (const auto& rec : records) {
            const std::size_t start = header_size + (slot_index * stride);
            if (start + stride > rec.payload.size()) {
                continue;
            }

            bool row_active = false;
            if ((stride % 4) == 0) {
                for (std::size_t lane_offset = 0; lane_offset + 4 <= stride; lane_offset += 4) {
                    std::uint32_t lane_value = 0;
                    if (read_u32_le(rec.payload, start + lane_offset, lane_value) && lane_value != padding_u32) {
                        row_active = true;
                        break;
                    }
                }
            } else {
                for (std::size_t byte_offset = 0; byte_offset < stride; ++byte_offset) {
                    if (rec.payload[start + byte_offset] != padding_byte) {
                        row_active = true;
                        break;
                    }
                }
            }
            if (!row_active) {
                continue;
            }

            row_active_records++;
            min_chunk_id = std::min(min_chunk_id, rec.chunk_id);
            max_chunk_id = std::max(max_chunk_id, rec.chunk_id);

            for (auto& window : windows) {
                std::uint32_t raw_value = 0;
                if (!read_u32_le(rec.payload, start + window.offset, raw_value)) {
                    continue;
                }
                window.active_samples++;
                window.token_freq[raw_value]++;
                std::size_t sample_hit_count = 0;
                for (std::size_t bit_start = 0; bit_start <= 20; ++bit_start) {
                    const std::uint32_t extracted = extract_12(raw_value, bit_start);
                    const auto target_it = target_map.find(extracted);
                    if (target_it == target_map.end()) {
                        continue;
                    }
                    sample_hit_count++;
                    window.bit_start_freq[bit_start]++;
                    window.target_count_freq[extracted]++;
                }
                if (sample_hit_count > 0) {
                    window.descriptor_sample_hits++;
                    window.total_exact_hits += sample_hit_count;
                }
                if (sample_hit_count > 1) {
                    window.multi_match_samples++;
                }
            }
        }

        std::size_t descriptor_window_count = 0;
        for (auto& window : windows) {
            if (window.active_samples == 0) {
                continue;
            }
            const double sample_hit_ratio = static_cast<double>(window.descriptor_sample_hits) / static_cast<double>(window.active_samples);
            window.descriptor_like = window.descriptor_sample_hits >= 6 &&
                                     window.multi_match_samples >= 4 &&
                                     window.total_exact_hits >= 18 &&
                                     window.bit_start_freq.size() >= 4 &&
                                     window.target_count_freq.size() >= 3 &&
                                     sample_hit_ratio >= 0.45;
            if (window.descriptor_like) {
                descriptor_window_count++;
            }
            for (const auto& [raw_value, count] : window.token_freq) {
                if (global_signature_motifs.find(raw_value) == global_signature_motifs.end()) {
                    continue;
                }
                window.signature_token_freq[raw_value] = count;
                window.signature_samples += count;
                window.top_signature_token_count = std::max(window.top_signature_token_count, count);
            }
            window.signature_ratio = window.active_samples > 0
                ? static_cast<double>(window.signature_samples) / static_cast<double>(window.active_samples)
                : 0.0;
            window.signature_dominated = window.signature_samples >= 2 && window.signature_ratio >= 0.20 && window.top_signature_token_count >= 1;
        }

        const bool row_descriptor_like = descriptor_window_count > 0;
        std::set<std::size_t> excluded_u32_offsets;
        for (const auto& window : windows) {
            if (window.signature_dominated) {
                excluded_u32_offsets.insert(window.offset);
                for (const auto& [raw_value, count] : window.signature_token_freq) {
                    global_signature_freq[raw_value] += count;
                }
            }
        }

        std::vector<FieldProfile> profiles;
        if (!row_descriptor_like) {
            std::vector<std::size_t> excluded_byte_coverage(stride, 0);
            for (const std::size_t offset : excluded_u32_offsets) {
                for (std::size_t byte_index = offset; byte_index < std::min(stride, offset + 4); ++byte_index) {
                    excluded_byte_coverage[byte_index] += 1;
                }
            }
            auto field_is_excluded = [&](std::size_t offset, std::size_t width) -> bool {
                if (offset + width > stride) {
                    return true;
                }
                for (std::size_t byte_index = offset; byte_index < offset + width; ++byte_index) {
                    if (excluded_byte_coverage[byte_index] == 0) {
                        return false;
                    }
                }
                return true;
            };

            profiles.reserve((stride * 1) + ((stride > 1 ? stride - 1 : 0) * 2) + ((stride > 3 ? stride - 3 : 0) * 3));
            for (std::size_t offset = 0; offset < stride; ++offset) {
                if (field_is_excluded(offset, 1)) {
                    continue;
                }
                profiles.push_back({offset, 1, "u8"});
            }
            for (std::size_t offset = 0; offset + 2 <= stride; ++offset) {
                if (field_is_excluded(offset, 2)) {
                    continue;
                }
                profiles.push_back({offset, 2, "u16"});
                profiles.push_back({offset, 2, "i16"});
            }
            for (std::size_t offset = 0; offset + 4 <= stride; ++offset) {
                if (field_is_excluded(offset, 4)) {
                    continue;
                }
                profiles.push_back({offset, 4, "u32"});
                profiles.push_back({offset, 4, "i32"});
                profiles.push_back({offset, 4, "f32"});
            }

            const std::size_t max_record_index = records.size() > 1 ? (records.size() - 1) : 1;
            for (std::size_t record_index = 0; record_index < records.size(); ++record_index) {
                const auto& rec = records[record_index];
                const std::size_t start = header_size + (slot_index * stride);
                if (start + stride > rec.payload.size()) {
                    continue;
                }

                bool row_active = false;
                if ((stride % 4) == 0) {
                    for (std::size_t lane_offset = 0; lane_offset + 4 <= stride; lane_offset += 4) {
                        std::uint32_t lane_value = 0;
                        if (read_u32_le(rec.payload, start + lane_offset, lane_value) && lane_value != padding_u32) {
                            row_active = true;
                            break;
                        }
                    }
                } else {
                    for (std::size_t byte_offset = 0; byte_offset < stride; ++byte_offset) {
                        if (rec.payload[start + byte_offset] != padding_byte) {
                            row_active = true;
                            break;
                        }
                    }
                }
                if (!row_active) {
                    continue;
                }

                const int timestamp = subrecord_sample_timestamp_millis(rec, summary, record_index, max_record_index);

                for (auto& profile : profiles) {
                    const std::size_t field_offset = start + profile.offset;
                    if (profile.width == 1) {
                        const std::uint8_t raw = rec.payload[field_offset];
                        update_profile(profile, rec, record_index, timestamp, raw, static_cast<double>(raw));
                    } else if (profile.width == 2) {
                        const std::uint16_t raw = static_cast<std::uint16_t>(rec.payload[field_offset]) |
                                                  (static_cast<std::uint16_t>(rec.payload[field_offset + 1]) << 8U);
                        if (profile.decode_label == "u16") {
                            update_profile(profile, rec, record_index, timestamp, raw, static_cast<double>(raw));
                        } else {
                            const std::int16_t signed_value = static_cast<std::int16_t>(raw);
                            update_profile(profile, rec, record_index, timestamp, raw, static_cast<double>(signed_value));
                        }
                    } else {
                        std::uint32_t raw = 0;
                        if (!read_u32_le(rec.payload, field_offset, raw)) {
                            continue;
                        }
                        if (profile.decode_label == "u32") {
                            update_profile(profile, rec, record_index, timestamp, raw, static_cast<double>(raw));
                        } else if (profile.decode_label == "i32") {
                            const std::int32_t signed_value = static_cast<std::int32_t>(raw);
                            update_profile(profile, rec, record_index, timestamp, raw, static_cast<double>(signed_value));
                        } else {
                            const float as_float = std::bit_cast<float>(raw);
                            if (!std::isfinite(as_float)) {
                                continue;
                            }
                            update_profile(profile, rec, record_index, timestamp, raw, static_cast<double>(as_float));
                        }
                    }
                }
            }

            for (auto& profile : profiles) {
                if (profile.active_samples < min_active_samples) {
                    profile.score = 0.0;
                    continue;
                }
                const double unique_ratio = static_cast<double>(profile.value_freq.size()) / static_cast<double>(profile.active_samples);
                const double change_ratio = profile.transitions > 0
                    ? static_cast<double>(profile.changed_transitions) / static_cast<double>(profile.transitions)
                    : 0.0;
                const double monotonic_ratio = profile.transitions > 0
                    ? static_cast<double>(std::max(profile.increasing_transitions, profile.decreasing_transitions)) / static_cast<double>(profile.transitions)
                    : 0.0;
                const double coverage = records.empty()
                    ? 0.0
                    : static_cast<double>(profile.active_samples) / static_cast<double>(records.size());
                profile.score = static_cast<double>(profile.active_samples) *
                                (0.15 + unique_ratio) *
                                (0.20 + change_ratio) *
                                (0.25 + coverage) *
                                (0.25 + monotonic_ratio);
            }

            std::sort(profiles.begin(), profiles.end(), [](const FieldProfile& left, const FieldProfile& right) {
                if (left.score != right.score) {
                    return left.score > right.score;
                }
                if (left.active_samples != right.active_samples) {
                    return left.active_samples > right.active_samples;
                }
                if (left.width != right.width) {
                    return left.width > right.width;
                }
                if (left.offset != right.offset) {
                    return left.offset < right.offset;
                }
                return left.decode_label < right.decode_label;
            });
        }

        output << ",\"activeRecords\":" << row_active_records << ',';
        output << "\"chunkSpanStart\":" << (min_chunk_id == std::numeric_limits<int>::max() ? 0 : min_chunk_id) << ',';
        output << "\"chunkSpanEnd\":" << (max_chunk_id == std::numeric_limits<int>::min() ? 0 : max_chunk_id) << ',';
        output << "\"descriptorWindowCount\":" << descriptor_window_count << ',';
        output << "\"descriptorLike\":" << (row_descriptor_like ? "true" : "false") << ',';
        output << "\"excludedWindows\":[";
        bool first_window_output = true;
        for (const auto& window : windows) {
            if (!window.signature_dominated) {
                continue;
            }
            if (!first_window_output) {
                output << ',';
            }
            first_window_output = false;
            std::vector<std::pair<std::uint32_t, std::size_t>> top_tokens(window.signature_token_freq.begin(), window.signature_token_freq.end());
            std::sort(top_tokens.begin(), top_tokens.end(), [](const auto& left, const auto& right) {
                if (left.second != right.second) {
                    return left.second > right.second;
                }
                return left.first < right.first;
            });
            output << '{';
            output << "\"offset\":" << window.offset << ',';
            output << "\"activeSamples\":" << window.active_samples << ',';
            output << "\"signatureSamples\":" << window.signature_samples << ',';
            output << "\"signatureRatio\":" << std::fixed << std::setprecision(4) << window.signature_ratio << ',';
            output << "\"descriptorLike\":" << (window.descriptor_like ? "true" : "false") << ',';
            output << "\"topSignatureTokens\":[";
            for (std::size_t index = 0; index < std::min<std::size_t>(4, top_tokens.size()); ++index) {
                if (index > 0) {
                    output << ',';
                }
                output << '{';
                output << "\"rawU32\":" << top_tokens[index].first << ',';
                output << "\"hex\":\"" << u32_hex(top_tokens[index].first) << "\",";
                output << "\"count\":" << top_tokens[index].second;
                output << '}';
            }
            output << "]}";
        }
        output << "],";
        output << "\"fields\":[";
        std::size_t emitted = 0;
        for (const auto& profile : profiles) {
            if (emitted >= top_fields) {
                break;
            }
            if (profile.active_samples < min_active_samples || profile.score <= 0.0) {
                continue;
            }
            if (emitted++ > 0) {
                output << ',';
            }
            const double unique_ratio = static_cast<double>(profile.value_freq.size()) / static_cast<double>(profile.active_samples);
            const double change_ratio = profile.transitions > 0
                ? static_cast<double>(profile.changed_transitions) / static_cast<double>(profile.transitions)
                : 0.0;
            const double monotonic_ratio = profile.transitions > 0
                ? static_cast<double>(std::max(profile.increasing_transitions, profile.decreasing_transitions)) / static_cast<double>(profile.transitions)
                : 0.0;
            const char* direction = "mixed";
            if (profile.increasing_transitions > profile.decreasing_transitions && monotonic_ratio >= 0.6) {
                direction = "increasing";
            } else if (profile.decreasing_transitions > profile.increasing_transitions && monotonic_ratio >= 0.6) {
                direction = "decreasing";
            }

            std::vector<std::pair<std::uint64_t, std::size_t>> top_values(profile.value_freq.begin(), profile.value_freq.end());
            std::sort(top_values.begin(), top_values.end(), [](const auto& left, const auto& right) {
                if (left.second != right.second) {
                    return left.second > right.second;
                }
                return left.first < right.first;
            });

            output << '{';
            output << "\"offset\":" << profile.offset << ',';
            output << "\"width\":" << profile.width << ',';
            output << "\"decodeLabel\":\"" << json_escape(profile.decode_label) << "\",";
            output << "\"score\":" << std::fixed << std::setprecision(4) << profile.score << ',';
            output << "\"activeSamples\":" << profile.active_samples << ',';
            output << "\"nonZeroSamples\":" << profile.non_zero_samples << ',';
            output << "\"uniqueValues\":" << profile.value_freq.size() << ',';
            output << "\"transitions\":" << profile.transitions << ',';
            output << "\"changedTransitions\":" << profile.changed_transitions << ',';
            output << "\"increasingTransitions\":" << profile.increasing_transitions << ',';
            output << "\"decreasingTransitions\":" << profile.decreasing_transitions << ',';
            output << "\"stableTransitions\":" << profile.stable_transitions << ',';
            output << "\"uniqueRatio\":" << unique_ratio << ',';
            output << "\"changeRatio\":" << change_ratio << ',';
            output << "\"monotonicRatio\":" << monotonic_ratio << ',';
            output << "\"directionHint\":\"" << direction << "\",";
            output << "\"minValue\":" << (std::isfinite(profile.min_value) ? profile.min_value : 0.0) << ',';
            output << "\"maxValue\":" << (std::isfinite(profile.max_value) ? profile.max_value : 0.0) << ',';
            output << "\"topValues\":[";
            for (std::size_t value_index = 0; value_index < std::min<std::size_t>(3, top_values.size()); ++value_index) {
                const auto& [raw_value, count] = top_values[value_index];
                if (value_index > 0) {
                    output << ',';
                }
                output << '{';
                output << "\"raw\":" << raw_value << ',';
                output << "\"hex\":\"" << value_hex(raw_value, profile.width) << "\",";
                output << "\"count\":" << count;
                output << '}';
            }
            output << "],\"samples\":[";
            for (std::size_t sample_index = 0; sample_index < profile.samples.size(); ++sample_index) {
                const auto& sample = profile.samples[sample_index];
                if (sample_index > 0) {
                    output << ',';
                }
                output << '{';
                output << "\"segmentId\":" << sample.segment_id << ',';
                output << "\"segmentType\":\"" << json_escape(sample.segment_type) << "\",";
                output << "\"chunkId\":" << sample.chunk_id << ',';
                output << "\"recordIndex\":" << sample.record_index << ',';
                output << "\"apiFrameIndex\":" << sample.api_frame_index << ',';
                output << "\"timestamp\":" << sample.timestamp << ',';
                output << "\"raw\":" << sample.raw_value << ',';
                output << "\"rawHex\":\"" << value_hex(sample.raw_value, profile.width) << "\",";
                output << "\"decoded\":" << sample.decoded_value;
                output << '}';
            }
            output << "]}";
        }
        output << "]}";
    }
    output << "],";

    std::vector<GlobalSignatureToken> signature_catalog;
    signature_catalog.reserve(global_signature_shapes.size());
    for (const auto& [raw_value, count] : global_signature_shapes) {
        if (global_signature_motifs.find(raw_value) == global_signature_motifs.end()) {
            continue;
        }
        signature_catalog.push_back({raw_value, count});
    }
    std::sort(signature_catalog.begin(), signature_catalog.end(), [](const GlobalSignatureToken& left, const GlobalSignatureToken& right) {
        if (left.count != right.count) {
            return left.count > right.count;
        }
        return left.raw_value < right.raw_value;
    });

    output << "\"signatureCatalog\":[";
    for (std::size_t index = 0; index < std::min<std::size_t>(24, signature_catalog.size()); ++index) {
        if (index > 0) {
            output << ',';
        }
        const auto& token = signature_catalog[index];
        output << '{';
        output << "\"rawU32\":" << token.raw_value << ',';
        output << "\"hex\":\"" << u32_hex(token.raw_value) << "\",";
        output << "\"count\":" << token.count << ',';
        output << "\"exactHitCount\":" << exact_hit_count_for_token(token.raw_value) << ',';
        output << "\"signatureByteCount\":" << count_signature_bytes_for_token(token.raw_value) << ',';
        output << "\"zeroByteCount\":" << count_zero_bytes(token.raw_value) << ',';
        output << "\"uniqueByteCount\":" << count_unique_bytes(token.raw_value);
        output << '}';
    }
    output << "]}";
    return output.str();
}

std::string analyze_clean_row_offsets_file_json(
    const std::string& path,
    std::size_t target_length,
    std::uint8_t target_first_byte,
    std::size_t header_size,
    std::size_t stride,
    const std::vector<std::size_t>& slot_indices,
    std::size_t top_fields,
    std::string_view segment_type,
    std::size_t min_active_samples
) {
    const auto bytes = read_file_bytes(path);
    return analyze_clean_row_offsets_json(bytes, target_length, target_first_byte, header_size, stride, slot_indices, top_fields, segment_type, min_active_samples);
}

std::string analyze_handle_links_json(
    const std::vector<std::uint8_t>& bytes,
    std::size_t target_length,
    std::uint8_t target_first_byte,
    std::size_t header_size,
    std::size_t stride,
    const std::vector<std::size_t>& slot_indices,
    std::size_t top_links,
    std::size_t top_families,
    std::string_view segment_type
) {
    struct FamilyDescriptor {
        std::size_t length = 0;
        std::uint8_t first_byte = 0;
        std::vector<std::size_t> element_counts;
        std::string label;
    };

    struct LinkHypothesis {
        std::size_t slot_index = 0;
        std::size_t offset = 0;
        std::size_t family_index = 0;
        std::size_t family_byte_offset = 0;
        std::size_t index_offset = 0;
        std::size_t index_width = 0;
        std::size_t row_active_records = 0;
        std::size_t family_byte_matches = 0;
        std::size_t in_range_count = 0;
        std::size_t transitions = 0;
        std::size_t changed_transitions = 0;
        std::uint32_t best_element_count = 0;
        std::uint32_t min_index = std::numeric_limits<std::uint32_t>::max();
        std::uint32_t max_index = 0;
        bool previous_valid = false;
        std::uint32_t previous_index = 0;
        std::map<std::uint32_t, std::size_t> index_freq;
        std::map<std::uint32_t, std::size_t> token_freq;
        std::map<std::uint32_t, std::size_t> element_count_hits;
        double score = 0.0;
    };

    const ReplaySummary summary = parse_replay_bytes(bytes);
    const std::string segment_filter = normalize_segment_type_filter(segment_type);
    const auto records = extract_subrecord_family(bytes, summary, target_length, target_first_byte, segment_filter);
    std::ostringstream output;

    output << '{';
    output << "\"segmentType\":\"" << json_escape(segment_filter) << "\",";
    output << "\"length\":" << target_length << ',';
    output << "\"firstByte\":" << static_cast<int>(target_first_byte) << ',';
    output << "\"recordCount\":" << records.size() << ',';
    output << "\"headerSize\":" << header_size << ',';
    output << "\"stride\":" << stride << ',';
    output << "\"selectedSlots\":[";
    for (std::size_t index = 0; index < slot_indices.size(); ++index) {
        if (index > 0) {
            output << ',';
        }
        output << slot_indices[index];
    }
    output << "],";

    if (records.empty()) {
        output << "\"families\":[],\"topHypotheses\":[],\"slots\":[]}";
        return output.str();
    }
    if (slot_indices.empty()) {
        output << "\"error\":\"At least one slot must be provided.\",\"families\":[],\"topHypotheses\":[],\"slots\":[]}";
        return output.str();
    }
    if (header_size >= target_length) {
        output << "\"error\":\"Header size must be smaller than the target record length.\",\"families\":[],\"topHypotheses\":[],\"slots\":[]}";
        return output.str();
    }
    if (stride < 4) {
        output << "\"error\":\"Stride must be at least 4 bytes.\",\"families\":[],\"topHypotheses\":[],\"slots\":[]}";
        return output.str();
    }

    const std::size_t usable_bytes = target_length - header_size;
    const std::size_t element_count = usable_bytes / stride;
    output << "\"elementCount\":" << element_count << ',';

    const auto family_scan = collect_ranked_chunk_families(bytes, 256, 2, segment_filter);
    if (top_families == 0) {
        top_families = 16;
    }

    std::vector<FamilyDescriptor> families;
    families.reserve(std::min<std::size_t>(top_families, family_scan.ranked_families.size()));
    for (const auto& family : family_scan.ranked_families) {
        if (family.length == target_length && family.first_byte == target_first_byte) {
            continue;
        }
        if (family.first_byte == 0) {
            continue;
        }
        FamilyDescriptor descriptor;
        descriptor.length = family.length;
        descriptor.first_byte = family.first_byte;
        std::ostringstream label;
        label << family.length << " / 0x" << std::hex << std::uppercase << std::setw(2) << std::setfill('0') << static_cast<int>(family.first_byte);
        descriptor.label = label.str();
        for (std::size_t candidate_header = 0; candidate_header <= 16; ++candidate_header) {
            if (family.length <= candidate_header || ((family.length - candidate_header) % 16) != 0) {
                continue;
            }
            descriptor.element_counts.push_back((family.length - candidate_header) / 16);
        }
        if (descriptor.element_counts.empty()) {
            continue;
        }
        std::sort(descriptor.element_counts.begin(), descriptor.element_counts.end());
        descriptor.element_counts.erase(std::unique(descriptor.element_counts.begin(), descriptor.element_counts.end()), descriptor.element_counts.end());
        families.push_back(std::move(descriptor));
        if (families.size() >= top_families) {
            break;
        }
    }

    output << "\"families\":[";
    for (std::size_t family_index = 0; family_index < families.size(); ++family_index) {
        const auto& family = families[family_index];
        if (family_index > 0) {
            output << ',';
        }
        output << '{';
        output << "\"length\":" << family.length << ',';
        output << "\"firstByte\":" << static_cast<int>(family.first_byte) << ',';
        output << "\"label\":\"" << json_escape(family.label) << "\",";
        output << "\"elementCounts\":[";
        for (std::size_t count_index = 0; count_index < family.element_counts.size(); ++count_index) {
            if (count_index > 0) {
                output << ',';
            }
            output << family.element_counts[count_index];
        }
        output << "]}";
    }
    output << "],";

    auto read_index = [](std::uint32_t raw_value, std::size_t byte_offset, std::size_t width) -> std::uint32_t {
        if (width == 1) {
            return (raw_value >> (byte_offset * 8U)) & 0xFFu;
        }
        if (width == 2) {
            return (raw_value >> (byte_offset * 8U)) & 0xFFFFu;
        }
        return (raw_value >> (byte_offset * 8U)) & 0xFFFFFFu;
    };

    auto u32_hex_u = [](std::uint32_t value) {
        return u32_hex(value);
    };

    if (top_links == 0) {
        top_links = 24;
    }

    std::vector<LinkHypothesis> global_ranked;
    output << "\"slots\":[";
    bool first_slot_output = true;
    for (const std::size_t slot_index : slot_indices) {
        if (!first_slot_output) {
            output << ',';
        }
        first_slot_output = false;

        output << '{';
        output << "\"slotIndex\":" << slot_index;
        if (slot_index >= element_count) {
            output << ",\"error\":\"Slot index exceeds element count.\",\"topHypotheses\":[]}";
            continue;
        }

        std::vector<LinkHypothesis> hypotheses;
        for (std::size_t offset = 0; offset + 4 <= stride; ++offset) {
            for (std::size_t family_index = 0; family_index < families.size(); ++family_index) {
                for (std::size_t family_byte_offset = 0; family_byte_offset < 4; ++family_byte_offset) {
                    for (std::size_t index_offset = 0; index_offset < 4; ++index_offset) {
                        if (index_offset == family_byte_offset) {
                            continue;
                        }
                        hypotheses.push_back({slot_index, offset, family_index, family_byte_offset, index_offset, 1});
                    }
                    for (std::size_t index_offset = 0; index_offset + 2 <= 4; ++index_offset) {
                        if (family_byte_offset >= index_offset && family_byte_offset < index_offset + 2) {
                            continue;
                        }
                        hypotheses.push_back({slot_index, offset, family_index, family_byte_offset, index_offset, 2});
                    }
                    for (std::size_t index_offset = 0; index_offset + 3 <= 4; ++index_offset) {
                        if (family_byte_offset >= index_offset && family_byte_offset < index_offset + 3) {
                            continue;
                        }
                        hypotheses.push_back({slot_index, offset, family_index, family_byte_offset, index_offset, 3});
                    }
                }
            }
        }

        std::size_t row_active_records = 0;
        for (const auto& rec : records) {
            const std::size_t start = header_size + (slot_index * stride);
            if (start + stride > rec.payload.size()) {
                continue;
            }

            bool row_active = false;
            for (std::size_t lane_offset = 0; lane_offset + 4 <= stride; lane_offset += 4) {
                std::uint32_t lane_value = 0;
                if (read_u32_le(rec.payload, start + lane_offset, lane_value)) {
                    row_active = true;
                    break;
                }
            }
            if (!row_active) {
                continue;
            }
            row_active_records++;

            for (auto& hypothesis : hypotheses) {
                std::uint32_t raw_value = 0;
                if (!read_u32_le(rec.payload, start + hypothesis.offset, raw_value)) {
                    continue;
                }
                const std::uint8_t family_byte = static_cast<std::uint8_t>((raw_value >> (hypothesis.family_byte_offset * 8U)) & 0xFFu);
                if (family_byte != families[hypothesis.family_index].first_byte) {
                    continue;
                }
                hypothesis.family_byte_matches++;
                hypothesis.token_freq[raw_value]++;

                const std::uint32_t index_value = read_index(raw_value, hypothesis.index_offset, hypothesis.index_width);
                std::uint32_t matched_element_count = 0;
                for (const std::size_t element_count_candidate : families[hypothesis.family_index].element_counts) {
                    if (index_value < element_count_candidate) {
                        matched_element_count = static_cast<std::uint32_t>(element_count_candidate);
                        break;
                    }
                }
                if (matched_element_count == 0) {
                    continue;
                }

                hypothesis.in_range_count++;
                hypothesis.element_count_hits[matched_element_count]++;
                hypothesis.index_freq[index_value]++;
                hypothesis.min_index = std::min(hypothesis.min_index, index_value);
                hypothesis.max_index = std::max(hypothesis.max_index, index_value);
                if (hypothesis.previous_valid) {
                    hypothesis.transitions++;
                    if (hypothesis.previous_index != index_value) {
                        hypothesis.changed_transitions++;
                    }
                }
                hypothesis.previous_valid = true;
                hypothesis.previous_index = index_value;
            }
        }

        for (auto& hypothesis : hypotheses) {
            hypothesis.row_active_records = row_active_records;
            if (hypothesis.family_byte_matches < 3 || hypothesis.in_range_count < 3 || row_active_records == 0) {
                hypothesis.score = 0.0;
                continue;
            }
            const double byte_match_ratio = static_cast<double>(hypothesis.family_byte_matches) / static_cast<double>(row_active_records);
            const double in_range_ratio = static_cast<double>(hypothesis.in_range_count) / static_cast<double>(hypothesis.family_byte_matches);
            const double unique_ratio = static_cast<double>(hypothesis.index_freq.size()) / static_cast<double>(hypothesis.in_range_count);
            const double changed_ratio = hypothesis.transitions > 0
                ? static_cast<double>(hypothesis.changed_transitions) / static_cast<double>(hypothesis.transitions)
                : 0.0;
            if (!hypothesis.element_count_hits.empty()) {
                const auto best = std::max_element(hypothesis.element_count_hits.begin(), hypothesis.element_count_hits.end(), [](const auto& left, const auto& right) {
                    if (left.second != right.second) {
                        return left.second < right.second;
                    }
                    return left.first > right.first;
                });
                hypothesis.best_element_count = best->first;
            }
            hypothesis.score = static_cast<double>(hypothesis.in_range_count) *
                               (0.50 + byte_match_ratio) *
                               (0.50 + in_range_ratio) *
                               (0.25 + unique_ratio) *
                               (0.25 + changed_ratio);
        }

        std::sort(hypotheses.begin(), hypotheses.end(), [](const LinkHypothesis& left, const LinkHypothesis& right) {
            if (left.score != right.score) {
                return left.score > right.score;
            }
            if (left.in_range_count != right.in_range_count) {
                return left.in_range_count > right.in_range_count;
            }
            if (left.family_byte_matches != right.family_byte_matches) {
                return left.family_byte_matches > right.family_byte_matches;
            }
            if (left.offset != right.offset) {
                return left.offset < right.offset;
            }
            return left.index_offset < right.index_offset;
        });

        output << ",\"rowActiveRecords\":" << row_active_records << ',';
        output << "\"topHypotheses\":[";
        std::size_t emitted = 0;
        for (const auto& hypothesis : hypotheses) {
            if (emitted >= top_links) {
                break;
            }
            if (hypothesis.score <= 0.0) {
                continue;
            }
            if (emitted++ > 0) {
                output << ',';
            }
            global_ranked.push_back(hypothesis);
            const auto& family = families[hypothesis.family_index];
            const double byte_match_ratio = static_cast<double>(hypothesis.family_byte_matches) / static_cast<double>(std::max<std::size_t>(1, hypothesis.row_active_records));
            const double in_range_ratio = static_cast<double>(hypothesis.in_range_count) / static_cast<double>(std::max<std::size_t>(1, hypothesis.family_byte_matches));
            const double changed_ratio = hypothesis.transitions > 0
                ? static_cast<double>(hypothesis.changed_transitions) / static_cast<double>(hypothesis.transitions)
                : 0.0;

            std::vector<std::pair<std::uint32_t, std::size_t>> top_indices(hypothesis.index_freq.begin(), hypothesis.index_freq.end());
            std::sort(top_indices.begin(), top_indices.end(), [](const auto& left, const auto& right) {
                if (left.second != right.second) {
                    return left.second > right.second;
                }
                return left.first < right.first;
            });
            std::vector<std::pair<std::uint32_t, std::size_t>> top_tokens(hypothesis.token_freq.begin(), hypothesis.token_freq.end());
            std::sort(top_tokens.begin(), top_tokens.end(), [](const auto& left, const auto& right) {
                if (left.second != right.second) {
                    return left.second > right.second;
                }
                return left.first < right.first;
            });

            output << '{';
            output << "\"offset\":" << hypothesis.offset << ',';
            output << "\"familyLabel\":\"" << json_escape(family.label) << "\",";
            output << "\"familyLength\":" << family.length << ',';
            output << "\"familyFirstByte\":" << static_cast<int>(family.first_byte) << ',';
            output << "\"familyByteOffset\":" << hypothesis.family_byte_offset << ',';
            output << "\"indexOffset\":" << hypothesis.index_offset << ',';
            output << "\"indexWidth\":" << hypothesis.index_width << ',';
            output << "\"bestElementCount\":" << hypothesis.best_element_count << ',';
            output << "\"score\":" << std::fixed << std::setprecision(4) << hypothesis.score << ',';
            output << "\"familyByteMatches\":" << hypothesis.family_byte_matches << ',';
            output << "\"inRangeCount\":" << hypothesis.in_range_count << ',';
            output << "\"byteMatchRatio\":" << byte_match_ratio << ',';
            output << "\"inRangeRatio\":" << in_range_ratio << ',';
            output << "\"uniqueIndices\":" << hypothesis.index_freq.size() << ',';
            output << "\"transitions\":" << hypothesis.transitions << ',';
            output << "\"changedTransitions\":" << hypothesis.changed_transitions << ',';
            output << "\"changedRatio\":" << changed_ratio << ',';
            output << "\"minIndex\":" << (hypothesis.min_index == std::numeric_limits<std::uint32_t>::max() ? 0 : hypothesis.min_index) << ',';
            output << "\"maxIndex\":" << hypothesis.max_index << ',';
            output << "\"topIndices\":[";
            const std::size_t top_index_limit = std::min<std::size_t>(3, top_indices.size());
            for (std::size_t index = 0; index < top_index_limit; ++index) {
                const auto& [value, count] = top_indices[index];
                if (index > 0) {
                    output << ',';
                }
                output << '{';
                output << "\"value\":" << value << ',';
                output << "\"count\":" << count;
                output << '}';
            }
            output << "],\"topTokens\":[";
            const std::size_t top_token_limit = std::min<std::size_t>(3, top_tokens.size());
            for (std::size_t index = 0; index < top_token_limit; ++index) {
                const auto& [value, count] = top_tokens[index];
                if (index > 0) {
                    output << ',';
                }
                output << '{';
                output << "\"rawU32\":" << value << ',';
                output << "\"hex\":\"" << u32_hex_u(value) << "\",";
                output << "\"count\":" << count;
                output << '}';
            }
            output << "]}";
        }
        output << "]}";
    }
    output << "],";

    std::sort(global_ranked.begin(), global_ranked.end(), [](const LinkHypothesis& left, const LinkHypothesis& right) {
        if (left.score != right.score) {
            return left.score > right.score;
        }
        if (left.in_range_count != right.in_range_count) {
            return left.in_range_count > right.in_range_count;
        }
        return left.slot_index < right.slot_index;
    });

    output << "\"topHypotheses\":[";
    std::size_t emitted = 0;
    for (const auto& hypothesis : global_ranked) {
        if (emitted >= top_links) {
            break;
        }
        if (hypothesis.score <= 0.0) {
            continue;
        }
        if (emitted++ > 0) {
            output << ',';
        }
        const auto& family = families[hypothesis.family_index];
        const double byte_match_ratio = static_cast<double>(hypothesis.family_byte_matches) / static_cast<double>(std::max<std::size_t>(1, hypothesis.row_active_records));
        const double in_range_ratio = static_cast<double>(hypothesis.in_range_count) / static_cast<double>(std::max<std::size_t>(1, hypothesis.family_byte_matches));
        output << '{';
        output << "\"slotIndex\":" << hypothesis.slot_index << ',';
        output << "\"offset\":" << hypothesis.offset << ',';
        output << "\"familyLabel\":\"" << json_escape(family.label) << "\",";
        output << "\"familyByteOffset\":" << hypothesis.family_byte_offset << ',';
        output << "\"indexOffset\":" << hypothesis.index_offset << ',';
        output << "\"indexWidth\":" << hypothesis.index_width << ',';
        output << "\"bestElementCount\":" << hypothesis.best_element_count << ',';
        output << "\"score\":" << std::fixed << std::setprecision(4) << hypothesis.score << ',';
        output << "\"familyByteMatches\":" << hypothesis.family_byte_matches << ',';
        output << "\"inRangeCount\":" << hypothesis.in_range_count << ',';
        output << "\"byteMatchRatio\":" << byte_match_ratio << ',';
        output << "\"inRangeRatio\":" << in_range_ratio;
        output << '}';
    }
    output << "]}";
    return output.str();
}

std::string analyze_handle_links_file_json(
    const std::string& path,
    std::size_t target_length,
    std::uint8_t target_first_byte,
    std::size_t header_size,
    std::size_t stride,
    const std::vector<std::size_t>& slot_indices,
    std::size_t top_links,
    std::size_t top_families,
    std::string_view segment_type
) {
    const auto bytes = read_file_bytes(path);
    return analyze_handle_links_json(bytes, target_length, target_first_byte, header_size, stride, slot_indices, top_links, top_families, segment_type);
}

std::string analyze_token_bitfields_json(
    const std::vector<std::uint8_t>& bytes,
    std::size_t target_length,
    std::uint8_t target_first_byte,
    std::size_t header_size,
    std::size_t stride,
    const std::vector<std::size_t>& slot_indices,
    std::size_t top_slices,
    std::size_t top_families,
    std::string_view segment_type
) {
    struct FamilyDescriptor {
        std::size_t length = 0;
        std::uint8_t first_byte = 0;
        std::vector<std::size_t> element_counts;
        std::string label;
    };

    struct SliceCandidate {
        std::size_t slot_index = 0;
        std::size_t offset = 0;
        std::size_t bit_start = 0;
        std::size_t bit_width = 0;
        std::size_t family_index = 0;
        std::size_t active_samples = 0;
        std::size_t transitions = 0;
        std::size_t changed_transitions = 0;
        std::size_t in_range_count = 0;
        std::size_t best_element_count = 0;
        std::uint32_t min_index = std::numeric_limits<std::uint32_t>::max();
        std::uint32_t max_index = 0;
        bool previous_valid = false;
        std::uint32_t previous_index = 0;
        std::map<std::uint32_t, std::size_t> index_freq;
        std::map<std::uint32_t, std::size_t> residual_freq;
        double score = 0.0;
    };

    const ReplaySummary summary = parse_replay_bytes(bytes);
    const std::string segment_filter = normalize_segment_type_filter(segment_type);
    const auto records = extract_subrecord_family(bytes, summary, target_length, target_first_byte, segment_filter);
    std::ostringstream output;

    output << '{';
    output << "\"segmentType\":\"" << json_escape(segment_filter) << "\",";
    output << "\"length\":" << target_length << ',';
    output << "\"firstByte\":" << static_cast<int>(target_first_byte) << ',';
    output << "\"recordCount\":" << records.size() << ',';
    output << "\"headerSize\":" << header_size << ',';
    output << "\"stride\":" << stride << ',';
    output << "\"selectedSlots\":[";
    for (std::size_t index = 0; index < slot_indices.size(); ++index) {
        if (index > 0) {
            output << ',';
        }
        output << slot_indices[index];
    }
    output << "],";

    if (records.empty()) {
        output << "\"families\":[],\"topSlices\":[],\"slots\":[]}";
        return output.str();
    }
    if (slot_indices.empty()) {
        output << "\"error\":\"At least one slot must be provided.\",\"families\":[],\"topSlices\":[],\"slots\":[]}";
        return output.str();
    }
    if (header_size >= target_length) {
        output << "\"error\":\"Header size must be smaller than the target record length.\",\"families\":[],\"topSlices\":[],\"slots\":[]}";
        return output.str();
    }
    if (stride < 4) {
        output << "\"error\":\"Stride must be at least 4 bytes.\",\"families\":[],\"topSlices\":[],\"slots\":[]}";
        return output.str();
    }

    const std::size_t usable_bytes = target_length - header_size;
    const std::size_t element_count = usable_bytes / stride;
    output << "\"elementCount\":" << element_count << ',';

    const auto family_scan = collect_ranked_chunk_families(bytes, 256, 2, segment_filter);
    if (top_families == 0) {
        top_families = 16;
    }

    std::vector<FamilyDescriptor> families;
    for (const auto& family : family_scan.ranked_families) {
        if (family.length == target_length && family.first_byte == target_first_byte) {
            continue;
        }
        if (family.first_byte == 0) {
            continue;
        }
        FamilyDescriptor descriptor;
        descriptor.length = family.length;
        descriptor.first_byte = family.first_byte;
        std::ostringstream label;
        label << family.length << " / 0x" << std::hex << std::uppercase << std::setw(2) << std::setfill('0') << static_cast<int>(family.first_byte);
        descriptor.label = label.str();
        for (std::size_t candidate_header = 0; candidate_header <= 16; ++candidate_header) {
            if (family.length <= candidate_header || ((family.length - candidate_header) % 16) != 0) {
                continue;
            }
            descriptor.element_counts.push_back((family.length - candidate_header) / 16);
        }
        if (descriptor.element_counts.empty()) {
            continue;
        }
        std::sort(descriptor.element_counts.begin(), descriptor.element_counts.end());
        descriptor.element_counts.erase(std::unique(descriptor.element_counts.begin(), descriptor.element_counts.end()), descriptor.element_counts.end());
        families.push_back(std::move(descriptor));
        if (families.size() >= top_families) {
            break;
        }
    }

    output << "\"families\":[";
    for (std::size_t family_index = 0; family_index < families.size(); ++family_index) {
        const auto& family = families[family_index];
        if (family_index > 0) {
            output << ',';
        }
        output << '{';
        output << "\"length\":" << family.length << ',';
        output << "\"firstByte\":" << static_cast<int>(family.first_byte) << ',';
        output << "\"label\":\"" << json_escape(family.label) << "\",";
        output << "\"elementCounts\":[";
        for (std::size_t count_index = 0; count_index < family.element_counts.size(); ++count_index) {
            if (count_index > 0) {
                output << ',';
            }
            output << family.element_counts[count_index];
        }
        output << "]}";
    }
    output << "],";

    std::vector<std::size_t> bit_widths;
    for (std::size_t width = 6; width <= 24; ++width) {
        bit_widths.push_back(width);
    }
    if (top_slices == 0) {
        top_slices = 24;
    }

    auto extract_bits = [](std::uint32_t raw_value, std::size_t bit_start, std::size_t bit_width) -> std::uint32_t {
        const std::uint64_t mask = ((std::uint64_t{1} << bit_width) - 1ULL) << bit_start;
        return static_cast<std::uint32_t>((static_cast<std::uint64_t>(raw_value) & mask) >> bit_start);
    };
    auto residual_bits = [](std::uint32_t raw_value, std::size_t bit_start, std::size_t bit_width) -> std::uint32_t {
        const std::uint64_t mask = ((std::uint64_t{1} << bit_width) - 1ULL) << bit_start;
        return static_cast<std::uint32_t>(static_cast<std::uint64_t>(raw_value) & ~mask);
    };

    std::vector<SliceCandidate> global_ranked;
    output << "\"slots\":[";
    bool first_slot_output = true;
    for (const std::size_t slot_index : slot_indices) {
        if (!first_slot_output) {
            output << ',';
        }
        first_slot_output = false;

        output << '{';
        output << "\"slotIndex\":" << slot_index;
        if (slot_index >= element_count) {
            output << ",\"error\":\"Slot index exceeds element count.\",\"topSlices\":[]}";
            continue;
        }

        std::vector<SliceCandidate> candidates;
        for (std::size_t offset = 0; offset + 4 <= stride; ++offset) {
            for (const std::size_t bit_width : bit_widths) {
                const std::size_t max_bit_start = 32 - bit_width;
                for (std::size_t bit_start = 0; bit_start <= max_bit_start; ++bit_start) {
                    for (std::size_t family_index = 0; family_index < families.size(); ++family_index) {
                        candidates.push_back({slot_index, offset, bit_start, bit_width, family_index});
                    }
                }
            }
        }

        for (const auto& rec : records) {
            const std::size_t start = header_size + (slot_index * stride);
            if (start + stride > rec.payload.size()) {
                continue;
            }
            for (auto& candidate : candidates) {
                std::uint32_t raw_value = 0;
                if (!read_u32_le(rec.payload, start + candidate.offset, raw_value)) {
                    continue;
                }
                candidate.active_samples++;
                const std::uint32_t index_value = extract_bits(raw_value, candidate.bit_start, candidate.bit_width);
                const std::uint32_t residual_value = residual_bits(raw_value, candidate.bit_start, candidate.bit_width);
                candidate.residual_freq[residual_value]++;

                std::size_t matched_element_count = 0;
                for (const std::size_t element_count_candidate : families[candidate.family_index].element_counts) {
                    if (index_value < element_count_candidate) {
                        matched_element_count = element_count_candidate;
                        break;
                    }
                }
                if (matched_element_count == 0) {
                    continue;
                }

                if (candidate.best_element_count == 0 || matched_element_count < candidate.best_element_count) {
                    candidate.best_element_count = matched_element_count;
                }
                candidate.in_range_count++;
                candidate.index_freq[index_value]++;
                candidate.min_index = std::min(candidate.min_index, index_value);
                candidate.max_index = std::max(candidate.max_index, index_value);
                if (candidate.previous_valid) {
                    candidate.transitions++;
                    if (candidate.previous_index != index_value) {
                        candidate.changed_transitions++;
                    }
                }
                candidate.previous_valid = true;
                candidate.previous_index = index_value;
            }
        }

        for (auto& candidate : candidates) {
            if (candidate.active_samples < 4 || candidate.in_range_count < 4 || candidate.best_element_count == 0) {
                candidate.score = 0.0;
                continue;
            }
            const double in_range_ratio = static_cast<double>(candidate.in_range_count) / static_cast<double>(candidate.active_samples);
            const double unique_ratio = static_cast<double>(candidate.index_freq.size()) / static_cast<double>(candidate.in_range_count);
            const double changed_ratio = candidate.transitions > 0
                ? static_cast<double>(candidate.changed_transitions) / static_cast<double>(candidate.transitions)
                : 0.0;
            const double span_ratio = candidate.best_element_count > 0
                ? static_cast<double>(candidate.max_index) / static_cast<double>(candidate.best_element_count)
                : 0.0;
            std::size_t top_residual_count = 0;
            if (!candidate.residual_freq.empty()) {
                top_residual_count = std::max_element(candidate.residual_freq.begin(), candidate.residual_freq.end(), [](const auto& left, const auto& right) {
                    if (left.second != right.second) {
                        return left.second < right.second;
                    }
                    return left.first > right.first;
                })->second;
            }
            const double residual_repeat_ratio = candidate.active_samples > 0
                ? static_cast<double>(top_residual_count) / static_cast<double>(candidate.active_samples)
                : 0.0;
            const double span_score = std::min(1.0, span_ratio * 4.0);
            candidate.score = static_cast<double>(candidate.in_range_count) *
                              (0.30 + in_range_ratio) *
                              (0.25 + unique_ratio) *
                              (0.25 + changed_ratio) *
                              (0.20 + residual_repeat_ratio) *
                              (0.15 + span_score);
        }

        std::sort(candidates.begin(), candidates.end(), [](const SliceCandidate& left, const SliceCandidate& right) {
            if (left.score != right.score) {
                return left.score > right.score;
            }
            if (left.in_range_count != right.in_range_count) {
                return left.in_range_count > right.in_range_count;
            }
            if (left.bit_width != right.bit_width) {
                return left.bit_width > right.bit_width;
            }
            if (left.offset != right.offset) {
                return left.offset < right.offset;
            }
            return left.bit_start < right.bit_start;
        });

        output << ",\"topSlices\":[";
        std::size_t emitted = 0;
        for (const auto& candidate : candidates) {
            if (emitted >= top_slices) {
                break;
            }
            if (candidate.score <= 0.0) {
                continue;
            }
            if (emitted++ > 0) {
                output << ',';
            }
            global_ranked.push_back(candidate);
            const auto& family = families[candidate.family_index];
            const double in_range_ratio = static_cast<double>(candidate.in_range_count) / static_cast<double>(candidate.active_samples);
            const double unique_ratio = static_cast<double>(candidate.index_freq.size()) / static_cast<double>(candidate.in_range_count);
            const double changed_ratio = candidate.transitions > 0
                ? static_cast<double>(candidate.changed_transitions) / static_cast<double>(candidate.transitions)
                : 0.0;
            const double span_ratio = candidate.best_element_count > 0
                ? static_cast<double>(candidate.max_index) / static_cast<double>(candidate.best_element_count)
                : 0.0;

            std::vector<std::pair<std::uint32_t, std::size_t>> top_indices(candidate.index_freq.begin(), candidate.index_freq.end());
            std::sort(top_indices.begin(), top_indices.end(), [](const auto& left, const auto& right) {
                if (left.second != right.second) {
                    return left.second > right.second;
                }
                return left.first < right.first;
            });
            std::vector<std::pair<std::uint32_t, std::size_t>> top_residuals(candidate.residual_freq.begin(), candidate.residual_freq.end());
            std::sort(top_residuals.begin(), top_residuals.end(), [](const auto& left, const auto& right) {
                if (left.second != right.second) {
                    return left.second > right.second;
                }
                return left.first < right.first;
            });

            output << '{';
            output << "\"offset\":" << candidate.offset << ',';
            output << "\"bitStart\":" << candidate.bit_start << ',';
            output << "\"bitWidth\":" << candidate.bit_width << ',';
            output << "\"familyLabel\":\"" << json_escape(family.label) << "\",";
            output << "\"bestElementCount\":" << candidate.best_element_count << ',';
            output << "\"score\":" << std::fixed << std::setprecision(4) << candidate.score << ',';
            output << "\"activeSamples\":" << candidate.active_samples << ',';
            output << "\"inRangeCount\":" << candidate.in_range_count << ',';
            output << "\"inRangeRatio\":" << in_range_ratio << ',';
            output << "\"uniqueIndices\":" << candidate.index_freq.size() << ',';
            output << "\"uniqueRatio\":" << unique_ratio << ',';
            output << "\"transitions\":" << candidate.transitions << ',';
            output << "\"changedTransitions\":" << candidate.changed_transitions << ',';
            output << "\"changedRatio\":" << changed_ratio << ',';
            output << "\"minIndex\":" << (candidate.min_index == std::numeric_limits<std::uint32_t>::max() ? 0 : candidate.min_index) << ',';
            output << "\"maxIndex\":" << candidate.max_index << ',';
            output << "\"spanRatio\":" << span_ratio << ',';
            output << "\"topIndices\":[";
            const std::size_t top_index_limit = std::min<std::size_t>(3, top_indices.size());
            for (std::size_t index = 0; index < top_index_limit; ++index) {
                const auto& [value, count] = top_indices[index];
                if (index > 0) {
                    output << ',';
                }
                output << '{';
                output << "\"value\":" << value << ',';
                output << "\"count\":" << count;
                output << '}';
            }
            output << "],\"topResiduals\":[";
            const std::size_t top_residual_limit = std::min<std::size_t>(3, top_residuals.size());
            for (std::size_t index = 0; index < top_residual_limit; ++index) {
                const auto& [value, count] = top_residuals[index];
                if (index > 0) {
                    output << ',';
                }
                output << '{';
                output << "\"rawU32\":" << value << ',';
                output << "\"hex\":\"" << u32_hex(value) << "\",";
                output << "\"count\":" << count;
                output << '}';
            }
            output << "]}";
        }
        output << "]}";
    }
    output << "],";

    std::sort(global_ranked.begin(), global_ranked.end(), [](const SliceCandidate& left, const SliceCandidate& right) {
        if (left.score != right.score) {
            return left.score > right.score;
        }
        if (left.in_range_count != right.in_range_count) {
            return left.in_range_count > right.in_range_count;
        }
        return left.slot_index < right.slot_index;
    });

    output << "\"topSlices\":[";
    std::size_t emitted = 0;
    for (const auto& candidate : global_ranked) {
        if (emitted >= top_slices) {
            break;
        }
        if (candidate.score <= 0.0) {
            continue;
        }
        if (emitted++ > 0) {
            output << ',';
        }
        const auto& family = families[candidate.family_index];
        const double in_range_ratio = static_cast<double>(candidate.in_range_count) / static_cast<double>(candidate.active_samples);
        output << '{';
        output << "\"slotIndex\":" << candidate.slot_index << ',';
        output << "\"offset\":" << candidate.offset << ',';
        output << "\"bitStart\":" << candidate.bit_start << ',';
        output << "\"bitWidth\":" << candidate.bit_width << ',';
        output << "\"familyLabel\":\"" << json_escape(family.label) << "\",";
        output << "\"bestElementCount\":" << candidate.best_element_count << ',';
        output << "\"score\":" << std::fixed << std::setprecision(4) << candidate.score << ',';
        output << "\"activeSamples\":" << candidate.active_samples << ',';
        output << "\"inRangeCount\":" << candidate.in_range_count << ',';
        output << "\"inRangeRatio\":" << in_range_ratio;
        output << '}';
    }
    output << "]}";
    return output.str();
}

std::string analyze_token_bitfields_file_json(
    const std::string& path,
    std::size_t target_length,
    std::uint8_t target_first_byte,
    std::size_t header_size,
    std::size_t stride,
    const std::vector<std::size_t>& slot_indices,
    std::size_t top_slices,
    std::size_t top_families,
    std::string_view segment_type
) {
    const auto bytes = read_file_bytes(path);
    return analyze_token_bitfields_json(bytes, target_length, target_first_byte, header_size, stride, slot_indices, top_slices, top_families, segment_type);
}

std::string analyze_table_descriptors_json(
    const std::vector<std::uint8_t>& bytes,
    std::size_t target_length,
    std::uint8_t target_first_byte,
    std::size_t header_size,
    std::size_t stride,
    const std::vector<std::size_t>& slot_indices,
    std::size_t top_matches,
    std::string_view segment_type
) {
    struct DescriptorTarget {
        std::string family_label;
        std::size_t element_count = 0;
    };
    struct DescriptorMatch {
        std::size_t slot_index = 0;
        std::size_t offset = 0;
        std::size_t bit_start = 0;
        std::string family_label;
        std::size_t element_count = 0;
        std::size_t exact_match_count = 0;
        std::map<std::uint32_t, std::size_t> residual_freq;
        std::map<std::uint32_t, std::size_t> token_freq;
    };

    const ReplaySummary summary = parse_replay_bytes(bytes);
    const std::string segment_filter = normalize_segment_type_filter(segment_type);
    const auto records = extract_subrecord_family(bytes, summary, target_length, target_first_byte, segment_filter);
    std::ostringstream output;

    output << '{';
    output << "\"segmentType\":\"" << json_escape(segment_filter) << "\",";
    output << "\"length\":" << target_length << ',';
    output << "\"firstByte\":" << static_cast<int>(target_first_byte) << ',';
    output << "\"recordCount\":" << records.size() << ',';
    output << "\"headerSize\":" << header_size << ',';
    output << "\"stride\":" << stride << ',';
    output << "\"selectedSlots\":[";
    for (std::size_t index = 0; index < slot_indices.size(); ++index) {
        if (index > 0) {
            output << ',';
        }
        output << slot_indices[index];
    }
    output << "],";

    if (records.empty()) {
        output << "\"targets\":[],\"matches\":[],\"slots\":[]}";
        return output.str();
    }
    if (slot_indices.empty()) {
        output << "\"error\":\"At least one slot must be provided.\",\"targets\":[],\"matches\":[],\"slots\":[]}";
        return output.str();
    }
    if (header_size >= target_length) {
        output << "\"error\":\"Header size must be smaller than the target record length.\",\"targets\":[],\"matches\":[],\"slots\":[]}";
        return output.str();
    }

    const std::size_t usable_bytes = target_length - header_size;
    const std::size_t element_count = usable_bytes / stride;
    output << "\"elementCount\":" << element_count << ',';

    const auto family_scan = collect_ranked_chunk_families(bytes, 256, 2, segment_filter);
    std::vector<DescriptorTarget> targets;
    for (const auto& family : family_scan.ranked_families) {
        for (std::size_t candidate_header = 0; candidate_header <= 16; ++candidate_header) {
            if (family.length <= candidate_header || ((family.length - candidate_header) % 16) != 0) {
                continue;
            }
            std::ostringstream label;
            label << family.length << " / 0x" << std::hex << std::uppercase << std::setw(2) << std::setfill('0') << static_cast<int>(family.first_byte);
            targets.push_back({label.str(), (family.length - candidate_header) / 16});
        }
    }
    std::sort(targets.begin(), targets.end(), [](const DescriptorTarget& left, const DescriptorTarget& right) {
        if (left.element_count != right.element_count) {
            return left.element_count < right.element_count;
        }
        return left.family_label < right.family_label;
    });

    output << "\"targets\":[";
    for (std::size_t index = 0; index < targets.size(); ++index) {
        if (index > 0) {
            output << ',';
        }
        output << '{';
        output << "\"familyLabel\":\"" << json_escape(targets[index].family_label) << "\",";
        output << "\"elementCount\":" << targets[index].element_count;
        output << '}';
    }
    output << "],";

    auto extract_12 = [](std::uint32_t raw_value, std::size_t bit_start) -> std::uint32_t {
        return (raw_value >> bit_start) & 0xFFFu;
    };
    auto residual_12 = [](std::uint32_t raw_value, std::size_t bit_start) -> std::uint32_t {
        const std::uint32_t mask = 0xFFFu << bit_start;
        return raw_value & ~mask;
    };
    if (top_matches == 0) {
        top_matches = 32;
    }

    std::vector<DescriptorMatch> global_matches;
    output << "\"slots\":[";
    bool first_slot_output = true;
    for (const std::size_t slot_index : slot_indices) {
        if (!first_slot_output) {
            output << ',';
        }
        first_slot_output = false;
        output << '{';
        output << "\"slotIndex\":" << slot_index;
        if (slot_index >= element_count) {
            output << ",\"matches\":[]}";
            continue;
        }

        std::vector<DescriptorMatch> matches;
        for (std::size_t offset = 0; offset + 4 <= stride; ++offset) {
            for (std::size_t bit_start = 0; bit_start <= 20; ++bit_start) {
                for (const auto& target : targets) {
                    matches.push_back({slot_index, offset, bit_start, target.family_label, target.element_count});
                }
            }
        }

        for (const auto& rec : records) {
            const std::size_t start = header_size + (slot_index * stride);
            if (start + stride > rec.payload.size()) {
                continue;
            }
            for (auto& match : matches) {
                std::uint32_t raw_value = 0;
                if (!read_u32_le(rec.payload, start + match.offset, raw_value)) {
                    continue;
                }
                const std::uint32_t extracted = extract_12(raw_value, match.bit_start);
                if (extracted != match.element_count) {
                    continue;
                }
                match.exact_match_count++;
                match.residual_freq[residual_12(raw_value, match.bit_start)]++;
                match.token_freq[raw_value]++;
            }
        }

        matches.erase(std::remove_if(matches.begin(), matches.end(), [](const DescriptorMatch& match) {
            return match.exact_match_count == 0;
        }), matches.end());
        std::sort(matches.begin(), matches.end(), [](const DescriptorMatch& left, const DescriptorMatch& right) {
            if (left.exact_match_count != right.exact_match_count) {
                return left.exact_match_count > right.exact_match_count;
            }
            if (left.offset != right.offset) {
                return left.offset < right.offset;
            }
            if (left.bit_start != right.bit_start) {
                return left.bit_start < right.bit_start;
            }
            return left.family_label < right.family_label;
        });

        output << ",\"matches\":[";
        std::size_t emitted = 0;
        for (const auto& match : matches) {
            if (emitted >= top_matches) {
                break;
            }
            if (emitted++ > 0) {
                output << ',';
            }
            global_matches.push_back(match);
            std::vector<std::pair<std::uint32_t, std::size_t>> residuals(match.residual_freq.begin(), match.residual_freq.end());
            std::sort(residuals.begin(), residuals.end(), [](const auto& left, const auto& right) {
                if (left.second != right.second) {
                    return left.second > right.second;
                }
                return left.first < right.first;
            });
            std::vector<std::pair<std::uint32_t, std::size_t>> tokens(match.token_freq.begin(), match.token_freq.end());
            std::sort(tokens.begin(), tokens.end(), [](const auto& left, const auto& right) {
                if (left.second != right.second) {
                    return left.second > right.second;
                }
                return left.first < right.first;
            });

            output << '{';
            output << "\"offset\":" << match.offset << ',';
            output << "\"bitStart\":" << match.bit_start << ',';
            output << "\"familyLabel\":\"" << json_escape(match.family_label) << "\",";
            output << "\"elementCount\":" << match.element_count << ',';
            output << "\"exactMatchCount\":" << match.exact_match_count << ',';
            output << "\"topResiduals\":[";
            for (std::size_t index = 0; index < std::min<std::size_t>(3, residuals.size()); ++index) {
                if (index > 0) {
                    output << ',';
                }
                output << '{';
                output << "\"rawU32\":" << residuals[index].first << ',';
                output << "\"hex\":\"" << u32_hex(residuals[index].first) << "\",";
                output << "\"count\":" << residuals[index].second;
                output << '}';
            }
            output << "],\"topTokens\":[";
            for (std::size_t index = 0; index < std::min<std::size_t>(3, tokens.size()); ++index) {
                if (index > 0) {
                    output << ',';
                }
                output << '{';
                output << "\"rawU32\":" << tokens[index].first << ',';
                output << "\"hex\":\"" << u32_hex(tokens[index].first) << "\",";
                output << "\"count\":" << tokens[index].second;
                output << '}';
            }
            output << "]}";
        }
        output << "]}";
    }
    output << "],";

    std::sort(global_matches.begin(), global_matches.end(), [](const DescriptorMatch& left, const DescriptorMatch& right) {
        if (left.exact_match_count != right.exact_match_count) {
            return left.exact_match_count > right.exact_match_count;
        }
        if (left.slot_index != right.slot_index) {
            return left.slot_index < right.slot_index;
        }
        if (left.offset != right.offset) {
            return left.offset < right.offset;
        }
        return left.bit_start < right.bit_start;
    });

    output << "\"matches\":[";
    std::size_t emitted = 0;
    for (const auto& match : global_matches) {
        if (emitted >= top_matches) {
            break;
        }
        if (emitted++ > 0) {
            output << ',';
        }
        output << '{';
        output << "\"slotIndex\":" << match.slot_index << ',';
        output << "\"offset\":" << match.offset << ',';
        output << "\"bitStart\":" << match.bit_start << ',';
        output << "\"familyLabel\":\"" << json_escape(match.family_label) << "\",";
        output << "\"elementCount\":" << match.element_count << ',';
        output << "\"exactMatchCount\":" << match.exact_match_count;
        output << '}';
    }
    output << "]}";
    return output.str();
}

std::string analyze_table_descriptors_file_json(
    const std::string& path,
    std::size_t target_length,
    std::uint8_t target_first_byte,
    std::size_t header_size,
    std::size_t stride,
    const std::vector<std::size_t>& slot_indices,
    std::size_t top_matches,
    std::string_view segment_type
) {
    const auto bytes = read_file_bytes(path);
    return analyze_table_descriptors_json(bytes, target_length, target_first_byte, header_size, stride, slot_indices, top_matches, segment_type);
}


std::string analyze_bitfield_schema_json(
    const std::vector<std::uint8_t>& bytes,
    std::size_t target_length,
    std::uint8_t target_first_byte,
    std::size_t header_size,
    std::size_t stride,
    const std::vector<std::size_t>& slot_indices,
    std::size_t top_windows,
    std::string_view segment_type
) {
    struct TargetCount {
        std::size_t element_count = 0;
        std::vector<std::string> family_labels;
    };
    struct WindowClassification {
        std::size_t slot_index = 0;
        std::size_t offset = 0;
        std::size_t active_samples = 0;
        std::size_t non_zero_samples = 0;
        std::size_t descriptor_sample_hits = 0;
        std::size_t multi_match_samples = 0;
        std::size_t total_exact_hits = 0;
        std::size_t transitions = 0;
        std::size_t changed_transitions = 0;
        bool previous_valid = false;
        std::uint32_t previous_value = 0;
        std::map<std::size_t, std::size_t> bit_start_freq;
        std::map<std::size_t, std::size_t> target_count_freq;
        std::map<std::uint32_t, std::size_t> token_freq;
        double score = 0.0;
        bool descriptor_like = false;
    };

    const ReplaySummary summary = parse_replay_bytes(bytes);
    const std::string segment_filter = normalize_segment_type_filter(segment_type);
    const auto records = extract_subrecord_family(bytes, summary, target_length, target_first_byte, segment_filter);
    std::ostringstream output;

    output << '{';
    output << "\"segmentType\":\"" << json_escape(segment_filter) << "\",";
    output << "\"length\":" << target_length << ',';
    output << "\"firstByte\":" << static_cast<int>(target_first_byte) << ',';
    output << "\"recordCount\":" << records.size() << ',';
    output << "\"headerSize\":" << header_size << ',';
    output << "\"stride\":" << stride << ',';
    output << "\"selectedSlots\":[";
    for (std::size_t index = 0; index < slot_indices.size(); ++index) {
        if (index > 0) {
            output << ',';
        }
        output << slot_indices[index];
    }
    output << "],";

    if (records.empty()) {
        output << "\"targets\":[],\"descriptorRows\":[],\"topWindows\":[],\"rows\":[]}";
        return output.str();
    }
    if (slot_indices.empty()) {
        output << "\"error\":\"At least one slot must be provided.\",\"targets\":[],\"descriptorRows\":[],\"topWindows\":[],\"rows\":[]}";
        return output.str();
    }
    if (header_size >= target_length) {
        output << "\"error\":\"Header size must be smaller than the target record length.\",\"targets\":[],\"descriptorRows\":[],\"topWindows\":[],\"rows\":[]}";
        return output.str();
    }
    if (stride < 4) {
        output << "\"error\":\"Stride must be at least 4 bytes.\",\"targets\":[],\"descriptorRows\":[],\"topWindows\":[],\"rows\":[]}";
        return output.str();
    }

    const std::size_t usable_bytes = target_length - header_size;
    const std::size_t element_count = usable_bytes / stride;
    output << "\"elementCount\":" << element_count << ',';

    const auto family_scan = collect_ranked_chunk_families(bytes, 256, 2, segment_filter);
    std::map<std::size_t, std::vector<std::string>> target_map;
    for (const auto& family : family_scan.ranked_families) {
        if (family.record_count < 4 || family.segment_ids.size() < 4 || family.length < 16000) {
            continue;
        }
        for (std::size_t candidate_header = 0; candidate_header <= 16; ++candidate_header) {
            if (family.length <= candidate_header || ((family.length - candidate_header) % 16) != 0) {
                continue;
            }
            const std::size_t count = (family.length - candidate_header) / 16;
            if (count < 512 || count > 0xFFFu) {
                continue;
            }
            std::ostringstream label;
            label << family.length << " / 0x" << std::hex << std::uppercase << std::setw(2) << std::setfill('0') << static_cast<int>(family.first_byte);
            target_map[count].push_back(label.str());
        }
    }

    std::vector<TargetCount> targets;
    targets.reserve(target_map.size());
    for (auto& [count, labels] : target_map) {
        std::sort(labels.begin(), labels.end());
        labels.erase(std::unique(labels.begin(), labels.end()), labels.end());
        targets.push_back({count, labels});
    }

    output << "\"targets\":[";
    for (std::size_t index = 0; index < targets.size(); ++index) {
        if (index > 0) {
            output << ',';
        }
        output << '{';
        output << "\"elementCount\":" << targets[index].element_count << ',';
        output << "\"familyLabels\":[";
        for (std::size_t label_index = 0; label_index < targets[index].family_labels.size(); ++label_index) {
            if (label_index > 0) {
                output << ',';
            }
            output << '"' << json_escape(targets[index].family_labels[label_index]) << '"';
        }
        output << "]}";
    }
    output << "],";

    auto extract_12 = [](std::uint32_t raw_value, std::size_t bit_start) -> std::uint32_t {
        return (raw_value >> bit_start) & 0xFFFu;
    };
    if (top_windows == 0) {
        top_windows = 32;
    }

    std::vector<WindowClassification> global_windows;
    struct RowSummary {
        std::size_t slot_index = 0;
        std::size_t row_active_records = 0;
        std::size_t descriptor_window_count = 0;
        std::size_t best_offset = 0;
        std::size_t best_descriptor_sample_hits = 0;
        std::size_t best_multi_match_samples = 0;
        std::size_t best_total_exact_hits = 0;
        double best_window_score = 0.0;
        bool descriptor_like = false;
    };
    std::vector<RowSummary> row_summaries;

    output << "\"rows\":[";
    bool first_row_output = true;
    for (const std::size_t slot_index : slot_indices) {
        if (!first_row_output) {
            output << ',';
        }
        first_row_output = false;

        output << '{';
        output << "\"slotIndex\":" << slot_index;
        if (slot_index >= element_count) {
            output << ",\"error\":\"Slot index exceeds element count.\",\"topWindows\":[]}";
            continue;
        }

        std::vector<WindowClassification> windows;
        windows.reserve(stride >= 4 ? (stride - 3) : 0);
        for (std::size_t offset = 0; offset + 4 <= stride; ++offset) {
            windows.push_back({slot_index, offset});
        }

        std::size_t row_active_records = 0;
        for (const auto& rec : records) {
            const std::size_t start = header_size + (slot_index * stride);
            if (start + stride > rec.payload.size()) {
                continue;
            }

            bool row_active = false;
            for (std::size_t lane_offset = 0; lane_offset + 4 <= stride; lane_offset += 4) {
                std::uint32_t lane_value = 0;
                if (read_u32_le(rec.payload, start + lane_offset, lane_value) && lane_value != 0) {
                    row_active = true;
                    break;
                }
            }
            if (row_active) {
                row_active_records++;
            }

            for (auto& window : windows) {
                std::uint32_t raw_value = 0;
                if (!read_u32_le(rec.payload, start + window.offset, raw_value)) {
                    continue;
                }
                window.active_samples++;
                if (raw_value != 0) {
                    window.non_zero_samples++;
                }
                if (window.previous_valid) {
                    window.transitions++;
                    if (window.previous_value != raw_value) {
                        window.changed_transitions++;
                    }
                }
                window.previous_valid = true;
                window.previous_value = raw_value;

                std::size_t sample_hit_count = 0;
                for (std::size_t bit_start = 0; bit_start <= 20; ++bit_start) {
                    const std::uint32_t extracted = extract_12(raw_value, bit_start);
                    const auto target_it = target_map.find(extracted);
                    if (target_it == target_map.end()) {
                        continue;
                    }
                    sample_hit_count++;
                    window.bit_start_freq[bit_start]++;
                    window.target_count_freq[extracted]++;
                }
                if (sample_hit_count > 0) {
                    window.descriptor_sample_hits++;
                    window.total_exact_hits += sample_hit_count;
                    window.token_freq[raw_value]++;
                }
                if (sample_hit_count > 1) {
                    window.multi_match_samples++;
                }
            }
        }

        RowSummary row_summary{};
        row_summary.slot_index = slot_index;
        row_summary.row_active_records = row_active_records;

        for (auto& window : windows) {
            if (window.active_samples == 0) {
                continue;
            }
            const double sample_hit_ratio = static_cast<double>(window.descriptor_sample_hits) / static_cast<double>(window.active_samples);
            const double multi_match_ratio = static_cast<double>(window.multi_match_samples) / static_cast<double>(window.active_samples);
            const double changed_ratio = window.transitions > 0
                ? static_cast<double>(window.changed_transitions) / static_cast<double>(window.transitions)
                : 0.0;
            const double distinct_bit_ratio = std::min<std::size_t>(4, window.bit_start_freq.size()) / 4.0;
            const double distinct_target_ratio = std::min<std::size_t>(4, window.target_count_freq.size()) / 4.0;
            const double non_zero_ratio = static_cast<double>(window.non_zero_samples) / static_cast<double>(window.active_samples);
            window.score = static_cast<double>(window.total_exact_hits) *
                           (0.50 + sample_hit_ratio) *
                           (0.50 + multi_match_ratio) *
                           (0.25 + distinct_bit_ratio) *
                           (0.25 + distinct_target_ratio) *
                           (0.25 + non_zero_ratio) *
                           (0.25 + changed_ratio);
            window.descriptor_like = window.descriptor_sample_hits >= 6 &&
                                     window.multi_match_samples >= 4 &&
                                     window.total_exact_hits >= 18 &&
                                     window.bit_start_freq.size() >= 4 &&
                                     window.target_count_freq.size() >= 3 &&
                                     sample_hit_ratio >= 0.45;
            if (window.descriptor_like) {
                row_summary.descriptor_window_count++;
            }
            if (window.score > row_summary.best_window_score) {
                row_summary.best_window_score = window.score;
                row_summary.best_offset = window.offset;
                row_summary.best_descriptor_sample_hits = window.descriptor_sample_hits;
                row_summary.best_multi_match_samples = window.multi_match_samples;
                row_summary.best_total_exact_hits = window.total_exact_hits;
                row_summary.descriptor_like = window.descriptor_like;
            }
        }

        std::sort(windows.begin(), windows.end(), [](const WindowClassification& left, const WindowClassification& right) {
            if (left.score != right.score) {
                return left.score > right.score;
            }
            if (left.total_exact_hits != right.total_exact_hits) {
                return left.total_exact_hits > right.total_exact_hits;
            }
            return left.offset < right.offset;
        });

        row_summaries.push_back(row_summary);
        output << ",\"rowActiveRecords\":" << row_active_records << ',';
        output << "\"descriptorWindowCount\":" << row_summary.descriptor_window_count << ',';
        output << "\"bestOffset\":" << row_summary.best_offset << ',';
        output << "\"bestWindowScore\":" << std::fixed << std::setprecision(4) << row_summary.best_window_score << ',';
        output << "\"descriptorLike\":" << (row_summary.descriptor_like ? "true" : "false") << ',';
        output << "\"topWindows\":[";
        std::size_t emitted = 0;
        for (const auto& window : windows) {
            if (emitted >= top_windows) {
                break;
            }
            if (window.score <= 0.0) {
                continue;
            }
            if (emitted++ > 0) {
                output << ',';
            }
            global_windows.push_back(window);

            std::vector<std::pair<std::size_t, std::size_t>> bit_starts(window.bit_start_freq.begin(), window.bit_start_freq.end());
            std::sort(bit_starts.begin(), bit_starts.end(), [](const auto& left, const auto& right) {
                if (left.second != right.second) {
                    return left.second > right.second;
                }
                return left.first < right.first;
            });
            std::vector<std::pair<std::size_t, std::size_t>> target_counts(window.target_count_freq.begin(), window.target_count_freq.end());
            std::sort(target_counts.begin(), target_counts.end(), [](const auto& left, const auto& right) {
                if (left.second != right.second) {
                    return left.second > right.second;
                }
                return left.first < right.first;
            });
            std::vector<std::pair<std::uint32_t, std::size_t>> top_tokens(window.token_freq.begin(), window.token_freq.end());
            std::sort(top_tokens.begin(), top_tokens.end(), [](const auto& left, const auto& right) {
                if (left.second != right.second) {
                    return left.second > right.second;
                }
                return left.first < right.first;
            });

            output << '{';
            output << "\"offset\":" << window.offset << ',';
            output << "\"activeSamples\":" << window.active_samples << ',';
            output << "\"nonZeroSamples\":" << window.non_zero_samples << ',';
            output << "\"descriptorSampleHits\":" << window.descriptor_sample_hits << ',';
            output << "\"multiMatchSamples\":" << window.multi_match_samples << ',';
            output << "\"totalExactHits\":" << window.total_exact_hits << ',';
            output << "\"distinctBitStarts\":" << window.bit_start_freq.size() << ',';
            output << "\"distinctTargets\":" << window.target_count_freq.size() << ',';
            output << "\"score\":" << std::fixed << std::setprecision(4) << window.score << ',';
            output << "\"descriptorLike\":" << (window.descriptor_like ? "true" : "false") << ',';
            output << "\"topBitStarts\":[";
            for (std::size_t index = 0; index < std::min<std::size_t>(4, bit_starts.size()); ++index) {
                if (index > 0) {
                    output << ',';
                }
                output << '{';
                output << "\"bitStart\":" << bit_starts[index].first << ',';
                output << "\"count\":" << bit_starts[index].second;
                output << '}';
            }
            output << "],\"topTargets\":[";
            for (std::size_t index = 0; index < std::min<std::size_t>(4, target_counts.size()); ++index) {
                if (index > 0) {
                    output << ',';
                }
                const auto labels_it = target_map.find(target_counts[index].first);
                output << '{';
                output << "\"elementCount\":" << target_counts[index].first << ',';
                output << "\"count\":" << target_counts[index].second << ',';
                output << "\"familyLabels\":[";
                if (labels_it != target_map.end()) {
                    for (std::size_t label_index = 0; label_index < labels_it->second.size(); ++label_index) {
                        if (label_index > 0) {
                            output << ',';
                        }
                        output << '"' << json_escape(labels_it->second[label_index]) << '"';
                    }
                }
                output << "]}";
            }
            output << "],\"topTokens\":[";
            for (std::size_t index = 0; index < std::min<std::size_t>(4, top_tokens.size()); ++index) {
                if (index > 0) {
                    output << ',';
                }
                output << '{';
                output << "\"rawU32\":" << top_tokens[index].first << ',';
                output << "\"hex\":\"" << u32_hex(top_tokens[index].first) << "\",";
                output << "\"count\":" << top_tokens[index].second;
                output << '}';
            }
            output << "]}";
        }
        output << "]}";
    }
    output << "],";

    std::sort(row_summaries.begin(), row_summaries.end(), [](const RowSummary& left, const RowSummary& right) {
        if (left.descriptor_window_count != right.descriptor_window_count) {
            return left.descriptor_window_count > right.descriptor_window_count;
        }
        if (left.best_window_score != right.best_window_score) {
            return left.best_window_score > right.best_window_score;
        }
        return left.slot_index < right.slot_index;
    });

    output << "\"descriptorRows\":[";
    std::size_t descriptor_rows_emitted = 0;
    for (const auto& row : row_summaries) {
        if (descriptor_rows_emitted >= top_windows) {
            break;
        }
        if (row.best_window_score <= 0.0) {
            continue;
        }
        if (descriptor_rows_emitted++ > 0) {
            output << ',';
        }
        output << '{';
        output << "\"slotIndex\":" << row.slot_index << ',';
        output << "\"rowActiveRecords\":" << row.row_active_records << ',';
        output << "\"descriptorWindowCount\":" << row.descriptor_window_count << ',';
        output << "\"bestOffset\":" << row.best_offset << ',';
        output << "\"bestWindowScore\":" << std::fixed << std::setprecision(4) << row.best_window_score << ',';
        output << "\"bestDescriptorSampleHits\":" << row.best_descriptor_sample_hits << ',';
        output << "\"bestMultiMatchSamples\":" << row.best_multi_match_samples << ',';
        output << "\"bestTotalExactHits\":" << row.best_total_exact_hits << ',';
        output << "\"descriptorLike\":" << (row.descriptor_like ? "true" : "false");
        output << '}';
    }
    output << "],";

    std::sort(global_windows.begin(), global_windows.end(), [](const WindowClassification& left, const WindowClassification& right) {
        if (left.score != right.score) {
            return left.score > right.score;
        }
        if (left.total_exact_hits != right.total_exact_hits) {
            return left.total_exact_hits > right.total_exact_hits;
        }
        if (left.slot_index != right.slot_index) {
            return left.slot_index < right.slot_index;
        }
        return left.offset < right.offset;
    });

    output << "\"topWindows\":[";
    std::size_t emitted = 0;
    for (const auto& window : global_windows) {
        if (emitted >= top_windows) {
            break;
        }
        if (window.score <= 0.0) {
            continue;
        }
        if (emitted++ > 0) {
            output << ',';
        }
        output << '{';
        output << "\"slotIndex\":" << window.slot_index << ',';
        output << "\"offset\":" << window.offset << ',';
        output << "\"descriptorSampleHits\":" << window.descriptor_sample_hits << ',';
        output << "\"multiMatchSamples\":" << window.multi_match_samples << ',';
        output << "\"totalExactHits\":" << window.total_exact_hits << ',';
        output << "\"distinctBitStarts\":" << window.bit_start_freq.size() << ',';
        output << "\"distinctTargets\":" << window.target_count_freq.size() << ',';
        output << "\"score\":" << std::fixed << std::setprecision(4) << window.score << ',';
        output << "\"descriptorLike\":" << (window.descriptor_like ? "true" : "false");
        output << '}';
    }
    output << "]}";
    return output.str();
}

std::string analyze_bitfield_schema_file_json(
    const std::string& path,
    std::size_t target_length,
    std::uint8_t target_first_byte,
    std::size_t header_size,
    std::size_t stride,
    const std::vector<std::size_t>& slot_indices,
    std::size_t top_windows,
    std::string_view segment_type
) {
    const auto bytes = read_file_bytes(path);
    return analyze_bitfield_schema_json(bytes, target_length, target_first_byte, header_size, stride, slot_indices, top_windows, segment_type);
}

std::string analyze_artifact_bundle_file_json(
    const std::string& path,
    std::size_t minimum_length,
    std::size_t minimum_records,
    std::size_t top_families,
    std::size_t top_entity_slots,
    std::size_t top_scalar_slots,
    std::size_t dynamic_slot_count,
    std::size_t mixed_slot_count,
    std::size_t handle_slot_count,
    std::size_t top_windows,
    std::size_t top_fields,
    bool skip_scalar,
    std::string_view segment_type
) {
    struct RankedFamilyDescriptor {
        std::size_t length = 0;
        std::uint8_t first_byte = 0;
        std::size_t record_count = 0;
        std::size_t segment_count = 0;
        std::size_t chunk_count = 0;
        std::size_t header_size = 0;
        std::size_t stride = 16;
    };

    struct FamilyArtifactResult {
        RankedFamilyDescriptor family;
        std::string family_key;
        ArtifactSelectedSlots slot_selection;
        std::string entity_slab_json;
        std::string scalar_json;
        std::string schema_json;
        std::string cleaned_json;
    };

    const auto bytes = read_file_bytes(path);
    const ReplaySummary summary = parse_replay_bytes(bytes);
    const std::string segment_filter = normalize_segment_type_filter(segment_type);
    const auto family_scan = collect_ranked_chunk_families(bytes, minimum_length, minimum_records, segment_filter);

    const std::size_t shown = std::min<std::size_t>(top_families == 0 ? 20 : top_families, family_scan.ranked_families.size());
    std::vector<RankedFamilyDescriptor> ranked_families;
    ranked_families.reserve(shown);
    for (std::size_t index = 0; index < shown; ++index) {
        const auto& family = family_scan.ranked_families[index];
        std::size_t recommended_header_size = 0;
        for (std::size_t header_size = 0; header_size <= 16; ++header_size) {
            if (family.length <= header_size || ((family.length - header_size) % 16) != 0) {
                continue;
            }
            recommended_header_size = header_size;
            break;
        }

        ranked_families.push_back({
            family.length,
            family.first_byte,
            family.record_count,
            family.segment_ids.size(),
            family.chunk_ids.size(),
            recommended_header_size,
            16,
        });
    }

    std::vector<std::future<FamilyArtifactResult>> futures;
    futures.reserve(ranked_families.size());
    for (const auto& family : ranked_families) {
        futures.push_back(std::async(std::launch::async, [&bytes, family, top_entity_slots, top_scalar_slots, dynamic_slot_count, mixed_slot_count, handle_slot_count, top_windows, top_fields, skip_scalar, segment_filter]() {
            FamilyArtifactResult result;
            result.family = family;

            std::ostringstream key_builder;
            key_builder << family.length << "-0x"
                        << std::hex << std::uppercase << std::setw(2) << std::setfill('0')
                        << static_cast<int>(family.first_byte)
                        << std::dec << std::setfill(' ')
                        << "-h" << family.header_size;
            result.family_key = key_builder.str();

            result.entity_slab_json = analyze_entity_slab_json(
                bytes,
                family.length,
                family.first_byte,
                family.header_size,
                family.stride,
                top_entity_slots,
                segment_filter);
            result.slot_selection = select_candidate_slots_from_entity_slab_json(
                trim_json_whitespace(result.entity_slab_json),
                dynamic_slot_count,
                mixed_slot_count,
                handle_slot_count);

            if (!skip_scalar) {
                result.scalar_json = analyze_scalar_family_json(
                    bytes,
                    family.length,
                    family.first_byte,
                    family.header_size,
                    family.stride,
                    top_scalar_slots,
                    segment_filter);
            }

            if (!result.slot_selection.selected_slots.empty()) {
                result.schema_json = analyze_bitfield_schema_json(
                    bytes,
                    family.length,
                    family.first_byte,
                    family.header_size,
                    family.stride,
                    result.slot_selection.selected_slots,
                    top_windows,
                    segment_filter);
                result.cleaned_json = analyze_clean_row_offsets_json(
                    bytes,
                    family.length,
                    family.first_byte,
                    family.header_size,
                    family.stride,
                    result.slot_selection.selected_slots,
                    top_fields,
                    segment_filter,
                    4);
            }

            return result;
        }));
    }

    std::vector<FamilyArtifactResult> family_results;
    family_results.reserve(futures.size());
    for (auto& future : futures) {
        family_results.push_back(future.get());
    }
    std::sort(family_results.begin(), family_results.end(), [](const FamilyArtifactResult& left, const FamilyArtifactResult& right) {
        if (left.family.chunk_count != right.family.chunk_count) {
            return left.family.chunk_count > right.family.chunk_count;
        }
        if (left.family.record_count != right.family.record_count) {
            return left.family.record_count > right.family.record_count;
        }
        if (left.family.length != right.family.length) {
            return left.family.length > right.family.length;
        }
        return left.family.first_byte < right.family.first_byte;
    });

    const std::string summary_json = replay_summary_to_json(summary);
    const std::string family_scan_json = scan_replay_families_json(bytes, minimum_length, minimum_records, top_families, segment_filter);

    std::ostringstream output;
    output << '{';
    output << "\"segmentType\":\"" << json_escape(segment_filter) << "\",";
    output << "\"summary\":" << trim_json_whitespace(summary_json) << ',';
    output << "\"familyScan\":" << trim_json_whitespace(family_scan_json) << ',';
    output << "\"families\":[";
    for (std::size_t index = 0; index < family_results.size(); ++index) {
        const auto& family = family_results[index];
        if (index > 0) {
            output << ',';
        }
        output << '{';
        output << "\"familyKey\":\"" << json_escape(family.family_key) << "\",";
        output << "\"length\":" << family.family.length << ',';
        output << "\"firstByte\":" << static_cast<int>(family.family.first_byte) << ',';
        output << "\"headerSize\":" << family.family.header_size << ',';
        output << "\"stride\":" << family.family.stride << ',';
        output << "\"recordCount\":" << family.family.record_count << ',';
        output << "\"segmentCount\":" << family.family.segment_count << ',';
        output << "\"chunkCount\":" << family.family.chunk_count << ',';
        output << "\"selectedSlots\":";
        write_number_array(output, family.slot_selection.selected_slots);
        output << ',';
        output << "\"dynamicSlots\":";
        write_number_array(output, family.slot_selection.dynamic_slots);
        output << ',';
        output << "\"mixedSlots\":";
        write_number_array(output, family.slot_selection.mixed_slots);
        output << ',';
        output << "\"handleSlots\":";
        write_number_array(output, family.slot_selection.handle_slots);
        output << ',';
        output << "\"entitySlab\":" << trim_json_whitespace(family.entity_slab_json) << ',';
        output << "\"scalar\":";
        if (skip_scalar || family.scalar_json.empty()) {
            output << "null";
        } else {
            output << trim_json_whitespace(family.scalar_json);
        }
        output << ',';
        output << "\"schema\":";
        if (family.schema_json.empty()) {
            output << "null";
        } else {
            output << trim_json_whitespace(family.schema_json);
        }
        output << ',';
        output << "\"cleaned\":";
        if (family.cleaned_json.empty()) {
            output << "null";
        } else {
            output << trim_json_whitespace(family.cleaned_json);
        }
        output << '}';
    }
    output << "]}";
    return output.str();
}

std::string match_event_window(
    const std::string& replay_path,
    std::size_t target_length,
    std::uint8_t target_first_byte,
    std::size_t header_size,
    std::size_t stride,
    double event_x,
    double event_y,
    int timestamp_millis,
    int chunk_time_millis,
    int chunk_base_id,
    int chunk_radius,
    std::size_t top_slots,
    float move_epsilon,
    float smooth_threshold
) {
    std::ostringstream output;
    const std::vector<std::uint8_t> bytes = read_file_bytes(replay_path);
    const ReplaySummary summary = parse_replay_bytes(bytes);
    const std::uint8_t padding_byte = static_cast<std::uint8_t>(target_length & 0xFFu);
    const std::uint32_t padding_u32 = static_cast<std::uint32_t>(padding_byte) |
                                      (static_cast<std::uint32_t>(padding_byte) << 8U) |
                                      (static_cast<std::uint32_t>(padding_byte) << 16U) |
                                      (static_cast<std::uint32_t>(padding_byte) << 24U);
    const auto records = extract_subrecord_family(bytes, summary, target_length, target_first_byte);

    output << "ROFL event window matcher for " << records.size() << " records of size " << target_length
           << " starting with 0x" << std::hex << std::uppercase << std::setw(2) << std::setfill('0')
           << static_cast<int>(target_first_byte) << std::dec << "\n\n";
    output << "Header size:      " << header_size << " bytes\n";
    output << "Stride:           " << stride << " bytes\n";
    output << "Event:            (" << std::fixed << std::setprecision(2) << event_x << ", " << event_y << ") at " << timestamp_millis << " ms\n";
    output << "Chunk time:       " << chunk_time_millis << " ms\n";
    output << "Chunk base id:    " << chunk_base_id << " (negative means auto)\n";
    output << "Chunk radius:     " << chunk_radius << "\n";
    output << "Move epsilon:     " << move_epsilon << "\n";
    output << "Smooth threshold: " << smooth_threshold << "\n";

    if (records.empty()) {
        output << "No matching sparse-family records were found.\n";
        return output.str();
    }
    if (header_size >= target_length) {
        output << "Header size must be smaller than the target record length.\n";
        return output.str();
    }
    if (stride == 0 || (stride % 4) != 0) {
        output << "Stride must be a non-zero multiple of 4 for lane analysis.\n";
        return output.str();
    }
    if (chunk_time_millis <= 0) {
        output << "Chunk time must be positive.\n";
        return output.str();
    }
    if (chunk_radius < 0) {
        output << "Chunk radius must be non-negative.\n";
        return output.str();
    }
    if (smooth_threshold <= 0.0F) {
        output << "Smooth threshold must be positive.\n";
        return output.str();
    }
    if (move_epsilon < 0.0F) {
        output << "Move epsilon must be non-negative.\n";
        return output.str();
    }

    int derived_chunk_base_id = chunk_base_id;
    if (derived_chunk_base_id < 0) {
        derived_chunk_base_id = summary.container.game_start_chunk_id > 0 ? summary.container.game_start_chunk_id : records.front().chunk_id;
    }
    const int target_chunk_id = derived_chunk_base_id + static_cast<int>(std::floor(static_cast<double>(timestamp_millis) / static_cast<double>(chunk_time_millis)));

    std::vector<ExtractedSubrecord> window_records;
    window_records.reserve(records.size());
    for (const auto& record : records) {
        if (std::abs(record.chunk_id - target_chunk_id) <= chunk_radius) {
            window_records.push_back(record);
        }
    }

    output << "Derived chunk base id: " << derived_chunk_base_id << "\n";
    output << "Target chunk id:      " << target_chunk_id << "\n";
    output << "Window records:       " << window_records.size() << "\n\n";
    if (window_records.empty()) {
        output << "No matching family records were present in the requested chunk window.\n";
        return output.str();
    }

    const std::size_t usable_bytes = target_length - header_size;
    const std::size_t element_count = usable_bytes / stride;
    const std::size_t lane_count = std::min<std::size_t>(4, stride / 4);
    if (lane_count < 2) {
        output << "Need at least two 32-bit lanes to compare event candidates.\n";
        return output.str();
    }

    struct PairDefinition {
        std::size_t left_lane = 0;
        std::size_t right_lane = 0;
        std::string label;
    };
    struct PreviousSample {
        bool valid = false;
        std::size_t record_index = 0;
        float x = 0.0F;
        float y = 0.0F;
    };
    struct SlotPairProfile {
        std::size_t slot_index = 0;
        std::size_t pair_index = 0;
        std::size_t coordinate_samples = 0;
        std::size_t transitions = 0;
        std::size_t smooth_transitions = 0;
        std::size_t moving_transitions = 0;
        int min_chunk_id = std::numeric_limits<int>::max();
        int max_chunk_id = std::numeric_limits<int>::min();
        double sum_event_distance = 0.0;
        double best_event_distance = std::numeric_limits<double>::infinity();
        double best_x = 0.0;
        double best_y = 0.0;
        int best_chunk_id = std::numeric_limits<int>::min();
        std::size_t hits_250 = 0;
        std::size_t hits_500 = 0;
        std::size_t hits_1000 = 0;
        std::size_t hits_2000 = 0;
        std::map<std::uint8_t, std::size_t> first_byte_freq;
        std::map<std::uint8_t, std::size_t> mask_freq;
    };
    struct EventMatch {
        std::size_t slot_index = 0;
        std::string pair_label;
        double best_distance = 0.0;
        double mean_distance = 0.0;
        std::size_t coordinate_samples = 0;
        std::size_t transitions = 0;
        std::size_t hits_250 = 0;
        std::size_t hits_500 = 0;
        std::size_t hits_1000 = 0;
        std::size_t hits_2000 = 0;
        double smooth_ratio = 0.0;
        double moving_ratio = 0.0;
        std::uint8_t top_first = 0;
        std::uint8_t top_mask = 0;
        int best_chunk_id = 0;
        double best_x = 0.0;
        double best_y = 0.0;
    };

    std::vector<PairDefinition> pair_defs = {{0, 1, "+0/+4"}};
    if (lane_count >= 3) {
        pair_defs.push_back({1, 2, "+4/+8"});
        pair_defs.push_back({0, 2, "+0/+8"});
    }
    if (lane_count >= 4) {
        pair_defs.push_back({2, 3, "+8/+12"});
        pair_defs.push_back({0, 3, "+0/+12"});
    }

    const auto is_coordinate_like = [](float value) {
        return std::isfinite(value) && std::fpclassify(value) == FP_NORMAL && value >= -5000.0F && value <= 20000.0F;
    };
    const auto format_mask = [lane_count](std::uint8_t mask) {
        std::ostringstream line;
        for (int bit = static_cast<int>(lane_count) - 1; bit >= 0; --bit) {
            line << (((mask >> bit) & 1U) != 0U ? '1' : '0');
        }
        return line.str();
    };
    const auto top_freq_entry = [](const std::map<std::uint8_t, std::size_t>& freq) {
        if (freq.empty()) {
            return std::pair<std::uint8_t, std::size_t>{0, 0};
        }
        const auto it = std::max_element(freq.begin(), freq.end(), [](const auto& left, const auto& right) {
            if (left.second != right.second) {
                return left.second < right.second;
            }
            return left.first > right.first;
        });
        return std::pair<std::uint8_t, std::size_t>{it->first, it->second};
    };

    const std::size_t profile_count = element_count * pair_defs.size();
    std::vector<SlotPairProfile> profiles(profile_count);
    std::vector<PreviousSample> previous_samples(profile_count);
    for (std::size_t slot_index = 0; slot_index < element_count; ++slot_index) {
        for (std::size_t pair_index = 0; pair_index < pair_defs.size(); ++pair_index) {
            auto& profile = profiles[(slot_index * pair_defs.size()) + pair_index];
            profile.slot_index = slot_index;
            profile.pair_index = pair_index;
        }
    }

    for (std::size_t record_index = 0; record_index < window_records.size(); ++record_index) {
        const auto& rec = window_records[record_index];
        for (std::size_t slot_index = 0; slot_index < element_count; ++slot_index) {
            const std::size_t start = header_size + (slot_index * stride);
            if (start + stride > rec.payload.size()) {
                break;
            }

            std::array<bool, 4> lane_is_coordinate = {false, false, false, false};
            std::array<float, 4> lane_floats = {0.0F, 0.0F, 0.0F, 0.0F};
            std::uint8_t mask = 0;
            bool active = false;
            for (std::size_t lane_index = 0; lane_index < lane_count; ++lane_index) {
                std::uint32_t value = 0;
                if (!read_u32_le(rec.payload, start + (lane_index * 4), value) || value == padding_u32) {
                    continue;
                }
                active = true;
                mask |= static_cast<std::uint8_t>(1U << lane_index);
                const float as_float = std::bit_cast<float>(value);
                if (is_coordinate_like(as_float)) {
                    lane_is_coordinate[lane_index] = true;
                    lane_floats[lane_index] = as_float;
                }
            }
            if (!active) {
                continue;
            }

            for (std::size_t pair_index = 0; pair_index < pair_defs.size(); ++pair_index) {
                const auto& pair = pair_defs[pair_index];
                auto& profile = profiles[(slot_index * pair_defs.size()) + pair_index];
                if (!lane_is_coordinate[pair.left_lane] || !lane_is_coordinate[pair.right_lane]) {
                    continue;
                }

                const double sample_x = lane_floats[pair.left_lane];
                const double sample_y = lane_floats[pair.right_lane];
                const double event_distance = std::hypot(sample_x - event_x, sample_y - event_y);
                profile.coordinate_samples++;
                profile.first_byte_freq[rec.payload[start]]++;
                profile.mask_freq[mask]++;
                profile.min_chunk_id = std::min(profile.min_chunk_id, rec.chunk_id);
                profile.max_chunk_id = std::max(profile.max_chunk_id, rec.chunk_id);
                profile.sum_event_distance += event_distance;
                if (event_distance < profile.best_event_distance) {
                    profile.best_event_distance = event_distance;
                    profile.best_x = sample_x;
                    profile.best_y = sample_y;
                    profile.best_chunk_id = rec.chunk_id;
                }
                if (event_distance <= 250.0) {
                    profile.hits_250++;
                }
                if (event_distance <= 500.0) {
                    profile.hits_500++;
                }
                if (event_distance <= 1000.0) {
                    profile.hits_1000++;
                }
                if (event_distance <= 2000.0) {
                    profile.hits_2000++;
                }

                auto& previous = previous_samples[(slot_index * pair_defs.size()) + pair_index];
                if (previous.valid && previous.record_index + 1 == record_index) {
                    const float distance = std::hypot(static_cast<float>(sample_x) - previous.x, static_cast<float>(sample_y) - previous.y);
                    profile.transitions++;
                    if (distance <= smooth_threshold) {
                        profile.smooth_transitions++;
                        if (distance >= move_epsilon) {
                            profile.moving_transitions++;
                        }
                    }
                }
                previous.valid = true;
                previous.record_index = record_index;
                previous.x = static_cast<float>(sample_x);
                previous.y = static_cast<float>(sample_y);
            }
        }
    }

    std::vector<EventMatch> matches;
    matches.reserve(profiles.size());
    for (const auto& profile : profiles) {
        if (profile.coordinate_samples < 3 || !std::isfinite(profile.best_event_distance)) {
            continue;
        }
        const auto& pair = pair_defs[profile.pair_index];
        const auto top_first = top_freq_entry(profile.first_byte_freq);
        const auto top_mask = top_freq_entry(profile.mask_freq);
        const double smooth_ratio = profile.transitions > 0
            ? static_cast<double>(profile.smooth_transitions) / static_cast<double>(profile.transitions)
            : 1.0;
        const double moving_ratio = profile.transitions > 0
            ? static_cast<double>(profile.moving_transitions) / static_cast<double>(profile.transitions)
            : 0.0;
        matches.push_back({
            profile.slot_index,
            pair.label,
            profile.best_event_distance,
            profile.sum_event_distance / static_cast<double>(profile.coordinate_samples),
            profile.coordinate_samples,
            profile.transitions,
            profile.hits_250,
            profile.hits_500,
            profile.hits_1000,
            profile.hits_2000,
            smooth_ratio,
            moving_ratio,
            top_first.first,
            top_mask.first,
            profile.best_chunk_id,
            profile.best_x,
            profile.best_y,
        });
    }

    std::sort(matches.begin(), matches.end(), [](const EventMatch& left, const EventMatch& right) {
        if (left.hits_250 != right.hits_250) {
            return left.hits_250 > right.hits_250;
        }
        if (left.hits_500 != right.hits_500) {
            return left.hits_500 > right.hits_500;
        }
        if (left.hits_1000 != right.hits_1000) {
            return left.hits_1000 > right.hits_1000;
        }
        if (left.hits_2000 != right.hits_2000) {
            return left.hits_2000 > right.hits_2000;
        }
        if (left.best_distance != right.best_distance) {
            return left.best_distance < right.best_distance;
        }
        if (left.mean_distance != right.mean_distance) {
            return left.mean_distance < right.mean_distance;
        }
        return left.coordinate_samples > right.coordinate_samples;
    });

    output << "Candidate event matches: " << matches.size() << "\n\n";
    if (matches.empty()) {
        output << "No event-window candidates met the minimum sample threshold.\n";
        return output.str();
    }

    if (top_slots == 0) {
        top_slots = 40;
    }
    const std::size_t shown = std::min<std::size_t>(top_slots, matches.size());
    output << "Best event-local candidates:\n";
    for (std::size_t index = 0; index < shown; ++index) {
        const auto& match = matches[index];
        output << "  #" << index + 1
               << " | slot=" << std::setw(4) << std::setfill('0') << match.slot_index << std::setfill(' ')
               << " | pair=" << match.pair_label
               << " | bestDist=" << std::fixed << std::setprecision(2) << match.best_distance
               << " | meanDist=" << match.mean_distance
               << " | hits250/500/1000/2000=" << match.hits_250 << '/' << match.hits_500 << '/' << match.hits_1000 << '/' << match.hits_2000
               << " | samples=" << match.coordinate_samples
               << " | transitions=" << match.transitions
               << " | smooth=" << match.smooth_ratio
               << " | moving=" << match.moving_ratio
               << " | bestChunk=" << match.best_chunk_id
               << " | bestXY=(" << match.best_x << ", " << match.best_y << ")"
               << " | first=0x" << std::hex << std::uppercase << std::setw(2) << std::setfill('0') << static_cast<int>(match.top_first)
               << std::dec << std::setfill(' ') << " | mask=" << format_mask(match.top_mask)
               << "\n";
    }

    output << "\nInterpretation note:\n";
    output << "  This command checks whether any raw coordinate-like slot samples in the event chunk window land near the known event location.\n";
    output << "  Strong candidates should show small best-distance values and multiple hits inside 500-1000 world units, not just one accidental close sample.\n";
    return output.str();
}

}  // namespace rofl::core





























