add_library(rofl_core STATIC
    src/decoder_profiles.cpp
    src/packet_blocks.cpp
    src/replay_analyzer.cpp
)

target_include_directories(rofl_core
    PUBLIC
        "${CMAKE_CURRENT_SOURCE_DIR}/include"
)

target_compile_features(rofl_core PUBLIC cxx_std_20)

target_link_libraries(rofl_core PUBLIC libzstd_static)

add_executable(rofl_core_cli
    src/cli_main.cpp
)

target_link_libraries(rofl_core_cli PRIVATE rofl_core)

add_executable(rofl_core_tests
    tests/smoke_test.cpp
)

target_link_libraries(rofl_core_tests PRIVATE rofl_core)

add_executable(rofl_packet_blocks_tests
    tests/packet_blocks_test.cpp
)

target_link_libraries(rofl_packet_blocks_tests PRIVATE rofl_core)
add_dependencies(rofl_core_tests rofl_packet_blocks_tests)

add_test(NAME rofl_core_smoke COMMAND rofl_core_tests)
add_test(NAME rofl_packet_blocks COMMAND rofl_packet_blocks_tests)
