// The signals endpoint derives explainable anomalies from career_jobs: these tests seed real jobs
// through ingest, shift their first_seen_at to build history, then assert each rule's evidence and
// the route's parameter bounds. No model or heuristics outside the documented rules are involved.
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import Fastify from "fastify";
import { closeDb, sql } from "@aihot/backend/db";
import type { NormalizedJobV1 } from "../contracts/index.ts";
import { loadCareerSignals } from "../backend/career-signals.ts";
import { registerCareerHttp } from "../backend/http.ts";
import { ingestBatch } from "../backend/ingest.ts";
import { SqlCareerRepository } from "../backend/sql-repository.ts";
import { NORMALIZER_VERSION } from "../data/normalize.ts";

const repository = new SqlCareerRepository(sql);
const digest = (seed: string) => createHash("sha256").update(seed).digest("hex");
const nowIso = () => new Date().toISOString();

function job(overrides: Partial<NormalizedJobV1> = {}): NormalizedJobV1 {
  const jobKey = overrides.job_key ?? "job-1";
  const skills = overrides.skills ?? ["python"];
  return {
    schema_version: "1.0",
    normalizer_version: NORMALIZER_VERSION,
    source_key: "career-signals-test",
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
    student_friendly: "no",
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
    source_key: "career-signals-test",
    fetched_at: jobs[0]!.fetched_at,
    collector_version: "test-collector-1",
    jobs,
  });
}

async function ageJob(jobKey: string, days: number): Promise<void> {
  await sql`UPDATE career_jobs SET first_seen_at = now() - make_interval(days => ${days}::int) WHERE job_key = ${jobKey}`;
}

beforeEach(async () => {
  await sql`TRUNCATE career_job_observations, career_jobs, career_policies, career_ingest_runs RESTART IDENTITY`;
});

after(async () => {
  await closeDb();
});

test("an AI-heavy company with a mechanical job is reported as cross_industry with the hit term", async () => {
  await seed(
    job({ job_key: "deepseek-1", company_name: "深智公司", title: "算法工程师", role_family: "ai_algorithm" }),
    job({ job_key: "deepseek-2", company_name: "深智公司", title: "大模型算法工程师", role_family: "ai_algorithm" }),
    job({ job_key: "deepseek-3", company_name: "深智公司", title: "推荐算法专家", role_family: "ai_algorithm" }),
    job({ job_key: "deepseek-4", company_name: "深智公司", title: "数据工程师", role_family: "data" }),
    job({
      job_key: "deepseek-5",
      company_name: "深智公司",
      title: "机械设计工程师",
      role_family: "unknown",
      skills: ["mechanical_design", "cad"],
    }),
  );

  const result = await loadCareerSignals(sql, { limit: 10, window_days: 30 });
  const signal = result.signals.find((entry) => entry.rule === "cross_industry");

  assert.ok(signal, "the mechanical job triggers cross_industry");
  assert.equal(signal.company, "深智公司");
  assert.equal(signal.job_title, "机械设计工程师");
  assert.equal(signal.confidence, "high");
  assert.equal(signal.evidence.company_job_count, 5);
  assert.equal(signal.evidence.ai_family_job_count, 4);
  assert.equal(signal.evidence.ai_family_ratio, 0.8);
  assert.ok(signal.evidence.matched_terms?.includes("机械"), "evidence names the hit term");
  assert.match(signal.reason_text, /机械/, "the reason explains the hit term");
  assert.match(signal.reason_text, /5 个岗位中 4 个为算法\/AI 族/);
  assert.ok(signal.source_key.length > 0);
  assert.ok(signal.official_url.startsWith("https://"));
});

test("a company that gains a role family it never had inside the window reports new_family", async () => {
  await seed(
    job({ job_key: "new-family-1", company_name: "新族公司", title: "算法工程师", role_family: "ai_algorithm" }),
    job({ job_key: "new-family-2", company_name: "新族公司", title: "数据工程师", role_family: "data" }),
    job({ job_key: "new-family-3", company_name: "新族公司", title: "数据分析师", role_family: "data" }),
  );
  await ageJob("new-family-1", 60);

  const result = await loadCareerSignals(sql, { limit: 10, window_days: 30 });
  const familySignals = result.signals.filter((entry) => entry.rule === "new_family");

  assert.deepEqual(familySignals.map((entry) => entry.evidence.role_family), ["data"]);
  assert.equal(familySignals[0]!.evidence.family_job_count, 2);
  assert.equal(familySignals[0]!.evidence.window_days, 30);
  assert.equal(familySignals[0]!.confidence, "high");
  assert.match(familySignals[0]!.reason_text, /首次出现「数据」职族/);
  assert.match(familySignals[0]!.reason_text, /此前无该族招聘记录/, "a fully covered window keeps the original wording");
  assert.ok((familySignals[0]!.evidence.data_coverage_days ?? 0) >= 30, "the fixture covers the whole window");
});

test("new_family downgrades to low and drops the first-time claim when the data covers less than the window", async () => {
  // 数据只覆盖 3 天：窗口内最早也只能说明「本站观察到」，不能断言近 30 天首次。
  await seed(
    job({ job_key: "short-1", company_name: "短片公司", title: "算法工程师", role_family: "ai_algorithm" }),
    job({ job_key: "short-2", company_name: "短片公司", title: "数据工程师", role_family: "data" }),
    job({ job_key: "short-3", company_name: "短片公司", title: "数据分析师", role_family: "data" }),
  );
  await ageJob("short-1", 3);

  const result = await loadCareerSignals(sql, { limit: 10, window_days: 30 });
  const familySignals = result.signals.filter((entry) => entry.rule === "new_family");

  assert.ok(familySignals.length >= 2, "both families are still reported, just with weaker wording");
  for (const signal of familySignals) {
    assert.equal(signal.confidence, "low", "insufficient coverage can never be high confidence");
    assert.match(signal.reason_text, /^本站自 \d{4}-\d{2}-\d{2} 起观察到该公司首次出现/);
    assert.match(signal.reason_text, /不足 30 天/);
    assert.match(signal.reason_text, /不代表近 30 天首次/);
    assert.doesNotMatch(signal.reason_text, /此前无该族招聘记录/, "no universal claim without 30 days of history");
    assert.ok(typeof signal.evidence.data_coverage_days === "number");
    assert.ok(signal.evidence.data_coverage_days! < 30);
  }
});

test("a company with less than two days of history is skipped as insufficient_history", async () => {
  await seed(
    job({ job_key: "young-1", company_name: "今日新公司", title: "算法工程师" }),
    job({ job_key: "young-2", company_name: "今日新公司", title: "算法工程师" }),
    job({ job_key: "young-3", company_name: "今日新公司", title: "算法工程师" }),
    job({ job_key: "young-4", company_name: "今日新公司", title: "算法工程师" }),
    job({ job_key: "young-5", company_name: "今日新公司", title: "算法工程师" }),
  );

  const result = await loadCareerSignals(sql, { limit: 10, window_days: 30 });

  assert.equal(result.signals.some((entry) => entry.rule === "surge"), false, "surge is not guessed");
  assert.deepEqual(
    result.skipped.map((entry) => [entry.company, entry.rule, entry.reason]),
    [["今日新公司", "surge", "insufficient_history"]],
  );
  assert.ok(result.skipped[0]!.history_days < 2);
});

test("a company whose 24h intake is five-plus and three times its daily average reports surge", async () => {
  await seed(
    job({ job_key: "surge-old-1", company_name: "突增公司" }),
    job({ job_key: "surge-old-2", company_name: "突增公司" }),
    job({ job_key: "surge-old-3", company_name: "突增公司" }),
    job({ job_key: "surge-old-4", company_name: "突增公司" }),
    job({ job_key: "surge-new-1", company_name: "突增公司" }),
    job({ job_key: "surge-new-2", company_name: "突增公司" }),
    job({ job_key: "surge-new-3", company_name: "突增公司" }),
    job({ job_key: "surge-new-4", company_name: "突增公司" }),
    job({ job_key: "surge-new-5", company_name: "突增公司" }),
    job({ job_key: "surge-new-6", company_name: "突增公司" }),
  );
  for (const key of ["surge-old-1", "surge-old-2", "surge-old-3", "surge-old-4"]) {
    await ageJob(key, 10);
  }

  const result = await loadCareerSignals(sql, { limit: 10, window_days: 30 });
  const signal = result.signals.find((entry) => entry.rule === "surge" && entry.company === "突增公司");

  assert.ok(signal, "6 new jobs against a ~0.44/day baseline is a surge");
  assert.equal(signal.evidence.last_24h_jobs, 6);
  assert.equal(signal.evidence.history_daily_average, 0.44);
  assert.ok(typeof signal.evidence.history_days === "number" && signal.evidence.history_days >= 2);
  assert.ok(typeof signal.evidence.surge_ratio === "number" && signal.evidence.surge_ratio >= 3);
  assert.match(signal.reason_text, /最近 24 小时新增 6 个岗位/);
});

test("an algorithm-titled job requiring mechanical skills reports skill_mismatch", async () => {
  await seed(
    job({
      job_key: "mismatch-1",
      company_name: "错配公司",
      title: "大模型算法工程师",
      role_family: "ai_algorithm",
      skills: ["机械设计", "python"],
    }),
  );

  const result = await loadCareerSignals(sql, { limit: 10, window_days: 30 });
  const signal = result.signals.find((entry) => entry.rule === "skill_mismatch");

  assert.ok(signal, "algorithm title plus mechanical skill is a mismatch");
  assert.equal(signal.job_title, "大模型算法工程师");
  assert.ok(signal.evidence.matched_title_terms?.includes("大模型"));
  assert.ok(signal.evidence.matched_skill_terms?.includes("机械"));
  assert.match(signal.reason_text, /疑似跨界错配/);
});

test("the signals route enforces limit bounds, a public cache, and answers an empty table with empty lists", async () => {
  const app = Fastify();
  registerCareerHttp(app, repository);
  await app.ready();

  for (const query of ["limit=0", "limit=51", "limit=abc", "window_days=0", "window_days=366", "sort=surge"]) {
    const response = await app.inject({ url: `/api/site/career-insights/signals?${query}` });
    assert.equal(response.statusCode, 400, query);
    assert.equal(response.json().error.code, "invalid_parameter", query);
  }

  const empty = await app.inject({ url: "/api/site/career-insights/signals" });
  assert.equal(empty.statusCode, 200);
  assert.equal(empty.headers["cache-control"], "public, max-age=60, stale-while-revalidate=300");
  assert.deepEqual(empty.json().signals, []);
  assert.deepEqual(empty.json().skipped, []);
  assert.equal(empty.json().window_days, 30);
  assert.equal(empty.json().generated_at, "1970-01-01T00:00:00.000Z", "no data means the epoch cutoff, not the request time");
  const notModified = await app.inject({
    url: "/api/site/career-insights/signals",
    headers: { "if-none-match": String(empty.headers.etag) },
  });
  assert.equal(notModified.statusCode, 304, "a stable generated_at lets the ETag hit");
  await app.close();
});

test("signals report a stable data cutoff, so the public ETag answers 304", async () => {
  const fetchedAt = nowIso();
  await seed(
    job({ job_key: "cutoff-1", company_name: "稳定公司", fetched_at: fetchedAt }),
    job({ job_key: "cutoff-2", company_name: "稳定公司", title: "数据工程师", role_family: "data", fetched_at: fetchedAt }),
  );

  const first = await loadCareerSignals(sql, { limit: 10, window_days: 30 });
  const second = await loadCareerSignals(sql, { limit: 10, window_days: 30 });
  assert.equal(first.generated_at, fetchedAt, "generated_at is the latest observation, not the request time");
  assert.equal(second.generated_at, first.generated_at);

  const app = Fastify();
  registerCareerHttp(app, repository);
  await app.ready();
  try {
    const response = await app.inject({ url: "/api/site/career-insights/signals" });
    assert.equal(response.statusCode, 200);
    const notModified = await app.inject({
      url: "/api/site/career-insights/signals",
      headers: { "if-none-match": String(response.headers.etag) },
    });
    assert.equal(notModified.statusCode, 304);
    assert.equal(notModified.body, "");
  } finally {
    await app.close();
  }
});

test("limit caps the returned signals", async () => {
  await seed(
    job({ job_key: "cap-1", company_name: "截断公司", title: "算法工程师", role_family: "ai_algorithm" }),
    job({ job_key: "cap-2", company_name: "截断公司", title: "机械设计工程师", role_family: "unknown", skills: ["mechanical_design"] }),
    job({ job_key: "cap-3", company_name: "截断公司", title: "数据工程师", role_family: "data" }),
  );

  const all = await loadCareerSignals(sql, { limit: 50, window_days: 30 });
  const capped = await loadCareerSignals(sql, { limit: 1, window_days: 30 });

  assert.ok(all.signals.length >= 2);
  assert.equal(capped.signals.length, 1);
  assert.deepEqual(capped.signals, all.signals.slice(0, 1), "limit keeps the ranked order");
});