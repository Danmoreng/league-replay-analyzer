#include <cstdlib>
#include <cstdint>
#include <fstream>
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
        "{\"gameLength\":123456,\"lastGameChunkId\":66,\"lastKeyFrameId\":32,\"statsJson\":\"[{\\\"TEAM\\\":\\\"100\\\",\\\"SKIN\\\":\\\"Ornn\\\",\\\"RIOT_ID_GAME_NAME\\\":\\\"TheBearinator\\\",\\\"RIOT_ID_TAG_LINE\\\":\\\"BABBA\\\",\\\"TEAM_POSITION\\\":\\\"TOP\\\",\\\"WIN\\\":\\\"Win\\\",\\\"CHAMPIONS_KILLED\\\":\\\"3\\\",\\\"NUM_DEATHS\\\":\\\"7\\\",\\\"ASSISTS\\\":\\\"6\\\",\\\"GOLD_EARNED\\\":\\\"10373\\\",\\\"TOTAL_DAMAGE_DEALT_TO_CHAMPIONS\\\":\\\"27239\\\",\\\"VISION_SCORE\\\":\\\"17\\\"}]\"}";
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

    const auto& player = summary.players.front();
    if (player.champion != "Ornn" || player.team != 100 || player.kills != 3 || player.deaths != 7 || player.assists != 6) {
        return false;
    }

    const std::string json = rofl::core::replay_summary_to_json(summary);
    const std::string probe = rofl::core::probe_replay_bytes(build_classic_rofl_fixture());
    return json.find("\"segmentTableAvailable\":true") != std::string::npos &&
           json.find("\"payloadOffset\":") != std::string::npos &&
           probe.find("Classic header valid: yes") != std::string::npos &&
           probe.find("Container format: classic-rofl") != std::string::npos &&
           probe.find("Metadata source: binary-header") != std::string::npos;
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
           summary.warnings.back().find("raw zstd decompression is available") != std::string::npos &&
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

}  // namespace

int main() {
    if (!test_classic_fixture()) {
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

    return EXIT_SUCCESS;
}



