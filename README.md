<p align="center">
  <picture>
    <source srcset="logo-es-dark.svg" media="(prefers-color-scheme: dark)">
    <source srcset="logo-es-light.svg" media="(prefers-color-scheme: light)">
    <img src="logo-es-light.svg" alt="opencode es logo">
  </picture>
</p>
<p align="center">The open source AI coding agent — local first.</p>

---

## Local Fork Changes

This is a modified build of OpenCode with the following customizations:

### Local Provider Auto-Detection
- **Ollama** (`localhost:11434`) and **LMStudio** (`localhost:1234`) are automatically detected at startup. If either is running, their installed models are fetched and made available — no API key or config required.
- Ollama is preferred as the default model provider, with LMStudio as the fallback, before any cloud provider.
- Ollama requests use `num_ctx: 32768` to give the model enough context for the system prompt and tools (Ollama's default of 2048 is far too small).
- `stream_options: { include_usage: true }` is disabled for both local providers to prevent silent stream hangs.

### Cloud Providers Hidden by Default
The following providers are removed from both the active provider list and the "Connect a provider" dialog unless explicitly enabled in config:
- **OpenCode Zen** (`opencode`, `opencode-go`) — removed with all its models (Big Pickle, MinMax, etc.)
- **Groq** (`groq`)
- **ZenMux** (`zenmux`)

To re-enable any of them, add them to `enabled_providers` in your `opencode.json`.

### Install (from GitHub releases)

```bash
curl -fsSL https://raw.githubusercontent.com/EdikSimonian/opencode/dev/install.sh | sudo sh
```

Detects your OS and architecture automatically, installs to `/usr/local/bin/opencode`.

### Upgrade

From the command line:
```bash
opencode upgrade
```

Or reinstall the latest release:
```bash
curl -fsSL https://raw.githubusercontent.com/EdikSimonian/opencode/dev/install.sh | sudo sh
```

### Dev Mode (no build required)

```bash
bun install
bun run dev   # runs TypeScript directly via Bun from packages/opencode/src/index.ts
```

### Build

```bash
bun install
cd packages/opencode
bun run build --single   # current platform only (macOS arm64)
bun run build            # all platforms (linux/darwin/musl/x64/arm64)
```

Binary output: `packages/opencode/dist/opencode-darwin-arm64/bin/opencode`

### Release

Tag a version to trigger the GitHub Actions build and publish binaries:
```bash
git tag v0.1.5
git push origin v0.1.5
```

### Docker

A pre-built multi-arch image (`linux/amd64`, `linux/arm64`) is published to GitHub Container Registry on every release and automatically rebuilt daily when the base image updates:

```bash
docker pull ghcr.io/ediksimonian/opencode:latest
```

#### Base image

The image is built on **[`dhi.io/debian-base:bookworm`](https://hub.docker.com/hardened-images/catalog/dhi/debian-base)** — Docker's official hardened Debian base image. It is:

- Published with **zero known CVEs**, maintained by Docker with critical/high patches within 7 days
- Signed with **SLSA Level 3 provenance** and includes a full SBOM
- Rebuilt nightly; this image automatically rebuilds whenever its digest changes

#### With Ollama

Ollama runs on your host machine. On macOS with Docker Desktop, `host.docker.internal` resolves to the host automatically:

```bash
docker run -it --rm \
  --cap-add NET_ADMIN \
  -v /path/to/your/project:/workspace \
  -w /workspace \
  -e OLLAMA_HOST=http://host.docker.internal:11434 \
  ghcr.io/ediksimonian/opencode:latest
```

On Linux, use `--add-host` since `host.docker.internal` isn't automatic:

```bash
docker run -it --rm \
  --cap-add NET_ADMIN \
  -v /path/to/your/project:/workspace \
  -w /workspace \
  --add-host=host.docker.internal:host-gateway \
  -e OLLAMA_HOST=http://host.docker.internal:11434 \
  ghcr.io/ediksimonian/opencode:latest
```

#### With Open WebUI

Generate an API key in Open WebUI under **Settings → Account → API Keys**, then:

```bash
docker run -it --rm \
  --cap-add NET_ADMIN \
  -v /path/to/your/project:/workspace \
  -w /workspace \
  -e OPENWEBUI_HOST=http://your-openwebui-url \
  -e OPENWEBUI_API_KEY=your-api-key \
  ghcr.io/ediksimonian/opencode:latest
```

#### Network isolation

`--cap-add NET_ADMIN` enables network isolation at startup:

- All outbound IPv4 and IPv6 traffic is blocked by default
- Only the provider hosts passed via `OLLAMA_HOST`, `LMSTUDIO_HOST`, or `OPENWEBUI_HOST` are allowed through
- DNS is always allowed so hostnames resolve correctly
- `CAP_NET_ADMIN` is dropped before opencode starts, so the process cannot modify the firewall rules at runtime
- The container runs as root so it can freely install packages (`npm install`, `pip install`, `apt-get`, etc.)

Without `--cap-add NET_ADMIN` the container starts normally with no network restrictions.

To disable isolation while keeping `--cap-add NET_ADMIN` (e.g. for debugging):

```bash
-e OPENCODE_DISABLE_ISOLATION=1
```

#### Environment variables

| Variable | Description |
|---|---|
| `OLLAMA_HOST` | Ollama base URL (e.g. `http://host.docker.internal:11434`) |
| `LMSTUDIO_HOST` | LM Studio base URL (e.g. `http://host.docker.internal:1234`) |
| `OPENWEBUI_HOST` | Open WebUI base URL |
| `OPENWEBUI_API_KEY` | Open WebUI API key |
| `OPENCODE_DISABLE_ISOLATION` | Set to any value to skip network isolation entirely |
| `OPENCODE_PERMISSION` | Override tool permissions (default: `{"*":"allow"}`) |

#### Persisting config

Mount your opencode config directory to preserve settings between runs:

```bash
-v ~/.config/opencode:/root/.config/opencode
```

#### Building locally

```bash
bun install
cd packages/opencode && bun run build
docker build -t opencode packages/opencode
```

---
<p align="center">
  <a href="https://opencode.ai/discord"><img alt="Discord" src="https://img.shields.io/discord/1391832426048651334?style=flat-square&label=discord" /></a>
  <a href="https://www.npmjs.com/package/opencode-ai"><img alt="npm" src="https://img.shields.io/npm/v/opencode-ai?style=flat-square" /></a>
  <a href="https://github.com/anomalyco/opencode/actions/workflows/publish.yml"><img alt="Build status" src="https://img.shields.io/github/actions/workflow/status/anomalyco/opencode/publish.yml?style=flat-square&branch=dev" /></a>
</p>

<p align="center">
  <a href="README.md">English</a> |
  <a href="README.zh.md">简体中文</a> |
  <a href="README.zht.md">繁體中文</a> |
  <a href="README.ko.md">한국어</a> |
  <a href="README.de.md">Deutsch</a> |
  <a href="README.es.md">Español</a> |
  <a href="README.fr.md">Français</a> |
  <a href="README.it.md">Italiano</a> |
  <a href="README.da.md">Dansk</a> |
  <a href="README.ja.md">日本語</a> |
  <a href="README.pl.md">Polski</a> |
  <a href="README.ru.md">Русский</a> |
  <a href="README.bs.md">Bosanski</a> |
  <a href="README.ar.md">العربية</a> |
  <a href="README.no.md">Norsk</a> |
  <a href="README.br.md">Português (Brasil)</a> |
  <a href="README.th.md">ไทย</a> |
  <a href="README.tr.md">Türkçe</a> |
  <a href="README.uk.md">Українська</a> |
  <a href="README.bn.md">বাংলা</a> |
  <a href="README.gr.md">Ελληνικά</a>
</p>

[![OpenCode Terminal UI](packages/web/src/assets/lander/screenshot.png)](https://opencode.ai)

---

### Installation

```bash
# YOLO
curl -fsSL https://opencode.ai/install | bash

# Package managers
npm i -g opencode-ai@latest        # or bun/pnpm/yarn
scoop install opencode             # Windows
choco install opencode             # Windows
brew install anomalyco/tap/opencode # macOS and Linux (recommended, always up to date)
brew install opencode              # macOS and Linux (official brew formula, updated less)
sudo pacman -S opencode            # Arch Linux (Stable)
paru -S opencode-bin               # Arch Linux (Latest from AUR)
mise use -g opencode               # Any OS
nix run nixpkgs#opencode           # or github:anomalyco/opencode for latest dev branch
```

> [!TIP]
> Remove versions older than 0.1.x before installing.

### Desktop App (BETA)

OpenCode is also available as a desktop application. Download directly from the [releases page](https://github.com/anomalyco/opencode/releases) or [opencode.ai/download](https://opencode.ai/download).

| Platform              | Download                              |
| --------------------- | ------------------------------------- |
| macOS (Apple Silicon) | `opencode-desktop-darwin-aarch64.dmg` |
| macOS (Intel)         | `opencode-desktop-darwin-x64.dmg`     |
| Windows               | `opencode-desktop-windows-x64.exe`    |
| Linux                 | `.deb`, `.rpm`, or AppImage           |

```bash
# macOS (Homebrew)
brew install --cask opencode-desktop
# Windows (Scoop)
scoop bucket add extras; scoop install extras/opencode-desktop
```

#### Installation Directory

The install script respects the following priority order for the installation path:

1. `$OPENCODE_INSTALL_DIR` - Custom installation directory
2. `$XDG_BIN_DIR` - XDG Base Directory Specification compliant path
3. `$HOME/bin` - Standard user binary directory (if it exists or can be created)
4. `$HOME/.opencode/bin` - Default fallback

```bash
# Examples
OPENCODE_INSTALL_DIR=/usr/local/bin curl -fsSL https://opencode.ai/install | bash
XDG_BIN_DIR=$HOME/.local/bin curl -fsSL https://opencode.ai/install | bash
```

### Agents

OpenCode includes two built-in agents you can switch between with the `Tab` key.

- **build** - Default, full-access agent for development work
- **plan** - Read-only agent for analysis and code exploration
  - Denies file edits by default
  - Asks permission before running bash commands
  - Ideal for exploring unfamiliar codebases or planning changes

Also included is a **general** subagent for complex searches and multistep tasks.
This is used internally and can be invoked using `@general` in messages.

Learn more about [agents](https://opencode.ai/docs/agents).

### Documentation

For more info on how to configure OpenCode, [**head over to our docs**](https://opencode.ai/docs).

### Contributing

If you're interested in contributing to OpenCode, please read our [contributing docs](./CONTRIBUTING.md) before submitting a pull request.

### Building on OpenCode

If you are working on a project that's related to OpenCode and is using "opencode" as part of its name, for example "opencode-dashboard" or "opencode-mobile", please add a note to your README to clarify that it is not built by the OpenCode team and is not affiliated with us in any way.

### FAQ

#### How is this different from Claude Code?

It's very similar to Claude Code in terms of capability. Here are the key differences:

- 100% open source
- Not coupled to any provider. Although we recommend the models we provide through [OpenCode Zen](https://opencode.ai/zen), OpenCode can be used with Claude, OpenAI, Google, or even local models. As models evolve, the gaps between them will close and pricing will drop, so being provider-agnostic is important.
- Out-of-the-box LSP support
- A focus on TUI. OpenCode is built by neovim users and the creators of [terminal.shop](https://terminal.shop); we are going to push the limits of what's possible in the terminal.
- A client/server architecture. This, for example, can allow OpenCode to run on your computer while you drive it remotely from a mobile app, meaning that the TUI frontend is just one of the possible clients.

---

**Join our community** [Discord](https://discord.gg/opencode) | [X.com](https://x.com/opencode)
