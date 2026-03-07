#!/bin/sh
set -e

setup_firewall() {
  # Allow opting out of network isolation entirely
  if [ -n "$OPENCODE_DISABLE_ISOLATION" ]; then
    echo "opencode: OPENCODE_DISABLE_ISOLATION set — network isolation skipped" >&2
    return 0
  fi

  # Skip silently if we don't have NET_ADMIN capability
  iptables -L OUTPUT > /dev/null 2>&1 || {
    echo "opencode: NET_ADMIN not available, skipping network isolation" >&2
    return 0
  }

  # ── IPv4 ────────────────────────────────────────────────────────────────────
  iptables -F OUTPUT
  iptables -P OUTPUT DROP

  iptables -A OUTPUT -o lo -j ACCEPT
  iptables -A OUTPUT -p udp --dport 53 -j ACCEPT
  iptables -A OUTPUT -p tcp --dport 53 -j ACCEPT
  iptables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT

  # ── IPv6 (block everything except loopback + DNS + established) ─────────────
  ip6tables -F OUTPUT 2>/dev/null || true
  ip6tables -P OUTPUT DROP 2>/dev/null || true
  ip6tables -A OUTPUT -o lo -j ACCEPT 2>/dev/null || true
  ip6tables -A OUTPUT -p udp --dport 53 -j ACCEPT 2>/dev/null || true
  ip6tables -A OUTPUT -p tcp --dport 53 -j ACCEPT 2>/dev/null || true
  ip6tables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT 2>/dev/null || true

  # ── Allow package managers (apt, npm, pip) ──────────────────────────────────
  for pkg_host in \
    deb.debian.org security.debian.org \
    registry.npmjs.org \
    pypi.org files.pythonhosted.org; do
    pkg_ips=$(getent hosts "$pkg_host" 2>/dev/null | awk '{print $1}')
    for ip in $pkg_ips; do
      if echo "$ip" | grep -q ':'; then
        ip6tables -A OUTPUT -d "$ip" -j ACCEPT 2>/dev/null || true
      else
        iptables -A OUTPUT -d "$ip" -j ACCEPT || true
      fi
    done
  done

  # ── Allow configured provider hosts (IPv4 + IPv6) ───────────────────────────
  for env_var in OLLAMA_HOST LMSTUDIO_HOST OPENWEBUI_HOST; do
    url=$(eval "echo \"\$$env_var\"")
    [ -z "$url" ] && continue

    host=$(echo "$url" | sed -E 's|^[a-z]+://||' | cut -d'/' -f1 | cut -d':' -f1)
    ips=$(getent hosts "$host" 2>/dev/null | awk '{print $1}')

    if [ -z "$ips" ]; then
      echo "opencode: WARNING: could not resolve '$host' from $env_var — no firewall rule added" >&2
      continue
    fi

    for ip in $ips; do
      echo "opencode: allowing outbound to $env_var host $host ($ip)" >&2
      if echo "$ip" | grep -q ':'; then
        ip6tables -A OUTPUT -d "$ip" -j ACCEPT 2>/dev/null || true
      else
        iptables -A OUTPUT -d "$ip" -j ACCEPT || true
      fi
    done
  done

  # REJECT remaining traffic so blocked connections fail instantly instead of
  # hanging for 30-120s on TCP timeouts (DROP silently discards packets).
  # Without this, bun plugin installs block the TUI from starting.
  iptables -A OUTPUT -p tcp -j REJECT --reject-with tcp-reset
  iptables -A OUTPUT -j REJECT --reject-with icmp-port-unreachable
  ip6tables -A OUTPUT -p tcp -j REJECT --reject-with tcp-reset 2>/dev/null || true
  ip6tables -A OUTPUT -j REJECT --reject-with icmp6-port-unreachable 2>/dev/null || true

  echo "opencode: network isolation active — all other outbound traffic blocked" >&2
}

setup_firewall

# Auto-allow all opencode tool permissions (bash, edit, read, write, etc.)
# Can be overridden by passing OPENCODE_PERMISSION explicitly.
export OPENCODE_PERMISSION="${OPENCODE_PERMISSION:-{\"*\":\"allow\"}}"

# ── Generate AGENTS.md with runtime environment info ─────────────────────────
generate_agents_md() {
  local agents_dir="/root/.config/opencode"
  local agents_file="$agents_dir/AGENTS.md"
  local template="/docker-agents.md"

  # Don't overwrite if user mounted their own
  [ -f "$agents_file" ] && return 0
  [ ! -f "$template" ] && return 0

  mkdir -p "$agents_dir"

  # Build network status into a temp file
  local net_file
  net_file=$(mktemp)

  if [ -n "$OPENCODE_DISABLE_ISOLATION" ]; then
    echo "- **Firewall**: Disabled — all outbound traffic is allowed" > "$net_file"
  elif iptables -L OUTPUT > /dev/null 2>&1; then
    cat > "$net_file" <<NETEOF
- **Firewall**: Active — outbound traffic is filtered
- **Allowed**: DNS, package registries (apt/npm/pip), and configured provider hosts
- **Blocked**: All other outbound traffic (cloud AI APIs, arbitrary internet access)
NETEOF
    [ -n "$OLLAMA_HOST" ] && echo "- **Ollama**: $OLLAMA_HOST" >> "$net_file"
    [ -n "$LMSTUDIO_HOST" ] && echo "- **LM Studio**: $LMSTUDIO_HOST" >> "$net_file"
    [ -n "$OPENWEBUI_HOST" ] && echo "- **Open WebUI**: $OPENWEBUI_HOST" >> "$net_file"
  else
    echo "- **Firewall**: Not active (no NET_ADMIN capability) — all outbound traffic is allowed" > "$net_file"
  fi

  # Replace placeholder with network info
  awk -v netfile="$net_file" '
    /\{\{NETWORK_STATUS\}\}/ { while ((getline line < netfile) > 0) print line; next }
    { print }
  ' "$template" > "$agents_file"

  rm -f "$net_file"
}

generate_agents_md

exec /usr/local/bin/opencode "$@"
