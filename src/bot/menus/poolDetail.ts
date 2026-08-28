import { Menu } from "@grammyjs/menu";
import { BotContext } from "../../types/context.js";
import { PoolStateDAO } from "../../db/dao/poolState.js";
import { SubscriptionDAO } from "../../db/dao/subscriptions.js";
import { SlotHistoryDAO } from "../../db/dao/slotHistory.js";
import { SubscriberInvertedIndex } from "../notifier/subscriberIndex.js";
import { translate } from "../../i18n/index.js";
import { ScraperOrchestrator } from "../../engine/scraperOrchestrator.js";
import { ActiveDashboardRegistry } from "../liveSync/dashboardRegistry.js";

// Re-export presentation functions from view layer for 100% backward compatibility
export {
  renderPoolDetailText,
  renderPoolSettingsText,
  getBlockIcon,
  DEFAULT_BLOCK_IDS,
  DEFAULT_BLOCK_HOURS,
} from "../views/poolDetailView.js";
import {
  renderPoolDetailText,
  renderPoolSettingsText,
  DEFAULT_BLOCK_IDS,
  DEFAULT_BLOCK_HOURS,
} from "../views/poolDetailView.js";
import { renderDashboardText } from "../views/dashboardView.js";
import { safeEditMessageText } from "../views/common.js";

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
      const slug = ctx.session?.tempPoolSlug || "flagship";
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
            c.answerCallbackQuery(c.t("pool_settings.toast_filter_updated")).catch(() => {});
            await safeEditMessageText(c, renderPoolSettingsText(c, poolStateDao, subDao));
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
            c.answerCallbackQuery(c.t("pool_settings.toast_filter_updated")).catch(() => {});
            await safeEditMessageText(c, renderPoolSettingsText(c, poolStateDao, subDao));
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
            c.answerCallbackQuery(c.t("pool_settings.toast_filter_updated")).catch(() => {});
            await safeEditMessageText(c, renderPoolSettingsText(c, poolStateDao, subDao));
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
            c.answerCallbackQuery(c.t("pool_settings.toast_filter_updated")).catch(() => {});
            await safeEditMessageText(c, renderPoolSettingsText(c, poolStateDao, subDao));
          }
        )
        .row();

      for (const blockId of blockIds) {
        const isBlockActive = subDao.isBlockSubscribed(ctx.user.id, slug, blockId);
        const blockName = translate(ctx.lang, `common.block_${blockId}`) || blockId;
        const blockRow = blocks.find((b) => b.block_id === blockId);
        const blockHours = blockRow?.hours_utc || DEFAULT_BLOCK_HOURS[blockId] || "";

        range
          .text(
            isBlockActive
              ? ctx.t("subscriptions.slot_active", { name: blockName, hours: blockHours })
              : ctx.t("subscriptions.slot_inactive", { name: blockName, hours: blockHours }),
            async (c) => {
              const { isBlockSubscribed: active, isPoolSubscribed: parentPoolActive } =
                subDao.toggleBlockAndUpdatePool(c.user.id, slug, blockId, blockIds);
              const currentFlags = subDao.getPoolFlags(c.user.id, slug);
              const fullFlags = toFlags(currentFlags);
              const disabledFlags = { available: false, soldOut: false, models: false, prices: false };

              // Sync Pool Master in RAM
              invertedIndex.updateSubscription(
                c.user.id,
                slug,
                "ALL",
                parentPoolActive ? fullFlags : disabledFlags
              );

              // Sync all regional blocks in RAM
              for (const b of blockIds) {
                const bActive = subDao.isBlockSubscribed(c.user.id, slug, b);
                invertedIndex.updateSubscription(
                  c.user.id,
                  slug,
                  b,
                  bActive ? fullFlags : disabledFlags
                );
              }

              if (!active) {
                invertedIndex.updateSubscription(c.user.id, "ALL", "ALL", disabledFlags);
              }

              const toast = active
                ? c.t("subscriptions.toast_slot_on", { pool: slug.toUpperCase(), block: blockName })
                : c.t("subscriptions.toast_slot_off", { pool: slug.toUpperCase(), block: blockName });
              c.answerCallbackQuery(toast).catch(() => {});
              await safeEditMessageText(c, renderPoolSettingsText(c, poolStateDao, subDao));
            }
          )
          .row();
      }
    })
    .text(
      (ctx) => ctx.t("pool_settings.btn_back_to_pool", { pool_name: (ctx.session?.tempPoolSlug || "flagship").toUpperCase() }),
      async (ctx) => {
        await ctx.answerCallbackQuery().catch(() => {});
        if (ctx.chat) {
          dashboardRegistry?.updateView(ctx.chat.id, "pool_detail", ctx.session?.tempPoolSlug);
        }
        await safeEditMessageText(ctx, renderPoolDetailText(ctx, poolStateDao, historyDao, scraper));
        return ctx.menu.nav("pool-detail-menu");
      }
    );

  const poolDetailMenu = new Menu<BotContext>("pool-detail-menu")
    .dynamic((ctx, range) => {
      const slug = ctx.session?.tempPoolSlug || "flagship";
      const blocks = poolStateDao.getPoolBlocks(slug);
      const blockIds = blocks.length > 0 ? blocks.map((b) => b.block_id) : DEFAULT_BLOCK_IDS;
      const isSubscribedToPool = subDao.isPoolSubscribed(ctx.user.id, slug, blockIds);

      const poolNameUpper = slug.toUpperCase();
      const btnClaimLabel = ctx.lang === "uk"
        ? `🚀 Оформити тариф ${poolNameUpper} на сайті`
        : ctx.lang === "ru"
        ? `🚀 Оформить тариф ${poolNameUpper} на сайте`
        : `🚀 Claim ${poolNameUpper} on Website`;

      range.url(
        btnClaimLabel,
        `https://cheapestinference.com/pools/${slug}`
      ).row();

      // Toggle subscription for this pool
      range.text(
        isSubscribedToPool
          ? ctx.t("pool_detail.btn_unsubscribe_pool", { pool_name: slug.toUpperCase() })
          : ctx.t("pool_detail.btn_subscribe_pool", { pool_name: slug.toUpperCase() }),
        async (c) => {
          const newSubState = subDao.togglePoolWithBlocks(c.user.id, slug, blockIds);
          const currentFlags = subDao.getPoolFlags(c.user.id, slug);

          const flags = {
            available: newSubState ? currentFlags.available : false,
            soldOut: newSubState ? currentFlags.soldOut : false,
            models: newSubState ? currentFlags.models : false,
            prices: newSubState ? currentFlags.prices : false,
          };
          invertedIndex.updateSubscription(c.user.id, slug, "ALL", flags);
          for (const bId of blockIds) {
            invertedIndex.updateSubscription(c.user.id, slug, bId, flags);
          }

          if (!newSubState) {
            invertedIndex.updateSubscription(c.user.id, "ALL", "ALL", {
              available: false,
              soldOut: false,
              models: false,
              prices: false,
            });
          }

          const toast = newSubState
            ? c.t("subscriptions.toast_pool_on", { pool: slug.toUpperCase() })
            : c.t("subscriptions.toast_pool_off", { pool: slug.toUpperCase() });
          c.answerCallbackQuery(toast).catch(() => {});
          await safeEditMessageText(c, renderPoolDetailText(c, poolStateDao, historyDao, scraper));
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
            text: c.t("common.refreshed_toast"),
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
            ? (telemetry.lastUsedProxy.includes("9050") ? "Tor SOCKS5" : "Proxy")
            : "Direct";
          console.log(`🔄 [Manual Refresh] User ${username} in pool '${slug}' -> Scrape: ${scrapeLatency}ms (${proxyTag}) | TG Edit: ${tgEditLatency}ms | Total E2E: ${totalE2E}ms (source: ${telemetry?.lastSource || "cache"})`);
          if (c.chat) {
            const msgId = c.callbackQuery?.message?.message_id;
            if (msgId) {
              dashboardRegistry?.register(c.chat.id, msgId, c.user.id, c.lang, "pool_detail", slug);
            }
          }
          try { ctx.menu.update(); } catch {}
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
