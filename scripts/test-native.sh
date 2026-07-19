#!/usr/bin/env bash

set -Eeuo pipefail

usage() {
    cat <<'EOF'
Build and run the native C++ tests on Linux.

Usage: scripts/test-native.sh [options]

Options:
  --clean                    Remove the selected build directory first.
  --configuration <value>    Debug or Release (default: Debug).
  --build-dir <path>         Build directory (default: build-linux).
  --generator <value>        Ninja or Unix Makefiles (default: Ninja).
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

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/.." && pwd)"
if [[ "$build_dir" = /* ]]; then
    resolved_build_dir="$build_dir"
else
    resolved_build_dir="$repo_root/$build_dir"
fi

build_args=(
    --configuration "$configuration"
    --build-dir "$build_dir"
    --generator "$generator"
    --target rofl_core_tests
)
if $clean; then
    build_args+=(--clean)
fi

"$script_dir/build-native.sh" "${build_args[@]}"

echo "Running native tests"
ctest \
    --test-dir "$resolved_build_dir" \
    --output-on-failure \
    --build-config "$configuration"
