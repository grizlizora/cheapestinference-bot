import { describe, it, expect, vi } from "vitest";
import { TursoCloudSync } from "../src/db/tursoSync.js";
import Database from "better-sqlite3";
import fs from "node:fs";

describe("TursoCloudSync Universal Cloud Sync Suite", () => {
  it("1. should remain completely disabled and no-op when URL or token is missing", async () => {
    const sync = new TursoCloudSync(undefined, undefined);
    expect(sync.isEnabled()).toBe(false);

    // Calling pull/push/flush should be completely safe and immediate
    const db = new Database(":memory:");
    await sync.pullStateFromTurso(db);
    sync.pushMutation("INSERT INTO users VALUES (1)");
    await sync.flush();
    await sync.close();
  });

  it("2. should correctly normalize libsql:// protocol to https://", () => {
    const sync = new TursoCloudSync("libsql://my-test-db-user.turso.io/", "test-token-123");
    expect(sync.isEnabled()).toBe(true);
    expect((sync as any).url).toBe("https://my-test-db-user.turso.io");
    expect((sync as any).token).toBe("test-token-123");
  });

  it("3. should enqueue mutations and debounce batch flushes", async () => {
    const sync = new TursoCloudSync("https://mock-turso.io", "mock-token");
    expect(sync.isEnabled()).toBe(true);

    const executeSpy = vi.spyOn(sync as any, "executePipeline").mockResolvedValue([]);

    sync.pushMutation("UPDATE users SET language = ?", ["uk"]);
    sync.pushMutation("UPDATE users SET is_muted = 1 WHERE telegram_id = ?", [12345]);

    expect((sync as any).pendingMutations.length).toBe(2);

    await sync.flush();

    expect((sync as any).pendingMutations.length).toBe(0);
    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(executeSpy).toHaveBeenCalledWith([
      { type: "execute", stmt: { sql: "UPDATE users SET language = ?", args: ["uk"] } },
      { type: "execute", stmt: { sql: "UPDATE users SET is_muted = 1 WHERE telegram_id = ?", args: [12345] } },
    ]);
  });
});
