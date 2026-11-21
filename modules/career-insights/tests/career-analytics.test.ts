// The hot board and the daily report read career_jobs / career_ingest_runs: these tests seed real
// batches (ingest and policy writes) and check the aggregates against the contract, then drive the
// Fastify routes for parameter bounds and cache semantics.
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import Fastify from "fastify";
import { closeDb, sql } from "@aihot/backend/db";
import type { NormalizedJobV1, SummaryResponseV1 } from "../contracts/index.ts";
import { loadCareerDaily, loadCareerHot } from "../backend/career-analytics.ts";
import { registerCareerHttp } from "../backend/http.ts";
import { ingestBatch } from "../backend/ingest.ts";
import { writePolicyBatch } from "../backend/policy-repository.ts";
import { finishRun } from "../backend/run-repository.ts";
import { SqlCareerRepository } from "../backend/sql-repository.ts";
import { NORMALIZER_VERSION } from "../data/normalize.ts";

const EPOCH = "1970-01-01T00:00:00.000Z";
const DAY_MS = 24 * 60 * 60 * 1000;
const repository = new SqlCareerRepository(sql);
const digest = (seed: string) => createHash("sha256").update(seed).digest("hex");
const nowIso = () => new Date().toISOString();

function job(overrides: Partial<NormalizedJobV1> = {}): NormalizedJobV1 {
  const skills = overrides.skills ?? ["python"];
  const jobKey = overrides.job_key ?? "job-1";
  return {
    schema_version: "1.0",
    normalizer_version: NORMALIZER_VERSION,
    source_key: "career-test",
    job_key: jobKey,
    company_name: "测试科技有限公司",
    title: "AI 应用开发工程师",
    official_url: "https://careers.example/jobs/job-1",
    role_family: "data",
    locations: ["北京"],
    degree: "bachelor",
    degree_raw: "本科",
    experience_min_years: 0,
    experience_max_years: 3,
    experience_raw: "1-3 年",
    employment_type: "campus",
    student_friendly: "yes",
    skills,
    skill_evidence: skills.map((skillId) => ({ skill_id: skillId, evidence_text: `熟悉 ${skillId}` })),
    published_at: null,
    fetched_at: nowIso(),
    collector_version: "test-collector-1",
    content_hash: digest(jobKey),
    raw_text: "岗位文本",
    raw_payload: { id: jobKey },
    ...overrides,
  };
}

async function seed(...jobs: NormalizedJobV1[]): Promise<void> {
  await ingestBatch(sql, {
    schema_version: "1.0",
    source_key: "career-test",
    fetched_at: jobs[0]!.fetched_at,
    collector_version: "test-collector-1",
    jobs,
  });
}

beforeEach(async () => {
  await sql`TRUNCATE career_job_observations, career_jobs, career_policies, career_ingest_runs RESTART IDENTITY`;
});

after(async () => {
  await closeDb();
});

test("the hot board aggregates by company inside the observation window and drops unknown families", async () => {
  await seed(
    job({ job_key: "baidu-1", company_name: "百度", role_family: "ai_product_operations", published_at: "2026-11-19T00:00:00.000Z" }),
    job({ job_key: "baidu-2", company_name: "百度", role_family: "unknown", published_at: "2026-11-19T00:00:00.000Z" }),
    job({ job_key: "tencent-1", company_name: "腾讯", role_family: "ai_algorithm" }),
    job({ job_key: "tencent-2", company_name: "腾讯", role_family: "ai_application_development" }),
    job({ job_key: "tencent-3", company_name: "腾讯", role_family: "data" }),
    job({ job_key: "tencent-4", company_name: "腾讯", role_family: "ai_product_operations" }),
    job({ job_key: "meituan-1", company_name: "美团", role_family: "unknown" }),
    job({ job_key: "meituan-2", company_name: "美团", role_family: "unknown" }),
    job({ job_key: "old-1", company_name: "旧公司", fetched_at: new Date(Date.now() - 60 * DAY_MS).toISOString() }),
  );

  const hot = await loadCareerHot(sql, { limit: 10, window_days: 30 });

  assert.equal(hot.contract_version, "0.1");
  assert.equal(hot.data_origin, "live");
  assert.equal(hot.window_days, 30);
  assert.deepEqual(
    hot.entries.map((entry) => [entry.company, entry.job_count]),
    [["腾讯", 4], ["百度", 2], ["美团", 2]],
    "job_count DESC, then latest_published_at DESC with invalid dates last",
  );
  assert.equal(hot.entries[0]!.latest_published_at, null);
  assert.deepEqual(hot.entries[0]!.role_families, [
    { role_family: "ai_algorithm", count: 1 },
    { role_family: "ai_application_development", count: 1 },
    { role_family: "ai_product_operations", count: 1 },
  ], "top 3 by count, ties by role_family ASC");
  assert.deepEqual(hot.entries[1], {
    company: "百度",
    job_count: 2,
    latest_published_at: "2026-11-19T00:00:00.000Z",
    role_families: [{ role_family: "ai_product_operations", count: 1 }],
  });
  assert.deepEqual(hot.entries[2]!.role_families, [], "unknown is not a role family");
  assert.equal(hot.entries.some((entry) => entry.company === "旧公司"), false, "observations outside the window are excluded");
  assert.notEqual(hot.as_of, EPOCH);
});

test("the hot board respects the limit and answers an empty table with an empty list", async () => {
  await seed(
    job({ job_key: "a-1", company_name: "甲" }),
    job({ job_key: "b-1", company_name: "乙" }),
  );
  const top = await loadCareerHot(sql, { limit: 1, window_days: 30 });
  assert.deepEqual(top.entries.map((entry) => entry.company).sort(), ["乙"]);

  await sql`TRUNCATE career_job_observations, career_jobs RESTART IDENTITY`;
  const empty = await loadCareerHot(sql, { limit: 10, window_days: 30 });
  assert.deepEqual(empty.entries, []);
  assert.equal(empty.as_of, EPOCH);
  assert.equal(empty.data_origin, "live");
});

test("the hot route rejects limit and window_days outside the bounds", async () => {
  await seed(
    job({ job_key: "a-1", company_name: "甲" }),
    job({ job_key: "b-1", company_name: "乙" }),
  );
  const app = Fastify();
  registerCareerHttp(app, repository);
  await app.ready();

  for (const query of ["limit=0", "limit=51", "limit=abc", "window_days=0", "window_days=366", "sort=jobs"]) {
    const response = await app.inject({ url: `/api/site/career-insights/hot?${query}` });
    assert.equal(response.statusCode, 400, query);
    assert.equal(response.json().error.code, "invalid_parameter", query);
  }

  const response = await app.inject({ url: "/api/site/career-insights/hot" });
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["cache-control"], "public, max-age=60, stale-while-revalidate=300");
  assert.equal(response.json().window_days, 30);
  assert.equal(response.json().entries.length, 2);
  await app.close();
});

test("the daily report answers has_run=false when today has no ingest run", async () => {
  const daily = await loadCareerDaily(sql);
  const expectedDate = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai" }).format(new Date());

  assert.equal(daily.contract_version, "0.1");
  assert.equal(daily.date, expectedDate);
  assert.deepEqual(daily.sources, []);
  assert.equal(daily.has_run, false);
  assert.equal(daily.jobs_total, 0);
  assert.equal(daily.new_jobs_today, 0);
  assert.equal(daily.new_policies_today, 0);
  assert.equal(daily.policies_total, 0);
  assert.equal(daily.unknown_ratio, null);
  assert.equal(daily.sample_size, 0);
  assert.equal(daily.data_origin, "live");
  assert.equal(daily.generated_at, EPOCH, "an empty table reports the epoch cutoff, not the request time");
});

test("the daily report sums today's runs per source and shares the summary unknown ratio", async () => {
  const seededAt = nowIso();
  await seed(
    job({ job_key: "today-1", company_name: "百度", skills: ["python"], fetched_at: seededAt }),
    job({ job_key: "today-2", company_name: "腾讯", skills: [], fetched_at: seededAt }),
    job({ job_key: "past-1", company_name: "美团", skills: [], fetched_at: new Date(Date.now() - 3 * DAY_MS).toISOString() }),
  );
  await writePolicyBatch(sql, {
    source_key: "policy-test",
    fetched_at: seededAt,
    collector_version: "test-collector-1",
    data_origin: "live",
    policies: [
      {
        policy_item_id: "policy-1",
        source_key: "policy-test",
        source_tier: "government_official",
        title: "就业优先政策",
        issuer: "国家发展改革委",
        published_at: "2026-11-18",
        official_url: "https://www.ndrc.gov.cn/policy-1",
        theme_ids: ["employment_promotion"],
        evidence_excerpt: "政策摘录",
        content_hash: digest("policy-1"),
        collector_version: "test-collector-1",
        fetched_at: seededAt,
      },
    ],
  });

  const runKey = { kind: "jobs" as const, collector_version: "test-collector-1", data_origin: "live" as const };
  const earlier = new Date(Date.now() - 60_000).toISOString();
  const later = new Date(Date.now() - 30_000).toISOString();
  await finishRun(
    sql,
    { ...runKey, source_key: "baidu-official-careers", fetched_at: earlier },
    "ok",
    { job_count: 50, accepted: 30, updated: 1, duplicates: 19, rejected: 0 },
    null,
  );
  await finishRun(
    sql,
    { ...runKey, source_key: "baidu-official-careers", fetched_at: later },
    "partial",
    { job_count: 20, accepted: 0, updated: 0, duplicates: 20, rejected: 0 },
    "page 2 failed",
  );
  await finishRun(
    sql,
    { ...runKey, source_key: "tencent-official-careers", fetched_at: earlier },
    "failed",
    { job_count: 10, accepted: 0, updated: 0, duplicates: 0, rejected: 0 },
    "blocked",
  );
  await finishRun(
    sql,
    { ...runKey, source_key: "meituan-official-careers", fetched_at: new Date(Date.now() - 2 * DAY_MS).toISOString() },
    "ok",
    { job_count: 5, accepted: 0, updated: 0, duplicates: 5, rejected: 0 },
    null,
  );

  const daily = await loadCareerDaily(sql);
  const bySource = new Map(daily.sources.map((source) => [source.source_key, source]));

  assert.equal(daily.has_run, true);
  assert.deepEqual([...bySource.keys()], ["baidu-official-careers", "policy-test", "tencent-official-careers"]);
  assert.deepEqual(bySource.get("baidu-official-careers"), {
    source_key: "baidu-official-careers",
    collected: 70,
    accepted: 30,
    updated: 1,
    duplicates: 39,
    status: "partial",
  });
  assert.equal(bySource.get("tencent-official-careers")!.status, "failed");
  assert.equal(bySource.get("policy-test")!.accepted, 1);
  assert.equal(bySource.has("meituan-official-careers"), false, "runs from another day are excluded");

  assert.equal(daily.jobs_total, 3);
  assert.equal(daily.new_jobs_today, 2);
  assert.equal(daily.policies_total, 1);
  assert.equal(daily.new_policies_today, 1);

  const summary: SummaryResponseV1 = await repository.summary();
  const skillMetric = summary.metrics.find((entry) => entry.metric_id === "skill_demand_share")!;
  assert.equal(daily.unknown_ratio, 2 / 3);
  assert.equal(daily.unknown_ratio, skillMetric.unknown_ratio, "the same denominator as the summary");
  assert.equal(daily.sample_size, summary.sample_size);

  // 数据截止时间取最新一次观测：同一份数据下保持稳定，ETag 才能命中 304。
  assert.equal(daily.generated_at, seededAt);
  const again = await loadCareerDaily(sql);
  assert.equal(again.generated_at, daily.generated_at);
});

test("the daily route rejects query parameters and answers today", async () => {
  const app = Fastify();
  registerCareerHttp(app, repository);
  await app.ready();

  const rejected = await app.inject({ url: "/api/site/career-insights/daily?date=2026-11-01" });
  assert.equal(rejected.statusCode, 400);
  assert.equal(rejected.json().error.code, "invalid_parameter");

  const response = await app.inject({ url: "/api/site/career-insights/daily" });
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["cache-control"], "public, max-age=60, stale-while-revalidate=300");
  assert.equal(response.json().has_run, false);
  assert.equal(
    response.json().date,
    new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai" }).format(new Date()),
  );
  assert.equal(response.json().generated_at, EPOCH, "no data means the epoch cutoff");
  const notModified = await app.inject({
    url: "/api/site/career-insights/daily",
    headers: { "if-none-match": String(response.headers.etag) },
  });
  assert.equal(notModified.statusCode, 304, "a stable generated_at lets the ETag hit");
  await app.close();
});