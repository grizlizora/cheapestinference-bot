/**
 * src/http/undiciAgent.ts
 * Low-Level Undici Agent Factory, SOCKS5+TLS Connector & TLS Session Ticket Cache
 */

import { Dispatcher, Agent, ProxyAgent } from "undici";
import { SocksClient, SocksClientOptions } from "socks";
import tls from "node:tls";
import net from "node:net";
import { defaultDnsCache } from "./dnsCache.js";

export interface UndiciPoolConfig {
  connectTimeoutMs?: number;
  keepAliveTimeoutMs?: number;
  keepAliveMaxTimeoutMs?: number;
  maxConnections?: number;
  maxCachedDispatchers?: number;
}

export class TlsSessionTicketCache {
  private cache = new Map<string, Buffer>();

  public get(host: string): Buffer | undefined {
    return this.cache.get(host);
  }

  public set(host: string, ticket: Buffer): void {
    if (this.cache.size >= 50 && !this.cache.has(host)) {
      const oldest = this.cache.keys().next().value;
      if (oldest) this.cache.delete(oldest);
    }
    this.cache.set(host, ticket);
  }

  public clear(): void {
    this.cache.clear();
  }
}

export function createDirectUndiciAgent(config?: UndiciPoolConfig): Agent {
  return new Agent({
    connect: {
      timeout: config?.connectTimeoutMs ?? 8_000,
      lookup: defaultDnsCache.lookup as any,
      autoSelectFamily: true,
      autoSelectFamilyAttemptTimeout: 50,
      keepAlive: true,
      keepAliveInitialDelay: 1000,
      noDelay: true,
    },
    keepAliveTimeout: config?.keepAliveTimeoutMs ?? 45_000,
    keepAliveMaxTimeout: config?.keepAliveMaxTimeoutMs ?? 55_000,
    keepAliveTimeoutThreshold: 1000,
    pipelining: 1,
    connections: config?.maxConnections ?? 8,
    strictContentLength: false,
  });
}

export function createSocksDispatcher(
  proxyUrl: string,
  timeoutMs: number,
  tlsCache: TlsSessionTicketCache,
  config?: UndiciPoolConfig
): Agent {
  const parsed = new URL(proxyUrl);
  const host = parsed.hostname;
  const port = parseInt(parsed.port, 10) || 1080;
  const user = parsed.username ? decodeURIComponent(parsed.username) : undefined;
  const pass = parsed.password ? decodeURIComponent(parsed.password) : undefined;

  const socksConnector = (opts: any, callback: any) => {
    const destHost = opts.hostname || opts.host;
    const destPort =
      opts.port && parseInt(opts.port, 10) > 0
        ? parseInt(opts.port, 10)
        : opts.protocol === "http:"
        ? 80
        : 443;

    const socksOptions: SocksClientOptions = {
      proxy: {
        host,
        port,
        type: 5,
        userId: user,
        password: pass,
      },
      command: "connect",
      destination: {
        host: destHost,
        port: destPort,
      },
      timeout: Math.min(timeoutMs, 6_000),
    };

    const client = new SocksClient(socksOptions);
    let isHandshakeComplete = false;

    client.on("error", (err: any) => {
      if (!isHandshakeComplete) {
        isHandshakeComplete = true;
        callback(err, null);
      }
    });

    client.on("established", (info) => {
      info.socket.setNoDelay(true);

      if (opts.protocol === "https:" || destPort === 443) {
        const cachedSession = tlsCache.get(destHost);
        const tlsSocket = tls.connect({
          socket: info.socket,
          servername: opts.servername || destHost,
          rejectUnauthorized: true,
          ALPNProtocols: ["http/1.1"],
          session: cachedSession,
        });
        tlsSocket.setNoDelay(true);

        tlsSocket.on("session", (sessionBuffer: Buffer) => {
          tlsCache.set(destHost, sessionBuffer);
        });

        const tlsTimeout = Math.min(timeoutMs, 5_000);
        tlsSocket.setTimeout(tlsTimeout, () => {
          if (!isHandshakeComplete) {
            isHandshakeComplete = true;
            info.socket.destroy();
            tlsSocket.destroy(new Error("TLS Handshake Timeout over SOCKS5"));
            callback(new Error("TLS Handshake Timeout over SOCKS5"), null);
          }
        });

        tlsSocket.once("secureConnect", () => {
          if (!isHandshakeComplete) {
            isHandshakeComplete = true;
            tlsSocket.setTimeout(0);
            callback(null, tlsSocket);
          }
        });

        tlsSocket.on("error", (err) => {
          if (!isHandshakeComplete) {
            isHandshakeComplete = true;
            info.socket.destroy();
            callback(err, null);
          }
        });

        info.socket.on("error", (err) => {
          if (!isHandshakeComplete) {
            isHandshakeComplete = true;
            tlsSocket.destroy();
            callback(err, null);
          }
        });
      } else {
        isHandshakeComplete = true;
        callback(null, info.socket);
      }
    });

    client.connect();
  };

  return new Agent({
    connect: socksConnector as any,
    keepAliveTimeout: config?.keepAliveTimeoutMs ?? 45_000,
    keepAliveMaxTimeout: config?.keepAliveMaxTimeoutMs ?? 55_000,
    keepAliveTimeoutThreshold: 1000,
    connections: config?.maxConnections ?? 8,
    strictContentLength: false,
  });
}

export function createHttpProxyAgent(
  proxyUrl: string,
  timeoutMs: number,
  config?: UndiciPoolConfig
): ProxyAgent {
  return new ProxyAgent({
    uri: proxyUrl,
    connect: { timeout: timeoutMs },
    keepAliveTimeout: config?.keepAliveTimeoutMs ?? 45_000,
    keepAliveMaxTimeout: config?.keepAliveMaxTimeoutMs ?? 55_000,
    connections: config?.maxConnections ?? 8,
  });
}

export class UndiciDispatcherPool {
  private dispatchers = new Map<string, Dispatcher>();
  private readonly directAgent: Agent;
  private readonly tlsCache: TlsSessionTicketCache;
  private readonly maxCached: number;

  constructor(private readonly config?: UndiciPoolConfig) {
    this.maxCached = config?.maxCachedDispatchers ?? 10;
    this.tlsCache = new TlsSessionTicketCache();
    this.directAgent = createDirectUndiciAgent(config);
  }

  public getDirectDispatcher(): Dispatcher {
    return this.directAgent;
  }

  public getOrCreateDispatcher(proxyUrl: string | null, timeoutMs: number): Dispatcher {
    if (!proxyUrl) return this.directAgent;

    let dispatcher = this.dispatchers.get(proxyUrl);
    if (dispatcher) return dispatcher;

    if (this.dispatchers.size >= this.maxCached) {
      const oldestKey = this.dispatchers.keys().next().value;
      if (oldestKey) {
        this.invalidate(oldestKey);
      }
    }

    const parsed = new URL(proxyUrl);
    if (parsed.protocol.startsWith("socks")) {
      dispatcher = createSocksDispatcher(proxyUrl, timeoutMs, this.tlsCache, this.config);
    } else {
      dispatcher = createHttpProxyAgent(proxyUrl, timeoutMs, this.config);
    }

    this.dispatchers.set(proxyUrl, dispatcher);
    return dispatcher;
  }

  public invalidate(proxyUrl: string): void {
    const existing = this.dispatchers.get(proxyUrl);
    if (existing) {
      this.dispatchers.delete(proxyUrl);
      try {
        existing.destroy();
      } catch {}
    }
  }

  public destroy(): void {
    try {
      this.directAgent.destroy();
    } catch {}
    for (const d of this.dispatchers.values()) {
      try {
        d.destroy();
      } catch {}
    }
    this.dispatchers.clear();
    this.tlsCache.clear();
  }
}
