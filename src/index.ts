import { connect } from "cloudflare:sockets";
import { parseVlessRequest } from "./vless";

interface Env {
  UUID: string;
  ALLOWED_PORTS?: string;
}

const DEFAULT_ALLOWED_PORTS = [80, 443, 8080, 8443, 2053, 2083, 2087, 2096];
const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;
const MAX_WS_BUFFERED_BYTES = 4 * 1024 * 1024;
const SECURITY_HEADERS = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
};

function response(body: BodyInit | null, status: number, headers?: HeadersInit): Response {
  const merged = new Headers(SECURITY_HEADERS);
  if (headers) new Headers(headers).forEach((value, key) => merged.set(key, value));
  return new Response(body, { status, headers: merged });
}

function isSensitivePath(pathname: string): boolean {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname).toLowerCase();
  } catch {
    return true;
  }
  const normalized = decoded.replace(/\\/g, "/");
  return normalized.split("/").some((part) =>
    part === ".env" || part === ".git" || part === ".vscode" ||
    part === ".svn" || part === ".hg" || part === "actuator" ||
    part === "wp-admin" || part === "phpmyadmin"
  );
}

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
  if (request.method !== "GET") return response("Method not allowed", 405, { allow: "GET" });
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    return response("Expected WebSocket upgrade", 426);
  }
  if (!env.UUID) return response("Service unavailable", 503);

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
    if (isSensitivePath(url.pathname)) return response("Not found", 404);
    if (request.method !== "GET") return response("Method not allowed", 405, { allow: "GET" });

    if (url.pathname === "/health") {
      return Response.json(
        { ok: true, service: "edge-service" },
        { headers: SECURITY_HEADERS },
      );
    }
    if (url.pathname === "/") {
      return response("Worker TCP Proxy is running.", 200, { "content-type": "text/plain; charset=utf-8" });
    }
    if (url.pathname === "/ws") return handleWebSocket(request, env);
    return response("Not found", 404);
  },
} satisfies ExportedHandler<Env>;
