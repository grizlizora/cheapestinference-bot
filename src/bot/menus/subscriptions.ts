import { Menu } from "@grammyjs/menu";
import { BotContext } from "../../types/context.js";
import { SubscriptionDAO } from "../../db/dao/subscriptions.js";
import { UserDAO } from "../../db/dao/users.js";
import { PoolStateDAO } from "../../db/dao/poolState.js";
import { SlotHistoryDAO } from "../../db/dao/slotHistory.js";
import { SubscriberInvertedIndex } from "../notifier/subscriberIndex.js";
import { renderDashboardText, safeEditMessageText } from "./mainDashboard.js";

import { ScraperOrchestrator } from "../../engine/scraperOrchestrator.js";
import { ActiveDashboardRegistry } from "../liveSync/dashboardRegistry.js";

const DEFAULT_BLOCK_IDS = ["asia", "europe", "americas"];

export function createSubscriptionsMenu(
  subDao: SubscriptionDAO,
  userDao: UserDAO,
  poolStateDao: PoolStateDAO,
  invertedIndex: SubscriberInvertedIndex,
  historyDao?: SlotHistoryDAO,
  scraper?: ScraperOrchestrator,
  dashboardRegistry?: ActiveDashboardRegistry
) {
  return new Menu<BotContext>("subscriptions-menu")
    // Row 1: Available Slots & Sold Out (2x2 Grid)
    .text(
      (ctx) =>
        (ctx.user.notify_available_global ?? 1) === 1
          ? ctx.t("subscriptions.btn_toggle_avail_on")
          : ctx.t("subscriptions.btn_toggle_avail_off"),
      async (ctx) => {
        const val = userDao.toggleAvailable(ctx.from!.id);
        ctx.user.notify_available_global = val;
        subDao.updateUserGlobalCategory(ctx.user.id, "available", val === 1);
        invertedIndex.updateUserPreferences(ctx.from!.id, {
          notifyAvailableGlobal: val === 1,
        });

        const toast =
          val === 1
            ? ctx.t("subscriptions.toast_avail_on")
            : ctx.t("subscriptions.toast_avail_off");
        await ctx.answerCallbackQuery(toast).catch(() => {});
        await safeEditMessageText(ctx, renderSubscriptionsText(ctx, subDao));
      }
    )
    .text(
      (ctx) =>
        (ctx.user.notify_sold_out_global ?? 0) === 1
          ? ctx.t("subscriptions.btn_toggle_sold_on")
          : ctx.t("subscriptions.btn_toggle_sold_off"),
      async (ctx) => {
        const val = userDao.toggleSoldOut(ctx.from!.id);
        ctx.user.notify_sold_out_global = val;
        subDao.updateUserGlobalCategory(ctx.user.id, "sold_out", val === 1);
        invertedIndex.updateUserPreferences(ctx.from!.id, {
          notifySoldOutGlobal: val === 1,
        });

        const toast =
          val === 1
            ? ctx.t("subscriptions.toast_sold_on")
            : ctx.t("subscriptions.toast_sold_off");
        await ctx.answerCallbackQuery(toast).catch(() => {});
        await safeEditMessageText(ctx, renderSubscriptionsText(ctx, subDao));
      }
    )
    .row()
    // Row 2: Model Updates & Price Changes (2x2 Grid)
    .text(
      (ctx) =>
        (ctx.user.notify_models_global ?? 1) === 1
          ? ctx.t("subscriptions.btn_toggle_models_on")
          : ctx.t("subscriptions.btn_toggle_models_off"),
      async (ctx) => {
        const val = userDao.toggleModels(ctx.from!.id);
        ctx.user.notify_models_global = val;
        subDao.updateUserGlobalCategory(ctx.user.id, "models", val === 1);
        invertedIndex.updateUserPreferences(ctx.from!.id, {
          notifyModelsGlobal: val === 1,
        });

        const toast =
          val === 1
            ? ctx.t("subscriptions.toast_models_on")
            : ctx.t("subscriptions.toast_models_off");
        await ctx.answerCallbackQuery(toast).catch(() => {});
        await safeEditMessageText(ctx, renderSubscriptionsText(ctx, subDao));
      }
    )
    .text(
      (ctx) =>
        (ctx.user.notify_prices_global ?? 1) === 1
          ? ctx.t("subscriptions.btn_toggle_prices_on")
          : ctx.t("subscriptions.btn_toggle_prices_off"),
      async (ctx) => {
        const val = userDao.togglePrices(ctx.from!.id);
        ctx.user.notify_prices_global = val;
        subDao.updateUserGlobalCategory(ctx.user.id, "prices", val === 1);
        invertedIndex.updateUserPreferences(ctx.from!.id, {
          notifyPricesGlobal: val === 1,
        });

        const toast =
          val === 1
            ? ctx.t("subscriptions.toast_prices_on")
            : ctx.t("subscriptions.toast_prices_off");
        await ctx.answerCallbackQuery(toast).catch(() => {});
        await safeEditMessageText(ctx, renderSubscriptionsText(ctx, subDao));
      }
    )
    .row()
    // Global All Slots (Cascading to all pools and blocks)
    .text(
      (ctx) => {
        const isGlobal = subDao.hasSubscription(ctx.user.id, "ALL", "ALL");
        return isGlobal
          ? ctx.t("subscriptions.btn_toggle_global_on")
          : ctx.t("subscriptions.btn_toggle_global_off");
      },
      async (ctx) => {
        const summaries = poolStateDao.getPoolSummaries();
        const pools = (summaries.length > 0 ? summaries : [
          { slug: "flagship", blocks: [{ block: "asia" }, { block: "europe" }, { block: "americas" }] },
          { slug: "frontier", blocks: [{ block: "asia" }, { block: "europe" }, { block: "americas" }] },
          { slug: "core", blocks: [{ block: "asia" }, { block: "europe" }, { block: "americas" }] },
        ]).map((p) => ({
          slug: p.slug,
          blocks: p.blocks.map((b: any) => b.block || b.block_id || b),
        }));

        const active = subDao.toggleGlobalWithAllPools(ctx.user.id, pools);
        const userAvail = (ctx.user.notify_available_global ?? 1) === 1;
        const userSold = (ctx.user.notify_sold_out_global ?? 0) === 1;
        const userModels = (ctx.user.notify_models_global ?? 1) === 1;
        const userPrices = (ctx.user.notify_prices_global ?? 1) === 1;

        const flags = {
          available: active ? userAvail : false,
          soldOut: active ? userSold : false,
          models: active ? userModels : false,
          prices: active ? userPrices : false,
        };

        // Synchronize in-memory inverted index
        invertedIndex.updateSubscription(ctx.user.id, "ALL", "ALL", flags);

        for (const p of pools) {
          invertedIndex.updateSubscription(ctx.user.id, p.slug, "ALL", flags);
          for (const b of p.blocks) {
            invertedIndex.updateSubscription(ctx.user.id, p.slug, b, flags);
          }
        }

        const toast = active
          ? ctx.t("subscriptions.toast_global_on")
          : ctx.t("subscriptions.toast_global_off");
        await ctx.answerCallbackQuery(toast).catch(() => {});
        await safeEditMessageText(ctx, renderSubscriptionsText(ctx, subDao));
      }
    )
    .row()
    // Sound Toggle
    .text(
      (ctx) =>
        ctx.user.is_muted === 1
          ? ctx.t("subscriptions.btn_toggle_sound_off")
          : ctx.t("subscriptions.btn_toggle_sound_on"),
      async (ctx) => {
        const newMuted = userDao.toggleMute(ctx.from!.id);
        ctx.user.is_muted = newMuted;
        invertedIndex.updateUserPreferences(ctx.from!.id, {
          isMuted: newMuted === 1,
        });

        const toast =
          newMuted === 1
            ? ctx.t("subscriptions.toast_sound_muted")
            : ctx.t("subscriptions.toast_sound_enabled");
        await ctx.answerCallbackQuery(toast).catch(() => {});
        await safeEditMessageText(ctx, renderSubscriptionsText(ctx, subDao));
      }
    )
    .row()
    // Dynamic Pool & Regional Block Sections (Cascading Parent-Child Linkage)
    .dynamic((ctx, range) => {
      const summaries = poolStateDao.getPoolSummaries();
      const pools =
        summaries.length > 0
          ? summaries.map((s) => ({ slug: s.slug, name: s.name }))
          : [
              { slug: "flagship", name: "Flagship" },
              { slug: "frontier", name: "Frontier" },
              { slug: "core", name: "Core" },
            ];

      const blocks = [
        { id: "asia", nameKey: "common.block_asia", hours: "00:00 – 08:00 UTC" },
        { id: "europe", nameKey: "common.block_europe", hours: "08:00 – 16:00 UTC" },
        { id: "americas", nameKey: "common.block_americas", hours: "16:00 – 24:00 UTC" },
      ];
      const blockIds = blocks.map((b) => b.id);

      for (const pool of pools) {
        const poolBlocks = poolStateDao.getPoolBlocks(pool.slug);
        const isPoolSub = subDao.hasSubscription(ctx.user.id, pool.slug, "ALL");
        range
          .text(
            isPoolSub
              ? ctx.t("subscriptions.pool_active", { name: pool.name })
              : ctx.t("subscriptions.pool_inactive", { name: pool.name }),
            async (c) => {
              // Cascading Master Toggle: Toggling the pool synchronizes all regional blocks!
              const active = subDao.togglePoolWithBlocks(c.user.id, pool.slug, blockIds);

              invertedIndex.updateSubscription(c.user.id, pool.slug, "ALL", {
                available: active,
                soldOut: active,
                models: active,
                prices: active,
              });

              for (const bId of blockIds) {
                invertedIndex.updateSubscription(c.user.id, pool.slug, bId, {
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
                ? c.t("subscriptions.toast_pool_on", { pool: pool.name })
                : c.t("subscriptions.toast_pool_off", { pool: pool.name });
              await c.answerCallbackQuery(toast).catch(() => {});
              await safeEditMessageText(c, renderSubscriptionsText(c, subDao));
            }
          )
          .row();

        for (const block of blocks) {
          const isSlotSub = subDao.hasSubscription(ctx.user.id, pool.slug, block.id);
          const blockTitle = ctx.t(block.nameKey);
          const blockHours = poolBlocks.find((b) => b.block_id === block.id)?.hours_utc || block.hours;

          range
            .text(
              isSlotSub
                ? ctx.t("subscriptions.slot_active", { name: blockTitle, hours: blockHours })
                : ctx.t("subscriptions.slot_inactive", { name: blockTitle, hours: blockHours }),
              async (c) => {
                // Child Block Toggle: Auto-updates parent "Весь пул" state
                const { isBlockSubscribed: active, isPoolSubscribed: parentPoolActive } =
                  subDao.toggleBlockAndUpdatePool(c.user.id, pool.slug, block.id, blockIds);
                const currentFlags = subDao.getPoolFlags(c.user.id, pool.slug);

                invertedIndex.updateSubscription(c.user.id, pool.slug, block.id, {
                  available: active ? currentFlags.available : false,
                  soldOut: active ? currentFlags.soldOut : false,
                  models: active ? currentFlags.models : false,
                  prices: active ? currentFlags.prices : false,
                });

                invertedIndex.updateSubscription(c.user.id, pool.slug, "ALL", {
                  available: parentPoolActive ? currentFlags.available : false,
                  soldOut: parentPoolActive ? currentFlags.soldOut : false,
                  models: parentPoolActive ? currentFlags.models : false,
                  prices: parentPoolActive ? currentFlags.prices : false,
                });

                if (!active) {
                  invertedIndex.updateSubscription(c.user.id, "ALL", "ALL", {
                    available: false,
                    soldOut: false,
                    models: false,
                    prices: false,
                  });
                }

                const toast = active
                  ? c.t("subscriptions.toast_slot_on", { pool: pool.name, block: blockTitle })
                  : c.t("subscriptions.toast_slot_off", { pool: pool.name, block: blockTitle });
                await c.answerCallbackQuery(toast).catch(() => {});
                await safeEditMessageText(c, renderSubscriptionsText(c, subDao));
              }
            )
            .row();
        }
      }
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
}

export function renderSubscriptionsText(ctx: BotContext, subDao: SubscriptionDAO): string {
  const isGlobal = subDao.hasSubscription(ctx.user.id, "ALL", "ALL");
  const globalStatus = isGlobal
    ? ctx.t("subscriptions.global_enabled")
    : ctx.t("subscriptions.global_disabled");
  const soundStatus =
    ctx.user.is_muted === 1
      ? ctx.t("subscriptions.sound_muted")
      : ctx.t("subscriptions.sound_enabled");

  const availStatus =
    (ctx.user.notify_available_global ?? 1) === 1
      ? ctx.t("subscriptions.filter_on")
      : ctx.t("subscriptions.filter_off");

  const soldStatus =
    (ctx.user.notify_sold_out_global ?? 0) === 1
      ? ctx.t("subscriptions.filter_on")
      : ctx.t("subscriptions.filter_off");

  const modelStatus =
    (ctx.user.notify_models_global ?? 1) === 1
      ? ctx.t("subscriptions.filter_on")
      : ctx.t("subscriptions.filter_off");

  const priceStatus =
    (ctx.user.notify_prices_global ?? 1) === 1
      ? ctx.t("subscriptions.filter_on")
      : ctx.t("subscriptions.filter_off");

  return ctx.t("subscriptions.title", {
    global_status: globalStatus,
    sound_status: soundStatus,
    avail_status: availStatus,
    sold_status: soldStatus,
    model_status: modelStatus,
    price_status: priceStatus,
  });
}
