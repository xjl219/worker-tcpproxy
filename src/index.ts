import { connect } from "cloudflare:sockets";
import { parseVlessRequest } from "./vless";

interface Env {
  UUID: string;
  ALLOWED_PORTS?: string;
}

const DEFAULT_ALLOWED_PORTS = [80, 443, 8080, 8443, 2053, 2083, 2087, 2096];
const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;
const MAX_WS_BUFFERED_BYTES = 4 * 1024 * 1024;

function toBytes(data: unknown): Uint8Array {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  throw new Error("Only binary WebSocket messages are supported");
}

function allowedPorts(env: Env): Set<number> {
  const raw = env.ALLOWED_PORTS?.trim();
  if (!raw) return new Set(DEFAULT_ALLOWED_PORTS);
  const ports = raw.split(",").map((value) => Number(value.trim()));
  if (ports.some((port) => !Number.isInteger(port) || port < 1 || port > 65535)) {
    throw new Error("ALLOWED_PORTS contains an invalid port");
  }
  return new Set(ports);
}

async function handleWebSocket(request: Request, env: Env): Promise<Response> {
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    return new Response("Expected WebSocket upgrade", { status: 426 });
  }
  if (!env.UUID) return new Response("Server is not configured: UUID secret is missing", { status: 503 });

  const pair = new WebSocketPair();
  const client = pair[0];
  const server = pair[1];
  server.accept({ allowHalfOpen: true });

  let upstream: ReturnType<typeof connect> | undefined;
  let upstreamWriter: WritableStreamDefaultWriter<Uint8Array> | undefined;
  let initialized = false;
  let closed = false;
  let messageChain = Promise.resolve();

  const closeBoth = async (code = 1000, reason = "connection closed") => {
    if (closed) return;
    closed = true;
    try { server.close(code, reason.slice(0, 100)); } catch { /* already closed */ }
    try { await upstreamWriter?.close(); } catch { /* already closed */ }
    try { await upstream?.close(); } catch { /* already closed */ }
  };

  const pumpUpstream = async (socket: ReturnType<typeof connect>) => {
    const reader = socket.readable.getReader();
    try {
      while (!closed) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value?.byteLength) {
          if (server.readyState !== WebSocket.OPEN) break;
          if (server.bufferedAmount > MAX_WS_BUFFERED_BYTES) {
            await closeBoth(1013, "client cannot keep up");
            break;
          }
          server.send(value);
        }
      }
    } finally {
      reader.releaseLock();
      if (!closed) await closeBoth(1000, "upstream ended");
    }
  };

  server.addEventListener("message", (event: MessageEvent) => {
    messageChain = messageChain.then(async () => {
      if (closed) return;
      const bytes = toBytes(event.data);
      if (bytes.byteLength > MAX_MESSAGE_BYTES) throw new Error("WebSocket message exceeds 8 MiB limit");

      if (!initialized) {
        const parsed = parseVlessRequest(bytes, env.UUID);
        if (!allowedPorts(env).has(parsed.port)) throw new Error("Destination port is not allowed");

        upstream = connect({ hostname: parsed.hostname, port: parsed.port }, { allowHalfOpen: true });
        await upstream.opened;
        upstreamWriter = upstream.writable.getWriter();
        initialized = true;
        server.send(new Uint8Array([parsed.version, 0]));
        if (parsed.payload.byteLength) await upstreamWriter.write(parsed.payload);
        void pumpUpstream(upstream).catch(() => closeBoth(1011, "upstream read failed"));
        return;
      }

      if (!upstreamWriter) throw new Error("Upstream is not ready");
      await upstreamWriter.write(bytes);
    }).catch(async (error: unknown) => {
      const reason = error instanceof Error ? error.message : "proxy error";
      await closeBoth(1008, reason);
    });
  });

  server.addEventListener("close", () => { void closeBoth(); });
  server.addEventListener("error", () => { void closeBoth(1011, "websocket error"); });

  return new Response(null, { status: 101, webSocket: client });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return Response.json({ ok: true, service: "worker-tcp-proxy", protocol: "vless-ws-tcp" });
    }
    if (url.pathname === "/") {
      return new Response("Worker TCP Proxy is running. WebSocket endpoint: /ws", {
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
    if (url.pathname === "/ws") return handleWebSocket(request, env);
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
