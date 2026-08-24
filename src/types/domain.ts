export type SlotStatus = "sold-out" | "limited" | "available" | "active" | "unknown";
export type RegionBlock = "asia" | "europe" | "americas" | "global";

export interface PoolBlockData {
  block: RegionBlock | string;
  hoursUtc: string;
  pricePerMonth: string;
  status: SlotStatus | string;
}

export interface PoolData {
  id: string;
  slug: string;
  modelId: string;
  modelName: string;
  models: string[];
  description: string;
  infraSpec?: string;
  status: string;
  minPricePerDay: string;
  manualProvisioning?: boolean;
  annualDiscount?: number;
  blocks: PoolBlockData[];
  createdAt?: string;
}

export interface PoolsSnapshot {
  success: boolean;
  data: PoolData[];
}

export type DiffEventType =
  | "SLOT_APPEARED"         // sold-out -> limited | available
  | "SLOT_DISAPPEARED"      // limited | available -> sold-out
  | "SLOT_STATUS_CHANGED"   // limited <-> available
  | "PRICE_CHANGED"         // Price increased or decreased
  | "CATALOG_UPDATED"       // Models or pool description updated
  | "NEW_POOL_EVENT";       // Brand new pool detected

export interface DiffEvent {
  id: string;
  type: DiffEventType;
  poolSlug: string;
  poolName: string;
  block: string;
  models: string[];
  hoursUtc: string;
  previousStatus?: string;
  newStatus: string;
  previousPrice?: string;
  newPrice: string;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

export interface ScrapeResult {
  success: boolean;
  modified: boolean;
  etag?: string;
  lastModified?: string;
  snapshot?: PoolsSnapshot;
  source: "api" | "html_snapshot" | "html_dom" | "cache_not_modified";
  latencyMs: number;
  error?: string;
}
