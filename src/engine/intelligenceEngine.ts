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
      const tip = analytics.avgDurationFormatted
        ? translate(lang, "intelligence.tip_limited_historical", { duration: analytics.avgDurationFormatted })
        : translate(lang, "intelligence.tip_limited_site");

      return {
        badge: translate(lang, "common.status_limited"),
        demandTag: translate(lang, "intelligence.tag_high_demand"),
        isHot: true,
        predictionTip: tip,
        analytics,
      };
    }

    // rawSiteStatus === "available"
    if (analytics.demandCategory === "hot" && analytics.avgDurationFormatted) {
      return {
        badge: `${translate(lang, "common.status_available")} (🔥 ${analytics.avgDurationFormatted})`,
        demandTag: translate(lang, "intelligence.tag_hot_slot"),
        isHot: true,
        predictionTip: translate(lang, "intelligence.tip_hot_historical", { duration: analytics.avgDurationFormatted }),
        analytics,
      };
    }

    return {
      badge: translate(lang, "common.status_available"),
      demandTag: translate(lang, "intelligence.tag_stable"),
      isHot: false,
      predictionTip: analytics.avgDurationFormatted
        ? translate(lang, "intelligence.tip_stable_historical", { duration: analytics.avgDurationFormatted })
        : undefined,
      analytics,
    };
  }
}
