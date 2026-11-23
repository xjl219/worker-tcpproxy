import { connect } from "cloudflare:sockets";
import { parseVlessRequest } from "./vless";

interface Env {
  UUID: string;
  ALLOWED_PORTS?: string;
  SOCKS5_HOST: string;
  SOCKS5_PORT?: string;
  SOCKS5_USERNAME?: string;
  SOCKS5_PASSWORD?: string;
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
  const normalized = decoded.replace(/\\\\/g, "/");
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

class SocketReader {
  private buffer = new Uint8Array(0);
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;

  constructor(readable: ReadableStream<Uint8Array>) {
    this.reader = readable.getReader();
  }

  async readExactly(length: number): Promise<Uint8Array> {
    while (this.buffer.length < length) {
      const { value, done } = await this.reader.read();
      if (done || !value) throw new Error("SOCKS5 upstream closed during handshake");
      const merged = new Uint8Array(this.buffer.length + value.length);
      merged.set(this.buffer);
      merged.set(value, this.buffer.length);
      this.buffer = merged;
    }
    const result = this.buffer.slice(0, length);
    this.buffer = this.buffer.slice(length);
    return result;
  }

  async pumpTo(websocket: WebSocket, isClosed: () => boolean): Promise<void> {
    try {
      while (!isClosed()) {
        let chunk: Uint8Array | undefined;
        if (this.buffer.length) {
          chunk = this.buffer;
          this.buffer = new Uint8Array(0);
        } else {
          const { value, done } = await this.reader.read();
          if (done) break;
          chunk = value;
        }
        if (chunk?.length) {
          if (websocket.readyState !== WebSocket.OPEN) break;
          if (websocket.bufferedAmount > MAX_WS_BUFFERED_BYTES) {
            try { websocket.close(1013, "client cannot keep up"); } catch { /* already closed */ }
            break;
          }
          websocket.send(chunk);
        }
      }
    } finally {
      try { this.reader.releaseLock(); } catch { /* already released */ }
    }
  }
}

function encodeSocksAddress(hostname: string): Uint8Array {
  const host = hostname.replace(/^\\[|\\]$/g, "");
  const ipv4 = host.match(/^(\\d{1,3})\\.(\\d{1,3})\\.(\\d{1,3})\\.(\\d{1,3})$/);
  if (ipv4 && ipv4.every((part) => Number(part) <= 255)) {
    return new Uint8Array([1, ...ipv4.map(Number)]);
  }
  if (host.includes(":")) {
    const halves = host.split("::");
    if (halves.length > 2) throw new Error("Invalid IPv6 destination");
    const left = halves[0] ? halves[0].split(":") : [];
    const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
    const missing = 8 - left.length - right.length;
    if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) {
      throw new Error("Invalid IPv6 destination");
    }
    const groups = [...left, ...Array(missing).fill("0"), ...right];
    if (groups.length !== 8 || groups.some((part) => !/^[0-9a-fA-F]{1,4}$/.test(part))) {
      throw new Error("Invalid IPv6 destination");
    }
    const bytes = groups.flatMap((part) => {
      const value = Number.parseInt(part, 16);
      return [value >> 8, value & 255];
    });
    return new Uint8Array([4, ...bytes]);
  }
  const domain = new TextEncoder().encode(host);
  if (!domain.length || domain.length > 255) throw new Error("Invalid SOCKS5 destination hostname");
  return new Uint8Array([3, domain.length, ...domain]);
}

async function connectViaSocks5(
  env: Env,
  destinationHost: string,
  destinationPort: number,
): Promise<{ socket: ReturnType<typeof connect>; reader: SocketReader; writer: WritableStreamDefaultWriter<Uint8Array> }> {
  if (!env.SOCKS5_HOST?.trim()) throw new Error("SOCKS5_HOST is not configured");
  const proxyPort = Number(env.SOCKS5_PORT || "1080");
  if (!Number.isInteger(proxyPort) || proxyPort < 1 || proxyPort > 65535) {
    throw new Error("SOCKS5_PORT is invalid");
  }
  const username = env.SOCKS5_USERNAME || "";
  const password = env.SOCKS5_PASSWORD || "";
  if ((username.length > 0) !== (password.length > 0)) {
    throw new Error("Both SOCKS5_USERNAME and SOCKS5_PASSWORD must be set together");
  }
  if (username.length > 255 || password.length > 255) throw new Error("SOCKS5 credentials exceed protocol limits");

  const socket = connect({ hostname: env.SOCKS5_HOST.trim(), port: proxyPort }, { allowHalfOpen: true });
  await socket.opened;
  const writer = socket.writable.getWriter();
  const reader = new SocketReader(socket.readable);

  try {
    await writer.write(new Uint8Array(username ? [5, 2, 0, 2] : [5, 1, 0]));
    const greeting = await reader.readExactly(2);
    if (greeting[0] !== 5 || greeting[1] === 255) throw new Error("SOCKS5 proxy rejected authentication methods");
    if (greeting[1] === 2) {
      if (!username) throw new Error("SOCKS5 proxy requires username/password authentication");
      const userBytes = new TextEncoder().encode(username);
      const passBytes = new TextEncoder().encode(password);
      await writer.write(new Uint8Array([1, userBytes.length, ...userBytes, passBytes.length, ...passBytes]));
      const authReply = await reader.readExactly(2);
      if (authReply[0] !== 1 || authReply[1] !== 0) throw new Error("SOCKS5 authentication failed");
    } else if (greeting[1] !== 0) {
      throw new Error("SOCKS5 proxy selected an unsupported authentication method");
    }

    const address = encodeSocksAddress(destinationHost);
    await writer.write(new Uint8Array([
      5, 1, 0, ...address, (destinationPort >> 8) & 255, destinationPort & 255,
    ]));
    const reply = await reader.readExactly(4);
    if (reply[0] !== 5 || reply[2] !== 0) throw new Error("Invalid SOCKS5 CONNECT response");
    if (reply[1] !== 0) throw new Error("SOCKS5 CONNECT failed with code " + reply[1]);

    if (reply[3] === 1) await reader.readExactly(4);
    else if (reply[3] === 4) await reader.readExactly(16);
    else if (reply[3] === 3) {
      const length = await reader.readExactly(1);
      await reader.readExactly(length[0]);
    } else throw new Error("SOCKS5 returned an invalid bound address type");
    await reader.readExactly(2);

    return { socket, reader, writer };
  } catch (error) {
    try { await writer.close(); } catch { /* already closed */ }
    try { await socket.close(); } catch { /* already closed */ }
    throw error;
  }
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

  server.addEventListener("message", (event: MessageEvent) => {
    messageChain = messageChain.then(async () => {
      if (closed) return;
      const bytes = toBytes(event.data);
      if (bytes.byteLength > MAX_MESSAGE_BYTES) throw new Error("WebSocket message exceeds 8 MiB limit");

      if (!initialized) {
        const parsed = parseVlessRequest(bytes, env.UUID);
        if (!allowedPorts(env).has(parsed.port)) throw new Error("Destination port is not allowed");

        const connection = await connectViaSocks5(env, parsed.hostname, parsed.port);
        upstream = connection.socket;
        upstreamWriter = connection.writer;
        initialized = true;
        server.send(new Uint8Array([parsed.version, 0]));
        if (parsed.payload.byteLength) await upstreamWriter.write(parsed.payload);
        void connection.reader.pumpTo(server, () => closed)
          .finally(() => { if (!closed) void closeBoth(1000, "upstream ended"); })
          .catch(() => closeBoth(1011, "upstream read failed"));
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
      const configured = Boolean(env.SOCKS5_HOST?.trim());
      return Response.json(
        { ok: true, service: "worker-tcpproxy-socks5", socks5Configured: configured },
        { headers: SECURITY_HEADERS },
      );
    }
    if (url.pathname === "/") {
      return response("Worker TCP Proxy (SOCKS5 upstream) is running.", 200, { "content-type": "text/plain; charset=utf-8" });
    }
    if (url.pathname === "/ws") return handleWebSocket(request, env);
    return response("Not found", 404);
  },
} satisfies ExportedHandler<Env>;
