#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <exception>
#include <iostream>
#include <sstream>
#include <string>
#include <string_view>
#include <vector>

#include "rofl/core/replay_analyzer.hpp"

#ifdef __EMSCRIPTEN__
#include <emscripten/console.h>
#include <emscripten/emscripten.h>
#else
#define EMSCRIPTEN_KEEPALIVE
#endif

namespace {

std::vector<std::size_t> parse_slot_indices_csv(const char* csv) {
    std::vector<std::size_t> slot_indices;
    if (csv == nullptr || csv[0] == '\0') {
        return slot_indices;
    }

    std::stringstream stream(csv);
    std::string token;
    while (std::getline(stream, token, ',')) {
        if (token.empty()) {
            continue;
        }
        try {
            slot_indices.push_back(static_cast<std::size_t>(std::stoull(token)));
        } catch (const std::exception&) {
        }
    }

    return slot_indices;
}

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

[[nodiscard]] std::string json_escape(std::string_view input) {
    std::string escaped;
    escaped.reserve(input.size());
    for (const char character : input) {
        switch (character) {
            case '\\': escaped += "\\\\"; break;
            case '"': escaped += "\\\""; break;
            case '\n': escaped += "\\n"; break;
            case '\r': escaped += "\\r"; break;
            case '\t': escaped += "\\t"; break;
            default:
                escaped += static_cast<unsigned char>(character) < 0x20U ? '?' : character;
        }
    }
    return escaped;
}

[[nodiscard]] const char* allocate_result(std::string_view json) {
    char* output = new char[json.size() + 1];
    std::memcpy(output, json.data(), json.size());
    output[json.size()] = '\0';
    return output;
}

[[nodiscard]] const char* profile_error_result(std::string_view message) {
    return allocate_result(std::string{"{\"error\":\""} + json_escape(message) + "\"}");
}

template <typename Decode>
[[nodiscard]] const char* run_with_decoder_profiles(
    const std::uint8_t* replay_data,
    int replay_size,
    const std::uint8_t* profile_data,
    int profile_size,
    std::string_view operation,
    Decode&& decode
) {
    try {
        if (replay_data == nullptr || replay_size <= 0) {
            return profile_error_result("Replay buffer was empty while " + std::string(operation) + ".");
        }
        if (profile_data == nullptr || profile_size <= 0) {
            return profile_error_result("Decoder profile registry buffer was empty.");
        }

        const std::string profile_json(
            reinterpret_cast<const char*>(profile_data),
            static_cast<std::size_t>(profile_size)
        );
        const auto load_result = rofl::core::parse_decoder_profile_registry_json(profile_json);
        if (!load_result.ok()) {
            const std::string error = load_result.errors.empty()
                ? "Decoder profile registry was rejected."
                : "Decoder profile registry was rejected: " + load_result.errors.front();
            return profile_error_result(error);
        }

        const std::vector<std::uint8_t> replay_bytes(replay_data, replay_data + replay_size);
        return allocate_result(decode(replay_bytes, *load_result.registry));
    } catch (const std::exception& exception) {
        log_error(
            "[lra/wasm] " + std::string(operation) +
            " with decoder profiles failed: " + exception.what()
        );
        return profile_error_result(exception.what());
    }
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

EMSCRIPTEN_KEEPALIVE const char* lra_extract_replay_kills_buffer(
    const std::uint8_t* data,
    int size
) {
    try {
        if (data == nullptr || size <= 0) {
            log_error("[lra/wasm] Replay buffer was empty while decoding kills.");
            const std::string empty = "{\"error\":\"Replay buffer was empty.\"}";
            char* output = new char[empty.size() + 1];
            std::memcpy(output, empty.c_str(), empty.size() + 1);
            return output;
        }

        log_info("[lra/wasm] Decoding replay kill timeline from packet blocks.");
        const std::vector<std::uint8_t> bytes(data, data + size);
        const std::string json = rofl::core::extract_replay_kills_json(bytes);
        char* output = new char[json.size() + 1];
        std::memcpy(output, json.c_str(), json.size() + 1);
        return output;
    } catch (const std::exception& exception) {
        log_error(std::string{"[lra/wasm] Replay kill decoding failed: "} + exception.what());
        const std::string error_json = std::string{"{\"error\":\""} + exception.what() + "\"}";
        char* output = new char[error_json.size() + 1];
        std::memcpy(output, error_json.c_str(), error_json.size() + 1);
        return output;
    }
}

EMSCRIPTEN_KEEPALIVE const char* lra_parse_replay_buffer_with_profiles(
    const std::uint8_t* replay_data,
    int replay_size,
    const std::uint8_t* profile_data,
    int profile_size
) {
    return run_with_decoder_profiles(
        replay_data,
        replay_size,
        profile_data,
        profile_size,
        "parsing replay",
        [](const auto& bytes, const auto& profiles) {
            return rofl::core::replay_summary_to_json(
                rofl::core::parse_replay_bytes(bytes, profiles)
            );
        }
    );
}

EMSCRIPTEN_KEEPALIVE const char* lra_extract_replay_objectives_buffer(
    const std::uint8_t* data,
    int size
) {
    try {
        if (data == nullptr || size <= 0) {
            log_error("[lra/wasm] Replay buffer was empty while decoding objectives.");
            const std::string empty = "{\"error\":\"Replay buffer was empty.\"}";
            char* output = new char[empty.size() + 1];
            std::memcpy(output, empty.c_str(), empty.size() + 1);
            return output;
        }

        log_info("[lra/wasm] Decoding replay elite-monster objectives from packet blocks.");
        const std::vector<std::uint8_t> bytes(data, data + size);
        const std::string json = rofl::core::extract_replay_objectives_json(bytes);
        char* output = new char[json.size() + 1];
        std::memcpy(output, json.c_str(), json.size() + 1);
        return output;
    } catch (const std::exception& exception) {
        log_error(std::string{"[lra/wasm] Replay objective decoding failed: "} + exception.what());
        const std::string error_json = std::string{"{\"error\":\""} + exception.what() + "\"}";
        char* output = new char[error_json.size() + 1];
        std::memcpy(output, error_json.c_str(), error_json.size() + 1);
        return output;
    }
}

EMSCRIPTEN_KEEPALIVE const char* lra_extract_replay_kills_buffer_with_profiles(
    const std::uint8_t* replay_data,
    int replay_size,
    const std::uint8_t* profile_data,
    int profile_size
) {
    return run_with_decoder_profiles(
        replay_data,
        replay_size,
        profile_data,
        profile_size,
        "decoding kills",
        [](const auto& bytes, const auto& profiles) {
            return rofl::core::extract_replay_kills_json(bytes, profiles);
        }
    );
}

EMSCRIPTEN_KEEPALIVE const char*
lra_extract_replay_purchase_linked_item_updates_buffer_with_profiles(
    const std::uint8_t* replay_data,
    int replay_size,
    const std::uint8_t* profile_data,
    int profile_size
) {
    return run_with_decoder_profiles(
        replay_data,
        replay_size,
        profile_data,
        profile_size,
        "decoding purchase-linked item updates",
        [](const auto& bytes, const auto& profiles) {
            return rofl::core::extract_replay_purchase_linked_item_updates_json(
                bytes,
                profiles
            );
        }
    );
}

EMSCRIPTEN_KEEPALIVE const char*
lra_extract_replay_direct_item_purchases_buffer_with_profiles(
    const std::uint8_t* replay_data,
    int replay_size,
    const std::uint8_t* profile_data,
    int profile_size
) {
    return run_with_decoder_profiles(
        replay_data,
        replay_size,
        profile_data,
        profile_size,
        "decoding direct add-only item purchases",
        [](const auto& bytes, const auto& profiles) {
            return rofl::core::extract_replay_direct_item_purchases_json(
                bytes,
                profiles
            );
        }
    );
}

EMSCRIPTEN_KEEPALIVE const char*
lra_extract_replay_item_sales_buffer_with_profiles(
    const std::uint8_t* replay_data,
    int replay_size,
    const std::uint8_t* profile_data,
    int profile_size
) {
    return run_with_decoder_profiles(
        replay_data,
        replay_size,
        profile_data,
        profile_size,
        "decoding item sale operations",
        [](const auto& bytes, const auto& profiles) {
            return rofl::core::extract_replay_item_sales_json(bytes, profiles);
        }
    );
}

// This surface intentionally has no built-in-profile overload. Participant
// stat snapshots are emitted only when the caller supplied a strict external
// decoder registry containing the exact-build snapshot capability.
EMSCRIPTEN_KEEPALIVE const char*
lra_extract_replay_participant_stat_snapshots_buffer_with_profiles(
    const std::uint8_t* replay_data,
    int replay_size,
    const std::uint8_t* profile_data,
    int profile_size
) {
    return run_with_decoder_profiles(
        replay_data,
        replay_size,
        profile_data,
        profile_size,
        "decoding participant stat snapshots",
        [](const auto& bytes, const auto& profiles) {
            return rofl::core::extract_replay_participant_stat_snapshots_json(
                bytes,
                profiles
            );
        }
    );
}

EMSCRIPTEN_KEEPALIVE const char* lra_extract_replay_wards_buffer(
    const std::uint8_t* data,
    int size
) {
    try {
        if (data == nullptr || size <= 0) {
            log_error("[lra/wasm] Replay buffer was empty while decoding wards.");
            const std::string empty = "{\"error\":\"Replay buffer was empty.\"}";
            char* output = new char[empty.size() + 1];
            std::memcpy(output, empty.c_str(), empty.size() + 1);
            return output;
        }

        log_info("[lra/wasm] Decoding replay ward lifecycle from packet blocks.");
        const std::vector<std::uint8_t> bytes(data, data + size);
        const std::string json = rofl::core::extract_replay_wards_json(bytes);
        char* output = new char[json.size() + 1];
        std::memcpy(output, json.c_str(), json.size() + 1);
        return output;
    } catch (const std::exception& exception) {
        log_error(std::string{"[lra/wasm] Replay ward decoding failed: "} + exception.what());
        const std::string error_json = std::string{"{\"error\":\""} + exception.what() + "\"}";
        char* output = new char[error_json.size() + 1];
        std::memcpy(output, error_json.c_str(), error_json.size() + 1);
        return output;
    }
}

EMSCRIPTEN_KEEPALIVE const char* lra_extract_replay_objectives_buffer_with_profiles(
    const std::uint8_t* replay_data,
    int replay_size,
    const std::uint8_t* profile_data,
    int profile_size
) {
    return run_with_decoder_profiles(
        replay_data,
        replay_size,
        profile_data,
        profile_size,
        "decoding objectives",
        [](const auto& bytes, const auto& profiles) {
            return rofl::core::extract_replay_objectives_json(bytes, profiles);
        }
    );
}

EMSCRIPTEN_KEEPALIVE const char*
lra_extract_replay_ward_position_candidates_buffer(
    const std::uint8_t* data,
    int size
) {
    try {
        if (data == nullptr || size <= 0) {
            log_error(
                "[lra/wasm] Replay buffer was empty while decoding "
                "ward position research candidates."
            );
            const std::string empty =
                "{\"error\":\"Replay buffer was empty.\"}";
            char* output = new char[empty.size() + 1];
            std::memcpy(output, empty.c_str(), empty.size() + 1);
            return output;
        }

        log_info(
            "[lra/wasm] Deriving research-only ward marker "
            "hypotheses from replay packet blocks."
        );
        const std::vector<std::uint8_t> bytes(data, data + size);
        const std::string json =
            rofl::core::extract_replay_ward_position_candidates_json(
                bytes
            );
        char* output = new char[json.size() + 1];
        std::memcpy(output, json.c_str(), json.size() + 1);
        return output;
    } catch (const std::exception& exception) {
        log_error(
            std::string{
                "[lra/wasm] Replay ward position research failed: "
            } + exception.what()
        );
        const std::string error_json =
            std::string{"{\"error\":\""} +
            exception.what() + "\"}";
        char* output = new char[error_json.size() + 1];
        std::memcpy(
            output,
            error_json.c_str(),
            error_json.size() + 1
        );
        return output;
    }
}

EMSCRIPTEN_KEEPALIVE const char* lra_extract_replay_wards_buffer_with_profiles(
    const std::uint8_t* replay_data,
    int replay_size,
    const std::uint8_t* profile_data,
    int profile_size
) {
    return run_with_decoder_profiles(
        replay_data,
        replay_size,
        profile_data,
        profile_size,
        "decoding wards",
        [](const auto& bytes, const auto& profiles) {
            return rofl::core::extract_replay_wards_json(bytes, profiles);
        }
    );
}

EMSCRIPTEN_KEEPALIVE const char*
lra_extract_replay_ward_position_candidates_buffer_with_profiles(
    const std::uint8_t* replay_data,
    int replay_size,
    const std::uint8_t* profile_data,
    int profile_size
) {
    return run_with_decoder_profiles(
        replay_data,
        replay_size,
        profile_data,
        profile_size,
        "deriving ward position research candidates",
        [](const auto& bytes, const auto& profiles) {
            return rofl::core::extract_replay_ward_position_candidates_json(
                bytes,
                profiles
            );
        }
    );
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

EMSCRIPTEN_KEEPALIVE const char* lra_analyze_entity_slab_buffer(
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
        const std::string json = rofl::core::analyze_entity_slab_json(
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
        log_error(std::string{"[lra/wasm] Entity-slab analysis failed: "} + exception.what());
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

EMSCRIPTEN_KEEPALIVE const char* lra_analyze_clean_row_offsets_buffer(
    const std::uint8_t* data,
    int size,
    int target_length,
    int target_first_byte,
    int header_size,
    int stride,
    const char* slot_indices_csv,
    int top_fields
) {
    try {
        if (data == nullptr || size <= 0) {
            const std::string empty = "{\"error\":\"Replay buffer was empty.\"}";
            char* output = new char[empty.size() + 1];
            std::memcpy(output, empty.c_str(), empty.size() + 1);
            return output;
        }

        const std::vector<std::uint8_t> bytes(data, data + size);
        const auto slot_indices = parse_slot_indices_csv(slot_indices_csv);
        const std::string json = rofl::core::analyze_clean_row_offsets_json(
            bytes,
            static_cast<std::size_t>(std::max(target_length, 0)),
            static_cast<std::uint8_t>(std::clamp(target_first_byte, 0, 255)),
            static_cast<std::size_t>(std::max(header_size, 0)),
            static_cast<std::size_t>(std::max(stride, 0)),
            slot_indices,
            static_cast<std::size_t>(std::max(top_fields, 0))
        );
        char* output = new char[json.size() + 1];
        std::memcpy(output, json.c_str(), json.size() + 1);
        return output;
    } catch (const std::exception& exception) {
        log_error(std::string{"[lra/wasm] Clean-row analysis failed: "} + exception.what());
        const std::string error_json = std::string{"{\"error\":\""} + exception.what() + "\"}";
        char* output = new char[error_json.size() + 1];
        std::memcpy(output, error_json.c_str(), error_json.size() + 1);
        return output;
    }
}

EMSCRIPTEN_KEEPALIVE const char* lra_analyze_bitfield_schema_buffer(
    const std::uint8_t* data,
    int size,
    int target_length,
    int target_first_byte,
    int header_size,
    int stride,
    const char* slot_indices_csv,
    int top_windows
) {
    try {
        if (data == nullptr || size <= 0) {
            const std::string empty = "{\"error\":\"Replay buffer was empty.\"}";
            char* output = new char[empty.size() + 1];
            std::memcpy(output, empty.c_str(), empty.size() + 1);
            return output;
        }

        const std::vector<std::uint8_t> bytes(data, data + size);
        const auto slot_indices = parse_slot_indices_csv(slot_indices_csv);
        const std::string json = rofl::core::analyze_bitfield_schema_json(
            bytes,
            static_cast<std::size_t>(std::max(target_length, 0)),
            static_cast<std::uint8_t>(std::clamp(target_first_byte, 0, 255)),
            static_cast<std::size_t>(std::max(header_size, 0)),
            static_cast<std::size_t>(std::max(stride, 0)),
            slot_indices,
            static_cast<std::size_t>(std::max(top_windows, 0))
        );
        char* output = new char[json.size() + 1];
        std::memcpy(output, json.c_str(), json.size() + 1);
        return output;
    } catch (const std::exception& exception) {
        log_error(std::string{"[lra/wasm] Bitfield-schema analysis failed: "} + exception.what());
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


