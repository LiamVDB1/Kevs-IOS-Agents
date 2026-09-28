# Linux + RemoteXPC host

The farm can run permanently on Linux for real iPhones running iOS 18 or newer. macOS is still required to build and sign WebDriverAgent (WDA), but it does not need to be the always-on automation host.

This is especially useful on a dual-boot Mac: provision the phone once from the macOS boot, then boot Linux and operate the same installed WDA runner over RemoteXPC.

## Architecture

```text
macOS/Xcode boot (provisioning only)
  patched WDA -> sign -> install on iPhone

Ubuntu/Linux boot (normal operation)
  RemoteXPC tunnel
       |
  wda-service -> preinstalled WDA -> local :8100 / MJPEG :9100
       |
  Appium 3 + XCUITest 12
       |
  worker / web / PostgreSQL
```

`WDA_BACKEND` defaults to `xcode` on macOS and `remotexpc` elsewhere. It can be set explicitly.

## Linux prerequisites

- Node.js 22+
- `/dev/net/tun`
- `iproute2`
- `usbmuxd`
- a USB-connected, paired iPhone on iOS 18+
- current repository XCUITest driver
- signed patched WDA already installed on that iPhone

Install and check the Linux side manually:

```sh
npm ci
npm run appium:install-driver
npm run linux:preflight
```

For an always-on Ubuntu host, `bash deploy/setup-linux.sh` performs the dependency/database setup and installs systemd units for the tunnel, Appium, WDA supervisor, worker, and dashboard. It keeps the dashboard on loopback by default.

The repository pins its runtime commands to Appium 3.7.0 and XCUITest 12.12.4. The RemoteXPC module is loaded from the installed XCUITest driver so its transport implementation stays version-aligned with the driver.

## One-time macOS provisioning

Boot the machine into macOS, clone/check out the same fork, and install dependencies:

```sh
npm ci
npm run appium:install-driver
cp .env.example .env
```

Set at least:

```text
IOS_PLATFORM_VERSION=<the phone's iOS version>
XCODE_ORG_ID=<Apple Developer Team ID>
WDA_BUNDLE_ID=<bundle id you control>
```

Connect/unlock the iPhone, accept Trust This Computer, enable Developer Mode, then run:

```sh
npm run wda:provision
```

`wda:provision` applies the repository WDA patches, builds/signs WDA with Xcode, then starts the Xcode WDA runner once and waits for its HTTP endpoint. That first run installs the signed runner app on the phone. The command then stops the supervisor; the signed app remains installed for the Linux boot.

If iOS asks you to trust the development profile, do that under Settings -> General -> VPN & Device Management.

Re-provision when the signing profile expires, the phone/iOS changes enough to require a new build, the WDA bundle changes, or the WDA patch changes.

## Linux runtime

Boot Ubuntu, connect the same phone by USB, and set the same `WDA_BUNDLE_ID` in `.env`. The runner bundle defaults to `<WDA_BUNDLE_ID>.xctrunner`; set `WDA_RUNNER_BUNDLE_ID` only when your installed bundle differs.

Check readiness:

```sh
npm run linux:preflight
```

Start the RemoteXPC tunnel in its own long-lived terminal:

```sh
npm run remotexpc:tunnel
```

The interactive helper elevates only the already-installed, version-pinned RemoteXPC tunnel script—no npm/npx code is fetched or executed as root—and preserves the invoking user's HOME so the normal service account can find the tunnel-registry metadata. Keep this process running while the phone is controlled.

For unattended systemd operation, `deploy/setup-linux.sh` additionally snapshots the installed Appium/XCUITest module tree into root-owned `/opt/phone-farm-remotexpc` and the privileged unit executes that immutable copy with `/usr/bin/node`. It does not execute JavaScript or load `.env` from the user-writable checkout as root. The service restarts periodically when no phone is connected so later USB attachment is self-healing.

Then run the normal farm processes:

```sh
npm run appium
npm run wda:service
npm run worker
npm run web
```

The rest of the application still sees WDA on localhost ports. `wda-service` launches the preinstalled runner with RemoteXPC DVT process control and creates localhost forwards for WDA and MJPEG. Existing dashboard, worker, remote-control, and plugin code therefore use the same contract on macOS and Linux.

## Real-device notes (iPhone XR, iOS 18.7, Xcode 27)

Verified end to end on 2026-09-28. These are the steps and behaviours that are not obvious from the architecture above.

**One-time, by hand on the phone**

- Pair with the Linux host while the phone is unlocked (tap Trust). An iOS update can invalidate the old pairing; the tunnel then logs `InvalidHostID`. Remove the stale record in `/var/lib/lockdown/` and pair again.
- After provisioning: Settings → General → VPN & Device Management → trust the developer profile, and Settings → Developer → **Enable UI Automation**. Without the latter WDA launches but XCTest waits forever at "enabling automation".
- A free Apple ID (Personal Team) signs for 7 days; re-run `npm run wda:provision` with the phone on the Mac before it expires.
- For unattended use: no passcode (or store it in `devices.json`), automatic iOS updates off, Settings → Face ID & Passcode → Accessories on.
- The first photo import asks WDA for Photos access (allow **Add Only**); TikTok needs full Photos access and camera access for its create screen. The microphone is not needed.

**How WDA is launched**

A plain process launch starts the runner without a test session, so the WDA server never opens. `wda-service` opens a testmanagerd XCTest session through RemoteXPC (what Xcode does) and keeps it for as long as WDA serves. With the Xcode 27 test stack the runner can no longer background itself ("Failed to background test runner"), so the launcher foregrounds Settings right after launch.

**The tunnel drops every 30 minutes**

The device drops the CoreDeviceProxy tunnel on a fixed ~30-minute cycle anchored to the clock, not to tunnel age, and the WDA test session dies with it. WDA's `/status` can keep answering while its XCTest authorization is gone ("Not authorized for performing UI testing actions").

- `phone-farm-tunnel-watchdog.timer` probes the tunnel every 30 s, restarts it after a drop, and records the drop in `/var/lib/phone-farm/tunnel-drops`.
- The WDA supervisor relaunches WDA whenever the tunnel identity changes.
- The executor starts a task only when it fits before the predicted next drop and once WDA has had 90 s to settle on a new tunnel. Posts retry up to the publish form after waiting for WDA to recover; they never retry past the Drafts/Post tap.

Do not probe the tunnel's RSD port in tight loops; the watchdog's 30-second check is enough.

## Failure boundaries

- No iPhone in `linux:preflight`: the phone is connected to a different computer, is not trusted, or usbmuxd cannot see it.
- Tunnel registry missing: start `npm run remotexpc:tunnel` and keep it running.
- iOS below 18: the Linux RemoteXPC backend is intentionally blocked.
- WDA launch says runner unavailable: provision/install WDA from the macOS boot and verify `WDA_BUNDLE_ID` / `WDA_RUNNER_BUNDLE_ID`.
- WDA endpoint fails after launch: check the tunnel, Developer Mode/profile trust, WDA ports, and whether another process owns the same phone/ports.

Do not run the Xcode WDA supervisor and Linux RemoteXPC supervisor against the same device simultaneously.
