import { describe, expect, it } from "vitest";
import { parseSecretNames, resolveDeploymentUuid, validateUuid } from "../scripts/deploy.mjs";

const UUID = "00000000-0000-4000-8000-000000000001";

describe("secure deployment UUID handling", () => {
  it("prefers an explicitly configured deployment UUID", () => {
    expect(resolveDeploymentUuid({ configuredUuid: UUID, secretNames: new Set(["UUID"]) }))
      .toEqual({ action: "set", uuid: UUID });
  });

  it("reuses the existing Cloudflare secret when no override is supplied", () => {
    expect(resolveDeploymentUuid({ configuredUuid: undefined, secretNames: new Set(["UUID"]) }))
      .toEqual({ action: "reuse", uuid: null });
  });

  it("generates a UUID only when neither override nor remote secret exists", () => {
    const result = resolveDeploymentUuid({ configuredUuid: undefined, secretNames: new Set() });
    expect(result.action).toBe("set");
    expect(result.uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });

  it("recognizes UUID in Wrangler JSON secret listings", () => {
    expect(parseSecretNames('[{"name":"UUID","type":"secret_text"},{"name":"SOCKS5_PASSWORD"}]'))
      .toEqual(new Set(["UUID", "SOCKS5_PASSWORD"]));
  });

  it("fails closed on malformed Wrangler output rather than rotating credentials", () => {
    expect(() => parseSecretNames("not json")).toThrow("refusing to rotate");
    expect(() => parseSecretNames('{"unexpected":[]}')).toThrow("refusing to rotate");
  });

  it("rejects malformed configured UUID values", () => {
    expect(() => validateUuid("not-a-uuid")).toThrow("canonical UUID");
  });
});
