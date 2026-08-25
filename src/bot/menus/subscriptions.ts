import { Menu } from "@grammyjs/menu";
import { BotContext } from "../../types/context.js";
import { SubscriptionDAO } from "../../db/dao/subscriptions.js";
import { UserDAO } from "../../db/dao/users.js";
import { PoolStateDAO } from "../../db/dao/poolState.js";
import { renderDashboardText, safeEditMessageText } from "./mainDashboard.js";

export function createSubscriptionsMenu(
  subDao: SubscriptionDAO,
  userDao: UserDAO,
  poolStateDao: PoolStateDAO
) {
  return new Menu<BotContext>("subscriptions-menu")
    .text(
      (ctx) => {
        const isGlobal = subDao.hasSubscription(ctx.user.id, "ALL", "ALL");
        return isGlobal
          ? ctx.t("subscriptions.btn_toggle_global_off")
          : ctx.t("subscriptions.btn_toggle_global_on");
      },
      async (ctx) => {
        const active = subDao.toggleSubscription(ctx.user.id, "ALL", "ALL");
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
    .text(
      (ctx) =>
        ctx.user.is_muted === 1
          ? ctx.t("subscriptions.btn_toggle_sound_on")
          : ctx.t("subscriptions.btn_toggle_sound_off"),
      async (ctx) => {
        const newMuted = userDao.toggleMute(ctx.from!.id);
        ctx.user.is_muted = newMuted;
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
              const active = subDao.toggleSubscription(c.user.id, pool.slug, "ALL");
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
                const active = subDao.toggleSubscription(c.user.id, pool.slug, block.id);
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
        await safeEditMessageText(ctx, renderDashboardText(ctx, poolStateDao));
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

  return ctx.t("subscriptions.title", {
    global_status: globalStatus,
    sound_status: soundStatus,
  });
}
