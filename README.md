# Worker TCP Proxy — SOCKS5 upstream v1

This version keeps the VLESS-over-WebSocket ingress but routes every accepted destination through a configured SOCKS5 upstream. The Worker does not silently fall back to direct Cloudflare TCP egress.

## Flow

`VLESS client -> Cloudflare Worker -> configured SOCKS5 server -> allowlisted destination`

The SOCKS5 server determines the final network egress. A successful Worker deployment does not prove that the SOCKS5 server is reachable or that its public egress IP is in the intended country; verify those separately with an authorized test endpoint.

## Fail-closed security defaults

- Proxy access is disabled unless `PROXY_ENABLED=true`.
- A non-empty exact-match `ALLOWED_HOSTS` list is required. Wildcards and suffix matching are not supported.
- Destination ports are restricted by `ALLOWED_PORTS`.
- The VLESS UUID is required before any upstream socket is opened.
- Private/local destination IP literals are rejected by the VLESS parser.
- The Worker has no direct-egress fallback: if SOCKS5 connection, authentication, or CONNECT fails, the session fails closed.
- HTTP endpoints and WebSocket handling retain method/path checks and security response headers.

The host allowlist is exact string matching; it does not resolve DNS or guarantee that an allowed hostname cannot resolve to a private address. Use only trusted destinations and a controlled SOCKS5 server. Do not expose this Worker as a public, unrestricted relay.

## Configuration

Set the following in the Cloudflare Worker settings. Do not commit real credentials.

| Name | Type | Required | Purpose |
|---|---|---:|---|
| `UUID` | Secret | Yes | VLESS client UUID |
| `SOCKS5_HOST` | Variable | Yes | Hostname or public IP of your authorized SOCKS5 server |
| `SOCKS5_PORT` | Variable | No | SOCKS5 port; defaults to 1080 |
| `SOCKS5_USERNAME` | Secret | No | SOCKS5 username; set with password |
| `SOCKS5_PASSWORD` | Secret | No | SOCKS5 password; set with username |
| `PROXY_ENABLED` | Variable | Yes | Must be literal `true` to enable |
| `ALLOWED_HOSTS` | Variable | Yes | Comma-separated exact destination hostnames |
| `ALLOWED_PORTS` | Variable | No | Comma-separated destination ports |

Start with a narrow host list for the applications you intend to use. Example only: `generativelanguage.googleapis.com,api.anthropic.com`. Add other required hostnames only after reviewing them.

Example secret commands (run locally; never paste secret values into chat):

```sh
npx wrangler secret put UUID
npx wrangler secret put SOCKS5_USERNAME
npx wrangler secret put SOCKS5_PASSWORD
```

Set `SOCKS5_HOST`, `SOCKS5_PORT`, `PROXY_ENABLED`, `ALLOWED_HOSTS`, and `ALLOWED_PORTS` in the Worker Variables settings. Keep `PROXY_ENABLED=false` until the upstream and access policy have been reviewed.

## Staged verification

1. Deploy this as a separate Worker name; do not overwrite the existing service.
2. Check `/health`. It reports whether proxying is enabled and whether the SOCKS5 host and destination allowlist are configured; it does not test credentials or connectivity.
3. With proxying still disabled, confirm `/ws` returns 503.
4. Configure the authorized SOCKS5 server and a narrow destination allowlist. Enable only for a controlled test.
5. Verify SOCKS5 authentication and CONNECT using an approved destination.
6. Verify the observed public egress IP using a test endpoint you control or are authorized to use.
7. Test streaming and reconnect behavior before considering production use.

Do not use hostname or deployment changes to evade a provider restriction or abuse review. If the platform has restricted a service, resolve that restriction through its official process before enabling public traffic.

## Known limitations

- SOCKS5 TCP CONNECT only; no UDP ASSOCIATE.
- One SOCKS5 upstream per Worker deployment; no pool or automatic failover in v1.
- No direct egress fallback by design.
- DNS resolution for destination domains is delegated to the SOCKS5 server.
- This initial implementation has not yet passed a live Cloudflare deployment or end-to-end SOCKS5 test. Treat it as an implementation candidate until those checks pass.
