export function encodeSocksAddress(hostname: string): Uint8Array {
  const host = hostname;
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
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
