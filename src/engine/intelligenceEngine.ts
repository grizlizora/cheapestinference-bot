import { SlotHistoryDAO, SlotAnalytics } from "../db/dao/slotHistory.js";
import { SupportedLanguage, translate } from "../i18n/index.js";

export interface SmartStatusResult {
  badge: string;
  demandTag: string;
  isHot: boolean;
  predictionTip?: string;
  analytics: SlotAnalytics;
}

export class AvailabilityIntelligenceEngine {
  constructor(private readonly historyDao: SlotHistoryDAO) {}

  public getSmartStatus(
    poolSlug: string,
    blockId: string,
    rawSiteStatus: string,
    lang: SupportedLanguage = "uk"
  ): SmartStatusResult {
    const analytics = this.historyDao.getSlotAnalytics(poolSlug, blockId);

    if (rawSiteStatus === "sold-out") {
      return {
        badge: translate(lang, "common.status_sold_out"),
        demandTag: "",
        isHot: false,
        analytics,
      };
    }

    if (rawSiteStatus === "limited") {
      return {
        badge: translate(lang, "common.status_limited"),
        demandTag: "🔥 High Demand",
        isHot: true,
        predictionTip:
          analytics.avgDurationFormatted
            ? `⚡ <i>За історією розбирають за ${analytics.avgDurationFormatted}!</i>`
            : "⚡ <i>Сайт сигналізує про обмежену кількість місць!</i>",
        analytics,
      };
    }

    // rawSiteStatus === "available"
    if (analytics.demandCategory === "hot" && analytics.avgDurationFormatted) {
      return {
        badge: `🟡 ${translate(lang, "common.status_limited")} (🔥 ${analytics.avgDurationFormatted})`,
        demandTag: "🔥 Hot Slot",
        isHot: true,
        predictionTip: `🔥 <i>Гарячий слот! За історією живе в середньому ${analytics.avgDurationFormatted}.</i>`,
        analytics,
      };
    }

    return {
      badge: translate(lang, "common.status_available"),
      demandTag: "🟢 Stable",
      isHot: false,
      predictionTip: analytics.avgDurationFormatted
        ? `⏱ <i>Середній час у наявності: ${analytics.avgDurationFormatted}</i>`
        : undefined,
      analytics,
    };
  }
}
