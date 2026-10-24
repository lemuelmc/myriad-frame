#!/usr/bin/env bash
set -euo pipefail

# Build a single-file portable EXE (electron-builder `portable` target) and
# zip it for distribution. This is NOT an NSIS installer — the portable EXE
# self-extracts to a temp dir on launch and needs no install step.
#
# Usage:
#   sh scripts/build-portable.sh
# or
#   npm run dist:portable
#
# Produces: dist/<productName>-<version>-portable.zip
#
# Note: electron-builder may pull in the winCodeSign bundle (for signing). If the
# build fails on 7-Zip extracting symlinks, run this from an elevated
# (Administrator) shell, or the portable target alone still works unsigned on
# most machines.

# Ensure coreutils are available even when Git Bash's bin dir is not on PATH
for candidate in "/usr/bin" "/usr/local/bin" "C:/Program Files/Git/usr/bin"; do
  if [ -d "$candidate" ]; then
    PATH="$candidate:$PATH"
  fi
done

SCRIPT_SOURCE="${BASH_SOURCE[0]}"
SCRIPT_DIR="${SCRIPT_SOURCE%/*}"
if [ "$SCRIPT_DIR" = "$SCRIPT_SOURCE" ]; then
  SCRIPT_DIR="."
fi
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

echo "==> Building renderer/main/preload (electron-vite build)"
npx electron-vite build

# `--target` is not a valid electron-builder CLI flag; targets come from
# electron-builder.yml. Build a temporary config scoped to only the portable
# target so nsis isn't built too.
tmp_cfg="$(mktemp --suffix=.yml)"
cat > "$tmp_cfg" <<'YML'
appId: com.myriadframe.app
productName: Myriad Frame
files:
  - out/**/*
extraResources:
  - from: configurations
    to: configurations
    filter:
      - '**/*'
win:
  target:
    - portable
  icon: src/assets/logo-square-small.png
portable:
  artifactName: ${productName}-${version}-portable-${os}-${arch}.exe
YML

echo "==> Building portable EXE (electron-builder --win)"
npx electron-builder --win -c "$tmp_cfg"
rm -f "$tmp_cfg"

# Locate the produced portable EXE in dist/. The artifact name is
# ${productName}-${version}-portable-${os}-${arch}.exe (see electron-builder.yml).
shopt -s nullglob
portable_exes=(dist/*-portable-*.exe)
if [ ${#portable_exes[@]} -eq 0 ]; then
  echo "==> ERROR: No portable EXE found in dist/ after build" >&2
  exit 1
fi
if [ ${#portable_exes[@]} -gt 1 ]; then
  echo "==> WARNING: Multiple portable EXEs found; zipping the first: ${portable_exes[0]}"
fi
portable_exe="${portable_exes[0]}"
echo "==> Found portable EXE: $portable_exe"

# Derive a clean zip name from package.json.
version="$(node -e "console.log(require('./package.json').version)")"
product_name="$(node -e "console.log(require('./package.json').name)")"
zipbase="$(printf '%s' "$product_name" | tr ' ' '-')"
zip_name="${zipbase}-${version}-portable.zip"
zip_path="dist/${zip_name}"

echo "==> Zipping -> $zip_path"
if command -v zip >/dev/null 2>&1; then
  (cd dist && zip -j "$zip_name" "$(basename "$portable_exe")")
else
  powershell -Command "Compress-Archive -Path (Convert-Path '$portable_exe') -DestinationPath '$zip_path' -CompressionLevel Optimal"
fi

echo "==> Done: $zip_path"
