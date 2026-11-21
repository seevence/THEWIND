import { sql } from "@aihot/backend/db";
import { defineQueue, type ModuleQueue } from "@aihot/backend/modules";
import type { CareerObservationBatchV1 } from "../contracts/api.ts";
import { ingestBatch } from "./ingest.ts";

export const careerIngestQueue: ModuleQueue<CareerObservationBatchV1> = defineQueue({
  name: "career-insights.ingest",
  options: { retryLimit: 3, retryDelay: 60, retryBackoff: true, expireInSeconds: 600 },
  worker: { batchSize: 1 },
  async run(batches) {
    let written = 0;
    for (const batch of batches) {
      const result = await ingestBatch(sql, batch);
      written += result.accepted + result.updated + result.duplicates + result.rejected;
    }
    return written;
  },
});