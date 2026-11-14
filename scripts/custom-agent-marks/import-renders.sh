#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then
  echo "Usage: $0 <render-output-directory> [review-sheet-directory]" >&2
  exit 64
fi

source_directory="$1"
script_directory="$(cd "$(dirname "$0")" && pwd)"
target_directory="$(cd "$script_directory/../.." && pwd)/src/renderer/src/assets/marks"
names=(runner scout guard builder scribe spark)
themes=(dark light)

for name in "${names[@]}"; do
  for theme in "${themes[@]}"; do
    file="$source_directory/$name-$theme.png"
    if [ ! -f "$file" ] || [ -L "$file" ]; then
      echo "Missing render: $file" >&2
      exit 1
    fi
  done
done

sheets=()
if [ "$#" -eq 2 ]; then
  sheets=(--sheets "$2")
fi

python3 -I "$script_directory/frame-renders.py" --source "$source_directory" --output "$target_directory" "${sheets[@]}"
