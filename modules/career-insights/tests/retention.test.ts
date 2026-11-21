// career-insights 的每日清理：过期的岗位观测（180 天）与采集流水（90 天）按参数化 SQL 删除，
// 返回删除行数；单条语句失败只记进结果、不抛穿。用真库验证保留边界，用假库验证失败语义。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, beforeEach, test } from "node:test";
import { closeDb, sql, type Db } from "@aihot/backend/db";
import type { NormalizedJobV1 } from "../contracts/index.ts";
import { ingestBatch } from "../backend/ingest.ts";
import {
  CAREER_INGEST_RUN_RETENTION_DAYS,
  CAREER_OBSERVATION_RETENTION_DAYS,
  careerRetention,
  clearCareerRetention,
} from "../backend/retention.ts";
import { NORMALIZER_VERSION } from "../data/normalize.ts";

const NOW = new Date("2026-11-21T06:10:00.000Z");
const DAY_MS = 86_400_000;
const digest = (seed: string) => createHash("sha256").update(seed).digest("hex");

function daysBefore(days: number): string {
  return new Date(NOW.getTime() - days * DAY_MS).toISOString();
}

function job(overrides: Partial<NormalizedJobV1> = {}): NormalizedJobV1 {
  const jobKey = overrides.job_key ?? "retention-job-1";
  return {
    schema_version: "1.0",
    normalizer_version: NORMALIZER_VERSION,
    source_key: "career-retention-test",
    job_key: jobKey,
    company_name: "测试科技有限公司",
    title: "算法工程师",
    official_url: `https://careers.example/jobs/${jobKey}`,
    role_family: "ai_algorithm",
    locations: ["北京"],
    degree: "bachelor",
    degree_raw: "本科",
    experience_min_years: 0,
    experience_max_years: 3,
    experience_raw: "1-3 年",
    employment_type: "experienced",
    student_friendly: "unknown",
    skills: ["python"],
    skill_evidence: [{ skill_id: "python", evidence_text: "熟悉 Python" }],
    published_at: null,
    fetched_at: daysBefore(CAREER_OBSERVATION_RETENTION_DAYS + 20),
    collector_version: "test-collector-1",
    content_hash: digest(jobKey),
    raw_text: "岗位文本",
    raw_payload: { id: jobKey },
    ...overrides,
  };
}

async function seedJob(fetchedAt: string, jobKey: string): Promise<void> {
  await ingestBatch(sql, {
    schema_version: "1.0",
    source_key: "career-retention-test",
    fetched_at: fetchedAt,
    collector_version: "test-collector-1",
    jobs: [job({ job_key: jobKey, fetched_at: fetchedAt, content_hash: digest(jobKey) })],
  });
}

async function seedRun(fetchedAt: string, sourceKey: string): Promise<void> {
  await sql`
    INSERT INTO career_ingest_runs (kind, source_key, fetched_at, collector_version, data_origin, status, job_count)
    VALUES ('jobs', ${sourceKey}, ${fetchedAt}::timestamptz, 'test-collector-1', 'live', 'ok', 1)`;
}

async function countObservations(): Promise<number> {
  const [row] = await sql<{ count: number }[]>`SELECT COUNT(*)::int AS count FROM career_job_observations`;
  return row!.count;
}

async function countRuns(): Promise<number> {
  const [row] = await sql<{ count: number }[]>`SELECT COUNT(*)::int AS count FROM career_ingest_runs`;
  return row!.count;
}

beforeEach(async () => {
  await sql`TRUNCATE career_job_observations, career_jobs, career_ingest_runs RESTART IDENTITY`;
});

after(async () => {
  await closeDb();
});

test("observations older than 180 days and ingest runs older than 90 days are deleted, newer rows stay", async () => {
  // 200 天前与 170 天前各一个观测：只有 200 天前的过期。
  await seedJob(daysBefore(CAREER_OBSERVATION_RETENTION_DAYS + 20), "old-job");
  await seedJob(daysBefore(CAREER_OBSERVATION_RETENTION_DAYS - 10), "recent-job");
  assert.equal(await countObservations(), 2);

  // 100 天前与 80 天前各一条采集流水：只有 100 天前的过期。
  await seedRun(daysBefore(CAREER_INGEST_RUN_RETENTION_DAYS + 10), "old-source");
  await seedRun(daysBefore(CAREER_INGEST_RUN_RETENTION_DAYS - 10), "recent-source");
  assert.equal(await countRuns(), 2);

  const result = await clearCareerRetention(sql, NOW);

  assert.deepEqual(result, {
    deletedCareerObservations: 1,
    deletedCareerIngestRuns: 1,
    careerRetentionErrors: [],
  });
  const remaining = await sql<{ job_key: string }[]>`SELECT job_key FROM career_jobs ORDER BY job_key`;
  assert.deepEqual(remaining.map((row) => row.job_key), ["old-job", "recent-job"], "the job of a deleted observation stays; only the observation row goes");
  const remainingObs = await sql<{ observed_at: Date }[]>`SELECT observed_at FROM career_job_observations`;
  assert.equal(remainingObs.length, 1);
  const remainingRuns = await sql<{ source_key: string }[]>`SELECT source_key FROM career_ingest_runs`;
  assert.deepEqual(remainingRuns.map((row) => row.source_key), ["recent-source"]);
});

test("nothing older than the periods deletes nothing and reports zero", async () => {
  await seedJob(daysBefore(1), "fresh-job");
  await seedRun(daysBefore(1), "fresh-source");

  const result = await clearCareerRetention(sql, NOW);

  assert.deepEqual(result, { deletedCareerObservations: 0, deletedCareerIngestRuns: 0, careerRetentionErrors: [] });
  assert.equal(await countObservations(), 1);
  assert.equal(await countRuns(), 1);
});

test("a failing statement is recorded, not thrown, and the other table is still cleaned", async () => {
  // 第一条 DELETE 成功、第二条失败：用假库模拟「观测删掉了，采集流水没权限」。
  let statement = 0;
  const halfBroken = (async () => {
    statement += 1;
    if (statement === 1) return { count: 2 };
    throw new Error("permission denied");
  }) as unknown as Db;

  const result = await clearCareerRetention(halfBroken, NOW);

  assert.deepEqual(result, {
    deletedCareerObservations: 2,
    deletedCareerIngestRuns: 0,
    careerRetentionErrors: ["career_ingest_runs: Error: permission denied"],
  });
});

test("a database that rejects every statement yields zeros and both errors instead of throwing", async () => {
  const broken = (() => {
    throw new Error("db down");
  }) as unknown as Db;

  const result = await clearCareerRetention(broken, NOW);

  assert.equal(result.deletedCareerObservations, 0);
  assert.equal(result.deletedCareerIngestRuns, 0);
  assert.equal(result.careerRetentionErrors.length, 2);
  assert.match(result.careerRetentionErrors[0]!, /^career_job_observations: Error: db down$/);
  assert.match(result.careerRetentionErrors[1]!, /^career_ingest_runs: Error: db down$/);
});

test("the ServerModule.retention capability object reads the default database", async () => {
  await seedJob(daysBefore(CAREER_OBSERVATION_RETENTION_DAYS + 1), "capability-job");

  const result = await careerRetention.clear(NOW);

  assert.equal(result.deletedCareerObservations, 1);
  assert.equal(result.deletedCareerIngestRuns, 0);
  assert.equal(await countObservations(), 0);
});
