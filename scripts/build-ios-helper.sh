#!/bin/sh
# Builds the macOS iOS-capture helper as a universal binary into
# resources/bin/mac-<arch>/ (copied into the app by electron-builder).
set -e
cd "$(dirname "$0")/.."
SRC=native/ios-capture/main.swift
TMP=$(mktemp -d)
for ARCH in arm64 x86_64; do
  swiftc -O -target "$ARCH-apple-macos13.0" -o "$TMP/ios-capture-$ARCH" "$SRC"
done
lipo -create -output "$TMP/ios-capture" "$TMP/ios-capture-arm64" "$TMP/ios-capture-x86_64"
strip -x "$TMP/ios-capture"
for DIR in mac-arm64 mac-x64; do
  mkdir -p "resources/bin/$DIR"
  # copy then rename: replaces the file without touching a copy that is running
  cp "$TMP/ios-capture" "resources/bin/$DIR/ios-capture.new"
  mv -f "resources/bin/$DIR/ios-capture.new" "resources/bin/$DIR/ios-capture"
done
rm -rf "$TMP"
ls -la resources/bin/mac-arm64/ios-capture
