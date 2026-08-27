export type DiffEventType =
  | "SLOT_APPEARED"
  | "SLOT_DISAPPEARED"
  | "SLOT_STATUS_CHANGED"
  | "SLOT_PRICE_CHANGED"
  | "POOL_BASE_PRICE_CHANGED"
  | "MODEL_UPGRADE_EVENT"
  | "TIER_UPDATED_EVENT"
  | "PRICE_CHANGED"
  | "CATALOG_UPDATED"
  | "NEW_POOL_EVENT";

export interface ModelDiffItem {
  type: "added" | "upgraded" | "removed";
  modelName: string;
  previousModelName?: string;
  family: string;
  oldVersion?: string;
  newVersion?: string;
  changeNote?: string;
}

export interface ModelUpgradePayload {
  added: ModelDiffItem[];
  upgraded: ModelDiffItem[];
  removed: ModelDiffItem[];
  allActiveModels: string[];
}

export interface TierUpdatedPayload {
  previousDescription?: string;
  newDescription: string;
  previousAnnualDiscount?: number;
  newAnnualDiscount: number;
  previousInfraSpec?: string;
  newInfraSpec?: string;
  previousManualProvisioning?: boolean;
  newManualProvisioning?: boolean;
  manualProvisioningChanged?: boolean;
}

export type PriceRating = "all_time_low" | "below_average" | "fair" | "above_average" | "insufficient_data";

export interface PriceAnalyticsPayload {
  rating: PriceRating;
  minPrice: number | null;
  avgPrice: number | null;
  maxPrice: number | null;
  sampleCount: number;
}

export interface SlotPricePayload {
  block: string;
  hoursUtc: string;
  previousPrice: string;
  newPrice: string;
  priceDelta: number;
  percentageDelta: number;
  isDiscount: boolean;
  priceAnalytics?: PriceAnalyticsPayload;
}

export interface PoolBasePricePayload {
  previousMinPrice: string;
  newMinPrice: string;
  priceDelta: number;
  percentageDelta: number;
  priceAnalytics?: PriceAnalyticsPayload;
}

export type DemandCategory = "flash" | "hot" | "moderate" | "stable" | "unknown";
export type DropPatternType = "BATCH_DROP" | "SINGLE_SLOT_RELEASE" | "UNKNOWN";
export type DropType = "BATCH_CAPACITY_EXPANSION" | "UNRENEWED_EXPIRY" | "ISOLATED_PROVISIONING" | "UNKNOWN";
export type PredictionConfidence = "HIGH" | "MEDIUM" | "LOW" | "INSUFFICIENT_DATA";

export interface DropClassification {
  dropType: DropType;
  confidence: number; // 0.00 to 1.00
  isHourlyBoundary: boolean;
  clusterSize: number;
  labelKey: string;
}

export interface EtaPrediction {
  isPredictable: boolean;
  sampleCount: number;
  minRequired: number;
  confidence: PredictionConfidence;
  confidenceScore: number; // 0 to 100
  medianDowntimeSeconds: number | null;
  downtimeIqrLowSeconds: number | null;
  downtimeIqrHighSeconds: number | null;
  detectedCadenceHours: number | null; // e.g. 24, 12, 1
  expectedOpenTimestampMin: number | null; // Epoch ms
  expectedOpenTimestampMax: number | null; // Epoch ms
  formattedEtaWindow: string; // e.g. "~18-24 год"
  isOverdue?: boolean;
  message?: string;
}

export interface SlotAnalyticsPayload {
  avgLifespanFormatted: string; // e.g. "~45s", "~14 min", "~2.3 h"
  avgLifespanSeconds: number | null;
  demandCategory: DemandCategory;
  isBatchDrop: boolean;
  dropPattern: DropPatternType;
  totalOpenings: number;
  lastOpenedAt?: string | null;
  eta?: EtaPrediction;
  dropClassification?: DropClassification;
}

export interface DiffEvent {
  id: string;
  type: DiffEventType;
  poolSlug: string;
  poolName: string;
  block: string; // 'asia' | 'europe' | 'americas' | 'ALL'
  models: string[];
  hoursUtc: string;
  previousStatus?: string;
  newStatus?: string;
  previousPrice?: string;
  newPrice?: string;
  timestamp: number;
  modelUpgrade?: ModelUpgradePayload;
  tierUpdate?: TierUpdatedPayload;
  slotPrice?: SlotPricePayload;
  basePrice?: PoolBasePricePayload;
  analytics?: SlotAnalyticsPayload;
  metadata?: Record<string, unknown>;
}

export interface PoolBlock {
  block: string;
  hoursUtc: string;
  pricePerMonth: string;
  status: string;
}

export interface PoolData {
  id: string;
  slug: string;
  modelId: string;
  modelName: string;
  models: string[];
  description: string;
  status: string;
  minPricePerDay: string;
  annualDiscount: number;
  blocks: PoolBlock[];
  infraSpec?: string;
  manualProvisioning?: boolean;
}

export interface PoolsSnapshot {
  success: boolean;
  data: PoolData[];
}

export interface ScrapeResult {
  success: boolean;
  modified: boolean;
  snapshot?: PoolsSnapshot;
  etag?: string;
  lastModified?: string;
  source: string;
  latencyMs: number;
  usedProxy?: string | null;
}

