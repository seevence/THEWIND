import type { Db } from "@aihot/backend/db";
import type { DataOrigin } from "../contracts/index.ts";

export type IngestRunKind = "jobs" | "policy";
export type IngestRunStatus = "ok" | "partial" | "failed";

export interface IngestRunCounts {
  job_count: number;
  accepted: number;
  updated: number;
  duplicates: number;
  rejected: number;
}

export interface IngestRunKey {
  kind: IngestRunKind;
  source_key: string;
  fetched_at: string;
  collector_version: string;
  data_origin: DataOrigin;
}

export interface IngestRunRecord extends IngestRunKey {
  id: string;
  status: IngestRunStatus;
  counts: IngestRunCounts;
  error: string | null;
  created_at: string;
}

export interface StartedRun {
  id: string | null;
  existing: boolean;
}

const ERROR_LIMIT = 500;
const ZERO_COUNTS: IngestRunCounts = { job_count: 0, accepted: 0, updated: 0, duplicates: 0, rejected: 0 };

function clampCount(value: number | undefined): number {
  return Number.isFinite(value) && (value as number) > 0 ? Math.trunc(value as number) : 0;
}

function normalizeCounts(counts: Partial<IngestRunCounts> | undefined): IngestRunCounts {
  return {
    job_count: clampCount(counts?.job_count),
    accepted: clampCount(counts?.accepted),
    updated: clampCount(counts?.updated),
    duplicates: clampCount(counts?.duplicates),
    rejected: clampCount(counts?.rejected),
  };
}

function safeError(error: string | null | undefined): string | null {
  if (typeof error !== "string" || error.trim() === "") return null;
  return error.slice(0, ERROR_LIMIT);
}

export async function startRun(db: Db, key: IngestRunKey): Promise<StartedRun> {
  const inserted = await db<{ id: string }[]>`
    INSERT INTO career_ingest_runs (
      kind, source_key, fetched_at, collector_version, data_origin, status, error
    ) VALUES (
      ${key.kind}, ${key.source_key}, ${key.fetched_at}::timestamptz, ${key.collector_version},
      ${key.data_origin}, 'failed', 'run started but did not finish'
    )
    ON CONFLICT (source_key, kind, fetched_at) DO NOTHING
    RETURNING id`;
  if (inserted[0] !== undefined) return { id: inserted[0].id, existing: false };

  const rows = await db<{ id: string }[]>`
    SELECT id FROM career_ingest_runs
    WHERE source_key = ${key.source_key} AND kind = ${key.kind} AND fetched_at = ${key.fetched_at}::timestamptz
    LIMIT 1`;
  return { id: rows[0]?.id ?? null, existing: true };
}

export async function finishRun(
  db: Db,
  key: IngestRunKey,
  status: IngestRunStatus,
  counts: Partial<IngestRunCounts> | undefined,
  error: string | null | undefined,
): Promise<string> {
  const normalized = counts === undefined ? ZERO_COUNTS : normalizeCounts(counts);
  const rows = await db<{ id: string }[]>`
    INSERT INTO career_ingest_runs (
      kind, source_key, fetched_at, collector_version, data_origin, status,
      job_count, accepted, updated, duplicates, rejected, error
    ) VALUES (
      ${key.kind}, ${key.source_key}, ${key.fetched_at}::timestamptz, ${key.collector_version},
      ${key.data_origin}, ${status},
      ${normalized.job_count}, ${normalized.accepted}, ${normalized.updated},
      ${normalized.duplicates}, ${normalized.rejected}, ${safeError(error)}
    )
    ON CONFLICT (source_key, kind, fetched_at) DO UPDATE SET
      collector_version = EXCLUDED.collector_version,
      data_origin = EXCLUDED.data_origin,
      status = EXCLUDED.status,
      job_count = EXCLUDED.job_count,
      accepted = EXCLUDED.accepted,
      updated = EXCLUDED.updated,
      duplicates = EXCLUDED.duplicates,
      rejected = EXCLUDED.rejected,
      error = EXCLUDED.error
    RETURNING id`;
  return rows[0]!.id;
}

export async function listRuns(db: Db, kind: IngestRunKind, limit = 20): Promise<IngestRunRecord[]> {
  const rows = await db<{
    id: string;
    kind: IngestRunKind;
    source_key: string;
    fetched_at: Date;
    collector_version: string;
    data_origin: DataOrigin;
    status: IngestRunStatus;
    job_count: number;
    accepted: number;
    updated: number;
    duplicates: number;
    rejected: number;
    error: string | null;
    created_at: Date;
  }[]>`
    SELECT id, kind, source_key, fetched_at, collector_version, data_origin, status,
      job_count, accepted, updated, duplicates, rejected, error, created_at
    FROM career_ingest_runs
    WHERE kind = ${kind}
    ORDER BY fetched_at DESC
    LIMIT ${limit}`;

  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    source_key: row.source_key,
    fetched_at: new Date(row.fetched_at).toISOString(),
    collector_version: row.collector_version,
    data_origin: row.data_origin,
    status: row.status,
    counts: {
      job_count: row.job_count,
      accepted: row.accepted,
      updated: row.updated,
      duplicates: row.duplicates,
      rejected: row.rejected,
    },
    error: row.error,
    created_at: new Date(row.created_at).toISOString(),
  }));
}