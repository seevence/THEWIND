// 每日采集后的 LLM 兜底：fake 模型 + 内存 store 守选行、双预算、写回白名单、幂等与失败隔离；
// cron 入口只守子进程参数与环境开关、失败安全。不启动真实子进程、不连库、不调真实模型
// （tests/standalone.ts 把 DATABASE_URL 指向不可达地址，任何误连都会立刻失败）。
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_BUDGET_PROMPT_TOKENS,
  DEFAULT_BUDGET_ROWS,
  emptyIncrementalLlmDetail,
  estimatePromptTokens,
  incrementalLlmArgs,
  isIncrementalCandidate,
  parseIncrementalLlmDetail,
  runIncrementalLlm,
  runIncrementalLlmCron,
  type IncrementalCandidateStore,
  type IncrementalJobRow,
  type LlmCaller,
  type LlmNormalizedFields,
} from "../backend/llm-incremental.ts";
import { careerNormalizationSpec, parseBackfillArgs } from "../../../scripts/backfill-incremental-llm.ts";
import { LLM_NORMALIZER_VERSION, NORMALIZER_VERSION } from "../data/normalize.ts";

/** 兜底回看 2 小时的窗口起点（UTC；Asia/Shanghai 04:40）；采集在 06:10 写入的行落在窗口内。 */
const WINDOW_START = new Date("2026-11-19T20:40:00.000Z");

interface JobRecord extends IncrementalJobRow {
  last_seen_at: string;
  content_hash: string;
  observations: number;
  created_at: string;
}

function job(overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    title: "机器学习平台工程师",
    raw_text: "负责机器学习平台开发，熟悉 Python 与 SQL，要求 1-3 年经验。",
    degree_raw: "本科",
    experience_raw: "1-3 年经验",
    skills: [],
    experience_min_years: null,
    experience_max_years: null,
    role_family: "unknown",
    student_friendly: "unknown",
    normalizer_version: NORMALIZER_VERSION,
    // 06:10 采集写入的 updated_at，落在兜底窗口内。
    updated_at: "2026-11-19T22:10:00.000Z",
    last_seen_at: "2026-11-01T00:00:00.000Z",
    content_hash: "a".repeat(64),
    observations: 12,
    created_at: "2026-10-01T00:00:00.000Z",
    ...overrides,
  };
}

class MemoryStore implements IncrementalCandidateStore {
  readonly jobs: JobRecord[];
  readonly updates: Array<{ id: string; fields: LlmNormalizedFields }> = [];

  constructor(jobs: readonly JobRecord[]) {
    this.jobs = jobs.map((item) => ({ ...item }));
  }

  async listCandidates(since: Date): Promise<IncrementalJobRow[]> {
    return this.jobs.filter((item) => isIncrementalCandidate(item, since)).map((item) => ({ ...item }));
  }

  async updateLlmFields(id: string, fields: LlmNormalizedFields): Promise<number> {
    const target = this.jobs.find((item) => item.id === id);
    if (target === undefined) return 0;
    if (target.normalizer_version === LLM_NORMALIZER_VERSION) return 0;
    this.updates.push({ id, fields });
    target.role_family = fields.role_family;
    target.student_friendly = fields.student_friendly;
    target.skills = fields.skills;
    target.experience_min_years = fields.experience_min_years;
    target.experience_max_years = fields.experience_max_years;
    target.normalizer_version = LLM_NORMALIZER_VERSION;
    target.updated_at = "2026-11-19T22:40:00.000Z";
    return 1;
  }
}

const validOutput = {
  role_family: "ai_algorithm",
  student_friendly: "yes",
  skills: ["python", "sql"],
  experience_min_years: 1,
  experience_max_years: 3,
};

function fakeLlm(
  outputs: readonly unknown[],
  options: { fail?: boolean } = {},
): { callLlm: LlmCaller; calls: () => number } {
  let calls = 0;
  let index = 0;
  const callLlm: LlmCaller = async () => {
    calls += 1;
    if (options.fail === true) throw new Error("network down");
    const data = outputs[Math.min(index, outputs.length - 1)];
    index += 1;
    return { data, usage: { prompt_tokens: 120, completion_tokens: 30 } };
  };
  return { callLlm, calls: () => calls };
}

function runWith(
  store: MemoryStore,
  llm: { callLlm: LlmCaller },
  overrides: Partial<Parameters<typeof runIncrementalLlm>[0]> = {},
) {
  return runIncrementalLlm({
    since: WINDOW_START,
    store,
    callLlm: llm.callLlm,
    spec: careerNormalizationSpec,
    apply: true,
    concurrency: 1,
    ...overrides,
  });
}

test("候选判定：未分类、窗口内、且不是已兜底版本的行才进入候选", () => {
  assert.equal(isIncrementalCandidate(job({ role_family: "unknown" }), WINDOW_START), true);
  assert.equal(
    isIncrementalCandidate(job({ role_family: "data", student_friendly: "unknown", skills: ["sql"] }), WINDOW_START),
    true,
    "学生友好度未知也算未分类",
  );
  assert.equal(isIncrementalCandidate(job({ role_family: "data", student_friendly: "yes", skills: [] }), WINDOW_START), true);
  assert.equal(
    isIncrementalCandidate(job({ role_family: "data", student_friendly: "yes", skills: ["sql"] }), WINDOW_START),
    false,
    "已分类行不进候选",
  );
  assert.equal(
    isIncrementalCandidate(job({ normalizer_version: LLM_NORMALIZER_VERSION }), WINDOW_START),
    false,
    "已兜底版本不重复付费",
  );
  assert.equal(
    isIncrementalCandidate(job({ updated_at: "2026-11-19T18:00:00.000Z" }), WINDOW_START),
    false,
    "窗口外更新的旧行不进候选",
  );
});

test("只调用窗口内更新且未分类的行：已分类行、旧行与已兜底行都不调用模型", async () => {
  const store = new MemoryStore([
    job({ id: "10000000-0000-0000-0000-000000000001", title: "机器学习平台工程师" }),
    job({
      id: "10000000-0000-0000-0000-000000000002",
      title: "数据分析师",
      role_family: "data",
      student_friendly: "yes",
      skills: ["sql"],
    }),
    job({ id: "10000000-0000-0000-0000-000000000003", title: "旧岗位", updated_at: "2026-11-19T18:00:00.000Z" }),
    job({
      id: "10000000-0000-0000-0000-000000000004",
      title: "已兜底岗位",
      normalizer_version: LLM_NORMALIZER_VERSION,
      updated_at: "2026-11-19T22:20:00.000Z",
    }),
  ]);
  const llm = fakeLlm([validOutput]);

  const detail = await runWith(store, llm);

  assert.equal(detail.candidates, 1);
  assert.equal(detail.called, 1);
  assert.equal(detail.changed, 1);
  assert.equal(detail.failed, 0);
  assert.equal(llm.calls(), 1);
  assert.deepEqual(store.updates.map((update) => update.id), ["10000000-0000-0000-0000-000000000001"]);
  assert.deepEqual(detail.usage, { prompt_tokens: 120, completion_tokens: 30 });
  assert.equal(store.jobs[1]!.normalizer_version, NORMALIZER_VERSION);
  assert.equal(store.jobs[2]!.normalizer_version, NORMALIZER_VERSION);
  assert.equal(store.jobs[3]!.normalizer_version, LLM_NORMALIZER_VERSION);
});

test("行数预算触顶即停止，记录触顶原因与跳过行数", async () => {
  const store = new MemoryStore(
    Array.from({ length: 5 }, (_, index) => job({ id: `20000000-0000-0000-0000-00000000000${index}` })),
  );
  const llm = fakeLlm([validOutput]);

  const detail = await runWith(store, llm, { maxRows: 2, maxPromptTokens: 1_000_000 });

  assert.equal(detail.candidates, 5);
  assert.equal(detail.called, 2);
  assert.equal(detail.budget.max_rows, 2);
  assert.equal(detail.budget.rows, 2);
  assert.equal(detail.stopped_by_budget, "max_rows");
  assert.equal(detail.skipped.rows, 3);
  assert.equal(detail.skipped.reason, "max_rows");
  assert.equal(llm.calls(), 2);
  assert.equal(store.updates.length, 2);
});

test("token 预算按 prompt 估算触发停止：放得下的行处理，下一行停下并记录", async () => {
  const rows = Array.from({ length: 5 }, (_, index) => job({ id: `30000000-0000-0000-0000-00000000000${index}` }));
  const perRow = estimatePromptTokens(careerNormalizationSpec.system, careerNormalizationSpec.user(rows[0]!));
  const store = new MemoryStore(rows);
  const llm = fakeLlm([validOutput]);

  const detail = await runWith(store, llm, { maxPromptTokens: perRow * 2 });

  assert.equal(detail.candidates, 5);
  assert.equal(detail.called, 2);
  assert.equal(detail.budget.max_prompt_tokens, perRow * 2);
  assert.equal(detail.budget.prompt_tokens_estimated, perRow * 2);
  assert.equal(detail.stopped_by_budget, "max_prompt_tokens");
  assert.equal(detail.skipped.rows, 3);
  assert.equal(detail.skipped.reason, "max_prompt_tokens");
  assert.equal(llm.calls(), 2);
});

test("token 预算装不下一行时一次模型调用都不发生", async () => {
  const rows = Array.from({ length: 3 }, (_, index) => job({ id: `40000000-0000-0000-0000-00000000000${index}` }));
  const perRow = estimatePromptTokens(careerNormalizationSpec.system, careerNormalizationSpec.user(rows[0]!));
  const store = new MemoryStore(rows);
  const llm = fakeLlm([validOutput]);

  const detail = await runWith(store, llm, { maxPromptTokens: perRow - 1 });

  assert.equal(detail.called, 0);
  assert.equal(detail.calls, 0);
  assert.equal(detail.stopped_by_budget, "max_prompt_tokens");
  assert.equal(detail.skipped.rows, 3);
  assert.equal(llm.calls(), 0);
  assert.equal(store.updates.length, 0);
});

test("写回只碰白名单字段：观测、last_seen_at、content_hash 前后不变", async () => {
  const store = new MemoryStore([job()]);
  const before = { ...store.jobs[0]! };
  const llm = fakeLlm([validOutput]);

  const detail = await runWith(store, llm);

  const after = store.jobs[0]!;
  assert.equal(detail.changed, 1);
  assert.deepEqual(Object.keys(store.updates[0]!.fields).sort(), [
    "experience_max_years",
    "experience_min_years",
    "role_family",
    "skills",
    "student_friendly",
  ]);
  assert.equal(after.role_family, "ai_algorithm");
  assert.equal(after.student_friendly, "yes");
  assert.deepEqual(after.skills, ["python", "sql"]);
  assert.equal(after.experience_min_years, 1);
  assert.equal(after.experience_max_years, 3);
  assert.equal(after.normalizer_version, LLM_NORMALIZER_VERSION);
  assert.equal(after.last_seen_at, before.last_seen_at);
  assert.equal(after.content_hash, before.content_hash);
  assert.equal(after.observations, before.observations);
  assert.equal(after.created_at, before.created_at);
});

test("二次运行 0 候选 0 调用（幂等）", async () => {
  const store = new MemoryStore([job()]);
  const llm = fakeLlm([validOutput]);

  const first = await runWith(store, llm);
  assert.equal(first.changed, 1);
  assert.equal(llm.calls(), 1);

  const second = await runWith(store, llm);
  assert.equal(second.candidates, 0);
  assert.equal(second.called, 0);
  assert.equal(second.changed, 0);
  assert.equal(second.calls, 0);
  assert.equal(llm.calls(), 1);
  assert.equal(store.updates.length, 1);
});

test("dry-run 只报告拟变更，不写库", async () => {
  const store = new MemoryStore([job()]);
  const llm = fakeLlm([validOutput]);

  const detail = await runWith(store, llm, { apply: false });

  assert.equal(detail.apply, false);
  assert.equal(detail.changed, 1);
  assert.equal(store.updates.length, 0);
  assert.equal(store.jobs[0]!.role_family, "unknown");
  assert.equal(detail.usage.prompt_tokens, 120);
});

test("模型失败两次后只记失败并继续，不抛异常、不写库", async () => {
  const store = new MemoryStore([
    job({ id: "50000000-0000-0000-0000-000000000001" }),
    job({ id: "50000000-0000-0000-0000-000000000002", title: "数据分析师" }),
  ]);
  const llm = fakeLlm([], { fail: true });

  const detail = await runWith(store, llm);

  assert.equal(detail.candidates, 2);
  assert.equal(detail.called, 2);
  assert.equal(detail.failed, 2);
  assert.equal(detail.calls, 4);
  assert.equal(detail.retries, 2);
  assert.equal(detail.usageMissingCalls, 4);
  assert.deepEqual(detail.usage, { prompt_tokens: 0, completion_tokens: 0 });
  assert.equal(store.updates.length, 0);
});

test("合并校验抛错（如 schema 非法）按行失败计入 failed，不写库", async () => {
  const store = new MemoryStore([job()]);
  const llm = fakeLlm([{ ...validOutput, role_family: "sales" }]);

  const detail = await runWith(store, llm);

  assert.equal(detail.failed, 1);
  assert.equal(detail.changed, 0);
  assert.equal(detail.calls, 2);
  assert.equal(detail.retries, 1);
  assert.equal(store.updates.length, 0);
  assert.equal(store.jobs[0]!.role_family, "unknown");
});

test("cron 入口以子进程显式打开模型调用，worker 全局开关不变，汇总原样进 detail", async () => {
  const previous = process.env.MODEL_CALLS_ENABLED;
  process.env.MODEL_CALLS_ENABLED = "false";
  try {
    const since = new Date("2026-11-19T19:40:00.000Z");
    const summary = {
      ...emptyIncrementalLlmDetail({ apply: true, since, maxRows: 7, maxPromptTokens: 900 }),
      candidates: 2,
      called: 2,
      changed: 1,
      unchanged: 1,
      failed: 1,
      calls: 3,
      usage: { prompt_tokens: 240, completion_tokens: 60 },
    };
    let seenArgs: readonly string[] = [];
    let seenEnv: NodeJS.ProcessEnv = {};

    const detail = await runIncrementalLlmCron({
      budgetRows: 7,
      budgetTokens: 900,
      sinceHours: 3,
      now: () => new Date("2026-11-19T22:40:00.000Z"),
      run: async (args, env) => {
        seenArgs = args;
        seenEnv = env;
        return { code: 0, stdout: `候选行: 2\n${JSON.stringify(summary)}\n`, stderr: "" };
      },
    });

    assert.deepEqual(seenArgs, ["--apply", "--budget-rows", "7", "--budget-tokens", "900", "--since-hours", "3"]);
    assert.equal(seenEnv.MODEL_CALLS_ENABLED, "true", "子进程显式启用模型调用");
    assert.equal(process.env.MODEL_CALLS_ENABLED, "false", "worker 自己的开关保持不变");
    assert.equal(detail.ok, true);
    assert.equal(detail.since, since.toISOString());
    assert.equal(detail.candidates, 2);
    assert.equal(detail.changed, 1);
    assert.equal(detail.failed, 1);
    assert.equal(detail.usage.prompt_tokens, 240);
    assert.equal(detail.exit_code, 0);
    assert.equal(typeof detail.duration_ms, "number");
  } finally {
    if (previous === undefined) delete process.env.MODEL_CALLS_ENABLED;
    else process.env.MODEL_CALLS_ENABLED = previous;
  }
});

test("cron 兜底：子进程失败不抛异常，结构化 detail 记录错误与跳过原因", async () => {
  const crashed = await runIncrementalLlmCron({
    run: async () => {
      throw new Error("spawn node ENOENT");
    },
  });
  assert.equal(crashed.ok, false);
  assert.equal(crashed.failed, 0);
  assert.equal(crashed.candidates, 0);
  assert.equal(crashed.skipped.reason, "cli_failed");
  assert.match(crashed.error ?? "", /ENOENT|启动失败/);

  const noSummary = await runIncrementalLlmCron({
    run: async () => ({ code: 2, stdout: "not json", stderr: "MODEL_CALLS_ENABLED 为 false" }),
  });
  assert.equal(noSummary.ok, false);
  assert.equal(noSummary.exit_code, 2);
  assert.equal(noSummary.skipped.reason, "cli_failed");
  assert.match(noSummary.error ?? "", /MODEL_CALLS_ENABLED/);
});

test("默认预算覆盖一天的批次：不少于 80 行 / 120000 prompt token", () => {
  assert.ok(DEFAULT_BUDGET_ROWS >= 80, `预算行数 ${DEFAULT_BUDGET_ROWS} 至少要盖住一天新增的 30-50 行批次`);
  assert.ok(DEFAULT_BUDGET_PROMPT_TOKENS >= 120_000, "token 预算按 chars/1.5 的保守估算要够 80 行");
});

test("CLI 默认 dry-run 与默认预算/窗口，显式参数覆盖；非法取值直接报错", () => {
  assert.deepEqual(parseBackfillArgs([]), { apply: false, budgetRows: 80, budgetTokens: 120_000, sinceHours: 2 });
  assert.deepEqual(
    parseBackfillArgs(["--apply", "--budget-rows", "12", "--budget-tokens", "3456", "--since-hours", "5"]),
    { apply: true, budgetRows: 12, budgetTokens: 3456, sinceHours: 5 },
  );
  assert.throws(() => parseBackfillArgs(["--budget-rows", "0"]), /正整数/);
  assert.throws(() => parseBackfillArgs(["--budget-tokens"]), /正整数/);
  assert.throws(() => parseBackfillArgs(["--since-hours", "2.5"]), /正整数/);
  assert.deepEqual(incrementalLlmArgs(), ["--apply", "--budget-rows", "80", "--budget-tokens", "120000", "--since-hours", "2"]);
  assert.deepEqual(incrementalLlmArgs({ apply: false }), ["--budget-rows", "80", "--budget-tokens", "120000", "--since-hours", "2"]);
});

test("汇总 JSON 取 stdout 最后一行的对象，日志行与坏行被跳过", () => {
  assert.equal(parseIncrementalLlmDetail(""), null);
  assert.equal(parseIncrementalLlmDetail("not json"), null);
  const detail = parseIncrementalLlmDetail('log line\n{"candidates":3,"called":2}\n');
  assert.equal(detail?.candidates, 3);
});
