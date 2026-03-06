#!/bin/sh
set -e

setup_firewall() {
  # Skip silently if we don't have NET_ADMIN capability
  iptables -L OUTPUT > /dev/null 2>&1 || {
    echo "opencode: NET_ADMIN not available, skipping network isolation" >&2
    return 0
  }

  iptables -F OUTPUT
  iptables -P OUTPUT DROP

  # Allow loopback
  iptables -A OUTPUT -o lo -j ACCEPT

  # Allow DNS (needed to resolve hostnames below)
  iptables -A OUTPUT -p udp --dport 53 -j ACCEPT
  iptables -A OUTPUT -p tcp --dport 53 -j ACCEPT

  # Allow already-established connections
  iptables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT

  # Allow each configured provider host
  for env_var in OLLAMA_HOST LMSTUDIO_HOST OPENWEBUI_HOST; do
    url=$(eval "echo \"\$$env_var\"")
    [ -z "$url" ] && continue

    # Strip scheme and path to get the bare hostname/IP
    host=$(echo "$url" | sed -E 's|^[a-z]+://||' | cut -d'/' -f1 | cut -d':' -f1)

    ips=$(getent hosts "$host" 2>/dev/null | awk '{print $1}')
    [ -z "$ips" ] && ips="$host"  # already an IP

    for ip in $ips; do
      echo "opencode: allowing outbound to $env_var host $host ($ip)" >&2
      iptables -A OUTPUT -d "$ip" -j ACCEPT
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
exec capsh --drop=cap_net_admin,cap_net_raw -- -c 'exec /usr/local/bin/opencode "$@"' _ "$@"
