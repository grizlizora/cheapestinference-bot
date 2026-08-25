import { Menu } from "@grammyjs/menu";
import { BotContext } from "../../types/context.js";
import { SubscriptionDAO } from "../../db/dao/subscriptions.js";
import { UserDAO } from "../../db/dao/users.js";
import { PoolStateDAO } from "../../db/dao/poolState.js";
import { SlotHistoryDAO } from "../../db/dao/slotHistory.js";
import { SubscriberInvertedIndex } from "../notifier/subscriberIndex.js";
import { renderDashboardText, safeEditMessageText } from "./mainDashboard.js";

const DEFAULT_BLOCK_IDS = ["asia", "europe", "americas"];

export function createSubscriptionsMenu(
  subDao: SubscriptionDAO,
  userDao: UserDAO,
  poolStateDao: PoolStateDAO,
  invertedIndex: SubscriberInvertedIndex,
  historyDao?: SlotHistoryDAO
) {
  return new Menu<BotContext>("subscriptions-menu")
    // Category 1: Available Slots
    .text(
      (ctx) =>
        (ctx.user.notify_available_global ?? 1) === 1
          ? ctx.t("subscriptions.btn_toggle_avail_on")
          : ctx.t("subscriptions.btn_toggle_avail_off"),
      async (ctx) => {
        const val = userDao.toggleAvailable(ctx.from!.id);
        ctx.user.notify_available_global = val;
        invertedIndex.updateUserPreferences(ctx.from!.id, {
          notifyAvailableGlobal: val === 1,
        });

        const toast =
          val === 1
            ? ctx.t("subscriptions.toast_avail_on")
            : ctx.t("subscriptions.toast_avail_off");
        await ctx.answerCallbackQuery(toast);
        await safeEditMessageText(ctx, renderSubscriptionsText(ctx, subDao));
        try {
          ctx.menu.update();
        } catch {}
      }
    )
    .row()
    // Category 2: Sold Out
    .text(
      (ctx) =>
        (ctx.user.notify_sold_out_global ?? 0) === 1
          ? ctx.t("subscriptions.btn_toggle_sold_on")
          : ctx.t("subscriptions.btn_toggle_sold_off"),
      async (ctx) => {
        const val = userDao.toggleSoldOut(ctx.from!.id);
        ctx.user.notify_sold_out_global = val;
        invertedIndex.updateUserPreferences(ctx.from!.id, {
          notifySoldOutGlobal: val === 1,
        });

        const toast =
          val === 1
            ? ctx.t("subscriptions.toast_sold_on")
            : ctx.t("subscriptions.toast_sold_off");
        await ctx.answerCallbackQuery(toast);
        await safeEditMessageText(ctx, renderSubscriptionsText(ctx, subDao));
        try {
          ctx.menu.update();
        } catch {}
      }
    )
    .row()
    // Category 3: Model Updates
    .text(
      (ctx) =>
        (ctx.user.notify_models_global ?? 1) === 1
          ? ctx.t("subscriptions.btn_toggle_models_on")
          : ctx.t("subscriptions.btn_toggle_models_off"),
      async (ctx) => {
        const val = userDao.toggleModels(ctx.from!.id);
        ctx.user.notify_models_global = val;
        invertedIndex.updateUserPreferences(ctx.from!.id, {
          notifyModelsGlobal: val === 1,
        });

        const toast =
          val === 1
            ? ctx.t("subscriptions.toast_models_on")
            : ctx.t("subscriptions.toast_models_off");
        await ctx.answerCallbackQuery(toast);
        await safeEditMessageText(ctx, renderSubscriptionsText(ctx, subDao));
        try {
          ctx.menu.update();
        } catch {}
      }
    )
    .row()
    // Category 4: Price Changes
    .text(
      (ctx) =>
        (ctx.user.notify_prices_global ?? 1) === 1
          ? ctx.t("subscriptions.btn_toggle_prices_on")
          : ctx.t("subscriptions.btn_toggle_prices_off"),
      async (ctx) => {
        const val = userDao.togglePrices(ctx.from!.id);
        ctx.user.notify_prices_global = val;
        invertedIndex.updateUserPreferences(ctx.from!.id, {
          notifyPricesGlobal: val === 1,
        });

        const toast =
          val === 1
            ? ctx.t("subscriptions.toast_prices_on")
            : ctx.t("subscriptions.toast_prices_off");
        await ctx.answerCallbackQuery(toast);
        await safeEditMessageText(ctx, renderSubscriptionsText(ctx, subDao));
        try {
          ctx.menu.update();
        } catch {}
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

        // Synchronize in-memory inverted index
        invertedIndex.updateSubscription(ctx.user.id, "ALL", "ALL", {
          available: active,
          soldOut: active,
          models: active,
          prices: active,
        });

        for (const p of pools) {
          invertedIndex.updateSubscription(ctx.user.id, p.slug, "ALL", {
            available: active,
            soldOut: active,
            models: active,
            prices: active,
          });
          for (const b of p.blocks) {
            invertedIndex.updateSubscription(ctx.user.id, p.slug, b, {
              available: active,
              soldOut: active,
              models: active,
              prices: active,
            });
          }
        }

        const toast = active
          ? ctx.t("subscriptions.toast_global_on")
          : ctx.t("subscriptions.toast_global_off");
        await ctx.answerCallbackQuery(toast);
        await safeEditMessageText(ctx, renderSubscriptionsText(ctx, subDao));
        try {
          ctx.menu.update();
        } catch {}
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
        await ctx.answerCallbackQuery(toast);
        await safeEditMessageText(ctx, renderSubscriptionsText(ctx, subDao));
        try {
          ctx.menu.update();
        } catch {}
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

      for (const pool of pools) {
        const isPoolSub = subDao.hasSubscription(ctx.user.id, pool.slug, "ALL");
        range
          .text(
            isPoolSub
              ? ctx.t("subscriptions.pool_active", { name: pool.name })
              : ctx.t("subscriptions.pool_inactive", { name: pool.name }),
            async (c) => {
              // Cascading Master Toggle: Toggling the pool synchronizes all 3 regional blocks!
              const active = subDao.togglePoolWithBlocks(c.user.id, pool.slug, DEFAULT_BLOCK_IDS);

              invertedIndex.updateSubscription(c.user.id, pool.slug, "ALL", {
                available: active,
                soldOut: active,
                models: active,
                prices: active,
              });

              for (const bId of DEFAULT_BLOCK_IDS) {
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
              await c.answerCallbackQuery(toast);
              await safeEditMessageText(c, renderSubscriptionsText(c, subDao));
              try {
                c.menu.update();
              } catch {}
            }
          )
          .row();

        for (const block of blocks) {
          const isSlotSub = subDao.hasSubscription(ctx.user.id, pool.slug, block.id);
          const blockTitle = ctx.t(block.nameKey);

          range
            .text(
              isSlotSub
                ? ctx.t("subscriptions.slot_active", { name: blockTitle, hours: block.hours })
                : ctx.t("subscriptions.slot_inactive", { name: blockTitle, hours: block.hours }),
              async (c) => {
                // Child Block Toggle: Auto-updates parent "Весь пул" state
                const active = subDao.toggleBlockAndUpdatePool(c.user.id, pool.slug, block.id, DEFAULT_BLOCK_IDS);
                const parentPoolActive = subDao.hasSubscription(c.user.id, pool.slug, "ALL");

                invertedIndex.updateSubscription(c.user.id, pool.slug, block.id, {
                  available: active,
                  soldOut: active,
                  models: active,
                  prices: active,
                });

                invertedIndex.updateSubscription(c.user.id, pool.slug, "ALL", {
                  available: parentPoolActive,
                  soldOut: parentPoolActive,
                  models: parentPoolActive,
                  prices: parentPoolActive,
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
                  ? c.t("subscriptions.toast_slot_on", {
                      pool: pool.name,
                      block: `${blockTitle} (${block.hours})`,
                    })
                  : c.t("subscriptions.toast_slot_off", {
                      pool: pool.name,
                      block: `${blockTitle} (${block.hours})`,
                    });
                await c.answerCallbackQuery(toast);
                await safeEditMessageText(c, renderSubscriptionsText(c, subDao));
                try {
                  c.menu.update();
                } catch {}
              }
            )
            .row();
        }
      }
    })
    .back(
      (ctx) => ctx.t("common.back"),
      async (ctx) => {
        await ctx.answerCallbackQuery();
        await safeEditMessageText(ctx, renderDashboardText(ctx, poolStateDao, historyDao));
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
