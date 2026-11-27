#!/usr/bin/env bash
# Builds dist/AHTracker-<version>.zip: unzip it into Interface/AddOns/ to install the addon by hand.
set -euo pipefail
cd "$(dirname "$0")/.."
version=$(sed -n 's/^## Version: *//p' addon/AHTracker/AHTracker.toc | tr -d '\r')
mkdir -p dist
out="dist/AHTracker-${version}.zip"
rm -f "$out"
(cd addon && zip -qr "../$out" AHTracker -x '*.DS_Store')
echo "wrote $out"
