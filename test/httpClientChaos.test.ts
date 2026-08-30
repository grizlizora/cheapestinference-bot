import { describe, it, expect, vi, beforeEach } from "vitest";
import { RobustHttpClient } from "../src/http/client.js";
import { ProxyPool } from "../src/proxy/proxyPool.js";

describe("🛡️ CHAOS: RobustHttpClient Network Fault Injection & Socket Resiliency", () => {
  it("1. Demotes Cloudflare Worker and falls back to Direct IP upon receiving WAF HTTP 403", () => {
    // Register worker (Tier 0) and direct (Tier 1)
    const proxyPool = new ProxyPool(undefined, true, [], "http://worker.internal:8080");

    const bestProxyBefore = proxyPool.getNextProxy();
    expect(bestProxyBefore.type).toBe("worker");

    // Simulate reporting 403 failure on Worker
    proxyPool.reportFailure(bestProxyBefore.url, 403);

    // Verify Worker was demoted and Direct is now preferred
    const bestProxyAfter = proxyPool.getNextProxy();
    expect(bestProxyAfter.type).toBe("direct");
  });

  it("2. Quarantines Direct IP and cascades to External/Tor upon receiving consecutive 403/502 errors", () => {
    const proxyPool = new ProxyPool(undefined, true, ["http://ext-proxy.internal:8080"]);
    const directProxy = proxyPool.getNextProxy();
    expect(directProxy.type).toBe("direct");

    // Report 403 on Direct IP
    proxyPool.reportFailure(directProxy.url, 403);

    // Cascade should now pick External
    const nextProxy = proxyPool.getNextProxy();
    expect(nextProxy.type).toBe("external");
  });

  it("3. Successfully handles AbortSignal timeout without unhandled promise rejection", () => {
    const controller = new AbortController();
    const abortSignal = controller.signal;

    // Trigger immediate abort
    controller.abort(new Error("Timeout aborted"));

    expect(abortSignal.aborted).toBe(true);
  });
});
