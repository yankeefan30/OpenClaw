# Rico 2 Image Studio

A local page for Alan Rosa to prompt Rico 2’s Flux image model and get a print back. It is a standalone studio. It is not part of OpenClaw, the gateway, iMessage, or any repair work.

OpenClaw’s gateway must stay down. This folder does not start it, talk to it, or depend on it.

## Backend (already running — do not redeploy)

Rico 2 ethernet: `192.168.4.246` (`en0`). Do not use `192.168.4.92` or `192.168.4.118`.

| Item | Value |
| --- | --- |
| Runtime | mflux 0.18.1 + FastAPI wrapper |
| LaunchAgent | `com.rico2.image` |
| Base URL | `http://192.168.4.246:1240` |
| Health | `GET /health` |
| Models | `GET /v1/models` → `black-forest-labs/FLUX.2-klein-4B` |
| Generate | `POST /v1/images/generations` |

This is an image-generations API, not chat-completions. Edit is not implemented.

A 256×256 / 4-step / seed 1 smoke has returned 200 in about 8 seconds. Larger sizes can take tens of seconds. The studio waits 180 seconds by default.

## Run on original Rico

From this folder, with Node 20+:

```sh
cd rico2-image-studio
npm test
npm start
```

Then open [http://127.0.0.1:3840](http://127.0.0.1:3840).

The tiny server in this folder does two jobs:

1. Serves the studio UI
2. Proxies `/v1/*` and `/health` to `http://192.168.4.246:1240` so the browser is not blocked by CORS

Any machine on the LAN can use the studio if it can reach original Rico on port 3840. The browser still talks only to the local proxy; the proxy talks to Rico 2.

Optional environment overrides:

```sh
HOST=0.0.0.0 PORT=3840 RICO2_BACKEND=http://192.168.4.246:1240 TIMEOUT_MS=180000 npm start
```

Do not open the HTML as `file://`. Use the local server.

## What it does not do

- Does not start or stop the OpenClaw gateway
- Does not send iMessages
- Does not SSH to Rico 2 or change the model stack
- Does not implement image edit
- Does not use auth or the cloud
