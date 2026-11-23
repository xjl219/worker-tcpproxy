

## Security controls

The Worker applies basic defense-in-depth controls:

- Only GET is accepted for the public HTTP endpoints and WebSocket handshake.
- Unknown paths and common scanner targets (including `.env`, `.git`, `.vscode`, `actuator`, and common admin paths) return a generic 404.
- Responses include `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, and `X-Frame-Options: DENY`.
- VLESS UUID validation remains mandatory before any outbound TCP socket is opened.
- Destination ports are restricted by `ALLOWED_PORTS`; private, loopback, link-local, carrier-grade NAT, documentation, benchmarking, multicast, and other non-public IP literals are rejected.
- WebSocket messages remain limited to 8 MiB, and upstream buffering is bounded.

### Required Cloudflare-side controls

Application code cannot reliably rate-limit requests across Worker isolates. Add Cloudflare WAF / rate-limiting rules for the zone hosting the custom domain:

1. Challenge or block repeated requests to sensitive paths such as `/.env`, `/.git/*`, `/.vscode/*`, and `/actuator/*`.
2. Rate-limit repeated requests to `/ws` per source IP. Start conservatively so legitimate reconnects are not blocked; tune from observed traffic.
3. Keep the UUID in the Worker secret named `UUID`; never put it in source code, query strings, logs, or public client profiles.
4. Review Security Events and Worker invocation logs after enabling rules. Do not block all Go clients by User-Agent; legitimate clients can use Go's HTTP library.

These controls do not provide a distributed concurrent-connection quota, and the IP-literal checks do not fully prevent DNS rebinding to private addresses. Treat this as baseline hardening, not a substitute for a managed rate limiter or a strict destination allowlist.
