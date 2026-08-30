/**
 * src/db/sync/types.ts
 * Shared Types & Contracts for Turso Cloud Synchronization
 */

export interface MutationItem {
  sql: string;
  args?: any[];
  retryCount?: number;
  compactionKey?: string;
  addedAt?: number;
}

export type LibSqlArg =
  | { type: "null" }
  | { type: "integer"; value: string }
  | { type: "float"; value: number }
  | { type: "text"; value: string }
  | { type: "blob"; base64: string };

export interface LibSqlStatement {
  sql: string;
  args?: any[];
}

export interface LibSqlPipelineRequest {
  type: "execute" | "close";
  stmt: LibSqlStatement;
}

export interface LibSqlPipelineResponse {
  type: "ok" | "error";
  error?: { message: string };
  response?: {
    result?: {
      cols: Array<{ name: string; type?: string }>;
      rows: Array<Array<{ type: string; value?: any }>>;
      affected_row_count?: number;
      last_insert_rowid?: string;
    };
  };
}
