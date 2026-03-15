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

    std::cout << "rofl_core_cli scaffold\n";
    std::cout << "Use --version for build metadata.\n";
    std::cout << "Use --summary <path-to-rofl> to print a parsed replay summary.\n";
    std::cout << "Use --probe <path-to-rofl> to inspect likely payload/index regions.\n";
    std::cout << "Use --inspect <path-to-rofl> to inspect decompressed footer-style payload records.\n";
    std::cout << "Use --dump-subrecord-family <path-to-rofl> --length <len> --first-byte <byte> to dump matching records.\n";
    std::cout << "Use --compare-subrecord-family <path-to-rofl> --length <len> --first-byte <byte> [--prefix-bytes <len>] to analyze stable fields.\n";
    std::cout << "Use --guess-stride <path-to-rofl> --length <len> --first-byte <byte> [--header-size <len>] to detect repeating patterns.\n";
    return 0;
}


