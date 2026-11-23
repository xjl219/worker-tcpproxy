## Security controls

The Worker applies defense-in-depth controls:

- Proxying is **disabled by default**. Set `PROXY_ENABLED=true` only after reviewing the deployment and destination policy.
- Proxying requires a non-empty `ALLOWED_HOSTS` exact-match allowlist. Wildcards and suffix matching are intentionally unsupported.
- Only GET is accepted for the public HTTP endpoints and WebSocket handshake.
- Unknown paths and common scanner targets (including `.env`, `.git`, `.vscode`, `actuator`, and common admin paths) return a generic 404.
- Responses include `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, and `X-Frame-Options: DENY`.
- VLESS UUID validation remains mandatory before any outbound TCP socket is opened.
- Destination ports are restricted by `ALLOWED_PORTS`; private, loopback, link-local, carrier-grade NAT, documentation, benchmarking, multicast, and other non-public IP literals are rejected.
- WebSocket messages remain limited to 8 MiB, and upstream buffering is bounded.

### Required configuration

Set secrets and variables through Wrangler or the Cloudflare dashboard. Never commit real credentials.

- `UUID`: required VLESS UUID, stored as a Worker secret.
- `PROXY_ENABLED`: set to the literal string `true` to enable proxying. Any other value disables `/ws`.
- `ALLOWED_HOSTS`: comma-separated exact destination hostnames or IP literals. Example: `generativelanguage.googleapis.com,api.anthropic.com`. No wildcards.
- `ALLOWED_PORTS`: optional comma-separated destination ports; defaults to the conservative list in `src/index.ts`.

Start with the smallest destination allowlist required by the intended application. Add hosts only after review. The allowlist is exact-match and does not perform DNS resolution or DNS-rebinding validation; do not treat it as a complete SSRF defense.

### Required Cloudflare-side controls

Application code cannot reliably enforce a global rate limit across Worker isolates. Configure Cloudflare WAF / rate-limiting rules for the zone hosting the custom domain:

1. Challenge or block repeated requests to sensitive paths such as `/.env`, `/.git/*`, `/.vscode/*`, and `/actuator/*`.
2. Apply a conservative rate limit to `/ws`, then tune it using observed legitimate reconnect patterns.
3. Keep the UUID in the Worker secret named `UUID`; never put it in source code, query strings, logs, or public client profiles.
4. Review Security Events, Worker invocation logs, and Abuse Reports regularly. Preserve evidence and respond through the existing Cloudflare abuse-report case; do not move the same traffic to replacement hostnames to bypass an enforcement action.

These controls reduce exposure but do not guarantee that a service will not receive abuse reports. They do not provide a distributed concurrent-connection quota or complete DNS-rebinding protection. If Cloudflare has restricted the service, resolve the report with Cloudflare before restoring public proxy traffic.
