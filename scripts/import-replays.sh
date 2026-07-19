#!/usr/bin/env bash

set -Eeuo pipefail

usage() {
    cat <<'EOF'
Import locally staged .rofl files into this checkout without silent overwrites.

Usage: scripts/import-replays.sh --source <directory> [options]

Options:
  --source <directory>       Directory containing .rofl files (required).
  --destination <directory>  Destination (default: repository replays/).
  --overwrite                Replace different files with the same name.
  --dry-run                  Print actions without copying.
  -h, --help                 Show this help.

Only .rofl files directly inside the source directory are imported.
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

source_dir=""
destination_dir=""
overwrite=false
dry_run=false

while (($# > 0)); do
    case "$1" in
        --source)
            require_value "$1" "${2-}"
            source_dir="$2"
            shift 2
            ;;
        --destination)
            require_value "$1" "${2-}"
            destination_dir="$2"
            shift 2
            ;;
        --overwrite)
            overwrite=true
            shift
            ;;
        --dry-run)
            dry_run=true
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

if [[ -z "$source_dir" ]]; then
    echo "--source is required." >&2
    usage >&2
    exit 2
fi
if [[ ! -d "$source_dir" ]]; then
    echo "Source directory does not exist: $source_dir" >&2
    exit 1
fi

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/.." && pwd)"
if [[ -z "$destination_dir" ]]; then
    destination_dir="$repo_root/replays"
elif [[ "$destination_dir" != /* ]]; then
    destination_dir="$repo_root/$destination_dir"
fi

mapfile -d '' replay_files < <(
    find "$source_dir" -maxdepth 1 -type f -iname '*.rofl' -print0 | sort -z
)
if ((${#replay_files[@]} == 0)); then
    echo "No .rofl files found directly in $source_dir." >&2
    exit 1
fi

conflicts=0
for source_file in "${replay_files[@]}"; do
    destination_file="$destination_dir/$(basename -- "$source_file")"
    if [[ -f "$destination_file" ]] && ! cmp --silent -- "$source_file" "$destination_file"; then
        if ! $overwrite; then
            echo "Refusing to overwrite different file: $destination_file" >&2
            ((conflicts += 1))
        fi
    fi
done
if ((conflicts > 0)); then
    echo "Import cancelled. Re-run with --overwrite only if replacement is intended." >&2
    exit 1
fi

if $dry_run; then
    echo "Would ensure destination exists: $destination_dir"
else
    mkdir -p -- "$destination_dir"
fi

copied=0
unchanged=0
for source_file in "${replay_files[@]}"; do
    destination_file="$destination_dir/$(basename -- "$source_file")"
    if [[ -f "$destination_file" ]] && cmp --silent -- "$source_file" "$destination_file"; then
        echo "Unchanged: $(basename -- "$source_file")"
        ((unchanged += 1))
        continue
    fi

    if $dry_run; then
        echo "Would copy: $source_file -> $destination_file"
    else
        cp -p -- "$source_file" "$destination_file"
        echo "Copied: $(basename -- "$source_file")"
    fi
    ((copied += 1))
done

if $dry_run; then
    echo "Dry run complete: $copied to copy, $unchanged unchanged."
else
    echo "Import complete: $copied copied, $unchanged unchanged."
fi
