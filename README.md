# Worker TCP Proxy

A minimal, authenticated **VLESS over WebSocket to outbound TCP** bridge for Cloudflare Workers.

> First milestone: TCP only. This is not a MASQUE server and does not implement UDP, CONNECT-UDP, CONNECT-IP, TUN, or a full VPN stack.

## Data path

```text
Windows / sing-box
      |
      | VLESS over WebSocket over TLS (WSS)
      v
Cloudflare Worker  /ws
      |
      | cloudflare:sockets connect()
      v
Target TCP host:port
```

The Worker accepts a WebSocket at `/ws`, validates the VLESS UUID, parses a TCP destination, checks the destination port against an allowlist, opens an outbound TCP socket, and relays bytes in both directions.

## Current scope and limitations

- Supported: VLESS TCP command (`0x01`) over WebSocket; binary WebSocket messages; IPv4, IPv6 and domain destination fields.
- Not supported: VLESS UDP command, UDP sockets, DNS proxying, QUIC/HTTP/3 tunneling, inbound raw TCP, TUN, multiplexing, fallback transports.
- Default destination ports: `80,443,8080,8443,2053,2083,2087,2096`.
- A custom comma-separated port list can be set with the `ALLOWED_PORTS` Worker variable.
- Private/local IP literals and common local hostnames are rejected. This is a basic guard, not a complete DNS-rebinding or destination-policy system. Keep the UUID secret private and do not expose it in client profiles or public logs.
- A WebSocket message is capped at 8 MiB by this implementation. Cloudflare's platform also applies its own WebSocket and Worker runtime limits.
- The Worker does not guarantee a US egress IP, a fixed egress IP, or acceptance by any particular AI service. Test the actual deployed endpoint and destination services from your own network.
- A Worker `connect()` outbound TCP socket is not the same as a public inbound TCP listener. The public endpoint in this project is WSS.

## Requirements

- Node.js 22+
- npm
- A Cloudflare account with Workers enabled
- A GitHub repository: [xjl219/worker-tcpproxy](https://github.com/xjl219/worker-tcpproxy)

## Local setup

```bash
git clone https://github.com/xjl219/worker-tcpproxy.git
cd worker-tcpproxy
npm install
cp .dev.vars.example .dev.vars
```

Edit `.dev.vars` and replace the example UUID with a private UUID. For example, generate one with `uuidgen`. Never commit `.dev.vars`.

Run static checks and parser tests:

```bash
npm run check
```

Start the local Worker:

```bash
npm run dev
```

In another terminal, verify the health endpoint:

```bash
curl http://127.0.0.1:8787/health
```

Expected shape:

```json
{"ok":true,"service":"worker-tcp-proxy","protocol":"vless-ws-tcp"}
```

The health request verifies that the Worker is responding; it does **not** verify VLESS authentication or an end-to-end TCP tunnel. Use a VLESS-capable client for the end-to-end test below.

## Deploy manually

Authenticate Wrangler:

```bash
npx wrangler login
```

Create/update the Worker:

```bash
npm run deploy
```

Set the UUID as a Worker secret:

```bash
npx wrangler secret put UUID
```

Paste the UUID when prompted. Then test:

```bash
curl https://YOUR-WORKER.YOUR-SUBDOMAIN.workers.dev/health
```

The WSS endpoint is:

```text
wss://YOUR-WORKER.YOUR-SUBDOMAIN.workers.dev/ws
```

## End-to-end client test (sing-box)

Create a VLESS outbound using these values:

| Setting | Value |
|---|---|
| Protocol | VLESS |
| Server | Your deployed `workers.dev` hostname |
| Server port | `443` |
| UUID | The same UUID stored as Worker secret `UUID` |
| TLS | Enabled |
| TLS server name | Your deployed `workers.dev` hostname |
| Transport | WebSocket |
| WebSocket path | `/ws` |
| Flow | Empty |
| Multiplexing | Disabled for the first test |

Example outbound fragment (replace the placeholders):

```json
{
  "type": "vless",
  "tag": "worker-tcp",
  "server": "YOUR-WORKER.YOUR-SUBDOMAIN.workers.dev",
  "server_port": 443,
  "uuid": "YOUR-UUID",
  "tls": {
    "enabled": true,
    "server_name": "YOUR-WORKER.YOUR-SUBDOMAIN.workers.dev"
  },
  "transport": {
    "type": "ws",
    "path": "/ws"
  }
}
```

Use that outbound as the proxy for a simple HTTPS request to a destination on port 443. A successful `/health` request alone is not an end-to-end proxy test. If the VLESS client reports a handshake or EOF error, check the UUID, WSS hostname, `/ws` path, and whether the target port is in `ALLOWED_PORTS`.

## GitHub Actions automatic deployment

The workflow at `.github/workflows/deploy.yml` runs on every push to `main` and can also be started manually from the Actions tab. Before using it, add these **repository Actions secrets** in GitHub:

| Secret | Purpose |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Cloudflare API token with permission to deploy Workers scripts |
| `CLOUDFLARE_ACCOUNT_ID` | Your Cloudflare account ID |
| `WORKER_UUID` | The VLESS UUID used by clients |

The workflow installs dependencies, runs type checks and tests, deploys the Worker, then uploads `WORKER_UUID` to the Worker as the `UUID` secret. Do not put the UUID in `wrangler.toml` or commit it to Git.

After the first successful workflow run, check the Actions log and open:

```text
https://YOUR-WORKER.YOUR-SUBDOMAIN.workers.dev/health
```

## Repository layout

```text
src/index.ts                 Worker entry point and VLESS/TCP bridge
test/protocol.test.ts        VLESS request parser tests
wrangler.toml                Worker configuration
.github/workflows/deploy.yml GitHub Actions deployment
```

## Roadmap

1. Validate this TCP-only path locally and on a deployed Worker.
2. Add integration tests for real sing-box clients and connection teardown.
3. Improve destination policy and DNS/IP validation.
4. Evaluate UDP separately; do not treat TCP success as UDP or full-VPN support.
