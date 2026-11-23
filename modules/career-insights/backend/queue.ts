import { sql } from "@aihot/backend/db";
import { defineQueue, type ModuleQueue } from "@aihot/backend/modules";
import type { CareerObservationBatchV1 } from "../contracts/api.ts";
import { InvalidParameterError } from "./errors.ts";
import { ingestBatch } from "./ingest.ts";

export const careerIngestQueue: ModuleQueue<CareerObservationBatchV1> = defineQueue({
  name: "career-insights.ingest",
  options: { retryLimit: 3, retryDelay: 60, retryBackoff: true, expireInSeconds: 600 },
  worker: { batchSize: 1 },
  async run(batches) {
    let written = 0;
    for (const batch of batches) {
      try {
        const result = await ingestBatch(sql, batch);
        written += result.accepted + result.updated + result.duplicates + result.rejected;
      } catch (error) {
        // 参数错误重试多少次都一样，按 retryLimit 重投只会拖住后续批次并放大延迟。
        if (error instanceof InvalidParameterError) {
          const rawSourceKey: unknown = batch?.source_key;
          const sourceKey =
            typeof rawSourceKey === "string" ? rawSourceKey.trim() : String(rawSourceKey);
          console.error(`[career-insights.ingest] dropping batch from "${sourceKey}": ${error.message}`);
          continue;
        }
        throw error;
      }
    }
    return written;
  },
});