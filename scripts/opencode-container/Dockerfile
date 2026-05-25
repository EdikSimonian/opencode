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
RUN apt-get update \
  && apt-get install -y --no-install-recommends ripgrep git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# amd64 uses the baseline (no-AVX2) build for broad CPU compatibility.
FROM base AS build-amd64
COPY dist/opencode-linux-x64-baseline/bin/opencode /usr/local/bin/opencode

FROM base AS build-arm64
COPY dist/opencode-linux-arm64/bin/opencode /usr/local/bin/opencode

ARG TARGETARCH
FROM build-${TARGETARCH}
RUN opencode --version
ENTRYPOINT ["opencode"]
