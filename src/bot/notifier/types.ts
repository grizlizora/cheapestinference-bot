/**
 * src/bot/notifier/types.ts
 * Core Types & Interfaces for Notification Dispatching
 */

import { InlineKeyboard } from "grammy";

export type BroadcastPriority = "P0" | "P1" | "P2" | "P3";

export interface OutgoingAlertMessage {
  id: string;
  telegramId: number;
  userId: number;
  poolSlug: string;
  blockId: string;
  eventType: string;
  text: string;
  keyboard?: InlineKeyboard;
  isMuted: boolean;
  priority: BroadcastPriority;
  retries: number;
  enqueuedAt: number;
  mediaType?: "text" | "photo" | "video" | "document" | "animation";
  fileId?: string;
  language?: string;
}

export interface DispatcherMetrics {
  p0: number;
  p1: number;
  p2: number;
  p3: number;
  total: number;
  tokensAvailable: number;
  isPaused: boolean;
}
