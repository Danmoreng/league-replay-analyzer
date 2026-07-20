#include <algorithm>
#include <bit>
#include <cstdlib>
#include <cstdint>
#include <fstream>
#include <sstream>
#include <string>
#include <string_view>
#include <vector>

#include <zstd.h>

#include "rofl/core/decoder_profiles.hpp"
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

std::vector<std::uint8_t> build_footer_inventory_purchase_fixture(
    const std::string& game_version = "16.14.794.5912"
) {
    constexpr std::uint32_t champion_base = 0x400000AD;
    constexpr std::uint16_t add_packet_type = 0x0369;
    constexpr std::uint16_t removal_packet_type = 0x03F9;
    constexpr std::uint16_t removal_context_packet_type = 0x0146;
    constexpr std::uint16_t undo_component_packet_type = 0x0081;
    std::vector<std::uint8_t> first_chunk_payload;
    std::vector<std::uint8_t> payload;
    const std::vector<std::uint8_t> removal_six(6, 0);
    const std::vector<std::uint8_t> context_two(2, 0);
    std::vector<std::uint8_t> available_add(14, 0);
    available_add[9] = 0x01;  // q72=1: avoids both fail-closed missing symbols.
    const std::vector<std::uint8_t> unavailable_add(14, 0);
    const std::vector<std::uint8_t> long_add(15, 0);

    // Deliberately span the first selected group across chunks. Decompressed
    // offsets restart at zero in the second chunk, so source ordering must use
    // segment provenance before local packet offsets.
    append_packet_block_with_content(first_chunk_payload, 10.0F, removal_packet_type, champion_base + 1, removal_six);
    append_packet_block_with_content(first_chunk_payload, 10.0F, removal_packet_type, champion_base + 1, removal_six);
    append_packet_block_with_content(payload, 10.0F, add_packet_type, champion_base + 1, available_add);

    append_packet_block_with_content(payload, 20.0F, removal_packet_type, champion_base + 2, removal_six);
    append_packet_block_with_content(payload, 20.0F, removal_packet_type, champion_base + 2, removal_six);
    append_packet_block_with_content(payload, 20.0F, add_packet_type, champion_base + 2, unavailable_add);

    append_packet_block_with_content(payload, 30.0F, removal_packet_type, champion_base + 3, removal_six);
    append_packet_block_with_content(payload, 30.0F, removal_packet_type, champion_base + 3, removal_six);
    append_packet_block_with_content(payload, 30.0F, removal_context_packet_type, champion_base + 3, context_two);
    append_packet_block_with_content(payload, 30.0F, add_packet_type, champion_base + 3, available_add);

    append_packet_block_with_content(payload, 40.0F, removal_packet_type, champion_base + 4, removal_six);
    append_packet_block_with_content(payload, 40.0F, removal_packet_type, champion_base + 4, removal_six);
    append_packet_block_with_content(payload, 40.0F, add_packet_type, champion_base + 4, long_add);

    append_packet_block_with_content(payload, 50.0F, add_packet_type, champion_base + 5, available_add);
    append_packet_block_with_content(payload, 50.0F, removal_packet_type, champion_base + 5, removal_six);
    append_packet_block_with_content(payload, 50.0F, removal_packet_type, champion_base + 5, removal_six);

    append_packet_block_with_content(payload, 60.0F, removal_packet_type, champion_base + 6, removal_six);
    append_packet_block_with_content(payload, 60.0F, removal_packet_type, champion_base + 6, removal_six);
    append_packet_block_with_content(payload, 60.0F, undo_component_packet_type, champion_base + 6, context_two);
    append_packet_block_with_content(payload, 60.0F, add_packet_type, champion_base + 6, available_add);

    const std::string metadata =
        "{\"gameLength\":60000,\"lastGameChunkId\":2,\"lastKeyFrameId\":0,\"statsJson\":\"[]\"}";
    const auto first_chunk_compressed = compress_zstd_payload(std::string(
        reinterpret_cast<const char*>(first_chunk_payload.data()), first_chunk_payload.size()));
    const auto compressed = compress_zstd_payload(std::string(
        reinterpret_cast<const char*>(payload.data()), payload.size()));
    if (first_chunk_compressed.empty() || compressed.empty()) return {};
    constexpr std::size_t first_chunk_header_offset = 32;
    constexpr std::size_t first_chunk_payload_offset = first_chunk_header_offset + 17;
    const std::size_t header_offset = first_chunk_payload_offset + first_chunk_compressed.size();
    const std::size_t payload_offset = header_offset + 17;
    const std::size_t metadata_offset = payload_offset + compressed.size();
    const std::size_t total_size = metadata_offset + metadata.size() + 4;
    std::vector<std::uint8_t> bytes(total_size, 0);
    write_ascii(bytes, 0, "RIOT");
    bytes[4] = 0x02;
    write_ascii(bytes, 16, game_version);
    write_zstd_record_header(bytes, first_chunk_header_offset, 1, 2, 1,
        static_cast<std::uint32_t>(first_chunk_payload.size()),
        static_cast<std::uint32_t>(first_chunk_compressed.size()));
    std::copy(first_chunk_compressed.begin(), first_chunk_compressed.end(),
        bytes.begin() + first_chunk_payload_offset);
    write_zstd_record_header(bytes, header_offset, 2, 3, 1,
        static_cast<std::uint32_t>(payload.size()), static_cast<std::uint32_t>(compressed.size()));
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

bool test_multi_packet_type_dump_fixture() {
    constexpr std::uint16_t owner_packet_type = 0x021A;
    constexpr std::uint16_t marker_packet_type = 0x03EF;
    const std::string path = "rofl_core_smoke_multi_packet_dump_fixture.rofl";
    {
        std::ofstream file(path, std::ios::binary);
        const auto bytes = build_footer_kill_fixture();
        file.write(reinterpret_cast<const char*>(bytes.data()), static_cast<std::streamsize>(bytes.size()));
    }

    const std::string json = rofl::core::dump_packet_types_file_json(
        path,
        {marker_packet_type, owner_packet_type, marker_packet_type},
        "chunk",
        1
    );
    std::remove(path.c_str());
    return json.find("\"schema\":\"packet-types-dump.v1\"") != std::string::npos &&
           json.find("\"segmentType\":\"chunk\"") != std::string::npos &&
           json.find("\"packetTypes\":[538,1007]") != std::string::npos &&
           json.find("\"maxBlocksPerPacketType\":1") != std::string::npos &&
           json.find("\"packetType\":538,\"matchingBlockCount\":3,\"emittedBlockCount\":1,\"truncated\":true") != std::string::npos &&
           json.find("\"packetType\":1007,\"matchingBlockCount\":2,\"emittedBlockCount\":1,\"truncated\":true") != std::string::npos &&
           json.find("]},,{") == std::string::npos &&
           json.find("\"errors\":[]") != std::string::npos;
}

bool test_packet_window_dump_fixture() {
    constexpr std::uint32_t champion_base = 0x400000AD;
    const std::string path = "rofl_core_smoke_packet_window_fixture.rofl";
    {
        std::ofstream file(path, std::ios::binary);
        const auto bytes = build_footer_kill_fixture();
        file.write(reinterpret_cast<const char*>(bytes.data()), static_cast<std::streamsize>(bytes.size()));
    }

    const std::string json = rofl::core::dump_packet_window_file_json(
        path,
        "chunk",
        12500,
        12500,
        1,
        champion_base + 1,
        true,
        1
    );
    bool invalid_window_rejected = false;
    try {
        (void)rofl::core::dump_packet_window_file_json(path, "chunk", 2, 1);
    } catch (const std::invalid_argument&) {
        invalid_window_rejected = true;
    }
    std::remove(path.c_str());
    return invalid_window_rejected &&
           json.find("\"schema\":\"packet-window-dump.v1\"") != std::string::npos &&
           json.find("\"startTimestampMillis\":12500,\"endTimestampMillis\":12500") != std::string::npos &&
           json.find("\"channel\":1,\"blockParamProvided\":true,\"blockParam\":1073741998") != std::string::npos &&
           json.find("\"matchingBlockCount\":2,\"emittedBlockCount\":1,\"truncated\":true") != std::string::npos &&
           json.find("\"timestampMillis\":12500") != std::string::npos &&
           json.find("\"errors\":[]") != std::string::npos;
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

std::string inventory_purchase_subset_profile_json(
    const std::string& accepted_version = "16.14.794.5912"
) {
    return R"json({
        "schema":"rofl-replay-decoder-profiles/v1",
        "registryId":"inventory-purchase-smoke",
        "revision":1,
        "profiles":[{
            "versionGroup":"16.14",
            "acceptedGameVersions":[")json" + accepted_version + R"json("],
            "inventoryPurchaseSubset":{
                "segmentType":"chunk",
                "channel":1,
                "championNetworkIdBase":1073741997,
                "add":{"packetType":873,"contentLengths":{"exact":[14,15]}},
                "removal":{"packetType":1017,"contentLengths":{"exact":[6,7]}},
                "removalContext":{"packetType":326,"contentLengths":{"exact":[2,3,4]}},
                "undoComponent":{"packetType":129},
                "templates":[[
                    {"family":"removal","contentLength":6},
                    {"family":"removal","contentLength":6},
                    {"family":"add","contentLength":14}
                ],[
                    {"family":"removal","contentLength":7},
                    {"family":"removal","contentLength":6},
                    {"family":"add","contentLength":14}
                ],[
                    {"family":"removal","contentLength":7},
                    {"family":"add","contentLength":14}
                ],[
                    {"family":"removal","contentLength":6},
                    {"family":"removal","contentLength":7},
                    {"family":"removal","contentLength":7},
                    {"family":"add","contentLength":14}
                ],[
                    {"family":"removal","contentLength":6},
                    {"family":"removal","contentLength":6},
                    {"family":"removal","contentLength":7},
                    {"family":"add","contentLength":14}
                ],[
                    {"family":"removal","contentLength":7},
                    {"family":"removal","contentLength":6},
                    {"family":"removal","contentLength":7},
                    {"family":"add","contentLength":14}
                ],[
                    {"family":"removal","contentLength":7},
                    {"family":"removal","contentLength":7},
                    {"family":"add","contentLength":14}
                ],[
                    {"family":"removal","contentLength":7},
                    {"family":"removal","contentLength":7},
                    {"family":"removal","contentLength":6},
                    {"family":"add","contentLength":14}
                ],[
                    {"family":"removal","contentLength":7},
                    {"family":"removal","contentLength":7},
                    {"family":"removal","contentLength":7},
                    {"family":"add","contentLength":14}
                ],[
                    {"family":"removal","contentLength":6},
                    {"family":"removal","contentLength":6},
                    {"family":"removal","contentLength":7},
                    {"family":"removal","contentLength":7},
                    {"family":"add","contentLength":14}
                ]]
            }
        }]
    })json";
}

bool test_replay_inventory_purchase_subset_fixture() {
    const auto loaded = rofl::core::parse_decoder_profile_registry_json(
        inventory_purchase_subset_profile_json());
    if (!loaded.ok() || !loaded.registry.has_value()) return false;
    const std::string json = rofl::core::extract_replay_purchase_linked_item_updates_json(
        build_footer_inventory_purchase_fixture(), *loaded.registry);
    bool unsupported_build_rejected = false;
    try {
        (void)rofl::core::extract_replay_purchase_linked_item_updates_json(
            build_footer_inventory_purchase_fixture("16.14.794.5913"), *loaded.registry);
    } catch (const std::exception&) {
        unsupported_build_rejected = true;
    }
    const auto wrong_accepted_version = rofl::core::parse_decoder_profile_registry_json(
        inventory_purchase_subset_profile_json("16.14.794.5913"));
    std::string unfrozen_templates = inventory_purchase_subset_profile_json();
    const std::size_t first_removal_length =
        unfrozen_templates.find("\"contentLength\":6");
    if (first_removal_length == std::string::npos) return false;
    const std::size_t replacement = unfrozen_templates.find('6', first_removal_length);
    unfrozen_templates[replacement] = '7';
    const auto unfrozen_profile = rofl::core::parse_decoder_profile_registry_json(unfrozen_templates);
    return unsupported_build_rejected && !wrong_accepted_version.ok() &&
           !wrong_accepted_version.registry.has_value() &&
           !unfrozen_profile.ok() && !unfrozen_profile.registry.has_value() &&
           json.find("\"schema\":\"rofl-replay-purchase-linked-item-updates/v1\"") != std::string::npos &&
           json.find("\"runtimeInput\":\"rofl-only\",\"riotApiInput\":false") != std::string::npos &&
           json.find("\"origin\":\"external\"") != std::string::npos &&
           json.find("\"addUpdatePacketType\":873") != std::string::npos &&
           json.find("\"contentLengths\":[14,15]") != std::string::npos &&
           json.find("\"type\":\"PURCHASE_LINKED_RESULTING_ITEM_UPDATE\",\"timestampMillis\":10000,\"participantId\":1,\"participantNetworkId\":1073741998,\"participantNetworkIdHex\":\"0x400000AE\",\"resultingItemId\":7546") != std::string::npos &&
           json.find("\"matchedTemplateSignature\":\"removal:6>removal:6>add:14\"") != std::string::npos &&
           json.find("\"groupBlocks\":[{\"family\":\"removal\"") != std::string::npos &&
           json.find("\"profiledAddUpdatePacketCount\":6") != std::string::npos &&
           json.find("\"profiledOwnerTimeGroupCount\":6") != std::string::npos &&
           json.find("\"matchedTemplateGroupCount\":2") != std::string::npos &&
           json.find("\"rejectedNonmatchingGroupCount\":4") != std::string::npos &&
           json.find("\"rejectedUnavailableItemIdGroupCount\":1") != std::string::npos &&
           json.find("\"emittedEventCount\":1") != std::string::npos &&
           json.find("\"unavailableAddUpdatePacketCount\":5") != std::string::npos &&
           json.find("\"coverage\":\"strict-subset-not-complete\"") != std::string::npos &&
           json.find("\"completePurchaseTimelineAvailable\":false") != std::string::npos &&
           json.find("\"inventoryTimelineAvailable\":false") != std::string::npos &&
           json.find("\"currentInventoryAvailable\":false") != std::string::npos &&
           json.find("\"slotAvailable\":false") != std::string::npos &&
           json.find("\"itemInstanceAvailable\":false") != std::string::npos &&
           json.find("\"goldStateAvailable\":false") != std::string::npos;
}

std::vector<std::uint8_t> build_footer_item_sales_fixture(
    const std::string& game_version = "16.14.794.5912"
) {
    constexpr std::uint32_t champion_base = 0x400000AD;
    constexpr std::uint16_t add_packet_type = 0x0369;
    constexpr std::uint16_t removal_packet_type = 0x03F9;
    std::vector<std::uint8_t> payload;
    std::vector<std::uint8_t> sale_removal(6, 0);
    sale_removal[0] = 0x02;
    sale_removal[2] = 0x30;
    std::vector<std::uint8_t> unknown_discriminator_removal = sale_removal;
    unknown_discriminator_removal[2] = 0x31;
    const std::vector<std::uint8_t> add(14, 0);

    // Exact sale-operation predicate: one removal, no profiled add, and a
    // frozen discriminator byte. The emitted stream intentionally carries no
    // sold-item identity or inventory state.
    append_packet_block_with_content(
        payload, 10.0F, removal_packet_type, champion_base + 1, sale_removal);
    append_packet_block_with_content(
        payload, 20.0F, removal_packet_type, champion_base + 2, unknown_discriminator_removal);
    append_packet_block_with_content(
        payload, 30.0F, removal_packet_type, champion_base + 3, sale_removal);
    append_packet_block_with_content(
        payload, 30.0F, add_packet_type, champion_base + 3, add);

    const std::string metadata =
        R"({"gameLength":60000,"lastGameChunkId":1,"lastKeyFrameId":0,"statsJson":"[]"})";
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
    write_ascii(bytes, 16, game_version);
    write_zstd_record_header(bytes, header_offset, 1, 2, 1,
        static_cast<std::uint32_t>(payload.size()), static_cast<std::uint32_t>(compressed.size()));
    std::copy(compressed.begin(), compressed.end(), bytes.begin() + payload_offset);
    write_ascii(bytes, metadata_offset, metadata);
    write_u32_le(bytes, total_size - 4, static_cast<std::uint32_t>(metadata.size()));
    return bytes;
}

std::string inventory_sale_subset_profile_json(
    const std::string& accepted_version = "16.14.794.5912"
) {
    return R"json({
        "schema":"rofl-replay-decoder-profiles/v1",
        "registryId":"inventory-sale-smoke",
        "revision":1,
        "profiles":[{
            "versionGroup":"16.14",
            "acceptedGameVersions":[")json" + accepted_version + R"json("],
            "inventorySaleSubset":{
                "segmentType":"chunk",
                "channel":1,
                "championNetworkIdBase":1073741997,
                "add":{"packetType":873,"contentLengths":{"exact":[14,15]}},
                "removal":{"packetType":1017,"contentLengths":{"exact":[6,7]}},
                "exactGroup":{"addCount":0,"removalCount":1,"timestampToleranceMillis":0},
                "removalPayload":{"payload0LowNibbleAllow":[2,5],"payload2LowTwoBitReject":3,"payload2Allow":[48,110,122,234,238,249]}
            }
        }]
    })json";
}

bool test_replay_item_sales_fixture() {
    const auto loaded = rofl::core::parse_decoder_profile_registry_json(
        inventory_sale_subset_profile_json());
    if (!loaded.ok() || !loaded.registry.has_value()) return false;

    const std::string json = rofl::core::extract_replay_item_sales_json(
        build_footer_item_sales_fixture(), *loaded.registry);
    bool unsupported_build_rejected = false;
    try {
        (void)rofl::core::extract_replay_item_sales_json(
            build_footer_item_sales_fixture("16.14.794.5913"), *loaded.registry);
    } catch (const std::exception&) {
        unsupported_build_rejected = true;
    }

    const auto mutation_rejected = [](std::string profile, std::string_view needle,
                                      std::string_view replacement) {
        const std::size_t offset = profile.find(needle);
        if (offset == std::string::npos) return false;
        profile.replace(offset, needle.size(), replacement);
        const auto mutated = rofl::core::parse_decoder_profile_registry_json(profile);
        return !mutated.ok() && !mutated.registry.has_value();
    };
    const bool timestamp_tolerance_mutation_rejected = mutation_rejected(
        inventory_sale_subset_profile_json(),
        "\"timestampToleranceMillis\":0",
        "\"timestampToleranceMillis\":1"
    );
    const bool payload_enum_mutation_rejected = mutation_rejected(
        inventory_sale_subset_profile_json(),
        "\"payload2Allow\":[48,110,122,234,238,249]",
        "\"payload2Allow\":[48,110,122,234,238,248]"
    );

    return unsupported_build_rejected &&
           timestamp_tolerance_mutation_rejected &&
           payload_enum_mutation_rejected &&
           json.find("\"schema\":\"rofl-replay-item-sales/v1\"") != std::string::npos &&
           json.find("\"runtimeInput\":\"rofl-only\",\"riotApiInput\":false") != std::string::npos &&
           json.find("\"origin\":\"external\"") != std::string::npos &&
           json.find("\"removalPacketType\":1017") != std::string::npos &&
           json.find("\"removalContentLengths\":[6,7]") != std::string::npos &&
           json.find("\"type\":\"ITEM_SOLD_OPERATION\",\"timestampMillis\":10000,\"participantId\":1,\"participantNetworkId\":1073741998,\"participantNetworkIdHex\":\"0x400000AE\"") != std::string::npos &&
           json.find("\"removalBlock\":{\"family\":\"removal\",\"channel\":1,\"packetType\":1017,\"packetTypeHex\":\"0x03F9\",\"contentLength\":6,\"blockParam\":1073741998") != std::string::npos &&
            json.find("\"availability\":{\"soldItemId\":false,\"slot\":false,\"itemInstance\":false,\"countOrCharges\":false,\"price\":false,\"goldGain\":false,\"inventoryState\":false,\"undo\":false}") != std::string::npos &&
            json.find("\"ownerTimestampGroupCount\":3") != std::string::npos &&
            json.find("\"singleRemovalNoAddGroupCount\":2") != std::string::npos &&
            json.find("\"rejectedGroupShapeCount\":1") != std::string::npos &&
            json.find("\"rejectedPayloadPredicateGroupCount\":0") != std::string::npos &&
            json.find("\"rejectedUnprofiledSaleDiscriminatorGroupCount\":1") != std::string::npos &&
            json.find("\"emittedEventCount\":1") != std::string::npos &&
           json.find("\"soldItemIdAvailable\":false") != std::string::npos &&
           json.find("\"slotAvailable\":false") != std::string::npos &&
           json.find("\"itemInstanceAvailable\":false") != std::string::npos &&
           json.find("\"countOrChargesAvailable\":false") != std::string::npos &&
           json.find("\"priceAvailable\":false") != std::string::npos &&
           json.find("\"goldGainAvailable\":false") != std::string::npos &&
           json.find("\"inventoryStateAvailable\":false") != std::string::npos &&
           json.find("\"undoAvailable\":false") != std::string::npos &&
           json.find("\"exactPacketFraming\":true") != std::string::npos &&
           json.find("\"coverage\":\"exact-sale-operation-only\"") != std::string::npos &&
           json.find("\"timestampMillis\":20000") == std::string::npos &&
           json.find("\"timestampMillis\":30000") == std::string::npos;
}

void set_inventory_payload_bit(
    std::vector<std::uint8_t>& payload, std::size_t bit
) {
    payload[bit >> 3U] |= static_cast<std::uint8_t>(1U << (bit & 7U));
}

std::vector<std::uint8_t> direct_purchase_item_payload(std::uint16_t item_id) {
    std::vector<std::uint8_t> payload(14, 0);
    if (item_id == 1001) {
        // Validated 16.14 grammar for Boots (a Data-Dragon-pinned component).
        for (const std::size_t bit : {67U, 71U, 73U, 75U, 78U}) {
            set_inventory_payload_bit(payload, bit);
        }
    } else if (item_id == 8191) {
        // A structurally decodable, but non-catalog, value. It must not escape
        // the static-catalog gate as a replay item purchase.
        for (const std::size_t bit : {66U, 68U, 71U, 72U, 73U, 76U, 79U}) {
            set_inventory_payload_bit(payload, bit);
        }
    }
    return payload;
}

std::vector<std::uint8_t> build_footer_direct_item_purchase_fixture(
    const std::string& game_version = "16.14.794.5912"
) {
    constexpr std::uint32_t champion_base = 0x400000AD;
    constexpr std::uint16_t add_packet_type = 0x0369;
    constexpr std::uint16_t removal_packet_type = 0x03F9;
    std::vector<std::uint8_t> payload;
    const std::vector<std::uint8_t> removal_six(6, 0);
    const auto boots = direct_purchase_item_payload(1001);
    const auto non_catalog = direct_purchase_item_payload(8191);
    const std::vector<std::uint8_t> missing_item_symbol(14, 0);

    append_packet_block_with_content(payload, 10.0F, add_packet_type, champion_base + 1, boots);
    append_packet_block_with_content(payload, 20.0F, add_packet_type, champion_base + 2, non_catalog);
    append_packet_block_with_content(payload, 30.0F, add_packet_type, champion_base + 3, boots);
    append_packet_block_with_content(payload, 30.0F, removal_packet_type, champion_base + 3, removal_six);
    append_packet_block_with_content(payload, 40.0F, add_packet_type, champion_base + 4, boots);
    append_packet_block_with_content(payload, 40.001F, removal_packet_type, champion_base + 4, removal_six);
    append_packet_block_with_content(payload, 50.0F, add_packet_type, champion_base + 5, missing_item_symbol);

    const std::string metadata =
        R"({"gameLength":60000,"lastGameChunkId":1,"lastKeyFrameId":0,"statsJson":"[]"})";
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
    write_ascii(bytes, 16, game_version);
    write_zstd_record_header(bytes, header_offset, 1, 2, 1,
        static_cast<std::uint32_t>(payload.size()), static_cast<std::uint32_t>(compressed.size()));
    std::copy(compressed.begin(), compressed.end(), bytes.begin() + payload_offset);
    write_ascii(bytes, metadata_offset, metadata);
    write_u32_le(bytes, total_size - 4, static_cast<std::uint32_t>(metadata.size()));
    return bytes;
}

std::string inventory_direct_purchase_subset_profile_json(
    const std::string& accepted_version = "16.14.794.5912"
) {
    // These lists deliberately mirror the exact pinned 16.14.1 Data Dragon
    // catalog in replay-decoder-profiles.v1.json. The parser requires all
    // 212 real IDs and the 71-item buildable-component subset, so this is also a strict
    // parser regression test rather than a reduced test-only catalog.
    const std::vector<std::uint16_t> real_item_ids{
        1001,1004,1006,1011,1018,1026,1027,1028,1029,1031,1033,1036,1037,1038,1042,
        1043,1052,1053,1054,1055,1056,1057,1058,1082,1083,1086,1101,1102,1103,1105,
        1106,1107,1120,2003,2019,2020,2021,2022,2031,2051,2055,2065,2138,2139,2140,
        2141,2420,2421,2501,2502,2503,2504,2508,2510,2512,2517,2520,2522,2523,2524,
        2525,2526,3003,3004,3006,3008,3009,3020,3024,3026,3031,3032,3033,3035,3036,
        3041,3044,3046,3047,3050,3051,3053,3057,3065,3066,3067,3068,3070,3071,3072,
        3073,3074,3075,3076,3077,3078,3082,3083,3084,3085,3086,3087,3089,3091,3094,
        3097,3100,3102,3107,3108,3109,3110,3111,3112,3113,3114,3115,3116,3118,3119,
        3123,3124,3133,3134,3135,3137,3139,3140,3142,3143,3144,3145,3146,3147,3152,
        3153,3155,3156,3157,3158,3161,3165,3168,3170,3171,3172,3173,3174,3175,3177,
        3179,3181,3184,3190,3211,3222,3302,3504,3508,3742,3748,3801,3802,3803,3814,
        3865,3869,3870,3871,3876,3877,3916,4005,4401,4628,4629,4630,4632,4633,4642,
        4645,4646,6333,6609,6610,6616,6617,6620,6621,6631,6653,6655,6657,6660,6662,
        6664,6665,6670,6672,6673,6675,6676,6690,6692,6694,6695,6696,6697,6698,6699,
        8010,8020};
    const std::vector<std::uint16_t> component_item_ids{
        1001,1004,1006,1011,1018,1026,1027,1028,1029,1031,1033,1036,1037,1038,1042,
        1043,1052,1053,1057,1058,1082,2019,2020,2021,2022,2031,2420,2421,2508,2526,
        3006,3008,3009,3020,3024,3035,3044,3047,3051,3057,3066,3067,3070,3076,3077,
        3082,3086,3108,3111,3113,3114,3123,3133,3134,3140,3144,3145,3147,3155,3158,
        3211,3801,3802,3803,3916,4630,4632,4642,6660,6670,6690};
    const auto write_ids = [](std::ostringstream& output,
                              const std::vector<std::uint16_t>& values) {
        for (std::size_t index = 0; index < values.size(); ++index) {
            if (index > 0) output << ',';
            output << values[index];
        }
    };
    std::ostringstream output;
    output << R"json({"schema":"rofl-replay-decoder-profiles/v1","registryId":"inventory-direct-purchase-smoke","revision":1,"profiles":[{"versionGroup":"16.14","acceptedGameVersions":[")json"
           << accepted_version << R"json("],"inventoryDirectPurchaseSubset":{"segmentType":"chunk","channel":1,"championNetworkIdBase":1073741997,"add":{"packetType":873,"contentLengths":{"exact":[14,15]}},"blockingPacketTypes":[1017,326,129],"isolationToleranceMillis":1,"staticItemCatalog":{"provider":"Riot Data Dragon","version":"16.14.1","locale":"en_US","sourceUrl":"https://ddragon.leagueoflegends.com/cdn/16.14.1/data/en_US/item.json","sourceByteLength":583139,"sourceSha256":"0094f848489371da9e86b9f210f70b6ce0a3982c9063c7c734099cd5a88ddb75","entryCount":706,"realItemIds":[)json";
    write_ids(output, real_item_ids);
    output << R"json(],"componentItemIds":[)json";
    write_ids(output, component_item_ids);
    output << R"json(]}}}]})json";
    return output.str();
}

bool test_replay_direct_item_purchase_subset_fixture() {
    const auto loaded = rofl::core::parse_decoder_profile_registry_json(
        inventory_direct_purchase_subset_profile_json());
    if (!loaded.ok() || !loaded.registry.has_value()) return false;

    const std::string json = rofl::core::extract_replay_direct_item_purchases_json(
        build_footer_direct_item_purchase_fixture(), *loaded.registry);
    bool unsupported_build_rejected = false;
    try {
        (void)rofl::core::extract_replay_direct_item_purchases_json(
            build_footer_direct_item_purchase_fixture("16.14.794.5913"), *loaded.registry);
    } catch (const std::exception&) {
        unsupported_build_rejected = true;
    }
    const auto wrong_accepted_version = rofl::core::parse_decoder_profile_registry_json(
        inventory_direct_purchase_subset_profile_json("16.14.794.5913"));
    std::string unfrozen_blockers = inventory_direct_purchase_subset_profile_json();
    const std::size_t blockers = unfrozen_blockers.find("\"blockingPacketTypes\":[1017,326,129]");
    if (blockers == std::string::npos) return false;
    unfrozen_blockers.replace(blockers, std::string("\"blockingPacketTypes\":[1017,326,129]").size(),
        "\"blockingPacketTypes\":[1017,327,129]");
    const auto invalid_blockers = rofl::core::parse_decoder_profile_registry_json(unfrozen_blockers);
    std::string unfrozen_catalog = inventory_direct_purchase_subset_profile_json();
    const std::size_t catalog_id = unfrozen_catalog.find(",1082,1083,1086,");
    if (catalog_id == std::string::npos) return false;
    unfrozen_catalog.replace(catalog_id, std::string(",1082,1083,1086,").size(),
        ",1082,1084,1086,");
    const auto invalid_catalog = rofl::core::parse_decoder_profile_registry_json(unfrozen_catalog);

    return unsupported_build_rejected && !wrong_accepted_version.ok() &&
           !wrong_accepted_version.registry.has_value() && !invalid_blockers.ok() &&
           !invalid_blockers.registry.has_value() && !invalid_catalog.ok() &&
           !invalid_catalog.registry.has_value() &&
           json.find("\"schema\":\"rofl-replay-direct-item-purchases/v1\"") != std::string::npos &&
           json.find("\"runtimeInput\":\"rofl-only\",\"riotApiInput\":false") != std::string::npos &&
           json.find("\"origin\":\"external\"") != std::string::npos &&
           json.find("\"realItemIdCount\":212,\"componentItemIdCount\":71") != std::string::npos &&
           json.find("\"type\":\"DIRECT_ADD_ONLY_ITEM_PURCHASE\",\"timestampMillis\":10000,\"participantId\":1,\"participantNetworkId\":1073741998,\"participantNetworkIdHex\":\"0x400000AE\",\"itemId\":1001,\"componentItem\":true") != std::string::npos &&
           json.find("\"addBlock\":{\"family\":\"add\",\"channel\":1,\"packetType\":873") != std::string::npos &&
           json.find("\"availability\":{\"slot\":false,\"itemInstance\":false,\"countOrCharges\":false,\"price\":false,\"goldState\":false,\"inventoryState\":false}") != std::string::npos &&
           json.find("\"knownInventoryOperationPacketCount\":7") != std::string::npos &&
           json.find("\"profiledAddUpdatePacketCount\":5") != std::string::npos &&
           json.find("\"knownOwnerTimeGroupCount\":6") != std::string::npos &&
           json.find("\"profiledSingleAddOnlyGroupCount\":4") != std::string::npos &&
           json.find("\"rejectedNonSingletonGroupCount\":1") != std::string::npos &&
           json.find("\"rejectedNeighborOperationGroupCount\":1") != std::string::npos &&
           json.find("\"rejectedUnavailableItemIdGroupCount\":1") != std::string::npos &&
           json.find("\"rejectedStaticItemCatalogGroupCount\":1") != std::string::npos &&
           json.find("\"emittedEventCount\":1") != std::string::npos &&
           json.find("\"componentItemEventCount\":1") != std::string::npos &&
           json.find("\"exactPacketFraming\":true") != std::string::npos &&
           json.find("\"coverage\":\"strict-direct-add-only-subset-not-complete\"") != std::string::npos &&
           json.find("\"inventoryStateAvailable\":false") != std::string::npos;
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

std::vector<std::uint8_t> build_footer_keyframe_participant_stats_fixture(
    bool include_duplicate_participant_snapshot = false,
    bool include_invalid_owner_snapshot = false,
    bool include_invalid_value_snapshot = false,
    float second_experience = 1140.0F,
    int final_level = 18
) {
    constexpr std::uint32_t champion_base = 0x400000AD;
    constexpr std::uint16_t snapshot_packet_type = 0x02EB;
    constexpr std::size_t snapshot_content_length = 1479;
    const auto make_snapshot = [](float experience, float gold, float lane, float neutral) {
        std::vector<std::uint8_t> payload(snapshot_content_length, 0);
        const auto write_interleaved_float = [&](const std::array<std::size_t, 4>& offsets,
                                                   float value) {
            const std::uint32_t bits = std::bit_cast<std::uint32_t>(value);
            for (std::size_t index = 0; index < offsets.size(); ++index) {
                payload[offsets[index]] = static_cast<std::uint8_t>(
                    (bits >> (index * 8U)) & 0xFFU);
            }
        };
        write_interleaved_float({83, 85, 87, 89}, experience);
        write_interleaved_float({115, 117, 119, 121}, gold);
        write_interleaved_float({123, 125, 127, 129}, lane);
        write_interleaved_float({131, 133, 135, 137}, neutral);
        return payload;
    };

    const auto make_keyframe_payload = [&] (
        float timestamp, float experience, float gold_base, float lane_base,
        float neutral_base
    ) {
        std::vector<std::uint8_t> payload;
        for (int participant_id = 1; participant_id <= 10; ++participant_id) {
            const float gold = participant_id == 1 ? gold_base : gold_base + participant_id;
            append_packet_block_with_content(
                payload,
                timestamp,
                snapshot_packet_type,
                champion_base + static_cast<std::uint32_t>(participant_id),
                make_snapshot(
                    experience, gold, lane_base + participant_id - 1,
                    neutral_base + participant_id - 1)
            );
        }
        return payload;
    };
    std::vector<std::uint8_t> first_keyframe =
        make_keyframe_payload(0.0F, 0.0F, 500.25F, 0.0F, 0.0F);
    std::vector<std::uint8_t> second_keyframe =
        make_keyframe_payload(60.0F, second_experience, 610.5F, 12.0F, 20.6F);
    if (include_duplicate_participant_snapshot) {
        append_packet_block_with_content(
            second_keyframe, 60.0F, snapshot_packet_type, champion_base + 1,
            make_snapshot(second_experience, 611.0F, 13.0F, 21.6F));
    }
    if (include_invalid_owner_snapshot) {
        append_packet_block_with_content(
            second_keyframe, 60.0F, snapshot_packet_type, champion_base + 11,
            make_snapshot(second_experience, 700.0F, 15.0F, 25.0F));
    }
    if (include_invalid_value_snapshot) {
        append_packet_block_with_content(
            second_keyframe, 120.0F, snapshot_packet_type, champion_base + 1,
            make_snapshot(second_experience, 600.0F, 13.0F, 10.0F));
    }

    std::string stats_json = "[";
    for (int participant_id = 1; participant_id <= 10; ++participant_id) {
        if (participant_id > 1) stats_json += ',';
        stats_json += "{\"LEVEL\":\"" + std::to_string(final_level) +
            R"(","EXP":"25000","MINIONS_KILLED":"100","NEUTRAL_MINIONS_KILLED":"0","ITEM0":"0","ITEM1":"0","ITEM2":"0","ITEM3":"0","ITEM4":"0","ITEM5":"0","ITEM6":"0","WARD_PLACED":"0","WARD_KILLED":"0"})";
    }
    stats_json += ']';
    std::string escaped_stats_json;
    for (const char character : stats_json) {
        if (character == '"' || character == '\\') escaped_stats_json += '\\';
        escaped_stats_json += character;
    }
    const std::string metadata =
        R"({"gameLength":120000,"lastGameChunkId":0,"lastKeyFrameId":2,"statsJson":")" +
        escaped_stats_json + R"("})";
    const auto first_compressed = compress_zstd_payload(std::string(
        reinterpret_cast<const char*>(first_keyframe.data()), first_keyframe.size()));
    const auto second_compressed = compress_zstd_payload(std::string(
        reinterpret_cast<const char*>(second_keyframe.data()), second_keyframe.size()));
    if (first_compressed.empty() || second_compressed.empty()) return {};
    constexpr std::size_t first_header_offset = 32;
    constexpr std::size_t first_payload_offset = first_header_offset + 17;
    const std::size_t second_header_offset = first_payload_offset + first_compressed.size();
    const std::size_t second_payload_offset = second_header_offset + 17;
    const std::size_t metadata_offset = second_payload_offset + second_compressed.size();
    const std::size_t total_size = metadata_offset + metadata.size() + 4;
    std::vector<std::uint8_t> bytes(total_size, 0);
    write_ascii(bytes, 0, "RIOT");
    bytes[4] = 0x02;
    write_ascii(bytes, 16, "16.14.794.5912");
    write_zstd_record_header(bytes, first_header_offset, 1, 3, 2,
        static_cast<std::uint32_t>(first_keyframe.size()), static_cast<std::uint32_t>(first_compressed.size()));
    std::copy(first_compressed.begin(), first_compressed.end(), bytes.begin() + first_payload_offset);
    write_zstd_record_header(bytes, second_header_offset, 2, 5, 2,
        static_cast<std::uint32_t>(second_keyframe.size()), static_cast<std::uint32_t>(second_compressed.size()));
    std::copy(second_compressed.begin(), second_compressed.end(), bytes.begin() + second_payload_offset);
    write_ascii(bytes, metadata_offset, metadata);
    write_u32_le(bytes, total_size - 4, static_cast<std::uint32_t>(metadata.size()));
    return bytes;
}

std::string keyframe_participant_stats_profile_json() {
    std::ostringstream output;
    output << R"json({"schema":"rofl-replay-decoder-profiles/v1","registryId":"keyframe-stats-smoke","revision":1,"profiles":[{"versionGroup":"16.14","acceptedGameVersions":["16.14.794.5912"],"finalStatsValidated":true,"keyframeParticipantStats":{"acceptedGameVersions":["16.14.794.5912"],"segmentType":"keyframe","channel":1,"packetType":747,"contentLength":1479,"championNetworkIdBase":1073741997,"cipherToPlain":[)json";
    for (int value = 0; value < 256; ++value) {
        if (value > 0) output << ',';
        output << value;
    }
    output << R"json(],"experienceOffsets":[83,85,87,89],"experienceProjection":"float32","totalGoldOffsets":[115,117,119,121],"laneMinionsKilledOffsets":[123,125,127,129],"neutralMinionsKilledOffsets":[131,133,135,137],"neutralMinionsKilledProjection":"floor-plus-1e-5"}}]})json";
    return output.str();
}

bool test_replay_participant_stat_snapshots_fixture() {
    const auto loaded = rofl::core::parse_decoder_profile_registry_json(
        keyframe_participant_stats_profile_json());
    if (!loaded.ok() || !loaded.registry.has_value()) return false;
    const std::string json = rofl::core::extract_replay_participant_stat_snapshots_json(
        build_footer_keyframe_participant_stats_fixture(), *loaded.registry);
    const std::string capped_level_json =
        rofl::core::extract_replay_participant_stat_snapshots_json(
            build_footer_keyframe_participant_stats_fixture(
                false, false, false, 22420.0F, 18),
            *loaded.registry);
    const std::string extended_level_json =
        rofl::core::extract_replay_participant_stat_snapshots_json(
            build_footer_keyframe_participant_stats_fixture(
                false, false, false, 22420.0F, 20),
            *loaded.registry);
    bool duplicate_rejected = false;
    bool invalid_owner_rejected = false;
    bool invalid_value_rejected = false;
    try {
        (void)rofl::core::extract_replay_participant_stat_snapshots_json(
            build_footer_keyframe_participant_stats_fixture(true), *loaded.registry);
    } catch (const std::exception& error) {
        duplicate_rejected = std::string_view(error.what()).find(
            "rejected duplicate participant snapshots") != std::string_view::npos;
    }
    try {
        (void)rofl::core::extract_replay_participant_stat_snapshots_json(
            build_footer_keyframe_participant_stats_fixture(false, true), *loaded.registry);
    } catch (const std::exception& error) {
        invalid_owner_rejected = std::string_view(error.what()).find(
            "rejected invalid owner or value packets") != std::string_view::npos;
    }
    try {
        (void)rofl::core::extract_replay_participant_stat_snapshots_json(
            build_footer_keyframe_participant_stats_fixture(false, false, true), *loaded.registry);
    } catch (const std::exception& error) {
        invalid_value_rejected = std::string_view(error.what()).find(
            "rejected invalid owner or value packets") != std::string_view::npos;
    }
    return json.find("\"schema\":\"rofl-replay-participant-stat-snapshots/v4\"") != std::string::npos &&
           duplicate_rejected &&
           invalid_owner_rejected &&
           invalid_value_rejected &&
           capped_level_json.find("\"experience\":22420,\"level\":18") != std::string::npos &&
           extended_level_json.find("\"experience\":22420,\"level\":20") != std::string::npos &&
           json.find("\"runtimeInput\":\"rofl-only\",\"riotApiInput\":false") != std::string::npos &&
           json.find("\"origin\":\"external\"") != std::string::npos &&
           json.find("\"snapshotPacketType\":747") != std::string::npos &&
           json.find("\"timestampMillis\":0,\"participantId\":1,\"experience\":0,\"level\":1,\"totalGold\":500.25,\"laneMinionsKilled\":0,\"neutralMinionsKilled\":0") != std::string::npos &&
           json.find("\"timestampMillis\":60000,\"participantId\":1,\"experience\":1140,\"level\":4,\"totalGold\":610.5,\"laneMinionsKilled\":12,\"neutralMinionsKilled\":20") != std::string::npos &&
           json.find("\"keyframeSegmentCount\":2") != std::string::npos &&
           json.find("\"profiledSnapshotPacketCount\":20") != std::string::npos &&
           json.find("\"rejectedInvalidOwnerPacketCount\":0") != std::string::npos &&
           json.find("\"rejectedInvalidValuePacketCount\":0") != std::string::npos &&
           json.find("\"emittedSnapshotCount\":20") != std::string::npos &&
           json.find("\"exactPacketFraming\":true") != std::string::npos;
}

bool test_decoder_profile_registry_loader() {
    const std::string valid_profile = R"json({
        "schema":"rofl-replay-decoder-profiles/v1",
        "registryId":"smoke-test",
        "revision":1,
        "profiles":[{
            "versionGroup":"16.14",
            "acceptedGameVersions":["16.14.794.5912"],
            "finalStatsValidated":true,
            "objective":{
                "channel":1,
                "packetType":30,
                "minimumContentLength":136,
                "maximumContentLength":137,
                "discriminator":{
                    "origin":"end",
                    "offset":2,
                    "values":[{"value":168,"class":"DRAGON"}]
                }
            },
            "ward":{
                "channel":1,
                "placementMarkerPacketType":1000,
                "placementContentLength":3,
                "placementDiscriminatorOffset":2,
                "placementDiscriminatorValues":[199],
                "placementOwnerPacketType":197,
                "placementOwnerContentLengths":{"minimum":113,"maximum":141},
                "removalPacketType":487,
                "removalContentLengths":{"exact":[21,28,29]},
                "killerOwnerPacketType":535,
                "killerOwnerContentLengths":{"exact":[10,11]},
                "championNetworkIdBase":1073741997
            }
        }]
    })json";

    const rofl::core::DecoderProfileLoadResult loaded =
        rofl::core::parse_decoder_profile_registry_json(valid_profile);
    if (!loaded.ok() || !loaded.registry.has_value() || !loaded.errors.empty()) {
        return false;
    }

    const rofl::core::DecoderVersionProfile* exact_profile =
        rofl::core::find_decoder_profile(*loaded.registry, "16.14.794.5912");
    if (exact_profile == nullptr ||
        rofl::core::find_decoder_profile(*loaded.registry, "16.14.794.5913") != nullptr ||
        rofl::core::find_decoder_profile(*loaded.registry, "16.14") != nullptr ||
        !exact_profile->objective.has_value() || !exact_profile->ward.has_value()) {
        return false;
    }

    const rofl::core::ObjectiveDecoderProfile& objective = *exact_profile->objective;
    const rofl::core::WardDecoderProfile& ward = *exact_profile->ward;
    if (objective.discriminator_origin != rofl::core::PayloadOffsetOrigin::end ||
        objective.discriminator_offset != 2 ||
        objective.discriminators.size() != 1 ||
        objective.discriminators.front().monster_class !=
            rofl::core::ObjectiveMonsterClass::dragon ||
        !ward.placement_owner_content_lengths.minimum.has_value() ||
        !ward.placement_owner_content_lengths.maximum.has_value() ||
        *ward.placement_owner_content_lengths.minimum != 113 ||
        *ward.placement_owner_content_lengths.maximum != 141 ||
        !ward.placement_owner_content_lengths.exact_values.empty()) {
        return false;
    }

    const auto is_atomic_rejection = [](std::string_view candidate) {
        const rofl::core::DecoderProfileLoadResult result =
            rofl::core::parse_decoder_profile_registry_json(candidate);
        return !result.ok() && !result.registry.has_value() &&
            !result.errors.empty();
    };

    const auto keyframe_participant_stats_profile_json = [](std::string_view build) {
        std::ostringstream output;
        output << R"json({
            "schema":"rofl-replay-decoder-profiles/v1",
            "registryId":"smoke-test-keyframe-stats",
            "revision":1,
            "profiles":[{
                "versionGroup":"16.14",
                "acceptedGameVersions":[")json" << build << R"json("],
                "finalStatsValidated":true,
                "keyframeParticipantStats":{
                    "acceptedGameVersions":[")json" << build << R"json("],
                    "segmentType":"keyframe",
                    "channel":1,
                    "packetType":747,
                    "contentLength":1479,
                    "championNetworkIdBase":1073741997,
                    "cipherToPlain":[)json";
        for (std::uint16_t value = 0; value < 256; ++value) {
            if (value != 0) output << ',';
            output << value;
        }
        output << R"json(],
                    "experienceOffsets":[83,85,87,89],
                    "experienceProjection":"float32",
                    "totalGoldOffsets":[115,117,119,121],
                    "laneMinionsKilledOffsets":[123,125,127,129],
                    "neutralMinionsKilledOffsets":[131,133,135,137],
                    "neutralMinionsKilledProjection":"floor-plus-1e-5"
                }
            }]
        })json";
        return output.str();
    };

    const std::string keyframe_participant_stats_profile =
        keyframe_participant_stats_profile_json("16.14.794.5912");
    const rofl::core::DecoderProfileLoadResult keyframe_stats_loaded =
        rofl::core::parse_decoder_profile_registry_json(keyframe_participant_stats_profile);
    const rofl::core::DecoderVersionProfile* keyframe_stats_profile =
        keyframe_stats_loaded.registry.has_value()
            ? rofl::core::find_decoder_profile(
                  *keyframe_stats_loaded.registry, "16.14.794.5912")
            : nullptr;
    if (!keyframe_stats_loaded.ok() || keyframe_stats_profile == nullptr ||
        keyframe_stats_loaded.registry->provenance().fingerprint.size() !=
            std::string("fnv1a64:").size() + 16 ||
        !keyframe_stats_profile->keyframe_participant_stats.has_value()) {
        return false;
    }
    const rofl::core::KeyframeParticipantStatsDecoderProfile& keyframe_stats =
        *keyframe_stats_profile->keyframe_participant_stats;
    if (keyframe_stats.segment_type != "keyframe" || keyframe_stats.channel != 1 ||
        keyframe_stats.packet_type != 747 || keyframe_stats.content_length != 1479 ||
        keyframe_stats.champion_network_id_base != 1073741997 ||
        keyframe_stats.cipher_to_plain[0] != std::optional<std::uint8_t>{0} ||
        keyframe_stats.cipher_to_plain[255] != std::optional<std::uint8_t>{255} ||
        !keyframe_stats.experience_offsets.has_value() ||
        *keyframe_stats.experience_offsets !=
            std::array<std::size_t, 4>{83, 85, 87, 89} ||
        keyframe_stats.experience_projection != "float32" ||
        !keyframe_stats.total_gold_offsets.has_value() ||
        *keyframe_stats.total_gold_offsets !=
            std::array<std::size_t, 4>{115, 117, 119, 121} ||
        keyframe_stats.lane_minions_killed_offsets !=
            std::array<std::size_t, 4>{123, 125, 127, 129} ||
        keyframe_stats.neutral_minions_killed_offsets !=
            std::array<std::size_t, 4>{131, 133, 135, 137} ||
        keyframe_stats.neutral_minions_killed_projection != "floor-plus-1e-5") {
        return false;
    }
    std::string duplicate_cipher_profile = keyframe_participant_stats_profile;
    const std::size_t cipher_tail = duplicate_cipher_profile.rfind(",255]");
    if (cipher_tail == std::string::npos) return false;
    duplicate_cipher_profile.replace(cipher_tail, 4, ",254]");

    const std::string minimal_profile = R"json({
        "schema":"rofl-replay-decoder-profiles/v1",
        "registryId":"smoke-test",
        "profiles":[{"versionGroup":"16.14","finalStatsValidated":true}]
    })json";
    const std::string duplicate_key_profile = R"json({
        "schema":"rofl-replay-decoder-profiles/v1",
        "schema":"rofl-replay-decoder-profiles/v1",
        "registryId":"smoke-test",
        "profiles":[{"versionGroup":"16.14","finalStatsValidated":true}]
    })json";
    const std::string duplicate_version_profile = R"json({
        "schema":"rofl-replay-decoder-profiles/v1",
        "registryId":"smoke-test",
        "profiles":[
            {"versionGroup":"16.14","finalStatsValidated":true},
            {"versionGroup":"16.14","finalStatsValidated":true}
        ]
    })json";
    const std::string unknown_field_profile = R"json({
        "schema":"rofl-replay-decoder-profiles/v1",
        "registryId":"smoke-test",
        "unexpected":true,
        "profiles":[{"versionGroup":"16.14","finalStatsValidated":true}]
    })json";
    const std::string invalid_end_offset_profile = R"json({
        "schema":"rofl-replay-decoder-profiles/v1",
        "registryId":"smoke-test",
        "profiles":[{
            "versionGroup":"16.14",
            "objective":{
                "channel":1,
                "packetType":30,
                "minimumContentLength":136,
                "maximumContentLength":137,
                "discriminator":{
                    "origin":"end",
                    "offset":0,
                    "values":[{"value":168,"class":"DRAGON"}]
                }
            }
        }]
    })json";
    std::string oversized_profile(262145, ' ');

    return is_atomic_rejection("{\"schema\"") &&
        is_atomic_rejection(unknown_field_profile) &&
        is_atomic_rejection(duplicate_key_profile) &&
        is_atomic_rejection(duplicate_version_profile) &&
        is_atomic_rejection(invalid_end_offset_profile) &&
        is_atomic_rejection(oversized_profile) &&
        is_atomic_rejection(duplicate_cipher_profile) &&
        !is_atomic_rejection(keyframe_participant_stats_profile_json("16.14.794.5913")) &&
        rofl::core::parse_decoder_profile_registry_json(minimal_profile).ok();
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

    if (!test_multi_packet_type_dump_fixture()) {
        return EXIT_FAILURE;
    }

    if (!test_packet_window_dump_fixture()) {
        return EXIT_FAILURE;
    }

    if (!test_replay_objective_extractor_fixture()) {
        return EXIT_FAILURE;
    }

    if (!test_replay_inventory_purchase_subset_fixture()) {
        return EXIT_FAILURE;
    }

    if (!test_replay_item_sales_fixture()) {
        return EXIT_FAILURE;
    }

    if (!test_replay_direct_item_purchase_subset_fixture()) {
        return EXIT_FAILURE;
    }

    if (!test_replay_ward_extractor_fixture()) {
        return EXIT_FAILURE;
    }

    if (!test_replay_ward_position_research_fixture()) {
        return EXIT_FAILURE;
    }

    if (!test_replay_participant_stat_snapshots_fixture()) {
        return EXIT_FAILURE;
    }

    if (!test_decoder_profile_registry_loader()) {
        return EXIT_FAILURE;
    }

    return EXIT_SUCCESS;
}
