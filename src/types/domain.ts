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

export interface SlotPricePayload {
  block: string;
  hoursUtc: string;
  previousPrice: string;
  newPrice: string;
  priceDelta: number;
  percentageDelta: number;
  isDiscount: boolean;
}

export interface PoolBasePricePayload {
  previousMinPrice: string;
  newMinPrice: string;
  priceDelta: number;
  percentageDelta: number;
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
