cmake_minimum_required(VERSION 3.26)

if (NOT EMSCRIPTEN)
    message(FATAL_ERROR "packages/rofl-wasm requires the Emscripten toolchain.")
endif()

add_executable(rofl_wasm
    src/rofl_wasm.cpp
)

target_link_libraries(rofl_wasm PRIVATE rofl_core)

target_include_directories(rofl_wasm PRIVATE "${CMAKE_SOURCE_DIR}/packages/rofl-core/include")

target_compile_options(rofl_core PRIVATE "-fexceptions")
target_compile_options(rofl_wasm PRIVATE "-fexceptions")

target_link_options(rofl_wasm PRIVATE
    "-sEXPORTED_RUNTIME_METHODS=['ccall','cwrap','UTF8ToString']"
    "-sEXPORTED_FUNCTIONS=['_malloc','_free','_lra_alloc_buffer','_lra_copy_buffer_chunk','_lra_free_buffer','_lra_parse_replay_buffer','_lra_extract_replay_kills_buffer','_lra_extract_replay_objectives_buffer','_lra_extract_replay_wards_buffer','_lra_extract_replay_ward_position_candidates_buffer','_lra_scan_replay_families_buffer','_lra_analyze_entity_slab_buffer','_lra_analyze_sparse_family_buffer','_lra_analyze_scalar_family_buffer','_lra_analyze_clean_row_offsets_buffer','_lra_analyze_bitfield_schema_buffer','_lra_free_string']"
    "-sALLOW_MEMORY_GROWTH=1"
    "-fexceptions"
    "-sMODULARIZE=1"
    "-sEXPORT_ES6=1"
    "-sENVIRONMENT=web,worker"
    "-sFILESYSTEM=0"
    "-o${CMAKE_CURRENT_BINARY_DIR}/rofl_wasm.js"
)

