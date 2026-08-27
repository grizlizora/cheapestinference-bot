/**
 * Ultra-Low-Latency Zero-Cost Cloudflare Worker Edge Proxy
 * Reverse proxy for CheapestInference API & HTML endpoints.
 * Edge RTT: ~15-40ms | Trusted Cloudflare AS13335 Outbound Edge IP
 * 100,000 requests/day 100% Free Tier on Cloudflare
 */

export default {
  async fetch(request, env, ctx) {
    // 1. Method verification
    if (request.method !== "GET" && request.method !== "HEAD" && request.method !== "OPTIONS") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    // 2. CORS Preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
          "Access-Control-Allow-Headers": "*",
          "Access-Control-Max-Age": "86400",
        },
      });
    }

    // 3. Security Secret Verification (Optional token protection)
    const expectedSecret = env.PROXY_SECRET;
    if (expectedSecret) {
      const authHeader = request.headers.get("x-proxy-secret") || request.headers.get("authorization");
      const providedSecret = authHeader?.replace(/^Bearer\s+/i, "");
      if (providedSecret !== expectedSecret) {
        return new Response(JSON.stringify({ error: "Unauthorized proxy access" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    // 4. Target URL Extraction & Whitelist Validation
    const reqUrl = new URL(request.url);
    const targetUrlParam = reqUrl.searchParams.get("url") || request.headers.get("x-target-url");

    if (!targetUrlParam) {
      return new Response(
        JSON.stringify({
          error: "Missing target URL",
          usage: "GET /?url=https://api.cheapestinference.com/api/pools",
        }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    let targetUrl;
    try {
      targetUrl = new URL(targetUrlParam);
    } catch {
      return new Response(JSON.stringify({ error: "Invalid target URL format" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Whitelist allowed hosts
    const allowedHosts = ["cheapestinference.com", "api.cheapestinference.com", "www.cheapestinference.com"];
    if (!allowedHosts.includes(targetUrl.hostname)) {
      return new Response(
        JSON.stringify({ error: "Forbidden: Target host not in whitelist" }),
        { status: 403, headers: { "Content-Type": "application/json" } }
      );
    }

    // 5. Header Forwarding (Preserving ETag / If-None-Match for 304s)
    const upstreamHeaders = new Headers();
    const forwardedHeaders = [
      "accept",
      "accept-encoding",
      "accept-language",
      "if-none-match",
      "if-modified-since",
      "sec-ch-ua",
      "sec-ch-ua-mobile",
      "sec-ch-ua-platform",
      "sec-fetch-dest",
      "sec-fetch-mode",
      "sec-fetch-site",
      "sec-fetch-user",
      "user-agent",
      "priority",
    ];

    for (const name of forwardedHeaders) {
      const val = request.headers.get(name);
      if (val) upstreamHeaders.set(name, val);
    }

    upstreamHeaders.set("Origin", "https://cheapestinference.com");
    upstreamHeaders.set("Referer", "https://cheapestinference.com/pools");

    try {
      const originResponse = await fetch(targetUrl.toString(), {
        method: request.method,
        headers: upstreamHeaders,
        cf: {
          cacheTtl: 0, // Bypass edge cache to guarantee live GPU stock
          cacheEverything: false,
        },
      });

      // 6. Build Downstream Response (Streaming body, zero buffering overhead)
      const responseHeaders = new Headers(originResponse.headers);
      responseHeaders.set("Access-Control-Allow-Origin", "*");
      responseHeaders.set("X-Proxied-By", "Cloudflare-Worker-FastPath");

      return new Response(originResponse.body, {
        status: originResponse.status,
        statusText: originResponse.statusText,
        headers: responseHeaders,
      });
    } catch (err) {
      return new Response(
        JSON.stringify({ error: "Upstream fetch failed", message: err.message }),
        { status: 502, headers: { "Content-Type": "application/json" } }
      );
    }
  },
};
