// 就业日报归档：GET /api/site/career-insights/daily/history 按 Asia/Shanghai 自然日聚合
// 日评缓存 + 当日岗位/政策，倒序分页；参数校验、no-store 与「观测被清理后仍能列出」都在真库上验证。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, beforeEach, test } from "node:test";
import Fastify from "fastify";
import { closeDb, sql } from "@aihot/backend/db";
import type { NormalizedJobV1 } from "../contracts/index.ts";
import {
  CAREER_DAILY_HISTORY_PATH,
  MAX_COMMENT_SUMMARY_CHARS,
  loadCareerDailyHistory,
  registerCareerArchiveRoutes,
} from "../backend/routes/archive.ts";
import { ingestBatch } from "../backend/ingest.ts";
import { writePolicyBatch } from "../backend/policy-repository.ts";
import { SqlCareerRepository } from "../backend/sql-repository.ts";
import { NORMALIZER_VERSION } from "../data/normalize.ts";

const DAY_ONE = "2026-11-19";
const DAY_TWO = "2026-11-20";
const DAY_THREE = "2026-11-21";
const FETCHED_ONE = "2026-11-19T02:00:00.000Z";
const FETCHED_TWO = "2026-11-20T02:00:00.000Z";
const FETCHED_THREE = "2026-11-21T02:00:00.000Z";
const digest = (seed: string) => createHash("sha256").update(seed).digest("hex");

function job(jobKey: string, overrides: Partial<NormalizedJobV1> = {}): NormalizedJobV1 {
  return {
    schema_version: "1.0",
    normalizer_version: NORMALIZER_VERSION,
    source_key: "tencent-official-careers",
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
    fetched_at: FETCHED_ONE,
    collector_version: "test-collector-1",
    content_hash: digest(jobKey),
    raw_text: "岗位文本",
    raw_payload: { id: jobKey },
    ...overrides,
  };
}

const DAY_ONE_JOBS = [job("h1"), job("h2"), job("h3")];
const DAY_TWO_JOBS = [...DAY_ONE_JOBS, job("h4"), job("h5")];

async function seedJobs(fetchedAt: string, jobs: NormalizedJobV1[]): Promise<void> {
  await ingestBatch(sql, {
    schema_version: "1.0",
    source_key: "tencent-official-careers",
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

/** 三天数据：第一天 3 个岗位 + 1 条政策；第二天新增 2 个岗位 + 1 条政策；第三天只重新观测。 */
async function seedThreeDays(): Promise<void> {
  await seedJobs(FETCHED_ONE, DAY_ONE_JOBS);
  await seedPolicy(FETCHED_ONE, "t20261119_1", "关于做好高校毕业生就业工作的通知");
  await seedJobs(FETCHED_TWO, DAY_TWO_JOBS);
  await seedPolicy(FETCHED_TWO, "t20261120_1", "关于促进人工智能就业的通知");
  await seedJobs(FETCHED_THREE, DAY_TWO_JOBS);
}

/** 第二天的日评：样本与新增取自缓存（比当日观测聚合优先），评论远超 120 字，验证摘要截断。 */
const LONG_COMMENT = "数".repeat(300);

async function seedComments(): Promise<void> {
  await sql`
    INSERT INTO career_daily_comments (
      contract_version, comment_date, as_of, generated_at, sample_size, new_jobs, prompt_version,
      confidence, comment, facts, evidence, receipt_id, model
    ) VALUES (
      '0.1', ${DAY_TWO}::date, ${FETCHED_TWO}::timestamptz, ${FETCHED_TWO}::timestamptz, 7, 3, 'career-daily-comment/1',
      'medium', ${LONG_COMMENT}, '[]'::jsonb, '[]'::jsonb, NULL, NULL
    ), (
      '0.1', ${DAY_THREE}::date, ${FETCHED_THREE}::timestamptz, ${FETCHED_THREE}::timestamptz, 5, 0, 'career-daily-comment/1',
      'high', '今日无新增，样本与技能分布延续前一日。', '[]'::jsonb, '[]'::jsonb, NULL, NULL
    )`;
}

function appFor(): ReturnType<typeof Fastify> {
  const app = Fastify();
  registerCareerArchiveRoutes(app, new SqlCareerRepository(sql));
  return app;
}

beforeEach(async () => {
  await sql`TRUNCATE career_daily_comments, career_job_observations, career_jobs, career_policies, career_ingest_runs RESTART IDENTITY`;
});

after(async () => {
  await closeDb();
});

test("the archive lists every day with data, newest first, with its sample, new jobs/policies and comment", async () => {
  await seedThreeDays();
  await seedComments();

  const app = appFor();
  try {
    const response = await app.inject({ url: CAREER_DAILY_HISTORY_PATH });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers["cache-control"], "no-store");
    const body = response.json();
    assert.equal(body.contract_version, "0.1");
    assert.equal(body.data_origin, "live");
    assert.equal(body.page, 1);
    assert.equal(body.page_size, 20);
    assert.equal(body.total, 3);
    assert.deepEqual(
      body.entries.map((entry: { date: string }) => entry.date),
      [DAY_THREE, DAY_TWO, DAY_ONE],
      "newest day first",
    );

    const [third, second, first] = body.entries;
    assert.deepEqual(third, {
      date: DAY_THREE,
      sample_size: 5,
      new_jobs: 0,
      new_policies: 0,
      confidence: "high",
      comment_summary: "今日无新增，样本与技能分布延续前一日。",
    });
    assert.equal(second.sample_size, 7, "the comment's stored sample wins over the day's observations");
    assert.equal(second.new_jobs, 3);
    assert.equal(second.new_policies, 1);
    assert.equal(second.confidence, "medium");
    const summaryLength = [...second.comment_summary].length;
    assert.equal(summaryLength, MAX_COMMENT_SUMMARY_CHARS);
    assert.ok(second.comment_summary.endsWith("…"));
    assert.deepEqual(first, {
      date: DAY_ONE,
      sample_size: 3,
      new_jobs: 3,
      new_policies: 1,
      confidence: null,
      comment_summary: null,
    }, "a day whose comment was never generated still appears, with no confidence or summary");
  } finally {
    await app.close();
  }
});

test("page and page_size select a slice and keep the total of every day", async () => {
  await seedThreeDays();
  await seedComments();
  const app = appFor();
  try {
    const firstPage = (await app.inject({ url: `${CAREER_DAILY_HISTORY_PATH}?page=1&page_size=2` })).json();
    assert.equal(firstPage.total, 3);
    assert.equal(firstPage.page, 1);
    assert.equal(firstPage.page_size, 2);
    assert.deepEqual(firstPage.entries.map((entry: { date: string }) => entry.date), [DAY_THREE, DAY_TWO]);

    const secondPage = (await app.inject({ url: `${CAREER_DAILY_HISTORY_PATH}?page=2&page_size=2` })).json();
    assert.equal(secondPage.total, 3);
    assert.deepEqual(secondPage.entries.map((entry: { date: string }) => entry.date), [DAY_ONE]);

    const pastEnd = (await app.inject({ url: `${CAREER_DAILY_HISTORY_PATH}?page=3&page_size=2` })).json();
    assert.equal(pastEnd.total, 3, "a page past the end still reports the real total");
    assert.deepEqual(pastEnd.entries, []);
  } finally {
    await app.close();
  }
});

test("invalid parameters are 400 in the same style as the other career route", async () => {
  const app = appFor();
  try {
    for (const query of ["page=0", "page=-1", "page=abc", "page_size=0", "page_size=51", "page_size=1.5", "month=11"]) {
      const response = await app.inject({ url: `${CAREER_DAILY_HISTORY_PATH}?${query}` });
      assert.equal(response.statusCode, 400, query);
      const body = response.json();
      assert.equal(body.error.code, "invalid_parameter", query);
      assert.equal(body.error.details.parameter, query.split("=")[0], query);
    }
    const tooLarge = await app.inject({ url: `${CAREER_DAILY_HISTORY_PATH}?page_size=51` });
    assert.match(tooLarge.json().error.message, /between 1 and 50/);
  } finally {
    await app.close();
  }
});

test("an empty database answers an empty page instead of an error", async () => {
  const empty = await loadCareerDailyHistory(sql, { page: 1, page_size: 20 });
  assert.deepEqual(empty, {
    contract_version: "0.1",
    data_origin: "live",
    page: 1,
    page_size: 20,
    total: 0,
    entries: [],
  });
});

test("a day's sample counts distinct jobs even when one job leaves several observation rows", async () => {
  await seedJobs(FETCHED_ONE, [job("dup-1"), job("dup-2")]);
  // 同一岗位当天被改写：内容哈希不同会在同一天再留一条观测，观测行数因此多于岗位数。
  await seedJobs("2026-11-19T10:00:00.000Z", [
    { ...job("dup-1"), title: "算法工程师（更新）", raw_text: "岗位文本（更新）", content_hash: digest("dup-1-v2") },
  ]);

  const [observed] = await sql<{ observation_rows: number; distinct_jobs: number }[]>`
    SELECT COUNT(*)::int AS observation_rows, COUNT(DISTINCT job_id)::int AS distinct_jobs
    FROM career_job_observations
    WHERE (observed_at AT TIME ZONE 'Asia/Shanghai')::date = ${DAY_ONE}::date`;
  assert.deepEqual(observed, { observation_rows: 3, distinct_jobs: 2 }, "the fixture leaves three rows for two jobs");

  const history = await loadCareerDailyHistory(sql, { page: 1, page_size: 20 });
  const day = history.entries.find((entry) => entry.date === DAY_ONE);
  assert.ok(day !== undefined);
  assert.equal(day.sample_size, 2, "the archived sample is the distinct job count, not the observation row count");
  assert.equal(day.new_jobs, 2);
});

test("a day whose observations were cleaned up after 180 days still lists, from its first-seen counts", async () => {
  await seedThreeDays();
  await sql`DELETE FROM career_job_observations WHERE (observed_at AT TIME ZONE 'Asia/Shanghai')::date = ${DAY_ONE}::date`;

  const history = await loadCareerDailyHistory(sql, { page: 1, page_size: 20 });
  const day = history.entries.find((entry) => entry.date === DAY_ONE);
  assert.ok(day !== undefined, "the day still appears through career_jobs.first_seen_at");
  assert.equal(day.sample_size, 0, "no observations left for that day");
  assert.equal(day.new_jobs, 3, "first-seen jobs remain the day's count");
  assert.equal(day.new_policies, 1);
});
