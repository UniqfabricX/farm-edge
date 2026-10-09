# Farm Edge Agent

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org/)
[![Platform: Windows](https://img.shields.io/badge/platform-Windows-blue.svg)](https://microsoft.com/windows)

**Farm Edge** is a lightweight, open-source local bridge agent for 3D printer farms. It runs on a local Windows PC or server in the same local network (LAN) as your 3D printers, discovering devices across local protocols (MQTT, TCP, SDCP, UDP, HTTP) and establishing a secure, outbound-only WebSocket relay to the cloud management dashboard ([farm.5dsap.ru](https://farm.5dsap.ru)).

**No router port forwarding or public static IP addresses are required.**

---

## Supported 3D Printers & Protocols

- **Bambu Lab** (X1 Carbon, P1S, P1P, A1, A1 Mini) via local MQTT & FTPS (`LAN Only Mode`)
- **Flashforge** (Adventurer 5M, 5M Pro) via raw TCP control protocol (port 8899)
- **Creality / Klipper / Moonraker** (K1, K1 Max, K2 Plus, Ender series with Klipper) via Moonraker API & WebSocket
- **Elegoo** (Centauri Carbon, Saturn series) via SDCP WebSocket & UDP discovery
- **OctoPrint** instances via REST API

---

## Key Features

- **Outbound-only connection:** Operates behind strict NAT and firewalls without opening incoming ports.
- **Local offline autonomy:** If internet connectivity drops, ongoing print jobs continue on printer hardware without interruption; local events and telemetry buffer on disk until reconnected.
- **Zero-touch printer discovery:** Scans local subnets for 3D printer signatures and reports IP, firmware, and telemetry to the cloud dashboard.
- **One-click diagnostic packaging:** Collects diagnostic bundles, serial numbers, firmware versions, and logs into a single zip archive for manufacturer support tickets.
- **Multi-material / AMS support:** Relays 4-slot AMS/CFS telemetry and RFID tag data in real time.

---

## Installation & Setup

### For End Users (Windows Installer)

1. Download the latest installer: **`FarmEdge-Setup.exe`** from [Releases](https://github.com/UniqfabricX/farm-edge/releases).
2. Run `FarmEdge-Setup.exe`.
3. In your cloud dashboard ([farm.5dsap.ru](https://farm.5dsap.ru)), go to **Administration → Get Pairing Code** (8-digit code, e.g. `ABCD-EFGH`).
4. Paste the pairing code into the setup window and click **Connect**.
5. Done! The agent registers as a Windows background task (`FarmEdgeAgent`) and auto-starts on login.

*(Alternative: Download the standalone `FarmEdge-Setup-win.zip` for portable environments without an installer).*

---

### Manual Setup (Developers / CLI)

Prerequisites: [Node.js](https://nodejs.org/) v20 or higher.

```bash
# Clone the repository
git clone https://github.com/UniqfabricX/farm-edge.git
cd farm-edge

# Install dependencies
npm install

# Pair with your cloud tenant
node index.js pair --code YOUR-PAIRING-CODE --cloud https://farm.5dsap.ru

# Run the agent
node index.js run
```

---

## Architecture & Security

- **No secret storage on cloud:** Printer access codes, LAN passwords, and private network topology remain strictly within your local environment on the machine running Farm Edge (`%ProgramData%\farm-edge`).
- **Encrypted transport:** All communication with the cloud is encrypted over TLS/WSS.
- **Pairing tokens:** Pairing codes are short-lived (15 minutes), single-use tokens hashed with bcrypt.
- **Least privilege:** Runs as standard non-elevated user; does not require administrative privileges.

---

## Code signing policy

Free code signing provided by [SignPath.io](https://signpath.io), certificate by [SignPath Foundation](https://signpath.org).

- **Automated verifiable builds:** Official executable binaries are built and signed automatically via GitHub Actions pipelines directly from this public open-source repository.
- **Integrity verification:** Each release includes SHA-256 checksums alongside Authenticode-signed executables to ensure complete software supply chain integrity.
- **Transparency:** No proprietary or binary blobs are added outside the public build workflow.

---

## License

This project is licensed under the [MIT License](LICENSE) — see the LICENSE file for details.

Copyright (c) 2026 3D ZIPPER / Dmitry Glushkov.
