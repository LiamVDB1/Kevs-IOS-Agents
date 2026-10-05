#!/usr/bin/env bash
# Re-sign and reinstall WebDriverAgent with a fresh 7-day free-team profile, from Linux.
# xtool (https://github.com/xtool-org/xtool) holds the Apple ID session and the signing
# certificate under ~/.config/xtool; log in once with `xtool auth login --mode password`.
# xtool prefixes the bundle id, so .env sets
# WDA_RUNNER_BUNDLE_ID=XTL-<team>.com.liamvdb.WebDriverAgentRunner.xctrunner.
set -euo pipefail

XTOOL="${XTOOL:-$HOME/.local/bin/xtool}"
WDA_APP="${WDA_APP:-$HOME/.local/opt/xtool/wda/WebDriverAgentRunner-Runner.app}"
UDID="${IOS_UDID:-00008020-000C34561188003A}"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
SOCKET="$REPO/.wda/wda-service.sock"

# Reinstalling kills a running WDA, so never renew in the middle of a post.
for _ in $(seq 1 60); do
    systemctl is-active --quiet phone-farm-queue.service || break
    echo "A queue run is active; waiting before renewing WDA"
    sleep 60
done

"$XTOOL" install --udid "$UDID" --usb "$WDA_APP" </dev/null

curl --fail --silent --show-error --max-time 10 --unix-socket "$SOCKET" \
    -X POST "http://localhost/devices/$UDID/reconnect" >/dev/null
echo "WDA re-signed and relaunched for $UDID"
