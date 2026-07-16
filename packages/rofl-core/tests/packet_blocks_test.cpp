#include <bit>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <vector>

#include "rofl/core/packet_blocks.hpp"

namespace {

void append_u16_le(std::vector<std::uint8_t>& bytes, const std::uint16_t value) {
    bytes.push_back(static_cast<std::uint8_t>(value & 0xFFU));
    bytes.push_back(static_cast<std::uint8_t>((value >> 8U) & 0xFFU));
}

void append_u32_le(std::vector<std::uint8_t>& bytes, const std::uint32_t value) {
    bytes.push_back(static_cast<std::uint8_t>(value & 0xFFU));
    bytes.push_back(static_cast<std::uint8_t>((value >> 8U) & 0xFFU));
    bytes.push_back(static_cast<std::uint8_t>((value >> 16U) & 0xFFU));
    bytes.push_back(static_cast<std::uint8_t>((value >> 24U) & 0xFFU));
}

void append_f32_le(std::vector<std::uint8_t>& bytes, const float value) {
    append_u32_le(bytes, std::bit_cast<std::uint32_t>(value));
}

[[nodiscard]] bool nearly_equal(const double left, const double right) {
    return std::fabs(left - right) < 0.000000001;
}

[[nodiscard]] bool test_direct_and_compact_blocks() {
    std::vector<std::uint8_t> bytes;

    // Absolute f32 time, u32 length, direct u16 type, direct u32 owner.
    bytes.push_back(0x02);
    append_f32_le(bytes, 12.5F);
    append_u32_le(bytes, 3);
    append_u16_le(bytes, 0x02CB);
    append_u32_le(bytes, 0x400000B4U);
    bytes.insert(bytes.end(), {0x11, 0x22, 0x33});

    // Delta time, u8 length, inherited type, signed compact owner delta.
    bytes.push_back(0xF3);
    bytes.push_back(25);
    bytes.push_back(2);
    bytes.push_back(0xFB);  // -5: 0x400000B4 -> 0x400000AF
    bytes.insert(bytes.end(), {0xAA, 0xBB});

    const rofl::core::PacketSegmentProvenance provenance{
        .kind = rofl::core::PacketSegmentKind::chunk,
        .segment_id = 17,
        .chunk_id = 42,
        .segment_header_offset = 1000,
        .segment_payload_offset = 1017,
    };
    const auto parsed = rofl::core::parse_packet_blocks(bytes, provenance);
    if (!parsed.exactly_consumed() || parsed.blocks.size() != 2 || parsed.consumed_bytes != 24) {
        return false;
    }

    const auto& direct = parsed.blocks[0];
    if (direct.marker != 0x02 || direct.channel != 2 || !nearly_equal(direct.timestamp_seconds, 12.5)) {
        return false;
    }
    if (direct.timestamp_is_delta || direct.content_length_is_compact ||
        direct.packet_type_is_inherited || direct.block_param_is_compact) {
        return false;
    }
    if (direct.content_length != 3 || direct.packet_type != 0x02CB ||
        direct.block_param != 0x400000B4U) {
        return false;
    }
    if (direct.header_offset != 0 || direct.content_offset != 15 || direct.end_offset != 18) {
        return false;
    }
    if (direct.provenance.kind != rofl::core::PacketSegmentKind::chunk ||
        direct.provenance.segment_id != 17 || direct.provenance.chunk_id != 42 ||
        direct.provenance.segment_payload_offset != 1017) {
        return false;
    }

    const auto& compact = parsed.blocks[1];
    if (compact.marker != 0xF3 || compact.channel != 3 ||
        !nearly_equal(compact.timestamp_seconds, 12.525)) {
        return false;
    }
    if (!compact.timestamp_is_delta || compact.timestamp_delta_milliseconds != 25 ||
        !compact.content_length_is_compact || compact.content_length != 2 ||
        !compact.packet_type_is_inherited || compact.packet_type != 0x02CB ||
        !compact.block_param_is_compact || compact.block_param_delta != 0xFB ||
        compact.block_param_signed_delta != -5 || compact.block_param != 0x400000AFU) {
        return false;
    }
    if (compact.header_offset != 18 || compact.content_offset != 22 || compact.end_offset != 24) {
        return false;
    }

    return nearly_equal(parsed.final_state.timestamp_seconds, 12.525) &&
           parsed.final_state.previous_packet_type == 0x02CB &&
           parsed.final_state.previous_block_param == 0x400000AFU &&
           rofl::core::packet_segment_kind_name(provenance.kind) == "chunk";
}

[[nodiscard]] bool test_explicit_state_and_signed_wraparound() {
    const std::vector<std::uint8_t> bytes{
        0xF0,  // all compact/inherited, channel 0
        7,     // +7 ms
        0,     // empty content
        0xFB,  // -5
    };
    const rofl::core::PacketBlockParseState initial{
        .timestamp_seconds = 1.0,
        .previous_packet_type = 0x1234,
        .previous_block_param = 2,
    };

    const auto parsed = rofl::core::parse_packet_blocks(bytes, {}, initial);
    return parsed.exactly_consumed() &&
           parsed.blocks.size() == 1 &&
           nearly_equal(parsed.blocks[0].timestamp_seconds, 1.007) &&
           parsed.blocks[0].packet_type == 0x1234 &&
           parsed.blocks[0].block_param_signed_delta == -5 &&
           parsed.blocks[0].block_param == 0xFFFFFFFDU &&
           parsed.final_state.previous_block_param == 0xFFFFFFFDU;
}

[[nodiscard]] bool expect_error(
    const std::vector<std::uint8_t>& bytes,
    const rofl::core::PacketBlockParseErrorCode code,
    const std::size_t error_offset,
    const std::size_t expected_bytes,
    const std::size_t available_bytes
) {
    const auto parsed = rofl::core::parse_packet_blocks(bytes);
    return !parsed.ok() &&
           !parsed.exactly_consumed() &&
           parsed.blocks.empty() &&
           parsed.consumed_bytes == 0 &&
           parsed.error->code == code &&
           parsed.error->block_index == 0 &&
           parsed.error->block_offset == 0 &&
           parsed.error->error_offset == error_offset &&
           parsed.error->expected_bytes == expected_bytes &&
           parsed.error->available_bytes == available_bytes &&
           !parsed.error->message.empty() &&
           rofl::core::packet_block_parse_error_code_name(code) != "unknown";
}

[[nodiscard]] bool test_clear_truncation_errors() {
    if (!expect_error(
            {0x80},
            rofl::core::PacketBlockParseErrorCode::truncated_timestamp,
            1,
            1,
            0
        )) {
        return false;
    }

    if (!expect_error(
            {0x80, 0},
            rofl::core::PacketBlockParseErrorCode::truncated_content_length,
            2,
            4,
            0
        )) {
        return false;
    }

    if (!expect_error(
            {0x90, 0, 0},
            rofl::core::PacketBlockParseErrorCode::truncated_packet_type,
            3,
            2,
            0
        )) {
        return false;
    }

    if (!expect_error(
            {0xD0, 0, 0},
            rofl::core::PacketBlockParseErrorCode::truncated_block_param,
            3,
            4,
            0
        )) {
        return false;
    }

    if (!expect_error(
            {0xF0, 0, 3, 0, 0xAA},
            rofl::core::PacketBlockParseErrorCode::truncated_content,
            4,
            3,
            1
        )) {
        return false;
    }

    return true;
}

[[nodiscard]] bool test_non_finite_timestamp_error() {
    std::vector<std::uint8_t> bytes{0x70};
    append_u32_le(bytes, 0x7FC00000U);
    bytes.insert(bytes.end(), {0, 0});

    const auto parsed = rofl::core::parse_packet_blocks(bytes);
    return !parsed.ok() &&
           parsed.error->code == rofl::core::PacketBlockParseErrorCode::non_finite_timestamp &&
           parsed.error->error_offset == 1 &&
           parsed.blocks.empty();
}

[[nodiscard]] bool test_partial_parse_is_transactional() {
    std::vector<std::uint8_t> bytes;
    bytes.push_back(0xF0);
    bytes.insert(bytes.end(), {1, 0, 4});
    bytes.push_back(0x80);  // second block has no timestamp byte

    const rofl::core::PacketBlockParseState initial{
        .timestamp_seconds = 2.0,
        .previous_packet_type = 7,
        .previous_block_param = 100,
    };
    const auto parsed = rofl::core::parse_packet_blocks(bytes, {}, initial);
    return !parsed.ok() &&
           parsed.blocks.size() == 1 &&
           parsed.consumed_bytes == 4 &&
           parsed.error->block_index == 1 &&
           parsed.error->block_offset == 4 &&
           parsed.error->error_offset == 5 &&
           nearly_equal(parsed.final_state.timestamp_seconds, 2.001) &&
           parsed.final_state.previous_packet_type == 7 &&
           parsed.final_state.previous_block_param == 104;
}

}  // namespace

int main() {
    if (!test_direct_and_compact_blocks()) {
        return EXIT_FAILURE;
    }
    if (!test_explicit_state_and_signed_wraparound()) {
        return EXIT_FAILURE;
    }
    if (!test_clear_truncation_errors()) {
        return EXIT_FAILURE;
    }
    if (!test_non_finite_timestamp_error()) {
        return EXIT_FAILURE;
    }
    if (!test_partial_parse_is_transactional()) {
        return EXIT_FAILURE;
    }
    return EXIT_SUCCESS;
}
