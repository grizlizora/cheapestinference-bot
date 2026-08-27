import { Menu } from "@grammyjs/menu";
import { BotContext } from "../../types/context.js";
import { PoolStateDAO } from "../../db/dao/poolState.js";
import { SubscriptionDAO } from "../../db/dao/subscriptions.js";
import { SlotHistoryDAO } from "../../db/dao/slotHistory.js";
import { SubscriberInvertedIndex } from "../notifier/subscriberIndex.js";
import { AvailabilityIntelligenceEngine } from "../../engine/intelligenceEngine.js";
import { translate, escapeHtml, formatRelativeTime } from "../../i18n/index.js";
import { renderDashboardText, safeEditMessageText } from "./mainDashboard.js";

import { ScraperOrchestrator } from "../../engine/scraperOrchestrator.js";
import { ActiveDashboardRegistry } from "../liveSync/dashboardRegistry.js";

const DEFAULT_BLOCK_IDS = ["asia", "europe", "americas"];

export function createPoolDetailMenu(
  poolStateDao: PoolStateDAO,
  subDao: SubscriptionDAO,
  invertedIndex: SubscriberInvertedIndex,
  historyDao?: SlotHistoryDAO,
  scraper?: ScraperOrchestrator,
  dashboardRegistry?: ActiveDashboardRegistry
) {
  const poolSettingsMenu = new Menu<BotContext>("pool-settings-menu")
    .dynamic((ctx, range) => {
      const slug = ctx.session.tempPoolSlug || "flagship";
      const blocks = poolStateDao.getPoolBlocks(slug);
      const blockIds = blocks.length > 0 ? blocks.map((b) => b.block_id) : DEFAULT_BLOCK_IDS;
      const flags = subDao.getPoolFlags(ctx.user.id, slug);

      const toFlags = (f: any) => ({
        available: f.notify_on_available === 1,
        soldOut: f.notify_on_sold_out === 1,
        models: f.notify_on_models === 1,
        prices: f.notify_on_prices === 1,
      });

      const syncRamFlags = (userId: number, fullFlags: any) => {
        if (subDao.hasSubscription(userId, slug, "ALL")) {
          invertedIndex.updateSubscription(userId, slug, "ALL", fullFlags);
        }
        for (const bId of blockIds) {
          if (subDao.hasSubscription(userId, slug, bId)) {
            invertedIndex.updateSubscription(userId, slug, bId, fullFlags);
          }
        }
      };

      range
        .text(
          flags.available
            ? ctx.t("pool_settings.btn_avail_on")
            : ctx.t("pool_settings.btn_avail_off"),
          async (c) => {
            const res = subDao.togglePoolEventCategory(c.user.id, slug, "available", blockIds);
            const fullFlags = toFlags(res.flags);
            syncRamFlags(c.user.id, fullFlags);
            await c.answerCallbackQuery(c.t("pool_settings.toast_filter_updated")).catch(() => {});
            await safeEditMessageText(c, renderPoolSettingsText(c, poolStateDao, subDao));
            try { c.menu.update(); } catch {}
          }
        )
        .text(
          flags.soldOut
            ? ctx.t("pool_settings.btn_sold_on")
            : ctx.t("pool_settings.btn_sold_off"),
          async (c) => {
            const res = subDao.togglePoolEventCategory(c.user.id, slug, "sold_out", blockIds);
            const fullFlags = toFlags(res.flags);
            syncRamFlags(c.user.id, fullFlags);
            await c.answerCallbackQuery(c.t("pool_settings.toast_filter_updated")).catch(() => {});
            await safeEditMessageText(c, renderPoolSettingsText(c, poolStateDao, subDao));
            try { c.menu.update(); } catch {}
          }
        )
        .row()
        .text(
          flags.models
            ? ctx.t("pool_settings.btn_models_on")
            : ctx.t("pool_settings.btn_models_off"),
          async (c) => {
            const res = subDao.togglePoolEventCategory(c.user.id, slug, "models", blockIds);
            const fullFlags = toFlags(res.flags);
            syncRamFlags(c.user.id, fullFlags);
            await c.answerCallbackQuery(c.t("pool_settings.toast_filter_updated")).catch(() => {});
            await safeEditMessageText(c, renderPoolSettingsText(c, poolStateDao, subDao));
            try { c.menu.update(); } catch {}
          }
        )
        .text(
          flags.prices
            ? ctx.t("pool_settings.btn_prices_on")
            : ctx.t("pool_settings.btn_prices_off"),
          async (c) => {
            const res = subDao.togglePoolEventCategory(c.user.id, slug, "prices", blockIds);
            const fullFlags = toFlags(res.flags);
            syncRamFlags(c.user.id, fullFlags);
            await c.answerCallbackQuery(c.t("pool_settings.toast_filter_updated")).catch(() => {});
            await safeEditMessageText(c, renderPoolSettingsText(c, poolStateDao, subDao));
            try { c.menu.update(); } catch {}
          }
        )
        .row();

      for (const blockId of blockIds) {
        const isBlockActive = subDao.hasSubscription(ctx.user.id, slug, blockId);
        const blockName = translate(ctx.lang, `common.block_${blockId}`) || blockId;
        const blockRow = blocks.find((b) => b.block_id === blockId);
        const blockHours = blockRow?.hours_utc || "";

        range
          .text(
            isBlockActive
              ? `✅ ${blockName} (${blockHours})`
              : `❌ ${blockName} (${blockHours})`,
            async (c) => {
              const active = subDao.toggleBlockAndUpdatePool(c.user.id, slug, blockId, blockIds);
              const parentPoolActive = subDao.hasSubscription(c.user.id, slug, "ALL");
              const currentFlags = subDao.getPoolFlags(c.user.id, slug);
              const fullFlags = toFlags(currentFlags);

              const blockFlags = {
                available: active ? fullFlags.available : false,
                soldOut: active ? fullFlags.soldOut : false,
                models: active ? fullFlags.models : false,
                prices: active ? fullFlags.prices : false,
              };
              const poolFlags = {
                available: parentPoolActive ? fullFlags.available : false,
                soldOut: parentPoolActive ? fullFlags.soldOut : false,
                models: parentPoolActive ? fullFlags.models : false,
                prices: parentPoolActive ? fullFlags.prices : false,
              };

              invertedIndex.updateSubscription(c.user.id, slug, blockId, blockFlags);
              invertedIndex.updateSubscription(c.user.id, slug, "ALL", poolFlags);

              const toast = active
                ? c.t("subscriptions.toast_slot_on", { pool: slug.toUpperCase(), block: blockName })
                : c.t("subscriptions.toast_slot_off", { pool: slug.toUpperCase(), block: blockName });
              await c.answerCallbackQuery(toast).catch(() => {});
              await safeEditMessageText(c, renderPoolSettingsText(c, poolStateDao, subDao));
              try { c.menu.update(); } catch {}
            }
          )
          .row();
      }
    })
    .text(
      (ctx) => ctx.t("pool_settings.btn_back_to_pool", { pool_name: (ctx.session.tempPoolSlug || "flagship").toUpperCase() }),
      async (ctx) => {
        await ctx.answerCallbackQuery().catch(() => {});
        if (ctx.chat) {
          dashboardRegistry?.updateView(ctx.chat.id, "pool_detail", ctx.session.tempPoolSlug);
        }
        await safeEditMessageText(ctx, renderPoolDetailText(ctx, poolStateDao, historyDao, scraper));
        return ctx.menu.nav("pool-detail-menu");
      }
    );

  const poolDetailMenu = new Menu<BotContext>("pool-detail-menu")
    .dynamic((ctx, range) => {
      const slug = ctx.session.tempPoolSlug || "flagship";
      const blocks = poolStateDao.getPoolBlocks(slug);
      const isSubscribedToPool = subDao.hasSubscription(ctx.user.id, slug, "ALL");

      const availableBlocks = blocks.filter(
        (b) => b.status === "available" || b.status === "limited"
      );

      if (availableBlocks.length > 0) {
        for (const b of availableBlocks) {
          const blockName = translate(ctx.lang, `common.block_${b.block_id}`) || b.block_id;
          range.url(
            `${ctx.t("alerts.btn_claim_slot")} (${blockName})`,
            `https://cheapestinference.com/pools/${slug}#${b.block_id}`
          ).row();
        }
      } else {
        range.url(
          ctx.t("common.open_site"),
          `https://cheapestinference.com/pools/${slug}`
        ).row();
      }

      // Toggle subscription for this pool (Cascading to all its regional blocks)
      const blockIds = blocks.length > 0 ? blocks.map((b) => b.block_id) : DEFAULT_BLOCK_IDS;

      range.text(
        isSubscribedToPool
          ? ctx.t("pool_detail.btn_unsubscribe_pool", { pool_name: slug.toUpperCase() })
          : ctx.t("pool_detail.btn_subscribe_pool", { pool_name: slug.toUpperCase() }),
        async (c) => {
          const newSubState = subDao.togglePoolWithBlocks(c.user.id, slug, blockIds);

          const flags = {
            available: newSubState,
            soldOut: false,
            models: newSubState,
            prices: newSubState,
          };
          invertedIndex.updateSubscription(c.user.id, slug, "ALL", flags);
          for (const bId of blockIds) {
            invertedIndex.updateSubscription(c.user.id, slug, bId, flags);
          }

          const toast = newSubState
            ? c.t("subscriptions.toast_pool_on", { pool: slug.toUpperCase() })
            : c.t("subscriptions.toast_pool_off", { pool: slug.toUpperCase() });
          await c.answerCallbackQuery(toast).catch(() => {});
          await safeEditMessageText(c, renderPoolDetailText(c, poolStateDao, historyDao, scraper));
          try {
            c.menu.update();
          } catch {}
        }
      ).row();

      // Per-Pool Settings button
      range.text(
        ctx.t("pool_detail.btn_pool_filters", { pool_name: slug.toUpperCase() }),
        async (c) => {
          await c.answerCallbackQuery().catch(() => {});
          if (c.chat) {
            dashboardRegistry?.updateView(c.chat.id, "other");
          }
          await safeEditMessageText(c, renderPoolSettingsText(c, poolStateDao, subDao));
          return c.menu.nav("pool-settings-menu");
        }
      ).row();

      // Refresh button
      range.text(
        (c) => c.t("common.refresh"),
        async (c) => {
          const startTime = Date.now();
          await c.answerCallbackQuery({
            text: c.lang === "uk" ? "🔄 Оновлюю дані з сайту..." : c.lang === "ru" ? "🔄 Обновляю данные с сайта..." : "🔄 Refreshing data from site...",
            show_alert: false,
          }).catch(() => {});
          if (scraper) {
            await scraper.forceRefresh(3000);
          }
          const telemetry = scraper?.getTelemetry();
          const scrapeLatency = telemetry?.lastScrapeLatencyMs || 0;
          const rendered = renderPoolDetailText(c, poolStateDao, historyDao, scraper);
          const tgStartTime = Date.now();
          await safeEditMessageText(c, rendered);
          const tgEditLatency = Date.now() - tgStartTime;
          const totalE2E = Date.now() - startTime;
          const username = c.from?.username ? `@${c.from.username}` : `ID:${c.from?.id}`;
          const proxyTag = telemetry?.lastUsedProxy
            ? (telemetry.lastUsedProxy.includes("9050") ? "🧅 Tor SOCKS5" : "🌐 Proxy")
            : "⚡ Direct";
          console.log(`🔄 [Manual Refresh] User ${username} in pool '${slug}' -> Scrape: ${scrapeLatency}ms (${proxyTag}) | TG Edit: ${tgEditLatency}ms | Total E2E: ${totalE2E}ms (source: ${telemetry?.lastSource || "cache"})`);
          if (c.chat) {
            const msgId = c.callbackQuery?.message?.message_id;
            if (msgId) {
              dashboardRegistry?.register(c.chat.id, msgId, c.user.id, c.lang, "pool_detail", slug);
            }
          }
          try {
            c.menu.update();
          } catch {}
        }
      );
    })
    .text(
      (ctx) => ctx.t("common.back"),
      async (ctx) => {
        await ctx.answerCallbackQuery().catch(() => {});
        if (ctx.chat) {
          dashboardRegistry?.updateView(ctx.chat.id, "dashboard");
        }
        await safeEditMessageText(ctx, renderDashboardText(ctx, poolStateDao, historyDao, scraper));
        return ctx.menu.nav("main-dashboard-menu");
      }
    );

  poolDetailMenu.register(poolSettingsMenu);
  return { poolDetailMenu, poolSettingsMenu };
}

export function renderPoolSettingsText(
  ctx: BotContext,
  poolStateDao: PoolStateDAO,
  subDao: SubscriptionDAO
): string {
  const slug = ctx.session.tempPoolSlug || "flagship";
  const flags = subDao.getPoolFlags(ctx.user.id, slug);
  const blocks = poolStateDao.getPoolBlocks(slug);
  const poolName = blocks[0]?.pool_name || slug.toUpperCase();

  const onText = ctx.t("subscriptions.filter_on");
  const offText = ctx.t("subscriptions.filter_off");

  return ctx.t("pool_settings.title", {
    pool_name: escapeHtml(poolName),
    avail_status: flags.available ? onText : offText,
    sold_status: flags.soldOut ? onText : offText,
    model_status: flags.models ? onText : offText,
    price_status: flags.prices ? onText : offText,
    pool_status: flags.isSubscribed
      ? ctx.t("subscriptions.global_enabled")
      : ctx.t("subscriptions.global_disabled"),
  });
}

export function renderPoolDetailText(
  ctx: BotContext,
  poolStateDao: PoolStateDAO,
  historyDao?: SlotHistoryDAO,
  scraper?: ScraperOrchestrator
): string {
  const slug = ctx.session.tempPoolSlug || "flagship";
  const blocks = poolStateDao.getPoolBlocks(slug);

  if (blocks.length === 0) {
    return ctx.t("pool_detail.no_data", { pool: slug.toUpperCase() });
  }

  const first = blocks[0];
  let models: string[] = [];
  try {
    models = JSON.parse(first.models_json);
  } catch {
    models = [];
  }

  const modelsList = models
    .map((m) => ctx.t("pool_detail.model_item", { model_name: escapeHtml(m) }))
    .join("\n");

  const intelligenceEngine = historyDao
    ? new AvailabilityIntelligenceEngine(historyDao)
    : null;

  const blocksList = blocks
    .map((b) => {
      const blockName = ctx.t(`common.block_${b.block_id}`) || b.block_id;
      const smart = intelligenceEngine
        ? intelligenceEngine.getSmartStatus(slug, b.block_id, b.status, ctx.lang)
        : null;

      const isAvailable = b.status === "available" || b.status === "limited";
      const statusBadge = isAvailable
        ? ctx.t("common.status_available")
        : ctx.t("common.status_sold_out");

      const icon = b.block_id === "asia" ? "🌏" : b.block_id === "europe" ? "🌍" : "🌎";

      let row = ctx.t("pool_detail.block_row", {
        block_icon: icon,
        block_name: blockName,
        hours_utc: b.hours_utc,
        status_badge: statusBadge,
        price: b.price_month,
      });

      if (smart?.predictionTip && isAvailable) {
        row += `\n   ${smart.predictionTip}`;
      }

      return row;
    })
    .join("\n");

  const parseNum = (v: string) => parseFloat(String(v).replace(/[^0-9.-]/g, "")) || 0;
  const prices = blocks.map((b) => parseNum(b.price_month)).filter((p) => p > 0);
  const minPriceNum = prices.length > 0 ? Math.min(...prices) : parseNum(first.min_price_day);
  const minPrice = minPriceNum > 0 ? minPriceNum.toFixed(2) : "0.00";
  const minPriceDay = minPriceNum > 0 ? (minPriceNum / 30).toFixed(2) : "0.00";

  const telemetry = scraper?.getTelemetry();
  const lastVerified = poolStateDao.getLastVerified();
  const lastVerifiedTs = telemetry?.lastScrapeTimestamp || lastVerified?.timestamp;
  const lastLatency = telemetry?.lastScrapeLatencyMs || lastVerified?.latencyMs || 0;
  const lastProxy = telemetry?.lastUsedProxy;
  const proxyBadge = lastProxy ? (lastProxy.includes("9050") ? " 🧅" : " 🌐") : " ⚡";

  let timeFooter = "";
  if (lastVerifiedTs && lastVerifiedTs > 0) {
    const utcDateStr = new Date(lastVerifiedTs).toISOString().replace("T", " ").substring(0, 19) + " UTC";
    const elapsedText = formatRelativeTime(lastVerifiedTs, ctx.lang);
    timeFooter = `\n\n🕒 <i>${ctx.lang === "uk" ? "Оновлено" : ctx.lang === "ru" ? "Обновлено" : "Updated"}: ${utcDateStr} (${elapsedText})</i>`;
  }

  const baseTitle = ctx.t("pool_detail.title", {
    pool_name: escapeHtml(first.pool_name),
    description: escapeHtml(first.description || "Unlimited AI inference pool"),
    models_list: modelsList || "  • Custom open-weights models",
    min_price: minPrice,
    min_price_day: minPriceDay,
    annual_discount: Math.round((first.annual_discount || 0.15) * 100),
    blocks_list: blocksList,
    url: `https://cheapestinference.com/pools/${slug}`,
  });

  return `${baseTitle}${timeFooter}`;
}
