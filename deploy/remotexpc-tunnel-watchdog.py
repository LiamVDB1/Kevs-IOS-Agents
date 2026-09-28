#!/usr/bin/python3
"""Restart the RemoteXPC tunnel when it is alive but no longer passes traffic.

Installed root-owned to /usr/local/libexec by deploy/setup-linux.sh and run by
phone-farm-tunnel-watchdog.timer. Exits quietly when no tunnel is registered.
"""
import json
import socket
import subprocess
import sys
import urllib.request

REGISTRY = "http://127.0.0.1:42314/remotexpc/tunnels"

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
subprocess.run(["systemctl", "restart", "phone-farm-tunnel.service"], check=True)
