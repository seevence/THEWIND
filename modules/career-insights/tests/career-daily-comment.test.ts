// 就业日报 AI 评论：生成链路只认输入里的数字（与研判共用白名单校验），按 (comment_date, prompt_version)
// upsert 缓存；页面只读缓存、无缓存返回 204。生成/校验/缓存/HTTP 都用真库与假模型验证，不访问外部服务。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, beforeEach, test } from "node:test";
import { beijingDate } from "@aihot/contracts/time";
import Fastify from "fastify";
import { closeDb, sql } from "@aihot/backend/db";
import type { NormalizedJobV1 } from "../contracts/index.ts";
import {
  CAREER_DAILY_COMMENT_PROMPT_VERSION,
  CareerCommentValidationError,
  composeCareerDailyComment,
  generateCareerDailyComment,
  loadCareerDailyComment,
  loadDailyCommentInput,
  saveCareerDailyComment,
  type CareerDailyCommentInputV1,
  type CareerDailyCommentLlmCaller,
} from "../backend/career-daily-comment.ts";
import { CareerBriefValidationError } from "../backend/brief.ts";
import { registerCareerHttp } from "../backend/http.ts";
import { ingestBatch } from "../backend/ingest.ts";
import { writePolicyBatch } from "../backend/policy-repository.ts";
import { SqlCareerRepository } from "../backend/sql-repository.ts";
import { NORMALIZER_VERSION } from "../data/normalize.ts";

const JOB_ID = "11111111-1111-1111-1111-111111111111";
const DAY_ONE = "2026-11-19";
const DAY_TWO = "2026-11-20";
const DAY_THREE = "2026-11-21";
const FETCHED_ONE = "2026-11-19T02:00:00.000Z";
const FETCHED_TWO = "2026-11-20T02:00:00.000Z";
const FETCHED_THREE = "2026-11-21T02:00:00.000Z";
const digest = (seed: string) => createHash("sha256").update(seed).digest("hex");

function input(overrides: Partial<CareerDailyCommentInputV1> = {}): CareerDailyCommentInputV1 {
  return {
    date: DAY_TWO,
    as_of: "2026-11-20T02:00:00.000Z",
    sample_size: 12,
    new_jobs: 3,
    observation_days: 2,
    directions: [{ role_family: "ai_algorithm", job_count: 8 }],
    titles: [{ title: "算法工程师", job_count: 4 }],
    skills: [{ skill: "python", job_count: 6, share: 0.5 }],
    new_policy_count: 1,
    new_policies: [{ title: "关于促进人工智能就业的通知", issuer: "国家发展和改革委员会" }],
    skills_sample_size: 12,
    unknown_direction_count: 0,
    evidence_candidates: [{ kind: "job", id: JOB_ID, title: "大客户服务经理 TAM（J107214）" }],
    facts: ["当日有观测的岗位：12 个"],
    ...overrides,
  };
}

function draft(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    comment: "今日有观测的岗位 12 个，其中 AI 算法方向 8 个，新增 3 个岗位，值得先补齐常用技能。",
    confidence: "medium",
    ...overrides,
  };
}

/** 真库两天数据的实际数字：6 个当日观测岗位、AI 算法方向 4 个、当日新增 2 个。 */
function dayTwoDraft(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    comment: "今日有观测的岗位 6 个，其中 AI 算法方向 4 个，新增 2 个岗位，值得先补齐 Python。",
    confidence: "medium",
    ...overrides,
  };
}

function job(overrides: Partial<NormalizedJobV1> = {}): NormalizedJobV1 {
  const jobKey = overrides.job_key ?? "comment-job-1";
  const skills = overrides.skills ?? ["python"];
  return {
    schema_version: "1.0",
    normalizer_version: NORMALIZER_VERSION,
    source_key: "career-daily-comment-test",
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
    student_friendly: "yes",
    skills,
    skill_evidence: skills.map((skill) => ({ skill_id: skill, evidence_text: `熟悉 ${skill}` })),
    published_at: null,
    fetched_at: FETCHED_ONE,
    collector_version: "test-collector-1",
    content_hash: digest(jobKey),
    raw_text: "岗位文本",
    raw_payload: { id: jobKey },
    ...overrides,
  };
}

async function seedJobs(fetchedAt: string, jobs: NormalizedJobV1[]): Promise<void> {
  await ingestBatch(sql, {
    schema_version: "1.0",
    source_key: "career-daily-comment-test",
    fetched_at: fetchedAt,
    collector_version: "test-collector-1",
    jobs: jobs.map((entry) => ({ ...entry, fetched_at: fetchedAt })),
  });
}

async function seedPolicy(fetchedAt: string, itemId: string, title: string): Promise<void> {
  await writePolicyBatch(sql, {
    source_key: "ndrc-policy",
    fetched_at: fetchedAt,
    collector_version: "test-collector-1",
    data_origin: "live",
    policies: [
      {
        policy_item_id: itemId,
        source_key: "ndrc-policy",
        source_tier: "government_official",
        title,
        issuer: "国家发展和改革委员会",
        published_at: "2026-11-18",
        official_url: `https://www.ndrc.gov.cn/xxgk/zcfb/tz/202611/${itemId}.html`,
        theme_ids: ["employment_promotion"],
        evidence_excerpt: "政策文本",
        content_hash: digest(itemId),
        collector_version: "test-collector-1",
        fetched_at: fetchedAt,
      },
    ],
  });
}

const DAY_ONE_JOBS = [
  job({ job_key: "j1", title: "算法工程师", skills: ["python", "大模型"] }),
  job({ job_key: "j2", company_name: "云图公司", title: "推荐算法工程师", skills: ["python"] }),
  job({ job_key: "j3", title: "数据工程师", role_family: "data", skills: ["sql"] }),
  job({ job_key: "j4", title: "机械设计工程师", role_family: "unknown", skills: [] }),
];

/** 第一天 4 个岗位；第二天重新观测它们，并新增 2 个（含 1 个政策）。 */
async function seedTwoDays(): Promise<void> {
  await seedJobs(FETCHED_ONE, DAY_ONE_JOBS);
  await seedPolicy(FETCHED_ONE, "t20261118_1400000", "关于做好高校毕业生就业工作的通知");
  await seedJobs(FETCHED_TWO, [
    ...DAY_ONE_JOBS,
    job({ job_key: "j5", title: "大模型算法工程师", skills: ["大模型", "python"] }),
    job({ job_key: "j6", company_name: "云图公司", title: "算法工程师", skills: ["python", "大模型"] }),
  ]);
  await seedPolicy(FETCHED_TWO, "t20261119_1400001", "关于促进人工智能就业的通知");
}

/** 第三天只重新观测，不新增岗位、不新增政策。 */
async function seedThirdDay(): Promise<void> {
  await seedJobs(FETCHED_THREE, [
    ...DAY_ONE_JOBS,
    job({ job_key: "j5", title: "大模型算法工程师", skills: ["大模型", "python"] }),
    job({ job_key: "j6", company_name: "云图公司", title: "算法工程师", skills: ["python", "大模型"] }),
  ]);
}

beforeEach(async () => {
  await sql`TRUNCATE career_daily_comments, career_briefs, career_job_observations, career_jobs, career_policies, career_ingest_runs RESTART IDENTITY`;
});

after(async () => {
  await closeDb();
});

test("the composed comment keeps the contract shape and the evidence titles from the input", () => {
  const record = composeCareerDailyComment(input(), draft(), { generated_at: "2026-11-20T03:00:00.000Z" });

  assert.equal(record.contract_version, "0.1");
  assert.equal(record.date, DAY_TWO);
  assert.equal(record.as_of, "2026-11-20T02:00:00.000Z");
  assert.equal(record.generated_at, "2026-11-20T03:00:00.000Z");
  assert.equal(record.sample_size, 12);
  assert.equal(record.new_jobs, 3);
  assert.equal(record.confidence, "medium");
  assert.deepEqual(record.evidence, [{ kind: "job", id: JOB_ID, title: "大客户服务经理 TAM（J107214）" }]);
  assert.equal(record.prompt_version, CAREER_DAILY_COMMENT_PROMPT_VERSION);
  assert.equal(record.receipt_id, null);
});

test("a number absent from the input rejects the comment", () => {
  assert.throws(
    () => composeCareerDailyComment(input(), draft({ comment: "今日新增 999 个岗位。" }), {
      generated_at: "2026-11-20T03:00:00.000Z",
    }),
    (error: unknown): boolean =>
      error instanceof CareerCommentValidationError &&
      error instanceof CareerBriefValidationError &&
      error.message.includes("999"),
  );
});

test("numbers from the input pass: sample size, new jobs, top counts, share and the data date", () => {
  const record = composeCareerDailyComment(
    input(),
    draft({ comment: "2026-11-20 当日有观测的岗位 12 个，AI 算法方向 8 个，新增 3 个；Python 占比 50%，观察 2 天。" }),
    { generated_at: "2026-11-20T03:00:00.000Z" },
  );

  assert.match(record.comment, /12 个/);
});

test("digit runs inside input strings are quotable, numbers outside the input still reject", () => {
  const withJobId = input();
  const pass = composeCareerDailyComment(withJobId, draft({ comment: "证据里的职位 J107214 属于算法方向。" }), {
    generated_at: "2026-11-20T03:00:00.000Z",
  });
  assert.equal(pass.comment, "证据里的职位 J107214 属于算法方向。");

  assert.throws(
    () => composeCareerDailyComment(withJobId, draft({ comment: "证据里的职位 J107215 不存在。" }), {
      generated_at: "2026-11-20T03:00:00.000Z",
    }),
    (error: unknown): boolean => error instanceof CareerCommentValidationError && error.message.includes("J107215"),
  );
});

test("the Asia/Shanghai comment date is quotable even when as_of is the previous UTC day", () => {
  // 2026-11-20T23:00Z 是 2026-11-21 07:00 CST：数据日期与 as_of 的日期片段都要放行。
  const record = composeCareerDailyComment(
    input({ date: DAY_THREE, as_of: "2026-11-20T23:00:00.000Z" }),
    draft({ comment: "2026-11-21 当日有观测的岗位 12 个。" }),
    { generated_at: "2026-11-21T00:00:00.000Z" },
  );
  assert.equal(record.date, DAY_THREE);
});

test("confidence and the 400 character limit are schema checks", () => {
  const broken = ["very-high", "", null];
  for (const confidence of broken) {
    assert.throws(
      () => composeCareerDailyComment(input(), { comment: "今日无新增。", confidence }, { generated_at: "2026-11-20T03:00:00.000Z" }),
      (error: unknown): boolean => error instanceof CareerCommentValidationError,
      String(confidence),
    );
  }

  const longest = "数".repeat(400);
  assert.equal([...composeCareerDailyComment(input(), draft({ comment: longest }), { generated_at: "2026-11-20T03:00:00.000Z" }).comment].length, 400);
  assert.throws(
    () => composeCareerDailyComment(input(), draft({ comment: "数".repeat(401) }), { generated_at: "2026-11-20T03:00:00.000Z" }),
    (error: unknown): boolean => error instanceof CareerCommentValidationError && error.message.includes("400"),
  );

  assert.throws(
    () => composeCareerDailyComment(input(), draft({ comment: "   " }), { generated_at: "2026-11-20T03:00:00.000Z" }),
    (error: unknown): boolean => error instanceof CareerCommentValidationError,
  );
  assert.throws(
    () => composeCareerDailyComment(input(), "not an object", { generated_at: "2026-11-20T03:00:00.000Z" }),
    (error: unknown): boolean => error instanceof CareerCommentValidationError,
  );
});

test("the daily input aggregates the Asia/Shanghai day: sample, new jobs, top directions/titles/skills and policies", async () => {
  await seedTwoDays();

  const day = await loadDailyCommentInput(sql, DAY_TWO);
  assert.equal(day.date, DAY_TWO);
  assert.equal(day.as_of, FETCHED_TWO);
  assert.equal(day.sample_size, 6, "当日有观测的 6 个岗位");
  assert.equal(day.new_jobs, 2, "当日首次观测到的 2 个岗位");
  assert.equal(day.observation_days, 2);
  assert.deepEqual(day.directions, [
    { role_family: "ai_algorithm", job_count: 4 },
    { role_family: "data", job_count: 1 },
  ]);
  assert.equal(day.titles[0]!.title, "算法工程师");
  assert.equal(day.titles[0]!.job_count, 2);
  assert.equal(day.titles.length, 3);
  assert.deepEqual(day.skills, [
    { skill: "python", job_count: 4, share: 4 / 5 },
    { skill: "大模型", job_count: 3, share: 3 / 5 },
    { skill: "sql", job_count: 1, share: 1 / 5 },
  ]);
  assert.equal(day.new_policy_count, 1);
  assert.deepEqual(day.new_policies.map((policy) => policy.title), ["关于促进人工智能就业的通知"]);
  assert.equal(day.evidence_candidates.filter((entry) => entry.kind === "job").length, 2);
  assert.equal(
    day.evidence_candidates.some((entry) => entry.kind === "policy" && entry.title === "关于促进人工智能就业的通知"),
    true,
  );
  assert.ok(day.facts.includes("当日有观测的岗位：6 个"), day.facts.join(" / "));
  assert.ok(day.facts.includes("当日首次观测到的新岗位：2 个"));
  assert.ok(day.facts.some((fact) => fact.includes("方向 Top3：AI 算法 4 个岗位；数据 1 个岗位")));
  assert.ok(day.facts.some((fact) => fact.includes("Python 4 个岗位（占比 80.0%）")));
  // 占比必须带分母、unknown 必须单列（路线图「口径披露」纪律）。
  assert.ok(day.facts.some((fact) => fact.includes("技能占比的分母：当日带技能岗位 5 个")), day.facts.join(" / "));
  assert.ok(day.facts.some((fact) => fact.includes("当日方向未归类（unknown）岗位 1 个")));
  assert.ok(day.facts.some((fact) => fact.includes("当日新增政策 1 条：关于促进人工智能就业的通知")));
  assert.equal(JSON.stringify(day).includes("测试科技有限公司"), false, "模型输入里没有公司名");
});

test("a day with no new jobs or policies says so in the facts", async () => {
  await seedTwoDays();
  await seedThirdDay();

  const day = await loadDailyCommentInput(sql, DAY_THREE);
  assert.equal(day.sample_size, 6);
  assert.equal(day.new_jobs, 0);
  assert.equal(day.new_policy_count, 0);
  assert.equal(day.observation_days, 3);
  assert.ok(day.facts.includes("当日无新增岗位"));
  assert.ok(day.facts.includes("当日无新增政策"));
  assert.deepEqual(day.evidence_candidates, []);
});

test("a generated comment is cached per (comment_date, prompt_version) and read back in contract shape", async () => {
  await seedTwoDays();
  assert.equal(await loadCareerDailyComment(sql, DAY_TWO), null);

  const seen: CareerDailyCommentInputV1[] = [];
  const callLlm: CareerDailyCommentLlmCaller = async (modelInput) => {
    seen.push(modelInput);
    return { draft: dayTwoDraft(), receipt_id: 7, model: "fake-model" };
  };

  const first = await generateCareerDailyComment(sql, callLlm, {
    date: DAY_TWO,
    now: () => new Date("2026-11-20T03:00:00.000Z"),
  });
  assert.ok(first !== null);
  assert.equal(first?.sample_size, 6);
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.sample_size, 6);
  assert.equal(JSON.stringify(seen[0]).includes("测试科技有限公司"), false, "模型输入里没有公司名");

  const loaded = await loadCareerDailyComment(sql, DAY_TWO);
  assert.ok(loaded !== null);
  assert.equal(loaded!.generated_at, "2026-11-20T03:00:00.000Z");
  assert.equal(loaded!.comment, dayTwoDraft().comment);
  assert.deepEqual(loaded!.evidence, first!.evidence);
  assert.equal(loaded!.facts.length, seen[0]!.facts.length);

  const stored = await sql<{ prompt_version: string; model: string; receipt_id: string | null }[]>`
    SELECT prompt_version, model, receipt_id::text AS receipt_id FROM career_daily_comments`;
  assert.equal(stored.length, 1);
  assert.equal(stored[0]!.prompt_version, CAREER_DAILY_COMMENT_PROMPT_VERSION);
  assert.equal(stored[0]!.model, "fake-model");
  assert.equal(stored[0]!.receipt_id, "7");

  // 同一天同一 prompt_version 再生成一次：更新同一行，不新增行。
  const second = await generateCareerDailyComment(
    sql,
    async () => ({ draft: draft({ comment: "今日有观测的岗位 6 个，AI 算法方向 4 个，建议先补齐 Python。" }), receipt_id: 8 }),
    { date: DAY_TWO, now: () => new Date("2026-11-20T04:00:00.000Z") },
  );
  assert.ok(second !== null);
  const counts = await sql<{ count: number }[]>`SELECT COUNT(*)::int AS count FROM career_daily_comments`;
  assert.equal(counts[0]!.count, 1, "同 date+prompt_version 的二次生成只更新，不新增行");
  const updated = await loadCareerDailyComment(sql, DAY_TWO);
  assert.equal(updated!.generated_at, "2026-11-20T04:00:00.000Z");
  assert.equal(updated!.comment, "今日有观测的岗位 6 个，AI 算法方向 4 个，建议先补齐 Python。");
});

test("dry_run validates and returns the record without writing the cache", async () => {
  await seedTwoDays();

  const record = await generateCareerDailyComment(sql, async () => ({ draft: dayTwoDraft() }), {
    date: DAY_TWO,
    dry_run: true,
  });

  assert.ok(record !== null);
  const counts = await sql<{ count: number }[]>`SELECT COUNT(*)::int AS count FROM career_daily_comments`;
  assert.equal(counts[0]!.count, 0);
  assert.equal(await loadCareerDailyComment(sql, DAY_TWO), null);
});

test("a day without observed jobs skips the model and writes nothing", async () => {
  await seedTwoDays();
  let calls = 0;

  const record = await generateCareerDailyComment(
    sql,
    async () => {
      calls += 1;
      return { draft: draft() };
    },
    { date: "2026-11-18" },
  );

  assert.equal(record, null);
  assert.equal(calls, 0);
  const counts = await sql<{ count: number }[]>`SELECT COUNT(*)::int AS count FROM career_daily_comments`;
  assert.equal(counts[0]!.count, 0);
});

test("a fabricated number from the model fails generation and leaves the cache empty", async () => {
  await seedTwoDays();

  await assert.rejects(
    generateCareerDailyComment(sql, async () => ({ draft: draft({ comment: "今日新增 999 个岗位。" }) }), {
      date: DAY_TWO,
    }),
    (error: unknown): boolean => error instanceof CareerCommentValidationError && error.message.includes("999"),
  );
  const counts = await sql<{ count: number }[]>`SELECT COUNT(*)::int AS count FROM career_daily_comments`;
  assert.equal(counts[0]!.count, 0);
});

test("the daily-comment route answers 204 without a cache and 200 with the stored cache", async () => {
  await seedTwoDays();
  await generateCareerDailyComment(sql, async () => ({ draft: dayTwoDraft() }), {
    date: DAY_TWO,
    now: () => new Date("2026-11-20T03:00:00.000Z"),
  });

  const app = Fastify();
  registerCareerHttp(app, new SqlCareerRepository(sql));
  await app.ready();

  const missing = await app.inject({ method: "GET", url: "/api/site/career-insights/daily-comment?date=" + DAY_ONE });
  assert.equal(missing.statusCode, 204);
  assert.equal(missing.headers["cache-control"], "no-store");
  assert.equal(missing.body, "");

  const served = await app.inject({ method: "GET", url: "/api/site/career-insights/daily-comment?date=" + DAY_TWO });
  assert.equal(served.statusCode, 200);
  assert.equal(served.headers["cache-control"], "public, max-age=60, stale-while-revalidate=300");
  const cached = await loadCareerDailyComment(sql, DAY_TWO);
  assert.deepEqual(served.json(), cached);
  await app.close();
});

test("the daily-comment route defaults to today in Asia/Shanghai", async () => {
  const today = beijingDate(new Date());
  const record = composeCareerDailyComment(
    input({ date: today, as_of: new Date().toISOString() }),
    draft({ comment: "今日岗位结构稳定，建议先补齐常用技能。" }),
    { generated_at: new Date().toISOString() },
  );
  await saveCareerDailyComment(sql, record);

  const app = Fastify();
  registerCareerHttp(app, new SqlCareerRepository(sql));
  await app.ready();
  const response = await app.inject({ method: "GET", url: "/api/site/career-insights/daily-comment" });
  await app.close();

  assert.equal(response.statusCode, 200);
  assert.equal(response.json().date, today);
});

test("the daily-comment route rejects an invalid or unsupported date", async () => {
  const app = Fastify();
  registerCareerHttp(app, new SqlCareerRepository(sql));
  await app.ready();

  for (const query of [
    "date=2026-13-01",
    "date=2026-02-30",
    "date=2026-1-1",
    "date=abc",
    "date=",
    "window_days=7",
    "date=2026-11-20&date=2026-11-21",
  ]) {
    const response = await app.inject({ method: "GET", url: "/api/site/career-insights/daily-comment?" + query });
    assert.equal(response.statusCode, 400, query);
    assert.equal(response.json().error.code, "invalid_parameter", query);
    assert.equal(response.headers["cache-control"], "no-store", query);
  }
  await app.close();
});
