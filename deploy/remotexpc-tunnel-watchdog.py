#!/usr/bin/python3
"""Restart the RemoteXPC tunnel when it is alive but no longer passes traffic.

Installed root-owned to /usr/local/libexec by deploy/setup-linux.sh and run by
phone-farm-tunnel-watchdog.timer. Exits quietly when no tunnel is registered.
"""
import json
import os
import socket
import subprocess
import sys
import time
import urllib.request

REGISTRY = "http://127.0.0.1:42314/remotexpc/tunnels"
DROPS_DIR = "/var/lib/phone-farm"
DROPS_FILE = os.path.join(DROPS_DIR, "tunnel-drops")

try:
    with urllib.request.urlopen(REGISTRY, timeout=5) as response:
        tunnels = json.load(response)["tunnels"]
except Exception:
    sys.exit(0)
if not tunnels:
    sys.exit(0)

for tunnel in tunnels.values():
    try:
        socket.create_connection((tunnel["address"], int(tunnel["rsdPort"])), timeout=5).close()
        sys.exit(0)
    except OSError:
        pass

print("No RemoteXPC tunnel answers; restarting phone-farm-tunnel.service", flush=True)
# Record the drop so the scheduler can predict the next one (fixed ~30 min cycle).
try:
    os.makedirs(DROPS_DIR, mode=0o755, exist_ok=True)
    lines = []
    if os.path.exists(DROPS_FILE):
        with open(DROPS_FILE) as handle:
            lines = handle.read().split()[-49:]
    lines.append(str(int(time.time())))
    with open(DROPS_FILE + ".tmp", "w") as handle:
        handle.write("\n".join(lines) + "\n")
    os.chmod(DROPS_FILE + ".tmp", 0o644)
    os.replace(DROPS_FILE + ".tmp", DROPS_FILE)
except OSError as error:
    print(f"Could not record the tunnel drop: {error}", flush=True)
subprocess.run(["systemctl", "restart", "phone-farm-tunnel.service"], check=True)
