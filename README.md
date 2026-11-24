# Worker TCP Proxy — pluggable outbound v1

VLESS over WebSocket ingress with three selectable outbound modes:

- `direct` (default): Cloudflare Worker opens a TCP socket directly to the requested destination using `cloudflare:sockets`.
- `relay`: Worker opens TCP to an explicitly configured SNI relay endpoint and forwards the client's original TLS stream unchanged. This mode is for TLS/SNI traffic to destination port 443 only.
- `socks5`: Worker establishes SOCKS5 CONNECT to an explicitly configured upstream.

`OUTBOUND_MODE` selects exactly one mode. There is no automatic cross-mode fallback: a failed route fails closed. This avoids silently changing the network egress or destination path.

## Flow

```
VLESS client -> Cloudflare Worker -> selected outbound adapter
                                  |-> direct TCP -> destination
                                  |-> SNI relay TCP -> TLS/SNI destination (443)
                                  |-> SOCKS5 CONNECT -> destination
```

## Configuration

| Name | Type | Required | Purpose |
|---|---|---:|---|
| `UUID` | Secret | Yes | VLESS client UUID |
| `OUTBOUND_MODE` | Variable | No | `direct` (default), `relay`, or `socks5` |
| `PROXY_ENABLED` | Variable | Yes | Must be literal `true` to enable the WebSocket proxy |
| `DOMAIN_FILTER_ENABLED` | Variable | No | Domain allowlist switch; defaults to `false`. Only literal `true` enables filtering. |
| `ALLOWED_HOSTS` | Variable | When filtering is enabled | Comma-separated DNS root domains; each entry allows that domain and its subdomains. No wildcard, URL, path, port, or IP-literal entries. |
| `ALLOWED_PORTS` | Variable | No | Comma-separated destination ports |
| `RELAY_ENDPOINTS` | Variable | Relay only | Comma-separated `host:port` relay endpoints |
| `SOCKS5_HOST` | Variable | SOCKS5 only | Authorized SOCKS5 server hostname/IP |
| `SOCKS5_PORT` | Variable | No | SOCKS5 port; defaults to 1080 |
| `SOCKS5_USERNAME` | Secret | No | Set together with password |
| `SOCKS5_PASSWORD` | Secret | No | Set together with username |

Example safe initial configuration:

- `OUTBOUND_MODE=direct`
- `PROXY_ENABLED=false` until access controls and destinations have been reviewed
- `DOMAIN_FILTER_ENABLED=false` (default); `ALLOWED_HOSTS` may be left unset while filtering is disabled

For relay mode, configure only relay endpoints that you own or are explicitly authorized to use. Each entry uses `host:port`; the current v1 parser expects a hostname or IPv4-style host and does not support bracketed IPv6 endpoints. The same destination hostname always selects the same configured relay within an isolate. There is no health-based failover or automatic public feed ingestion in v1.

Relay mode forwards the original client TLS bytes; it does not create a new TLS session to the relay. The relay must implement compatible SNI-based forwarding. It is restricted to destination port 443, but this does not itself prove the client stream contains a valid TLS ClientHello or that the relay reaches the intended destination. Verify using a relay you control and a destination you are authorized to test.

## Security behavior

- Proxying is disabled unless `PROXY_ENABLED=true`.
- VLESS UUID validation is required before any outbound socket is opened.
- UUID authentication and `ALLOWED_PORTS` restrictions apply to all modes. Domain filtering is optional and disabled by default; when `DOMAIN_FILTER_ENABLED=true`, `ALLOWED_HOSTS` applies root-domain-plus-subdomain matching with a DNS-label boundary.
- Private/local IP literals are rejected by the VLESS parser.
- No fallback between direct, relay, and SOCKS5 modes.
- HTTP endpoints retain method/path checks and security response headers.
- WebSocket messages and buffered output remain bounded.

### Mandatory Cloudflare-side controls

The Worker code cannot provide a reliable account-wide rate or concurrent-connection quota across independent isolates. Before enabling production traffic, configure controls on the Cloudflare zone/hostname:

1. Add a WAF custom rule for the proxy hostname: allow only the intended `/ws` path and the minimal public health/root paths you actually need; block requests to all other paths. Keep the Worker's own generic 404 checks as a second layer.
2. Add a rate-limiting rule scoped to `/ws`, keyed by source IP, with a conservative threshold based on measured legitimate reconnect behavior. Start in block/managed challenge mode supported for WebSocket handshakes by the zone; verify the rule actually applies to Upgrade requests before relying on it.
3. Enable Cloudflare managed WAF protections and review Security Events after controlled tests. Do not use User-Agent as an authentication mechanism.
4. Keep the Worker hostname and client UUID private. Rotate the UUID immediately if a client profile or credential is exposed.
5. Keep `PROXY_ENABLED=false` until these rules have been verified.

Do not interpret a request-rate rule as a concurrent-connection or bandwidth quota. A reliable global concurrency/byte quota requires a shared coordinator such as a Durable Object or an equivalent external control plane; that is a separate implementation gate and is not claimed by the current PR.

### DNS and destination boundary

The allowlist prevents a client from choosing arbitrary hostnames, but hostname allowlisting alone cannot prove which IP address a hostname resolves to at connection time. The current Cloudflare TCP socket path does not perform an application-controlled DNS resolution-and-pinning check before connect. Therefore:
- use only narrow, trusted destination hostnames controlled by reputable service operators;
- do not add user-controlled or arbitrary third-party hostnames;
- treat DNS rebinding resistance as a known limitation until a supported resolution/pinning design is implemented and tested;
- never claim that exact hostname matching alone eliminates SSRF or DNS-rebinding risk.

### Pre-deployment security acceptance gate

Do not enable the proxy or merge this as production-ready until all checks below have evidence:

| Test | Required result | Current verification scope |
|---|---|---|
| Proxy disabled | WebSocket proxy returns 503 and opens no outbound socket | Worker unit/integration test |
| Missing UUID / wrong UUID | Connection rejected before outbound socket creation | VLESS parser + integration test |
| Host not on allowlist | Connection rejected before outbound socket creation | Host allowlist unit/integration test |
| Domain filter disabled | No hostname allowlist is required when `DOMAIN_FILTER_ENABLED=false` | Security helper + handler test |\n| Domain filter enabled | Missing or malformed `ALLOWED_HOSTS` fails closed | Configuration test |\n| Root-domain matching | `google.com` authorizes `google.com` and `sub.google.com`, but not `evilgoogle.com` or `google.com.evil.net` | Host allowlist unit test |
| Wildcard or malformed allowlist | Configuration rejected closed | Host allowlist unit test |
| Port not allowed | Connection rejected before outbound socket creation | Integration test |
| Unapproved relay/SOCKS upstream | Not selectable unless explicitly configured by operator | Configuration review + integration test |
| Sensitive/admin paths | Generic 404; no config or secret disclosure | HTTP handler test |
| Excess request rate | Cloudflare edge rule limits repeated handshakes | Zone-level test required |
| Excess concurrent connections / bytes | Shared quota blocks excess usage | Not implemented; Durable Object/control-plane gate |
| DNS rebinding | Must not be represented as solved by hostname allowlisting | Design limitation; resolution/pinning work required |
| Secret leakage | UUID and SOCKS credentials absent from logs, URLs, health output, and committed config | Code review + log inspection |

A passing TypeScript build or unit-test suite is not a substitute for the zone-level WAF/rate-limit test, real outbound tests, or the remaining shared-quota and DNS-pinning work.

## Staged verification

1. Deploy under the separate Worker name in `wrangler.toml`; do not overwrite an existing service.
2. Set `OUTBOUND_MODE=direct`, configure `UUID` and a narrow `ALLOWED_HOSTS`, and keep `PROXY_ENABLED=false`.
3. Confirm `/health` reports the selected mode and configuration flags. It does not test outbound connectivity.
4. Enable only for a controlled test and verify a permitted destination.
5. Record the observed egress IP and independently check its geolocation; a successful request does not prove a US exit.
6. Test sustained bidirectional traffic, reconnects, and error handling before any broader use.
7. Test relay or SOCKS5 only after direct mode has been measured and an authorized upstream is available.

## Known limitations

- TCP only; no UDP ASSOCIATE.
- Relay mode is TLS/SNI pass-through on port 443, not a general-purpose relay for arbitrary protocols.
- Relay selection is deterministic per destination within an isolate; no health scoring or automatic failover.
- SOCKS5 supports CONNECT only; no UDP ASSOCIATE.
- No built-in public relay list. Public feed entries have unknown ownership, authorization, location, and stability and are not trusted by default.
- Typecheck and automated tests must pass before this implementation is considered build-verified. Live deployment and end-to-end traffic tests are separate later gates; do not infer them from CI success.
