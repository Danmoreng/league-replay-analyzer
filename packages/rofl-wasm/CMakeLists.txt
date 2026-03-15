cmake_minimum_required(VERSION 3.26)

if (NOT EMSCRIPTEN)
    message(FATAL_ERROR "packages/rofl-wasm requires the Emscripten toolchain.")
endif()

add_executable(rofl_wasm
    src/rofl_wasm.cpp
)

target_link_libraries(rofl_wasm PRIVATE rofl_core)

target_include_directories(rofl_wasm PRIVATE "${CMAKE_SOURCE_DIR}/packages/rofl-core/include")

target_link_options(rofl_wasm PRIVATE
    "-sEXPORTED_RUNTIME_METHODS=['ccall','cwrap']"
    "-sEXPORTED_FUNCTIONS=['_malloc','_free','_lra_parse_replay_buffer','_lra_free_string']"
    "-sALLOW_MEMORY_GROWTH=1"
    "-sMODULARIZE=1"
    "-sEXPORT_ES6=1"
    "-sENVIRONMENT=web,worker"
    "-sFILESYSTEM=0"
    "-o${CMAKE_CURRENT_BINARY_DIR}/rofl_wasm.js"
)
