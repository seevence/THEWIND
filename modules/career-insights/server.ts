import type { Scheduled, ServerModule } from "@aihot/backend/modules";
import { runCareerIngest, type CareerIngestRunResult } from "./collector/cli/ingest-career.ts";
import { careerIngestAlerts } from "./backend/alerts.ts";
import { registerCareerHttp } from "./backend/http.ts";
import {
  DEFAULT_BUDGET_PROMPT_TOKENS,
  DEFAULT_BUDGET_ROWS,
  DEFAULT_SINCE_HOURS,
  runIncrementalLlmCron,
  type IncrementalLlmCronDetail,
} from "./backend/llm-incremental.ts";
import { parseLastJsonLine, runModelCli, type ModelCliOutcome } from "./backend/model-cli.ts";
import { careerIngestQueue } from "./backend/queue.ts";
import { careerSitemapEntries } from "./backend/sitemap.ts";
import { registerCareerAdminOverview } from "./backend/admin-overview.ts";
import { careerAgent } from "./backend/agent.ts";
import { llms as careerLlms } from "./backend/llms.ts";
import { CAREER_MODEL_STEPS } from "./backend/models.ts";
import { careerRetention } from "./backend/retention.ts";
import { careerPushDailySchedule } from "./backend/notify.ts";
import { registerCareerArchiveRoutes } from "./backend/routes/archive.ts";
import { registerCareerPublicV1 } from "./backend/routes/public-v1.ts";
import { registerCareerFeeds } from "./backend/routes/feeds.ts";
import { SqlCareerRepository } from "./backend/sql-repository.ts";

const repository = new SqlCareerRepository();

/** 每个来源抓几页；与兜底/研判同属一个 job，测试按这个值断言注入的采集参数。 */
const INGEST_PAGE_LIMIT = 2;

/** 研判脚本：每次调用模型输出一份研判并按 (as_of, prompt_version) upsert 到 career_briefs。 */
const CAREER_BRIEF_CLI = "scripts/build-career-brief.ts";
/** 与 LLM 兜底同口径的超时（脚本内部单次模型调用 120s）。 */
const CAREER_BRIEF_TIMEOUT_MS = 15 * 60_000;
/** cron 固定让脚本走 --json：stdout 只有一行结构化汇总，人读日志走 stderr，detail 直接解析。 */
export const CAREER_BRIEF_ARGS: readonly string[] = ["--json"];

/** 日报评论脚本：每次调用模型输出一份当日评论并按 (comment_date, prompt_version) upsert 到 career_daily_comments。 */
const CAREER_DAILY_COMMENT_CLI = "scripts/build-career-daily-comment.ts";
/** 与研判脚本同口径的超时（单次模型调用 120s，留足重试与连库）。 */
const CAREER_DAILY_COMMENT_TIMEOUT_MS = 15 * 60_000;
/** cron 固定让脚本走 --json：stdout 只有一行结构化汇总，人读日志走 stderr，detail 直接解析。 */
export const CAREER_DAILY_COMMENT_ARGS: readonly string[] = ["--json"];

/**
 * 脚本 --json 的输出：成功、无样本、失败三种互斥形状。
 * 这里是 cron 侧解析用的形状；脚本侧的格式化在 scripts/build-career-brief.ts，测试会往返校验两者不漂移。
 */
export type CareerBriefSummary =
  | {
      ok: true;
      skipped: false;
      as_of: string;
      sample_size: number;
      observation_days: number;
      confidence: string;
      receipt_id: number | null;
      model: string | null;
    }
  | { ok: true; skipped: true; reason: string }
  | { ok: false; error: string };

/** 写进 job_runs.detail.brief：脚本汇总（或失败原因）加上进程信息。 */
export interface CareerBriefCronDetail {
  ok: boolean;
  duration_ms: number;
  exit_code: number | null;
  error?: string;
  skipped?: boolean;
  reason?: string;
  as_of?: string;
  sample_size?: number;
  observation_days?: number;
  confidence?: string;
  receipt_id?: number | null;
  model?: string | null;
}

/**
 * 日报评论脚本 --json 的输出：成功、当日无样本、失败三种互斥形状。
 * 脚本侧的格式化在 scripts/build-career-daily-comment.ts，测试会往返校验两者不漂移。
 */
export type CareerDailyCommentSummary =
  | {
      ok: true;
      skipped: false;
      date: string;
      as_of: string;
      sample_size: number;
      new_jobs: number;
      confidence: string;
      receipt_id: number | null;
      model: string | null;
    }
  | { ok: true; skipped: true; reason: string }
  | { ok: false; error: string };

/** 写进 job_runs.detail.comment：脚本汇总（或失败原因）加上进程信息。 */
export interface CareerDailyCommentCronDetail {
  ok: boolean;
  duration_ms: number;
  exit_code: number | null;
  error?: string;
  skipped?: boolean;
  reason?: string;
  date?: string;
  as_of?: string;
  sample_size?: number;
  new_jobs?: number;
  confidence?: string;
  receipt_id?: number | null;
  model?: string | null;
}

/** 只看 stdout 里带布尔 ok 的 JSON 行；人读日志与坏行跳过。 */
export function parseCareerBriefSummary(stdout: string): CareerBriefSummary | null {
  return parseLastJsonLine<CareerBriefSummary>(
    stdout,
    (value) => typeof value === "object" && value !== null && typeof (value as { ok?: unknown }).ok === "boolean",
  );
}

export function parseCareerDailyCommentSummary(stdout: string): CareerDailyCommentSummary | null {
  return parseLastJsonLine<CareerDailyCommentSummary>(
    stdout,
    (value) => typeof value === "object" && value !== null && typeof (value as { ok?: unknown }).ok === "boolean",
  );
}

export type CareerBriefCliRun = (args: readonly string[], env: NodeJS.ProcessEnv) => Promise<ModelCliOutcome>;

export interface CronCareerBriefOptions {
  /** 测试注入：替掉真实子进程。 */
  run?: CareerBriefCliRun;
  /** 在继承的 worker 环境上追加的变量；MODEL_CALLS_ENABLED=true 始终由本步骤显式写入。 */
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
}

function briefFailure(durationMs: number, exitCode: number | null, error: string): CareerBriefCronDetail {
  return { ok: false, duration_ms: durationMs, exit_code: exitCode, error: error.slice(0, 400) };
}

/**
 * 每日 cron 的研判步骤：以子进程执行 scripts/build-career-brief.ts --json，子进程环境里显式
 * MODEL_CALLS_ENABLED=true，worker 自己的开关不变；子进程失败（模型不可用/超时/无 key/崩溃/输出不合规）
 * 不抛出，而是返回结构化 detail 写进 job_runs。页面只读这份缓存，永远不触发模型调用。
 */
export async function runCareerBriefCron(options: CronCareerBriefOptions = {}): Promise<CareerBriefCronDetail> {
  const startedAt = Date.now();
  const log = options.log ?? (() => {});
  const env: NodeJS.ProcessEnv = { ...process.env, ...options.env, MODEL_CALLS_ENABLED: "true" };
  const run =
    options.run ??
    ((args, childEnv) =>
      runModelCli({ script: CAREER_BRIEF_CLI, args, env: childEnv, timeoutMs: CAREER_BRIEF_TIMEOUT_MS }));
  try {
    const outcome = await run(CAREER_BRIEF_ARGS, env);
    const durationMs = Date.now() - startedAt;
    const summary = parseCareerBriefSummary(outcome.stdout);
    if (summary === null) {
      const error =
        outcome.timedOut === true
          ? "研判子进程超时"
          : `研判子进程退出码 ${String(outcome.code)}：${outcome.stderr.trim().slice(0, 400) || "没有输出汇总"}`;
      log(error);
      return briefFailure(durationMs, outcome.code, error);
    }
    const ok = outcome.code === 0 && summary.ok === true;
    if (!ok) {
      const error =
        summary.ok === false
          ? summary.error
          : outcome.stderr.trim().slice(0, 400) || `研判子进程退出码 ${String(outcome.code)}`;
      log(`研判未生成：${error}`);
      return { ...summary, ok: false, error, duration_ms: durationMs, exit_code: outcome.code };
    }
    return { ...summary, ok: true, duration_ms: durationMs, exit_code: outcome.code };
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    const message = error instanceof Error ? `研判子进程启动失败: ${error.name}: ${error.message}` : "研判子进程启动失败";
    log(message);
    return briefFailure(durationMs, null, message);
  }
}

export type CareerDailyCommentCliRun = (args: readonly string[], env: NodeJS.ProcessEnv) => Promise<ModelCliOutcome>;

export interface CronCareerDailyCommentOptions {
  /** 测试注入：替掉真实子进程。 */
  run?: CareerDailyCommentCliRun;
  /** 在继承的 worker 环境上追加的变量；MODEL_CALLS_ENABLED=true 始终由本步骤显式写入。 */
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
}

function commentFailure(durationMs: number, exitCode: number | null, error: string): CareerDailyCommentCronDetail {
  return { ok: false, duration_ms: durationMs, exit_code: exitCode, error: error.slice(0, 400) };
}

/**
 * 每日 cron 的日报评论步骤：以子进程执行 scripts/build-career-daily-comment.ts --json，子进程环境里显式
 * MODEL_CALLS_ENABLED=true，worker 自己的开关不变；子进程失败（模型不可用/超时/无 key/崩溃/输出不合规）
 * 不抛出，而是返回结构化 detail 写进 job_runs。页面只读这份缓存，永远不触发模型调用。
 */
export async function runCareerDailyCommentCron(
  options: CronCareerDailyCommentOptions = {},
): Promise<CareerDailyCommentCronDetail> {
  const startedAt = Date.now();
  const log = options.log ?? (() => {});
  const env: NodeJS.ProcessEnv = { ...process.env, ...options.env, MODEL_CALLS_ENABLED: "true" };
  const run =
    options.run ??
    ((args, childEnv) =>
      runModelCli({ script: CAREER_DAILY_COMMENT_CLI, args, env: childEnv, timeoutMs: CAREER_DAILY_COMMENT_TIMEOUT_MS }));
  try {
    const outcome = await run(CAREER_DAILY_COMMENT_ARGS, env);
    const durationMs = Date.now() - startedAt;
    const summary = parseCareerDailyCommentSummary(outcome.stdout);
    if (summary === null) {
      const error =
        outcome.timedOut === true
          ? "日报评论子进程超时"
          : `日报评论子进程退出码 ${String(outcome.code)}：${outcome.stderr.trim().slice(0, 400) || "没有输出汇总"}`;
      log(error);
      return commentFailure(durationMs, outcome.code, error);
    }
    const ok = outcome.code === 0 && summary.ok === true;
    if (!ok) {
      const error =
        summary.ok === false
          ? summary.error
          : outcome.stderr.trim().slice(0, 400) || `日报评论子进程退出码 ${String(outcome.code)}`;
      log(`日报评论未生成：${error}`);
      return { ...summary, ok: false, error, duration_ms: durationMs, exit_code: outcome.code };
    }
    return { ...summary, ok: true, duration_ms: durationMs, exit_code: outcome.code };
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    const message = error instanceof Error ? `日报评论子进程启动失败: ${error.name}: ${error.message}` : "日报评论子进程启动失败";
    log(message);
    return commentFailure(durationMs, null, message);
  }
}

/** 每日 job 的四个步骤；测试注入 fake，不碰真实数据库、子进程与模型。 */
export interface CareerDailyDeps {
  ingest: (options: { pageLimit?: number }) => Promise<CareerIngestRunResult>;
  llm: (options: { budgetRows: number; budgetTokens: number; sinceHours: number }) => Promise<IncrementalLlmCronDetail>;
  brief: () => Promise<CareerBriefCronDetail>;
  comment: () => Promise<CareerDailyCommentCronDetail>;
}

/**
 * job_runs.detail：采集结果（report/rejected/failedSources 原样保留，alerts.ts 读顶层 failedSources）
 * 加上兜底、研判与日报评论汇总。四块都在，采集成功而后三步失败时采集成果不丢。
 */
export type CareerDailyResult = CareerIngestRunResult & {
  llm: IncrementalLlmCronDetail;
  brief: CareerBriefCronDetail;
  comment: CareerDailyCommentCronDetail;
};

/**
 * 采集 → LLM 兜底 → 就业研判 → 日报 AI 评论的串行 run。四步必须在一个 job 里跑完：pg-boss 的 missed: "once"
 * 补跑会在 worker 启动时把同一时刻漏掉的槽位一起拉起来，拆成多个 schedule 时后一步会和采集同时启动
 * （2026-11-21 实测 01:28:55 兜底与采集同刻启动，兜底 185ms 结束、0 候选，当天新增的 34 行 unknown 没有兜底）。
 * 研判放在兜底之后：它读聚合后的职族/技能，先等兜底把当天新行归一化，缓存才反映最新数据；日报评论再放
 * 在研判之后，点评的就是当天最终入库的岗位/政策/技能。
 *
 * 失败语义：采集抛错时整个 job 失败，不执行后三步、也不吞错；兜底返回 ok:false（子进程失败/超时）不算
 * job 失败，只记在 detail.llm 里。研判与评论同理，失败只记在 detail.brief / detail.comment 里；它们的
 * 「不抛穿」契约由本文件自己兜住（见 runBriefStep / runCommentStep），不像兜底那样把违反契约当成 job 失败
 * ——研判与评论只影响一份缓存，不应抹掉当日采集/兜底成果。
 *
 * 预算与窗口直接用 llm-incremental 的默认值（80 行 / 120000 token / 2 小时），不在这里复制数值。
 * 最坏耗时 = 采集约 53s + 兜底 CLI 15min + 研判 CLI 15min + 评论 CLI 15min < cron 队列 expireInSeconds=3600
 * （apps/worker/src/schedules.ts 统一给 cron.* 队列设的过期时间），不会被 pg-boss 判过期。
 */
function careerDailyRun(deps: CareerDailyDeps): () => Promise<CareerDailyResult> {
  return async () => {
    const ingest = await deps.ingest({ pageLimit: INGEST_PAGE_LIMIT });
    const llm = await deps.llm({
      budgetRows: DEFAULT_BUDGET_ROWS,
      budgetTokens: DEFAULT_BUDGET_PROMPT_TOKENS,
      sinceHours: DEFAULT_SINCE_HOURS,
    });
    const brief = await runBriefStep(deps.brief);
    const comment = await runCommentStep(deps.comment);
    return { ...ingest, llm, brief, comment };
  };
}

/**
 * 研判步骤再兜一层：子进程 runner 的契约是失败也返回 ok:false、不抛错；一旦它违反契约抛错，
 * 也只降级成 detail.brief.ok=false，让 job 仍然保留采集与兜底成果。与兜底有意不同：
 * 兜底抛错说明每日数据归一化坏了，要显形；研判只是缓存，丢了下一天再生成。
 */
async function runBriefStep(brief: () => Promise<CareerBriefCronDetail>): Promise<CareerBriefCronDetail> {
  const startedAt = Date.now();
  try {
    return await brief();
  } catch (error) {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : "研判步骤意外抛错";
    return briefFailure(Date.now() - startedAt, null, message);
  }
}

/**
 * 日报评论步骤同样再兜一层：runner 的契约是失败也返回 ok:false、不抛错；一旦它违反契约抛错，
 * 也只降级成 detail.comment.ok=false，让 job 仍然保留采集、兜底与研判成果——评论只是另一份缓存。
 */
async function runCommentStep(comment: () => Promise<CareerDailyCommentCronDetail>): Promise<CareerDailyCommentCronDetail> {
  const startedAt = Date.now();
  try {
    return await comment();
  } catch (error) {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : "日报评论步骤意外抛错";
    return commentFailure(Date.now() - startedAt, null, message);
  }
}

/** career-insights 的全部 schedule：采集、兜底、研判与日报评论只能在这一条里串行，不要再拆出独立 cron。 */
export function createCareerSchedules(deps: CareerDailyDeps): Scheduled[] {
  return [{ name: "career.ingest", cron: "10 6 * * *", missed: "once", run: careerDailyRun(deps) }];
}

const server: ServerModule = {
  name: "career-insights",
  http(app) {
    registerCareerHttp(app, repository);
    // P1/P2 新增的只读路由插件：日报归档、公开 API v1、就业 RSS、后台就业数据。
    registerCareerArchiveRoutes(app, repository);
    registerCareerPublicV1(app, repository);
    registerCareerFeeds(app, repository);
    registerCareerAdminOverview(app);
  },
  agent: careerAgent(repository),
  llms: careerLlms,
  // 后台「模型与评测」页列出/切换就业研判、日报评论与归一化兜底三步（默认见 site/models.ts）。
  models: CAREER_MODEL_STEPS,
  retention: (now: Date) => careerRetention.clear(now) as unknown as Promise<Record<string, unknown>>,
  // 职业洞察、热门岗位、政策页与每个存在的岗位详情（上限与 lastmod 见 backend/sitemap.ts）。
  sitemap: { entries: () => careerSitemapEntries() },
  alerts: careerIngestAlerts,
  queues: [careerIngestQueue],
  schedules: [
    ...createCareerSchedules({
      ingest: runCareerIngest,
      llm: runIncrementalLlmCron,
      brief: () => runCareerBriefCron(),
      comment: () => runCareerDailyCommentCron(),
    }),
    // 就业日报/新增岗位推送：默认关闭，配置 CAREER_PUSH_ENABLED + webhook 后生效（backend/notify.ts）。
    careerPushDailySchedule(),
  ],
};

export default server;
