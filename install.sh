#!/bin/sh
set -e

REPO="EdikSimonian/opencode"
BIN_DIR="/usr/local/bin"
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

# Install
echo "Installing to $BIN_DIR/$BIN_NAME..."
if [ -w "$BIN_DIR" ]; then
  mv "$TMP_DIR/opencode" "$BIN_DIR/$BIN_NAME"
else
  sudo mv "$TMP_DIR/opencode" "$BIN_DIR/$BIN_NAME"
fi
chmod +x "$BIN_DIR/$BIN_NAME"

# Cleanup
rm -rf "$TMP_DIR"

echo ""
echo "Installed $($BIN_DIR/$BIN_NAME --version)"
echo "Run: opencode"
