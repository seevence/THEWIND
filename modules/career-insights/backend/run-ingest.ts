import type { Db } from "@aihot/backend/db";
import type { CareerObservationBatchV1, IngestResultV1 } from "../contracts/api.ts";
import type { DataOrigin } from "../contracts/index.ts";
import { ingestBatch } from "./ingest.ts";
import { finishRun, startRun, type IngestRunKey, type IngestRunStatus } from "./run-repository.ts";

export interface RunIngestResult extends IngestResultV1 {
  run_id: string;
  status: IngestRunStatus;
}

export async function ingestWithRun(
  db: Db,
  batch: CareerObservationBatchV1,
  dataOrigin: DataOrigin = "live",
): Promise<RunIngestResult> {
  const key: IngestRunKey = {
    kind: "jobs",
    source_key: batch.source_key,
    fetched_at: batch.fetched_at,
    collector_version: batch.collector_version,
    data_origin: dataOrigin,
  };
  const started = await startRun(db, key);

  try {
    const result = await ingestBatch(db, batch, { data_origin: dataOrigin, batch_id: started.id });
    const status: IngestRunStatus = result.rejected > 0 ? "partial" : "ok";
    const runId = await finishRun(
      db,
      key,
      status,
      {
        job_count: batch.jobs.length,
        accepted: result.accepted,
        updated: result.updated,
        duplicates: result.duplicates,
        rejected: result.rejected,
      },
      result.rejected > 0 ? `${result.rejected} job(s) rejected` : null,
    );
    return { ...result, run_id: runId, status };
  } catch (error) {
    await finishRun(
      db,
      key,
      "failed",
      { job_count: batch.jobs.length },
      error instanceof Error ? error.message : String(error),
    );
    throw error;
  }
}