import { PoolsSnapshot } from "../types/domain.js";

export class SanityGuard {
  private consecutiveErrors = 0;

  public validateSnapshot(snapshot: unknown): PoolsSnapshot {
    if (!snapshot || typeof snapshot !== "object") {
      this.consecutiveErrors++;
      throw new Error("SanityGuard: Snapshot payload is not an object");
    }

    const s = snapshot as PoolsSnapshot;

    if (!s.success || !Array.isArray(s.data)) {
      this.consecutiveErrors++;
      throw new Error("SanityGuard: Snapshot payload missing 'success' or 'data' array");
    }

    if (s.data.length === 0) {
      this.consecutiveErrors++;
      throw new Error("SanityGuard: Zero pools in payload (empty catalog anomaly)");
    }

    for (const pool of s.data) {
      if (!pool.slug || !Array.isArray(pool.blocks) || pool.blocks.length === 0) {
        this.consecutiveErrors++;
        throw new Error(`SanityGuard: Malformed pool record for slug: ${pool.slug}`);
      }

      for (const block of pool.blocks) {
        if (!block.block || !block.status) {
          this.consecutiveErrors++;
          throw new Error(`SanityGuard: Invalid block in pool ${pool.slug}`);
        }
      }
    }

    this.consecutiveErrors = 0;
    return s;
  }

  public getConsecutiveErrors(): number {
    return this.consecutiveErrors;
  }
}
