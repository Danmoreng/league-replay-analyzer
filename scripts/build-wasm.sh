#!/usr/bin/env bash

set -Eeuo pipefail

usage() {
    cat <<'EOF'
Build the WebAssembly bridge on Linux and publish it to the web app.

Usage: scripts/build-wasm.sh [options]

Options:
  --clean                    Remove the selected build directory first.
  --configuration <value>    Debug or Release (default: Release).
  --build-dir <path>         Build directory (default: build-wasm).
  --emsdk-root <path>        emsdk directory (default: tools/emsdk).
  --generator <value>        Ninja or Unix Makefiles (default: Ninja).
  --publish-dir <path>       Output directory for JS/Wasm artifacts.
  --no-publish               Build without publishing artifacts.
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
configuration="Release"
build_dir="build-wasm"
emsdk_root="tools/emsdk"
generator="Ninja"
publish_dir="apps/web/src/generated/wasm"
publish=true

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
        --emsdk-root)
            require_value "$1" "${2-}"
            emsdk_root="$2"
            shift 2
            ;;
        --generator)
            require_value "$1" "${2-}"
            generator="$2"
            shift 2
            ;;
        --publish-dir)
            require_value "$1" "${2-}"
            publish_dir="$2"
            publish=true
            shift 2
            ;;
        --no-publish)
            publish=false
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

resolve_from_repo() {
    local path="$1"
    if [[ "$path" = /* ]]; then
        printf '%s\n' "$path"
    else
        printf '%s/%s\n' "$repo_root" "$path"
    fi
}

resolved_build_dir="$(resolve_from_repo "$build_dir")"
resolved_emsdk_root="$(resolve_from_repo "$emsdk_root")"
resolved_publish_dir="$(resolve_from_repo "$publish_dir")"

if [[ -z "$resolved_build_dir" || "$resolved_build_dir" == "/" || "$resolved_build_dir" == "$repo_root" ]]; then
    echo "Refusing to use unsafe build directory '$resolved_build_dir'." >&2
    exit 1
fi

emsdk_env="$resolved_emsdk_root/emsdk_env.sh"
if [[ -f "$emsdk_env" ]]; then
    export EMSDK_QUIET=1
    set +u
    # shellcheck disable=SC1090
    source "$emsdk_env" >/dev/null
    set -u
fi

if ! command -v emcmake >/dev/null 2>&1; then
    echo "emcmake was not found. Install/activate emsdk or pass --emsdk-root." >&2
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

echo "Configuring Wasm build with $generator ($configuration)"
emcmake cmake \
    -S "$repo_root" \
    -B "$resolved_build_dir" \
    -G "$generator" \
    -DROFL_BUILD_WASM=ON \
    -DCMAKE_BUILD_TYPE="$configuration"

echo "Building target rofl_wasm"
cmake --build "$resolved_build_dir" --config "$configuration" --target rofl_wasm

if $publish; then
    wasm_build_dir="$resolved_build_dir/packages/rofl-wasm"
    js_source="$wasm_build_dir/rofl_wasm.js"
    wasm_source="$wasm_build_dir/rofl_wasm.wasm"
    if [[ ! -f "$js_source" || ! -f "$wasm_source" ]]; then
        echo "Expected Wasm artifacts were not produced in $wasm_build_dir." >&2
        exit 1
    fi

    cmake -E make_directory "$resolved_publish_dir"
    cmake -E copy_if_different "$js_source" "$resolved_publish_dir/rofl_wasm.js"
    cmake -E copy_if_different "$wasm_source" "$resolved_publish_dir/rofl_wasm.wasm"
    echo "Published Wasm artifacts to $resolved_publish_dir"
fi
