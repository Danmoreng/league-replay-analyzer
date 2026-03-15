#include <exception>
#include <iostream>
#include <string>
#include <string_view>

#include "rofl/core/replay_analyzer.hpp"

int main(int argc, char** argv) {
    const std::string_view first_arg = argc > 1 ? argv[1] : "";

    if (first_arg == "--version") {
        std::cout << rofl::core::describe_scaffold() << '\n';
        return 0;
    }

    if (first_arg == "--summary" && argc > 2) {
        try {
            const auto summary = rofl::core::parse_replay_file(argv[2]);
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
    std::cout << "Use --summary <path-to-rofl> to print a parsed replay summary.\n";
    std::cout << "Use --probe <path-to-rofl> to inspect likely payload/index regions.\n";
    std::cout << "Use --inspect <path-to-rofl> to inspect decompressed footer-style payload records.\n";
    std::cout << "Use --dump-chunk-subrecords <path-to-rofl> --chunk-id <id> to dump subrecords for a chunk.\n";
    std::cout << "Use --dump-subrecord-family <path-to-rofl> --length <len> --first-byte <byte> to dump matching records.\n";
    std::cout << "Use --compare-subrecord-family <path-to-rofl> --length <len> --first-byte <byte> [--prefix-bytes <len>] to analyze stable fields.\n";
    std::cout << "Use --guess-stride <path-to-rofl> --length <len> --first-byte <byte> [--header-size <len>] to detect repeating patterns.\n";
    std::cout << "Use --analyze-sparse-family <path-to-rofl> --length <len> --first-byte <byte> --header-size <len> [--stride <len>] [--top-elements <n>] to profile 16-byte sparse records.\n";
    std::cout << "Use --trace-sparse-slot <path-to-rofl> --length <len> --first-byte <byte> --header-size <len> --slot-index <n> [--stride <len>] [--max-records <n>] to trace one sparse slot over time.\n";
    std::cout << "Use --profile-position-slots <path-to-rofl> --length <len> --first-byte <byte> --header-size <len> [--stride <len>] [--top-slots <n>] [--move-epsilon <f>] [--smooth-threshold <f>] to rank position-like sparse slots.\n";
    std::cout << "Use --compare-position-classes <path-to-rofl> --length <len> --first-byte <byte> --header-size <len> [--stride <len>] [--top-slots <n>] [--top-classes <n>] [--move-epsilon <f>] [--smooth-threshold <f>] to compare discovered slot classes against entity archetypes.\n";
    return 0;
}







