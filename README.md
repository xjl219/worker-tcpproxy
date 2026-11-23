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
| `ALLOWED_HOSTS` | Variable | Yes | Comma-separated exact destination hostnames |
| `ALLOWED_PORTS` | Variable | No | Comma-separated destination ports |
| `RELAY_ENDPOINTS` | Variable | Relay only | Comma-separated `host:port` relay endpoints |
| `SOCKS5_HOST` | Variable | SOCKS5 only | Authorized SOCKS5 server hostname/IP |
| `SOCKS5_PORT` | Variable | No | SOCKS5 port; defaults to 1080 |
| `SOCKS5_USERNAME` | Secret | No | Set together with password |
| `SOCKS5_PASSWORD` | Secret | No | Set together with username |

Example safe initial configuration:

- `OUTBOUND_MODE=direct`
- `PROXY_ENABLED=false` until access controls and destinations have been reviewed
- `ALLOWED_HOSTS` contains only the exact hosts you are authorized to access

For relay mode, configure only relay endpoints that you own or are explicitly authorized to use. Each entry uses `host:port`; the current v1 parser expects a hostname or IPv4-style host and does not support bracketed IPv6 endpoints. The same destination hostname always selects the same configured relay within an isolate. There is no health-based failover or automatic public feed ingestion in v1.

Relay mode forwards the original client TLS bytes; it does not create a new TLS session to the relay. The relay must implement compatible SNI-based forwarding. It is restricted to destination port 443, but this does not itself prove the client stream contains a valid TLS ClientHello or that the relay reaches the intended destination. Verify using a relay you control and a destination you are authorized to test.

## Security behavior

- Proxying is disabled unless `PROXY_ENABLED=true`.
- VLESS UUID validation is required before any outbound socket is opened.
- Exact-match `ALLOWED_HOSTS` and `ALLOWED_PORTS` restrictions apply to all modes.
- Private/local IP literals are rejected by the VLESS parser.
- No fallback between direct, relay, and SOCKS5 modes.
- HTTP endpoints retain method/path checks and security response headers.
- WebSocket messages and buffered output remain bounded.

Host allowlisting is not a complete DNS-rebinding defense. Use a narrow list of trusted destinations and keep this Worker private to intended clients. Configure Cloudflare WAF/rate limits for the deployed hostname.

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
- This implementation has not yet passed typecheck, automated tests, live deployment, or end-to-end traffic tests. Treat it as an implementation candidate until those checks pass.
