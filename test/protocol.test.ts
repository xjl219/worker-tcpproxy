import { describe, expect, it } from "vitest";
import { parseVlessRequest } from "../src/vless";

const UUID = "00000000-0000-4000-8000-000000000001";

function makeRequest(host: string, port = 443): Uint8Array {
  const uuid = UUID.replaceAll("-", "").match(/.{2}/g)!.map((x) => Number.parseInt(x, 16));
  const domain = new TextEncoder().encode(host);
  return new Uint8Array([
    0, ...uuid, 0, 1, (port >> 8) & 0xff, port & 0xff,
    2, domain.length, ...domain, 0x16, 0x03, 0x01,
  ]);
}

describe("VLESS request parser", () => {
  it("parses a domain TCP request and keeps early payload", () => {
    const result = parseVlessRequest(makeRequest("example.com"), UUID);
    expect(result.hostname).toBe("example.com");
    expect(result.port).toBe(443);
    expect(Array.from(result.payload)).toEqual([0x16, 0x03, 0x01]);
  });

  it("rejects an incorrect UUID", () => {
    expect(() => parseVlessRequest(makeRequest("example.com"), "10000000-0000-4000-8000-000000000001"))
      .toThrow("Invalid VLESS UUID");
  });

  it("rejects a private IPv4 destination", () => {
    const uuid = UUID.replaceAll("-", "").match(/.{2}/g)!.map((x) => Number.parseInt(x, 16));
    const bytes = new Uint8Array([0, ...uuid, 0, 1, 1, 187, 1, 10, 0, 0, 1]);
    expect(() => parseVlessRequest(bytes, UUID)).toThrow("Private or local");
  });

  it("rejects UDP command", () => {
    const data = makeRequest("example.com");
    data[18] = 2;
    expect(() => parseVlessRequest(data, UUID)).toThrow("Only VLESS TCP");
  });
});
