# Security Policy

Do not report vulnerabilities through public issues. Until a dedicated address is configured, contact the repository owners privately through the GitHub organization.

Never attach a self-hosted production runner to this repository's workflows. Never include device passcodes, Apple signing material, real UDIDs, authentication tokens, screenshots, uploaded media, or production logs in an issue or pull request.

On Linux, RemoteXPC tunnel creation requires root privileges for the TUN interface. Do not run `npm`, `npx`, plugins, the dashboard, worker, or Appium as root. The provided systemd deployment snapshots the pinned RemoteXPC runtime into a root-owned `/opt/phone-farm-remotexpc` tree and executes it with `/usr/bin/node`; the privileged service deliberately does not load the user-writable repository `.env`.

Keep the dashboard bound to loopback unless a reviewed `PHONE_FARM_AUTH_PLUGIN` is configured. Photo Mode public publishing requires explicit per-task approval and rejects recurring public schedules; do not weaken those guards in deployment wrappers.
