FROM dhi.io/debian-base AS base

# Disable the runtime transpiler cache by default inside Docker containers.
# On ephemeral containers, the cache is not useful
ARG BUN_RUNTIME_TRANSPILER_CACHE_PATH=0
ENV BUN_RUNTIME_TRANSPILER_CACHE_PATH=${BUN_RUNTIME_TRANSPILER_CACHE_PATH}
# bash is required by capsh (used to drop capabilities in entrypoint)
RUN apt-get update && apt-get install -y --no-install-recommends \
      ripgrep \
      iptables \
      libcap2-bin \
    && rm -rf /var/lib/apt/lists/*

FROM base AS build-amd64
COPY dist/opencode-linux-x64-baseline-musl/bin/opencode /usr/local/bin/opencode

FROM base AS build-arm64
COPY dist/opencode-linux-arm64-musl/bin/opencode /usr/local/bin/opencode

ARG TARGETARCH
FROM build-${TARGETARCH}
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh && opencode --version
ENTRYPOINT ["/entrypoint.sh"]
