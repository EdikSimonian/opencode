#!/bin/sh
set -e

REPO="EdikSimonian/opencode"
# Pick an install dir that exists, preferring /usr/local/bin
if [ -d "/opt/homebrew/bin" ]; then
  BIN_DIR="/opt/homebrew/bin"
elif [ -d "/usr/local/bin" ]; then
  BIN_DIR="/usr/local/bin"
else
  BIN_DIR="$HOME/.local/bin"
  mkdir -p "$BIN_DIR"
fi
BIN_NAME="opencode"

# Detect OS
OS=$(uname -s | tr '[:upper:]' '[:lower:]')
if [ "$OS" = "darwin" ]; then
  PLATFORM="darwin"
elif [ "$OS" = "linux" ]; then
  PLATFORM="linux"
else
  echo "Unsupported OS: $OS"
  exit 1
fi

# Detect arch
ARCH=$(uname -m)
if [ "$ARCH" = "arm64" ] || [ "$ARCH" = "aarch64" ]; then
  ARCH="arm64"
elif [ "$ARCH" = "x86_64" ]; then
  ARCH="x64"
else
  echo "Unsupported architecture: $ARCH"
  exit 1
fi

# Get latest release tag
echo "Fetching latest release from $REPO..."
LATEST=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" | grep '"tag_name"' | sed 's/.*"tag_name": *"\([^"]*\)".*/\1/')
if [ -z "$LATEST" ]; then
  echo "Could not determine latest release"
  exit 1
fi
echo "Latest version: $LATEST"

# Build download URL
if [ "$PLATFORM" = "linux" ]; then
  EXT="tar.gz"
else
  EXT="zip"
fi
NAME="opencode-${PLATFORM}-${ARCH}"
URL="https://github.com/$REPO/releases/download/$LATEST/${NAME}.${EXT}"

# Download
TMP_DIR=$(mktemp -d)
TMP_FILE="$TMP_DIR/opencode.$EXT"
echo "Downloading $URL..."
curl -fsSL "$URL" -o "$TMP_FILE"

# Extract
echo "Extracting..."
if [ "$EXT" = "zip" ]; then
  unzip -o "$TMP_FILE" -d "$TMP_DIR"
else
  tar -xzf "$TMP_FILE" -C "$TMP_DIR"
fi

# Find the binary (handles nested paths like opencode-darwin-arm64/bin/opencode)
BINARY=$(find "$TMP_DIR" -type f -name "opencode" | head -1)
if [ -z "$BINARY" ]; then
  echo "Could not find opencode binary in archive"
  exit 1
fi

# Install
echo "Installing to $BIN_DIR/$BIN_NAME..."
if [ -w "$BIN_DIR" ]; then
  mv "$BINARY" "$BIN_DIR/$BIN_NAME"
else
  sudo mv "$BINARY" "$BIN_DIR/$BIN_NAME"
fi
chmod +x "$BIN_DIR/$BIN_NAME"

# Cleanup
rm -rf "$TMP_DIR"

echo ""
echo "Installed $($BIN_DIR/$BIN_NAME --version)"
echo "Run: opencode"
