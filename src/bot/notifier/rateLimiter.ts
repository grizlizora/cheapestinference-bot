/**
 * src/bot/notifier/rateLimiter.ts
 * Dual-Tier Global Token Bucket & Per-User Sliding Window Rate Limiter
 */

export interface RateLimiterConfig {
  targetRatePerSec?: number;       // Default: 27 msg/s
  maxBurstTokens?: number;         // Default: 25 tokens
  userDispatchGapMs?: number;      // Default: 1050ms (1.05s)
  staleTimestampTtlMs?: number;    // Default: 5 minutes
}

export class NotificationRateLimiter {
  private readonly targetRatePerSec: number;
  private readonly tokenIntervalMs: number;
  private readonly maxTokens: number;
  private readonly userDispatchGapMs: number;
  private readonly staleTimestampTtlMs: number;

  private tokens: number;
  private lastTokenRefill: number;
  private isPaused: boolean = false;
  private pauseUntil: number = 0;

  // Telegram ID -> Timestamp of last dispatched message
  private lastUserDispatchTime = new Map<number, number>();

  constructor(config?: RateLimiterConfig) {
    this.targetRatePerSec = config?.targetRatePerSec ?? 27;
    this.tokenIntervalMs = 1000 / this.targetRatePerSec; // ~37.037ms
    this.maxTokens = config?.maxBurstTokens ?? 25;
    this.tokens = this.maxTokens;
    this.userDispatchGapMs = config?.userDispatchGapMs ?? 1050;
    this.staleTimestampTtlMs = config?.staleTimestampTtlMs ?? 5 * 60 * 1000;
    this.lastTokenRefill = performance.now();
  }

  /**
   * Refills global token bucket using non-drifting integer multiplication.
   */
  public refillTokens(): void {
    const now = performance.now();
    const elapsed = now - this.lastTokenRefill;
    if (elapsed >= this.tokenIntervalMs) {
      const newTokens = Math.floor(elapsed / this.tokenIntervalMs);
      this.tokens = Math.min(this.maxTokens, this.tokens + newTokens);
      this.lastTokenRefill += newTokens * this.tokenIntervalMs;
    }
  }

  public hasGlobalToken(): boolean {
    this.refillTokens();
    return this.tokens >= 1;
  }

  public consumeGlobalToken(): boolean {
    this.refillTokens();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }

  public isGlobalPaused(): boolean {
    if (!this.isPaused) return false;
    const now = performance.now();
    if (now < this.pauseUntil) {
      return true;
    }
    this.isPaused = false;
    return false;
  }

  public getPauseRemainingMs(): number {
    if (!this.isPaused) return 0;
    const now = performance.now();
    return Math.max(10, Math.ceil(this.pauseUntil - now));
  }

  public trigger429Backoff(retryAfterSec: number = 5): void {
    this.isPaused = true;
    this.pauseUntil = performance.now() + (retryAfterSec + 0.5) * 1000;
  }

  public canDispatchToUser(telegramId: number, now: number = Date.now()): boolean {
    const lastSent = this.lastUserDispatchTime.get(telegramId) || 0;
    return now - lastSent >= this.userDispatchGapMs;
  }

  public recordUserDispatch(telegramId: number, now: number = Date.now()): void {
    this.lastUserDispatchTime.set(telegramId, now);
  }

  public getJitteredDelayMs(): number {
    const jitter = (Math.random() - 0.5) * 6; // ±3ms
    return Math.max(5, this.tokenIntervalMs + jitter);
  }

  /**
   * Prunes user timestamps older than TTL to prevent memory leaks in continuous runtime.
   */
  public pruneStaleUserTimestamps(): number {
    const cutoff = Date.now() - this.staleTimestampTtlMs;
    let pruned = 0;
    for (const [tgId, lastSent] of this.lastUserDispatchTime.entries()) {
      if (lastSent < cutoff) {
        this.lastUserDispatchTime.delete(tgId);
        pruned++;
      }
    }
    return pruned;
  }

  public getMetrics() {
    this.refillTokens();
    return {
      tokensAvailable: this.tokens,
      isPaused: this.isGlobalPaused(),
      activeTrackedUsers: this.lastUserDispatchTime.size,
    };
  }

  public reset(): void {
    this.tokens = this.maxTokens;
    this.lastTokenRefill = performance.now();
    this.isPaused = false;
    this.pauseUntil = 0;
    this.lastUserDispatchTime.clear();
  }
}
