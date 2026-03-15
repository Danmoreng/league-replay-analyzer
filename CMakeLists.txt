cmake_minimum_required(VERSION 3.26)

project(league_replay_analyzer LANGUAGES C CXX)

option(ROFL_BUILD_WASM "Build the WebAssembly bridge with Emscripten" OFF)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

include(CTest)

set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
set(ZSTD_BUILD_SHARED OFF CACHE BOOL "" FORCE)
set(ZSTD_BUILD_STATIC ON CACHE BOOL "" FORCE)
set(ZSTD_BUILD_PROGRAMS OFF CACHE BOOL "" FORCE)
set(ZSTD_BUILD_TESTS OFF CACHE BOOL "" FORCE)
set(ZSTD_BUILD_CONTRIB OFF CACHE BOOL "" FORCE)
set(ZSTD_MULTITHREAD_SUPPORT OFF CACHE BOOL "" FORCE)

add_subdirectory(thirdparty/zstd/build/cmake EXCLUDE_FROM_ALL)

add_subdirectory(packages/rofl-core)

if (ROFL_BUILD_WASM)
    add_subdirectory(packages/rofl-wasm)
endif()
