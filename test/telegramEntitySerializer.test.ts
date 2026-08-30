import { describe, it, expect } from "vitest";
import {
  serializeTelegramEntitiesToHtml,
  escapeHtmlText,
  extractMessageContent,
} from "../src/bot/notifier/telegramEntitySerializer.js";
import { Message, MessageEntity } from "grammy/types";

describe("TelegramEntitySerializer", () => {
  it("should escape plain text without entities correctly", () => {
    const raw = "Special <tags> & symbols > here";
    const result = serializeTelegramEntitiesToHtml(raw);
    expect(result).toBe("Special &lt;tags&gt; &amp; symbols &gt; here");
  });

  it("should serialize basic formatting: bold, italic, underline, strikethrough, spoiler, code", () => {
    const raw = "Hello Bold and Italic and Code!";
    const entities: MessageEntity[] = [
      { type: "bold", offset: 6, length: 4 },
      { type: "italic", offset: 15, length: 6 },
      { type: "code", offset: 26, length: 4 },
    ];
    const result = serializeTelegramEntitiesToHtml(raw, entities);
    expect(result).toBe("Hello <b>Bold</b> and <i>Italic</i> and <code>Code</code>!");
  });

  it("should serialize 3D Custom Emojis (<tg-emoji>) correctly", () => {
    const raw = "Check this 💎 emoji";
    const entities: MessageEntity[] = [
      { type: "custom_emoji", offset: 11, length: 2, custom_emoji_id: "543210987654321" } as any,
    ];
    const result = serializeTelegramEntitiesToHtml(raw, entities);
    expect(result).toBe('Check this <tg-emoji emoji-id="543210987654321">💎</tg-emoji> emoji');
  });

  it("should handle UTF-16 code units properly with multi-byte characters and emojis", () => {
    // "🚀 Launch" -> 🚀 is 2 code units
    const raw = "🚀 Launch NOW 🔥";
    const entities: MessageEntity[] = [
      { type: "bold", offset: 3, length: 6 }, // "Launch"
      { type: "spoiler", offset: 10, length: 3 }, // "NOW"
    ];
    const result = serializeTelegramEntitiesToHtml(raw, entities);
    expect(result).toBe("🚀 <b>Launch</b> <tg-spoiler>NOW</tg-spoiler> 🔥");
  });

  it("should handle pre / code blocks with language and blockquotes", () => {
    const raw = "Code sample:\nconst a = 10;\nQuote text here";
    const entities: MessageEntity[] = [
      { type: "pre", offset: 13, length: 13, language: "typescript" } as any,
      { type: "blockquote", offset: 27, length: 15 },
    ];
    const result = serializeTelegramEntitiesToHtml(raw, entities);
    expect(result).toBe(
      'Code sample:\n<pre><code class="language-typescript">const a = 10;</code></pre>\n<blockquote>Quote text here</blockquote>'
    );
  });

  it("should handle nested formatting: bold inside hyperlink", () => {
    const raw = "Click HERE for info";
    const entities: MessageEntity[] = [
      { type: "text_link", offset: 6, length: 4, url: "https://cheapestinference.com" },
      { type: "bold", offset: 6, length: 4 },
    ];
    const result = serializeTelegramEntitiesToHtml(raw, entities);
    expect(result).toBe('Click <a href="https://cheapestinference.com"><b>HERE</b></a> for info');
  });

  it("should extract payload and media info via extractMessageContent", () => {
    const fakeMsg: Message = {
      message_id: 123,
      date: 1600000000,
      chat: { id: 828157777, type: "private", first_name: "Roman" },
      text: "📢 Announcement: Update 1.5",
      entities: [
        { type: "bold", offset: 0, length: 15 },
        { type: "code", offset: 17, length: 10 },
      ],
    } as any;

    const extracted = extractMessageContent(fakeMsg);
    expect(extracted.mediaType).toBe("text");
    expect(extracted.rawText).toBe("📢 Announcement: Update 1.5");
    expect(extracted.html).toBe("<b>📢 Announcement</b>: <code>Update 1.5</code>");
    expect(extracted.entitiesCount).toBe(2);
  });
});
