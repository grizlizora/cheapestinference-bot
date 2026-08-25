import { Menu } from "@grammyjs/menu";
import { BotContext } from "../../types/context.js";
import { PoolStateDAO } from "../../db/dao/poolState.js";
import { SubscriptionDAO } from "../../db/dao/subscriptions.js";
import { SlotHistoryDAO } from "../../db/dao/slotHistory.js";
import { AvailabilityIntelligenceEngine } from "../../engine/intelligenceEngine.js";
import { translate } from "../../i18n/index.js";
import { renderDashboardText, safeEditMessageText } from "./mainDashboard.js";

export function createPoolDetailMenu(
  poolStateDao: PoolStateDAO,
  subDao: SubscriptionDAO,
  historyDao?: SlotHistoryDAO
) {
  return new Menu<BotContext>("pool-detail-menu")
    .dynamic((ctx, range) => {
      const slug = ctx.session.tempPoolSlug || "flagship";
      const blocks = poolStateDao.getPoolBlocks(slug);
      const isSubscribedToPool = subDao.hasSubscription(ctx.user.id, slug, "ALL");

      // Direct buy links with block anchors
      const availableBlocks = blocks.filter(
        (b) => b.status === "available" || b.status === "limited"
      );

      for (const b of availableBlocks) {
        const blockName = translate(ctx.lang, `common.block_${b.block_id}`) || b.block_id;
        range.url(
          `🛒 ${ctx.t("alerts.btn_claim_slot")} (${blockName})`,
          `https://cheapestinference.com/pools/${slug}#${b.block_id}`
        ).row();
      }

      // Toggle subscription for this pool
      range.text(
        isSubscribedToPool
          ? ctx.t("pool_detail.btn_unsubscribe_pool", { pool_name: slug.toUpperCase() })
          : ctx.t("pool_detail.btn_subscribe_pool", { pool_name: slug.toUpperCase() }),
        async (c) => {
          const active = subDao.toggleSubscription(c.user.id, slug, "ALL");
          const toast = active
            ? c.t("subscriptions.toast_pool_on", { pool: slug.toUpperCase() })
            : c.t("subscriptions.toast_pool_off", { pool: slug.toUpperCase() });
          await c.answerCallbackQuery(toast);
          await safeEditMessageText(c, renderPoolDetailText(c, poolStateDao, historyDao));
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
            text: c.t("common.refreshed_toast"),
            show_alert: false,
          });
          await safeEditMessageText(c, renderPoolDetailText(c, poolStateDao, historyDao));
          try {
            c.menu.update();
          } catch {}
        }
      );
    })
    .back(
      (ctx) => ctx.t("common.back"),
      async (ctx) => {
        await safeEditMessageText(ctx, renderDashboardText(ctx, poolStateDao, historyDao));
      }
    );
}

export function renderPoolDetailText(
  ctx: BotContext,
  poolStateDao: PoolStateDAO,
  historyDao?: SlotHistoryDAO
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
    .map((m) => ctx.t("pool_detail.model_item", { model_name: m }))
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

  const prices = blocks.map((b) => parseFloat(b.price_month)).filter((p) => !isNaN(p));
  const minPrice = prices.length > 0 ? Math.min(...prices).toFixed(2) : first.min_price_day;

  return ctx.t("pool_detail.title", {
    pool_name: first.pool_name,
    description: first.description || "Unlimited AI inference pool",
    models_list: modelsList || "  • Custom open-weights models",
    min_price: minPrice,
    min_price_day: first.min_price_day || "0.00",
    annual_discount: Math.round(first.annual_discount * 100),
    blocks_list: blocksList,
    url: `https://cheapestinference.com/pools/${slug}`,
  });
}
