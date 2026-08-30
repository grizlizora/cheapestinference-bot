/**
 * src/db/sync/tursoClient.ts
 * HTTP LibSQL Pipeline Client & Socket Connection Manager
 */

import { LibSqlPipelineRequest, LibSqlArg } from "./types.js";

export class TursoClient {
  private url?: string;
  private token?: string;

  constructor(url?: string, token?: string) {
    if (url && url.trim().length > 0) {
      let normalized = url.trim();
      if (normalized.startsWith("libsql://")) {
        normalized = normalized.replace("libsql://", "https://");
      } else if (!normalized.startsWith("http://") && !normalized.startsWith("https://")) {
        normalized = `https://${normalized}`;
      }
      this.url = normalized.replace(/\/+$/, "");
    }
    if (token && token.trim().length > 0) {
      this.token = token.trim();
    }
  }

  public isEnabled(): boolean {
    return Boolean(this.url && this.token);
  }

  public getUrl(): string {
    return this.url || "";
  }

  public getToken(): string {
    return this.token || "";
  }

  public serializeArg(val: any): LibSqlArg {
    if (val === null || val === undefined) {
      return { type: "null" };
    }
    if (typeof val === "bigint") {
      return { type: "integer", value: val.toString() };
    }
    if (typeof val === "boolean") {
      return { type: "integer", value: val ? "1" : "0" };
    }
    if (typeof val === "number") {
      if (!Number.isFinite(val) || isNaN(val)) {
        return { type: "null" };
      }
      return Number.isInteger(val)
        ? { type: "integer", value: String(val) }
        : { type: "float", value: val };
    }
    if (val instanceof Uint8Array || (typeof Buffer !== "undefined" && Buffer.isBuffer(val))) {
      return { type: "blob", base64: Buffer.from(val).toString("base64") };
    }
    return { type: "text", value: String(val) };
  }

  /**
   * Executes remote Turso pipeline requests over HTTPS
   */
  public async executePipeline(
    requests: Array<{ type: string; stmt: { sql: string; args?: any[] } }>,
    timeoutMs = 10_000
  ): Promise<any[]> {
    if (!this.isEnabled() || !this.url || !this.token || requests.length === 0) {
      return [];
    }

    const endpoint = `${this.url}/v2/pipeline`;
    const formattedRequests = requests.map((req) => ({
      type: "execute",
      stmt: {
        sql: req.stmt.sql,
        args: (req.stmt.args || []).map((val) => this.serializeArg(val)),
      },
    }));

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ requests: formattedRequests }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      throw new Error(`Turso HTTP ${response.status}: ${errText}`);
    }

    let data: any;
    try {
      data = await response.json();
    } catch (parseErr: any) {
      throw new Error(`Turso Invalid JSON Response: ${parseErr?.message || parseErr}`);
    }

    const results = data?.results || [];
    const hasErrors = results.some((r: any) => r.type === "error");
    if (hasErrors) {
      const firstErr = results.find((r: any) => r.type === "error")?.error?.message || "Statement error";
      throw new Error(`Turso Pipeline Statement Error: ${firstErr}`);
    }
    return results;
  }
}
