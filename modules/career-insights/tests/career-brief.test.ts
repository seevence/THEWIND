// 离线研判：输入只含聚合指标，输出禁止输入外的数字，观测日不足两个时降为 low 并去掉走势断言；
// 缓存的 upsert 幂等与 /brief 路由（无缓存 204）用真库和假模型验证，不访问任何外部服务。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, beforeEach, test } from "node:test";
import Fastify from "fastify";
import { closeDb, sql } from "@aihot/backend/db";
import type { NormalizedJobV1 } from "../contracts/index.ts";
import type { CareerBriefV1 } from "../contracts/insights.ts";
import {
  CAREER_BRIEF_PROMPT_VERSION,
  CareerBriefValidationError,
  buildCareerBriefPrompt,
  composeCareerBrief,
  generateCareerBrief,
  loadCareerBrief,
  type CareerBriefInputV1,
  type CareerBriefLlmCaller,
} from "../backend/brief.ts";
import { registerCareerHttp } from "../backend/http.ts";
import { ingestBatch } from "../backend/ingest.ts";
import type { CareerRepository } from "../backend/repository.ts";
import { SKILL_ALIASES, SKILL_LABELS } from "../data/dictionaries.ts";
import { NORMALIZER_VERSION } from "../data/normalize.ts";

const JOB_ID = "11111111-1111-1111-1111-111111111111";
const digest = (seed: string) => createHash("sha256").update(seed).digest("hex");

function input(overrides: Partial<CareerBriefInputV1> = {}): CareerBriefInputV1 {
  return {
    as_of: "2026-11-20T00:00:00.000Z",
    window_days: 30,
    sample_size: 12,
    observation_days: 3,
    skills_sample_size: 12,
    directions: [],
    titles: [],
    skills: [],
    evidence_candidates: [{ kind: "job", id: JOB_ID, title: "算法工程师" }],
    ...overrides,
  };
}

function draft(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    facts: ["当前样本量为 12 个岗位"],
    inferences: ["观察窗 30 天内方向结构保持稳定"],
    actions: ["先补齐常用技能的项目经历"],
    limitations: ["只覆盖已采集的官方岗位"],
    confidence: "medium",
    evidence: [{ kind: "job", id: JOB_ID, title: "模型自己写的标题" }],
    ...overrides,
  };
}

function job(fetchedAt: string): NormalizedJobV1 {
  return {
    schema_version: "1.0",
    normalizer_version: NORMALIZER_VERSION,
    source_key: "iflytek-official-careers",
    job_key: "brief-job-1",
    company_name: "测试科技有限公司",
    title: "算法工程师",
    official_url: "https://careers.example/jobs/brief-job-1",
    role_family: "ai_algorithm",
    locations: ["北京"],
    degree: "bachelor",
    degree_raw: "本科",
    experience_min_years: 0,
    experience_max_years: 3,
    experience_raw: "1-3 年",
    employment_type: "experienced",
    student_friendly: "yes",
    skills: ["python", "大模型"],
    skill_evidence: [
      { skill_id: "python", evidence_text: "熟悉 python" },
      { skill_id: "大模型", evidence_text: "了解大模型" },
    ],
    published_at: null,
    fetched_at: fetchedAt,
    collector_version: "test-collector-1",
    content_hash: digest("brief-job-1"),
    raw_text: "岗位文本",
    raw_payload: { id: "brief-job-1" },
  };
}

async function seedDay(fetchedAt: string): Promise<void> {
  await ingestBatch(sql, {
    schema_version: "1.0",
    source_key: "iflytek-official-careers",
    fetched_at: fetchedAt,
    collector_version: "test-collector-1",
    jobs: [job(fetchedAt)],
  });
}

function fakeRepository(read: () => Promise<CareerBriefV1 | null>): CareerRepository {
  const notUsed = async (): Promise<never> => {
    throw new Error("not used");
  };
  return {
    summary: notUsed,
    listJobs: notUsed,
    jobDetail: notUsed,
    jobAvailability: notUsed,
    listPolicies: notUsed,
    hotCompanies: notUsed,
    dailySummary: notUsed,
    careerSignals: notUsed,
    careerCatalog: notUsed,
    careerBrief: read,
    careerDailyComment: notUsed,
    writeBatch: notUsed,
  };
}

async function build(repository: CareerRepository) {
  const app = Fastify();
  registerCareerHttp(app, repository);
  await app.ready();
  return app;
}

beforeEach(async () => {
  await sql`TRUNCATE career_briefs, career_job_observations, career_jobs, career_policies, career_ingest_runs RESTART IDENTITY`;
});

after(async () => {
  await closeDb();
});

test("the composed brief keeps the contract shape and rewrites evidence titles from the database", () => {
  const record = composeCareerBrief(input(), draft(), { generated_at: "2026-11-20T01:00:00.000Z" });

  assert.equal(record.contract_version, "0.1");
  assert.equal(record.as_of, "2026-11-20T00:00:00.000Z");
  assert.equal(record.sample_size, 12);
  assert.equal(record.window_days, 30);
  assert.equal(record.confidence, "medium");
  assert.deepEqual(record.evidence, [{ kind: "job", id: JOB_ID, title: "算法工程师" }]);
});

test("facts are cut to 60 characters and marked with an ellipsis", () => {
  const record = composeCareerBrief(input(), draft({ facts: ["数".repeat(80)] }), {
    generated_at: "2026-11-20T01:00:00.000Z",
  });

  assert.equal([...record.facts[0]!].length, 60);
  assert.ok(record.facts[0]!.endsWith("…"));
});

test("a truncated percentage fact still shows the percentage and an ellipsis", () => {
  const record = composeCareerBrief(
    shareInput(),
    draft({
      facts: ["data_analysis 占 12 个有技能岗位的 42.7%，" + "后续仍需更长观察窗确认走势".repeat(3)],
    }),
    { generated_at: "2026-11-20T01:00:00.000Z" },
  );

  assert.equal([...record.facts[0]!].length, 60);
  assert.ok(record.facts[0]!.endsWith("…"));
  assert.ok(record.facts[0]!.includes("42.7%"));
});

function shareInput(overrides: Partial<CareerBriefInputV1> = {}): CareerBriefInputV1 {
  return input({
    skills: [{ skill: "data_analysis", job_count: 42, share: 0.4266 }],
    ...overrides,
  });
}

test("a number absent from the aggregate input rejects the draft", () => {
  assert.throws(
    () => composeCareerBrief(input(), draft({ facts: ["本月新增 999 个岗位"] }), { generated_at: "2026-11-20T01:00:00.000Z" }),
    (error: unknown): boolean => error instanceof CareerBriefValidationError && error.message.includes("999"),
  );
});

test("a decimal share may be quoted as an equal, percentage or rounded value", () => {
  for (const fact of ["技能占比 42.7%", "技能占比 42.66%", "技能占比 0.43"]) {
    const record = composeCareerBrief(shareInput(), draft({ facts: [fact] }), {
      generated_at: "2026-11-20T01:00:00.000Z",
    });
    assert.equal(record.facts[0], fact);
  }
});

test("a long decimal share may be quoted at lower precision", () => {
  const record = composeCareerBrief(
    shareInput({ skills: [{ skill: "data_analysis", job_count: 61, share: 61 / 143 }] }),
    draft({ facts: ["data_analysis 占比 0.4266"] }),
    { generated_at: "2026-11-20T01:00:00.000Z" },
  );

  assert.equal(record.facts[0], "数据分析 占比 0.4266");
});

test("a percentage the input cannot support is rejected with its context", () => {
  assert.throws(
    () => composeCareerBrief(shareInput(), draft({ facts: ["技能占比 43%"] }), { generated_at: "2026-11-20T01:00:00.000Z" }),
    (error: unknown): boolean =>
      error instanceof CareerBriefValidationError && error.message.includes("43%") && error.message.includes("技能占比 43%"),
  );
});

test("sample sizes and the as_of date are quotable", () => {
  const record = composeCareerBrief(
    input({ sample_size: 188 }),
    draft({ facts: ["样本量 188 个岗位", "数据截止 2026 年 11 月"] }),
    { generated_at: "2026-11-20T01:00:00.000Z" },
  );

  assert.deepEqual(record.facts, ["样本量 188 个岗位", "数据截止 2026 年 11 月"]);
});

test("digits inside input strings are quotable: an evidence title may carry its job id", () => {
  const withJobId = input({
    evidence_candidates: [{ kind: "job", id: JOB_ID, title: "大客户服务经理 TAM（J107214）" }],
  });

  const record = composeCareerBrief(
    withJobId,
    draft({ facts: ["证据里的职位 J107214 是大客户服务经理"] }),
    { generated_at: "2026-11-20T01:00:00.000Z" },
  );
  assert.equal(record.facts[0], "证据里的职位 J107214 是大客户服务经理");

  assert.throws(
    () => composeCareerBrief(withJobId, draft({ facts: ["证据里的职位 999 不存在"] }), { generated_at: "2026-11-20T01:00:00.000Z" }),
    (error: unknown): boolean => error instanceof CareerBriefValidationError && error.message.includes("999"),
  );
});

test("digit runs in other input strings pass too, but numbers absent from the input still reject", () => {
  // skill_2024 的数字片段同时落在 as_of 年份白名单里；track_202445 只能靠字符串片段通过。
  const withSkillIds = input({
    skills: [
      { skill: "skill_2024", job_count: 42, share: 0.4266 },
      { skill: "track_202445", job_count: 7, share: 0.1 },
    ],
  });

  // 输出里只引用数字片段（不把内部 id 本身写进正文），片段来自输入字符串即可算是 grounded。
  const record = composeCareerBrief(
    withSkillIds,
    draft({ facts: ["输入编号 2024 与 202445 都可引用"] }),
    { generated_at: "2026-11-20T01:00:00.000Z" },
  );
  assert.equal(record.facts[0], "输入编号 2024 与 202445 都可引用");

  assert.throws(
    () => composeCareerBrief(withSkillIds, draft({ facts: ["输入编号 2024000 不在输入里"] }), { generated_at: "2026-11-20T01:00:00.000Z" }),
    (error: unknown): boolean => error instanceof CareerBriefValidationError && error.message.includes("2024000"),
  );
});

test("the string whitelist does not blanket-pass percentages", () => {
  const withJobId = input({
    skills: [{ skill: "data_analysis", job_count: 42, share: 0.4266 }],
    evidence_candidates: [{ kind: "job", id: JOB_ID, title: "大客户服务经理 TAM（J107214）" }],
  });

  assert.throws(
    () => composeCareerBrief(withJobId, draft({ facts: ["技能占比 43%"] }), { generated_at: "2026-11-20T01:00:00.000Z" }),
    (error: unknown): boolean =>
      error instanceof CareerBriefValidationError && error.message.includes("43%") && error.message.includes("技能占比 43%"),
  );
});

test("the prompt input uses Chinese display names and percentages instead of internal ids", () => {
  const promptInput = input({
    sample_size: 222,
    skills_sample_size: 166,
    directions: [
      {
        role_family: "ai_application_development",
        job_count: 42,
        company_count: 3,
        new_in_window: 42,
        student_friendly_count: 4,
        top_skills: [{ skill: "data_analysis", count: 22 }],
      },
    ],
    titles: [
      {
        title_key: "算法工程师",
        title_display: "算法工程师",
        job_count: 7,
        company_count: 2,
        cities: ["北京"],
        top_skills: [{ skill: "python", count: 5 }],
        student_friendly_count: 0,
        latest_published_at: null,
      },
    ],
    skills: [{ skill: "data_analysis", job_count: 72, share: 72 / 166 }],
  });

  const { user } = buildCareerBriefPrompt(promptInput);

  for (const internal of [
    "ai_application_development",
    "data_analysis",
    "role_family",
    "top_skills",
    "skills",
    "share",
    "title_key",
  ]) {
    assert.equal(user.includes(internal), false, internal);
  }
  assert.ok(user.includes("软件 / AI 应用开发"));
  assert.ok(user.includes("数据分析"));
  assert.ok(user.includes("43.4%"));
  assert.ok(user.includes("166"));
  assert.ok(user.includes("算法工程师"));
  assert.ok(user.includes("Python"));
  assert.ok(user.includes("可引用证据"));
});

test("the default prompt version is career-brief/3", () => {
  const record = composeCareerBrief(input(), draft(), { generated_at: "2026-11-20T01:00:00.000Z" });

  assert.equal(record.prompt_version, CAREER_BRIEF_PROMPT_VERSION);
  assert.equal(record.prompt_version, "career-brief/3");
});

test("the system prompt keeps the Chinese-only, Chinese-name and percentage constraints", () => {
  const { system } = buildCareerBriefPrompt(input());

  for (const constraint of [
    "正文（facts、inferences、actions、limitations 的文本）必须全部使用中文",
    "不得出现任何内部 ID、英文标识或英文字段名",
    "JSON 字段名（facts、inferences、actions、limitations、confidence、evidence）、枚举值（job/policy、low/medium/high）与证据编号（UUID）属于接口格式，不在此限",
    "引用职族或技能必须使用输入里的中文名称",
    "引用技能占比必须写成百分比并在同一处说明分母",
  ]) {
    assert.ok(system.includes(constraint), constraint);
  }
});

test("every skill alias maps to a skill with a display label", () => {
  const unlabeled = Object.values(SKILL_ALIASES).filter((skill) => !(skill in SKILL_LABELS));
  assert.deepEqual(unlabeled, []);
});

test("the composed brief replaces internal ids and snake_case field names in every text field", () => {
  const record = composeCareerBrief(
    shareInput({ skills_sample_size: 166 }),
    draft({
      facts: ["data_analysis 占比 42.7%，分母为 166 个有技能岗位"],
      inferences: ["ai_application_development 方向的 job_count 在观察窗内保持 0.4266"],
      actions: ["先补齐 data_analysis 与 python 的项目经历"],
      limitations: ["role_family 与 student_friendly 均为中文展示值"],
    }),
    { generated_at: "2026-11-20T01:00:00.000Z" },
  );

  assert.equal(record.facts[0], "数据分析 占比 42.7%，分母为 166 个有技能岗位");
  assert.equal(record.inferences[0], "软件 / AI 应用开发 方向的 岗位数 在观察窗内保持 0.4266");
  assert.equal(record.actions[0], "先补齐 数据分析 与 Python 的项目经历");
  assert.equal(record.limitations[0], "职族 与 学生友好 均为中文展示值");

  const serialized = JSON.stringify(record);
  for (const internal of ["data_analysis", "ai_application_development", "role_family", "student_friendly", "job_count"]) {
    assert.equal(serialized.includes(internal), false, internal);
  }
});

test("localization keeps ordinary English words intact and only replaces exact ids", () => {
  const record = composeCareerBrief(
    input(),
    draft({
      facts: ["Google、GitHub、email、metadata、database 都是普通英文词"],
      inferences: ["data 方向与 AI 算法方向都需要数据分析"],
    }),
    { generated_at: "2026-11-20T01:00:00.000Z" },
  );

  assert.equal(record.facts[0], "Google、GitHub、email、metadata、database 都是普通英文词");
  assert.equal(record.inferences[0], "数据 方向与 AI 算法方向都需要数据分析");
});

test("localization leaves hyphenated English words and confidence words alone", () => {
  const record = composeCareerBrief(
    input(),
    draft({ facts: ["high-paying 与 medium-sized 只是普通英文描述"] }),
    { generated_at: "2026-11-20T01:00:00.000Z" },
  );

  assert.equal(record.facts[0], "high-paying 与 medium-sized 只是普通英文描述");
});

test("an unknown snake_case identifier in the model output rejects the draft", () => {
  for (const [text, identifier] of [
    ["模型提到 rust_engineer 方向", "rust_engineer"],
    ["输入里没有 latest_published_at 字段", "latest_published_at"],
  ] as const) {
    assert.throws(
      () => composeCareerBrief(input(), draft({ limitations: [text] }), { generated_at: "2026-11-20T01:00:00.000Z" }),
      (error: unknown): boolean => error instanceof CareerBriefValidationError && error.message.includes(identifier),
    );
  }
});

test("the identifier fallback accepts job numbers, RAG, A/B and Go", () => {
  const withJobId = input({
    evidence_candidates: [{ kind: "job", id: JOB_ID, title: "大客户服务经理 TAM（J107214）" }],
  });

  const record = composeCareerBrief(
    withJobId,
    draft({ facts: ["J107214 岗位要求 RAG、A/B 测试与 Go 语言"] }),
    { generated_at: "2026-11-20T01:00:00.000Z" },
  );

  assert.equal(record.facts[0], "J107214 岗位要求 RAG、A/B 测试与 Go 语言");
});

test("evidence ids outside the input candidates are dropped silently", () => {
  const record = composeCareerBrief(
    input(),
    draft({
      evidence: [
        { kind: "job", id: "22222222-2222-2222-2222-222222222222", title: "编造的岗位" },
        { kind: "policy", id: JOB_ID, title: "编造的政策" },
      ],
    }),
    { generated_at: "2026-11-20T01:00:00.000Z" },
  );

  assert.deepEqual(record.evidence, []);
});

test("an unknown internal identifier from the model fails generation and writes nothing", async () => {
  await seedDay("2026-11-20T10:00:00.000Z");

  await assert.rejects(
    () =>
      generateCareerBrief(
        sql,
        async () => ({ draft: draft({ facts: ["岗位要求 rust_engineer 经验"] }) }),
        { limit: 6, window_days: 30, now: () => new Date("2026-11-20T12:00:00.000Z") },
      ),
    (error: unknown): boolean => error instanceof CareerBriefValidationError && error.message.includes("rust_engineer"),
  );

  const counts = await sql<{ count: number }[]>`SELECT COUNT(*)::int AS count FROM career_briefs`;
  assert.equal(counts[0]!.count, 0);
});

test("a single observation day forces low confidence and removes trend claims", () => {
  const record = composeCareerBrief(
    input({ observation_days: 1 }),
    draft({ confidence: "high", inferences: ["需求持续增长", "岗位覆盖三个方向"] }),
    { generated_at: "2026-11-20T01:00:00.000Z" },
  );

  assert.equal(record.confidence, "low");
  assert.equal(record.inferences.some((line) => line.includes("增长")), false);
  assert.equal(record.limitations.some((line) => line.includes("观测日不足")), true);
  assert.equal(record.inferences.some((line) => line.includes("观察窗") || line.includes("置信度")), true);
  assert.equal(record.inferences.some((line) => /low|medium|high/.test(line)), false);
  assert.equal(record.inferences.at(-1), "以上基于 30 天观察窗，置信度：低。");
});

test("stored briefs are read back in contract shape and upserted per (as_of, prompt_version)", async () => {
  await seedDay("2026-11-19T10:00:00.000Z");
  await seedDay("2026-11-20T10:00:00.000Z");

  const seen: CareerBriefInputV1[] = [];
  const callLlm: CareerBriefLlmCaller = async (modelInput) => {
    seen.push(modelInput);
    const candidate = modelInput.evidence_candidates[0]!;
    return {
      draft: draft({
        facts: ["当前样本量为 1 个岗位"],
        evidence: [{ kind: candidate.kind, id: candidate.id, title: "模型自己写的标题" }],
      }),
      receipt_id: 7,
      model: "fake-model",
    };
  };

  assert.equal(await loadCareerBrief(sql), null);

  const first = await generateCareerBrief(sql, callLlm, {
    limit: 6,
    window_days: 30,
    now: () => new Date("2026-11-20T12:00:00.000Z"),
  });
  assert.ok(first !== null);
  assert.equal(seen[0]!.sample_size, 1);
  assert.equal(seen[0]!.observation_days, 2);
  assert.equal(seen[0]!.skills_sample_size, 1);
  assert.equal(JSON.stringify(seen[0]).includes("测试科技有限公司"), false);

  await generateCareerBrief(sql, callLlm, {
    limit: 6,
    window_days: 30,
    now: () => new Date("2026-11-20T13:00:00.000Z"),
  });

  const counts = await sql<{ count: number }[]>`SELECT COUNT(*)::int AS count FROM career_briefs`;
  assert.equal(counts[0]!.count, 1);

  const loaded = await loadCareerBrief(sql);
  assert.ok(loaded !== null);
  assert.equal(loaded.generated_at, "2026-11-20T13:00:00.000Z");
  assert.deepEqual(loaded.evidence, [{ kind: "job", id: seen[0]!.evidence_candidates[0]!.id, title: "算法工程师" }]);
});

test("an empty catalog skips the model and writes nothing", async () => {
  let calls = 0;
  const record = await generateCareerBrief(
    sql,
    async () => {
      calls += 1;
      return { draft: draft() };
    },
    { limit: 6, window_days: 30 },
  );

  assert.equal(record, null);
  assert.equal(calls, 0);
  const counts = await sql<{ count: number }[]>`SELECT COUNT(*)::int AS count FROM career_briefs`;
  assert.equal(counts[0]!.count, 0);
});

test("the brief route answers 204 without a cache and 200 with a public cache when cached", async () => {
  const cached: CareerBriefV1 = {
    contract_version: "0.1",
    generated_at: "2026-11-20T01:00:00.000Z",
    as_of: "2026-11-20T00:00:00.000Z",
    sample_size: 12,
    window_days: 30,
    facts: ["当前样本量为 12 个岗位"],
    inferences: ["观察窗 30 天内方向结构保持稳定"],
    actions: ["先补齐常用技能的项目经历"],
    evidence: [{ kind: "job", id: JOB_ID, title: "算法工程师" }],
    limitations: ["只覆盖已采集的官方岗位"],
    confidence: "medium",
  };

  const emptyApp = await build(fakeRepository(async () => null));
  const empty = await emptyApp.inject({ method: "GET", url: "/api/site/career-insights/brief" });
  assert.equal(empty.statusCode, 204);
  assert.equal(empty.headers["cache-control"], "no-store");
  assert.equal(empty.body, "");
  await emptyApp.close();

  const cachedApp = await build(fakeRepository(async () => cached));
  const served = await cachedApp.inject({ method: "GET", url: "/api/site/career-insights/brief" });
  assert.equal(served.statusCode, 200);
  assert.equal(served.headers["cache-control"], "public, max-age=60, stale-while-revalidate=300");
  assert.deepEqual(served.json(), cached);
  await cachedApp.close();
});

test("the brief route rejects query parameters", async () => {
  const app = await build(fakeRepository(async () => null));
  const response = await app.inject({ method: "GET", url: "/api/site/career-insights/brief?window_days=7" });
  assert.equal(response.statusCode, 400);
  await app.close();
});