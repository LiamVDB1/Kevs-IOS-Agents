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

# xtool asks "Continue? (yes/no)" when it must revoke another development certificate
# (a free Apple ID keeps one). With stdin on /dev/null it crashed (epoll EPERM) and the
# timer failed silently. Answer "no" so it stops cleanly, and say why: revoking breaks
# whatever made the other certificate, so a person decides (rerun xtool by hand, answer yes).
log="$(mktemp)"
trap 'rm -f "$log"' EXIT
set +e
printf 'no\n' | "$XTOOL" install --udid "$UDID" --usb "$WDA_APP" 2>&1 | tee "$log"
status=${PIPESTATUS[1]}
set -e
if grep -q 'xtool auth' "$log"; then
    echo "WDA NOT renewed: xtool is logged out of the Apple ID." >&2
    echo "Liam must run 'xtool auth login -u <apple-id> --mode password' on macserver (password + 2FA code)." >&2
    exit 1
fi
if grep -q 'must be revoked' "$log"; then
    # xtool <1.24 dropped leading zeros from certificate serials, so it failed to
    # recognise its OWN certificate and offered to revoke it (xtool issue #305).
    echo "WDA NOT renewed: xtool wants to revoke a certificate. Do not answer yes blindly." >&2
    echo "Compare 'xtool ds certificates list' with the serial in ~/.config/xtool/data; if it is xtool's own" >&2
    echo "certificate, this is the serial bug (fixed in xtool 1.24.0), not another app." >&2
    exit 1
fi
if [ "$status" -ne 0 ] || ! grep -q 'Successfully installed' "$log"; then
    echo "WDA NOT renewed: xtool exited $status" >&2
    exit 1
fi

# Reinstalling can drop the personalized developer disk image; XCTest needs it mounted.
"${PYMOBILEDEVICE3:-$HOME/.local/bin/pymobiledevice3}" mounter auto-mount --udid "$UDID" \
    || echo "Warning: could not mount the developer disk image; WDA may not start" >&2

curl --fail --silent --show-error --max-time 10 --unix-socket "$SOCKET" \
    -X POST "http://localhost/devices/$UDID/reconnect" >/dev/null
echo "WDA re-signed and relaunched for $UDID"
