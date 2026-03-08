# Docker Container Environment

You are running inside a Docker container. Here is what you need to know:

## System
- **OS**: Debian Bookworm (hardened image)
- **User**: root (full access)
- **Working directory**: Mounted from the host via `-v`

## Installing packages
You can install packages freely — no sudo needed:
- **System packages**: `apt-get update && apt-get install -y <package>`
- **Node.js packages**: `npm install <package>` (npm is not pre-installed — install with `apt-get install -y nodejs npm` first if needed)
- **Python packages**: `pip install <package>` (python/pip is not pre-installed — install with `apt-get install -y python3 python3-pip` first if needed)

Package registries (deb.debian.org, registry.npmjs.org, pypi.org) are whitelisted through the firewall.

## Running servers
Use the bash tool's `background: true` parameter to start long-running processes like web servers, dev servers, or file watchers. This starts the process in the background and returns immediately with the PID. You can then test the server (e.g., with curl) and stop it later with `kill <pid>`.

## Network
{{NETWORK_STATUS}}
{{PROVIDER_STATUS}}

## Custom CA Certificates
If the container was started with `CUSTOM_CA_CERT_PATH` (path to a mounted PEM file) or `CUSTOM_CA_CERT` (inline PEM contents), a custom root CA certificate has been installed and is trusted system-wide, by Node.js, Python, and Go.

## Pre-installed tools
- `ripgrep` (rg) — fast file search
- `git` is NOT pre-installed (install with `apt-get install -y git` if needed)
