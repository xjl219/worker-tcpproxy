import { describe, expect, it } from "vitest";
import { parseVlessRequest } from "../src/vless";
import { encodeSocksAddress } from "../src/socks5";

const UUID = "00000000-0000-4000-8000-000000000001";

function makeRequest(host: string, port = 443, addressType = 2): Uint8Array {
  const uuid = UUID.replaceAll("-", "").match(/.{2}/g)!.map((x) => Number.parseInt(x, 16));
  if (addressType === 1) {
    const octets = host.split(".").map(Number);
    return new Uint8Array([0, ...uuid, 0, 1, (port >> 8) & 0xff, port & 0xff, 1, ...octets]);
  }
  const domain = new TextEncoder().encode(host);
  return new Uint8Array([0, ...uuid, 0, 1, (port >> 8) & 0xff, port & 0xff, 2, domain.length, ...domain]);
}

describe("VLESS request parser", () => {
  it("parses a domain TCP request", () => {
    const result = parseVlessRequest(makeRequest("example.com"), UUID);
    expect(result.hostname).toBe("example.com");
    expect(result.port).toBe(443);
  });

  it("rejects an incorrect UUID", () => {
    expect(() => parseVlessRequest(makeRequest("example.com"), "10000000-0000-4000-8000-000000000001"))
      .toThrow("Invalid VLESS UUID");
  });

  it.each(["10.0.0.1", "127.0.0.1", "169.254.1.1", "192.168.1.1", "100.64.0.1", "198.18.0.1", "203.0.113.1"])(
    "rejects non-public IPv4 destination %s", (host) => {
      expect(() => parseVlessRequest(makeRequest(host, 443, 1), UUID)).toThrow("Private or local");
    },
  );

  it("rejects UDP command", () => {
    const data = makeRequest("example.com");
    data[18] = 2;
    expect(() => parseVlessRequest(data, UUID)).toThrow("Only VLESS TCP");
  });
});


describe("SOCKS5 destination address encoding", () => {
  it("encodes IPv4 as ATYP 1 with four address octets", () => {
    expect(Array.from(encodeSocksAddress("8.8.4.4"))).toEqual([1, 8, 8, 4, 4]);
  });

  it("encodes domains as ATYP 3", () => {
    expect(Array.from(encodeSocksAddress("example.com"))).toEqual([
      3, 11, ...new TextEncoder().encode("example.com"),
    ]);
  });

  it("encodes compressed IPv6 as ATYP 4 with sixteen address bytes", () => {
    const encoded = encodeSocksAddress("2001:db8::1");
    expect(encoded[0]).toBe(4);
    expect(encoded).toHaveLength(17);
    expect(Array.from(encoded.slice(1))).toEqual([
      0x20, 0x01, 0x0d, 0xb8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1,
    ]);
  });
});
