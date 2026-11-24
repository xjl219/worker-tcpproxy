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
| `UUID` | Secret | Yes | VLESS client UUID; the secure deploy command creates it on first deployment and reuses the Cloudflare secret on later deployments |
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

### Automatic UUID provisioning

Use the normal deploy command:

```bash
npm run deploy
```

The deploy script performs these steps before `wrangler deploy`:

1. If the deployment environment contains `PROXY_UUID` (preferred) or `UUID`, validate it and store it as the Cloudflare `UUID` secret.
2. Otherwise, query the Cloudflare secret *names*. If a `UUID` secret already exists, keep it unchanged so redeployments do not invalidate existing client profiles.
3. If no `UUID` secret exists, generate a cryptographically random UUID v4 and send it directly to `wrangler secret put UUID` over stdin.
4. Deploy only after the secret step succeeds.

The generated UUID is never written to source files, command-line arguments, or deployment output. The script only reports whether it generated, reused, or accepted a supplied secret. If Wrangler cannot return a valid secret listing, deployment stops rather than generating a replacement and unexpectedly rotating credentials.

To intentionally rotate the credential, supply a new UUID for one deployment:

```bash
# PowerShell
$env:PROXY_UUID = [guid]::NewGuid().ToString()
npm run deploy
Remove-Item Env:PROXY_UUID

# Bash
PROXY_UUID="$(node -e 'console.log(require("node:crypto").randomUUID())')" npm run deploy
```

The value is stored as the Cloudflare `UUID` secret. Keep the new client UUID in your password manager; it is not recoverable from the Worker secret listing. If you do not provide an override on later deployments, the existing remote secret is reused.

Only when using an authenticated SOCKS5 upstream, set `SOCKS5_USERNAME` and `SOCKS5_PASSWORD` as Cloudflare secrets separately. Never put any credentials in `wrangler.toml`, source control, URLs, or logs. The checked-in `wrangler.toml` intentionally keeps `PROXY_ENABLED=false`.


Example safe initial configuration:

- `OUTBOUND_MODE=direct`
- `PROXY_ENABLED=false` until access controls and destinations have been reviewed
- `DOMAIN_FILTER_ENABLED=false` (default); `ALLOWED_HOSTS` may be left unset while filtering is disabled

For relay mode, configure only relay endpoints that you own or are explicitly authorized to use. Each entry uses `host:port`; the current v1 parser expects a hostname or IPv4-style host and does not support bracketed IPv6 endpoints. The same destination hostname determines the preferred configured relay within an isolate. If that relay fails, the Worker tries the other explicitly configured relay endpoints. Each endpoint has an isolate-local circuit breaker: three consecutive connection failures open the circuit for 30 seconds; after the timeout, one request may perform a half-open probe. A successful probe closes the circuit. This state is not shared across Worker isolates and is not a global health/quota coordinator. There is no automatic public feed ingestion.

Relay mode forwards the original client TLS bytes; it does not create a new TLS session to the relay. The relay must implement compatible SNI-based forwarding. It is restricted to destination port 443, but this does not itself prove the client stream contains a valid TLS ClientHello or that the relay reaches the intended destination. Verify using a relay you control and a destination you are authorized to test.

## Security behavior

- Proxying is disabled unless `PROXY_ENABLED=true`.
- VLESS UUID validation is required before any outbound socket is opened.
- UUID authentication and `ALLOWED_PORTS` restrictions apply to all modes. Domain filtering is optional and disabled by default; when `DOMAIN_FILTER_ENABLED=true`, `ALLOWED_HOSTS` applies root-domain-plus-subdomain matching with a DNS-label boundary.
- Private/local IP literals are rejected by the VLESS parser.
- No fallback between direct, relay, and SOCKS5 modes.
- Unauthenticated root and unknown paths return a generic 404; `/health` returns only `{ "ok": true }` and does not disclose mode or configuration. A disabled or incompletely configured proxy also returns a generic 404.\n- WebSocket policy failures use a generic close reason; detailed auth, destination, and upstream errors are not returned to unauthenticated clients.\n- HTTP endpoints retain method/path checks and security response headers.
- WebSocket messages and buffered output remain bounded.

### Mandatory Cloudflare-side controls

The Worker code cannot provide a reliable account-wide rate or concurrent-connection quota across independent isolates. Before enabling production traffic, configure controls on the Cloudflare zone/hostname:

1. Add a WAF custom rule for the proxy hostname: allow only the intended `/ws` path and the minimal public health/root paths you actually need; block requests to all other paths. Keep the Worker's own generic 404 checks as a second layer.
2. Add a rate-limiting rule scoped to `/ws`, keyed by source IP, with a conservative threshold based on measured legitimate reconnect behavior. Start in block/managed challenge mode supported for WebSocket handshakes by the zone; verify the rule actually applies to Upgrade requests before relying on it.
3. Enable Cloudflare managed WAF protections and review Security Events after controlled tests. Do not use User-Agent as an authentication mechanism.\n4. Consider disabling the public `/health` route at the Cloudflare edge if external monitoring is not needed; if retained, it exposes only a generic liveness bit.\n5. Do not assume a hidden path or generic 404 prevents discovery. Treat the UUID as the actual client authentication secret.
4. Keep the Worker hostname and client UUID private. Rotate the UUID immediately if a client profile or credential is exposed.
5. Keep `PROXY_ENABLED=false` until these rules have been verified.

Do not interpret a request-rate rule as a concurrent-connection or bandwidth quota. A reliable global concurrency/byte quota requires a shared coordinator such as a Durable Object or an equivalent external control plane; that is a separate implementation gate and is not claimed by the current PR.

### Relay circuit breaker behavior

- Applies only to relay endpoints explicitly listed in `RELAY_ENDPOINTS`; it never switches between `direct`, `relay`, and `socks5` modes.
- Opens an endpoint circuit after 3 consecutive connection-establishment failures.
- Keeps the circuit open for 30 seconds, then permits one half-open probe at a time within the current Worker isolate.
- A successful probe closes the circuit; a failed probe reopens it.
- State is isolate-local and may be lost on isolate replacement. It is not a global circuit breaker and does not coordinate health across all Worker instances.
- Failover attempts other configured relay endpoints in deterministic order. If all are open or fail, the connection fails closed.

### DNS and destination boundary

The allowlist prevents a client from choosing arbitrary hostnames, but hostname allowlisting alone cannot prove which IP address a hostname resolves to at connection time. The current outbound paths do not yet enforce a common, application-controlled DNS resolution-and-pinning policy at the actual egress resolver. In particular, SOCKS5 and relay upstreams may resolve destination names remotely. Therefore:
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
3. Confirm `/health` returns only `{ "ok": true }`. It intentionally does not report the selected mode or configuration and does not test outbound connectivity.
4. Enable only for a controlled test and verify a permitted destination.
5. Record the observed egress IP and independently check its geolocation; a successful request does not prove a US exit.
6. Test sustained bidirectional traffic, reconnects, and error handling before any broader use.
7. Test relay or SOCKS5 only after direct mode has been measured and an authorized upstream is available.

## Known limitations

- TCP only; no UDP ASSOCIATE.
- Relay mode is TLS/SNI pass-through on port 443, not a general-purpose relay for arbitrary protocols.
- Relay selection is deterministic per destination within an isolate, with failover only among explicitly configured relay endpoints and isolate-local circuit breaking. Circuit state is not global across Worker isolates.
- SOCKS5 supports CONNECT only; no UDP ASSOCIATE.
- No built-in public relay list. Public feed entries have unknown ownership, authorization, location, and stability and are not trusted by default.
- Typecheck and automated tests must pass before this implementation is considered build-verified. Live deployment and end-to-end traffic tests are separate later gates; do not infer them from CI success.
