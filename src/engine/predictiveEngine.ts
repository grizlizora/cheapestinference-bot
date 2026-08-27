import {
  DemandCategory,
  DropClassification,
  DropType,
  EtaPrediction,
  PredictionConfidence,
} from "../types/domain.js";
import { SlotHistoryDAO } from "../db/dao/slotHistory.js";

export interface SlotAnalyticsEnhanced {
  poolSlug: string;
  blockId: string;
  totalOpenings: number;
  sampleCount: number;
  medianDurationSeconds: number | null;
  trimmedMeanDurationSeconds: number | null;
  demandCategory: DemandCategory;
  avgDurationFormatted: string;
  lastOpenedAt: string | null;
  lastClosedAt: string | null;
  lastDropType: DropType;
  eta: EtaPrediction;
}

export class PredictiveAnalyticsEngine {
  constructor(private readonly historyDao: SlotHistoryDAO) {}

  /**
   * Computes robust quartiles (Q1, Median/Q2, Q3) and Interquartile Range (IQR)
   */
  public static calculateQuartiles(values: number[]): { q1: number; q2: number; q3: number; iqr: number } {
    if (!values || values.length === 0) {
      return { q1: 0, q2: 0, q3: 0, iqr: 0 };
    }
    const sorted = [...values].sort((a, b) => a - b);
    const n = sorted.length;

    const getPercentile = (p: number) => {
      const pos = (n - 1) * p;
      const base = Math.floor(pos);
      const rest = pos - base;
      if (sorted[base + 1] !== undefined) {
        return sorted[base] + rest * (sorted[base + 1] - sorted[base]);
      }
      return sorted[base];
    };

    const q1 = Math.round(getPercentile(0.25));
    const q2 = Math.round(getPercentile(0.50));
    const q3 = Math.round(getPercentile(0.75));
    const iqr = Math.max(0, q3 - q1);

    return { q1, q2, q3, iqr };
  }

  /**
   * Smart Drop Pattern Classifier:
   * Distinguishes between:
   * 1. BATCH_CAPACITY_EXPANSION: Multi-region release / catalog upgrade
   * 2. UNRENEWED_EXPIRY: Single slot unrenewed lease at :00 UTC boundary
   * 3. ISOLATED_PROVISIONING: Single ad-hoc opening
   */
  public classifyDrop(
    _poolSlug: string,
    _blockId: string,
    openTimestampMs: number = Date.now(),
    concurrentDropCount = 1,
    hasRecentCatalogMutation = false
  ): DropClassification {
    const date = new Date(openTimestampMs);
    const minute = date.getUTCMinutes();
    const second = date.getUTCSeconds();

    // Distance to nearest :00 UTC boundary in seconds
    const deltaBoundarySeconds = Math.min(minute * 60 + second, (60 - minute) * 60 - second);
    const isHourlyBoundary = deltaBoundarySeconds <= 180; // Within 3 minutes of :00

    let batchScore = 0;
    let expiryScore = 0;

    // 1. Boundary scoring
    if (isHourlyBoundary) {
      const boundaryProximity = 1.0 - deltaBoundarySeconds / 180;
      expiryScore += 0.45 + 0.35 * boundaryProximity;
    } else {
      batchScore += 0.2;
    }

    // 2. Concurrency scoring
    if (concurrentDropCount >= 2) {
      batchScore += 0.5 + Math.min((concurrentDropCount - 2) * 0.15, 0.4);
      expiryScore -= 0.3;
    } else {
      expiryScore += 0.2;
    }

    // 3. Catalog mutation trigger
    if (hasRecentCatalogMutation) {
      batchScore += 0.35;
    }

    let dropType: DropType = "ISOLATED_PROVISIONING";
    let labelKey = "drop_classifier.isolated";
    let confidence = 0.5;

    if (batchScore >= 0.65 && batchScore > expiryScore) {
      dropType = "BATCH_CAPACITY_EXPANSION";
      labelKey = "drop_classifier.batch_expansion";
      confidence = Math.min(0.95, batchScore);
    } else if (expiryScore >= 0.6 && expiryScore > batchScore) {
      dropType = "UNRENEWED_EXPIRY";
      labelKey = "drop_classifier.unrenewed_expiry";
      confidence = Math.min(0.95, expiryScore);
    }

    return {
      dropType,
      confidence: Math.round(confidence * 100) / 100,
      isHourlyBoundary,
      clusterSize: concurrentDropCount,
      labelKey,
    };
  }

  /**
   * Computes Outlier-Robust Duration and Demand Category via IQR & Median
   */
  public getDemandProfile(poolSlug: string, blockId: string): {
    demandCategory: DemandCategory;
    medianDurationSeconds: number | null;
    trimmedMeanSeconds: number | null;
    avgFormatted: string;
    totalOpenings: number;
    sampleCount: number;
  } {
    const rawDurations = this.historyDao.getRawDurations(poolSlug, blockId);
    if (rawDurations.length === 0) {
      return {
        demandCategory: "unknown",
        medianDurationSeconds: null,
        trimmedMeanSeconds: null,
        avgFormatted: "",
        totalOpenings: 0,
        sampleCount: 0,
      };
    }

    const { q1, q2: median, q3, iqr } = PredictiveAnalyticsEngine.calculateQuartiles(rawDurations);
    const lowerFence = Math.max(0, q1 - 1.5 * iqr);
    const upperFence = q3 + 1.5 * iqr;

    // Filter out outlier spikes
    const cleanDurations = rawDurations.filter((d) => d >= lowerFence && d <= upperFence);
    const effectiveClean = cleanDurations.length > 0 ? cleanDurations : rawDurations;

    // Trimmed & Recency-Weighted Mean of in-fence durations
    let trimmedMean: number;
    if (effectiveClean.length >= 6) {
      let weightSum = 0;
      let valSum = 0;
      effectiveClean.forEach((v, idx) => {
        const w = 1 / (1 + 0.1 * idx); // Newer observations carry higher mathematical weight
        valSum += v * w;
        weightSum += w;
      });
      trimmedMean = Math.round(valSum / weightSum);
    } else {
      trimmedMean = Math.round(
        effectiveClean.reduce((sum, v) => sum + v, 0) / effectiveClean.length
      );
    }

    const effectiveDuration =
      cleanDurations.length >= 3 ? Math.round(0.6 * median + 0.4 * trimmedMean) : median;

    let demandCategory: DemandCategory = "unknown";
    if (effectiveDuration < 300) {
      demandCategory = "flash";
    } else if (effectiveDuration <= 1800) {
      demandCategory = "hot";
    } else if (effectiveDuration <= 7200) {
      demandCategory = "moderate";
    } else {
      demandCategory = "stable";
    }

    let avgFormatted = "";
    if (effectiveDuration < 60) {
      avgFormatted = `~${effectiveDuration}s`;
    } else if (effectiveDuration < 3600) {
      avgFormatted = `~${Math.round(effectiveDuration / 60)} min`;
    } else if (effectiveDuration < 86400) {
      avgFormatted = `~${(effectiveDuration / 3600).toFixed(1)} h`;
    } else {
      avgFormatted = `~${(effectiveDuration / 86400).toFixed(1)} d`;
    }

    return {
      demandCategory,
      medianDurationSeconds: median,
      trimmedMeanSeconds: trimmedMean,
      avgFormatted,
      totalOpenings: rawDurations.length,
      sampleCount: effectiveClean.length,
    };
  }

  /**
   * Predictive Time-to-Next-Availability (ETA) Engine
   * Gated strictly by Sample Size N >= 3 to prevent spurious ungrounded predictions!
   */
  public predictNextAvailability(
    poolSlug: string,
    blockId: string,
    _currentStatus = "sold-out"
  ): EtaPrediction {
    const downtimes = this.historyDao.getDowntimeIntervals(poolSlug, blockId);
    const sampleCount = downtimes.length;

    // Strict Sample Size Threshold Gating (N >= 3)
    if (sampleCount < 3) {
      return {
        isPredictable: false,
        sampleCount,
        minRequired: 3,
        confidence: "INSUFFICIENT_DATA",
        confidenceScore: 0,
        medianDowntimeSeconds: null,
        downtimeIqrLowSeconds: null,
        downtimeIqrHighSeconds: null,
        detectedCadenceHours: null,
        expectedOpenTimestampMin: null,
        expectedOpenTimestampMax: null,
        formattedEtaWindow: "",
        message: "Збір даних (потрібно мін. 3 спостереження)",
      };
    }

    const { q1, q2: medianDowntime, q3 } = PredictiveAnalyticsEngine.calculateQuartiles(downtimes);

    // Calculate Median Absolute Deviation (MAD)
    const absoluteDeviations = downtimes.map((dt) => Math.abs(dt - medianDowntime));
    const { q2: mad } = PredictiveAnalyticsEngine.calculateQuartiles(absoluteDeviations);

    // Harmonic Periodicity Detection (24h, 12h, 48h, 1h)
    const candidates = [
      { hours: 24, seconds: 86400 },
      { hours: 12, seconds: 43200 },
      { hours: 48, seconds: 172800 },
      { hours: 1, seconds: 3600 },
    ];

    let detectedCadenceHours: number | null = null;
    for (const c of candidates) {
      const matchCount = downtimes.filter((dt) => Math.abs(dt - c.seconds) <= c.seconds * 0.25).length;
      if (matchCount / sampleCount >= 0.5) {
        detectedCadenceHours = c.hours;
        break;
      }
    }

    // Confidence scoring
    const dispersionRatio = mad / Math.max(medianDowntime, 60);
    let confidence: PredictionConfidence = "LOW";
    let confidenceScore = 35;

    if (
      (sampleCount >= 4 && dispersionRatio <= 0.4) ||
      (sampleCount >= 3 && detectedCadenceHours !== null)
    ) {
      confidence = "HIGH";
      confidenceScore = 85;
    } else if (sampleCount >= 3 && dispersionRatio <= 0.65) {
      confidence = "MEDIUM";
      confidenceScore = 65;
    }

    // Compute expected timestamp range
    const lastClosedEpoch =
      this.historyDao.getLastClosedEpoch(poolSlug, blockId) || Math.round(Date.now() / 1000);
    const lowSec = Math.max(0, medianDowntime - Math.max(mad, 1800));
    const highSec = medianDowntime + Math.max(mad, 1800);

    const expectedOpenTimestampMin = (lastClosedEpoch + lowSec) * 1000;
    const expectedOpenTimestampMax = (lastClosedEpoch + highSec) * 1000;
    const isOverdue = Date.now() > expectedOpenTimestampMax;

    const formatInterval = (s: number) => {
      if (s < 3600) return `${Math.round(s / 60)}хв`;
      if (s < 86400) return `${Math.round(s / 3600)}год`;
      return `${(s / 86400).toFixed(1)}дн`;
    };

    const formattedEtaWindow = `~${formatInterval(lowSec)} - ${formatInterval(highSec)}`;

    return {
      isPredictable: true,
      sampleCount,
      minRequired: 3,
      confidence,
      confidenceScore,
      medianDowntimeSeconds: medianDowntime,
      downtimeIqrLowSeconds: Math.round(q1),
      downtimeIqrHighSeconds: Math.round(q3),
      detectedCadenceHours,
      expectedOpenTimestampMin,
      expectedOpenTimestampMax,
      formattedEtaWindow,
      isOverdue,
    };
  }

  /**
   * Unified accessor for Bot UI & Menus
   */
  public getEnhancedAnalytics(
    poolSlug: string,
    blockId: string,
    currentStatus = "sold-out"
  ): SlotAnalyticsEnhanced {
    const demand = this.getDemandProfile(poolSlug, blockId);
    const eta = this.predictNextAvailability(poolSlug, blockId, currentStatus);
    const lastSlot = this.historyDao.getLastClosedSlotRecord(poolSlug, blockId);

    return {
      poolSlug,
      blockId,
      totalOpenings: demand.totalOpenings,
      sampleCount: demand.sampleCount,
      medianDurationSeconds: demand.medianDurationSeconds,
      trimmedMeanDurationSeconds: demand.trimmedMeanSeconds,
      demandCategory: demand.demandCategory,
      avgDurationFormatted: demand.avgFormatted,
      lastOpenedAt: lastSlot?.opened_at || null,
      lastClosedAt: lastSlot?.closed_at || null,
      lastDropType: (lastSlot?.initial_status as DropType) || "UNKNOWN",
      eta,
    };
  }
}
