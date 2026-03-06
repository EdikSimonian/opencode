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

  echo "opencode: network isolation active — all other outbound traffic blocked" >&2
}

setup_firewall

# Auto-allow all opencode tool permissions (bash, edit, read, write, etc.)
# Can be overridden by passing OPENCODE_PERMISSION explicitly.
export OPENCODE_PERMISSION="${OPENCODE_PERMISSION:-{\"*\":\"allow\"}}"

# Drop CAP_NET_ADMIN and CAP_NET_RAW from the bounding set before exec'ing opencode.
# This means opencode runs as root (full filesystem + package install access) but
# cannot modify iptables rules, even if --cap-add NET_ADMIN was passed to docker run.
# setpriv is used instead of capsh because capsh wraps via bash -c, which breaks
# PTY inheritance and causes a blank screen in interactive TUI mode.
exec setpriv --bounding-set=-cap_net_admin,-cap_net_raw -- /usr/local/bin/opencode "$@"
