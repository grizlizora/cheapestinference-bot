import Database from "better-sqlite3";
import { config } from "../config/env.js";
import { TursoClient } from "./sync/tursoClient.js";
import { RemoteSchemaManager } from "./sync/remoteSchema.js";
import { TursoHydrator } from "./sync/tursoHydrator.js";
import { MutationQueue } from "./sync/mutationQueue.js";
import { MutationItem } from "./sync/types.js";

export type { MutationItem } from "./sync/types.js";
export { TursoClient } from "./sync/tursoClient.js";
export { RemoteSchemaManager } from "./sync/remoteSchema.js";
export { TursoHydrator } from "./sync/tursoHydrator.js";
export { MutationQueue } from "./sync/mutationQueue.js";

/**
 * TursoCloudSync Unified Facade
 * 100% Backward Compatible Facade for local SQLite & Turso Cloud sync.
 */
export class TursoCloudSync {
  private client: TursoClient;
  private schemaManager: RemoteSchemaManager;
  private hydrator: TursoHydrator;
  private queue: MutationQueue;

  // Preserved for backward-compatibility with test spies/assertions
  public get url(): string {
    return this.client.getUrl();
  }
  public get token(): string {
    return this.client.getToken();
  }
  public get pendingMutations(): MutationItem[] {
    return this.queue.getPendingMutations();
  }
  public set pendingMutations(val: MutationItem[]) {
    this.queue.setPendingMutations(val);
  }

  constructor(url?: string, token?: string) {
    this.client = new TursoClient(url, token);
    const executor = (reqs: any[], timeoutMs?: number) => {
      return timeoutMs !== undefined
        ? this.executePipeline(reqs, timeoutMs)
        : this.executePipeline(reqs);
    };
    const isEnabledFn = () => this.isEnabled();

    this.schemaManager = new RemoteSchemaManager(executor, isEnabledFn);
    this.hydrator = new TursoHydrator(executor, isEnabledFn, this.schemaManager);
    this.queue = new MutationQueue(executor, isEnabledFn);
  }

  public isEnabled(): boolean {
    return this.client.isEnabled();
  }

  public getUrl(): string {
    return this.client.getUrl();
  }

  // Preserved for existing test spies
  private async executePipeline(
    requests: Array<{ type: string; stmt: { sql: string; args?: any[] } }>,
    timeoutMs?: number
  ): Promise<any[]> {
    return this.client.executePipeline(requests, timeoutMs);
  }

  public async initRemoteSchema(): Promise<void> {
    return this.schemaManager.initRemoteSchema();
  }

  public async pullStateFromTurso(db: Database.Database): Promise<void> {
    return this.hydrator.pullStateFromTurso(db);
  }

  public pushMutation(sql: string, args: any[] = [], immediate = false): void {
    this.queue.pushMutation(sql, args, immediate);
  }

  public async flush(): Promise<void> {
    return this.queue.flush();
  }

  public async close(): Promise<void> {
    await this.queue.close();
  }
}

// Global Singleton Instance
export const tursoCloudSync = new TursoCloudSync(config.TURSO_DATABASE_URL, config.TURSO_AUTH_TOKEN);
