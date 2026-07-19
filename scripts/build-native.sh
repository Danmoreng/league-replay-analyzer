#!/usr/bin/env bash

set -Eeuo pipefail

usage() {
    cat <<'EOF'
Build a native League Replay Analyzer target on Linux.

Usage: scripts/build-native.sh [options]

Options:
  --clean                    Remove the selected build directory first.
  --configuration <value>    Debug or Release (default: Debug).
  --build-dir <path>         Build directory (default: build-linux).
  --generator <value>        Ninja or Unix Makefiles (default: Ninja).
  --target <name>            CMake target (default: rofl_core_cli).
  --run-smoke-test           Run the built target with --version.
  -h, --help                 Show this help.
EOF
}

require_value() {
    local option="$1"
    local value="${2-}"
    if [[ -z "$value" ]]; then
        echo "Missing value for $option." >&2
        usage >&2
        exit 2
    fi
}

clean=false
configuration="Debug"
build_dir="build-linux"
generator="Ninja"
target="rofl_core_cli"
run_smoke_test=false

while (($# > 0)); do
    case "$1" in
        --clean)
            clean=true
            shift
            ;;
        --configuration)
            require_value "$1" "${2-}"
            configuration="$2"
            shift 2
            ;;
        --build-dir)
            require_value "$1" "${2-}"
            build_dir="$2"
            shift 2
            ;;
        --generator)
            require_value "$1" "${2-}"
            generator="$2"
            shift 2
            ;;
        --target)
            require_value "$1" "${2-}"
            target="$2"
            shift 2
            ;;
        --run-smoke-test)
            run_smoke_test=true
            shift
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            echo "Unknown option: $1" >&2
            usage >&2
            exit 2
            ;;
    esac
done

case "$configuration" in
    Debug|Release) ;;
    *)
        echo "Unsupported configuration '$configuration'. Use Debug or Release." >&2
        exit 2
        ;;
esac

case "${generator,,}" in
    ninja)
        generator="Ninja"
        ;;
    "unix makefiles"|unix-makefiles|make)
        generator="Unix Makefiles"
        ;;
    *)
        echo "Unsupported generator '$generator'. Use Ninja or Unix Makefiles." >&2
        exit 2
        ;;
esac

command -v cmake >/dev/null 2>&1 || {
    echo "cmake was not found on PATH (version 3.26 or newer is required)." >&2
    exit 1
}

if [[ "$generator" == "Ninja" ]] && ! command -v ninja >/dev/null 2>&1; then
    echo "Ninja was requested but was not found on PATH." >&2
    exit 1
fi

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/.." && pwd)"
if [[ "$build_dir" = /* ]]; then
    resolved_build_dir="$build_dir"
else
    resolved_build_dir="$repo_root/$build_dir"
fi

if [[ -z "$resolved_build_dir" || "$resolved_build_dir" == "/" || "$resolved_build_dir" == "$repo_root" ]]; then
    echo "Refusing to use unsafe build directory '$resolved_build_dir'." >&2
    exit 1
fi

remove_build_dir() {
    if [[ -d "$resolved_build_dir" ]]; then
        echo "Cleaning $resolved_build_dir"
        cmake -E remove_directory "$resolved_build_dir"
    fi
}

if $clean; then
    remove_build_dir
fi

cache_file="$resolved_build_dir/CMakeCache.txt"
if [[ -f "$cache_file" ]]; then
    configured_generator="$(sed -n 's/^CMAKE_GENERATOR:INTERNAL=//p' "$cache_file" | head -n 1)"
    if [[ -n "$configured_generator" && "$configured_generator" != "$generator" ]]; then
        echo "Generator mismatch (found '$configured_generator', requested '$generator')."
        remove_build_dir
    fi
fi

echo "Configuring native build with $generator ($configuration)"
cmake \
    -S "$repo_root" \
    -B "$resolved_build_dir" \
    -G "$generator" \
    -DCMAKE_BUILD_TYPE="$configuration"

echo "Building target $target"
cmake --build "$resolved_build_dir" --config "$configuration" --target "$target"

if $run_smoke_test; then
    executable="$resolved_build_dir/packages/rofl-core/$target"
    if [[ ! -x "$executable" ]]; then
        echo "Built executable was not found at $executable." >&2
        exit 1
    fi

    echo "Running smoke test"
    "$executable" --version
fi
