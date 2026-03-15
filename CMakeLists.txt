cmake_minimum_required(VERSION 3.26)

project(league_replay_analyzer LANGUAGES CXX)

option(ROFL_BUILD_WASM "Build the WebAssembly bridge with Emscripten" OFF)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

include(CTest)

add_subdirectory(packages/rofl-core)

if (ROFL_BUILD_WASM)
    add_subdirectory(packages/rofl-wasm)
endif()
