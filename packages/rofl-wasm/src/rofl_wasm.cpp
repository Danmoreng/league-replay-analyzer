#include <cstddef>
#include <cstdint>
#include <cstring>
#include <exception>
#include <string>
#include <vector>

#include "rofl/core/replay_analyzer.hpp"

#ifdef __EMSCRIPTEN__
#include <emscripten/emscripten.h>
#else
#define EMSCRIPTEN_KEEPALIVE
#endif

extern "C" {

EMSCRIPTEN_KEEPALIVE const char* lra_parse_replay_buffer(const std::uint8_t* data, int size) {
    try {
        if (data == nullptr || size <= 0) {
            const std::string empty = "{\"error\":\"Replay buffer was empty.\"}";
            char* output = new char[empty.size() + 1];
            std::memcpy(output, empty.c_str(), empty.size() + 1);
            return output;
        }

        const std::vector<std::uint8_t> bytes(data, data + size);
        const auto summary = rofl::core::parse_replay_bytes(bytes);
        const std::string json = rofl::core::replay_summary_to_json(summary);

        char* output = new char[json.size() + 1];
        std::memcpy(output, json.c_str(), json.size() + 1);
        return output;
    } catch (const std::exception& exception) {
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
