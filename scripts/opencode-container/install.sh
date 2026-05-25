#!/bin/sh
# opencode-container installer (macOS + Linux)
#
# Installs Podman -- a free, open-source, daemonless Docker replacement -- WITHOUT
# touching any existing Docker install, then installs an `opencode` command that
# runs the opencode container image with your project mounted as the working dir.
#
# On first launch, `opencode` asks for a server (LiteLLM base URL) + API key,
# stores them on the host (chmod 600), and passes them into the container
# read-only. Nothing about an existing Docker setup is modified.
#
# Usage:  curl -fsSL <url>/install.sh | sh
#     or  sh install.sh
set -eu

IMAGE="docker.io/edisimon/opencode:latest"
BIN_DIR="$HOME/.opencode-container/bin"
CREDS_DIR="$HOME/.config/opencode-container"
MARKER_START="# >>> opencode-container >>>"
MARKER_END="# <<< opencode-container <<<"

info() { printf '\033[36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[33mwarning:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }
confirm() {
  printf '%s [y/N] ' "$1"
  IFS= read -r _a </dev/tty 2>/dev/null || return 1
  case "$_a" in [yY] | [yY][eE][sS]) return 0 ;; *) return 1 ;; esac
}

OS=$(uname -s)
case "$OS" in
  Darwin) PLATFORM=mac ;;
  Linux) PLATFORM=linux ;;
  *) die "unsupported OS '$OS' -- on Windows use install.ps1" ;;
esac

# ----------------------------------------------------------------------------
# 1. Container runtime: Podman (do not touch any existing Docker)
# ----------------------------------------------------------------------------
if have docker; then
  info "Existing Docker detected -- it will NOT be modified. opencode uses Podman separately."
fi

OC_SEL=""

# First matching release-asset URL from a repo's latest GitHub release (no jq).
gh_latest_asset() { # $1=owner/repo  $2=ERE matched against the download URL
  curl -fsSL "https://api.github.com/repos/$1/releases/latest" \
    | grep -o '"browser_download_url"[^,]*' \
    | sed -E 's/.*"(https:[^"]+)".*/\1/' \
    | grep -E "$2" | head -1
}
sha256_of() { if have sha256sum; then sha256sum "$1" | awk '{print $1}'; else shasum -a 256 "$1" | awk '{print $1}'; fi; }

# macOS: prefer Homebrew if present, else the official signed Podman .pkg (no brew needed).
install_podman_mac() {
  if have brew; then info "Installing Podman via Homebrew..."; brew install podman; return 0; fi
  info "Homebrew not found -- downloading the official Podman macOS installer (.pkg)."
  case "$(uname -m)" in arm64) a='arm64|aarch64' ;; *) a='amd64|x86_64' ;; esac
  url=$(gh_latest_asset containers/podman "installer-macos.*($a).*\.pkg")
  [ -n "$url" ] || url=$(gh_latest_asset containers/podman "installer-macos.*\.pkg")
  [ -n "$url" ] || die "could not locate a Podman macOS .pkg in the latest release."
  tmp=$(mktemp -d); curl -fsSL "$url" -o "$tmp/podman.pkg" || die "Podman .pkg download failed."
  info "Installing Podman (sudo; macOS verifies the package signature)..."
  sudo installer -pkg "$tmp/podman.pkg" -target / || { rm -rf "$tmp"; die "Podman .pkg install failed."; }
  rm -rf "$tmp"
  [ -d /opt/podman/bin ] && PATH="/opt/podman/bin:$PATH" && export PATH
}

# Linux: distro package manager (standard; rootless Podman needs distro helpers).
install_podman_linux() {
  SUDO=""; [ "$(id -u)" -eq 0 ] || SUDO="sudo"
  if have apt-get;  then $SUDO apt-get update && $SUDO apt-get install -y podman jq curl
  elif have dnf;    then $SUDO dnf install -y podman jq curl
  elif have yum;    then $SUDO yum install -y podman jq curl
  elif have pacman; then $SUDO pacman -Sy --noconfirm podman jq curl
  elif have zypper; then $SUDO zypper install -y podman jq curl
  elif have apk;    then $SUDO apk add podman jq curl
  else die "no supported package manager (apt/dnf/yum/pacman/zypper/apk). Install podman+jq+curl manually, then re-run."
  fi
}

install_podman() {
  if have podman; then info "Podman already installed ($(podman --version 2>/dev/null))."; return 0; fi
  info "Podman (free, open-source Docker replacement) is required and not installed."
  confirm "Install Podman now?" || die "Podman is required. Aborting (nothing was changed)."
  case "$PLATFORM" in mac) install_podman_mac ;; linux) install_podman_linux ;; esac
  have podman || die "Podman installed but not on PATH yet -- open a new shell and re-run."
}

# jq powers first-run setup. Use distro/brew copy if present; otherwise fetch the
# official static jq binary into our bin dir (checksum-verified, no brew needed).
ensure_jq() {
  have jq && return 0
  if have brew; then brew install jq; return 0; fi
  JQ_VER=1.7.1
  case "$(uname -s)-$(uname -m)" in
    Darwin-arm64)                jqf=jq-macos-arm64 ;;
    Darwin-x86_64)               jqf=jq-macos-amd64 ;;
    Linux-x86_64)                jqf=jq-linux-amd64 ;;
    Linux-aarch64 | Linux-arm64) jqf=jq-linux-arm64 ;;
    *) die "no prebuilt jq for $(uname -s)-$(uname -m); install jq manually and re-run." ;;
  esac
  base="https://github.com/jqlang/jq/releases/download/jq-$JQ_VER"
  info "Downloading jq $JQ_VER ($jqf)..."
  mkdir -p "$BIN_DIR"
  curl -fsSL "$base/$jqf" -o "$BIN_DIR/jq" || die "jq download failed."
  tmp=$(mktemp -d)
  if curl -fsSL "$base/sha256sum.txt" -o "$tmp/sums" 2>/dev/null; then
    want=$(awk -v f="$jqf" '$2 ~ f {print $1}' "$tmp/sums" | head -1)
    got=$(sha256_of "$BIN_DIR/jq")
    if [ -n "$want" ] && [ "$want" != "$got" ]; then rm -rf "$tmp" "$BIN_DIR/jq"; die "jq checksum mismatch (want $want, got $got)."; fi
    [ -n "$want" ] && info "jq checksum verified."
  else
    warn "could not fetch jq checksums; proceeding (HTTPS download from github.com/jqlang/jq)."
  fi
  rm -rf "$tmp"; chmod +x "$BIN_DIR/jq"
}

ensure_runtime_ready() {
  if [ "$PLATFORM" = mac ]; then
    # macOS runs containers in a Podman machine (Linux VM). The default machine
    # only shares $HOME, so broaden mounts to cover arbitrary project paths.
    if ! podman machine inspect >/dev/null 2>&1; then
      info "Initializing Podman machine (shares /Users and /Volumes)..."
      podman machine init -v /Users:/Users -v /Volumes:/Volumes
    fi
    podman machine start >/dev/null 2>&1 || true
  else
    # SELinux-enforcing hosts deny unlabeled bind mounts -> relabel with :z.
    if have getenforce && [ "$(getenforce 2>/dev/null || true)" = "Enforcing" ]; then
      OC_SEL="z"
      info "SELinux enforcing -> bind mounts will be relabeled (:z)."
    fi
  fi
  podman info >/dev/null 2>&1 || die "podman is installed but not ready (try: podman machine start)."
}

# ----------------------------------------------------------------------------
# 2. Host state dirs (writable) + pull image
# ----------------------------------------------------------------------------
prepare_host() {
  for d in "$HOME/.local/share/opencode" "$HOME/.local/state/opencode" \
           "$HOME/.cache/opencode" "$CREDS_DIR" "$BIN_DIR"; do
    mkdir -p "$d"
  done
  chmod 700 "$CREDS_DIR"
  info "Pulling $IMAGE ..."
  podman pull "$IMAGE"
}

# ----------------------------------------------------------------------------
# 3. Write the wrapper commands into ~/.opencode-container/bin
# ----------------------------------------------------------------------------
write_wrappers() {
  # opencode-setup: first-run credential capture (server + key -> host files)
  cat > "$BIN_DIR/opencode-setup" <<'SETUP'
#!/bin/sh
set -u
# Find our co-located helpers (e.g. a bundled jq) first.
PATH="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd):$PATH"; export PATH
CREDS="$HOME/.config/opencode-container"
for t in podman jq curl; do command -v "$t" >/dev/null 2>&1 || { echo "opencode-setup: '$t' is required" >&2; exit 1; }; done
printf 'opencode first-time setup\n'
printf 'LiteLLM server base URL (e.g. https://ai.simonian.online): '
IFS= read -r srv </dev/tty || exit 1
[ -n "$srv" ] || { echo "no server entered" >&2; exit 1; }
case "$srv" in */v1 | */v1/) srv="${srv%/}" ;; *) srv="${srv%/}/v1" ;; esac
printf 'API key (input hidden): '
stty -echo </dev/tty 2>/dev/null || true
IFS= read -r key </dev/tty || { stty echo </dev/tty 2>/dev/null || true; exit 1; }
stty echo </dev/tty 2>/dev/null || true
printf '\n'
[ -n "$key" ] || { echo "no key entered" >&2; exit 1; }
printf 'validating %s/models ...\n' "$srv"
models_json=$(curl -fsS "$srv/models" -H "Authorization: Bearer $key") \
  || { echo "could not reach $srv/models, or the key was rejected" >&2; exit 1; }
ids=$(printf '%s' "$models_json" | jq -r '.data[].id' 2>/dev/null) \
  || { echo "unexpected response from $srv/models" >&2; exit 1; }
[ -n "$ids" ] || { echo "no models returned by $srv/models" >&2; exit 1; }
default=$(printf '%s\n' "$ids" | head -1)
models=$(printf '%s' "$models_json" | jq '[.data[].id]
  | map({key: ., value: {id: ., tool_call: true, attachment: true, temperature: true,
                         reasoning: false, limit: {context: 128000, output: 8192},
                         cost: {input: 0, output: 0}}})
  | from_entries')
mkdir -p "$CREDS"; chmod 700 "$CREDS"
jq -n --arg base "$srv" --arg model "litellm/$default" --argjson models "$models" \
  '{"$schema":"https://opencode.ai/config.json", model:$model,
    provider:{litellm:{name:"LiteLLM", npm:"@ai-sdk/openai-compatible",
                       options:{baseURL:$base}, models:$models}}}' \
  > "$CREDS/opencode.json"
( umask 177; jq -n --arg key "$key" '{litellm:{type:"api", key:$key}}' > "$CREDS/auth.json" )
chmod 600 "$CREDS/auth.json"
key=""
printf 'Saved %s/{opencode.json,auth.json} (chmod 600). Default model: %s. Discovered %s model(s).\n' \
  "$CREDS" "$default" "$(printf '%s\n' "$ids" | wc -l | tr -d ' ')"
SETUP

  # opencode: the main wrapper (runs the container)
  cat > "$BIN_DIR/opencode" <<'RUN'
#!/bin/sh
set -u
IMAGE="${OPENCODE_IMAGE:-docker.io/edisimon/opencode:latest}"
SEL="__OC_SEL__"
CREDS="$HOME/.config/opencode-container"
BIN=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

[ -f "$CREDS/auth.json" ] || { "$BIN/opencode-setup" || exit 1; }

if ! podman info >/dev/null 2>&1; then
  podman machine start >/dev/null 2>&1 || true
  podman info >/dev/null 2>&1 || { echo "opencode: podman is not ready (try: podman machine start)" >&2; exit 1; }
fi

root=$(git rev-parse --show-toplevel 2>/dev/null || printf '%s' "$PWD")
rel=${PWD#"$root"}; rel=${rel#/}
tty=""; [ -t 0 ] && tty="-t"
z=""; zro=":ro"
[ -n "$SEL" ] && { z=":$SEL"; zro=":ro,$SEL"; }

gitmount=""
[ -f "$HOME/.gitconfig" ] && gitmount="-v $HOME/.gitconfig:/oc/.gitconfig$zro"

envflags=""
for v in ANTHROPIC_API_KEY OPENAI_API_KEY OPENROUTER_API_KEY GEMINI_API_KEY \
         GOOGLE_GENERATIVE_AI_API_KEY AZURE_OPENAI_API_KEY AWS_ACCESS_KEY_ID \
         AWS_SECRET_ACCESS_KEY AWS_REGION GITHUB_TOKEN GITLAB_TOKEN \
         CLOUDFLARE_API_TOKEN OPENCODE_AUTH_CONTENT OPENCODE_CONFIG_CONTENT; do
  eval "val=\${$v:-}"
  [ -n "$val" ] && envflags="$envflags -e $v"
done

# shellcheck disable=SC2086
exec podman run --rm -i $tty \
  -v "$root:/work$z" -w "/work${rel:+/$rel}" \
  -e HOME=/oc -e XDG_CONFIG_HOME=/oc/.config -e XDG_DATA_HOME=/oc/.local/share \
  -e XDG_STATE_HOME=/oc/.local/state -e XDG_CACHE_HOME=/oc/.cache \
  -v "$HOME/.local/share/opencode:/oc/.local/share/opencode$z" \
  -v "$HOME/.local/state/opencode:/oc/.local/state/opencode$z" \
  -v "$HOME/.cache/opencode:/oc/.cache/opencode$z" \
  -v "$CREDS/opencode.json:/oc/.config/opencode/opencode.json$zro" \
  -v "$CREDS/auth.json:/oc/.local/share/opencode/auth.json$zro" \
  $gitmount $envflags "$IMAGE" "$@"
RUN

  # opencode-update / opencode-reauth helpers
  cat > "$BIN_DIR/opencode-update" <<'UPD'
#!/bin/sh
exec podman pull "${OPENCODE_IMAGE:-docker.io/edisimon/opencode:latest}"
UPD
  cat > "$BIN_DIR/opencode-reauth" <<'REAUTH'
#!/bin/sh
CREDS="$HOME/.config/opencode-container"
rm -f "$CREDS/auth.json" "$CREDS/opencode.json"
BIN=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec "$BIN/opencode-setup"
REAUTH

  # Bake the SELinux label decision into the run wrapper.
  sed -i.bak "s|__OC_SEL__|$OC_SEL|" "$BIN_DIR/opencode" && rm -f "$BIN_DIR/opencode.bak"
  chmod +x "$BIN_DIR/opencode" "$BIN_DIR/opencode-setup" "$BIN_DIR/opencode-update" "$BIN_DIR/opencode-reauth"
  info "Installed wrappers in $BIN_DIR"
}

# ----------------------------------------------------------------------------
# 4. Put ~/.opencode-container/bin on PATH (idempotent, per shell)
# ----------------------------------------------------------------------------
add_to_path() {
  shell=$(basename "${SHELL:-sh}")
  case "$shell" in
    fish) rc="$HOME/.config/fish/config.fish"; line="fish_add_path $BIN_DIR" ;;
    zsh)  rc="${ZDOTDIR:-$HOME}/.zshrc";        line="export PATH=\"$BIN_DIR:\$PATH\"" ;;
    bash) if [ -f "$HOME/.bashrc" ]; then rc="$HOME/.bashrc"; else rc="$HOME/.bash_profile"; fi
          line="export PATH=\"$BIN_DIR:\$PATH\"" ;;
    *)    rc="$HOME/.profile"; line="export PATH=\"$BIN_DIR:\$PATH\"" ;;
  esac
  mkdir -p "$(dirname "$rc")"; touch "$rc"
  if grep -qF "$MARKER_START" "$rc" 2>/dev/null; then
    info "PATH entry already present in $rc"
  else
    printf '\n%s\n%s\n%s\n' "$MARKER_START" "$line" "$MARKER_END" >> "$rc"
    info "Added $BIN_DIR to PATH in $rc"
  fi
  RC_FILE="$rc"
}

# ----------------------------------------------------------------------------
main() {
  info "Installing containerized opencode (Podman runtime)."
  install_podman
  ensure_jq
  ensure_runtime_ready
  prepare_host
  write_wrappers
  add_to_path
  printf '\n'
  info "Done. Open a new terminal (or: source \"$RC_FILE\"), then run 'opencode' in a project."
  info "First run will prompt for your LiteLLM server + API key."
  if confirm "Run the server/API-key setup now?"; then
    "$BIN_DIR/opencode-setup" || warn "Setup did not complete; it will run again on first 'opencode'."
  fi
}
main
