import { describe, it, expect } from "vitest";
import { TorManager } from "../src/proxy/torManager.js";

describe("TorManager", () => {
  it("should format SOCKS5h URL correctly", () => {
    const tor = new TorManager({ socksHost: "127.0.0.1", socksPort: 9050 });
    expect(tor.getSocksUrl()).toBe("socks5h://127.0.0.1:9050");
  });

  it("should deduplicate concurrent renewCircuit calls using mutex promise", async () => {
    const tor = new TorManager({ minNewnymIntervalMs: 50 });
    
    // Simulate non-running Tor ControlPort
    const p1 = tor.renewCircuit();
    const p2 = tor.renewCircuit();

    // Both should return the same underlying in-flight Promise instance
    expect(p1).toBe(p2);

    const [res1, res2] = await Promise.all([p1, p2]);
    expect(res1).toBe(false); // Fails gracefully since control port not running in test env
    expect(res2).toBe(false);
  });
});
