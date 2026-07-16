#include "rofl/core/packet_blocks.hpp"

#include <bit>
#include <cmath>
#include <string>

namespace rofl::core {
namespace {

static_assert(sizeof(float) == sizeof(std::uint32_t));

[[nodiscard]] std::uint16_t read_u16_le(
    const std::span<const std::uint8_t> bytes,
    const std::size_t offset
) noexcept {
    return static_cast<std::uint16_t>(
        static_cast<std::uint16_t>(bytes[offset]) |
        (static_cast<std::uint16_t>(bytes[offset + 1]) << 8U)
    );
}

[[nodiscard]] std::uint32_t read_u32_le(
    const std::span<const std::uint8_t> bytes,
    const std::size_t offset
) noexcept {
    return static_cast<std::uint32_t>(bytes[offset]) |
           (static_cast<std::uint32_t>(bytes[offset + 1]) << 8U) |
           (static_cast<std::uint32_t>(bytes[offset + 2]) << 16U) |
           (static_cast<std::uint32_t>(bytes[offset + 3]) << 24U);
}

[[nodiscard]] float read_f32_le(
    const std::span<const std::uint8_t> bytes,
    const std::size_t offset
) noexcept {
    return std::bit_cast<float>(read_u32_le(bytes, offset));
}

[[nodiscard]] std::size_t available_from(
    const std::span<const std::uint8_t> bytes,
    const std::size_t offset
) noexcept {
    return offset <= bytes.size() ? bytes.size() - offset : 0;
}

[[nodiscard]] std::string make_truncation_message(
    const std::string_view field,
    const std::size_t offset,
    const std::size_t expected,
    const std::size_t available
) {
    return "Packet block " + std::string(field) + " is truncated at decompressed offset " +
           std::to_string(offset) + ": expected " + std::to_string(expected) +
           " byte(s), found " + std::to_string(available) + ".";
}

void set_truncation_error(
    PacketBlockParseResult& result,
    const PacketBlockParseErrorCode code,
    const std::size_t block_index,
    const std::size_t block_offset,
    const std::size_t error_offset,
    const std::size_t expected_bytes,
    const std::size_t available_bytes,
    const std::uint32_t declared_content_length,
    const std::string_view field
) {
    result.consumed_bytes = block_offset;
    result.error = PacketBlockParseError{
        .code = code,
        .block_index = block_index,
        .block_offset = block_offset,
        .error_offset = error_offset,
        .expected_bytes = expected_bytes,
        .available_bytes = available_bytes,
        .declared_content_length = declared_content_length,
        .message = make_truncation_message(field, error_offset, expected_bytes, available_bytes),
    };
}

}  // namespace

PacketBlockParseResult parse_packet_blocks(
    const std::span<const std::uint8_t> bytes,
    const PacketSegmentProvenance provenance,
    const PacketBlockParseState initial_state
) {
    PacketBlockParseResult result;
    result.provenance = provenance;
    result.initial_state = initial_state;
    result.final_state = initial_state;
    result.input_size = bytes.size();

    PacketBlockParseState state = initial_state;
    std::size_t cursor = 0;

    while (cursor < bytes.size()) {
        const std::size_t block_offset = cursor;
        const std::size_t block_index = result.blocks.size();

        PacketBlock block;
        block.provenance = provenance;
        block.block_index = block_index;
        block.header_offset = block_offset;
        block.marker = bytes[cursor++];
        block.channel = static_cast<std::uint8_t>(block.marker & 0x0FU);

        PacketBlockParseState next_state = state;

        block.timestamp_is_delta = (block.marker & 0x80U) != 0;
        if (block.timestamp_is_delta) {
            if (available_from(bytes, cursor) < 1) {
                set_truncation_error(
                    result,
                    PacketBlockParseErrorCode::truncated_timestamp,
                    block_index,
                    block_offset,
                    cursor,
                    1,
                    available_from(bytes, cursor),
                    0,
                    "timestamp"
                );
                return result;
            }

            block.timestamp_delta_milliseconds = bytes[cursor++];
            next_state.timestamp_seconds +=
                static_cast<double>(block.timestamp_delta_milliseconds) / 1000.0;
        } else {
            constexpr std::size_t timestamp_size = sizeof(float);
            if (available_from(bytes, cursor) < timestamp_size) {
                set_truncation_error(
                    result,
                    PacketBlockParseErrorCode::truncated_timestamp,
                    block_index,
                    block_offset,
                    cursor,
                    timestamp_size,
                    available_from(bytes, cursor),
                    0,
                    "timestamp"
                );
                return result;
            }

            next_state.timestamp_seconds = static_cast<double>(read_f32_le(bytes, cursor));
            cursor += timestamp_size;
        }

        block.timestamp_seconds = next_state.timestamp_seconds;
        if (!std::isfinite(block.timestamp_seconds)) {
            result.consumed_bytes = block_offset;
            result.error = PacketBlockParseError{
                .code = PacketBlockParseErrorCode::non_finite_timestamp,
                .block_index = block_index,
                .block_offset = block_offset,
                .error_offset = block_offset + 1,
                .expected_bytes = block.timestamp_is_delta ? 1U : sizeof(float),
                .available_bytes = block.timestamp_is_delta ? 1U : sizeof(float),
                .declared_content_length = 0,
                .message = "Packet block timestamp resolved to a non-finite value at decompressed offset " +
                           std::to_string(block_offset + 1) + ".",
            };
            return result;
        }

        block.content_length_is_compact = (block.marker & 0x10U) != 0;
        if (block.content_length_is_compact) {
            if (available_from(bytes, cursor) < 1) {
                set_truncation_error(
                    result,
                    PacketBlockParseErrorCode::truncated_content_length,
                    block_index,
                    block_offset,
                    cursor,
                    1,
                    available_from(bytes, cursor),
                    0,
                    "content length"
                );
                return result;
            }
            block.content_length = bytes[cursor++];
        } else {
            constexpr std::size_t content_length_size = sizeof(std::uint32_t);
            if (available_from(bytes, cursor) < content_length_size) {
                set_truncation_error(
                    result,
                    PacketBlockParseErrorCode::truncated_content_length,
                    block_index,
                    block_offset,
                    cursor,
                    content_length_size,
                    available_from(bytes, cursor),
                    0,
                    "content length"
                );
                return result;
            }
            block.content_length = read_u32_le(bytes, cursor);
            cursor += content_length_size;
        }

        block.packet_type_is_inherited = (block.marker & 0x40U) != 0;
        if (block.packet_type_is_inherited) {
            block.packet_type = state.previous_packet_type;
        } else {
            constexpr std::size_t packet_type_size = sizeof(std::uint16_t);
            if (available_from(bytes, cursor) < packet_type_size) {
                set_truncation_error(
                    result,
                    PacketBlockParseErrorCode::truncated_packet_type,
                    block_index,
                    block_offset,
                    cursor,
                    packet_type_size,
                    available_from(bytes, cursor),
                    block.content_length,
                    "packet type"
                );
                return result;
            }
            block.packet_type = read_u16_le(bytes, cursor);
            cursor += packet_type_size;
        }
        next_state.previous_packet_type = block.packet_type;

        block.block_param_is_compact = (block.marker & 0x20U) != 0;
        if (block.block_param_is_compact) {
            if (available_from(bytes, cursor) < 1) {
                set_truncation_error(
                    result,
                    PacketBlockParseErrorCode::truncated_block_param,
                    block_index,
                    block_offset,
                    cursor,
                    1,
                    available_from(bytes, cursor),
                    block.content_length,
                    "block parameter"
                );
                return result;
            }

            block.block_param_delta = bytes[cursor++];
            block.block_param_signed_delta =
                block.block_param_delta <= 0x7FU
                    ? static_cast<std::int16_t>(block.block_param_delta)
                    : static_cast<std::int16_t>(block.block_param_delta) - 256;

            if (block.block_param_signed_delta >= 0) {
                block.block_param =
                    state.previous_block_param +
                    static_cast<std::uint32_t>(block.block_param_signed_delta);
            } else {
                block.block_param =
                    state.previous_block_param -
                    static_cast<std::uint32_t>(-block.block_param_signed_delta);
            }
        } else {
            constexpr std::size_t block_param_size = sizeof(std::uint32_t);
            if (available_from(bytes, cursor) < block_param_size) {
                set_truncation_error(
                    result,
                    PacketBlockParseErrorCode::truncated_block_param,
                    block_index,
                    block_offset,
                    cursor,
                    block_param_size,
                    available_from(bytes, cursor),
                    block.content_length,
                    "block parameter"
                );
                return result;
            }
            block.block_param = read_u32_le(bytes, cursor);
            cursor += block_param_size;
        }
        next_state.previous_block_param = block.block_param;

        block.content_offset = cursor;
        const std::size_t available_content = available_from(bytes, cursor);
        if (static_cast<std::size_t>(block.content_length) > available_content) {
            set_truncation_error(
                result,
                PacketBlockParseErrorCode::truncated_content,
                block_index,
                block_offset,
                cursor,
                block.content_length,
                available_content,
                block.content_length,
                "content"
            );
            return result;
        }

        cursor += block.content_length;
        block.end_offset = cursor;

        state = next_state;
        result.blocks.push_back(block);
        result.final_state = state;
        result.consumed_bytes = cursor;
    }

    return result;
}

std::string_view packet_segment_kind_name(const PacketSegmentKind kind) noexcept {
    switch (kind) {
        case PacketSegmentKind::startup:
            return "startup";
        case PacketSegmentKind::keyframe:
            return "keyframe";
        case PacketSegmentKind::chunk:
            return "chunk";
        case PacketSegmentKind::unknown:
            return "unknown";
    }
    return "unknown";
}

std::string_view packet_block_parse_error_code_name(
    const PacketBlockParseErrorCode code
) noexcept {
    switch (code) {
        case PacketBlockParseErrorCode::truncated_timestamp:
            return "truncated-timestamp";
        case PacketBlockParseErrorCode::truncated_content_length:
            return "truncated-content-length";
        case PacketBlockParseErrorCode::truncated_packet_type:
            return "truncated-packet-type";
        case PacketBlockParseErrorCode::truncated_block_param:
            return "truncated-block-param";
        case PacketBlockParseErrorCode::truncated_content:
            return "truncated-content";
        case PacketBlockParseErrorCode::non_finite_timestamp:
            return "non-finite-timestamp";
    }
    return "unknown";
}

}  // namespace rofl::core
