#include <algorithm>
#include <bit>
#include <cstdlib>
#include <cstdint>
#include <fstream>
#include <sstream>
#include <string>
#include <vector>

#include <zstd.h>

#include "rofl/core/replay_analyzer.hpp"

namespace {

void write_u16_le(std::vector<std::uint8_t>& bytes, std::size_t offset, std::uint16_t value) {
    bytes[offset] = static_cast<std::uint8_t>(value & 0xFFu);
    bytes[offset + 1] = static_cast<std::uint8_t>((value >> 8u) & 0xFFu);
}

void write_u32_le(std::vector<std::uint8_t>& bytes, std::size_t offset, std::uint32_t value) {
    bytes[offset] = static_cast<std::uint8_t>(value & 0xFFu);
    bytes[offset + 1] = static_cast<std::uint8_t>((value >> 8u) & 0xFFu);
    bytes[offset + 2] = static_cast<std::uint8_t>((value >> 16u) & 0xFFu);
    bytes[offset + 3] = static_cast<std::uint8_t>((value >> 24u) & 0xFFu);
}

void write_u64_le(std::vector<std::uint8_t>& bytes, std::size_t offset, std::uint64_t value) {
    write_u32_le(bytes, offset, static_cast<std::uint32_t>(value & 0xFFFFFFFFull));
    write_u32_le(bytes, offset + 4, static_cast<std::uint32_t>((value >> 32u) & 0xFFFFFFFFull));
}

void write_ascii(std::vector<std::uint8_t>& bytes, std::size_t offset, const std::string& text) {
    for (std::size_t index = 0; index < text.size(); ++index) {
        bytes[offset + index] = static_cast<std::uint8_t>(text[index]);
    }
}

std::vector<std::uint8_t> compress_zstd_payload(const std::string& text) {
    std::vector<std::uint8_t> compressed(ZSTD_compressBound(text.size()));
    const std::size_t result = ZSTD_compress(
        compressed.data(),
        compressed.size(),
        text.data(),
        text.size(),
        1
    );
    if (ZSTD_isError(result) != 0) {
        return {};
    }
    compressed.resize(result);
    return compressed;
}

void write_zstd_record_header(
    std::vector<std::uint8_t>& bytes,
    std::size_t offset,
    std::uint8_t id,
    std::uint8_t related_id,
    std::uint8_t kind,
    std::uint32_t uncompressed_length,
    std::uint32_t compressed_length
) {
    bytes[offset] = id;
    bytes[offset + 4] = related_id;
    bytes[offset + 8] = kind;
    write_u32_le(bytes, offset + 9, uncompressed_length);
    write_u32_le(bytes, offset + 13, compressed_length);
}

void write_zstd_payload(std::vector<std::uint8_t>& bytes, std::size_t offset, std::uint32_t compressed_length) {
    bytes[offset] = 0x28;
    bytes[offset + 1] = 0xB5;
    bytes[offset + 2] = 0x2F;
    bytes[offset + 3] = 0xFD;
    for (std::uint32_t index = 4; index < compressed_length; ++index) {
        bytes[offset + index] = static_cast<std::uint8_t>((offset + index) & 0xFFu);
    }
}

std::vector<std::uint8_t> build_classic_rofl_fixture() {
    const std::string metadata =
        "{\"gameLength\":123456,\"lastGameChunkId\":66,\"lastKeyFrameId\":32,\"statsJson\":\"[{\\\"TEAM\\\":\\\"100\\\",\\\"SKIN\\\":\\\"Ornn\\\",\\\"RIOT_ID_GAME_NAME\\\":\\\"TheBearinator\\\",\\\"RIOT_ID_TAG_LINE\\\":\\\"BABBA\\\",\\\"TEAM_POSITION\\\":\\\"TOP\\\",\\\"WIN\\\":\\\"Win\\\",\\\"CHAMPIONS_KILLED\\\":\\\"3\\\",\\\"NUM_DEATHS\\\":\\\"7\\\",\\\"ASSISTS\\\":\\\"6\\\",\\\"GOLD_EARNED\\\":\\\"10373\\\",\\\"TOTAL_DAMAGE_DEALT_TO_CHAMPIONS\\\":\\\"27239\\\",\\\"VISION_SCORE\\\":\\\"17\\\",\\\"LEVEL\\\":\\\"18\\\",\\\"EXP\\\":\\\"19342\\\",\\\"MINIONS_KILLED\\\":\\\"241\\\",\\\"NEUTRAL_MINIONS_KILLED\\\":\\\"17\\\",\\\"ITEM0\\\":\\\"1001\\\",\\\"ITEM1\\\":\\\"1002\\\",\\\"ITEM2\\\":\\\"1003\\\",\\\"ITEM3\\\":\\\"1004\\\",\\\"ITEM4\\\":\\\"1005\\\",\\\"ITEM5\\\":\\\"1006\\\",\\\"ITEM6\\\":\\\"0\\\",\\\"WARD_PLACED\\\":\\\"12\\\",\\\"WARD_KILLED\\\":\\\"4\\\"}]\"}";
    const std::string encrypted_key = "QUJDREVGR0g=";

    const std::size_t metadata_offset = 288;
    const std::size_t payload_header_offset = metadata_offset + metadata.size();
    const std::size_t payload_header_size = 34 + encrypted_key.size();
    const std::size_t payload_offset = payload_header_offset + payload_header_size;
    const std::size_t segment_count = 1;
    const std::size_t total_size = payload_offset + (segment_count * 17);

    std::vector<std::uint8_t> bytes(total_size, 0);
    write_ascii(bytes, 0, "RIOT");
    bytes[4] = 0x02;
    bytes[5] = 0x00;
    write_ascii(bytes, 16, "16.5.752.7101");

    write_u16_le(bytes, 262, 288);
    write_u32_le(bytes, 264, static_cast<std::uint32_t>(total_size));
    write_u32_le(bytes, 268, static_cast<std::uint32_t>(metadata_offset));
    write_u32_le(bytes, 272, static_cast<std::uint32_t>(metadata.size()));
    write_u32_le(bytes, 276, static_cast<std::uint32_t>(payload_header_offset));
    write_u32_le(bytes, 280, static_cast<std::uint32_t>(payload_header_size));
    write_u32_le(bytes, 284, static_cast<std::uint32_t>(payload_offset));

    write_ascii(bytes, metadata_offset, metadata);

    write_u64_le(bytes, payload_header_offset, 7779216102ull);
    write_u32_le(bytes, payload_header_offset + 8, 123456);
    write_u32_le(bytes, payload_header_offset + 12, 0);
    write_u32_le(bytes, payload_header_offset + 16, 1);
    write_u32_le(bytes, payload_header_offset + 20, 0);
    write_u32_le(bytes, payload_header_offset + 24, 1);
    write_u32_le(bytes, payload_header_offset + 28, 30000);
    write_u16_le(bytes, payload_header_offset + 32, static_cast<std::uint16_t>(encrypted_key.size()));
    write_ascii(bytes, payload_header_offset + 34, encrypted_key);

    write_u32_le(bytes, payload_offset, 1);
    bytes[payload_offset + 4] = 1;
    write_u32_le(bytes, payload_offset + 5, 100);
    write_u32_le(bytes, payload_offset + 9, 0);
    write_u32_le(bytes, payload_offset + 13, 0);

    return bytes;
}

std::vector<std::uint8_t> build_footer_fixture() {
    const std::string metadata =
        "{\"gameLength\":1895012,\"lastGameChunkId\":66,\"lastKeyFrameId\":32,\"statsJson\":\"[]\"}";
    std::vector<std::uint8_t> bytes(64 + metadata.size() + 4, 0);
    write_ascii(bytes, 0, "RIOT");
    bytes[4] = 0x02;
    bytes[5] = 0x00;
    write_ascii(bytes, 16, "16.5.752.7101");

    const std::size_t metadata_offset = bytes.size() - 4 - metadata.size();
    write_ascii(bytes, metadata_offset, metadata);
    write_u32_le(bytes, bytes.size() - 4, static_cast<std::uint32_t>(metadata.size()));
    return bytes;
}

std::vector<std::uint8_t> build_footer_zstd_fixture() {
    const std::string metadata =
        R"({"gameLength":240000,"lastGameChunkId":4,"lastKeyFrameId":1,"statsJson":"[]"})";

    const std::string startup_payload = "startup:hello";
    const std::string keyframe_payload = "keyframe:state";
    const std::string chunk3_payload = "chunk:3:movement";
    const std::string chunk4_payload = "chunk:4:events";

    const auto startup_compressed = compress_zstd_payload(startup_payload);
    const auto keyframe_compressed = compress_zstd_payload(keyframe_payload);
    const auto chunk3_compressed = compress_zstd_payload(chunk3_payload);
    const auto chunk4_compressed = compress_zstd_payload(chunk4_payload);
    if (startup_compressed.empty() || keyframe_compressed.empty() || chunk3_compressed.empty() || chunk4_compressed.empty()) {
        return {};
    }

    constexpr std::size_t start_offset = 28;
    const std::size_t startup_header = start_offset;
    const std::size_t startup_payload_offset = startup_header + 17;
    const std::size_t keyframe_header = startup_payload_offset + startup_compressed.size();
    const std::size_t keyframe_payload_offset = keyframe_header + 17;
    const std::size_t chunk3_header = keyframe_payload_offset + keyframe_compressed.size();
    const std::size_t chunk3_payload_offset = chunk3_header + 17;
    const std::size_t chunk4_header = chunk3_payload_offset + chunk3_compressed.size();
    const std::size_t chunk4_payload_offset = chunk4_header + 17;
    const std::size_t metadata_offset = chunk4_payload_offset + chunk4_compressed.size();
    const std::size_t total_size = metadata_offset + metadata.size() + 4;

    std::vector<std::uint8_t> bytes(total_size, 0);
    write_ascii(bytes, 0, "RIOT");
    bytes[4] = 0x02;
    bytes[5] = 0x00;
    write_ascii(bytes, 16, "16.5.752.7101");

    write_zstd_record_header(
        bytes,
        startup_header,
        1,
        2,
        3,
        static_cast<std::uint32_t>(startup_payload.size()),
        static_cast<std::uint32_t>(startup_compressed.size())
    );
    std::copy(startup_compressed.begin(), startup_compressed.end(), bytes.begin() + startup_payload_offset);

    write_zstd_record_header(
        bytes,
        keyframe_header,
        1,
        3,
        2,
        static_cast<std::uint32_t>(keyframe_payload.size()),
        static_cast<std::uint32_t>(keyframe_compressed.size())
    );
    std::copy(keyframe_compressed.begin(), keyframe_compressed.end(), bytes.begin() + keyframe_payload_offset);

    write_zstd_record_header(
        bytes,
        chunk3_header,
        3,
        4,
        1,
        static_cast<std::uint32_t>(chunk3_payload.size()),
        static_cast<std::uint32_t>(chunk3_compressed.size())
    );
    std::copy(chunk3_compressed.begin(), chunk3_compressed.end(), bytes.begin() + chunk3_payload_offset);

    write_zstd_record_header(
        bytes,
        chunk4_header,
        4,
        5,
        1,
        static_cast<std::uint32_t>(chunk4_payload.size()),
        static_cast<std::uint32_t>(chunk4_compressed.size())
    );
    std::copy(chunk4_compressed.begin(), chunk4_compressed.end(), bytes.begin() + chunk4_payload_offset);

    write_ascii(bytes, metadata_offset, metadata);
    write_u32_le(bytes, total_size - 4, static_cast<std::uint32_t>(metadata.size()));
    return bytes;
}

void append_u16_le(std::vector<std::uint8_t>& bytes, std::uint16_t value) {
    bytes.push_back(static_cast<std::uint8_t>(value & 0xFFu));
    bytes.push_back(static_cast<std::uint8_t>((value >> 8u) & 0xFFu));
}

void append_u32_le(std::vector<std::uint8_t>& bytes, std::uint32_t value) {
    bytes.push_back(static_cast<std::uint8_t>(value & 0xFFu));
    bytes.push_back(static_cast<std::uint8_t>((value >> 8u) & 0xFFu));
    bytes.push_back(static_cast<std::uint8_t>((value >> 16u) & 0xFFu));
    bytes.push_back(static_cast<std::uint8_t>((value >> 24u) & 0xFFu));
}

void append_packet_block(
    std::vector<std::uint8_t>& bytes,
    float timestamp_seconds,
    std::uint16_t packet_type,
    std::uint32_t block_param,
    std::uint32_t content_length
) {
    bytes.push_back(0x01);  // channel 1, direct timestamp/length/type/parameter
    append_u32_le(bytes, std::bit_cast<std::uint32_t>(timestamp_seconds));
    append_u32_le(bytes, content_length);
    append_u16_le(bytes, packet_type);
    append_u32_le(bytes, block_param);
    bytes.insert(bytes.end(), content_length, 0);
}

void append_packet_block_with_content(
    std::vector<std::uint8_t>& bytes,
    float timestamp_seconds,
    std::uint16_t packet_type,
    std::uint32_t block_param,
    const std::vector<std::uint8_t>& content
) {
    bytes.push_back(0x01);  // channel 1, direct timestamp/length/type/parameter
    append_u32_le(bytes, std::bit_cast<std::uint32_t>(timestamp_seconds));
    append_u32_le(bytes, static_cast<std::uint32_t>(content.size()));
    append_u16_le(bytes, packet_type);
    append_u32_le(bytes, block_param);
    bytes.insert(bytes.end(), content.begin(), content.end());
}

std::string escape_json_string(const std::string& input) {
    std::string escaped;
    for (const char ch : input) {
        if (ch == '"' || ch == '\\') escaped.push_back('\\');
        escaped.push_back(ch);
    }
    return escaped;
}

std::vector<std::uint8_t> build_footer_kill_fixture() {
    constexpr std::uint32_t champion_base = 0x400000AD;
    constexpr std::uint16_t owner_packet_type = 0x021A;
    constexpr std::uint16_t marker_packet_type = 0x03EF;
    std::vector<std::uint8_t> payload;
    append_packet_block(payload, 10.0F, marker_packet_type, champion_base + 4, 5);  // orphan marker
    append_packet_block(payload, 12.5F, owner_packet_type, champion_base + 1, 0);  // victim
    append_packet_block(payload, 12.5F, owner_packet_type, champion_base + 3, 0);  // assist
    append_packet_block(payload, 12.5F, owner_packet_type, champion_base + 2, 0);  // killer
    append_packet_block(payload, 12.5F, marker_packet_type, champion_base + 1, 5);

    std::ostringstream stats;
    stats << '[';
    for (int participant_id = 1; participant_id <= 10; ++participant_id) {
        if (participant_id > 1) stats << ',';
        stats << "{\"TEAM\":\"" << (participant_id <= 5 ? 100 : 200)
              << "\",\"SKIN\":\"Champion" << participant_id
              << "\",\"TEAM_POSITION\":\"" << (participant_id == 1 ? "TOP" : "UNKNOWN")
              << "\",\"RIOT_ID_GAME_NAME\":\"Player" << participant_id
              << "\",\"RIOT_ID_TAG_LINE\":\"TEST\",\"CHAMPIONS_KILLED\":\""
              << (participant_id == 2 ? 1 : 0) << "\",\"NUM_DEATHS\":\""
              << (participant_id == 1 ? 1 : 0) << "\",\"ASSISTS\":\""
              << (participant_id == 3 ? 1 : 0) << "\"}";
    }
    stats << ']';
    const std::string metadata =
        "{\"gameLength\":240000,\"lastGameChunkId\":1,\"lastKeyFrameId\":0,\"statsJson\":\"" +
        escape_json_string(stats.str()) + "\"}";
    const auto compressed = compress_zstd_payload(std::string(
        reinterpret_cast<const char*>(payload.data()), payload.size()));
    if (compressed.empty()) return {};

    constexpr std::size_t header_offset = 32;
    constexpr std::size_t payload_offset = header_offset + 17;
    const std::size_t metadata_offset = payload_offset + compressed.size();
    const std::size_t total_size = metadata_offset + metadata.size() + 4;
    std::vector<std::uint8_t> bytes(total_size, 0);
    write_ascii(bytes, 0, "RIOT");
    bytes[4] = 0x02;
    write_ascii(bytes, 16, "16.5.752.7101");
    write_zstd_record_header(bytes, header_offset, 1, 2, 1,
        static_cast<std::uint32_t>(payload.size()), static_cast<std::uint32_t>(compressed.size()));
    std::copy(compressed.begin(), compressed.end(), bytes.begin() + payload_offset);
    write_ascii(bytes, metadata_offset, metadata);
    write_u32_le(bytes, total_size - 4, static_cast<std::uint32_t>(metadata.size()));
    return bytes;
}

std::vector<std::uint8_t> build_footer_objective_fixture() {
    constexpr std::uint16_t objective_packet_type = 0x01EB;
    std::vector<std::uint8_t> payload;

    auto append_objective = [&](float timestamp_seconds, std::size_t content_length,
                                std::uint8_t discriminator) {
        std::vector<std::uint8_t> content(content_length, 0);
        content[2] = discriminator;
        append_packet_block_with_content(
            payload,
            timestamp_seconds,
            objective_packet_type,
            0,
            content
        );
    };

    append_objective(1.0F, 18, 69);    // Same opcode, rejected content length.
    append_objective(2.0F, 132, 0);    // Profile length, unknown discriminator.
    append_objective(10.0F, 132, 69);  // Dragon.
    append_objective(20.0F, 132, 172); // Baron Nashor.
    append_objective(30.0F, 132, 118); // Rift Herald.
    append_objective(40.0F, 133, 123); // Horde.

    std::vector<std::uint8_t> unrelated_content(132, 0);
    unrelated_content[2] = 69;
    append_packet_block_with_content(payload, 50.0F, 0xFFFF, 0, unrelated_content);

    const std::string metadata =
        R"({"gameLength":60000,"lastGameChunkId":1,"lastKeyFrameId":0,"statsJson":"[]"})";
    const auto compressed = compress_zstd_payload(std::string(
        reinterpret_cast<const char*>(payload.data()),
        payload.size()
    ));
    if (compressed.empty()) return {};

    constexpr std::size_t header_offset = 32;
    constexpr std::size_t payload_offset = header_offset + 17;
    const std::size_t metadata_offset = payload_offset + compressed.size();
    const std::size_t total_size = metadata_offset + metadata.size() + 4;
    std::vector<std::uint8_t> bytes(total_size, 0);
    write_ascii(bytes, 0, "RIOT");
    bytes[4] = 0x02;
    write_ascii(bytes, 16, "16.9.772.8292");
    write_zstd_record_header(
        bytes,
        header_offset,
        1,
        2,
        1,
        static_cast<std::uint32_t>(payload.size()),
        static_cast<std::uint32_t>(compressed.size())
    );
    std::copy(compressed.begin(), compressed.end(), bytes.begin() + payload_offset);
    write_ascii(bytes, metadata_offset, metadata);
    write_u32_le(bytes, total_size - 4, static_cast<std::uint32_t>(metadata.size()));
    return bytes;
}

std::vector<std::uint8_t> build_classic_invalid_final_stats_fixture() {
    std::vector<std::uint8_t> bytes = build_classic_rofl_fixture();
    const std::string needle_text = "\\\"EXP\\\":\\\"19342\\\"";
    const std::vector<std::uint8_t> needle(needle_text.begin(), needle_text.end());
    const auto found = std::search(bytes.begin(), bytes.end(), needle.begin(), needle.end());
    if (found == bytes.end()) return {};
    const std::size_t digit_offset = needle_text.find("19342");
    *(found + static_cast<std::ptrdiff_t>(digit_offset)) = static_cast<std::uint8_t>('x');
    return bytes;
}

std::vector<std::uint8_t> build_footer_ward_fixture() {
    constexpr std::uint32_t champion_base = 0x400000AD;
    constexpr std::uint16_t placement_marker_packet_type = 0x0041;
    constexpr std::uint16_t placement_owner_packet_type = 0x04AC;
    constexpr std::uint16_t removal_packet_type = 0x02E6;
    constexpr std::uint16_t killer_owner_packet_type = 0x02F6;
    constexpr std::uint16_t primary_spawn_packet_type = 0x00D6;
    constexpr std::uint16_t companion_spawn_packet_type = 0x01AD;
    constexpr std::uint32_t first_ward_id = 0x50000001;
    constexpr std::uint32_t second_ward_id = 0x50000002;
    constexpr std::uint32_t ignored_ward_id = 0x50000003;
    std::vector<std::uint8_t> payload;

    const auto placement_content = [](std::uint8_t discriminator) {
        return std::vector<std::uint8_t>{0, 0, discriminator};
    };
    const auto research_spawn_content = [](std::uint8_t seed) {
        std::vector<std::uint8_t> content(63);
        for (std::size_t index = 0; index < content.size(); ++index) {
            content[index] = static_cast<std::uint8_t>(
                seed + static_cast<std::uint8_t>(index * 3)
            );
        }
        return content;
    };

    append_packet_block_with_content(
        payload, 1.0F, placement_marker_packet_type, ignored_ward_id,
        placement_content(0xB0)
    );  // Classified marker without an owner.
    append_packet_block_with_content(
        payload, 1.1F, placement_marker_packet_type, ignored_ward_id + 1,
        placement_content(0x00)
    );  // Profile opcode and length, but an unrecognized discriminator.
    append_packet_block(payload, 1.2F, placement_marker_packet_type, ignored_ward_id + 2, 2);

    append_packet_block(payload, 2.0F, placement_owner_packet_type, champion_base + 1, 2);
    append_packet_block_with_content(
        payload,
        2.0F,
        primary_spawn_packet_type,
        first_ward_id,
        research_spawn_content(0x10)
    );
    append_packet_block_with_content(
        payload,
        2.0F,
        companion_spawn_packet_type,
        first_ward_id,
        research_spawn_content(0x20)
    );
    append_packet_block_with_content(
        payload, 2.0F, placement_marker_packet_type, first_ward_id,
        placement_content(0xB0)
    );
    append_packet_block_with_content(
        payload, 2.0F, placement_marker_packet_type, ignored_ward_id + 3,
        placement_content(0xB0)
    );  // Only the first classified marker after the owner may be emitted.

    append_packet_block(payload, 3.0F, placement_owner_packet_type, champion_base + 2, 4);
    append_packet_block_with_content(
        payload,
        3.0F,
        primary_spawn_packet_type,
        second_ward_id,
        research_spawn_content(0x30)
    );
    append_packet_block_with_content(
        payload,
        3.0F,
        companion_spawn_packet_type,
        second_ward_id,
        research_spawn_content(0x40)
    );
    append_packet_block_with_content(
        payload, 3.0F, placement_marker_packet_type, second_ward_id,
        placement_content(0xB0)
    );

    append_packet_block(payload, 4.0F, killer_owner_packet_type, champion_base + 4, 6);
    append_packet_block(payload, 4.0F, killer_owner_packet_type, champion_base + 3, 7);
    append_packet_block(payload, 4.0F, removal_packet_type, first_ward_id, 28);
    append_packet_block(payload, 4.1F, removal_packet_type, ignored_ward_id, 28);

    append_packet_block(payload, 5.0F, killer_owner_packet_type, champion_base + 5, 6);
    append_packet_block(payload, 5.0F, removal_packet_type, second_ward_id, 27);

    const std::string metadata =
        R"({"gameLength":60000,"lastGameChunkId":1,"lastKeyFrameId":0,"statsJson":"[]"})";
    const auto compressed = compress_zstd_payload(std::string(
        reinterpret_cast<const char*>(payload.data()),
        payload.size()
    ));
    if (compressed.empty()) return {};

    constexpr std::size_t header_offset = 32;
    constexpr std::size_t payload_offset = header_offset + 17;
    const std::size_t metadata_offset = payload_offset + compressed.size();
    const std::size_t total_size = metadata_offset + metadata.size() + 4;
    std::vector<std::uint8_t> bytes(total_size, 0);
    write_ascii(bytes, 0, "RIOT");
    bytes[4] = 0x02;
    write_ascii(bytes, 16, "16.9.772.8292");
    write_zstd_record_header(
        bytes,
        header_offset,
        1,
        2,
        1,
        static_cast<std::uint32_t>(payload.size()),
        static_cast<std::uint32_t>(compressed.size())
    );
    std::copy(compressed.begin(), compressed.end(), bytes.begin() + payload_offset);
    write_ascii(bytes, metadata_offset, metadata);
    write_u32_le(bytes, total_size - 4, static_cast<std::uint32_t>(metadata.size()));
    return bytes;
}


bool test_classic_fixture() {
    const auto summary = rofl::core::parse_replay_bytes(build_classic_rofl_fixture());
    if (summary.game_version != "16.5.752.7101") {
        return false;
    }
    if (summary.game_length_millis != 123456 || summary.last_game_chunk_id != 66 || summary.last_keyframe_id != 32) {
        return false;
    }
    if (summary.container.format != "classic-rofl" || !summary.container.binary_header_present) {
        return false;
    }
    if (!summary.container.payload_header_present || !summary.container.segment_table_present) {
        return false;
    }
    if (summary.container.match_id != 7779216102ull || summary.container.chunk_count != 1) {
        return false;
    }
    if (summary.container.segments.size() != 1 || summary.container.segments.front().type != "chunk") {
        return false;
    }
    if (summary.container.segments.front().payload_offset <= 0 || summary.container.segments.front().codec != "unknown") {
        return false;
    }
    if (summary.players.size() != 1) {
        return false;
    }
    if (!summary.capabilities.validated_final_player_stats_available) {
        return false;
    }

    const auto& player = summary.players.front();
    if (player.champion != "Ornn" || player.team != 100 || player.kills != 3 ||
        player.deaths != 7 || player.assists != 6 || player.level != 18 ||
        player.experience != 19342 || player.lane_minions_killed != 241 ||
        player.neutral_minions_killed != 17 ||
        player.items != std::array<int, 7>{1001, 1002, 1003, 1004, 1005, 1006, 0} ||
        player.wards_placed != 12 || player.wards_killed != 4) {
        return false;
    }

    const std::string json = rofl::core::replay_summary_to_json(summary);
    const std::string probe = rofl::core::probe_replay_bytes(build_classic_rofl_fixture());
    return json.find("\"segmentTableAvailable\":true") != std::string::npos &&
           json.find("\"validatedFinalPlayerStatsAvailable\":true") != std::string::npos &&
           json.find("\"payloadOffset\":") != std::string::npos &&
           json.find("\"level\":18") != std::string::npos &&
           json.find("\"experience\":19342") != std::string::npos &&
           json.find("\"laneMinionsKilled\":241") != std::string::npos &&
           json.find("\"neutralMinionsKilled\":17") != std::string::npos &&
           json.find("\"items\":[1001,1002,1003,1004,1005,1006,0]") != std::string::npos &&
           json.find("\"wardsPlaced\":12") != std::string::npos &&
           json.find("\"wardsKilled\":4") != std::string::npos &&
           probe.find("Classic header valid: yes") != std::string::npos &&
           probe.find("Container format: classic-rofl") != std::string::npos &&
           probe.find("Metadata source: binary-header") != std::string::npos;
}

bool test_invalid_final_player_stats_capability() {
    const auto summary =
        rofl::core::parse_replay_bytes(build_classic_invalid_final_stats_fixture());
    if (summary.players.size() != 1 ||
        summary.capabilities.validated_final_player_stats_available) {
        return false;
    }
    const std::string json = rofl::core::replay_summary_to_json(summary);
    return json.find("\"validatedFinalPlayerStatsAvailable\":false") != std::string::npos;
}

bool test_footer_fixture() {
    const auto summary = rofl::core::parse_replay_bytes(build_footer_fixture());
    if (summary.container.format != "rofl2-like-footer") {
        return false;
    }
    if (summary.container.metadata_source != "footer-size") {
        return false;
    }
    if (summary.game_length_millis != 1895012 || summary.last_game_chunk_id != 66 || summary.last_keyframe_id != 32) {
        return false;
    }
    if (summary.capabilities.binary_header_available || summary.capabilities.segment_table_available) {
        return false;
    }
    if (summary.warnings.empty()) {
        return false;
    }

    const std::string json = rofl::core::replay_summary_to_json(summary);
    const std::string probe = rofl::core::probe_replay_bytes(build_footer_fixture());
    return json.find("\"metadataSource\":\"footer-size\"") != std::string::npos &&
           json.find("\"validatedFinalPlayerStatsAvailable\":false") != std::string::npos &&
           probe.find("Classic header valid: no") != std::string::npos &&
           probe.find("Metadata source: footer-size") != std::string::npos &&
           probe.find("Parser summary available: yes") != std::string::npos;
}

bool test_footer_zstd_fixture() {
    const auto summary = rofl::core::parse_replay_bytes(build_footer_zstd_fixture());
    if (summary.container.format != "rofl2-like-footer" || !summary.container.segment_table_present) {
        return false;
    }
    if (!summary.capabilities.segment_table_available || summary.capabilities.payload_header_available) {
        return false;
    }
    if (summary.container.chunk_count != 2 || summary.container.keyframe_count != 1) {
        return false;
    }
    if (summary.container.startup_chunk_end_id != 2 || summary.container.game_start_chunk_id != 3) {
        return false;
    }
    if (summary.container.payload_offset != 28 || summary.container.segments.size() != 4) {
        return false;
    }
    if (summary.container.segments.front().type != "startup" || summary.container.segments.front().codec != "zstd") {
        return false;
    }
    if (summary.container.segments[1].type != "keyframe" || summary.container.segments[1].chunk_id != 3) {
        return false;
    }
    if (summary.container.segments[2].type != "chunk" || summary.container.segments[2].id != 3) {
        return false;
    }
    if (!summary.capabilities.payload_decoding_available) {
        return false;
    }

        const std::string json = rofl::core::replay_summary_to_json(summary);
    const std::string probe = rofl::core::probe_replay_bytes(build_footer_zstd_fixture());
    const std::string inspect = rofl::core::inspect_replay_bytes(build_footer_zstd_fixture());
    return json.find("\"segmentTablePresent\":true") != std::string::npos &&
           json.find("\"codec\":\"zstd\"") != std::string::npos &&
           json.find("\"payloadDecodingAvailable\":true") != std::string::npos &&
           summary.warnings.back().find("exact packet-block framing is available") != std::string::npos &&
           probe.find("Decompressed segment: id=1, type=startup") != std::string::npos &&
           probe.find("startup:hello") != std::string::npos &&
           inspect.find("Replay inspect") != std::string::npos &&
           inspect.find("Segment startup#1") != std::string::npos &&
           inspect.find("ASCII runs: \"startup:hello\"") != std::string::npos;
}

bool test_keyframe_state_candidates_unsupported_fixture() {
    const std::string path = "rofl_core_smoke_keyframe_state_fixture.rofl";
    {
        std::ofstream file(path, std::ios::binary);
        const auto bytes = build_footer_zstd_fixture();
        file.write(reinterpret_cast<const char*>(bytes.data()), static_cast<std::streamsize>(bytes.size()));
    }

    const std::string json = rofl::core::export_keyframe_state_candidates_json(path);
    std::remove(path.c_str());
    return json.find("\"schema\":\"keyframe-state-timeline.v1\"") != std::string::npos &&
           json.find("\"schemaId\":\"keyframe-state-schema.v1\"") != std::string::npos &&
           json.find("\"versionGroup\":\"16.5\"") != std::string::npos &&
           json.find("\"supported\":false") != std::string::npos &&
           json.find("\"calibration\":\"none\"") != std::string::npos &&
           json.find("\"participantIdentity\":\"unassigned\"") != std::string::npos;
}

bool test_replay_kill_extractor_fixture() {
    const std::string json = rofl::core::extract_replay_kills_json(build_footer_kill_fixture());
    return json.find("\"schema\":\"rofl-replay-kills/v1\"") != std::string::npos &&
           json.find("\"replayPath\":null") != std::string::npos &&
           json.find("\"versionGroup\":\"16.5\"") != std::string::npos &&
           json.find("\"victimParticipantId\":1,\"killerParticipantId\":2") != std::string::npos &&
           json.find("\"assistingParticipantIds\":[3]") != std::string::npos &&
           json.find("\"ignoredDeathMarkerBlockCount\":1") != std::string::npos &&
           json.find("\"segmentType\":\"chunk\"") != std::string::npos &&
           json.find("\"decodedKillEventCount\":1") != std::string::npos &&
           json.find("\"passingParticipantCount\":10,\"pass\":true") != std::string::npos;
}

bool test_replay_objective_extractor_fixture() {
    const std::string json =
        rofl::core::extract_replay_objectives_json(build_footer_objective_fixture());
    return json.find("\"schema\":\"rofl-replay-objectives/v1\"") != std::string::npos &&
           json.find("\"replayPath\":null") != std::string::npos &&
           json.find("\"versionGroup\":\"16.9\"") != std::string::npos &&
           json.find("\"packetTypeHex\":\"0x01EB\"") != std::string::npos &&
           json.find("\"minimumContentLength\":132,\"maximumContentLength\":133") !=
               std::string::npos &&
           json.find("\"monsterType\":\"DRAGON\"") != std::string::npos &&
           json.find("\"monsterType\":\"BARON_NASHOR\"") != std::string::npos &&
           json.find("\"monsterType\":\"RIFTHERALD\"") != std::string::npos &&
           json.find("\"monsterType\":\"HORDE\"") != std::string::npos &&
           json.find("\"monsterType\":\"UNKNOWN\"") == std::string::npos &&
           json.find("\"timestampMillis\":1000,") == std::string::npos &&
           json.find("\"timestampMillis\":2000,") == std::string::npos &&
           json.find("\"timestampMillis\":50000,") == std::string::npos &&
           json.find("\"candidatePacketBlockCount\":6") != std::string::npos &&
           json.find("\"profileLengthPacketBlockCount\":5") != std::string::npos &&
           json.find("\"rejectedContentLengthBlockCount\":1") != std::string::npos &&
           json.find("\"decodedObjectiveEventCount\":4") != std::string::npos &&
           json.find("\"unknownMonsterTypeCount\":1") != std::string::npos &&
           json.find("\"exactPacketFraming\":true") != std::string::npos &&
           json.find("\"killerOwnershipAvailable\":false") != std::string::npos &&
           json.find("\"elementalDragonSubtypeAvailable\":false") != std::string::npos;
}

bool test_replay_ward_extractor_fixture() {
    const std::string json =
        rofl::core::extract_replay_wards_json(build_footer_ward_fixture());
    return json.find("\"schema\":\"rofl-replay-wards/v1\"") != std::string::npos &&
           json.find("\"replayPath\":null") != std::string::npos &&
           json.find("\"versionGroup\":\"16.9\"") != std::string::npos &&
           json.find("\"placementMarkerPacketTypeHex\":\"0x0041\"") != std::string::npos &&
           json.find("\"placementDiscriminatorValuesHex\":[\"0xB0\"]") != std::string::npos &&
           json.find("\"type\":\"WARD_PLACED\",\"timestampMillis\":2000,\"wardEntityNetworkId\":1342177281") != std::string::npos &&
           json.find("\"ownerParticipantId\":1,\"ownerNetworkId\":1073741998,\"ownerNetworkIdHex\":\"0x400000AE\"") != std::string::npos &&
           json.find("\"type\":\"WARD_PLACED\",\"timestampMillis\":3000,\"wardEntityNetworkId\":1342177282") != std::string::npos &&
           json.find("\"type\":\"WARD_KILL\",\"timestampMillis\":4000,\"wardEntityNetworkId\":1342177281") != std::string::npos &&
           json.find("\"killerParticipantId\":3,\"killerNetworkId\":1073742000,\"killerNetworkIdHex\":\"0x400000B0\"") != std::string::npos &&
           json.find("\"wardType\":null,\"position\":null") != std::string::npos &&
           json.find("\"removalReason\":null") != std::string::npos &&
           json.find("\"ownerBlock\":{\"segmentType\":\"chunk\"") != std::string::npos &&
           json.find("\"markerBlock\":{\"segmentType\":\"chunk\"") != std::string::npos &&
           json.find("\"killerOwnerBlock\":{\"segmentType\":\"chunk\"") != std::string::npos &&
           json.find("\"removalBlock\":{\"segmentType\":\"chunk\"") != std::string::npos &&
           json.find("\"candidatePlacementMarkerBlockCount\":6") != std::string::npos &&
           json.find("\"classifiedPlacementMarkerBlockCount\":4") != std::string::npos &&
           json.find("\"rejectedPlacementContentLengthBlockCount\":1") != std::string::npos &&
           json.find("\"rejectedPlacementClassifierBlockCount\":1") != std::string::npos &&
           json.find("\"rejectedUnpairedPlacementMarkerBlockCount\":2") != std::string::npos &&
           json.find("\"decodedWardPlacementEventCount\":2") != std::string::npos &&
           json.find("\"candidateRemovalBlockCount\":3") != std::string::npos &&
           json.find("\"rejectedUntrackedRemovalBlockCount\":1") != std::string::npos &&
           json.find("\"rejectedTrackedUnprofiledRemovalBlockCount\":1") != std::string::npos &&
           json.find("\"rejectedMissingKillerOwnerBlockCount\":0") != std::string::npos &&
           json.find("\"killerOwnerCandidateCollisionCount\":1") != std::string::npos &&
           json.find("\"decodedWardKillEventCount\":1") != std::string::npos &&
           json.find("\"exactPacketFraming\":true") != std::string::npos &&
           json.find("\"placementCoverage\":\"exact-on-validated-corpus\"") != std::string::npos &&
           json.find("\"removalCoverage\":\"conservative-partial\"") != std::string::npos &&
           json.find("\"wardTypeAvailable\":false") != std::string::npos &&
           json.find("\"positionAvailable\":false") != std::string::npos &&
           json.find("\"visionRadiusAvailable\":false") != std::string::npos &&
           json.find("\"removalReasonAvailable\":false") != std::string::npos &&
           json.find("0x50000003") == std::string::npos;
}

bool test_replay_ward_position_research_fixture() {
    const std::vector<std::uint8_t> fixture =
        build_footer_ward_fixture();
    const std::string productive_json =
        rofl::core::extract_replay_wards_json(fixture);
    const std::string research_json =
        rofl::core::extract_replay_ward_position_candidates_json(
            fixture
        );
    return
        productive_json.find(
            "\"wardType\":null,\"position\":null"
        ) != std::string::npos &&
        research_json.find(
            "\"schema\":"
            "\"rofl-ward-position-candidates-research/v1\""
        ) != std::string::npos &&
        research_json.find("\"researchOnly\":true") !=
            std::string::npos &&
        research_json.find("\"promotionGate\":false") !=
            std::string::npos &&
        research_json.find("\"positionAvailable\":false") !=
            std::string::npos &&
        research_json.find("\"runtimeInput\":\"rofl-only\"") !=
            std::string::npos &&
        research_json.find("\"riotApiInput\":false") !=
            std::string::npos &&
        research_json.find("\"clientBinaryInput\":false") !=
            std::string::npos &&
        research_json.find(
            "\"primarySpawnPacketTypeHex\":\"0x00D6\""
        ) != std::string::npos &&
        research_json.find(
            "\"companionSpawnPacketTypeHex\":\"0x01AD\""
        ) != std::string::npos &&
        research_json.find("\"primaryMinimumContentLength\":62") !=
            std::string::npos &&
        research_json.find("\"primaryMaximumContentLength\":73") !=
            std::string::npos &&
        research_json.find("\"companionContentLength\":63") !=
            std::string::npos &&
        research_json.find(
            "\"id\":\"CONTROL-U16-7-11\""
        ) != std::string::npos &&
        research_json.find("\"id\":\"C24-BE-FX\"") !=
            std::string::npos &&
        research_json.find(
            "\"timestampMillis\":2000,"
            "\"wardEntityNetworkId\":1342177281"
        ) != std::string::npos &&
        research_json.find(
            "\"ownerParticipantId\":1,"
            "\"ownerNetworkId\":1073741998"
        ) != std::string::npos &&
        research_json.find(
            "\"spawnBlocks\":{\"primary\":"
            "{\"packetRole\":\"primary\""
        ) != std::string::npos &&
        research_json.find(
            "\"companion\":{\"packetRole\":\"companion\""
        ) != std::string::npos &&
        research_json.find("\"payloadHex\":\"") !=
            std::string::npos &&
        research_json.find(
            "\"hypothesisId\":\"CONTROL-U16-7-11\""
        ) != std::string::npos &&
        research_json.find("\"xSource\":\"N16(primary[7]") !=
            std::string::npos &&
        research_json.find("\"researchPlacementCount\":2") !=
            std::string::npos &&
        research_json.find("\"emittedCandidateCount\":16") !=
            std::string::npos &&
        research_json.find(
            "\"rejectedCoordinateCandidateCount\":0"
        ) != std::string::npos &&
        research_json.find(
            "\"coordinateClampingApplied\":false"
        ) != std::string::npos;
}

}  // namespace

int main() {
    if (!test_classic_fixture()) {
        return EXIT_FAILURE;
    }

    if (!test_invalid_final_player_stats_capability()) {
        return EXIT_FAILURE;
    }

    if (!test_footer_fixture()) {
        return EXIT_FAILURE;
    }

    if (!test_footer_zstd_fixture()) {
        return EXIT_FAILURE;
    }

    if (!test_keyframe_state_candidates_unsupported_fixture()) {
        return EXIT_FAILURE;
    }

    if (!test_replay_kill_extractor_fixture()) {
        return EXIT_FAILURE;
    }

    if (!test_replay_objective_extractor_fixture()) {
        return EXIT_FAILURE;
    }

    if (!test_replay_ward_extractor_fixture()) {
        return EXIT_FAILURE;
    }

    if (!test_replay_ward_position_research_fixture()) {
        return EXIT_FAILURE;
    }

    return EXIT_SUCCESS;
}



