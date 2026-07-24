# Containerized `opencode` (Podman)

## Install

**macOS / Linux:**
```sh
curl -fsSL https://raw.githubusercontent.com/EdikSimonian/opencode/dev/scripts/opencode-container/install.sh | sh
# or, from a checkout:
sh scripts/opencode-container/install.sh
```

**Windows (PowerShell):**
```powershell
irm https://raw.githubusercontent.com/EdikSimonian/opencode/dev/scripts/opencode-container/install.ps1 | iex
# or, from a checkout:
pwsh -File scripts\opencode-container\install.ps1
```

Then open a new terminal (or `source` your shell rc / `. $PROFILE`) and run
`opencode` in a project — the first run prompts for your server + API key.

## What this is

Run `opencode` **inside a container** instead of installing the native binary —
using **Podman**, a free, open-source, daemonless Docker replacement. It **does
not touch any existing Docker install**: the wrapper calls `podman` directly and
Podman keeps its own separate image store (and, on macOS/Windows, its own VM).
The runtime is used **only** for opencode.

On first launch you're asked for a **server (LiteLLM base URL)** and an **API
key**. They're stored on the host and passed into the container **read-only**.

## What the installer does
1. Installs Podman (with confirmation). **No Homebrew or winget required** — it
   uses them if present, otherwise downloads the **official signed Podman
   installer** (macOS `.pkg`, verified by macOS; Windows setup `.exe`, Authenticode
   signed). Linux uses the distro package manager. On macOS without Homebrew it
   also fetches a checksum-verified static `jq`. Skips if Podman is already present.
2. Starts the Podman machine (macOS/Windows VM); on macOS it shares `/Users` and
   `/Volumes` so projects outside `$HOME` work.
3. Pulls `docker.io/edisimon/opencode:latest`.
4. Installs the `opencode` command (a small wrapper on your `PATH`, so it works in
   bash/zsh/fish/PowerShell) and offers to run first-time setup.

## First-run setup

The first time you run `opencode` (or via `opencode-setup`) you'll be prompted:

```
LiteLLM server base URL (e.g. https://ai.simonian.online): https://ai.simonian.online
API key (input hidden): ********
```

The key is validated against `<server>/v1/models` (which also auto-discovers the
models your server offers), then written to:

- `~/.config/opencode-container/opencode.json` — provider config (`baseURL`, model list)
- `~/.config/opencode-container/auth.json` — the API key, **`chmod 600`** (dir `chmod 700`)

The key is never echoed to the terminal and never passed as a command-line
argument (so it won't land in shell history or the process list).

## Commands

| Command | What it does |
|---|---|
| `opencode [...]` | Run opencode in the container, current folder mounted at `/work` |
| `opencode-setup` | (Re)enter the server URL + API key |
| `opencode-reauth` | Forget stored creds and re-run setup |
| `opencode-update` | `podman pull` the latest image |

The project is mounted at the **git repo root** (so running from a subdirectory
still sees `.git`, `AGENTS.md`, `.opencode/`), with your subdir as the working
directory. Sessions/state persist on the host under `~/.local/share/opencode`.

**Resource cleanup (macOS/Windows):** the Podman machine is a VM. If `opencode`
had to **start** it and, on exit, **no other Podman containers are running**, it
stops the machine again to free RAM/CPU. It will *not* stop a machine that was
already running when you launched (so it never disrupts other Podman work). Set
`OPENCODE_KEEP_MACHINE=1` to leave the machine running (faster repeated launches).

## How credentials reach the container

- Config + key files live only in `~/.config/opencode-container/`.
- They are mounted into the container **read-only** (`:ro`), so the container can
  *read* them to authenticate but cannot modify/rotate them.
- **Note:** read-only protects against tampering, not against use — code running
  in the container can read the key in order to call your LiteLLM. This is
  inherent to running an agent that must authenticate; scope each student key
  accordingly on the LiteLLM side.

## Network isolation & sandboxing

By default the container runs on a dedicated, **egress-filtered** network so a
misbehaving agent (or weak model) can't reach anything it shouldn't:

- **Outbound → public internet only.** The container **cannot initiate**
  connections to your **LAN**, your **host**, link-local or CGNAT addresses
  (`10/8`, `172.16/12`, `192.168/16`, `169.254/16`, `100.64/10` are dropped). It
  can't poke your router, NAS, or host services — only the internet (e.g. your
  LiteLLM server).
- **Inbound still works.** Replies to inbound connections aren't filtered, so
  ports you publish remain reachable. See **Inbound ports** below.
- **No privilege escalation.** The container drops **all Linux capabilities**
  (`--cap-drop=ALL`) and sets **`no-new-privileges`**. Combined with Podman's
  **rootless** mode — where container UID 0 maps to your **non-root** host user —
  code in the container cannot become root on your host.

The filter is an `nftables` rule installed inside Podman's network namespace on
each launch and **verified before the session starts**. On macOS/Windows that
namespace lives inside the Podman VM, so **nothing on your host firewall is
touched**.

**Caveat — services on your LAN.** Since all private ranges are blocked, a
LiteLLM/registry/proxy hosted on your **LAN** is blocked too. A public server
(e.g. `https://ai.simonian.online`) is unaffected. To allow a specific LAN
destination (macOS/Linux):

```sh
OPENCODE_ALLOW="192.168.0.50/32" opencode      # permit one LAN host through the filter
```

### Inbound ports

opencode's TUI doesn't listen on anything, but if the agent starts a dev server
(or you run `opencode serve`), publish the port(s) to reach them from the host:

```sh
OPENCODE_PUBLISH="3000"            opencode     # one port
OPENCODE_PUBLISH="3000 8000-8010"  opencode     # ports + a range
OPENCODE_PUBLISH_ADDR=0.0.0.0 OPENCODE_PUBLISH="3000" opencode   # also reachable from the LAN
```

Ports publish to **`127.0.0.1` by default** (only your machine can reach them).
There is **no "publish all 65535"**: privileged ports (`<1024`) need root to
bind, and a single already-used host port aborts the whole range — so publish the
specific ports/ranges you need.

### Isolation env vars

| Var | Effect |
|---|---|
| `OPENCODE_PUBLISH` | Space/comma list of container ports/ranges to expose for inbound |
| `OPENCODE_PUBLISH_ADDR` | Host address to publish on (default `127.0.0.1`; `0.0.0.0` = LAN-reachable) |
| `OPENCODE_ALLOW` | Extra destination CIDRs to permit through the egress filter (e.g. a LAN LiteLLM) |
| `OPENCODE_REQUIRE_ISOLATION=1` | Refuse to start if the egress filter can't be confirmed (fail-closed) |
| `OPENCODE_NO_ISOLATION=1` | Run on the default bridge with **no** egress filter (opt-out) |

## Provider env vars (optional)

If set in your shell, these are forwarded into the container:
`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `GEMINI_API_KEY`,
`GITHUB_TOKEN`, `GITLAB_TOKEN`, AWS/Azure keys, `OPENCODE_AUTH_CONTENT`,
`OPENCODE_CONFIG_CONTENT`. For the LiteLLM setup above you don't need any of these.

## Limitations

- **Tools run inside the image.** opencode executes shell/build/test/git commands
  *inside* the container, a slim Debian image bundling `git`, `ripgrep`,
  **Node.js (current LTS) + npm**, and **Python 3 + pip/venv** (plus `ca-certificates`).
  So `npm`/`node` and `python`/`pip` work out of the box; **other** runtimes (Go,
  Rust, Java, …) are **not** present and would need adding to the image. Your
  `~/.gitconfig` is mounted read-only so git identity works.
- **Browser/OAuth logins won't work** from inside the container (a `localhost`
  callback can't reach your host browser). The LiteLLM API-key flow used here
  avoids that entirely.
- **macOS:** projects must be under a path the Podman machine shares (`/Users`,
  `/Volumes` by default). For other locations, re-init the machine with an extra
  `-v <path>:<path>`.
- **SELinux (Fedora/RHEL):** the installer detects enforcing mode and relabels
  bind mounts (`:z`).
- **Windows:** Podman uses a WSL2 backend; `install.ps1` is authored but should be
  validated on a real Windows host before classroom use.

## Troubleshooting

**`opencode` (or any `podman` command) hangs / the TUI won't load.** The Podman
machine (VM) is likely wedged — once `podman info`/`podman pull` hang, everything
does. Reset it:
```sh
podman machine stop; podman machine start
podman info >/dev/null && echo OK   # retry once if it says "connection reset" (SSH not ready yet)
```
The installer provisions the machine with 4 GiB to avoid the OOM-wedge the 2 GiB
default hits under load. If you still see wedges, give it more: `podman machine
stop && podman machine set --memory 6144 && podman machine start`.

## Uninstall

```sh
rm -rf ~/.opencode-container ~/.config/opencode-container
# then remove the block between the "# >>> opencode-container >>>" /
# "# <<< opencode-container <<<" markers from your shell rc (or $PROFILE)
```
Podman itself is left installed (remove with `brew uninstall podman` /
`winget uninstall RedHat.Podman` / your package manager if you also want it gone).
Any existing Docker install is unaffected throughout.
