#include <exception>
#include <iostream>
#include <optional>
#include <sstream>
#include <stdexcept>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include "rofl/core/replay_analyzer.hpp"

namespace {

[[nodiscard]] std::optional<rofl::core::DecoderProfileRegistry>
load_optional_decoder_profile_registry(int argc, char** argv, int first_option_index) {
    std::optional<std::string> profile_path;
    for (int index = first_option_index; index < argc; ++index) {
        const std::string_view argument = argv[index];
        if (argument != "--decoder-profiles") {
            continue;
        }
        if (index + 1 >= argc) {
            throw std::invalid_argument("Missing path after --decoder-profiles");
        }
        if (profile_path.has_value()) {
            throw std::invalid_argument("--decoder-profiles may only be provided once");
        }
        profile_path = argv[++index];
        if (profile_path->empty()) {
            throw std::invalid_argument("--decoder-profiles requires a non-empty JSON path");
        }
    }

    if (!profile_path.has_value()) {
        return std::nullopt;
    }

    auto loaded = rofl::core::load_decoder_profile_registry_file(*profile_path);
    if (loaded.ok()) {
        return std::move(loaded.registry);
    }

    std::ostringstream message;
    message << "Failed to load decoder profiles from '" << *profile_path << "'";
    if (!loaded.errors.empty()) {
        message << ':';
        for (const std::string& error : loaded.errors) {
            message << "\n  - " << error;
        }
    }
    throw std::runtime_error(message.str());
}

}  // namespace

int main(int argc, char** argv) {
    const std::string_view first_arg = argc > 1 ? argv[1] : "";

    if (first_arg == "--version") {
        std::cout << rofl::core::describe_scaffold() << '\n';
        return 0;
    }

    if (first_arg == "--summary" && argc > 2) {
        try {
            const auto decoder_profiles = load_optional_decoder_profile_registry(argc, argv, 3);
            const auto summary = decoder_profiles.has_value()
                ? rofl::core::parse_replay_file(argv[2], *decoder_profiles)
                : rofl::core::parse_replay_file(argv[2]);
            std::cout << rofl::core::replay_summary_to_json(summary) << '\n';
            return 0;
        } catch (const std::exception& exception) {
            std::cerr << exception.what() << '\n';
            return 1;
        }
    }

    if (first_arg == "--probe" && argc > 2) {
        try {
            std::cout << rofl::core::probe_replay_file(argv[2]);
            return 0;
        } catch (const std::exception& exception) {
            std::cerr << exception.what() << '\n';
            return 1;
        }
    }

    if (first_arg == "--inspect" && argc > 2) {
        try {
            std::cout << rofl::core::inspect_replay_file(argv[2]);
            return 0;
        } catch (const std::exception& exception) {
            std::cerr << exception.what() << '\n';
            return 1;
        }
    }

    if (first_arg == "--validate-packet-framing" && argc > 2) {
        try {
            std::string path = argv[2];
            std::string segment_type = "all";
            for (int i = 3; i < argc; ++i) {
                const std::string_view arg = argv[i];
                if ((arg == "--segment-type" || arg == "--record-type") && i + 1 < argc) {
                    segment_type = argv[++i];
                }
            }
            std::cout << rofl::core::validate_packet_framing_file_json(path, segment_type);
            return 0;
        } catch (const std::exception& exception) {
            std::cerr << exception.what() << '\n';
            return 1;
        }
    }

    if (first_arg == "--summarize-packet-types-json" && argc > 2) {
        try {
            std::string path = argv[2];
            std::string segment_type = "all";
            std::size_t top_types = 0;
            for (int i = 3; i < argc; ++i) {
                const std::string_view arg = argv[i];
                if ((arg == "--segment-type" || arg == "--record-type") && i + 1 < argc) {
                    segment_type = argv[++i];
                } else if (arg == "--top-types" && i + 1 < argc) {
                    top_types = std::stoull(argv[++i]);
                }
            }
            std::cout << rofl::core::summarize_packet_types_file_json(path, segment_type, top_types);
            return 0;
        } catch (const std::exception& exception) {
            std::cerr << exception.what() << '\n';
            return 1;
        }
    }

    if (first_arg == "--dump-packet-type-json" && argc > 2) {
        try {
            std::string path = argv[2];
            std::uint16_t packet_type = 0;
            bool packet_type_provided = false;
            std::string segment_type = "all";
            std::size_t max_blocks = 64;
            for (int i = 3; i < argc; ++i) {
                const std::string_view arg = argv[i];
                if (arg == "--packet-type" && i + 1 < argc) {
                    const unsigned long value = std::stoul(argv[++i], nullptr, 0);
                    if (value > 0xFFFFUL) {
                        throw std::out_of_range("Packet type must fit in an unsigned 16-bit integer");
                    }
                    packet_type = static_cast<std::uint16_t>(value);
                    packet_type_provided = true;
                } else if ((arg == "--segment-type" || arg == "--record-type") && i + 1 < argc) {
                    segment_type = argv[++i];
                } else if (arg == "--max-blocks" && i + 1 < argc) {
                    max_blocks = std::stoull(argv[++i]);
                }
            }
            if (!packet_type_provided) {
                std::cerr << "Missing --packet-type\n";
                return 1;
            }
            std::cout << rofl::core::dump_packet_type_file_json(path, packet_type, segment_type, max_blocks);
            return 0;
        } catch (const std::exception& exception) {
            std::cerr << exception.what() << '\n';
            return 1;
        }
    }

    if (first_arg == "--dump-packet-types-json" && argc > 2) {
        try {
            std::string path = argv[2];
            std::vector<std::uint16_t> packet_types;
            std::string segment_type = "all";
            std::size_t max_blocks = 64;
            for (int i = 3; i < argc; ++i) {
                const std::string_view arg = argv[i];
                if (arg == "--packet-type" && i + 1 < argc) {
                    const unsigned long value = std::stoul(argv[++i], nullptr, 0);
                    if (value > 0xFFFFUL) {
                        throw std::out_of_range("Packet type must fit in an unsigned 16-bit integer");
                    }
                    packet_types.push_back(static_cast<std::uint16_t>(value));
                } else if ((arg == "--segment-type" || arg == "--record-type") && i + 1 < argc) {
                    segment_type = argv[++i];
                } else if (arg == "--max-blocks" && i + 1 < argc) {
                    max_blocks = std::stoull(argv[++i]);
                } else {
                    throw std::invalid_argument(
                        "Unknown or incomplete --dump-packet-types-json option: " + std::string(arg));
                }
            }
            if (packet_types.empty()) {
                std::cerr << "Missing --packet-type\n";
                return 1;
            }
            std::cout << rofl::core::dump_packet_types_file_json(
                path, packet_types, segment_type, max_blocks);
            return 0;
        } catch (const std::exception& exception) {
            std::cerr << exception.what() << '\n';
            return 1;
        }
    }

    if (first_arg == "--extract-replay-kills-json" && argc > 2) {
        try {
            const auto decoder_profiles = load_optional_decoder_profile_registry(argc, argv, 3);
            std::cout << (decoder_profiles.has_value()
                ? rofl::core::extract_replay_kills_file_json(argv[2], *decoder_profiles)
                : rofl::core::extract_replay_kills_file_json(argv[2]));
            return 0;
        } catch (const std::exception& exception) {
            std::cerr << exception.what() << '\n';
            return 1;
        }
    }

    if (first_arg == "--extract-replay-objectives-json" && argc > 2) {
        try {
            const auto decoder_profiles = load_optional_decoder_profile_registry(argc, argv, 3);
            std::cout << (decoder_profiles.has_value()
                ? rofl::core::extract_replay_objectives_file_json(argv[2], *decoder_profiles)
                : rofl::core::extract_replay_objectives_file_json(argv[2]));
            return 0;
        } catch (const std::exception& exception) {
            std::cerr << exception.what() << '\n';
            return 1;
        }
    }

    if (first_arg == "--extract-replay-wards-json" && argc > 2) {
        try {
            const auto decoder_profiles = load_optional_decoder_profile_registry(argc, argv, 3);
            std::cout << (decoder_profiles.has_value()
                ? rofl::core::extract_replay_wards_file_json(argv[2], *decoder_profiles)
                : rofl::core::extract_replay_wards_file_json(argv[2]));
            return 0;
        } catch (const std::exception& exception) {
            std::cerr << exception.what() << '\n';
            return 1;
        }
    }

    if (first_arg == "--extract-replay-ward-position-candidates-json" &&
        argc > 2) {
        try {
            const auto decoder_profiles = load_optional_decoder_profile_registry(argc, argv, 3);
            std::cout << (decoder_profiles.has_value()
                ? rofl::core::extract_replay_ward_position_candidates_file_json(
                    argv[2],
                    *decoder_profiles
                )
                : rofl::core::extract_replay_ward_position_candidates_file_json(argv[2]));
            return 0;
        } catch (const std::exception& exception) {
            std::cerr << exception.what() << '\n';
            return 1;
        }
    }
    if (first_arg == "--summarize-subrecord-families" && argc > 2) {
        try {
            std::string path = argv[2];
            std::size_t minimum_length = 256;
            std::size_t minimum_records = 4;
            std::size_t top_families = 20;
            for (int i = 3; i < argc; ++i) {
                std::string_view arg = argv[i];
                if (arg == "--min-length" && i + 1 < argc) {
                    minimum_length = std::stoull(argv[++i]);
                } else if (arg == "--min-records" && i + 1 < argc) {
                    minimum_records = std::stoull(argv[++i]);
                } else if (arg == "--top-families" && i + 1 < argc) {
                    top_families = std::stoull(argv[++i]);
                }
            }
            std::cout << rofl::core::summarize_subrecord_families(path, minimum_length, minimum_records, top_families);
            return 0;
        } catch (const std::exception& exception) {
            std::cerr << exception.what() << '\n';
            return 1;
        }
    }

    if (first_arg == "--dump-subrecord-family" && argc > 2) {
        try {
            std::string path = argv[2];
            std::size_t length = 0;
            std::uint8_t first_byte = 0;
            for (int i = 3; i < argc; ++i) {
                std::string_view arg = argv[i];
                if (arg == "--length" && i + 1 < argc) {
                    length = std::stoull(argv[++i]);
                } else if (arg == "--first-byte" && i + 1 < argc) {
                    first_byte = static_cast<std::uint8_t>(std::stoul(argv[++i], nullptr, 0));
                }
            }
            std::cout << rofl::core::dump_subrecord_family(path, length, first_byte);
            return 0;
        } catch (const std::exception& exception) {
            std::cerr << exception.what() << '\n';
            return 1;
        }
    }

    if (first_arg == "--dump-subrecord-family-json" && argc > 2) {
        try {
            std::string path = argv[2];
            std::size_t length = 0;
            std::uint8_t first_byte = 0;
            std::string record_type = "chunk";
            std::size_t max_records = 16;
            for (int i = 3; i < argc; ++i) {
                std::string_view arg = argv[i];
                if (arg == "--length" && i + 1 < argc) {
                    length = std::stoull(argv[++i]);
                } else if (arg == "--first-byte" && i + 1 < argc) {
                    first_byte = static_cast<std::uint8_t>(std::stoul(argv[++i], nullptr, 0));
                } else if (arg == "--record-type" && i + 1 < argc) {
                    record_type = argv[++i];
                } else if (arg == "--max-records" && i + 1 < argc) {
                    max_records = std::stoull(argv[++i]);
                }
            }
            std::cout << rofl::core::dump_subrecord_family_json(path, length, first_byte, record_type, max_records);
            return 0;
        } catch (const std::exception& exception) {
            std::cerr << exception.what() << '\n';
            return 1;
        }
    }

    if (first_arg == "--compare-subrecord-family" && argc > 2) {
        try {
            std::string path = argv[2];
            std::size_t length = 0;
            std::uint8_t first_byte = 0;
            std::size_t prefix_bytes = 256;
            for (int i = 3; i < argc; ++i) {
                std::string_view arg = argv[i];
                if (arg == "--length" && i + 1 < argc) {
                    length = std::stoull(argv[++i]);
                } else if (arg == "--first-byte" && i + 1 < argc) {
                    first_byte = static_cast<std::uint8_t>(std::stoul(argv[++i], nullptr, 0));
                } else if (arg == "--prefix-bytes" && i + 1 < argc) {
                    prefix_bytes = std::stoull(argv[++i]);
                }
            }
            std::cout << rofl::core::compare_subrecord_family(path, length, first_byte, prefix_bytes);
            return 0;
        } catch (const std::exception& exception) {
            std::cerr << exception.what() << '\n';
            return 1;
        }
    }

    if (first_arg == "--analyze-sparse-family" && argc > 2) {
        try {
            std::string path = argv[2];
            std::size_t length = 0;
            std::uint8_t first_byte = 0;
            std::size_t header_size = 0;
            std::size_t stride = 16;
            std::size_t top_elements = 12;
            for (int i = 3; i < argc; ++i) {
                std::string_view arg = argv[i];
                if (arg == "--length" && i + 1 < argc) {
                    length = std::stoull(argv[++i]);
                } else if (arg == "--first-byte" && i + 1 < argc) {
                    first_byte = static_cast<std::uint8_t>(std::stoul(argv[++i], nullptr, 0));
                } else if (arg == "--header-size" && i + 1 < argc) {
                    header_size = std::stoull(argv[++i]);
                } else if (arg == "--stride" && i + 1 < argc) {
                    stride = std::stoull(argv[++i]);
                } else if (arg == "--top-elements" && i + 1 < argc) {
                    top_elements = std::stoull(argv[++i]);
                }
            }
            std::cout << rofl::core::analyze_sparse_family(path, length, first_byte, header_size, stride, top_elements);
            return 0;
        } catch (const std::exception& exception) {
            std::cerr << exception.what() << '\n';
            return 1;
        }
    }
    if (first_arg == "--scan-families-json" && argc > 2) {
        try {
            std::string path = argv[2];
            std::size_t minimum_length = 256;
            std::size_t minimum_records = 4;
            std::size_t top_families = 20;
            std::string record_type = "chunk";
            for (int i = 3; i < argc; ++i) {
                std::string_view arg = argv[i];
                if (arg == "--min-length" && i + 1 < argc) {
                    minimum_length = std::stoull(argv[++i]);
                } else if (arg == "--min-records" && i + 1 < argc) {
                    minimum_records = std::stoull(argv[++i]);
                } else if (arg == "--top-families" && i + 1 < argc) {
                    top_families = std::stoull(argv[++i]);
                } else if (arg == "--record-type" && i + 1 < argc) {
                    record_type = argv[++i];
                }
            }
            std::cout << rofl::core::scan_replay_families_file_json(path, minimum_length, minimum_records, top_families, record_type);
            return 0;
        } catch (const std::exception& exception) {
            std::cerr << exception.what() << '\n';
            return 1;
        }
    }

    if (first_arg == "--analyze-artifact-bundle-json" && argc > 2) {
        try {
            std::string path = argv[2];
            std::size_t minimum_length = 4096;
            std::size_t minimum_records = 4;
            std::size_t top_families = 8;
            std::size_t top_entity_slots = 24;
            std::size_t top_scalar_slots = 18;
            std::size_t dynamic_slot_count = 8;
            std::size_t mixed_slot_count = 2;
            std::size_t handle_slot_count = 0;
            std::size_t top_windows = 16;
            std::size_t top_fields = 16;
            bool skip_scalar = false;
            std::string record_type = "chunk";
            for (int i = 3; i < argc; ++i) {
                std::string_view arg = argv[i];
                if (arg == "--min-length" && i + 1 < argc) {
                    minimum_length = std::stoull(argv[++i]);
                } else if (arg == "--min-records" && i + 1 < argc) {
                    minimum_records = std::stoull(argv[++i]);
                } else if (arg == "--top-families" && i + 1 < argc) {
                    top_families = std::stoull(argv[++i]);
                } else if (arg == "--top-entity-slots" && i + 1 < argc) {
                    top_entity_slots = std::stoull(argv[++i]);
                } else if (arg == "--top-scalar-slots" && i + 1 < argc) {
                    top_scalar_slots = std::stoull(argv[++i]);
                } else if (arg == "--dynamic-slot-count" && i + 1 < argc) {
                    dynamic_slot_count = std::stoull(argv[++i]);
                } else if (arg == "--mixed-slot-count" && i + 1 < argc) {
                    mixed_slot_count = std::stoull(argv[++i]);
                } else if (arg == "--handle-slot-count" && i + 1 < argc) {
                    handle_slot_count = std::stoull(argv[++i]);
                } else if (arg == "--top-windows" && i + 1 < argc) {
                    top_windows = std::stoull(argv[++i]);
                } else if (arg == "--top-fields" && i + 1 < argc) {
                    top_fields = std::stoull(argv[++i]);
                } else if (arg == "--skip-scalar") {
                    skip_scalar = true;
                } else if (arg == "--record-type" && i + 1 < argc) {
                    record_type = argv[++i];
                }
            }
            std::cout << rofl::core::analyze_artifact_bundle_file_json(
                path,
                minimum_length,
                minimum_records,
                top_families,
                top_entity_slots,
                top_scalar_slots,
                dynamic_slot_count,
                mixed_slot_count,
                handle_slot_count,
                top_windows,
                top_fields,
                skip_scalar,
                record_type);
            return 0;
        } catch (const std::exception& exception) {
            std::cerr << exception.what() << '\n';
            return 1;
        }
    }

    if (first_arg == "--analyze-scalar-family-json" && argc > 2) {
        try {
            std::string path = argv[2];
            std::size_t length = 0;
            std::uint8_t first_byte = 0;
            std::size_t header_size = 0;
            std::size_t stride = 16;
            std::size_t top_slots = 24;
            std::string record_type = "chunk";
            for (int i = 3; i < argc; ++i) {
                std::string_view arg = argv[i];
                if (arg == "--length" && i + 1 < argc) {
                    length = std::stoull(argv[++i]);
                } else if (arg == "--first-byte" && i + 1 < argc) {
                    first_byte = static_cast<std::uint8_t>(std::stoul(argv[++i], nullptr, 0));
                } else if (arg == "--header-size" && i + 1 < argc) {
                    header_size = std::stoull(argv[++i]);
                } else if (arg == "--stride" && i + 1 < argc) {
                    stride = std::stoull(argv[++i]);
                } else if (arg == "--top-slots" && i + 1 < argc) {
                    top_slots = std::stoull(argv[++i]);
                } else if (arg == "--record-type" && i + 1 < argc) {
                    record_type = argv[++i];
                }
            }
            std::cout << rofl::core::analyze_scalar_family_file_json(path, length, first_byte, header_size, stride, top_slots, record_type);
            return 0;
        } catch (const std::exception& exception) {
            std::cerr << exception.what() << '\n';
            return 1;
        }
    }

    if (first_arg == "--analyze-row-offsets-json" && argc > 2) {
        try {
            std::string path = argv[2];
            std::size_t length = 0;
            std::uint8_t first_byte = 0;
            std::size_t header_size = 0;
            std::size_t stride = 16;
            std::size_t top_fields = 24;
            std::size_t min_active_samples = 4;
            std::string record_type = "chunk";
            std::vector<std::size_t> slot_indices;
            for (int i = 3; i < argc; ++i) {
                std::string_view arg = argv[i];
                if (arg == "--length" && i + 1 < argc) {
                    length = std::stoull(argv[++i]);
                } else if (arg == "--first-byte" && i + 1 < argc) {
                    first_byte = static_cast<std::uint8_t>(std::stoul(argv[++i], nullptr, 0));
                } else if (arg == "--header-size" && i + 1 < argc) {
                    header_size = std::stoull(argv[++i]);
                } else if (arg == "--stride" && i + 1 < argc) {
                    stride = std::stoull(argv[++i]);
                } else if (arg == "--top-fields" && i + 1 < argc) {
                    top_fields = std::stoull(argv[++i]);
                } else if (arg == "--min-active-samples" && i + 1 < argc) {
                    min_active_samples = std::stoull(argv[++i]);
                } else if (arg == "--record-type" && i + 1 < argc) {
                    record_type = argv[++i];
                } else if (arg == "--slots" && i + 1 < argc) {
                    std::stringstream slot_stream(argv[++i]);
                    std::string token;
                    while (std::getline(slot_stream, token, ',')) {
                        if (!token.empty()) {
                            slot_indices.push_back(std::stoull(token));
                        }
                    }
                }
            }
            std::cout << rofl::core::analyze_row_offsets_file_json(path, length, first_byte, header_size, stride, slot_indices, top_fields, record_type, min_active_samples);
            return 0;
        } catch (const std::exception& exception) {
            std::cerr << exception.what() << '\n';
            return 1;
        }
    }

    if (first_arg == "--analyze-clean-row-offsets-json" && argc > 2) {
        try {
            std::string path = argv[2];
            std::size_t length = 0;
            std::uint8_t first_byte = 0;
            std::size_t header_size = 0;
            std::size_t stride = 16;
            std::size_t top_fields = 24;
            std::size_t min_active_samples = 4;
            std::string record_type = "chunk";
            std::vector<std::size_t> slot_indices;
            for (int i = 3; i < argc; ++i) {
                std::string_view arg = argv[i];
                if (arg == "--length" && i + 1 < argc) {
                    length = std::stoull(argv[++i]);
                } else if (arg == "--first-byte" && i + 1 < argc) {
                    first_byte = static_cast<std::uint8_t>(std::stoul(argv[++i], nullptr, 0));
                } else if (arg == "--header-size" && i + 1 < argc) {
                    header_size = std::stoull(argv[++i]);
                } else if (arg == "--stride" && i + 1 < argc) {
                    stride = std::stoull(argv[++i]);
                } else if (arg == "--top-fields" && i + 1 < argc) {
                    top_fields = std::stoull(argv[++i]);
                } else if (arg == "--min-active-samples" && i + 1 < argc) {
                    min_active_samples = std::stoull(argv[++i]);
                } else if (arg == "--record-type" && i + 1 < argc) {
                    record_type = argv[++i];
                } else if (arg == "--slots" && i + 1 < argc) {
                    std::stringstream slot_stream(argv[++i]);
                    std::string token;
                    while (std::getline(slot_stream, token, ',')) {
                        if (!token.empty()) {
                            slot_indices.push_back(std::stoull(token));
                        }
                    }
                }
            }
            std::cout << rofl::core::analyze_clean_row_offsets_file_json(path, length, first_byte, header_size, stride, slot_indices, top_fields, record_type, min_active_samples);
            return 0;
        } catch (const std::exception& exception) {
            std::cerr << exception.what() << '\n';
            return 1;
        }
    }

    if (first_arg == "--analyze-handle-links-json" && argc > 2) {
        try {
            std::string path = argv[2];
            std::size_t length = 0;
            std::uint8_t first_byte = 0;
            std::size_t header_size = 0;
            std::size_t stride = 16;
            std::size_t top_links = 24;
            std::size_t top_families = 16;
            std::string record_type = "chunk";
            std::vector<std::size_t> slot_indices;
            for (int i = 3; i < argc; ++i) {
                std::string_view arg = argv[i];
                if (arg == "--length" && i + 1 < argc) {
                    length = std::stoull(argv[++i]);
                } else if (arg == "--first-byte" && i + 1 < argc) {
                    first_byte = static_cast<std::uint8_t>(std::stoul(argv[++i], nullptr, 0));
                } else if (arg == "--header-size" && i + 1 < argc) {
                    header_size = std::stoull(argv[++i]);
                } else if (arg == "--stride" && i + 1 < argc) {
                    stride = std::stoull(argv[++i]);
                } else if (arg == "--top-links" && i + 1 < argc) {
                    top_links = std::stoull(argv[++i]);
                } else if (arg == "--top-families" && i + 1 < argc) {
                    top_families = std::stoull(argv[++i]);
                } else if (arg == "--record-type" && i + 1 < argc) {
                    record_type = argv[++i];
                } else if (arg == "--slots" && i + 1 < argc) {
                    std::stringstream slot_stream(argv[++i]);
                    std::string token;
                    while (std::getline(slot_stream, token, ',')) {
                        if (!token.empty()) {
                            slot_indices.push_back(std::stoull(token));
                        }
                    }
                }
            }
            std::cout << rofl::core::analyze_handle_links_file_json(path, length, first_byte, header_size, stride, slot_indices, top_links, top_families, record_type);
            return 0;
        } catch (const std::exception& exception) {
            std::cerr << exception.what() << '\n';
            return 1;
        }
    }

    if (first_arg == "--analyze-token-bitfields-json" && argc > 2) {
        try {
            std::string path = argv[2];
            std::size_t length = 0;
            std::uint8_t first_byte = 0;
            std::size_t header_size = 0;
            std::size_t stride = 16;
            std::size_t top_slices = 24;
            std::size_t top_families = 16;
            std::string record_type = "chunk";
            std::vector<std::size_t> slot_indices;
            for (int i = 3; i < argc; ++i) {
                std::string_view arg = argv[i];
                if (arg == "--length" && i + 1 < argc) {
                    length = std::stoull(argv[++i]);
                } else if (arg == "--first-byte" && i + 1 < argc) {
                    first_byte = static_cast<std::uint8_t>(std::stoul(argv[++i], nullptr, 0));
                } else if (arg == "--header-size" && i + 1 < argc) {
                    header_size = std::stoull(argv[++i]);
                } else if (arg == "--stride" && i + 1 < argc) {
                    stride = std::stoull(argv[++i]);
                } else if (arg == "--top-slices" && i + 1 < argc) {
                    top_slices = std::stoull(argv[++i]);
                } else if (arg == "--top-families" && i + 1 < argc) {
                    top_families = std::stoull(argv[++i]);
                } else if (arg == "--record-type" && i + 1 < argc) {
                    record_type = argv[++i];
                } else if (arg == "--slots" && i + 1 < argc) {
                    std::stringstream slot_stream(argv[++i]);
                    std::string token;
                    while (std::getline(slot_stream, token, ',')) {
                        if (!token.empty()) {
                            slot_indices.push_back(std::stoull(token));
                        }
                    }
                }
            }
            std::cout << rofl::core::analyze_token_bitfields_file_json(path, length, first_byte, header_size, stride, slot_indices, top_slices, top_families, record_type);
            return 0;
        } catch (const std::exception& exception) {
            std::cerr << exception.what() << '\n';
            return 1;
        }
    }

    if (first_arg == "--analyze-table-descriptors-json" && argc > 2) {
        try {
            std::string path = argv[2];
            std::size_t length = 0;
            std::uint8_t first_byte = 0;
            std::size_t header_size = 0;
            std::size_t stride = 16;
            std::size_t top_matches = 32;
            std::string record_type = "chunk";
            std::vector<std::size_t> slot_indices;
            for (int i = 3; i < argc; ++i) {
                std::string_view arg = argv[i];
                if (arg == "--length" && i + 1 < argc) {
                    length = std::stoull(argv[++i]);
                } else if (arg == "--first-byte" && i + 1 < argc) {
                    first_byte = static_cast<std::uint8_t>(std::stoul(argv[++i], nullptr, 0));
                } else if (arg == "--header-size" && i + 1 < argc) {
                    header_size = std::stoull(argv[++i]);
                } else if (arg == "--stride" && i + 1 < argc) {
                    stride = std::stoull(argv[++i]);
                } else if (arg == "--top-matches" && i + 1 < argc) {
                    top_matches = std::stoull(argv[++i]);
                } else if (arg == "--record-type" && i + 1 < argc) {
                    record_type = argv[++i];
                } else if (arg == "--slots" && i + 1 < argc) {
                    std::stringstream slot_stream(argv[++i]);
                    std::string token;
                    while (std::getline(slot_stream, token, ',')) {
                        if (!token.empty()) {
                            slot_indices.push_back(std::stoull(token));
                        }
                    }
                }
            }
            std::cout << rofl::core::analyze_table_descriptors_file_json(path, length, first_byte, header_size, stride, slot_indices, top_matches, record_type);
            return 0;
        } catch (const std::exception& exception) {
            std::cerr << exception.what() << '\n';
            return 1;
        }
    }

    if (first_arg == "--analyze-bitfield-schema-json" && argc > 2) {
        try {
            std::string path = argv[2];
            std::size_t length = 0;
            std::uint8_t first_byte = 0;
            std::size_t header_size = 0;
            std::size_t stride = 16;
            std::size_t top_windows = 32;
            std::string record_type = "chunk";
            std::vector<std::size_t> slot_indices;
            for (int i = 3; i < argc; ++i) {
                std::string_view arg = argv[i];
                if (arg == "--length" && i + 1 < argc) {
                    length = std::stoull(argv[++i]);
                } else if (arg == "--first-byte" && i + 1 < argc) {
                    first_byte = static_cast<std::uint8_t>(std::stoul(argv[++i], nullptr, 0));
                } else if (arg == "--header-size" && i + 1 < argc) {
                    header_size = std::stoull(argv[++i]);
                } else if (arg == "--stride" && i + 1 < argc) {
                    stride = std::stoull(argv[++i]);
                } else if (arg == "--top-windows" && i + 1 < argc) {
                    top_windows = std::stoull(argv[++i]);
                } else if (arg == "--record-type" && i + 1 < argc) {
                    record_type = argv[++i];
                } else if (arg == "--slots" && i + 1 < argc) {
                    std::stringstream slot_stream(argv[++i]);
                    std::string token;
                    while (std::getline(slot_stream, token, ',')) {
                        if (!token.empty()) {
                            slot_indices.push_back(std::stoull(token));
                        }
                    }
                }
            }
            std::cout << rofl::core::analyze_bitfield_schema_file_json(path, length, first_byte, header_size, stride, slot_indices, top_windows, record_type);
            return 0;
        } catch (const std::exception& exception) {
            std::cerr << exception.what() << '\n';
            return 1;
        }
    }

    if (first_arg == "--analyze-entity-slab-json" && argc > 2) {
        try {
            std::string path = argv[2];
            std::size_t length = 0;
            std::uint8_t first_byte = 0;
            std::size_t header_size = 0;
            std::size_t stride = 16;
            std::size_t top_slots = 24;
            std::string record_type = "chunk";
            for (int i = 3; i < argc; ++i) {
                std::string_view arg = argv[i];
                if (arg == "--length" && i + 1 < argc) {
                    length = std::stoull(argv[++i]);
                } else if (arg == "--first-byte" && i + 1 < argc) {
                    first_byte = static_cast<std::uint8_t>(std::stoul(argv[++i], nullptr, 0));
                } else if (arg == "--header-size" && i + 1 < argc) {
                    header_size = std::stoull(argv[++i]);
                } else if (arg == "--stride" && i + 1 < argc) {
                    stride = std::stoull(argv[++i]);
                } else if (arg == "--top-slots" && i + 1 < argc) {
                    top_slots = std::stoull(argv[++i]);
                } else if (arg == "--record-type" && i + 1 < argc) {
                    record_type = argv[++i];
                }
            }
            std::cout << rofl::core::analyze_entity_slab_file_json(path, length, first_byte, header_size, stride, top_slots, record_type);
            return 0;
        } catch (const std::exception& exception) {
            std::cerr << exception.what() << '\n';
            return 1;
        }
    }

    if (first_arg == "--trace-sparse-slot" && argc > 2) {
        try {
            std::string path = argv[2];
            std::size_t length = 0;
            std::uint8_t first_byte = 0;
            std::size_t header_size = 0;
            std::size_t stride = 16;
            std::size_t slot_index = 0;
            std::size_t max_records = 24;
            for (int i = 3; i < argc; ++i) {
                std::string_view arg = argv[i];
                if (arg == "--length" && i + 1 < argc) {
                    length = std::stoull(argv[++i]);
                } else if (arg == "--first-byte" && i + 1 < argc) {
                    first_byte = static_cast<std::uint8_t>(std::stoul(argv[++i], nullptr, 0));
                } else if (arg == "--header-size" && i + 1 < argc) {
                    header_size = std::stoull(argv[++i]);
                } else if (arg == "--stride" && i + 1 < argc) {
                    stride = std::stoull(argv[++i]);
                } else if (arg == "--slot-index" && i + 1 < argc) {
                    slot_index = std::stoull(argv[++i]);
                } else if (arg == "--max-records" && i + 1 < argc) {
                    max_records = std::stoull(argv[++i]);
                }
            }
            std::cout << rofl::core::trace_sparse_slot(path, length, first_byte, header_size, stride, slot_index, max_records);
            return 0;
        } catch (const std::exception& exception) {
            std::cerr << exception.what() << '\n';
            return 1;
        }
    }
    if (first_arg == "--profile-position-slots" && argc > 2) {
        try {
            std::string path = argv[2];
            std::size_t length = 0;
            std::uint8_t first_byte = 0;
            std::size_t header_size = 0;
            std::size_t stride = 16;
            std::size_t top_slots = 20;
            float move_epsilon = 25.0F;
            float smooth_threshold = 1200.0F;
            for (int i = 3; i < argc; ++i) {
                std::string_view arg = argv[i];
                if (arg == "--length" && i + 1 < argc) {
                    length = std::stoull(argv[++i]);
                } else if (arg == "--first-byte" && i + 1 < argc) {
                    first_byte = static_cast<std::uint8_t>(std::stoul(argv[++i], nullptr, 0));
                } else if (arg == "--header-size" && i + 1 < argc) {
                    header_size = std::stoull(argv[++i]);
                } else if (arg == "--stride" && i + 1 < argc) {
                    stride = std::stoull(argv[++i]);
                } else if (arg == "--top-slots" && i + 1 < argc) {
                    top_slots = std::stoull(argv[++i]);
                } else if (arg == "--move-epsilon" && i + 1 < argc) {
                    move_epsilon = std::stof(argv[++i]);
                } else if (arg == "--smooth-threshold" && i + 1 < argc) {
                    smooth_threshold = std::stof(argv[++i]);
                }
            }
            std::cout << rofl::core::profile_position_slots(path, length, first_byte, header_size, stride, top_slots, move_epsilon, smooth_threshold);
            return 0;
        } catch (const std::exception& exception) {
            std::cerr << exception.what() << '\n';
            return 1;
        }
    }
    if (first_arg == "--compare-position-classes" && argc > 2) {
        try {
            std::string path = argv[2];
            std::size_t length = 0;
            std::uint8_t first_byte = 0;
            std::size_t header_size = 0;
            std::size_t stride = 16;
            std::size_t top_slots = 120;
            std::size_t top_classes = 12;
            float move_epsilon = 25.0F;
            float smooth_threshold = 1200.0F;
            for (int i = 3; i < argc; ++i) {
                std::string_view arg = argv[i];
                if (arg == "--length" && i + 1 < argc) {
                    length = std::stoull(argv[++i]);
                } else if (arg == "--first-byte" && i + 1 < argc) {
                    first_byte = static_cast<std::uint8_t>(std::stoul(argv[++i], nullptr, 0));
                } else if (arg == "--header-size" && i + 1 < argc) {
                    header_size = std::stoull(argv[++i]);
                } else if (arg == "--stride" && i + 1 < argc) {
                    stride = std::stoull(argv[++i]);
                } else if (arg == "--top-slots" && i + 1 < argc) {
                    top_slots = std::stoull(argv[++i]);
                } else if (arg == "--top-classes" && i + 1 < argc) {
                    top_classes = std::stoull(argv[++i]);
                } else if (arg == "--move-epsilon" && i + 1 < argc) {
                    move_epsilon = std::stof(argv[++i]);
                } else if (arg == "--smooth-threshold" && i + 1 < argc) {
                    smooth_threshold = std::stof(argv[++i]);
                }
            }
            std::cout << rofl::core::compare_position_classes(path, length, first_byte, header_size, stride, top_slots, top_classes, move_epsilon, smooth_threshold);
            return 0;
        } catch (const std::exception& exception) {
            std::cerr << exception.what() << '\n';
            return 1;
        }
    }
    if (first_arg == "--guess-stride" && argc > 2) {
        try {
            std::string path = argv[2];
            std::size_t length = 0;
            std::uint8_t first_byte = 0;
            std::size_t header_size = 0;
            for (int i = 3; i < argc; ++i) {
                std::string_view arg = argv[i];
                if (arg == "--length" && i + 1 < argc) {
                    length = std::stoull(argv[++i]);
                } else if (arg == "--first-byte" && i + 1 < argc) {
                    first_byte = static_cast<std::uint8_t>(std::stoul(argv[++i], nullptr, 0));
                } else if (arg == "--header-size" && i + 1 < argc) {
                    header_size = std::stoull(argv[++i]);
                }
            }
            std::cout << rofl::core::guess_stride(path, length, first_byte, header_size);
            return 0;
        } catch (const std::exception& exception) {
            std::cerr << exception.what() << '\n';
            return 1;
        }
    }

    if (first_arg == "--export-positions-json" && argc > 2) {
        try {
            std::string path = argv[2];
            std::size_t length = 0;
            std::uint8_t first_byte = 0;
            std::size_t header_size = 0;
            std::size_t stride = 16;
            std::vector<std::size_t> slots;
            for (int i = 3; i < argc; ++i) {
                std::string_view arg = argv[i];
                if (arg == "--length" && i + 1 < argc) {
                    length = std::stoull(argv[++i]);
                } else if (arg == "--first-byte" && i + 1 < argc) {
                    first_byte = static_cast<std::uint8_t>(std::stoul(argv[++i], nullptr, 0));
                } else if (arg == "--header-size" && i + 1 < argc) {
                    header_size = std::stoull(argv[++i]);
                } else if (arg == "--stride" && i + 1 < argc) {
                    stride = std::stoull(argv[++i]);
                } else if (arg == "--slots" && i + 1 < argc) {
                    std::string slots_str = argv[++i];
                    std::stringstream ss(slots_str);
                    std::string item;
                    while (std::getline(ss, item, ',')) {
                        slots.push_back(std::stoull(item));
                    }
                }
            }
            std::cout << rofl::core::export_positions_json(path, length, first_byte, header_size, stride, slots);
            return 0;
        } catch (const std::exception& exception) {
            std::cerr << exception.what() << '\n';
            return 1;
        }
    }

    if (first_arg == "--export-keyframe-state-candidates-json" && argc > 2) {
        try {
            std::string path = argv[2];
            std::cout << rofl::core::export_keyframe_state_candidates_json(path);
            return 0;
        } catch (const std::exception& exception) {
            std::cerr << exception.what() << '\n';
            return 1;
        }
    }

    if (first_arg == "--scan-keyframe-handle-graph-json" && argc > 2) {
        try {
            std::string path = argv[2];
            std::size_t minimum_length = 4096;
            std::size_t top_families = 32;
            std::size_t max_records = 0;
            std::string focus_family_key;
            std::vector<std::size_t> focus_slots;
            std::size_t focus_neighbor_radius = 0;
            for (int i = 3; i < argc; ++i) {
                std::string_view arg = argv[i];
                if (arg == "--min-length" && i + 1 < argc) {
                    minimum_length = std::stoull(argv[++i]);
                } else if (arg == "--top-families" && i + 1 < argc) {
                    top_families = std::stoull(argv[++i]);
                } else if (arg == "--max-records" && i + 1 < argc) {
                    max_records = std::stoull(argv[++i]);
                } else if (arg == "--focus-family" && i + 1 < argc) {
                    focus_family_key = argv[++i];
                } else if (arg == "--focus-slots" && i + 1 < argc) {
                    std::stringstream slot_stream(argv[++i]);
                    std::string item;
                    while (std::getline(slot_stream, item, ',')) {
                        if (!item.empty()) {
                            focus_slots.push_back(std::stoull(item));
                        }
                    }
                } else if (arg == "--focus-neighbor-radius" && i + 1 < argc) {
                    focus_neighbor_radius = std::stoull(argv[++i]);
                }
            }
            std::cout << rofl::core::scan_keyframe_handle_graph_json(
                path,
                minimum_length,
                top_families,
                max_records,
                focus_family_key,
                focus_slots,
                focus_neighbor_radius
            );
            return 0;
        } catch (const std::exception& exception) {
            std::cerr << exception.what() << '\n';
            return 1;
        }
    }

    if (first_arg == "--match-event-window" && argc > 2) {
        try {
            std::string replay_path = argv[2];
            std::size_t length = 0;
            std::uint8_t first_byte = 0;
            std::size_t header_size = 0;
            std::size_t stride = 16;
            double event_x = 0.0;
            double event_y = 0.0;
            int timestamp_millis = 0;
            int chunk_time_millis = 30000;
            int chunk_base_id = -1;
            int chunk_radius = 1;
            std::size_t top_slots = 40;
            float move_epsilon = 25.0F;
            float smooth_threshold = 1200.0F;
            for (int i = 3; i < argc; ++i) {
                std::string_view arg = argv[i];
                if (arg == "--length" && i + 1 < argc) {
                    length = std::stoull(argv[++i]);
                } else if (arg == "--first-byte" && i + 1 < argc) {
                    first_byte = static_cast<std::uint8_t>(std::stoul(argv[++i], nullptr, 0));
                } else if (arg == "--header-size" && i + 1 < argc) {
                    header_size = std::stoull(argv[++i]);
                } else if (arg == "--stride" && i + 1 < argc) {
                    stride = std::stoull(argv[++i]);
                } else if (arg == "--event-x" && i + 1 < argc) {
                    event_x = std::stod(argv[++i]);
                } else if (arg == "--event-y" && i + 1 < argc) {
                    event_y = std::stod(argv[++i]);
                } else if (arg == "--timestamp-ms" && i + 1 < argc) {
                    timestamp_millis = std::stoi(argv[++i]);
                } else if (arg == "--chunk-time-ms" && i + 1 < argc) {
                    chunk_time_millis = std::stoi(argv[++i]);
                } else if (arg == "--chunk-base-id" && i + 1 < argc) {
                    chunk_base_id = std::stoi(argv[++i]);
                } else if (arg == "--chunk-radius" && i + 1 < argc) {
                    chunk_radius = std::stoi(argv[++i]);
                } else if (arg == "--top-slots" && i + 1 < argc) {
                    top_slots = std::stoull(argv[++i]);
                } else if (arg == "--move-epsilon" && i + 1 < argc) {
                    move_epsilon = std::stof(argv[++i]);
                } else if (arg == "--smooth-threshold" && i + 1 < argc) {
                    smooth_threshold = std::stof(argv[++i]);
                }
            }
            std::cout << rofl::core::match_event_window(
                replay_path,
                length,
                first_byte,
                header_size,
                stride,
                event_x,
                event_y,
                timestamp_millis,
                chunk_time_millis,
                chunk_base_id,
                chunk_radius,
                top_slots,
                move_epsilon,
                smooth_threshold);
            return 0;
        } catch (const std::exception& exception) {
            std::cerr << exception.what() << '\n';
            return 1;
        }
    }

    if (first_arg == "--compare-raw-positions-with-api" && argc > 3) {
        try {
            std::string replay_path = argv[2];
            std::string api_positions_path = argv[3];
            std::size_t length = 0;
            std::uint8_t first_byte = 0;
            std::size_t header_size = 0;
            std::size_t stride = 16;
            std::size_t top_slots = 120;
            float move_epsilon = 25.0F;
            float smooth_threshold = 1200.0F;
            int chunk_time_millis = 30000;
            int chunk_base_id = -1;
            int max_time_offsets = 5;
            for (int i = 4; i < argc; ++i) {
                std::string_view arg = argv[i];
                if (arg == "--length" && i + 1 < argc) {
                    length = std::stoull(argv[++i]);
                } else if (arg == "--first-byte" && i + 1 < argc) {
                    first_byte = static_cast<std::uint8_t>(std::stoul(argv[++i], nullptr, 0));
                } else if (arg == "--header-size" && i + 1 < argc) {
                    header_size = std::stoull(argv[++i]);
                } else if (arg == "--stride" && i + 1 < argc) {
                    stride = std::stoull(argv[++i]);
                } else if (arg == "--top-slots" && i + 1 < argc) {
                    top_slots = std::stoull(argv[++i]);
                } else if (arg == "--move-epsilon" && i + 1 < argc) {
                    move_epsilon = std::stof(argv[++i]);
                } else if (arg == "--smooth-threshold" && i + 1 < argc) {
                    smooth_threshold = std::stof(argv[++i]);
                } else if (arg == "--chunk-time-ms" && i + 1 < argc) {
                    chunk_time_millis = std::stoi(argv[++i]);
                } else if (arg == "--chunk-base-id" && i + 1 < argc) {
                    chunk_base_id = std::stoi(argv[++i]);
                } else if (arg == "--max-time-offsets" && i + 1 < argc) {
                    max_time_offsets = std::stoi(argv[++i]);
                }
            }
            std::cout << rofl::core::compare_raw_positions_with_api(
                replay_path,
                api_positions_path,
                length,
                first_byte,
                header_size,
                stride,
                top_slots,
                move_epsilon,
                smooth_threshold,
                chunk_time_millis,
                chunk_base_id,
                max_time_offsets);
            return 0;
        } catch (const std::exception& exception) {
            std::cerr << exception.what() << '\n';
            return 1;
        }
    }
    if (first_arg == "--compare-positions-with-api" && argc > 3) {
        try {
            std::string replay_path = argv[2];
            std::string api_positions_path = argv[3];
            std::size_t length = 0;
            std::uint8_t first_byte = 0;
            std::size_t header_size = 0;
            std::size_t stride = 16;
            std::size_t top_slots = 120;
            float move_epsilon = 25.0F;
            float smooth_threshold = 1200.0F;
            int chunk_time_millis = 30000;
            int chunk_base_id = -1;
            int max_time_offsets = 5;
            for (int i = 4; i < argc; ++i) {
                std::string_view arg = argv[i];
                if (arg == "--length" && i + 1 < argc) {
                    length = std::stoull(argv[++i]);
                } else if (arg == "--first-byte" && i + 1 < argc) {
                    first_byte = static_cast<std::uint8_t>(std::stoul(argv[++i], nullptr, 0));
                } else if (arg == "--header-size" && i + 1 < argc) {
                    header_size = std::stoull(argv[++i]);
                } else if (arg == "--stride" && i + 1 < argc) {
                    stride = std::stoull(argv[++i]);
                } else if (arg == "--top-slots" && i + 1 < argc) {
                    top_slots = std::stoull(argv[++i]);
                } else if (arg == "--move-epsilon" && i + 1 < argc) {
                    move_epsilon = std::stof(argv[++i]);
                } else if (arg == "--smooth-threshold" && i + 1 < argc) {
                    smooth_threshold = std::stof(argv[++i]);
                } else if (arg == "--chunk-time-ms" && i + 1 < argc) {
                    chunk_time_millis = std::stoi(argv[++i]);
                } else if (arg == "--chunk-base-id" && i + 1 < argc) {
                    chunk_base_id = std::stoi(argv[++i]);
                } else if (arg == "--max-time-offsets" && i + 1 < argc) {
                    max_time_offsets = std::stoi(argv[++i]);
                }
            }
            std::cout << rofl::core::compare_positions_with_api(
                replay_path,
                api_positions_path,
                length,
                first_byte,
                header_size,
                stride,
                top_slots,
                move_epsilon,
                smooth_threshold,
                chunk_time_millis,
                chunk_base_id,
                max_time_offsets
            );
            return 0;
        } catch (const std::exception& exception) {
            std::cerr << exception.what() << '\n';
            return 1;
        }
    }

    if (first_arg == "--dump-chunk-subrecords" && argc > 2) {
        try {
            std::string path = argv[2];
            int chunk_id = -1;
            for (int i = 3; i < argc; ++i) {
                std::string_view arg = argv[i];
                if (arg == "--chunk-id" && i + 1 < argc) {
                    chunk_id = std::stoi(argv[++i]);
                }
            }
            if (chunk_id == -1) {
                std::cerr << "Missing --chunk-id\n";
                return 1;
            }
            std::cout << rofl::core::dump_chunk_subrecords(path, chunk_id);
            return 0;
        } catch (const std::exception& exception) {
            std::cerr << exception.what() << '\n';
            return 1;
        }
    }

    std::cout << "rofl_core_cli scaffold\n";
    std::cout << "Use --version for build metadata.\n";
    std::cout << "Use --summary <path-to-rofl> [--decoder-profiles <json-path>] to print a parsed replay summary.\n";
    std::cout << "Use --probe <path-to-rofl> to inspect likely payload/index regions.\n";
    std::cout << "Use --inspect <path-to-rofl> to inspect decompressed footer-style payload records.\n";
    std::cout << "Use --validate-packet-framing <path-to-rofl> [--segment-type startup|keyframe|chunk|all] to validate exact packet-block framing for every selected decompressed segment.\n";
    std::cout << "Use --summarize-packet-types-json <path-to-rofl> [--segment-type startup|keyframe|chunk|all] [--top-types <n>] to catalog packet types as JSON. A top-types value of 0 emits every group.\n";
    std::cout << "Use --dump-packet-type-json <path-to-rofl> --packet-type <u16> [--segment-type startup|keyframe|chunk|all] [--max-blocks <n>] to dump matching packet blocks as JSON. Decimal and 0x-prefixed packet types are accepted.\n";
    std::cout << "Use --dump-packet-types-json <path-to-rofl> --packet-type <u16> [--packet-type <u16> ...] [--segment-type startup|keyframe|chunk|all] [--max-blocks <n>] to dump multiple packet types from one replay parse. Limits apply per packet type.\n";
    std::cout << "Use --extract-replay-kills-json <path-to-rofl> [--decoder-profiles <json-path>] to emit ROFL-only normalized champion kill events with participant and packet provenance.\n";
    std::cout << "Use --extract-replay-objectives-json <path-to-rofl> [--decoder-profiles <json-path>] to emit ROFL-only elite-monster objective events with monster class and packet provenance.\n";
    std::cout << "Use --extract-replay-wards-json <path-to-rofl> [--decoder-profiles <json-path>] to emit ROFL-only standard ward placement and conservative ward-kill events with entity and participant provenance.\n";
    std::cout << "Use --extract-replay-ward-position-candidates-json <path-to-rofl> [--decoder-profiles <json-path>] to emit strictly research-only replay-byte ward marker hypotheses without promoting decoded positions.\n";
    std::cout << "Use --dump-chunk-subrecords <path-to-rofl> --chunk-id <id> to dump subrecords for a chunk.\n";
    std::cout << "Use --summarize-subrecord-families <path-to-rofl> [--min-length <n>] [--min-records <n>] [--top-families <n>] to rank recurring subrecord families across the replay.\n";
    std::cout << "Use --dump-subrecord-family <path-to-rofl> --length <len> --first-byte <byte> to dump matching records.\n";
    std::cout << "Use --dump-subrecord-family-json <path-to-rofl> --length <len> --first-byte <byte> [--record-type chunk|keyframe|startup|all] [--max-records <n>] to dump matching records as JSON with full payload hex.\n";
    std::cout << "Use --compare-subrecord-family <path-to-rofl> --length <len> --first-byte <byte> [--prefix-bytes <len>] to analyze stable fields.\n";
    std::cout << "Use --guess-stride <path-to-rofl> --length <len> --first-byte <byte> [--header-size <len>] to detect repeating patterns.\n";
    std::cout << "Use --analyze-sparse-family <path-to-rofl> --length <len> --first-byte <byte> --header-size <len> [--stride <len>] [--top-elements <n>] to profile 16-byte sparse records.\n";
    std::cout << "Use --scan-families-json <path-to-rofl> [--min-length <n>] [--min-records <n>] [--top-families <n>] [--record-type chunk|keyframe|startup|all] to emit recurring family scan results as JSON.\n";
    std::cout << "Use --analyze-artifact-bundle-json <path-to-rofl> [--min-length <n>] [--min-records <n>] [--top-families <n>] [--top-entity-slots <n>] [--top-scalar-slots <n>] [--dynamic-slot-count <n>] [--mixed-slot-count <n>] [--handle-slot-count <n>] [--top-windows <n>] [--top-fields <n>] [--skip-scalar] [--record-type chunk|keyframe|startup|all] to emit the full decoder artifact bundle as JSON in one process.\n";
    std::cout << "Use --analyze-scalar-family-json <path-to-rofl> --length <len> --first-byte <byte> --header-size <len> [--stride <len>] [--top-slots <n>] [--record-type chunk|keyframe|startup|all] to emit scalar lane candidates as JSON.\n";
    std::cout << "Use --analyze-entity-slab-json <path-to-rofl> --length <len> --first-byte <byte> --header-size <len> [--stride <len>] [--top-slots <n>] [--record-type chunk|keyframe|startup|all] to classify a sparse family into handle-like vs dynamic-state-like rows.\n";
    std::cout << "Use --analyze-row-offsets-json <path-to-rofl> --length <len> --first-byte <byte> --header-size <len> --slots <id1,id2,...> [--stride <len>] [--top-fields <n>] [--min-active-samples <n>] [--record-type chunk|keyframe|startup|all] to rank raw byte-offset fields inside selected sparse rows.\n";
    std::cout << "Use --analyze-clean-row-offsets-json <path-to-rofl> --length <len> --first-byte <byte> --header-size <len> --slots <id1,id2,...> [--stride <len>] [--top-fields <n>] [--min-active-samples <n>] [--record-type chunk|keyframe|startup|all] to mask descriptor/signature windows and rank cleaner offset candidates inside selected rows.\n";
    std::cout << "Use --analyze-handle-links-json <path-to-rofl> --length <len> --first-byte <byte> --header-size <len> --slots <id1,id2,...> [--stride <len>] [--top-links <n>] [--top-families <n>] [--record-type chunk|keyframe|startup|all] to test whether packed row tokens point into other recurring families.\n";
    std::cout << "Use --analyze-token-bitfields-json <path-to-rofl> --length <len> --first-byte <byte> --header-size <len> --slots <id1,id2,...> [--stride <len>] [--top-slices <n>] [--top-families <n>] [--record-type chunk|keyframe|startup|all] to search packed token bit slices for family-sized index fields.\n";
    std::cout << "Use --analyze-table-descriptors-json <path-to-rofl> --length <len> --first-byte <byte> --header-size <len> --slots <id1,id2,...> [--stride <len>] [--top-matches <n>] [--record-type chunk|keyframe|startup|all] to find exact 12-bit matches against known family element counts.\n";
    std::cout << "Use --analyze-bitfield-schema-json <path-to-rofl> --length <len> --first-byte <byte> --header-size <len> --slots <id1,id2,...> [--stride <len>] [--top-windows <n>] [--record-type chunk|keyframe|startup|all] to classify 32-bit token windows as descriptor-like via overlapping 12-bit family-count hits.\n";
    std::cout << "Use --trace-sparse-slot <path-to-rofl> --length <len> --first-byte <byte> --header-size <len> --slot-index <n> [--stride <len>] [--max-records <n>] to trace one sparse slot over time.\n";
    std::cout << "Use --profile-position-slots <path-to-rofl> --length <len> --first-byte <byte> --header-size <len> [--stride <len>] [--top-slots <n>] [--move-epsilon <f>] [--smooth-threshold <f>] to rank position-like sparse slots.\n";
    std::cout << "Use --compare-position-classes <path-to-rofl> --length <len> --first-byte <byte> --header-size <len> [--stride <len>] [--top-slots <n>] [--top-classes <n>] [--move-epsilon <f>] [--smooth-threshold <f>] to compare discovered slot classes against entity archetypes.\n";
    std::cout << "Use --export-positions-json <path-to-rofl> --length <len> --first-byte <byte> --header-size <len> --slots <id1,id2,...> [--stride <len>] to export sparse slot positions as JSON.\n";
    std::cout << "Use --export-keyframe-state-candidates-json <path-to-rofl> to export promoted keyframe state candidate fields as JSON. Participant identity is intentionally unassigned.\n";
    std::cout << "Use --scan-keyframe-handle-graph-json <path-to-rofl> [--min-length <n>] [--top-families <n>] [--max-records <n>] [--focus-family <key>] [--focus-slots <a,b,c>] [--focus-neighbor-radius <n>] to scan keyframe family headers and row-reference patterns.\n";
    std::cout << "Use --compare-positions-with-api <path-to-rofl> <path-to-api-positions-json> --length <len> --first-byte <byte> --header-size <len> [--stride <len>] [--top-slots <n>] [--move-epsilon <f>] [--smooth-threshold <f>] [--chunk-time-ms <ms>] [--chunk-base-id <id>] [--max-time-offsets <n>] to rank sparse slot tracks against Riot API positions.\n";
    std::cout << "Use --compare-raw-positions-with-api <path-to-rofl> <path-to-api-positions-json> --length <len> --first-byte <byte> --header-size <len> [--stride <len>] [--top-slots <n>] [--move-epsilon <f>] [--smooth-threshold <f>] [--chunk-time-ms <ms>] [--chunk-base-id <id>] [--max-time-offsets <n>] to rank raw per-record sparse samples against Riot API positions.\n";
    std::cout << "Use --match-event-window <path-to-rofl> --length <len> --first-byte <byte> --header-size <len> --event-x <x> --event-y <y> --timestamp-ms <ms> [--stride <len>] [--chunk-time-ms <ms>] [--chunk-base-id <id>] [--chunk-radius <n>] [--top-slots <n>] [--move-epsilon <f>] [--smooth-threshold <f>] to rank sparse slot samples near one known event location.\n";
    return 0;
}









