#include <cstdlib>
#include <cstdint>
#include <string>
#include <vector>

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
    if (summary.players.size() != 1) {
        return false;
    }

    const auto& player = summary.players.front();
    if (player.champion != "Ornn" || player.team != 100 || player.kills != 3 || player.deaths != 7 || player.assists != 6) {
        return false;
    }

    const std::string json = rofl::core::replay_summary_to_json(summary);
    return json.find("\"segmentTableAvailable\":true") != std::string::npos;
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
    return json.find("\"metadataSource\":\"footer-size\"") != std::string::npos;
}

}  // namespace

int main() {
    if (!test_classic_fixture()) {
        return EXIT_FAILURE;
    }

    if (!test_footer_fixture()) {
        return EXIT_FAILURE;
    }

    return EXIT_SUCCESS;
}
