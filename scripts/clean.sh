#!/usr/bin/env bash
set -euo pipefail

# Ensure coreutils are available even when Git Bash's bin dir is not on PATH
for candidate in "/usr/bin" "/usr/local/bin" "C:/Program Files/Git/usr/bin"; do
  if [ -d "$candidate" ]; then
    PATH="$candidate:$PATH"
  fi
done

echo "==> Starting clean process"

SCRIPT_SOURCE="${BASH_SOURCE[0]}"
SCRIPT_DIR="${SCRIPT_SOURCE%/*}"
if [ "$SCRIPT_DIR" = "$SCRIPT_SOURCE" ]; then
  SCRIPT_DIR="."
fi

ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "    Root directory: $ROOT_DIR"

CLEANED=0
for dir in dist out; do
  if [ -d "$ROOT_DIR/$dir" ]; then
    echo "    Removing directory: $ROOT_DIR/$dir"
    rm -rf "$ROOT_DIR/$dir"
    echo "    Removed: $ROOT_DIR/$dir"
    CLEANED=1
  else
    echo "    Nothing to clean: $ROOT_DIR/$dir does not exist"
  fi
done

if [ "$CLEANED" -eq 0 ]; then
  echo "==> Nothing was removed; no 'dist' or 'out' folder was present"
fi

echo "==> Clean process complete"
