# Glibc image for the containerized opencode **TUI**.
#
# opencode's @opentui TUI renderer hard-hangs (0 bytes, no output) under the
# Alpine/musl image — headless `opencode run` works there, but the interactive
# TUI never renders. The glibc build renders correctly, so this image uses a
# Debian base + the glibc linux binaries.
#
# Built by .github/workflows/docker.yml with context=packages/opencode (so the
# COPY paths resolve against packages/opencode/dist, populated by build.ts).
FROM debian:stable-slim AS base
# Agent toolchain: ripgrep/git for opencode itself, plus language runtimes so the
# agent can run project build/test commands inside the container:
#   - Python: Debian trixie's python3 (currently 3.13.x) + venv/pip + `python` alias
#   - Node.js: the current LTS (24.x) from the official nodejs.org tarball, since
#     Debian's apt `nodejs` lags many majors behind. Pinned to the v24 LTS line and
#     checksum-verified; bump the major here when a newer LTS lands.
RUN set -eux; \
  apt-get update; \
  apt-get install -y --no-install-recommends \
    ripgrep git ca-certificates curl xz-utils \
    python3 python3-venv python3-pip python-is-python3; \
  arch="$(dpkg --print-architecture)"; \
  case "$arch" in \
    amd64) nodearch=x64 ;; \
    arm64) nodearch=arm64 ;; \
    *) echo "unsupported arch for Node.js: $arch" >&2; exit 1 ;; \
  esac; \
  nbase="https://nodejs.org/dist/latest-v24.x"; \
  curl -fsSL "$nbase/SHASUMS256.txt" -o /tmp/SHASUMS256.txt; \
  nfile="$(awk -v a="linux-$nodearch.tar.xz" '$2 ~ a {print $2; exit}' /tmp/SHASUMS256.txt)"; \
  [ -n "$nfile" ] || { echo "could not resolve Node LTS tarball for $nodearch" >&2; exit 1; }; \
  curl -fsSL "$nbase/$nfile" -o "/tmp/$nfile"; \
  (cd /tmp && grep " $nfile\$" SHASUMS256.txt | sha256sum -c -); \
  tar -xJf "/tmp/$nfile" -C /usr/local --strip-components=1 --no-same-owner; \
  rm -f "/tmp/$nfile" /tmp/SHASUMS256.txt; \
  node --version; npm --version; python3 --version; \
  rm -rf /var/lib/apt/lists/*

# amd64 uses the baseline (no-AVX2) build for broad CPU compatibility.
FROM base AS build-amd64
COPY dist/opencode-linux-x64-baseline/bin/opencode /usr/local/bin/opencode

FROM base AS build-arm64
COPY dist/opencode-linux-arm64/bin/opencode /usr/local/bin/opencode

ARG TARGETARCH
FROM build-${TARGETARCH}
RUN opencode --version
ENTRYPOINT ["opencode"]
