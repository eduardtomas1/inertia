#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "Usage: $0 <render-output-directory>" >&2
  exit 64
fi

source_directory="$1"
target_directory="$(cd "$(dirname "$0")/../.." && pwd)/src/renderer/src/assets/marks"
names=(runner scout guard builder scribe spark)
themes=(dark light)

for name in "${names[@]}"; do
  for theme in "${themes[@]}"; do
    file="$source_directory/$name-$theme.webp"
    if [ ! -f "$file" ] || [ -L "$file" ]; then
      echo "Missing render: $file" >&2
      exit 1
    fi
  done
done

mkdir -p "$target_directory"
for name in "${names[@]}"; do
  for theme in "${themes[@]}"; do
    cp -- "$source_directory/$name-$theme.webp" "$target_directory/$name-$theme.webp"
  done
done
echo "Copied 12 marks into $target_directory"
