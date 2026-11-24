import { describe, expect, it } from "vitest";
import worker from "../src/index";

const baseEnv = {
  UUID: "00000000-0000-4000-8000-000000000001",
  PROXY_ENABLED: "false",
  OUTBOUND_MODE: "direct",
};

describe("public HTTP surface", () => {
  it("hides health by default", async () => {
    const response = await worker.fetch(new Request("https://worker.example/health"), baseEnv, {} as ExecutionContext);
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Not found");
  });

  it("exposes only a generic liveness response when health is explicitly enabled", async () => {
    const response = await worker.fetch(
      new Request("https://worker.example/health"),
      { ...baseEnv, HEALTH_ENABLED: "true" },
      {} as ExecutionContext,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it("returns the same not-found response for root and unknown paths", async () => {
    for (const path of ["/", "/admin", "/robots.txt", "/.env"]) {
      const response = await worker.fetch(new Request("https://worker.example" + path), baseEnv, {} as ExecutionContext);
      expect(response.status).toBe(404);
      expect(await response.text()).toBe("Not found");
    }
  });

  it("does not reveal the WebSocket route to ordinary HTTP probes", async () => {
    const response = await worker.fetch(new Request("https://worker.example/ws"), baseEnv, {} as ExecutionContext);
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Not found");
  });
});
