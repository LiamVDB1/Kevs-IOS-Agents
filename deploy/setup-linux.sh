#!/usr/bin/env bash
# Idempotent setup for an always-on Linux Phone Farm host.
# WDA must still be provisioned/signed once from macOS; see docs/linux-remotexpc.md.
set -euo pipefail
cd "$(dirname "$0")/.."
REPO="$(pwd)"
USER_NAME="${SUDO_USER:-$(id -un)}"
USER_HOME="$(getent passwd "$USER_NAME" | cut -d: -f6)"
NODE_BIN="$(dirname "$(readlink -f "$(command -v node)")")"

step() { printf '\n==> %s\n' "$1"; }

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "This setup script is for the Linux/RemoteXPC host. Use docs/getting-started.md on macOS." >&2
  exit 1
fi

for command in node npm docker systemctl openssl rsync; do
  command -v "$command" >/dev/null || { echo "Missing required command: $command" >&2; exit 1; }
done
[[ -x /usr/bin/node ]] || { echo "/usr/bin/node is required for the root-owned tunnel runtime" >&2; exit 1; }
SYSTEM_NODE_MAJOR="$(/usr/bin/node -p 'Number(process.versions.node.split(".")[0])')"
(( SYSTEM_NODE_MAJOR >= 22 )) || { echo "/usr/bin/node must be Node 22+ for RemoteXPC" >&2; exit 1; }
[[ -e /dev/net/tun ]] || { echo "/dev/net/tun is required for RemoteXPC" >&2; exit 1; }

step "Dependencies"
# The Linux host does not need third-party install hooks for this repository's
# tested runtime; keep setup reproducible and reduce supply-chain execution.
npm ci --ignore-scripts
npm run appium:install-driver

step "Root-owned RemoteXPC runtime"
TUNNEL_RUNTIME=/opt/phone-farm-remotexpc
sudo install -d -o root -g root -m 0755 "$TUNNEL_RUNTIME/node_modules"
sudo rsync -a --delete --chown=root:root .appium2/node_modules/ "$TUNNEL_RUNTIME/node_modules/"
sudo chmod -R go-w "$TUNNEL_RUNTIME"

step "Local configuration"
if [[ ! -f .env ]]; then
  PW="$(openssl rand -hex 24)"
  SAFE_USER="$(printf '%s' "$USER_NAME" | tr -cd '[:alnum:]')"
  cp .env.example .env
  sed -i \
    -e "s|CHANGE_ME|${PW}|g" \
    -e "s|^WDA_BUNDLE_ID=.*|WDA_BUNDLE_ID=com.${SAFE_USER}.WebDriverAgentRunner|" \
    -e "s|^# WDA_BACKEND=remotexpc|WDA_BACKEND=remotexpc|" \
    .env
  chmod 600 .env
  echo "Created .env. Keep WDA_BUNDLE_ID identical when provisioning from the macOS boot."
fi
set -a
# shellcheck disable=SC1091
source .env
set +a

step "PostgreSQL"
docker compose up -d --wait postgres
npm run db:migrate

step "Linux host preflight"
npm run linux:preflight

step "systemd services"
for service in tunnel appium wda worker web; do
  source_file="deploy/systemd/phone-farm-${service}.service"
  target_file="/etc/systemd/system/phone-farm-${service}.service"
  sudo sed \
    -e "s|__REPO__|${REPO}|g" \
    -e "s|__HOME__|${USER_HOME}|g" \
    -e "s|__USER__|${USER_NAME}|g" \
    -e "s|__NODE_BIN__|${NODE_BIN}|g" \
    -e "s|__TUNNEL_RUNTIME__|${TUNNEL_RUNTIME}|g" \
    "$source_file" | sudo tee "$target_file" >/dev/null
  sudo chmod 0644 "$target_file"
done
sudo systemctl daemon-reload
sudo systemctl enable --now \
  phone-farm-tunnel.service \
  phone-farm-appium.service \
  phone-farm-wda.service \
  phone-farm-worker.service \
  phone-farm-web.service

sleep 5
step "Health"
curl -fsS "http://127.0.0.1:${WEB_PORT:-3000}/health"
printf '\nDashboard: http://127.0.0.1:%s\n' "${WEB_PORT:-3000}"
printf 'Service status: systemctl status phone-farm-{tunnel,appium,wda,worker,web}.service\n'
printf '\nIf linux:preflight still reports WDA identity/device blockers, follow docs/linux-remotexpc.md and run npm run wda:provision from the macOS boot with the same WDA_BUNDLE_ID.\n'
