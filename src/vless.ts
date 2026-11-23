export type ParsedRequest = {
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
  if (parts.length !== 4 || parts.some((p) => !/^\\d{1,3}$/.test(p) || Number(p) > 255)) return false;
  const [a, b, c] = parts.map(Number);
  return a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 168 || (b === 0 && c === 0) || (b === 0 && c === 2) || (b === 0 && c === 0))) ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113);
}

function isPrivateIPv6(host: string): boolean {
  const value = host.toLowerCase();
  if (value === "::" || value === "::1") return true;
  if (value.startsWith("fc") || value.startsWith("fd") || /^fe[89ab]/.test(value)) return true;
  if (value.startsWith("ff")) return true;
  const mapped = value.match(/^::ffff:(\\d{1,3}(?:\\.\\d{1,3}){3})$/);
  return mapped ? isPrivateIPv4(mapped[1]) : false;
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
  if (hostname.length > 253 || /[^a-zA-Z0-9.\\-_:]/.test(hostname)) throw new Error("Invalid destination hostname");
  const normalized = hostname.toLowerCase().replace(/^\\[|\\]$/g, "");
  if (normalized === "localhost" || normalized.endsWith(".localhost") ||
      normalized.endsWith(".local") || normalized.endsWith(".internal") ||
      isPrivateIPv4(normalized) || isPrivateIPv6(normalized)) {
    throw new Error("Private or local destinations are not allowed");
  }

  const payloadOffset = addressOffset + addressLength;
  return { version, hostname, port, payload: data.slice(payloadOffset) };
}
