#pragma once

#include <cstddef>
#include <cstdint>
#include <optional>
#include <span>
#include <string>
#include <string_view>
#include <vector>

namespace rofl::core {

enum class PacketSegmentKind : std::uint8_t {
    unknown,
    startup,
    keyframe,
    chunk,
};

struct PacketSegmentProvenance {
    PacketSegmentKind kind = PacketSegmentKind::unknown;
    int segment_id = 0;
    int chunk_id = 0;
    std::size_t segment_header_offset = 0;
    std::size_t segment_payload_offset = 0;
};

struct PacketBlockParseState {
    double timestamp_seconds = 0.0;
    std::uint16_t previous_packet_type = 0;
    std::uint32_t previous_block_param = 0;
};

struct PacketBlock {
    PacketSegmentProvenance provenance;
    std::size_t block_index = 0;
    std::uint8_t marker = 0;
    std::uint8_t channel = 0;

    double timestamp_seconds = 0.0;
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

    // These offsets are relative to the decompressed segment passed to
    // parse_packet_blocks. Payload bytes remain owned by the caller.
    std::size_t header_offset = 0;
    std::size_t content_offset = 0;
    std::size_t end_offset = 0;
};

enum class PacketBlockParseErrorCode : std::uint8_t {
    truncated_timestamp,
    truncated_content_length,
    truncated_packet_type,
    truncated_block_param,
    truncated_content,
    non_finite_timestamp,
};

struct PacketBlockParseError {
    PacketBlockParseErrorCode code = PacketBlockParseErrorCode::truncated_timestamp;
    std::size_t block_index = 0;
    std::size_t block_offset = 0;
    std::size_t error_offset = 0;
    std::size_t expected_bytes = 0;
    std::size_t available_bytes = 0;
    std::uint32_t declared_content_length = 0;
    std::string message;
};

struct PacketBlockParseResult {
    PacketSegmentProvenance provenance;
    PacketBlockParseState initial_state;
    PacketBlockParseState final_state;
    std::size_t input_size = 0;
    std::size_t consumed_bytes = 0;
    std::vector<PacketBlock> blocks;
    std::optional<PacketBlockParseError> error;

    [[nodiscard]] bool ok() const noexcept {
        return !error.has_value();
    }

    [[nodiscard]] bool exactly_consumed() const noexcept {
        return ok() && consumed_bytes == input_size;
    }
};

// A decompressed startup, keyframe, or chunk is independently framed. Callers
// should normally use the default zero state for every segment. An explicit
// state is accepted for focused research and synthetic continuation tests.
[[nodiscard]] PacketBlockParseResult parse_packet_blocks(
    std::span<const std::uint8_t> bytes,
    PacketSegmentProvenance provenance = {},
    PacketBlockParseState initial_state = {}
);

[[nodiscard]] std::string_view packet_segment_kind_name(PacketSegmentKind kind) noexcept;
[[nodiscard]] std::string_view packet_block_parse_error_code_name(PacketBlockParseErrorCode code) noexcept;

}  // namespace rofl::core
