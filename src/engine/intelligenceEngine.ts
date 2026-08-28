import { SlotHistoryDAO, SlotAnalytics } from "../db/dao/slotHistory.js";
import { PredictiveAnalyticsEngine } from "./predictiveEngine.js";
import { SupportedLanguage, translate } from "../i18n/index.js";
import { icon } from "../bot/views/iconTheme.js";

export interface SmartStatusResult {
  badge: string;
  demandTag: string;
  isHot: boolean;
  predictionTip?: string;
  etaTip?: string;
  collectingStatsTip?: string;
  analytics: SlotAnalytics;
}

export class AvailabilityIntelligenceEngine {
  private predictiveEngine: PredictiveAnalyticsEngine;

  constructor(private readonly historyDao: SlotHistoryDAO) {
    this.predictiveEngine = new PredictiveAnalyticsEngine(historyDao);
  }

  public getSmartStatus(
    poolSlug: string,
    blockId: string,
    rawSiteStatus: string,
    lang: SupportedLanguage = "uk"
  ): SmartStatusResult {
    const enhanced = this.predictiveEngine.getEnhancedAnalytics(poolSlug, blockId, rawSiteStatus);
    const analytics: SlotAnalytics = {
      avgDurationSeconds: enhanced.medianDurationSeconds,
      minDurationSeconds: null,
      maxDurationSeconds: null,
      totalOpenings: enhanced.totalOpenings,
      lastOpenedAt: enhanced.lastOpenedAt,
      demandCategory: enhanced.demandCategory,
      avgDurationFormatted: enhanced.avgDurationFormatted,
    };

    if (rawSiteStatus === "sold-out") {
      let etaTip: string | undefined;
      let collectingStatsTip: string | undefined;

      if (enhanced.eta.isPredictable) {
        let confBadge = translate(lang, "intelligence.conf_low") || "⚪";
        if (enhanced.eta.confidence === "HIGH") {
          const rawConf = (translate(lang, "intelligence.conf_high") || "Висока точність").replace(/^[🟢🟡🔴]\s*/u, "");
          confBadge = `${icon("status_available")} ${rawConf}`;
        } else if (enhanced.eta.confidence === "MEDIUM") {
          const rawConf = (translate(lang, "intelligence.conf_medium") || "Середня точність").replace(/^[🟢🟡🔴]\s*/u, "");
          confBadge = `${icon("status_partially_available")} ${rawConf}`;
        }

        const recurrenceText = enhanced.eta.detectedCadenceHours
          ? (translate(lang, "intelligence.cadence_daily") || "добовий цикл 24h")
          : enhanced.eta.formattedEtaWindow;

        const avgLifeText = enhanced.avgDurationFormatted ? ` (сер. життя: ${enhanced.avgDurationFormatted} ${icon("event_hot_slot")})` : "";

        etaTip = `${icon("prediction_crystal")} <i>${translate(lang, "intelligence.eta_title") || "Очікувана поява"}: ${recurrenceText}${avgLifeText} [${confBadge}]</i>`;
      } else {
        collectingStatsTip = `${icon("nav_chart")} <i>${translate(lang, "intelligence.eta_gathering_data", {
          count: enhanced.eta.sampleCount,
          min: enhanced.eta.minRequired,
        }) || `Збір статистики (${enhanced.eta.sampleCount}/${enhanced.eta.minRequired})`}</i>`;
      }

      return {
        badge: translate(lang, "common.status_sold_out"),
        demandTag: "",
        isHot: false,
        etaTip,
        collectingStatsTip,
        analytics,
      };
    }

    const isHot = Boolean(
      enhanced.avgDurationFormatted &&
        (enhanced.demandCategory === "hot" || enhanced.demandCategory === "flash")
    );

    let tip = "";
    if (enhanced.avgDurationFormatted) {
      if (isHot) {
        const rawHot = (translate(lang, "intelligence.tag_sells_out_in", { duration: enhanced.avgDurationFormatted }) || `Розбирають за ${enhanced.avgDurationFormatted}`).replace(/^[⚡🔥]\s*/u, "");
        tip = `${icon("event_hot_slot")} <i>${rawHot}</i>`;
      } else {
        const rawAvg = (translate(lang, "intelligence.tag_avg_uptime", { duration: enhanced.avgDurationFormatted }) || `Середній час наявності: ${enhanced.avgDurationFormatted}`).replace(/^[⏱🕒]\s*/u, "");
        tip = `${icon("nav_clock")} <i>${rawAvg}</i>`;
      }
    }

    return {
      badge: translate(lang, "common.status_available"),
      demandTag: isHot ? translate(lang, "intelligence.tag_high_demand") : translate(lang, "intelligence.tag_stable"),
      isHot,
      predictionTip: tip || undefined,
      analytics,
    };
  }
}
