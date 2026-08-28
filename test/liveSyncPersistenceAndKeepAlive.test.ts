import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import http from "node:http";
import { initSchema } from "../src/db/index.js";
import { ActiveDashboardDAO } from "../src/db/dao/activeDashboards.js";
import { ActiveDashboardRegistry } from "../src/bot/liveSync/dashboardRegistry.js";
import { formatMonitoringFooter } from "../src/bot/views/common.js";
import { createHealthServer } from "../src/server/health.js";

describe("Persistent LiveSync Dashboard & Keep-Alive Resilience Invariants", () => {
  let db: Database.Database;
  let dao: ActiveDashboardDAO;

  beforeEach(() => {
    db = new Database(":memory:");
    initSchema(db);
    // Seed test user
    db.prepare(
      "INSERT INTO users (id, telegram_id, first_name, language) VALUES (1, 828157777, 'Admin', 'uk')"
    ).run();
    dao = new ActiveDashboardDAO(db);
  });

  afterEach(() => {
    db.close();
  });

  it("1. should persist active dashboard sessions to SQLite and survive application reboot", () => {
    // Phase 1: User opens bot and registers a dashboard
    dao.upsert({
      chat_id: 828157777,
      message_id: 1042,
      user_id: 1,
      view_type: "dashboard",
      pool_slug: null,
      language: "uk",
    });

    const candidateBefore = dao.getHydrationCandidates();
    expect(candidateBefore.length).toBe(1);
    expect(candidateBefore[0].chat_id).toBe(828157777);
    expect(candidateBefore[0].message_id).toBe(1042);
    expect(candidateBefore[0].view_type).toBe("dashboard");

    // Phase 2: Simulate Container Reboot by instantiating fresh Registry from DB
    const restoredRegistry = new ActiveDashboardRegistry(dao);
    expect(restoredRegistry.size()).toBe(1);

    const session = restoredRegistry.get(828157777);
    expect(session).toBeDefined();
    expect(session?.messageId).toBe(1042);
    expect(session?.lang).toBe("uk");
    expect(session?.viewType).toBe("dashboard");
  });

  it("2. should distinguish Active (<30m) vs Eco-Sync (30m-24h) and dispatch real-time slot updates to both", () => {
    const registry = new ActiveDashboardRegistry(dao);

    // User A: Active user (< 10 minutes ago)
    registry.register(111, 101, 1, "uk", "dashboard");
    // User B: Sleeping user (5 hours ago)
    registry.register(222, 202, 1, "en", "dashboard");
    const sessionB = registry.get(222)!;
    sessionB.lastUserInteractionAt = Date.now() - 5 * 60 * 60 * 1000; // 5 hours ago
    sessionB.lastTelegramEditAt = Date.now() - 2 * 60 * 1000; // 2 minutes ago

    // User C: Ancient session (3 days ago - beyond 48h limit)
    registry.register(333, 303, 1, "ru", "dashboard");
    const sessionC = registry.get(333)!;
    sessionC.lastUserInteractionAt = Date.now() - 72 * 60 * 60 * 1000;

    // Invariant A: On slot drop event (diff_events), BOTH active and eco users (<24h) MUST get immediate update
    const dataChangeSessions = registry.getSessionsForDataChange();
    const dataChangeChatIds = dataChangeSessions.map((s) => s.chatId);
    expect(dataChangeChatIds).toContain(111);
    expect(dataChangeChatIds).toContain(222);
    expect(dataChangeChatIds).not.toContain(333); // >24h excluded

    // Invariant B: On routine heartbeat poll (no slot changes):
    // Active user (111) is eligible if >=15s passed; Eco user (222) is eligible if >=60s passed
    const heartbeatSessions = registry.getSessionsForHeartbeat();
    const heartbeatChatIds = heartbeatSessions.map((s) => s.chatId);
    expect(heartbeatChatIds).toContain(111);
    expect(heartbeatChatIds).toContain(222); // 2m > 60s
  });

  it("3. should render dynamic formatMonitoringFooter correctly across active and eco tiers", () => {
    const now = Date.now();

    // Active user
    const activeFooter = formatMonitoringFooter(now, "uk", now - 5 * 60 * 1000);
    expect(activeFooter).toContain("UTC (🟢 Live 5s)");

    // Sleeping / Eco user (e.g. 6 hours ago)
    const ecoFooter = formatMonitoringFooter(now, "uk", now - 6 * 60 * 60 * 1000);
    expect(ecoFooter).toContain("UTC (🟢 Моніторинг активний)");

    // Standby user (30 hours ago)
    const standbyFooter = formatMonitoringFooter(now, "uk", now - 30 * 60 * 60 * 1000);
    expect(standbyFooter).toContain("UTC (💤 Режим очікування)");

    // English localization
    const enFooter = formatMonitoringFooter(now, "en", now - 2 * 60 * 60 * 1000);
    expect(enFooter).toContain("UTC (🟢 Monitoring active)");
  });

  it("4. should serve HTTP 200 on all Health check route aliases to prevent 503 and 404", () => {
    const server = createHealthServer(0);
    const handler = (server as any).listeners("request")[0];

    const routes = ["/health", "/healthz", "/ping", "/live", "/status", "/ready", "/readyz", "/api/health"];

    for (const route of routes) {
      let statusCode = 0;
      let body = "";
      const req: any = { method: "GET", url: route };
      const res: any = {
        writeHead: (code: number) => {
          statusCode = code;
          return res;
        },
        end: (chunk?: string) => {
          if (chunk) body += chunk;
        },
      };

      handler(req, res);
      expect(statusCode).toBe(200);
      const parsed = JSON.parse(body);
      expect(parsed.status).toBe("healthy");
    }

    // HEAD request
    let headStatusCode = 0;
    const headReq: any = { method: "HEAD", url: "/ping" };
    const headRes: any = {
      writeHead: (code: number) => {
        headStatusCode = code;
        return headRes;
      },
      end: () => {},
    };
    handler(headReq, headRes);
    expect(headStatusCode).toBe(200);

    server.close();
  });
});
