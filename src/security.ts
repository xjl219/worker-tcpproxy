const DOMAIN_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function normalizeDestinationHostname(input: string): string {
  const host = input.trim().toLowerCase().replace(/\\.$/, "");
  if (!host || host.length > 253 || host.includes("*") || host.includes("/") ||
      host.includes("@") || host.includes(":") || host.includes("%") ||
      host.includes("\\\\") || /\\s/.test(host)) {
    throw new Error("Destination must be a DNS hostname");
  }
  if (/^\\d+(?:\\.\\d+){0,3}$/.test(host)) {
    throw new Error("IP-literal destinations are not allowed");
  }
  const labels = host.split(".");
  if (labels.length < 2 || labels.some((label) => !DOMAIN_LABEL.test(label))) {
    throw new Error("Invalid destination hostname");
  }
  return host;
}

export function parseAllowedHosts(raw: string | undefined): Set<string> {
  if (!raw?.trim()) return new Set();
  const entries = raw.split(",");
  const hosts = new Set<string>();
  for (const entry of entries) {
    const value = entry.trim();
    if (!value) throw new Error("ALLOWED_HOSTS contains an empty entry");
    hosts.add(normalizeDestinationHostname(value));
  }
  return hosts;
}

export function isDomainFilterEnabled(raw: string | undefined): boolean {
  return raw?.trim().toLowerCase() === "true";
}

/**
 * Each configured root domain authorizes the apex and its DNS subdomains.
 * The dot boundary prevents "evil-example.com" matching "example.com".
 */
export function isAllowedDestinationHost(hostname: string, allowed: Set<string>): boolean {
  try {
    const host = normalizeDestinationHostname(hostname);
    for (const root of allowed) {
      if (host === root || host.endsWith("." + root)) return true;
    }
    return false;
  } catch {
    return false;
  }
}
