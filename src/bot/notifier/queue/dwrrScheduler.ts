/**
 * src/bot/notifier/queue/dwrrScheduler.ts
 * Deficit Weighted Round-Robin (DWRR) Priority Queue Scheduler
 */

import { CircularRingBuffer } from "../circularRingBuffer.js";
import { NotificationRateLimiter } from "../rateLimiter.js";
import { OutgoingAlertMessage, BroadcastPriority } from "../types.js";

export class DwrrScheduler {
  // DWRR 4-Queue Ring Buffers
  public readonly p0Queue = new CircularRingBuffer<OutgoingAlertMessage>(256);
  public readonly p1Queue = new CircularRingBuffer<OutgoingAlertMessage>(16384);
  public readonly p2Queue = new CircularRingBuffer<OutgoingAlertMessage>(8192);
  public readonly p3Queue = new CircularRingBuffer<OutgoingAlertMessage>(4096);

  // Deficit Weighted Round-Robin (DWRR) Counters
  private p0Deficit = 0;
  private p1Deficit = 0;
  private p2Deficit = 0;
  private p3Deficit = 0;
  private currentQueueIndex = 0;

  private readonly quantumP0 = 10;
  private readonly quantumP1 = 5;
  private readonly quantumP2 = 2;
  private readonly quantumP3 = 1;

  private readonly MAX_MESSAGE_AGE_MS = 10 * 60 * 1000; // 10 min TTL

  constructor(private rateLimiter: NotificationRateLimiter) {}

  public getQueueByPriority(priority: BroadcastPriority): CircularRingBuffer<OutgoingAlertMessage> {
    switch (priority) {
      case "P0":
        return this.p0Queue;
      case "P1":
        return this.p1Queue;
      case "P2":
        return this.p2Queue;
      case "P3":
      default:
        return this.p3Queue;
    }
  }

  public onEnqueue?: () => void;

  public enqueue(msg: OutgoingAlertMessage): void {
    const queue = this.getQueueByPriority(msg.priority);
    queue.push(msg);
    if (this.onEnqueue) {
      try {
        this.onEnqueue();
      } catch {}
    }
  }

  public getTotalPending(): number {
    return this.p0Queue.size() + this.p1Queue.size() + this.p2Queue.size() + this.p3Queue.size();
  }

  /**
   * Helper: Attempts to extract the next valid candidate from a specific priority queue,
   * skipping and re-queuing users who are currently rate-limited by the 1.05s per-user gap.
   */
  public popValidCandidate(
    queue: CircularRingBuffer<OutgoingAlertMessage>,
    ignoreRateLimit = false
  ): OutgoingAlertMessage | null {
    if (queue.isEmpty()) return null;

    const scanLimit = Math.min(queue.size(), 32);
    const skipped: OutgoingAlertMessage[] = [];
    let selected: OutgoingAlertMessage | null = null;
    const now = Date.now();

    for (let i = 0; i < scanLimit; i++) {
      const candidate = queue.pop();
      if (!candidate) break;

      // Drop expired TTL messages (> 10 mins old)
      if (now - candidate.enqueuedAt > this.MAX_MESSAGE_AGE_MS) {
        continue;
      }

      if (ignoreRateLimit || this.rateLimiter.canSendToUser(candidate.telegramId)) {
        selected = candidate;
        break;
      } else {
        skipped.push(candidate);
      }
    }

    // Re-queue skipped messages while preserving FIFO ordering
    for (let j = skipped.length - 1; j >= 0; j--) {
      queue.unshift(skipped[j]);
    }

    return selected;
  }

  /**
   * Selects the next eligible message using Deficit Weighted Round-Robin (DWRR)
   * Interleaves P0 (10), P1 (5), P2 (2), P3 (1) to eliminate starvation of hot slot drops.
   */
  public selectNextItemDWRR(ignoreRateLimit = false): OutgoingAlertMessage | null {
    const queueEntries = [
      { q: this.p0Queue, quantum: this.quantumP0, getDeficit: () => this.p0Deficit, setDeficit: (v: number) => (this.p0Deficit = v) },
      { q: this.p1Queue, quantum: this.quantumP1, getDeficit: () => this.p1Deficit, setDeficit: (v: number) => (this.p1Deficit = v) },
      { q: this.p2Queue, quantum: this.quantumP2, getDeficit: () => this.p2Deficit, setDeficit: (v: number) => (this.p2Deficit = v) },
      { q: this.p3Queue, quantum: this.quantumP3, getDeficit: () => this.p3Deficit, setDeficit: (v: number) => (this.p3Deficit = v) },
    ];

    const totalQueues = queueEntries.length;
    let attempts = 0;

    while (attempts < totalQueues * 2) {
      const entry = queueEntries[this.currentQueueIndex];

      if (!entry.q.isEmpty()) {
        if (entry.getDeficit() <= 0) {
          entry.setDeficit(entry.quantum);
        }

        if (entry.getDeficit() > 0) {
          const msg = this.popValidCandidate(entry.q, ignoreRateLimit);
          if (msg) {
            entry.setDeficit(entry.getDeficit() - 1);
            if (entry.getDeficit() <= 0) {
              this.currentQueueIndex = (this.currentQueueIndex + 1) % totalQueues;
            }
            return msg;
          }
        }
      }

      // If queue is empty or couldn't pop, reset deficit and advance
      entry.setDeficit(0);
      this.currentQueueIndex = (this.currentQueueIndex + 1) % totalQueues;
      attempts++;
    }

    return null;
  }
}
