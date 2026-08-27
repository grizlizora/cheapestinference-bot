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

const DEFAULT_BLOCK_IDS = ["asia", "europe", "americas"];

export function createPoolDetailMenu(
  poolStateDao: PoolStateDAO,
  subDao: SubscriptionDAO,
  invertedIndex: SubscriberInvertedIndex,
  historyDao?: SlotHistoryDAO,
  scraper?: ScraperOrchestrator
) {
  return new Menu<BotContext>("pool-detail-menu")
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
          const active = subDao.togglePoolWithBlocks(c.user.id, slug, blockIds);

          invertedIndex.updateSubscription(c.user.id, slug, "ALL", {
            available: active,
            soldOut: active,
            models: active,
            prices: active,
          });

          for (const bId of blockIds) {
            invertedIndex.updateSubscription(c.user.id, slug, bId, {
              available: active,
              soldOut: active,
              models: active,
              prices: active,
            });
          }

          if (!active) {
            invertedIndex.updateSubscription(c.user.id, "ALL", "ALL", {
              available: false,
              soldOut: false,
              models: false,
              prices: false,
            });
          }

          const toast = active
            ? c.t("subscriptions.toast_pool_on", { pool: slug.toUpperCase() })
            : c.t("subscriptions.toast_pool_off", { pool: slug.toUpperCase() });
          await c.answerCallbackQuery(toast).catch(() => {});
          await safeEditMessageText(c, renderPoolDetailText(c, poolStateDao, historyDao, scraper));
          try {
            c.menu.update();
          } catch {}
        }
      ).row();

      // Refresh button
      range.text(
        (c) => c.t("common.refresh"),
        async (c) => {
          await c.answerCallbackQuery({
            text: c.lang === "uk" ? "🔄 Оновлюю дані з сайту..." : c.lang === "ru" ? "🔄 Обновляю данные с сайта..." : "🔄 Refreshing data from site...",
            show_alert: false,
          }).catch(() => {});
          if (scraper) {
            await scraper.forceRefresh(3000);
          }
          await safeEditMessageText(c, renderPoolDetailText(c, poolStateDao, historyDao, scraper));
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
        await safeEditMessageText(ctx, renderDashboardText(ctx, poolStateDao, historyDao, scraper));
        return ctx.menu.nav("main-dashboard-menu");
      }
    );
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

      const statusBadge = smart
        ? smart.badge
        : b.status === "available"
        ? ctx.t("common.status_available")
        : b.status === "limited"
        ? ctx.t("common.status_limited")
        : ctx.t("common.status_sold_out");

      const icon = b.block_id === "asia" ? "🌏" : b.block_id === "europe" ? "🌍" : "🌎";

      let row = ctx.t("pool_detail.block_row", {
        block_icon: icon,
        block_name: blockName,
        hours_utc: b.hours_utc,
        status_badge: statusBadge,
        price: b.price_month,
      });

      if (smart?.predictionTip && b.status !== "sold-out") {
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

  const lastVerifiedTs = scraper?.getTelemetry().lastScrapeTimestamp || poolStateDao.getLastVerified()?.timestamp;
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
