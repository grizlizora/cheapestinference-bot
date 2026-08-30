/**
 * src/bot/notifier/telegramEntitySerializer.ts
 * Lossless Telegram MessageEntity to HTML Serializer
 * Handles UTF-16 surrogate pairs, 3D custom emojis, nested formatting, codeblocks, and hyperlinks.
 */

import { Message, MessageEntity } from "grammy/types";

export interface SerializedTelegramMessage {
  html: string;
  rawText: string;
  entitiesCount: number;
  hasCustomEmoji: boolean;
  mediaType: "text" | "photo" | "video" | "document" | "animation";
  fileId?: string;
}

/**
 * Escapes raw text for Telegram HTML parse mode without corrupting existing tags.
 */
export function escapeHtmlText(str: string): string {
  if (!str) return "";
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

interface BoundaryPoint {
  offset: number;
  openEntities: MessageEntity[];
  closeEntities: MessageEntity[];
}

/**
 * Serializes Telegram message text and its MessageEntities into 100% compliant Telegram HTML.
 * Strictly respects UTF-16 code unit offsets and LIFO tag closure nesting.
 */
export function serializeTelegramEntitiesToHtml(
  rawText: string,
  entities?: MessageEntity[]
): string {
  if (!rawText) return "";
  if (!entities || entities.length === 0) {
    return escapeHtmlText(rawText);
  }

  // 1. Sort entities:
  // - Ascending by offset
  // - For equal offsets: Descending by length (outer wrapper opens first)
  const sortedEntities = [...entities].sort((a, b) => {
    if (a.offset !== b.offset) return a.offset - b.offset;
    return b.length - a.length;
  });

  // 2. Build sorted discrete boundary points
  const boundaryMap = new Map<number, BoundaryPoint>();

  const getOrCreateBoundary = (offset: number): BoundaryPoint => {
    let b = boundaryMap.get(offset);
    if (!b) {
      b = { offset, openEntities: [], closeEntities: [] };
      boundaryMap.set(offset, b);
    }
    return b;
  };

  for (const entity of sortedEntities) {
    const start = entity.offset;
    const end = entity.offset + entity.length;
    getOrCreateBoundary(start).openEntities.push(entity);
    getOrCreateBoundary(end).closeEntities.push(entity);
  }

  // Sort boundary offsets numerically
  const boundaryOffsets = Array.from(boundaryMap.keys()).sort((a, b) => a - b);

  let resultHtml = "";
  let currentOffset = 0;
  const activeStack: MessageEntity[] = [];

  const getOpenTag = (entity: MessageEntity): string => {
    switch (entity.type) {
      case "bold":
        return "<b>";
      case "italic":
        return "<i>";
      case "underline":
        return "<u>";
      case "strikethrough":
        return "<s>";
      case "spoiler":
        return "<tg-spoiler>";
      case "code":
        return "<code>";
      case "pre":
        return (entity as any).language
          ? `<pre><code class="language-${escapeHtmlText((entity as any).language)}">`
          : "<pre>";
      case "blockquote":
        return "<blockquote>";
      case "expandable_blockquote":
        return "<blockquote expandable>";
      case "text_link":
        return `<a href="${escapeHtmlText(entity.url || "")}">`;
      case "text_mention":
        return `<a href="tg://user?id=${entity.user?.id || ""}">`;
      case "custom_emoji":
        return `<tg-emoji emoji-id="${(entity as any).custom_emoji_id}">`;
      default:
        return "";
    }
  };

  const getCloseTag = (entity: MessageEntity): string => {
    switch (entity.type) {
      case "bold":
        return "</b>";
      case "italic":
        return "</i>";
      case "underline":
        return "</u>";
      case "strikethrough":
        return "</s>";
      case "spoiler":
        return "</tg-spoiler>";
      case "code":
        return "</code>";
      case "pre":
        return (entity as any).language ? "</code></pre>" : "</pre>";
      case "blockquote":
      case "expandable_blockquote":
        return "</blockquote>";
      case "text_link":
      case "text_mention":
        return "</a>";
      case "custom_emoji":
        return "</tg-emoji>";
      default:
        return "";
    }
  };

  for (const offset of boundaryOffsets) {
    if (offset > currentOffset) {
      const textSlice = rawText.slice(currentOffset, offset);
      resultHtml += escapeHtmlText(textSlice);
      currentOffset = offset;
    }

    const boundary = boundaryMap.get(offset)!;

    // A. Process Closing Tags (Strict LIFO hierarchy)
    if (boundary.closeEntities.length > 0) {
      // Sort close entities so topmost tags on active stack close first
      const sortedClose = [...boundary.closeEntities].sort((a, b) => {
        return activeStack.lastIndexOf(b) - activeStack.lastIndexOf(a);
      });

      for (const toClose of sortedClose) {
        const stackIdx = activeStack.lastIndexOf(toClose);
        if (stackIdx !== -1) {
          // Unwind tags opened above this entity
          const unwound: MessageEntity[] = [];
          while (activeStack.length > stackIdx) {
            const popped = activeStack.pop()!;
            resultHtml += getCloseTag(popped);
            if (popped !== toClose) {
              unwound.push(popped);
            }
          }
          // Re-open unwound entities that have not ended yet
          while (unwound.length > 0) {
            const reOpen = unwound.pop()!;
            if (reOpen.offset + reOpen.length > offset) {
              resultHtml += getOpenTag(reOpen);
              activeStack.push(reOpen);
            }
          }
        }
      }
    }

    // B. Process Opening Tags
    if (boundary.openEntities.length > 0) {
      for (const toOpen of boundary.openEntities) {
        resultHtml += getOpenTag(toOpen);
        activeStack.push(toOpen);
      }
    }
  }

  // Append any trailing text after the last entity
  if (currentOffset < rawText.length) {
    resultHtml += escapeHtmlText(rawText.slice(currentOffset));
  }

  // Ensure all remaining active tags are cleanly closed
  while (activeStack.length > 0) {
    const popped = activeStack.pop()!;
    resultHtml += getCloseTag(popped);
  }

  return resultHtml;
}

/**
 * Extracts raw payload, entities, and media info from any incoming admin Telegram Message.
 */
export function extractMessageContent(msg: Message): SerializedTelegramMessage {
  const rawText = msg.text || msg.caption || "";
  const entities = msg.entities || msg.caption_entities || [];

  let mediaType: SerializedTelegramMessage["mediaType"] = "text";
  let fileId: string | undefined;

  if (msg.photo && msg.photo.length > 0) {
    mediaType = "photo";
    fileId = msg.photo[msg.photo.length - 1].file_id;
  } else if (msg.video) {
    mediaType = "video";
    fileId = msg.video.file_id;
  } else if (msg.document) {
    mediaType = "document";
    fileId = msg.document.file_id;
  } else if (msg.animation) {
    mediaType = "animation";
    fileId = msg.animation.file_id;
  }

  const html = serializeTelegramEntitiesToHtml(rawText, entities);
  const hasCustomEmoji = entities.some((e) => e.type === "custom_emoji");

  return {
    html,
    rawText,
    entitiesCount: entities.length,
    hasCustomEmoji,
    mediaType,
    fileId,
  };
}
