#include "rofl/core/replay_analyzer.hpp"

#include <algorithm>
#include <cctype>
#include <fstream>
#include <sstream>
#include <stdexcept>
#include <string_view>

namespace rofl::core {
namespace {

constexpr std::string_view kMetadataMarker = "{\"gameLength\":";
constexpr std::size_t kKnownHeaderLength = 288;
constexpr std::size_t kKnownPayloadHeaderMinimumSize = 34;
constexpr std::size_t kKnownSegmentHeaderLength = 17;
constexpr std::size_t kFooterLengthFieldSize = 4;

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

[[nodiscard]] std::vector<PlayerSummary> parse_players_from_stats_json(const std::string& stats_json) {
    std::vector<PlayerSummary> players;
    for (const std::string& object_json : split_top_level_objects(stats_json)) {
        PlayerSummary player;
        player.champion = parse_string_field(object_json, "SKIN");
        player.riot_id_game_name = parse_string_field(object_json, "RIOT_ID_GAME_NAME");
        player.riot_id_tag_line = parse_string_field(object_json, "RIOT_ID_TAG_LINE");
        player.team_position = parse_string_field(object_json, "TEAM_POSITION");
        player.win = parse_string_field(object_json, "WIN");
        player.team = parse_int_field(object_json, "TEAM");
        player.kills = parse_int_field(object_json, "CHAMPIONS_KILLED");
        player.deaths = parse_int_field(object_json, "NUM_DEATHS");
        player.assists = parse_int_field(object_json, "ASSISTS");
        player.gold_earned = parse_int_field(object_json, "GOLD_EARNED");
        player.total_damage_to_champions = parse_int_field(object_json, "TOTAL_DAMAGE_DEALT_TO_CHAMPIONS");
        player.vision_score = parse_int_field(object_json, "VISION_SCORE");
        players.push_back(std::move(player));
    }

    return players;
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
        .version = "0.3.0-container-probe",
        .parser_state = "metadata-plus-known-container-layouts",
        .wasm_state = "scaffolded-not-built"
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

ReplaySummary parse_replay_bytes(const std::vector<std::uint8_t>& bytes) {
    ReplaySummary summary;
    summary.file_size = bytes.size();
    summary.game_version = scan_game_version(bytes);

    KnownBinaryHeader binary_header;
    KnownPayloadHeader payload_header;

    if (parse_known_binary_header(bytes, binary_header)) {
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

        summary.warnings.push_back(
            "Payload header and segment table parsing are currently available only for the known classic ROFL layout. Payload decoding is not implemented yet."
        );
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

    try {
        const std::string stats_json = parse_string_field(summary.metadata_json, "statsJson");
        if (!stats_json.empty()) {
            summary.players = parse_players_from_stats_json(stats_json);
            summary.capabilities.player_stats_available = true;
        }
    } catch (const std::exception& exception) {
        throw std::runtime_error("Failed while parsing statsJson from embedded metadata: " + std::string(exception.what()));
    }

    return summary;
}

ReplaySummary parse_replay_file(const std::string& path) {
    return parse_replay_bytes(read_file_bytes(path));
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
        output << "\"offset\":" << segment.offset;
        output << '}';
    }
    output << "]},";

    output << "\"capabilities\":{";
    output << "\"metadataAvailable\":" << bool_to_json(summary.capabilities.metadata_available) << ',';
    output << "\"playerStatsAvailable\":" << bool_to_json(summary.capabilities.player_stats_available) << ',';
    output << "\"binaryHeaderAvailable\":" << bool_to_json(summary.capabilities.binary_header_available) << ',';
    output << "\"payloadHeaderAvailable\":" << bool_to_json(summary.capabilities.payload_header_available) << ',';
    output << "\"segmentTableAvailable\":" << bool_to_json(summary.capabilities.segment_table_available) << ',';
    output << "\"payloadDecodingAvailable\":" << bool_to_json(summary.capabilities.payload_decoding_available) << ',';
    output << "\"movementTimelineAvailable\":" << bool_to_json(summary.capabilities.movement_timeline_available);
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
        output << "\"visionScore\":" << player.vision_score;
        output << '}';
    }
    output << "],";

    output << "\"metadataJson\":\"" << json_escape(summary.metadata_json) << "\"";
    output << '}';
    return output.str();
}

}  // namespace rofl::core
