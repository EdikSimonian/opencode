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

exec /usr/local/bin/opencode "$@"
