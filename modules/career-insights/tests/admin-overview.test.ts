// 后台就业数据视图的聚合层：六段（采集运行、来源健康、LLM 兜底、研判、评论、数据规模）并行读，
// 单段查询抛错只降级该段（页面显示「数据暂不可用」），其余段照常；这里用 fake repository 覆盖聚合
// 与失败降级，不碰真库。
import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  CareerAdminBrief,
  CareerAdminComment,
  CareerAdminIngestRun,
  CareerAdminJobRun,
  CareerAdminOverview,
  CareerAdminScale,
  CareerAdminSection,
  CareerAdminSourceHealth,
} from "../contracts/admin.ts";
import { buildCareerAdminOverview, type CareerAdminRepository } from "../backend/admin-overview.ts";

const NOW = new Date("2026-11-21T06:10:00.000Z");

const ingestRun: CareerAdminIngestRun = {
  id: "run-1",
  kind: "jobs",
  source_key: "tencent-official-careers",
  source_label: "腾讯官方招聘",
  status: "ok",
  fetched_at: "2026-11-21T06:10:30.000Z",
  job_count: 10,
  accepted: 3,
  updated: 5,
  duplicates: 2,
  rejected: 0,
  error: null,
};

const sourceHealth: CareerAdminSourceHealth = {
  source_key: "tencent-official-careers",
  source_label: "腾讯官方招聘",
  kind: "jobs",
  last_status: "ok",
  last_fetched_at: "2026-11-21T06:10:30.000Z",
  last_accepted: 3,
  last_error: null,
  last_ok_at: "2026-11-21T06:10:30.000Z",
  last_ok_accepted: 3,
  failed_runs: 0,
};

const jobRun: CareerAdminJobRun = {
  job: "career.ingest",
  status: "ok",
  started_at: "2026-11-21T06:10:00.000Z",
  finished_at: "2026-11-21T06:14:00.000Z",
  error: null,
  llm: {
    ok: true,
    candidates: 12,
    called: 12,
    changed: 9,
    failed: 0,
    calls: 12,
    retries: 0,
    usage: { prompt_tokens: 1200, completion_tokens: 300 },
    budget: { max_rows: 80, max_prompt_tokens: 120000, rows: 12, prompt_tokens_estimated: 1200 },
    stopped_by_budget: null,
    skipped: { rows: 0, reason: null },
    duration_ms: 90000,
    exit_code: 0,
    error: null,
  },
  brief: {
    ok: true,
    skipped: false,
    reason: null,
    as_of: "2026-11-21T01:29:00.000Z",
    sample_size: 222,
    observation_days: 3,
    confidence: "medium",
    receipt_id: 331,
    model: "deepseek-flash",
    duration_ms: 12000,
    exit_code: 0,
    error: null,
  },
  comment: {
    ok: true,
    skipped: false,
    reason: null,
    date: "2026-11-21",
    as_of: "2026-11-21T02:00:00.000Z",
    sample_size: 60,
    new_jobs: 34,
    confidence: "medium",
    receipt_id: 334,
    model: "deepseek-flash",
    duration_ms: 8000,
    exit_code: 0,
    error: null,
  },
};

const brief: CareerAdminBrief = {
  prompt_version: "career-brief/2",
  as_of: "2026-11-21T01:29:00.000Z",
  generated_at: "2026-11-21T01:29:00.000Z",
  confidence: "medium",
  sample_size: 222,
  window_days: 30,
  observation_days: 3,
  receipt_id: 331,
  model: "deepseek-flash",
};

const comment: CareerAdminComment = {
  prompt_version: "career-daily-comment/2",
  date: "2026-11-21",
  as_of: "2026-11-21T02:00:00.000Z",
  generated_at: "2026-11-21T02:00:00.000Z",
  confidence: "medium",
  sample_size: 60,
  new_jobs: 34,
  receipt_id: 334,
  model: "deepseek-flash",
};

const scale: CareerAdminScale = {
  jobs: 188,
  observations: 440,
  policies: 6,
  briefs: 1,
  comments: 1,
  observed_days: 3,
  latest_observation_at: "2026-11-21T01:00:00.000Z",
  latest_job_seen_at: "2026-11-21T01:00:00.000Z",
  latest_policy_seen_at: "2026-11-20T08:00:00.000Z",
  latest_policy_published_at: "2026-11-19",
};

function repository(overrides: Partial<CareerAdminRepository> = {}): CareerAdminRepository {
  return {
    ingestRuns: async () => [ingestRun],
    sourceHealth: async () => [sourceHealth],
    latestJobRun: async () => jobRun,
    recentBriefs: async () => [brief],
    recentComments: async () => [comment],
    scale: async () => scale,
    ...overrides,
  };
}

function ok<T>(section: CareerAdminSection<T>): T {
  if (!section.ok) throw new Error("section read failed: " + section.error);
  return section.data;
}

test("六段聚合：每段返回各自的数据，快照时间可注入", async () => {
  const overview: CareerAdminOverview = await buildCareerAdminOverview(repository(), { now: () => NOW });
  assert.equal(overview.generated_at, NOW.toISOString());
  assert.deepEqual(ok(overview.ingest).runs, [ingestRun]);
  assert.deepEqual(ok(overview.sources), [sourceHealth]);
  assert.equal(ok(overview.llm)?.job, "career.ingest");
  assert.equal(ok(overview.llm)?.llm?.candidates, 12);
  assert.equal(ok(overview.llm)?.brief?.receipt_id, 331);
  assert.deepEqual(ok(overview.briefs), [brief]);
  assert.deepEqual(ok(overview.comments), [comment]);
  assert.deepEqual(ok(overview.scale), scale);
});

test("空库：列表为空数组、没有 job_runs 时 llm 段 ok 且 data 为 null", async () => {
  const overview = await buildCareerAdminOverview(
    repository({
      ingestRuns: async () => [],
      sourceHealth: async () => [],
      latestJobRun: async () => null,
      recentBriefs: async () => [],
      recentComments: async () => [],
      scale: async () => ({ ...scale, jobs: 0, observations: 0, policies: 0, briefs: 0, comments: 0, observed_days: 0, latest_observation_at: null, latest_job_seen_at: null, latest_policy_seen_at: null, latest_policy_published_at: null }),
    }),
    { now: () => NOW },
  );
  assert.deepEqual(ok(overview.ingest).runs, []);
  assert.deepEqual(ok(overview.sources), []);
  assert.equal(ok(overview.llm), null);
  assert.equal(ok(overview.scale).jobs, 0);
  assert.equal(ok(overview.scale).latest_job_seen_at, null);
});

test("单段查询失败只降级该段，其余段照常返回", async () => {
  const overview = await buildCareerAdminOverview(
    repository({
      ingestRuns: async () => {
        throw new Error("relation career_ingest_runs does not exist");
      },
      recentComments: async () => {
        throw new Error("timeout");
      },
    }),
    { now: () => NOW },
  );
  assert.equal(overview.ingest.ok, false);
  assert.match(overview.ingest.ok === false ? overview.ingest.error : "", /career_ingest_runs/);
  assert.equal(overview.comments.ok, false);
  assert.equal(overview.sources.ok, true);
  assert.equal(overview.llm.ok, true);
  assert.equal(overview.briefs.ok, true);
  assert.equal(overview.scale.ok, true);
});

test("六段全部失败也返回完整快照，不抛错（页面整体可用、逐卡显示数据暂不可用）", async () => {
  const fail = async (): Promise<never> => {
    throw new Error("database unavailable");
  };
  const overview = await buildCareerAdminOverview(
    repository({ ingestRuns: fail, sourceHealth: fail, latestJobRun: fail, recentBriefs: fail, recentComments: fail, scale: fail }),
    { now: () => NOW },
  );
  for (const section of [overview.ingest, overview.sources, overview.llm, overview.briefs, overview.comments, overview.scale]) {
    assert.equal(section.ok, false);
  }
  assert.equal(overview.generated_at, NOW.toISOString());
});

test("错误摘要截断到 200 字符，不把长错误原样带进页面", async () => {
  const overview = await buildCareerAdminOverview(repository({
    ingestRuns: async () => {
      throw new Error("x".repeat(500));
    },
  }));
  assert.equal(overview.ingest.ok, false);
  assert.equal((overview.ingest.ok === false ? overview.ingest.error : "").length, 200);
});
