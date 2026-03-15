#include "rofl/core/replay_analyzer.hpp"
#include <array>
#include <bit>
#include <cmath>
#include <limits>
#include <numeric>

#include <algorithm>
#include <cctype>
#include <fstream>
#include <iomanip>
#include <map>
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
        .version = "0.6.0-footer-payload-inspector",
        .parser_state = "footer-zstd-records-plus-inspector",
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

    try {
        const std::string stats_json = parse_string_field(summary.metadata_json, "statsJson");
        if (!stats_json.empty()) {
            summary.players = parse_players_from_stats_json(stats_json);
            summary.capabilities.player_stats_available = true;
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
                    "Footer-style zstd records were indexed from the pre-metadata payload region, and raw zstd decompression is available. Packet decoding is still not implemented."
                );
            } else {
                summary.warnings.push_back(
                    "Footer-style zstd records were indexed from the pre-metadata payload region, but raw zstd decompression could not be verified yet. Packet decoding is still not implemented."
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

struct ExtractedSubrecord {
    int chunk_id = 0;
    std::size_t chunk_offset = 0;
    std::vector<std::uint8_t> payload;
};

[[nodiscard]] std::vector<ExtractedSubrecord> extract_subrecord_family(
    const std::vector<std::uint8_t>& bytes,
    const ReplaySummary& summary,
    std::size_t target_length,
    std::uint8_t target_first_byte
) {
    std::vector<ExtractedSubrecord> results;

    for (const ReplaySegmentSummary& segment : summary.container.segments) {
        if (segment.codec != "zstd" || segment.type != "chunk") continue;

        std::vector<std::uint8_t> decompressed;
        std::string error;
        if (try_decompress_zstd_segment(bytes, segment, decompressed, error)) {
            const auto best_u16 = analyze_le_length_prefix(decompressed, 2);
            if (best_u16.record_count >= 2) {
                // Check framing at offset 0 and offset 1 (as seen in chunk 6)
                const auto best_u16_offset_1 = analyze_le_length_prefix(std::vector<std::uint8_t>(decompressed.begin() + 1, decompressed.end()), 2);
                
                std::size_t start_offset = best_u16.start_offset;
                if (best_u16_offset_1.record_count > best_u16.record_count) {
                    start_offset = best_u16_offset_1.start_offset + 1;
                }

                auto records = extract_le_framed_subrecords(decompressed, 2, start_offset, 1000000);
                for (const auto& rec : records) {
                    if (rec.length == target_length && decompressed[rec.payload_offset] == target_first_byte) {
                        ExtractedSubrecord extracted;
                        extracted.chunk_id = segment.chunk_id;
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
}  // namespace rofl::core















