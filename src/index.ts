import { connect } from "cloudflare:sockets";

interface Env {
  UUID: string;
  ALLOWED_PORTS?: string;
}

const DEFAULT_ALLOWED_PORTS = [80, 443, 8080, 8443, 2053, 2083, 2087, 2096];
const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;
const MAX_WS_BUFFERED_BYTES = 4 * 1024 * 1024;

type ParsedRequest = {
  version: number;
  hostname: string;
  port: number;
  payload: Uint8Array;
};

function uuidToBytes(uuid: string): Uint8Array {
  const hex = uuid.replaceAll("-", "").toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(hex)) {
    throw new Error("UUID must be a valid 32-character UUID");
  }
  return Uint8Array.from(hex.match(/.{2}/g)!, (part) => Number.parseInt(part, 16));
}

function bytesToIPv6(bytes: Uint8Array): string {
  const groups: string[] = [];
  for (let i = 0; i < 16; i += 2) {
    groups.push(((bytes[i] << 8) | bytes[i + 1]).toString(16));
  }
  return groups.join(":");
}

function isPrivateIPv4(host: string): boolean {
  const parts = host.split(".");
  if (parts.length !== 4 || parts.some((p) => !/^\d{1,3}$/.test(p) || Number(p) > 255)) return false;
  const [a, b] = parts.map(Number);
  return a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

function isPrivateIPv6(host: string): boolean {
  const value = host.toLowerCase();
  return value === "::" || value === "::1" || value.startsWith("fc") ||
    value.startsWith("fd") || /^fe[89ab]/.test(value) || value.startsWith("::ffff:127.") ||
    value.startsWith("::ffff:10.") || value.startsWith("::ffff:192.168.");
}

export function parseVlessRequest(data: Uint8Array, expectedUuid: string): ParsedRequest {
  if (data.length < 22) throw new Error("Incomplete VLESS request header");

  const expected = uuidToBytes(expectedUuid);
  let mismatch = 0;
  for (let i = 0; i < 16; i++) mismatch |= data[1 + i] ^ expected[i];
  if (mismatch !== 0) throw new Error("Invalid VLESS UUID");

  const version = data[0];
  const addonLength = data[17];
  const commandOffset = 18 + addonLength;
  if (data.length < commandOffset + 4) throw new Error("Incomplete VLESS address header");

  const command = data[commandOffset];
  if (command !== 0x01) throw new Error("Only VLESS TCP command is supported");

  const port = (data[commandOffset + 1] << 8) | data[commandOffset + 2];
  const addressType = data[commandOffset + 3];
  let hostname: string;
  let addressLength: number;
  let addressOffset = commandOffset + 4;

  if (addressType === 0x01) {
    addressLength = 4;
    if (data.length < addressOffset + addressLength) throw new Error("Incomplete IPv4 address");
    hostname = Array.from(data.subarray(addressOffset, addressOffset + 4)).join(".");
  } else if (addressType === 0x02) {
    if (data.length < addressOffset + 1) throw new Error("Incomplete domain length");
    addressLength = data[addressOffset++];
    if (addressLength < 1 || data.length < addressOffset + addressLength) throw new Error("Invalid domain address");
    hostname = new TextDecoder().decode(data.subarray(addressOffset, addressOffset + addressLength));
  } else if (addressType === 0x03) {
    addressLength = 16;
    if (data.length < addressOffset + addressLength) throw new Error("Incomplete IPv6 address");
    hostname = bytesToIPv6(data.subarray(addressOffset, addressOffset + addressLength));
  } else {
    throw new Error("Unsupported VLESS address type");
  }

  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid destination port");
  if (hostname.length > 253 || /[^a-zA-Z0-9.\-_:]/.test(hostname)) throw new Error("Invalid destination hostname");
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized === "localhost" || normalized.endsWith(".localhost") ||
      normalized.endsWith(".local") || normalized.endsWith(".internal") ||
      isPrivateIPv4(normalized) || isPrivateIPv6(normalized)) {
    throw new Error("Private or local destinations are not allowed");
  }

  const payloadOffset = addressOffset + addressLength;
  return { version, hostname, port, payload: data.slice(payloadOffset) };
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
