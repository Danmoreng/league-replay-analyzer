#!/usr/bin/env bash

set -Eeuo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/.." && pwd)"
tag="$(date -u +%F)-decoder"

if (( $# == 1 )) && [[ "$1" == "-h" || "$1" == "--help" ]]; then
  printf 'Usage: scripts/stop_autoresearch.sh [--tag] <value>\n'
  exit 0
elif (( $# == 1 )) && [[ "$1" != --* ]]; then
  tag="$1"
elif (( $# > 0 )); then
  if (( $# != 2 )) || [[ "$1" != "--tag" ]]; then
    printf 'Usage: scripts/stop_autoresearch.sh [--tag] <value>\n' >&2
    exit 2
  fi
  tag="$2"
fi

if [[ ! "$tag" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]]; then
  printf 'error: invalid autoresearch tag\n' >&2
  exit 2
fi

run_dir="$repo_root/tmp/autoresearch/$tag"
mkdir -p -- "$run_dir"
touch -- "$run_dir/STOP"
printf '[autoresearch] Stop requested for tag %s\n' "$tag"
