/**
 * src/bot/notifier/sender/telegramSender.ts
 * Telegram API Network Worker, Rate Limiting & Error Boundary
 */

import { Bot } from "grammy";
import { BotContext } from "../../../types/context.js";
import { NotificationRateLimiter } from "../rateLimiter.js";
import { toValidUtf8 } from "../htmlTagBalancer.js";
import { OutgoingAlertMessage } from "../types.js";
import { DwrrScheduler } from "../queue/dwrrScheduler.js";
import { OutboxManager } from "../outbox/outboxManager.js";

export class TelegramSender {
  private isWorkerRunning = false;
  private inFlightDispatches = new Set<Promise<void>>();

  constructor(
    private bot: Bot<BotContext>,
    private rateLimiter: NotificationRateLimiter,
    private scheduler: DwrrScheduler,
    private outboxManager: OutboxManager
  ) {
    this.scheduler.onEnqueue = () => this.notifyNewItem();
  }

  private notifyResolve: (() => void) | null = null;

  public notifyNewItem(): void {
    if (this.notifyResolve) {
      this.notifyResolve();
      this.notifyResolve = null;
    }
  }

  private waitForNewItem(timeoutMs = 2000): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.notifyResolve = null;
        resolve();
      }, timeoutMs);
      timer.unref?.();
      this.notifyResolve = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }

  public startWorker(): void {
    if (this.isWorkerRunning) return;
    this.isWorkerRunning = true;
    setImmediate(() => {
      this.processQueueLoop();
    });
  }

  public stop(): void {
    this.isWorkerRunning = false;
    this.notifyNewItem();
  }

  public getInFlightDispatches(): Set<Promise<void>> {
    return this.inFlightDispatches;
  }

  private async processQueueLoop(): Promise<void> {
    while (this.isWorkerRunning) {
      try {
        if (this.scheduler.getTotalPending() === 0) {
          await this.waitForNewItem(2000);
          continue;
        }

        // Check if rate limiter has tokens available (27 msg/s ceiling)
        if (!this.rateLimiter.hasAvailableTokens()) {
          const waitTime = this.rateLimiter.getTimeUntilNextToken();
          await new Promise((resolve) => setTimeout(resolve, Math.max(10, waitTime)));
          continue;
        }

        const msg = this.scheduler.selectNextItemDWRR();
        if (!msg) {
          await new Promise((resolve) => setTimeout(resolve, 20));
          continue;
        }

        // Consume global token and mark user timestamp
        this.rateLimiter.consumeGlobalToken();
        this.rateLimiter.recordUserDispatch(msg.telegramId);

        const dispatchPromise = this.dispatchSingleMessage(msg).finally(() => {
          this.inFlightDispatches.delete(dispatchPromise);
        });
        this.inFlightDispatches.add(dispatchPromise);

        // Yield tick to avoid starving Node.js event loop
        await new Promise((resolve) => setImmediate(resolve));
      } catch (err: any) {
        console.error("❌ [TelegramSender] Error in dispatch loop:", err?.message || err);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  }

  public async dispatchSingleMessage(msg: OutgoingAlertMessage): Promise<void> {
    const startTime = Date.now();
    try {
      const sanitizedText = toValidUtf8(msg.text);

      const sendHelper = async (text: string) => {
        if (msg.mediaType === "photo" && msg.fileId) {
          return await this.bot.api.sendPhoto(msg.telegramId, msg.fileId, {
            caption: text,
            parse_mode: "HTML",
            reply_markup: msg.keyboard,
            disable_notification: msg.isMuted,
          });
        } else if (msg.mediaType === "video" && msg.fileId) {
          return await this.bot.api.sendVideo(msg.telegramId, msg.fileId, {
            caption: text,
            parse_mode: "HTML",
            reply_markup: msg.keyboard,
            disable_notification: msg.isMuted,
          });
        } else if (msg.mediaType === "document" && msg.fileId) {
          return await this.bot.api.sendDocument(msg.telegramId, msg.fileId, {
            caption: text,
            parse_mode: "HTML",
            reply_markup: msg.keyboard,
            disable_notification: msg.isMuted,
          });
        } else if (msg.mediaType === "animation" && msg.fileId) {
          return await this.bot.api.sendAnimation(msg.telegramId, msg.fileId, {
            caption: text,
            parse_mode: "HTML",
            reply_markup: msg.keyboard,
            disable_notification: msg.isMuted,
          });
        } else {
          return await this.bot.api.sendMessage(msg.telegramId, text, {
            parse_mode: "HTML",
            reply_markup: msg.keyboard,
            disable_notification: msg.isMuted,
            link_preview_options: { is_disabled: true },
          });
        }
      };

      try {
        await sendHelper(sanitizedText);
      } catch (sendErr: any) {
        const desc = sendErr?.description || sendErr?.message || "";
        if (desc.includes("DOCUMENT_INVALID") || desc.includes("CUSTOM_EMOJI_INVALID")) {
          const stripped = sanitizedText.replace(/<tg-emoji[^>]*>(.*?)<\/tg-emoji>/gi, "$1");
          await sendHelper(stripped);
        } else {
          throw sendErr;
        }
      }

      this.outboxManager.markDispatched(msg.id);
      const latencyMs = Date.now() - startTime;
      this.outboxManager.recordDeliveryLog(msg, latencyMs);
    } catch (err: any) {
      await this.handleDispatchError(msg, err);
    }
  }

  public async handleDispatchError(msg: OutgoingAlertMessage, err: any): Promise<void> {
    const errorCode = err?.error_code || err?.response?.error_code;
    const description = err?.description || err?.message || "";

    // 1. User Blocked or Invalid Chat (403 / 400)
    if (errorCode === 403 || (errorCode === 400 && (description.includes("chat not found") || description.includes("bot was blocked by the user")))) {
      this.outboxManager.handleUserBlocked(msg.telegramId, msg.id);
      return;
    }

    // 2. Rate Limit (HTTP 429)
    if (errorCode === 429) {
      const retryAfter = err?.parameters?.retry_after || 5;
      console.warn(`⚠️ [TelegramSender] HTTP 429 received. Pausing queue for ${retryAfter + 0.5}s.`);
      this.rateLimiter.trigger429Backoff(retryAfter);
      const targetQ = this.scheduler.getQueueByPriority(msg.priority);
      targetQ.unshift(msg); // Push back to head of line
      this.notifyNewItem();
      return;
    }

    // 3. HTML parsing errors -> retry as plain text
    if (errorCode === 400 && (description.includes("can't parse entities") || description.includes("tag"))) {
      try {
        const plainText = msg.text.replace(/<[^>]*>/g, "");
        await this.bot.api.sendMessage(msg.telegramId, plainText, {
          reply_markup: msg.keyboard,
          disable_notification: msg.isMuted,
          link_preview_options: { is_disabled: true },
        });
        this.outboxManager.markDispatched(msg.id);
        return;
      } catch (fallbackErr: any) {
        this.outboxManager.markTerminalFailed(msg.id, `HTML & Plain text failed: ${fallbackErr.message}`);
        return;
      }
    }

    // 4. Transient Network Errors
    if (msg.retries < 3) {
      msg.retries++;
      const targetQ = this.scheduler.getQueueByPriority(msg.priority);
      targetQ.push(msg);
      this.notifyNewItem();
    } else {
      this.outboxManager.markFailed(msg.id, err.message);
      console.error(`❌ [TelegramSender] Dropping message to ${msg.telegramId} after 3 retries: ${err.message}`);
    }
  }
}
