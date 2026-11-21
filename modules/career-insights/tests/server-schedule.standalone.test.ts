// 定时采集是趋势可积累的前提：这里守 server.ts 声明的 cron 形状，以及「采集 → LLM 兜底 → 就业研判 →
// 日报 AI 评论」四步在同一个 job 里串行的顺序与失败语义。pg-boss 的 missed: "once" 补跑会在 worker 启动时
// 把漏掉的槽位一起拉起来，所以四步必须在同一个 run 里串行（2026-11-21 实测：采集与兜底同刻启动，兜底
// 185ms 结束、0 候选，当天新增的 34 行 unknown 没有被兜底）。研判与评论都是后台预生成、页面只读缓存：
// 它们失败不能抹掉前两步。
//
// --json 契约（scripts/build-career-brief.ts、scripts/build-career-daily-comment.ts）用一次真子进程验证：
// 禁用 MODEL_CALLS_ENABLED 时脚本在连库前退出，不调模型，stdout 只有一行 {"ok":false,...}、退出码非 0；
// 不加 --json 时 stdout 保持为空、人读错误走 stderr。worker 统一按 server.schedules 注册（Asia/Shanghai）；
// 下面的 fake 依赖不碰真实数据库、子进程与模型。
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import {
  formatCareerBriefSummary,
  type CareerBriefScriptSummary,
} from "../../../scripts/build-career-brief.ts";
import {
  formatCareerDailyCommentSummary,
  type CareerDailyCommentScriptSummary,
} from "../../../scripts/build-career-daily-comment.ts";
import {
  DEFAULT_BUDGET_PROMPT_TOKENS,
  DEFAULT_BUDGET_ROWS,
  DEFAULT_SINCE_HOURS,
  emptyIncrementalLlmDetail,
} from "../backend/llm-incremental.ts";
import { parseLastJsonLine } from "../backend/model-cli.ts";
import { buildIngestReport } from "../collector/cli/ingest-career.ts";
import server, {
  CAREER_BRIEF_ARGS,
  CAREER_DAILY_COMMENT_ARGS,
  createCareerSchedules,
  parseCareerBriefSummary,
  parseCareerDailyCommentSummary,
  runCareerBriefCron,
  runCareerDailyCommentCron,
  type CareerBriefCronDetail,
  type CareerDailyCommentCronDetail,
  type CareerDailyDeps,
  type CareerDailyResult,
} from "../server.ts";

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");

function ingestResult(overrides: { rejected?: number; failedSources?: string[] } = {}) {
  return {
    report: buildIngestReport({
      startedAt: "2026-11-20T22:10:00.000Z",
      finishedAt: "2026-11-20T22:10:53.000Z",
      pageLimit: 2,
      jobs: [],
      policies: [],
      counts: { jobs: 34 },
    }),
    rejected: overrides.rejected ?? 0,
    failedSources: overrides.failedSources ?? [],
  };
}

function llmResult(ok: boolean) {
  const detail = emptyIncrementalLlmDetail({
    apply: true,
    since: new Date("2026-11-20T20:10:00.000Z"),
    maxRows: 80,
    maxPromptTokens: 120_000,
  });
  return ok
    ? { ...detail, ok: true, duration_ms: 185, exit_code: 0 }
    : { ...detail, ok: false, duration_ms: 185, exit_code: 1, error: "兜底子进程退出码 1" };
}

function briefResult(ok: boolean): CareerBriefCronDetail {
  return ok
    ? {
        ok: true,
        duration_ms: 900,
        exit_code: 0,
        skipped: false,
        as_of: "2026-11-20T00:00:00.000Z",
        sample_size: 188,
        observation_days: 2,
        confidence: "low",
        receipt_id: 290,
        model: "deepseek-v4-flash",
      }
    : { ok: false, duration_ms: 900, exit_code: 1, error: "研判子进程退出码 1" };
}

function commentResult(ok: boolean): CareerDailyCommentCronDetail {
  return ok
    ? {
        ok: true,
        duration_ms: 700,
        exit_code: 0,
        skipped: false,
        date: "2026-11-20",
        as_of: "2026-11-20T02:00:00.000Z",
        sample_size: 188,
        new_jobs: 34,
        confidence: "medium",
        receipt_id: 291,
        model: "deepseek-v4-flash",
      }
    : { ok: false, duration_ms: 700, exit_code: 1, error: "日报评论子进程退出码 1" };
}

/** 真实子进程跑一次研判脚本；禁用模型时脚本在连库前退出，不会碰生产库或模型。 */
async function runBriefScript(args: readonly string[], env: NodeJS.ProcessEnv) {
  const script = path.join(REPO_ROOT, "scripts/build-career-brief.ts");
  try {
    const result = await execFileAsync(process.execPath, [script, ...args], {
      cwd: REPO_ROOT,
      env,
      timeout: 60_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    return { code: 0 as number | null, stdout: String(result.stdout), stderr: String(result.stderr) };
  } catch (error) {
    const failure = error as { code?: number | null; stdout?: string; stderr?: string };
    return { code: failure.code ?? null, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

test("career-insights 只有一条每日 06:10 的 schedule，missed 只补一次", () => {
  const schedules = server.schedules ?? [];
  assert.equal(schedules.length, 2, "采集、兜底、研判与日报评论在同一个 run 里；推送是独立的默认关闭 schedule");
  assert.deepEqual(schedules.map((entry) => entry.name), ["career.ingest", "career.push-daily"], "career.llm-normalize 已删除；推送默认关闭但 schedule 已注册");

  const [schedule] = schedules;
  assert.ok(schedule);
  assert.equal(schedule.cron, "10 6 * * *");
  assert.equal(schedule.missed, "once");
  assert.equal(typeof schedule.run, "function");
});

test("同一个 run 里串行四步：fake 调用序列为 ingest → llm → brief → comment", async () => {
  const calls: string[] = [];
  const deps: CareerDailyDeps = {
    async ingest(options) {
      calls.push("ingest:start");
      assert.equal(options.pageLimit, 2);
      // 模拟采集耗时（实测 53s）：后三步必须等 ingest 的 promise resolve 之后才开始。
      await new Promise((resolve) => setTimeout(resolve, 5));
      calls.push("ingest:done");
      return ingestResult();
    },
    async llm(options) {
      calls.push("llm");
      assert.deepEqual(calls, ["ingest:start", "ingest:done", "llm"], "兜底在采集 resolve 之后才开始，不是并发启动");
      assert.deepEqual(
        options,
        { budgetRows: DEFAULT_BUDGET_ROWS, budgetTokens: DEFAULT_BUDGET_PROMPT_TOKENS, sinceHours: DEFAULT_SINCE_HOURS },
        "注入的预算/窗口就是 llm-incremental 的导出默认值，server 不写死数字",
      );
      return llmResult(true);
    },
    async brief() {
      calls.push("brief");
      assert.deepEqual(
        calls,
        ["ingest:start", "ingest:done", "llm", "brief"],
        "研判在兜底 resolve 之后才开始；页面读它的缓存，所以要在当天归一化之后生成",
      );
      return briefResult(true);
    },
    async comment() {
      calls.push("comment");
      assert.deepEqual(
        calls,
        ["ingest:start", "ingest:done", "llm", "brief", "comment"],
        "日报评论在研判 resolve 之后才开始：它点评的就是当天最终入库的岗位/政策/技能",
      );
      return commentResult(true);
    },
  };

  const [schedule] = createCareerSchedules(deps);
  const result = (await schedule!.run()) as CareerDailyResult;

  assert.deepEqual(calls, ["ingest:start", "ingest:done", "llm", "brief", "comment"], "四步严格串行");
  assert.equal(result.report.kind, "career-ingest");
  assert.equal(result.report.page_limit, 2);
  assert.equal(result.llm.ok, true);
  assert.equal(result.brief.ok, true);
  assert.equal(result.brief.receipt_id, 290);
  assert.equal(result.comment.ok, true);
  assert.equal(result.comment.date, "2026-11-20");
  assert.equal(result.comment.new_jobs, 34);
  assert.equal(result.comment.receipt_id, 291);
});

test("采集抛错时 job 失败：兜底、研判与评论都不执行，错误不被吞掉", async () => {
  let llmCalls = 0;
  let briefCalls = 0;
  let commentCalls = 0;
  const [schedule] = createCareerSchedules({
    ingest: async () => {
      throw new Error("fetch failed: ECONNRESET");
    },
    llm: async () => {
      llmCalls += 1;
      return llmResult(true);
    },
    brief: async () => {
      briefCalls += 1;
      return briefResult(true);
    },
    comment: async () => {
      commentCalls += 1;
      return commentResult(true);
    },
  });

  await assert.rejects(schedule!.run(), /ECONNRESET/);
  assert.equal(llmCalls, 0, "采集失败后不进入兜底");
  assert.equal(briefCalls, 0, "采集失败后不进入研判");
  assert.equal(commentCalls, 0, "采集失败后不进入日报评论");
});

test("采集成功但兜底 ok:false：run 正常返回，采集、兜底、研判与评论汇总都在", async () => {
  const [schedule] = createCareerSchedules({
    ingest: async () => ingestResult({ rejected: 2, failedSources: ["career-dji"] }),
    llm: async () => llmResult(false),
    brief: async () => briefResult(true),
    comment: async () => commentResult(true),
  });

  const result = (await schedule!.run()) as CareerDailyResult;

  assert.equal(result.report.kind, "career-ingest", "采集成果保留在 detail.report");
  assert.equal(result.rejected, 2);
  assert.deepEqual(result.failedSources, ["career-dji"], "顶层 failedSources 供 alerts.ts 读取，形状不变");
  assert.equal(result.llm.ok, false, "兜底失败只记在 detail.llm，不升级为 job 失败");
  assert.match(result.llm.error ?? "", /退出码/);
  assert.equal(result.brief.ok, true, "兜底失败不阻止研判");
  assert.equal(result.comment.ok, true, "兜底失败不阻止日报评论");
});

test("兜底意外 throw（违反 runIncrementalLlmCron 不抛的契约）：job 失败，研判与评论不执行", async () => {
  // runIncrementalLlmCron 的契约是失败也返回 ok:false、不抛错。一旦它违反契约抛错，让整个 job 失败、
  // 采集 report 不落 detail 是有意的：这类 bug 要在 job_runs 里显形，而不是被静默吞掉变成"成功"。
  let briefCalls = 0;
  let commentCalls = 0;
  const [schedule] = createCareerSchedules({
    ingest: async () => ingestResult(),
    llm: async () => {
      throw new Error("兜底子进程意外抛错");
    },
    brief: async () => {
      briefCalls += 1;
      return briefResult(true);
    },
    comment: async () => {
      commentCalls += 1;
      return commentResult(true);
    },
  });

  await assert.rejects(schedule!.run(), /兜底子进程意外抛错/);
  assert.equal(briefCalls, 0);
  assert.equal(commentCalls, 0);
});

test("研判 ok:false：job 仍 resolve，detail.report / detail.llm / detail.brief.ok=false 都在，评论照常执行", async () => {
  const [schedule] = createCareerSchedules({
    ingest: async () => ingestResult(),
    llm: async () => llmResult(true),
    brief: async () => briefResult(false),
    comment: async () => commentResult(true),
  });

  const result = (await schedule!.run()) as CareerDailyResult;

  assert.equal(result.report.kind, "career-ingest", "采集成果保留");
  assert.equal(result.llm.ok, true, "兜底成果保留");
  assert.equal(result.brief.ok, false, "研判失败只记在 detail.brief");
  assert.match(result.brief.error ?? "", /退出码/);
  assert.equal(result.comment.ok, true, "研判失败不阻止日报评论");
});

test("研判意外 throw：job 仍 resolve 成 detail.brief.ok=false（有意与兜底不同），评论照常执行", async () => {
  // 兜底抛错会让整个 job 失败（上面一条测试）；研判由 server 自己兜住。研判只影响一份可下一天再生成的
  // 缓存，不该让当日采集与兜底成果从 job_runs 里消失，所以这里不把"违反不抛契约"当成 job 失败。
  const [schedule] = createCareerSchedules({
    ingest: async () => ingestResult(),
    llm: async () => llmResult(true),
    brief: async () => {
      throw new Error("研判步骤意外抛错");
    },
    comment: async () => commentResult(true),
  });

  const result = (await schedule!.run()) as CareerDailyResult;

  assert.equal(result.report.kind, "career-ingest");
  assert.equal(result.llm.ok, true);
  assert.equal(result.brief.ok, false);
  assert.match(result.brief.error ?? "", /研判步骤意外抛错/);
  assert.equal(result.comment.ok, true);
});

test("评论 ok:false：job 仍 resolve，采集、兜底与研判成果都在", async () => {
  const [schedule] = createCareerSchedules({
    ingest: async () => ingestResult(),
    llm: async () => llmResult(true),
    brief: async () => briefResult(true),
    comment: async () => commentResult(false),
  });

  const result = (await schedule!.run()) as CareerDailyResult;

  assert.equal(result.report.kind, "career-ingest", "采集成果保留");
  assert.equal(result.llm.ok, true, "兜底成果保留");
  assert.equal(result.brief.ok, true, "研判成果保留");
  assert.equal(result.comment.ok, false, "评论失败只记在 detail.comment");
  assert.match(result.comment.error ?? "", /退出码/);
});

test("评论意外 throw：job 仍 resolve 成 detail.comment.ok=false", async () => {
  const [schedule] = createCareerSchedules({
    ingest: async () => ingestResult(),
    llm: async () => llmResult(true),
    brief: async () => briefResult(true),
    comment: async () => {
      throw new Error("日报评论步骤意外抛错");
    },
  });

  const result = (await schedule!.run()) as CareerDailyResult;

  assert.equal(result.report.kind, "career-ingest");
  assert.equal(result.brief.ok, true);
  assert.equal(result.comment.ok, false);
  assert.match(result.comment.error ?? "", /日报评论步骤意外抛错/);
});

test("评论步骤以子进程跑 build-career-daily-comment.ts --json，并在子进程环境显式打开模型调用", async () => {
  const previous = process.env.MODEL_CALLS_ENABLED;
  process.env.MODEL_CALLS_ENABLED = "false";
  try {
    let seenArgs: readonly string[] = [];
    let seenEnv: NodeJS.ProcessEnv = {};
    const summary: CareerDailyCommentScriptSummary = {
      ok: true,
      skipped: false,
      date: "2026-11-20",
      as_of: "2026-11-20T02:00:00.000Z",
      sample_size: 188,
      new_jobs: 34,
      confidence: "medium",
      receipt_id: 291,
      model: "deepseek-v4-flash",
    };

    const detail = await runCareerDailyCommentCron({
      run: async (args, env) => {
        seenArgs = args;
        seenEnv = env;
        return { code: 0, stdout: "=== 就业日报 AI 评论（apply） ===\n" + formatCareerDailyCommentSummary(summary) + "\n", stderr: "" };
      },
    });

    assert.deepEqual(seenArgs, [...CAREER_DAILY_COMMENT_ARGS]);
    assert.deepEqual(seenArgs, ["--json"], "cron 固定让脚本走 --json，stdout 只有结构化汇总");
    assert.equal(seenEnv.MODEL_CALLS_ENABLED, "true", "子进程显式启用模型调用");
    assert.equal(process.env.MODEL_CALLS_ENABLED, "false", "worker 自己的开关保持不变");
    assert.equal(detail.ok, true);
    assert.equal(detail.exit_code, 0);
    assert.equal(detail.skipped, false);
    assert.equal(detail.date, "2026-11-20");
    assert.equal(detail.as_of, "2026-11-20T02:00:00.000Z");
    assert.equal(detail.sample_size, 188);
    assert.equal(detail.new_jobs, 34);
    assert.equal(detail.confidence, "medium");
    assert.equal(detail.receipt_id, 291);
    assert.equal(detail.model, "deepseek-v4-flash");
    assert.equal(typeof detail.duration_ms, "number");

    const noSamples = await runCareerDailyCommentCron({
      run: async () => ({ code: 0, stdout: formatCareerDailyCommentSummary({ ok: true, skipped: true, reason: "no_samples" }) + "\n", stderr: "" }),
    });
    assert.equal(noSamples.ok, true, "当日无观测样本时模型没被调用，算成功跳过");
    assert.equal(noSamples.skipped, true);
    assert.equal(noSamples.reason, "no_samples");
  } finally {
    if (previous === undefined) delete process.env.MODEL_CALLS_ENABLED;
    else process.env.MODEL_CALLS_ENABLED = previous;
  }
});

test("评论步骤失败安全：启动失败/超时/没有汇总/脚本 ok:false 都返回 ok:false 不抛", async () => {
  const crashed = await runCareerDailyCommentCron({
    run: async () => {
      throw new Error("spawn node ENOENT");
    },
  });
  assert.equal(crashed.ok, false);
  assert.equal(crashed.exit_code, null);
  assert.match(crashed.error ?? "", /启动失败|ENOENT/);

  const timedOut = await runCareerDailyCommentCron({ run: async () => ({ code: null, stdout: "", stderr: "", timedOut: true }) });
  assert.equal(timedOut.ok, false);
  assert.match(timedOut.error ?? "", /超时/);

  const noSummary = await runCareerDailyCommentCron({
    run: async () => ({ code: 2, stdout: "not json", stderr: "database connect failed" }),
  });
  assert.equal(noSummary.ok, false);
  assert.equal(noSummary.exit_code, 2);
  assert.match(noSummary.error ?? "", /database connect failed/);

  const rejected = await runCareerDailyCommentCron({
    run: async () => ({
      code: 1,
      stdout: formatCareerDailyCommentSummary({ ok: false, error: "模型输出不合规，未写库：comment 出现输入外的数字 999" }),
      stderr: "",
    }),
  });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.exit_code, 1);
  assert.match(rejected.error ?? "", /不合规/);

  // 防御：退出码 0 但汇总说失败，也按失败记录——不能把"没生成"记成"成功"。
  const inconsistent = await runCareerDailyCommentCron({
    run: async () => ({ code: 0, stdout: formatCareerDailyCommentSummary({ ok: false, error: "坏了" }), stderr: "" }),
  });
  assert.equal(inconsistent.ok, false);
  assert.match(inconsistent.error ?? "", /坏了/);
});

test("评论 --json 汇总与脚本格式化往返一致，日志行与坏行被跳过", () => {
  const success = {
    ok: true,
    skipped: false,
    date: "2026-11-20",
    as_of: "2026-11-20T02:00:00.000Z",
    sample_size: 188,
    new_jobs: 34,
    confidence: "medium",
    receipt_id: 291,
    model: "deepseek-v4-flash",
  } as const;
  assert.equal(
    formatCareerDailyCommentSummary(success),
    '{"ok":true,"skipped":false,"date":"2026-11-20","as_of":"2026-11-20T02:00:00.000Z","sample_size":188,"new_jobs":34,"confidence":"medium","receipt_id":291,"model":"deepseek-v4-flash"}',
  );
  assert.equal(
    formatCareerDailyCommentSummary({ ok: true, skipped: true, reason: "no_samples" }),
    '{"ok":true,"skipped":true,"reason":"no_samples"}',
  );
  assert.deepEqual(
    parseCareerDailyCommentSummary("=== 就业日报 AI 评论（apply） ===\n数据库: 127.0.0.1:5432/aihot\n" + formatCareerDailyCommentSummary(success)),
    success,
  );
  assert.deepEqual(parseCareerDailyCommentSummary(formatCareerDailyCommentSummary({ ok: true, skipped: true, reason: "no_samples" })), {
    ok: true,
    skipped: true,
    reason: "no_samples",
  });
  assert.deepEqual(parseCareerDailyCommentSummary(formatCareerDailyCommentSummary({ ok: false, error: "坏了" })), {
    ok: false,
    error: "坏了",
  });
  assert.equal(parseCareerDailyCommentSummary(""), null);
  assert.equal(parseCareerDailyCommentSummary('{"date":"2026-11-20"}'), null, "没有布尔 ok 的 JSON 不是评论汇总");
});

/** 真实子进程跑一次日报评论脚本；禁用模型时脚本在连库前退出，不会碰生产库或模型。 */
async function runCommentScript(args: readonly string[], env: NodeJS.ProcessEnv) {
  const script = path.join(REPO_ROOT, "scripts/build-career-daily-comment.ts");
  try {
    const result = await execFileAsync(process.execPath, [script, ...args], {
      cwd: REPO_ROOT,
      env,
      timeout: 60_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    return { code: 0 as number | null, stdout: String(result.stdout), stderr: String(result.stderr) };
  } catch (error) {
    const failure = error as { code?: number | null; stdout?: string; stderr?: string };
    return { code: failure.code ?? null, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

test("评论脚本 --json 契约（禁用模型）：stdout 只有一行 ok:false、退出码非 0，不连库不调模型", async () => {
  const env = { ...process.env, MODEL_CALLS_ENABLED: "false" };

  const json = await runCommentScript(["--json"], env);
  assert.notEqual(json.code, 0, "配置失败必须非 0 退出");
  const lines = json.stdout.split(/\r?\n/u).filter((line) => line.trim() !== "");
  assert.equal(lines.length, 1, "stdout 只有最后一行 JSON 汇总");
  const summary = parseCareerDailyCommentSummary(lines[0]!);
  assert.notEqual(summary, null);
  assert.equal(summary?.ok, false);
  if (summary !== null && summary.ok === false) assert.match(summary.error, /MODEL_CALLS_ENABLED/);

  const human = await runCommentScript([], env);
  assert.notEqual(human.code, 0);
  assert.equal(human.stdout.trim(), "", "不加 --json 时 stdout 保持为空，人读错误走 stderr");
  assert.match(human.stderr, /MODEL_CALLS_ENABLED/);

  const badDate = await runCommentScript(["--json", "--date", "2026-13-01"], env);
  assert.notEqual(badDate.code, 0);
  const badSummary = parseCareerDailyCommentSummary(badDate.stdout.trim());
  assert.equal(badSummary?.ok, false);
  if (badSummary !== null && badSummary.ok === false) assert.match(badSummary.error, /--date|日历日期/);
});

test("研判步骤以子进程跑 build-career-brief.ts --json，并在子进程环境显式打开模型调用", async () => {
  const previous = process.env.MODEL_CALLS_ENABLED;
  process.env.MODEL_CALLS_ENABLED = "false";
  try {
    let seenArgs: readonly string[] = [];
    let seenEnv: NodeJS.ProcessEnv = {};
    const summary: CareerBriefScriptSummary = {
      ok: true,
      as_of: "2026-11-20T00:00:00.000Z",
      sample_size: 188,
      observation_days: 2,
      confidence: "low",
      receipt_id: 290,
      model: "deepseek-v4-flash",
      skipped: false,
    };

    const detail = await runCareerBriefCron({
      run: async (args, env) => {
        seenArgs = args;
        seenEnv = env;
        return { code: 0, stdout: "=== 学生就业研判（apply） ===\n" + formatCareerBriefSummary(summary) + "\n", stderr: "" };
      },
    });

    assert.deepEqual(seenArgs, [...CAREER_BRIEF_ARGS]);
    assert.deepEqual(seenArgs, ["--json"], "cron 固定让脚本走 --json，stdout 只有结构化汇总");
    assert.equal(seenEnv.MODEL_CALLS_ENABLED, "true", "子进程显式启用模型调用");
    assert.equal(process.env.MODEL_CALLS_ENABLED, "false", "worker 自己的开关保持不变");
    assert.equal(detail.ok, true);
    assert.equal(detail.exit_code, 0);
    assert.equal(detail.skipped, false);
    assert.equal(detail.as_of, "2026-11-20T00:00:00.000Z");
    assert.equal(detail.sample_size, 188);
    assert.equal(detail.observation_days, 2);
    assert.equal(detail.confidence, "low");
    assert.equal(detail.receipt_id, 290);
    assert.equal(detail.model, "deepseek-v4-flash");
    assert.equal(typeof detail.duration_ms, "number");

    const noSamples = await runCareerBriefCron({
      run: async () => ({ code: 0, stdout: formatCareerBriefSummary({ ok: true, skipped: true, reason: "no_samples" }) + "\n", stderr: "" }),
    });
    assert.equal(noSamples.ok, true, "无岗位样本时模型没被调用，算成功跳过");
    assert.equal(noSamples.skipped, true);
    assert.equal(noSamples.reason, "no_samples");
  } finally {
    if (previous === undefined) delete process.env.MODEL_CALLS_ENABLED;
    else process.env.MODEL_CALLS_ENABLED = previous;
  }
});

test("研判步骤失败安全：启动失败/超时/没有汇总/脚本 ok:false 都返回 ok:false 不抛", async () => {
  const crashed = await runCareerBriefCron({
    run: async () => {
      throw new Error("spawn node ENOENT");
    },
  });
  assert.equal(crashed.ok, false);
  assert.equal(crashed.exit_code, null);
  assert.match(crashed.error ?? "", /启动失败|ENOENT/);

  const timedOut = await runCareerBriefCron({ run: async () => ({ code: null, stdout: "", stderr: "", timedOut: true }) });
  assert.equal(timedOut.ok, false);
  assert.match(timedOut.error ?? "", /超时/);

  const noSummary = await runCareerBriefCron({
    run: async () => ({ code: 2, stdout: "not json", stderr: "database connect failed" }),
  });
  assert.equal(noSummary.ok, false);
  assert.equal(noSummary.exit_code, 2);
  assert.match(noSummary.error ?? "", /database connect failed/);

  const rejected = await runCareerBriefCron({
    run: async () => ({
      code: 1,
      stdout: formatCareerBriefSummary({ ok: false, error: "模型输出不合规，未写库：facts 必须是字符串数组" }),
      stderr: "",
    }),
  });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.exit_code, 1);
  assert.match(rejected.error ?? "", /不合规/);

  // 防御：退出码 0 但汇总说失败，也按失败记录——不能把"没生成"记成"成功"。
  const inconsistent = await runCareerBriefCron({
    run: async () => ({ code: 0, stdout: formatCareerBriefSummary({ ok: false, error: "坏了" }), stderr: "" }),
  });
  assert.equal(inconsistent.ok, false);
  assert.match(inconsistent.error ?? "", /坏了/);
});

test("--json 汇总与脚本格式化往返一致，日志行与坏行被跳过", () => {
  assert.equal(
    formatCareerBriefSummary({
      ok: true,
      as_of: "2026-11-20T00:00:00.000Z",
      sample_size: 188,
      observation_days: 2,
      confidence: "low",
      receipt_id: 290,
      model: "deepseek-v4-flash",
      skipped: false,
    }),
    '{"ok":true,"as_of":"2026-11-20T00:00:00.000Z","sample_size":188,"observation_days":2,"confidence":"low","receipt_id":290,"model":"deepseek-v4-flash","skipped":false}',
  );
  assert.equal(
    formatCareerBriefSummary({ ok: true, skipped: true, reason: "no_samples" }),
    '{"ok":true,"skipped":true,"reason":"no_samples"}',
  );

  const success = {
    ok: true,
    as_of: "2026-11-20T00:00:00.000Z",
    sample_size: 188,
    observation_days: 2,
    confidence: "low",
    receipt_id: 290,
    model: "deepseek-v4-flash",
    skipped: false,
  } as const;
  assert.deepEqual(
    parseCareerBriefSummary("=== 学生就业研判（apply） ===\n数据库: 127.0.0.1:5432/aihot\n" + formatCareerBriefSummary(success)),
    success,
  );
  assert.deepEqual(parseCareerBriefSummary(formatCareerBriefSummary({ ok: true, skipped: true, reason: "no_samples" })), {
    ok: true,
    skipped: true,
    reason: "no_samples",
  });
  assert.deepEqual(parseCareerBriefSummary(formatCareerBriefSummary({ ok: false, error: "坏了" })), { ok: false, error: "坏了" });

  assert.equal(parseCareerBriefSummary(""), null);
  assert.equal(parseCareerBriefSummary("not json"), null);
  assert.equal(parseCareerBriefSummary('{"candidates":3}'), null, "没有布尔 ok 的 JSON 不是研判汇总");
  assert.equal(parseCareerBriefSummary('{"ok":"yes"}'), null);
  assert.deepEqual(parseLastJsonLine('log line\n{"candidates":3}\n'), { candidates: 3 });
  assert.equal(parseLastJsonLine("x\n{bad}\n"), null);
});

test("脚本 --json 契约（禁用模型）：stdout 只有一行 ok:false、退出码非 0，不连库不调模型", async () => {
  const env = { ...process.env, MODEL_CALLS_ENABLED: "false" };

  const json = await runBriefScript(["--json"], env);
  assert.notEqual(json.code, 0, "配置失败必须非 0 退出");
  const lines = json.stdout.split(/\r?\n/u).filter((line) => line.trim() !== "");
  assert.equal(lines.length, 1, "stdout 只有最后一行 JSON 汇总");
  const summary = parseCareerBriefSummary(lines[0]!);
  assert.notEqual(summary, null);
  assert.equal(summary?.ok, false);
  if (summary !== null && summary.ok === false) assert.match(summary.error, /MODEL_CALLS_ENABLED/);

  const human = await runBriefScript([], env);
  assert.notEqual(human.code, 0);
  assert.equal(human.stdout.trim(), "", "不加 --json 时 stdout 保持为空，人读错误走 stderr");
  assert.match(human.stderr, /MODEL_CALLS_ENABLED/);
});
