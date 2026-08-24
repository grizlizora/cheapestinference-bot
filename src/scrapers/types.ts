import { ScrapeResult } from "../types/domain.js";

export interface IFetcherEngine {
  fetch(etag?: string, lastModified?: string): Promise<ScrapeResult>;
}
