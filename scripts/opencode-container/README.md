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

## Provider env vars (optional)

If set in your shell, these are forwarded into the container:
`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `GEMINI_API_KEY`,
`GITHUB_TOKEN`, `GITLAB_TOKEN`, AWS/Azure keys, `OPENCODE_AUTH_CONTENT`,
`OPENCODE_CONFIG_CONTENT`. For the LiteLLM setup above you don't need any of these.

## Limitations

- **Tools run inside the image.** opencode executes shell/build/test/git commands
  *inside* the container, which is a thin Alpine image (only `ripgrep` + libs). File
  editing and LLM work fine, but your project's language runtimes / build tools are
  **not** present — `npm test`, `go build`, etc. may fail unless added to the image.
  Your `~/.gitconfig` is mounted read-only so git identity works.
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
