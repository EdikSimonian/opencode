FROM dhi.io/debian-base:bookworm AS base

# Disable the runtime transpiler cache by default inside Docker containers.
# On ephemeral containers, the cache is not useful
ARG BUN_RUNTIME_TRANSPILER_CACHE_PATH=0
ENV BUN_RUNTIME_TRANSPILER_CACHE_PATH=${BUN_RUNTIME_TRANSPILER_CACHE_PATH}
# dhi.io/debian-base runs as 'nonroot' by default and has no named root entry
# in /etc/passwd, so we use UID 0 directly. setpriv in the entrypoint drops
# CAP_NET_ADMIN before exec'ing opencode.
USER 0
# The DHI image has no root user in /etc/passwd, so HOME defaults to '/'.
# opencode needs a proper home directory for XDG config/data paths.
ENV HOME=/root
RUN mkdir -p /root && apt-get update && apt-get install -y --no-install-recommends \
      ripgrep \
      iptables \
    && rm -rf /var/lib/apt/lists/*

FROM base AS build-amd64
COPY dist/opencode-linux-x64-baseline/bin/opencode /usr/local/bin/opencode

FROM base AS build-arm64
COPY dist/opencode-linux-arm64/bin/opencode /usr/local/bin/opencode

ARG TARGETARCH
FROM build-${TARGETARCH}
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh && opencode --version
ENTRYPOINT ["/entrypoint.sh"]
