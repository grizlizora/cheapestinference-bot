/**
 * src/engine/priceDiffEvaluator.ts
 * Decoupled Price Parser, Delta Sanitizer & Base vs Regional Tariff Evaluator
 */

import {
  PoolData,
  SlotPricePayload,
  PoolBasePricePayload,
  DiffEvent,
} from "../types/domain.js";
import { CatalogHistoryDAO } from "../db/dao/catalogHistory.js";

export interface StagedSlotPriceChange {
  block: string;
  hoursUtc: string;
  prevPrice: string;
  newPrice: string;
  delta: number;
  pct: number;
  status: string;
}

export interface PriceEvaluationResult {
  events: DiffEvent[];
}

export class PriceDiffEvaluator {
  /**
   * Safe numeric parser extracting the primary currency number from arbitrary strings ($149.00, 149.00/mo, 149)
   */
  public static parseCleanPrice(val: string | undefined | null): number {
    if (!val) return 0;
    const str = String(val).trim();
    if (str.length === 0) return 0;

    // Fast-path: direct numeric literal
    const directNum = Number(str);
    if (!isNaN(directNum) && Number.isFinite(directNum)) {
      return Math.round(directNum * 100) / 100;
    }

    let startIndex = -1;
    let endIndex = -1;
    let hasDot = false;

    for (let i = 0; i < str.length; i++) {
      const code = str.charCodeAt(i);
      // '0'..'9'
      if (code >= 48 && code <= 57) {
        if (startIndex === -1) {
          if (i > 0 && (str.charCodeAt(i - 1) === 45 || str.charCodeAt(i - 1) === 43)) {
            startIndex = i - 1;
          } else {
            startIndex = i;
          }
        }
        endIndex = i + 1;
      } else if (code === 46 && startIndex !== -1 && !hasDot) {
        hasDot = true;
        endIndex = i + 1;
      } else if (startIndex !== -1 && code !== 44) {
        break;
      }
    }

    if (startIndex === -1) return 0;
    const extracted = str.slice(startIndex, endIndex).replace(/,/g, "");
    const num = parseFloat(extracted);
    if (isNaN(num) || !Number.isFinite(num)) return 0;
    return Math.round(num * 100) / 100;
  }

  /**
   * Floating-point sanitizer eliminating IEEE 754 precision artifacts and -0
   */
  public static cleanDelta(val: number): number {
    if (!Number.isFinite(val)) return 0;
    const rounded = Math.round(val * 100) / 100;
    return Object.is(rounded, -0) || rounded === 0 ? 0 : rounded;
  }

  /**
   * Evaluates slot price changes against pool base price changes.
   * Decouples uniform base price changes across all blocks (Case A: POOL_BASE_PRICE_CHANGED)
   * from isolated regional discounts/hikes (Case B: SLOT_PRICE_CHANGED).
   */
  public static evaluatePriceDiffs(
    pool: PoolData,
    prevPool: PoolData,
    stagedSlotPriceChanges: StagedSlotPriceChange[],
    catalogHistoryDao: CatalogHistoryDAO | undefined,
    timestamp: number
  ): PriceEvaluationResult {
    const events: DiffEvent[] = [];

    const basePriceChanged = pool.minPricePerDay !== prevPool.minPricePerDay;
    const allBlocksHaveSamePrice =
      (stagedSlotPriceChanges.length === pool.blocks.length &&
        pool.blocks.length > 1 &&
        stagedSlotPriceChanges.every((c) => c.newPrice === stagedSlotPriceChanges[0].newPrice)) ||
      (pool.blocks.length === 1 && basePriceChanged && stagedSlotPriceChanges.length === 1);

    if (basePriceChanged) {
      const prevPriceNum = PriceDiffEvaluator.parseCleanPrice(prevPool.minPricePerDay);
      const newPriceNum = PriceDiffEvaluator.parseCleanPrice(pool.minPricePerDay);
      const priceDelta = PriceDiffEvaluator.cleanDelta(newPriceNum - prevPriceNum);
      const pctDelta =
        prevPriceNum > 0 ? PriceDiffEvaluator.cleanDelta((priceDelta / prevPriceNum) * 100) : 0;

      if (priceDelta !== 0) {
        let priceAnalytics = undefined;
        if (catalogHistoryDao && newPriceNum > 0) {
          priceAnalytics = catalogHistoryDao.getPriceAnalytics(pool.slug, "ALL", newPriceNum);
        }

        const basePayload: PoolBasePricePayload = {
          previousMinPrice: prevPool.minPricePerDay,
          newMinPrice: pool.minPricePerDay,
          priceDelta,
          percentageDelta: pctDelta,
          priceAnalytics,
        };

        // Always persist base price change in catalog_history
        catalogHistoryDao?.recordBasePriceUpdate(
          pool.slug,
          pool.modelName,
          pool.models || [],
          basePayload
        );

        if (allBlocksHaveSamePrice || stagedSlotPriceChanges.length === 0) {
          events.push({
            id: crypto.randomUUID(),
            type: "POOL_BASE_PRICE_CHANGED",
            poolSlug: pool.slug,
            poolName: pool.modelName,
            block: "ALL",
            models: pool.models || [],
            hoursUtc: "",
            newStatus: pool.status,
            previousPrice: prevPool.minPricePerDay,
            newPrice: pool.minPricePerDay,
            timestamp,
            basePrice: basePayload,
          });
        }
      }
    }

    if (!allBlocksHaveSamePrice && stagedSlotPriceChanges.length > 0) {
      // Case B: Regional slot price delta
      for (const change of stagedSlotPriceChanges) {
        const cleanNew = PriceDiffEvaluator.parseCleanPrice(change.newPrice);
        let priceAnalytics = undefined;
        if (catalogHistoryDao && cleanNew > 0) {
          priceAnalytics = catalogHistoryDao.getPriceAnalytics(pool.slug, change.block, cleanNew);
        }

        const slotPricePayload: SlotPricePayload = {
          block: change.block,
          hoursUtc: change.hoursUtc,
          previousPrice: change.prevPrice,
          newPrice: change.newPrice,
          priceDelta: change.delta,
          percentageDelta: change.pct,
          isDiscount: change.delta < 0,
          priceAnalytics,
        };

        catalogHistoryDao?.recordSlotPriceChange(
          pool.slug,
          change.block,
          change.prevPrice,
          change.newPrice,
          change.delta,
          change.pct
        );

        events.push({
          id: crypto.randomUUID(),
          type: "SLOT_PRICE_CHANGED",
          poolSlug: pool.slug,
          poolName: pool.modelName,
          block: change.block,
          models: pool.models || [],
          hoursUtc: change.hoursUtc,
          newStatus: change.status,
          previousPrice: change.prevPrice,
          newPrice: change.newPrice,
          timestamp,
          slotPrice: slotPricePayload,
        });
      }
    }

    return { events };
  }
}
