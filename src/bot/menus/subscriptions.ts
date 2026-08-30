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
import { icon } from "../views/iconTheme.js";

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
  const syncAllUserSubsInRam = (userId: number) => {
    const subs = subDao.getSubscriptionsForUser(userId);
    for (const s of subs) {
      invertedIndex.updateSubscription(userId, s.pool_slug, s.block_id, {
        available: s.notify_on_available === 1,
        soldOut: s.notify_on_sold_out === 1,
        models: s.notify_on_models === 1,
        prices: s.notify_on_prices === 1,
      });
    }
  };

  return new Menu<BotContext>("subscriptions-menu")
    // Row 1: Available Slots & Sold-out Slots (2x2 Grid)
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
        syncAllUserSubsInRam(ctx.user.id);

        const toast =
          val === 1
            ? ctx.t("subscriptions.toast_avail_on")
            : ctx.t("subscriptions.toast_avail_off");
        ctx.answerCallbackQuery(toast).catch(() => {});
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
        syncAllUserSubsInRam(ctx.user.id);

        const toast =
          val === 1
            ? ctx.t("subscriptions.toast_sold_on")
            : ctx.t("subscriptions.toast_sold_off");
        ctx.answerCallbackQuery(toast).catch(() => {});
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
        syncAllUserSubsInRam(ctx.user.id);

        const toast =
          val === 1
            ? ctx.t("subscriptions.toast_models_on")
            : ctx.t("subscriptions.toast_models_off");
        ctx.answerCallbackQuery(toast).catch(() => {});
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
        syncAllUserSubsInRam(ctx.user.id);

        const toast =
          val === 1
            ? ctx.t("subscriptions.toast_prices_on")
            : ctx.t("subscriptions.toast_prices_off");
        ctx.answerCallbackQuery(toast).catch(() => {});
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
        ctx.answerCallbackQuery(toast).catch(() => {});
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
        ctx.answerCallbackQuery(toast).catch(() => {});
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
        const isPoolSub = subDao.isPoolSubscribed(ctx.user.id, pool.slug, blockIds);
        range
          .text(
            isPoolSub
              ? ctx.t("subscriptions.pool_active", { name: pool.name })
              : ctx.t("subscriptions.pool_inactive", { name: pool.name }),
            async (c) => {
              // Cascading Master Toggle: Toggling the pool synchronizes all regional blocks!
              const active = subDao.togglePoolWithBlocks(c.user.id, pool.slug, blockIds);
              const currentFlags = subDao.getPoolFlags(c.user.id, pool.slug);
              const flags = {
                available: active ? currentFlags.available : false,
                soldOut: active ? currentFlags.soldOut : false,
                models: active ? currentFlags.models : false,
                prices: active ? currentFlags.prices : false,
              };

              invertedIndex.updateSubscription(c.user.id, pool.slug, "ALL", flags);
              for (const bId of blockIds) {
                invertedIndex.updateSubscription(c.user.id, pool.slug, bId, flags);
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
              c.answerCallbackQuery(toast).catch(() => {});
              await safeEditMessageText(c, renderSubscriptionsText(c, subDao));
            }
          )
          .row();

        for (const block of blocks) {
          const isSlotSub = subDao.isBlockSubscribed(ctx.user.id, pool.slug, block.id);
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
                const fullFlags = {
                  available: currentFlags.available,
                  soldOut: currentFlags.soldOut,
                  models: currentFlags.models,
                  prices: currentFlags.prices,
                };
                const disabledFlags = { available: false, soldOut: false, models: false, prices: false };

                invertedIndex.updateSubscription(
                  c.user.id,
                  pool.slug,
                  "ALL",
                  parentPoolActive ? fullFlags : disabledFlags
                );

                for (const bId of blockIds) {
                  const bActive = subDao.isBlockSubscribed(c.user.id, pool.slug, bId);
                  invertedIndex.updateSubscription(
                    c.user.id,
                    pool.slug,
                    bId,
                    bActive ? fullFlags : disabledFlags
                  );
                }

                if (!active) {
                  invertedIndex.updateSubscription(c.user.id, "ALL", "ALL", disabledFlags);
                }

                const toast = active
                  ? c.t("subscriptions.toast_slot_on", { pool: pool.name, block: blockTitle })
                  : c.t("subscriptions.toast_slot_off", { pool: pool.name, block: blockTitle });
                c.answerCallbackQuery(toast).catch(() => {});
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
          const msgId = ctx.callbackQuery?.message?.message_id;
          dashboardRegistry?.updateView(ctx.chat.id, "dashboard", undefined, ctx.lang, msgId, ctx.user?.id);
        }
        await safeEditMessageText(ctx, renderDashboardText(ctx, poolStateDao, historyDao, scraper));
        return ctx.menu.nav("main-dashboard-menu");
      }
    );
}

export function renderSubscriptionsText(ctx: BotContext, subDao: SubscriptionDAO): string {
  const isGlobal = subDao.hasSubscription(ctx.user.id, "ALL", "ALL");

  const onIcon = icon("toggle_on");
  const offIcon = icon("toggle_off");

  const titleText = ctx.lang === "uk"
    ? `<b>Керування сповіщеннями</b>\n\nНалаштуйте категорії подій, тарифи та регіональні блоки:`
    : ctx.lang === "ru"
    ? `<b>Управление уведомлениями</b>\n\nНастройте категории событий, тарифы и региональные блоки:`
    : `<b>Notification Management</b>\n\nConfigure event categories, tiers, and regional blocks:`;

  const globalFiltersHeader = ctx.lang === "uk" ? "Глобальні фільтри:" : ctx.lang === "ru" ? "Глобальные фильтры:" : "Global Filters:";
  const dropsLabel = ctx.lang === "uk" ? "Вільні слоти" : ctx.lang === "ru" ? "Свободные слоты" : "Available Slots";
  const soldLabel = ctx.lang === "uk" ? "Розпродано" : ctx.lang === "ru" ? "Распродано" : "Sold Out";
  const modelsLabel = ctx.lang === "uk" ? "Оновлення моделей" : ctx.lang === "ru" ? "Обновления моделей" : "Model Updates";
  const pricesLabel = ctx.lang === "uk" ? "Зміни цін та тарифів" : ctx.lang === "ru" ? "Изменения цен и тарифов" : "Price & Tariff Changes";
  const globalAlertsLabel = ctx.lang === "uk" ? "Глобальні сповіщення" : ctx.lang === "ru" ? "Глобальные уведомления" : "Global Notifications";
  const soundLabel = ctx.lang === "uk" ? "Режим звуку" : ctx.lang === "ru" ? "Режим звука" : "Sound Mode";

  const soundStatus = ctx.user.is_muted === 1
    ? (ctx.lang === "uk" ? `Без звуку ${icon("notify_mute")}` : ctx.lang === "ru" ? `Без звука ${icon("notify_mute")}` : `Muted ${icon("notify_mute")}`)
    : (ctx.lang === "uk" ? `Звук увімкнено ${icon("notify_loud")}` : ctx.lang === "ru" ? `Звук включен ${icon("notify_loud")}` : `Sound on ${icon("notify_loud")}`);

  const availStatus = (ctx.user.notify_available_global ?? 1) === 1 ? onIcon : offIcon;
  const soldStatus = (ctx.user.notify_sold_out_global ?? 0) === 1 ? onIcon : offIcon;
  const modelStatus = (ctx.user.notify_models_global ?? 1) === 1 ? onIcon : offIcon;
  const priceStatus = (ctx.user.notify_prices_global ?? 1) === 1 ? onIcon : offIcon;
  const globalStatus = isGlobal ? onIcon : offIcon;

  return `${icon("notify_bell_on")} ${titleText}\n\n` +
    `<b>${globalFiltersHeader}</b>\n` +
    `• ${icon("event_slot_drop")} <b>${dropsLabel}:</b> ${availStatus}\n` +
    `• ${icon("event_slot_sold")} <b>${soldLabel}:</b> ${soldStatus}\n` +
    `• ${icon("ai_robot")} <b>${modelsLabel}:</b> ${modelStatus}\n` +
    `• ${icon("price_tag")} <b>${pricesLabel}:</b> ${priceStatus}\n\n` +
    `${icon("nav_language")} <b>${globalAlertsLabel}:</b> ${globalStatus}\n` +
    `🔊 <b>${soundLabel}:</b> ${soundStatus}`;
}
