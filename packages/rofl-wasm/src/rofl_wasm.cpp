#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <exception>
#include <iostream>
#include <string>
#include <vector>

#include "rofl/core/replay_analyzer.hpp"

#ifdef __EMSCRIPTEN__
#include <emscripten/console.h>
#include <emscripten/emscripten.h>
#else
#define EMSCRIPTEN_KEEPALIVE
#endif

namespace {

void log_info(const std::string& message) {
#ifdef __EMSCRIPTEN__
    emscripten_console_log(message.c_str());
#else
    std::clog << message << '\n';
#endif
}

void log_error(const std::string& message) {
#ifdef __EMSCRIPTEN__
    emscripten_console_error(message.c_str());
#else
    std::cerr << message << '\n';
#endif
}

}  // namespace

extern "C" {

EMSCRIPTEN_KEEPALIVE std::uint8_t* lra_alloc_buffer(int size) {
    if (size <= 0) {
        log_error("[lra/wasm] Refusing to allocate an empty replay buffer.");
        return nullptr;
    }

    log_info("[lra/wasm] Allocating replay buffer for " + std::to_string(size) + " bytes.");
    return static_cast<std::uint8_t*>(std::malloc(static_cast<std::size_t>(size)));
}

EMSCRIPTEN_KEEPALIVE void lra_copy_buffer_chunk(
    std::uint8_t* destination,
    int offset,
    const std::uint8_t* source,
    int size
) {
    if (destination == nullptr || source == nullptr || offset < 0 || size < 0) {
        log_error("[lra/wasm] Ignoring invalid replay chunk copy request.");
        return;
    }

    std::memcpy(destination + offset, source, static_cast<std::size_t>(size));
}

EMSCRIPTEN_KEEPALIVE void lra_free_buffer(std::uint8_t* value) {
    std::free(value);
}

EMSCRIPTEN_KEEPALIVE const char* lra_parse_replay_buffer(const std::uint8_t* data, int size) {
    try {
        if (data == nullptr || size <= 0) {
            log_error("[lra/wasm] Replay buffer was empty.");
            const std::string empty = "{\"error\":\"Replay buffer was empty.\"}";
            char* output = new char[empty.size() + 1];
            std::memcpy(output, empty.c_str(), empty.size() + 1);
            return output;
        }

        log_info("[lra/wasm] Starting replay parse for " + std::to_string(size) + " bytes.");
        const std::vector<std::uint8_t> bytes(data, data + size);
        const auto summary = rofl::core::parse_replay_bytes(bytes);
        log_info(
            "[lra/wasm] Parsed replay successfully. version=" + summary.game_version +
            ", players=" + std::to_string(summary.players.size()) +
            ", chunks=" + std::to_string(summary.last_game_chunk_id)
        );
        const std::string json = rofl::core::replay_summary_to_json(summary);

        char* output = new char[json.size() + 1];
        std::memcpy(output, json.c_str(), json.size() + 1);
        return output;
    } catch (const std::exception& exception) {
        log_error(std::string{"[lra/wasm] Replay parse failed: "} + exception.what());
        const std::string error_json = std::string{"{\"error\":\""} + exception.what() + "\"}";
        char* output = new char[error_json.size() + 1];
        std::memcpy(output, error_json.c_str(), error_json.size() + 1);
        return output;
    }
}

EMSCRIPTEN_KEEPALIVE const char* lra_scan_replay_families_buffer(
    const std::uint8_t* data,
    int size,
    int minimum_length,
    int minimum_records,
    int top_families
) {
    try {
        if (data == nullptr || size <= 0) {
            const std::string empty = "{\"error\":\"Replay buffer was empty.\"}";
            char* output = new char[empty.size() + 1];
            std::memcpy(output, empty.c_str(), empty.size() + 1);
            return output;
        }

        const std::vector<std::uint8_t> bytes(data, data + size);
        const std::string json = rofl::core::scan_replay_families_json(
            bytes,
            static_cast<std::size_t>(std::max(minimum_length, 0)),
            static_cast<std::size_t>(std::max(minimum_records, 0)),
            static_cast<std::size_t>(std::max(top_families, 0))
        );
        char* output = new char[json.size() + 1];
        std::memcpy(output, json.c_str(), json.size() + 1);
        return output;
    } catch (const std::exception& exception) {
        log_error(std::string{"[lra/wasm] Family scan failed: "} + exception.what());
        const std::string error_json = std::string{"{\"error\":\""} + exception.what() + "\"}";
        char* output = new char[error_json.size() + 1];
        std::memcpy(output, error_json.c_str(), error_json.size() + 1);
        return output;
    }
}

EMSCRIPTEN_KEEPALIVE const char* lra_analyze_scalar_family_buffer(
    const std::uint8_t* data,
    int size,
    int target_length,
    int target_first_byte,
    int header_size,
    int stride,
    int top_slots
) {
    try {
        if (data == nullptr || size <= 0) {
            const std::string empty = "{\"error\":\"Replay buffer was empty.\"}";
            char* output = new char[empty.size() + 1];
            std::memcpy(output, empty.c_str(), empty.size() + 1);
            return output;
        }

        const std::vector<std::uint8_t> bytes(data, data + size);
        const std::string json = rofl::core::analyze_scalar_family_json(
            bytes,
            static_cast<std::size_t>(std::max(target_length, 0)),
            static_cast<std::uint8_t>(std::clamp(target_first_byte, 0, 255)),
            static_cast<std::size_t>(std::max(header_size, 0)),
            static_cast<std::size_t>(std::max(stride, 0)),
            static_cast<std::size_t>(std::max(top_slots, 0))
        );
        char* output = new char[json.size() + 1];
        std::memcpy(output, json.c_str(), json.size() + 1);
        return output;
    } catch (const std::exception& exception) {
        log_error(std::string{"[lra/wasm] Scalar-family analysis failed: "} + exception.what());
        const std::string error_json = std::string{"{\"error\":\""} + exception.what() + "\"}";
        char* output = new char[error_json.size() + 1];
        std::memcpy(output, error_json.c_str(), error_json.size() + 1);
        return output;
    }
}

EMSCRIPTEN_KEEPALIVE const char* lra_analyze_sparse_family_buffer(
    const std::uint8_t* data,
    int size,
    int target_length,
    int target_first_byte,
    int header_size,
    int stride,
    int top_slots,
    float move_epsilon,
    float smooth_threshold
) {
    try {
        if (data == nullptr || size <= 0) {
            const std::string empty = "{\"error\":\"Replay buffer was empty.\"}";
            char* output = new char[empty.size() + 1];
            std::memcpy(output, empty.c_str(), empty.size() + 1);
            return output;
        }

        const std::vector<std::uint8_t> bytes(data, data + size);
        const std::string json = rofl::core::analyze_sparse_family_json(
            bytes,
            static_cast<std::size_t>(std::max(target_length, 0)),
            static_cast<std::uint8_t>(std::clamp(target_first_byte, 0, 255)),
            static_cast<std::size_t>(std::max(header_size, 0)),
            static_cast<std::size_t>(std::max(stride, 0)),
            static_cast<std::size_t>(std::max(top_slots, 0)),
            move_epsilon,
            smooth_threshold
        );
        char* output = new char[json.size() + 1];
        std::memcpy(output, json.c_str(), json.size() + 1);
        return output;
    } catch (const std::exception& exception) {
        log_error(std::string{"[lra/wasm] Sparse-family analysis failed: "} + exception.what());
        const std::string error_json = std::string{"{\"error\":\""} + exception.what() + "\"}";
        char* output = new char[error_json.size() + 1];
        std::memcpy(output, error_json.c_str(), error_json.size() + 1);
        return output;
    }
}
EMSCRIPTEN_KEEPALIVE void lra_free_string(const char* value) {
    delete[] value;
}

}


