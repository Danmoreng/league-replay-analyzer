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

    std::cout << "rofl_core_cli scaffold\n";
    std::cout << "Use --version for build metadata.\n";
    std::cout << "Use --summary <path-to-rofl> to print a parsed replay summary.\n";
    std::cout << "Use --probe <path-to-rofl> to inspect likely payload/index regions.\n";
    std::cout << "Use --inspect <path-to-rofl> to inspect decompressed footer-style payload records.\n";
    return 0;
}


