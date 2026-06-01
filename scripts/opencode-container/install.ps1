<#
  opencode-container installer (Windows / PowerShell)

  Installs Podman (a free, open-source Docker replacement, WSL2 backend) WITHOUT
  touching any existing Docker install, then adds `opencode` / `opencode-setup` /
  `opencode-update` / `opencode-reauth` functions to your PowerShell profile.

  `opencode` runs the opencode container image with the current folder mounted as
  the working dir. First launch prompts for a LiteLLM server + API key, stored on
  the host and passed into the container read-only.

  Usage:  irm <url>/install.ps1 | iex
      or  pwsh -File install.ps1
#>
$ErrorActionPreference = 'Stop'
$Image    = 'docker.io/edisimon/opencode:latest'
$CredsDir = Join-Path $HOME '.config\opencode-container'
$MarkerStart = '# >>> opencode-container >>>'
$MarkerEnd   = '# <<< opencode-container <<<'

function Info($m) { Write-Host "==> $m" -ForegroundColor Cyan }
function Warn($m) { Write-Host "warning: $m" -ForegroundColor Yellow }
function Confirm($m) { ($(Read-Host "$m [y/N]") -match '^(y|yes)$') }

# 1. Runtime: Podman (leave any existing Docker alone)
if (Get-Command docker -ErrorAction SilentlyContinue) {
  Info 'Existing Docker detected -- it will NOT be modified. opencode uses Podman separately.'
}
if (-not (Get-Command podman -ErrorAction SilentlyContinue)) {
  Info 'Podman (free, open-source Docker replacement) is required and not installed.'
  if (-not (Confirm 'Install Podman now?')) { throw 'Podman is required. Aborting (nothing changed).' }
  if (Get-Command winget -ErrorAction SilentlyContinue) {
    winget install --id RedHat.Podman -e --accept-source-agreements --accept-package-agreements
  } else {
    Info 'winget not found -- downloading the official signed Podman Windows installer.'
    $rel = Invoke-RestMethod 'https://api.github.com/repos/containers/podman/releases/latest'
    $asset = $rel.assets | Where-Object { $_.name -match 'setup\.exe$' } | Select-Object -First 1
    if (-not $asset) { throw 'could not find a Podman Windows setup .exe in the latest release.' }
    $out = Join-Path $env:TEMP $asset.name
    Info "Downloading $($asset.name)..."
    Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $out
    Info 'Running the signed Podman installer (Windows verifies the signature)...'
    Start-Process -FilePath $out -ArgumentList '/install','/quiet','/norestart' -Wait
  }
  $env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')
}

# Podman on Windows runs containers in a WSL2 machine.
if (-not (podman machine inspect 2>$null)) {
  Info 'Initializing Podman machine (4 GiB RAM, WSL2 backend)...'
  podman machine init --memory 4096
}
podman machine start 2>$null | Out-Null
podman info *> $null
if ($LASTEXITCODE -ne 0) { throw 'podman is installed but not ready (try: podman machine start).' }

# 2. Host state dirs + pull image
foreach ($d in @(
    (Join-Path $HOME '.local\share\opencode'),
    (Join-Path $HOME '.local\state\opencode'),
    (Join-Path $HOME '.cache\opencode'),
    $CredsDir)) { New-Item -ItemType Directory -Force -Path $d | Out-Null }
Info "Pulling $Image ..."
podman pull $Image

# 3. Profile block with the opencode functions
$block = @"
$MarkerStart
`$OPENCODE_IMAGE = '$Image'
`$OPENCODE_CREDS = Join-Path `$HOME '.config\opencode-container'

function opencode-setup {
  `$creds = `$OPENCODE_CREDS
  `$srv = Read-Host 'LiteLLM server base URL (e.g. https://ai.simonian.online)'
  if (-not `$srv) { Write-Error 'no server entered'; return }
  if (`$srv -notmatch '^https?://') { `$srv = "https://`$srv" }
  `$srv = `$srv.TrimEnd('/'); if (`$srv -notmatch '/v1`$') { `$srv = "`$srv/v1" }
  `$sec = Read-Host 'API key (hidden)' -AsSecureString
  `$key = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR(`$sec))
  if (-not `$key) { Write-Error 'no key entered'; return }
  try { `$resp = Invoke-RestMethod -Uri "`$srv/models" -Headers @{ Authorization = "Bearer `$key" } -ErrorAction Stop }
  catch { Write-Error "could not reach `$srv/models, or the key was rejected"; return }
  `$ids = @(`$resp.data.id)
  if (`$ids.Count -eq 0) { Write-Error 'no models returned'; return }
  if (`$ids.Count -le 1) { `$default = `$ids[0] }
  else {
    Write-Host 'Models available:'
    for (`$i = 0; `$i -lt `$ids.Count; `$i++) { Write-Host ('  {0,2}) {1}' -f (`$i + 1), `$ids[`$i]) }
    `$sel = Read-Host "Choose the default model [1-`$(`$ids.Count)] (Enter = 1)"
    if (-not (`$sel -as [int]) -or [int]`$sel -lt 1 -or [int]`$sel -gt `$ids.Count) { `$sel = 1 }
    `$default = `$ids[[int]`$sel - 1]
  }
  Write-Host "Default model: `$default"
  `$models = @{}
  foreach (`$id in `$ids) {
    `$models[`$id] = @{ id = `$id; tool_call = `$true; attachment = `$true; temperature = `$true;
                       reasoning = `$false; limit = @{ context = 128000; output = 8192 };
                       cost = @{ input = 0; output = 0 } }
  }
  `$cfg = [ordered]@{ '`$schema' = 'https://opencode.ai/config.json'; model = "litellm/`$default";
    provider = @{ litellm = @{ name = 'LiteLLM'; npm = '@ai-sdk/openai-compatible';
                               options = @{ baseURL = `$srv }; models = `$models } } }
  New-Item -ItemType Directory -Force -Path `$creds | Out-Null
  `$cfg | ConvertTo-Json -Depth 12 | Set-Content -Path (Join-Path `$creds 'opencode.json') -Encoding utf8
  @{ litellm = @{ type = 'api'; key = `$key } } | ConvertTo-Json -Depth 5 |
    Set-Content -Path (Join-Path `$creds 'auth.json') -Encoding utf8
  icacls (Join-Path `$creds 'auth.json') /inheritance:r /grant:r "`$($env:USERNAME):F" | Out-Null
  Write-Host "Saved `$creds\{opencode.json,auth.json}. Default model: `$default (`$(`$ids.Count) models)."
}

function opencode {
  `$creds = `$OPENCODE_CREDS
  foreach (`$d in @(
      (Join-Path `$HOME '.local\share\opencode'),
      (Join-Path `$HOME '.local\state\opencode'),
      (Join-Path `$HOME '.cache\opencode'),
      `$creds)) { New-Item -ItemType Directory -Force -Path `$d | Out-Null }
  if (-not (Test-Path (Join-Path `$creds 'auth.json'))) { opencode-setup; if (-not (Test-Path (Join-Path `$creds 'auth.json'))) { return } }
  `$started = `$false
  podman info *> `$null; if (`$LASTEXITCODE -ne 0) { podman machine start *> `$null; `$started = `$true }

  # --- network isolation: internet + inbound only; no LAN, no host ------------
  # Drops all caps + blocks privilege escalation, and filters egress so the
  # container can reach the public internet and accept inbound (published) ports
  # but cannot initiate connections to your LAN/host. Env knobs mirror install.sh:
  # OPENCODE_NO_ISOLATION, OPENCODE_REQUIRE_ISOLATION, OPENCODE_PUBLISH[_ADDR].
  `$ocNet = 'opencode'; `$ocSubnet = '10.89.0.0/24'; `$ocHolder = 'opencode-netns-holder'
  `$harden = @('--cap-drop=ALL','--security-opt=no-new-privileges')
  `$netflag = @('--network', `$ocNet)
  if (`$env:OPENCODE_NO_ISOLATION) {
    `$netflag = @()
  } else {
    podman network exists `$ocNet 2>`$null; if (`$LASTEXITCODE -ne 0) { podman network create --subnet `$ocSubnet `$ocNet *> `$null }
    podman rm -f `$ocHolder *> `$null
    # Holder keeps podman's rootless network namespace (where the bridge + filter
    # live) alive for the whole session.
    podman run -d --name `$ocHolder @netflag @harden --entrypoint sleep `$OPENCODE_IMAGE infinity *> `$null
    # Known-good multi-line nftables program, base64-encoded to avoid all quoting.
    `$nftB64 = 'dGFibGUgaW5ldCBvcGVuY29kZV9lZ3Jlc3Mge30KZGVsZXRlIHRhYmxlIGluZXQgb3BlbmNvZGVfZWdyZXNzCnRhYmxlIGluZXQgb3BlbmNvZGVfZWdyZXNzIHsKICBjaGFpbiBmb3J3YXJkIHsKICAgIHR5cGUgZmlsdGVyIGhvb2sgZm9yd2FyZCBwcmlvcml0eSAtMTAwOyBwb2xpY3kgYWNjZXB0OwogICAgaXAgc2FkZHIgMTAuODkuMC4wLzI0IGlwIGRhZGRyIHsgMTAuMC4wLjAvOCwgMTcyLjE2LjAuMC8xMiwgMTkyLjE2OC4wLjAvMTYsIDE2OS4yNTQuMC4wLzE2LCAxMDAuNjQuMC4wLzEwIH0gY3Qgc3RhdGUgbmV3IGRyb3AKICB9Cn0K'
    `$rb = (podman machine ssh "podman unshare --rootless-netns sh -c 'echo `$nftB64 | base64 -d | nft -f - && nft list table inet opencode_egress'" 2>`$null | Out-String)
    if (`$rb -notmatch '192\.168\.0\.0/16') {
      if (`$env:OPENCODE_REQUIRE_ISOLATION) { podman rm -f `$ocHolder *> `$null; Write-Error 'opencode: egress filter could not be applied -- refusing to start (OPENCODE_REQUIRE_ISOLATION).'; return }
      Write-Warning 'opencode: egress filter not confirmed; the container may reach your LAN/host. Set OPENCODE_REQUIRE_ISOLATION=1 to make this fatal.'
    }
  }
  # inbound: publish requested ports (space/comma separated) on OPENCODE_PUBLISH_ADDR (default loopback).
  `$pubAddr = if (`$env:OPENCODE_PUBLISH_ADDR) { `$env:OPENCODE_PUBLISH_ADDR } else { '127.0.0.1' }
  `$pub = @()
  if (`$env:OPENCODE_PUBLISH) { foreach (`$p in (`$env:OPENCODE_PUBLISH -split '[,\s]+' | Where-Object { `$_ })) { `$pub += @('-p', "`$pubAddr`:`$p`:`$p") } }

  `$root = (git rev-parse --show-toplevel 2>`$null); if (-not `$root) { `$root = (Get-Location).Path }
  `$run = @('run','--rm','-i') + `$netflag + `$harden + `$pub
  if (-not [Console]::IsInputRedirected) { `$run += '-t' }
  `$run += @(
    '--mount', "type=bind,source=`$root,target=/work", '-w', '/work',
    '-e','HOME=/oc','-e','XDG_CONFIG_HOME=/oc/.config','-e','XDG_DATA_HOME=/oc/.local/share',
    '-e','XDG_STATE_HOME=/oc/.local/state','-e','XDG_CACHE_HOME=/oc/.cache',
    '--mount', "type=bind,source=`$HOME\.local\share\opencode,target=/oc/.local/share/opencode",
    '--mount', "type=bind,source=`$HOME\.local\state\opencode,target=/oc/.local/state/opencode",
    '--mount', "type=bind,source=`$HOME\.cache\opencode,target=/oc/.cache/opencode",
    '--mount', "type=bind,source=`$creds\opencode.json,target=/oc/.config/opencode/opencode.json,readonly",
    '--mount', "type=bind,source=`$creds\auth.json,target=/oc/.local/share/opencode/auth.json,readonly"
  )
  foreach (`$v in 'ANTHROPIC_API_KEY','OPENAI_API_KEY','OPENROUTER_API_KEY','GEMINI_API_KEY','GOOGLE_GENERATIVE_AI_API_KEY','AZURE_OPENAI_API_KEY','AWS_ACCESS_KEY_ID','AWS_SECRET_ACCESS_KEY','AWS_REGION','CLOUDFLARE_API_TOKEN','GITHUB_TOKEN','GITLAB_TOKEN','OPENCODE_AUTH_CONTENT','OPENCODE_CONFIG_CONTENT') {
    if (Test-Path "env:`$v") { `$run += @('-e', `$v) }
  }
  if (Test-Path (Join-Path `$HOME '.gitconfig')) { `$run += @('--mount', "type=bind,source=`$HOME\.gitconfig,target=/oc/.gitconfig,readonly") }
  `$run += `$OPENCODE_IMAGE
  podman @run @args
  `$rc = `$LASTEXITCODE
  # Remove the isolation holder so the machine-stop check sees an idle runtime.
  podman rm -f `$ocHolder *> `$null
  # Free resources: only if WE started the machine this run and no other containers remain.
  if (`$started -and -not `$env:OPENCODE_KEEP_MACHINE -and -not (podman ps -q 2>`$null)) {
    Write-Host 'opencode: stopping the Podman machine we started (no other containers running).'
    podman machine stop *> `$null
  }
  `$global:LASTEXITCODE = `$rc
}

function opencode-update { podman pull `$OPENCODE_IMAGE }
function opencode-reauth { Remove-Item -Force -ErrorAction SilentlyContinue (Join-Path `$OPENCODE_CREDS 'auth.json'),(Join-Path `$OPENCODE_CREDS 'opencode.json'); opencode-setup }
$MarkerEnd
"@

if (-not (Test-Path $PROFILE)) { New-Item -ItemType File -Force -Path $PROFILE | Out-Null }
$existing = Get-Content -Raw -Path $PROFILE -ErrorAction SilentlyContinue
if ($existing -and $existing.Contains($MarkerStart)) {
  $pattern = '(?s)' + [regex]::Escape($MarkerStart) + '.*?' + [regex]::Escape($MarkerEnd) + '\r?\n?'
  $cleaned = [regex]::Replace($existing, $pattern, '')
  Set-Content -Path $PROFILE -Value ($cleaned.TrimEnd() + "`n`n" + $block) -Encoding utf8
  Info "Updated the opencode block in $PROFILE"
} else {
  Add-Content -Path $PROFILE -Value "`n$block"
  Info "Added opencode functions to $PROFILE"
}

Write-Host ''
Info "Done. Open a new PowerShell (or: . `$PROFILE), then run 'opencode' in a project."
if (Confirm 'Run the server/API-key setup now?') {
  . $PROFILE
  opencode-setup
}
