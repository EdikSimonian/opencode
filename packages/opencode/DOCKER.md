# opencode Docker Image

A hardened Docker image for running opencode with network isolation and local LLM provider support.

## Quick Start

```bash
docker run --rm -it \
  -v "$(pwd):/workspace" \
  -w /workspace \
  -e OLLAMA_HOST=http://host.docker.internal:11434 \
  dhi.io/opencode
```

## Environment Variables

### LLM Providers

| Variable | Purpose |
|---|---|
| `OLLAMA_HOST` | Ollama URL (e.g. `http://host.docker.internal:11434`) |
| `LMSTUDIO_HOST` | LM Studio URL (e.g. `http://host.docker.internal:1234`) |
| `OPENWEBUI_HOST` | Open WebUI URL |
| `OPENWEBUI_API_KEY` | Open WebUI API key |

Cloud provider API keys (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, etc.) are also supported. When set, the corresponding API host is whitelisted through the firewall.

### Network Isolation

| Variable | Purpose |
|---|---|
| `OPENCODE_DISABLE_ISOLATION` | Set to any value to skip iptables firewall setup |

By default, the container blocks all outbound traffic except:
- DNS
- Package registries (apt, npm, pip)
- Configured LLM provider hosts

Requires `--cap-add=NET_ADMIN` for iptables. Without it, isolation is skipped silently.

### Permissions

| Variable | Purpose |
|---|---|
| `OPENCODE_PERMISSION` | Override tool permissions (default: `{"*":"allow"}`) |

### Custom CA Certificates

For environments with TLS-intercepting proxies or private CA infrastructure, you can inject a custom root CA certificate. It will be trusted by:

- **System-wide** — added via `update-ca-certificates`
- **Node.js / Bun** — via `NODE_EXTRA_CA_CERTS`
- **Python** — via `SSL_CERT_FILE` and `REQUESTS_CA_BUNDLE`
- **Go / opencode** — via `SSL_CERT_DIR` and system cert store

| Variable | Purpose |
|---|---|
| `CUSTOM_CA_CERT_PATH` | Path to a PEM certificate file mounted into the container |
| `CUSTOM_CA_CERT` | PEM certificate contents passed inline as an environment variable |

#### Option 1: Mount a certificate file

```bash
docker run --rm -it \
  -v ./my-corp-ca.pem:/certs/ca.pem:ro \
  -e CUSTOM_CA_CERT_PATH=/certs/ca.pem \
  -v "$(pwd):/workspace" \
  -w /workspace \
  dhi.io/opencode
```

#### Option 2: Pass certificate inline

```bash
docker run --rm -it \
  -e CUSTOM_CA_CERT="$(cat my-corp-ca.pem)" \
  -v "$(pwd):/workspace" \
  -w /workspace \
  dhi.io/opencode
```

If both `CUSTOM_CA_CERT_PATH` and `CUSTOM_CA_CERT` are set, `CUSTOM_CA_CERT_PATH` takes precedence.

## Docker Compose Example

```yaml
services:
  opencode:
    image: dhi.io/opencode
    cap_add:
      - NET_ADMIN
    volumes:
      - ./project:/workspace
      - ./my-corp-ca.pem:/certs/ca.pem:ro
    working_dir: /workspace
    environment:
      OLLAMA_HOST: http://host.docker.internal:11434
      CUSTOM_CA_CERT_PATH: /certs/ca.pem
    stdin_open: true
    tty: true
```

## Image Details

- **Base**: `dhi.io/debian-base` (hardened Debian Bookworm, zero CVEs)
- **Architectures**: `amd64`, `arm64`
- **Pre-installed tools**: `ripgrep`
- **Entrypoint**: Sets up CA certs, configures iptables isolation, then execs opencode
