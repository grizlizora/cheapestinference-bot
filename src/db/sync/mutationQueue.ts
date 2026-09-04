/**
 * src/db/sync/mutationQueue.ts
 * Bounded Memory Mutation Buffer, Compaction & Poison-Pill Splitter
 */

import { MutationItem } from "./types.js";

export class MutationQueue {
  private static readonly MAX_PENDING_MUTATIONS = 10_000;
  private pendingMutations: MutationItem[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private isFlushing = false;

  constructor(
    private executePipeline: (requests: Array<{ type: string; stmt: { sql: string; args?: any[] } }>) => Promise<any[]>,
    private isEnabled: () => boolean
  ) {}

  public getPendingMutations(): MutationItem[] {
    return this.pendingMutations;
  }

  public setPendingMutations(val: MutationItem[]): void {
    this.pendingMutations = val;
  }

  /**
   * Enqueues a write mutation to be asynchronously pushed to Turso in the background
   */
  public pushMutation(sql: string, args: any[] = [], immediate = false): void {
    if (!this.isEnabled()) return;

    if (this.pendingMutations.length >= MutationQueue.MAX_PENDING_MUTATIONS) {
      this.pendingMutations.shift(); // Drop oldest to guarantee flat RAM bound
    }

    this.pendingMutations.push({ sql, args, retryCount: 0, addedAt: Date.now() });

    // High-watermark or immediate flush requested
    if (immediate || this.pendingMutations.length >= 50) {
      this.flush().catch(() => {});
      return;
    }

    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flush().catch(() => {});
      }, 1000);
      this.flushTimer.unref?.();
    }
  }

  private compactBatch(batch: MutationItem[]): MutationItem[] {
    if (batch.length <= 1) return batch;

    const seenKeyMap = new Map<string, number>();
    const compacted: MutationItem[] = [];

    for (let i = batch.length - 1; i >= 0; i--) {
      const item = batch[i];
      // Coalesce high-frequency user last_active_at touches
      if (item.sql.includes("UPDATE users SET last_active_at") && item.args && item.args.length >= 2) {
        const key = `user_last_active:${item.args[1]}`;
        if (seenKeyMap.has(key)) continue;
        seenKeyMap.set(key, 1);
      }
      compacted.push(item);
    }

    return compacted.reverse();
  }

  /**
   * Flushes all pending mutations in a single batch to Turso Cloud
   */
  public async flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    if (!this.isEnabled() || this.pendingMutations.length === 0 || this.isFlushing) {
      return;
    }

    this.isFlushing = true;
    const rawBatch = [...this.pendingMutations];
    this.pendingMutations = [];
    const batch = this.compactBatch(rawBatch);

    try {
      await this.executePipeline(
        batch.map((item) => ({
          type: "execute",
          stmt: {
            sql: item.sql,
            args: item.args,
          },
        }))
      );
    } catch (err: any) {
      console.warn(`⚠️ [TursoSync] Background batch push warning (${batch.length} mutations):`, err?.message || err);

      const retryableBatch: MutationItem[] = [];

      // If a multi-mutation batch fails, isolate poison pills by executing mutations individually
      if (batch.length > 1) {
        for (const item of batch) {
          try {
            await this.executePipeline([{
              type: "execute",
              stmt: {
                sql: item.sql,
                args: item.args,
              },
            }]);
          } catch (singleErr: any) {
            const count = (item.retryCount || 0) + 1;
            if (count <= 3) {
              retryableBatch.push({ ...item, retryCount: count });
            } else {
              console.error("❌ [TursoSync] Discarding isolated poison-pill mutation:", item.sql, singleErr?.message);
            }
          }
        }
      } else if (batch.length === 1) {
        const item = batch[0];
        const count = (item.retryCount || 0) + 1;
        if (count <= 5) {
          retryableBatch.push({ ...item, retryCount: count });
        } else {
          console.error("❌ [TursoSync] Discarding poison-pill mutation after 5 failed attempts:", item.sql);
        }
      }

      this.pendingMutations = [...retryableBatch, ...this.pendingMutations];
      if (this.pendingMutations.length > MutationQueue.MAX_PENDING_MUTATIONS) {
        this.pendingMutations = this.pendingMutations.slice(0, MutationQueue.MAX_PENDING_MUTATIONS);
      }
      if (!this.flushTimer) {
        this.flushTimer = setTimeout(() => {
          this.flush().catch(() => {});
        }, 5000);
        this.flushTimer.unref?.();
      }
    } finally {
      this.isFlushing = false;
      if (this.pendingMutations.length > 0 && !this.flushTimer) {
        this.flushTimer = setTimeout(() => {
          this.flush().catch(() => {});
        }, 1000);
        this.flushTimer.unref?.();
      }
    }
  }

  /**
   * Final flush and cleanup on graceful shutdown
   */
  public async close(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    while (this.isFlushing) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await this.flush().catch(() => {});
  }
}
