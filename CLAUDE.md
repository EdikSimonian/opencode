# opencode fork — Claude notes

## Project overview

This is a fork of `sst/opencode` (`dev` branch) maintained at `EdikSimonian/opencode`.
Key customizations: local provider auto-detection (Ollama, LMStudio, OpenWebUI), cloud providers hidden by default, Docker image with network isolation.

---

## ⚠️ CRITICAL — NEVER RUN OPENCODE AND CAPTURE STDOUT IN A TOOL CALL ⚠️

**THIS WILL INSTANTLY CONSUME THE ENTIRE CONTEXT WINDOW AND EXHAUST THE USER'S CLAUDE USAGE.**

Without a TTY, opencode dumps its entire TUI as raw ANSI escape sequences to stdout.
A single run can produce **tens of thousands of tokens** in one tool result.

```bash
# ❌ NEVER DO THIS — destroys context window
docker run ... opencode
timeout 5 /usr/local/bin/opencode
docker exec container opencode

# ✅ ALWAYS discard stdout, capture only stderr
timeout 5 /usr/local/bin/opencode > /dev/null 2>/tmp/stderr
cat /tmp/stderr

# ✅ Check log files instead
find /root/.local/share/opencode/log -name "*.log" | xargs tail -20
```

This already happened once and spiked usage from 0% to 100% in a single prompt.
**Always redirect stdout to /dev/null when running any TUI application in a tool call.**

---

## Tagging and releasing

**Use `v0.x.x` versioning only.** Do not use v1.x or higher until explicitly told otherwise.

Tags on `v0.x.x` that already exist locally (fetched from upstream sst/opencode) must be
deleted locally before retagging on our commit:

```bash
git tag -d vX.Y.Z 2>/dev/null; git tag vX.Y.Z && git push origin vX.Y.Z
```

## Docker image details

- Base: `dhi.io/debian-base` — hardened Debian with zero CVEs
- Uses glibc binaries (`opencode-linux-x64-baseline`, `opencode-linux-arm64`)
- Entrypoint sets up iptables isolation (REJECT, not DROP) then execs opencode directly
- `OPENCODE_PERMISSION={"*":"allow"}` is baked in to suppress tool confirmation prompts
- Previous blank-screen issues with Debian were misattributed to the base image; the real cause was iptables DROP hanging TCP connections (fixed with REJECT)

## Key env vars (Docker)

| Var | Purpose |
|---|---|
| `OLLAMA_HOST` | Ollama URL (e.g. `http://host.docker.internal:11434`) |
| `LMSTUDIO_HOST` | LM Studio URL |
| `OPENWEBUI_HOST` | Open WebUI URL |
| `OPENWEBUI_API_KEY` | Open WebUI API key |
| `OPENCODE_DISABLE_ISOLATION` | Skip iptables firewall setup |
| `OPENCODE_PERMISSION` | Override tool permissions |

## Automated workflows

- `release-fork.yml` — triggers on `v*` tags, builds binaries + Docker image
- `docker-base-update.yml` — daily at 6am UTC, rebuilds Docker if base image digest changes
- `sync-upstream.yml` — daily at 7am UTC, merges upstream `sst/opencode` if no conflicts

## Provider customizations

- `DEFAULT_DISABLED = ["groq", "zenmux", "opencode", "opencode-go"]` in `provider.ts`
- `routes/provider.ts` returns only connected/autoloaded providers — no cloud suggestions in UI
- Ollama respects `OLLAMA_HOST` env var (falls back to `localhost:11434`)
- LMStudio respects `LMSTUDIO_HOST` env var (falls back to `127.0.0.1:1234`)
- OpenWebUI uses `OPENWEBUI_HOST` + `OPENWEBUI_API_KEY`

## Upstream merges

After `git pull` from upstream, always run `bun install` — upstream often adds new packages
that won't be installed otherwise (e.g. the `which` package broke typecheck after one merge).
