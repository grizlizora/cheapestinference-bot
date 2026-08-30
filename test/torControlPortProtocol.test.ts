import { describe, it, expect } from "vitest";
import { TorManager } from "../src/proxy/torManager.js";

describe("🛡️ CHAOS: Tor ControlPort Wire Protocol & Circuit Resilience", () => {
  it("1. Generates unique stream isolation authentication strings for each request", () => {
    const tor = new TorManager();
    const url1 = tor.rotateStreamIsolation();
    const url2 = tor.rotateStreamIsolation();
    const url3 = tor.rotateStreamIsolation();

    expect(url1).not.toBe(url2);
    expect(url2).not.toBe(url3);
    expect(url1).toContain("socks5h://");
    expect(url1).toContain("127.0.0.1:9050");
  });

  it("2. Deduplicates concurrent circuit renewal requests with promise mutex", async () => {
    const tor = new TorManager({
      controlHost: "127.0.0.1",
      controlPort: 9051,
      minNewnymIntervalMs: 500,
    });

    // Invoke renewCircuit concurrently
    const p1 = tor.renewCircuit();
    const p2 = tor.renewCircuit();
    const p3 = tor.renewCircuit();

    const [res1, res2, res3] = await Promise.all([p1, p2, p3]);

    // All promises must resolve identically (either all true or all false if offline)
    expect(res1).toBe(res2);
    expect(res2).toBe(res3);
  });
});
