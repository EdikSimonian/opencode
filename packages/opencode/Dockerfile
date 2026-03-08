FROM dhi.io/debian-base:bookworm AS base

# Disable the runtime transpiler cache by default inside Docker containers.
# On ephemeral containers, the cache is not useful
ARG BUN_RUNTIME_TRANSPILER_CACHE_PATH=0
ENV BUN_RUNTIME_TRANSPILER_CACHE_PATH=${BUN_RUNTIME_TRANSPILER_CACHE_PATH}
ENV TERM=xterm-256color
ENV HOME=/root

USER 0
RUN apt-get update && apt-get install -y --no-install-recommends \
      iptables ripgrep ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && echo "root:x:0:0:root:/root:/bin/sh" >> /etc/passwd \
    && mkdir -p /root

FROM base AS build-amd64
COPY dist/opencode-linux-x64-baseline/bin/opencode /usr/local/bin/opencode

FROM base AS build-arm64
COPY dist/opencode-linux-arm64/bin/opencode /usr/local/bin/opencode

ARG TARGETARCH
FROM build-${TARGETARCH}
COPY entrypoint.sh /entrypoint.sh
COPY docker-agents.md /docker-agents.md
RUN chmod +x /entrypoint.sh && opencode --version
ENTRYPOINT ["/entrypoint.sh"]
