// 每日采集后的 LLM 兜底：只对「采集窗口内更新过、且仍未分类」的行调用模型，带行数与 prompt token 双预算，
// 写回只碰派生字段白名单（role_family / student_friendly / skills / 经验年限 / normalizer_version /
// updated_at），不碰观测、last_seen_at 和 content_hash。
//
// 模型语义（prompt、输出 schema、后置校验、与既有值的合并）由调用方注入：定时任务用子进程跑
// scripts/backfill-incremental-llm.ts，那里复用 scripts/backfill-normalizer-llm.ts 的同一套实现，
// 模块本身不反向 import scripts。进程内核心是 runIncrementalLlm；cron 入口是 runIncrementalLlmCron
// （子进程显式 MODEL_CALLS_ENABLED=true，worker 自己的开关不变），返回值进同一 job 的 job_runs.detail.llm，
// 由 server.ts 的 career.ingest 在采集成功之后串行调用；采集→兜底→研判三步不能拆成多条 schedule。
import type { Sql } from "@aihot/backend/db";
import type { JSONValue } from "postgres";
import type { RoleFamily, StudentFriendly } from "../contracts/index.ts";
import { LLM_NORMALIZER_VERSION } from "../data/normalize.ts";
import { parseLastJsonLine, runModelCli, type ModelCliOutcome } from "./model-cli.ts";

/**
 * 每次兜底最多调用模型的行数。80 约等于一天新增岗位量（约 30-50 行）的余量：预算触顶被跳过的行
 * 仍是旧 normalizer_version，但下一轮 sinceHours 窗口已不含它们（除非当天又被采集到），等于永久漏掉，
 * 所以行数预算要够处理完一天的批次。
 */
export const DEFAULT_BUDGET_ROWS = 80;
/**
 * 每次兜底的 prompt token 估算上限。估算公式按 chars/1.5 保守估计：2026-11-21 实测 27 行估算 48645
 * （≈1802 token/行），120000 按这个比例只够约 60-67 行；一天新增约 30-50 行，余量充足。避免因估算
 * 偏保守提前触顶、把行留给已经不覆盖它们的下一轮。
 */
export const DEFAULT_BUDGET_PROMPT_TOKENS = 120_000;
/** 默认只处理最近这么小时内被采集更新过的行（每天 06:10 采集成功后立即兜底，2 小时窗口覆盖整轮采集）。 */
export const DEFAULT_SINCE_HOURS = 2;
/** 与手工回填一致：中文按 1.5 字符约等于 1 token 估算。 */
export const CHARS_PER_TOKEN = 1.5;
/** 单行模型失败重试一次；两次都失败只记失败，不写库。 */
const MAX_ATTEMPTS = 2;
/** 同时最多几个模型调用，与手工回填一致。 */
export const DEFAULT_CONCURRENCY = 3;
/** 兜底最多 80 行模型调用（与 DEFAULT_BUDGET_ROWS 同口径），15 分钟仍未结束视为失败。 */
const CLI_TIMEOUT_MS = 15 * 60_000;
const CLI_MAX_BUFFER = 4 * 1024 * 1024;
export const INCREMENTAL_LLM_CLI = "scripts/backfill-incremental-llm.ts";

export interface IncrementalJobRow {
  id: string;
  title: string;
  raw_text: string;
  degree_raw: string | null;
  experience_raw: string | null;
  skills: string[] | null;
  experience_min_years: number | null;
  experience_max_years: number | null;
  role_family: RoleFamily;
  student_friendly: StudentFriendly;
  normalizer_version: string;
  /** 采集侧写的时间：只用来取窗口，本兜底不改它。 */
  updated_at: string | Date;
}

/** 允许写回 career_jobs 的派生字段；normalizer_version 与 updated_at 由存储实现补齐。 */
export interface LlmNormalizedFields {
  role_family: RoleFamily;
  student_friendly: StudentFriendly;
  skills: string[];
  experience_min_years: number | null;
  experience_max_years: number | null;
}

export interface LlmRequest {
  subject: string;
  system: string;
  user: string;
}

export interface LlmResponse {
  data: unknown;
  usage?: Record<string, unknown> | null;
}

export type LlmCaller = (request: LlmRequest) => Promise<LlmResponse>;

export interface NormalizationResult {
  fields: LlmNormalizedFields;
  /** 后置校验把 ai_product_operations 回退为 unknown。 */
  downgraded: boolean;
  /** 模型给出的技能词映射不到词表、被丢弃的个数。 */
  droppedSkillTerms: number;
}

/**
 * 一行的模型输入与结果解释。实现由 scripts/backfill-incremental-llm.ts 从
 * scripts/backfill-normalizer-llm.ts 引入，保证 cron 与手工回填使用同一套 prompt 与后置校验；
 * merge 抛错（含 schema 非法）即该行失败。
 */
export interface NormalizationSpec {
  system: string;
  user(row: IncrementalJobRow): string;
  merge(row: IncrementalJobRow, data: unknown): NormalizationResult;
}

export interface IncrementalCandidateStore {
  /** 时间窗内更新过、版本不是 LLM 版本、仍有未分类字段的行；新出现的职位优先（first_seen_at 降序）。 */
  listCandidates(since: Date): Promise<IncrementalJobRow[]>;
  /** 只写 role_family / student_friendly / skills / experience_min_years / experience_max_years / normalizer_version / updated_at。 */
  updateLlmFields(id: string, fields: LlmNormalizedFields): Promise<number>;
}

export type BudgetStop = "max_rows" | "max_prompt_tokens";
export type SkipReason = BudgetStop | "cli_failed";

/** 写进 job_runs.detail 的结构：cron 走子进程时原样返回 CLI 的汇总并补上进程信息。 */
export interface IncrementalLlmDetail {
  /** 是否真写库；cron 固定 true，手工 CLI 默认 dry-run。 */
  apply: boolean;
  /** 选行窗口起点（ISO）。 */
  since: string;
  candidates: number;
  called: number;
  changed: number;
  unchanged: number;
  failed: number;
  /** 模型调用次数，含重试。 */
  calls: number;
  retries: number;
  downgraded: number;
  droppedSkillTerms: number;
  usage: { prompt_tokens: number; completion_tokens: number };
  usageMissingCalls: number;
  budget: {
    max_rows: number;
    max_prompt_tokens: number;
    rows: number;
    prompt_tokens_estimated: number;
  };
  stopped_by_budget: BudgetStop | null;
  /** 因预算没被处理的行数与原因；cli_failed 表示兜底子进程本身没跑起来。 */
  skipped: { rows: number; reason: SkipReason | null };
}

function updatedAtMs(value: string | Date): number {
  return value instanceof Date ? value.getTime() : Date.parse(value);
}

/** 与 SQL 选行条件一致：窗口内更新过、版本还不是 LLM 版本、仍有未分类字段。 */
export function isIncrementalCandidate(
  row: Pick<IncrementalJobRow, "role_family" | "student_friendly" | "skills" | "normalizer_version" | "updated_at">,
  since: Date,
): boolean {
  return (
    updatedAtMs(row.updated_at) >= since.getTime() &&
    row.normalizer_version !== LLM_NORMALIZER_VERSION &&
    needsLlmNormalization(row)
  );
}

/** 与 scripts/backfill-normalizer-llm.ts 的 SQL 选行条件保持一致：职族/学生友好度未知或技能为空。 */
export function needsLlmNormalization(
  row: Pick<IncrementalJobRow, "role_family" | "student_friendly" | "skills">,
): boolean {
  return (
    row.role_family === "unknown" ||
    row.student_friendly === "unknown" ||
    row.skills === null ||
    row.skills.length === 0
  );
}

/** prompt token 估算，与手工回填同一套公式（中文约 1.5 字符一个 token）。 */
export function estimatePromptTokens(system: string, user: string): number {
  return Math.ceil((system.length + user.length) / CHARS_PER_TOKEN);
}

function usageOf(usage: Record<string, unknown> | null | undefined): { prompt_tokens: number; completion_tokens: number } {
  const number = (key: string): number => {
    const value = usage?.[key];
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
  };
  return { prompt_tokens: number("prompt_tokens"), completion_tokens: number("completion_tokens") };
}

/** 只暴露错误类别，不把模型原文、JD 或密钥写进日志与 job_runs。 */
function describeFailure(error: unknown): string {
  if (error instanceof Error) {
    const name = error.name !== "Error" ? error.name : error.constructor.name;
    return `调用失败: ${name}`;
  }
  return "调用失败: unknown";
}

/** 版本也要比较：内容相同但版本不同仍要写库，否则下一轮还会被选为候选并重复付费。 */
function alreadyNormalized(row: IncrementalJobRow, fields: LlmNormalizedFields): boolean {
  const listKey = (values: readonly string[]): string => [...new Set(values)].sort().join("\u0000");
  return (
    row.normalizer_version === LLM_NORMALIZER_VERSION &&
    row.role_family === fields.role_family &&
    row.student_friendly === fields.student_friendly &&
    listKey(row.skills ?? []) === listKey(fields.skills) &&
    row.experience_min_years === fields.experience_min_years &&
    row.experience_max_years === fields.experience_max_years
  );
}

export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(Math.max(limit, 1), items.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await worker(items[index]!);
    }
  });
  await Promise.all(runners);
  return results;
}

interface SelectedRow {
  row: IncrementalJobRow;
  user: string;
}

interface RowOutcome {
  status: "ok" | "failed";
  fields?: LlmNormalizedFields;
  unchanged?: boolean;
  downgraded?: boolean;
  droppedSkillTerms?: number;
  usage?: { prompt_tokens: number; completion_tokens: number };
  usageMissingCalls: number;
  calls: number;
  retries: number;
}

async function processRow(
  selected: SelectedRow,
  system: string,
  callLlm: LlmCaller,
  spec: NormalizationSpec,
  log: (line: string) => void,
): Promise<RowOutcome> {
  const { row, user } = selected;
  let calls = 0;
  let retries = 0;
  let usageMissingCalls = 0;
  let lastFailure = "";
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    calls += 1;
    if (attempt > 0) retries += 1;
    let response: LlmResponse;
    try {
      response = await callLlm({ subject: row.id, system, user });
    } catch (error) {
      lastFailure = describeFailure(error);
      usageMissingCalls += 1;
      continue;
    }
    // 调用已经发生（可能已计费）：usage 一律计入汇总，哪怕输出不可用。
    const usage = usageOf(response.usage);
    try {
      const merged = spec.merge(row, response.data);
      log(
        `  ${row.id} | ${row.title} | role: ${row.role_family}→${merged.fields.role_family} | ` +
          `student: ${row.student_friendly}→${merged.fields.student_friendly} | ` +
          `skills: ${(row.skills ?? []).length}→${merged.fields.skills.length} | ` +
          `exp: ${formatRange(row.experience_min_years, row.experience_max_years)}→${formatRange(merged.fields.experience_min_years, merged.fields.experience_max_years)}` +
          (merged.downgraded ? " | downgradedByRule: true" : ""),
      );
      return {
        status: "ok",
        fields: merged.fields,
        unchanged: alreadyNormalized(row, merged.fields),
        downgraded: merged.downgraded,
        droppedSkillTerms: merged.droppedSkillTerms,
        usage,
        usageMissingCalls,
        calls,
        retries,
      };
    } catch (error) {
      lastFailure = describeFailure(error);
      continue;
    }
  }
  log(`  ${row.id} | ${row.title} | ${lastFailure}`);
  return { status: "failed", usageMissingCalls, calls, retries, droppedSkillTerms: 0 };
}

function formatRange(min: number | null, max: number | null): string {
  if (min === null && max === null) return "null";
  return `${min === null ? "?" : min}-${max === null ? "?" : max}`;
}

export interface RunIncrementalOptions {
  since: Date;
  store: IncrementalCandidateStore;
  callLlm: LlmCaller;
  spec: NormalizationSpec;
  apply: boolean;
  maxRows?: number;
  maxPromptTokens?: number;
  concurrency?: number;
  log?: (line: string) => void;
}

/**
 * 核心流程与 IO 解耦：选行、预算、幂等、失败隔离与写回由这里负责，模型与存储由调用方注入。
 * 预算在调用前一次性判定（先按存储给出的顺序挑够行再并发调用），因此同一候选集合的停止点可复现。
 */
export async function runIncrementalLlm(options: RunIncrementalOptions): Promise<IncrementalLlmDetail> {
  const log = options.log ?? (() => {});
  const maxRows = options.maxRows ?? DEFAULT_BUDGET_ROWS;
  const maxPromptTokens = options.maxPromptTokens ?? DEFAULT_BUDGET_PROMPT_TOKENS;
  const candidates = await options.store.listCandidates(options.since);
  log(`候选行: ${candidates.length}（${options.since.toISOString()} 之后更新过、仍有未分类字段）`);

  const selected: SelectedRow[] = [];
  let estimated = 0;
  let stop: BudgetStop | null = null;
  for (const row of candidates) {
    if (selected.length >= maxRows) {
      stop = "max_rows";
      break;
    }
    const user = options.spec.user(row);
    const tokens = estimatePromptTokens(options.spec.system, user);
    if (estimated + tokens > maxPromptTokens) {
      stop = "max_prompt_tokens";
      break;
    }
    selected.push({ row, user });
    estimated += tokens;
  }
  log(
    `预算: 最多 ${maxRows} 行 / ${maxPromptTokens} prompt token，本次调用 ${selected.length} 行，估算 ${estimated} token` +
      (stop === null ? "" : `（触顶 ${stop}，跳过 ${candidates.length - selected.length} 行）`),
  );

  const outcomes = await mapWithConcurrency(selected, options.concurrency ?? DEFAULT_CONCURRENCY, (entry) =>
    processRow(entry, options.spec.system, options.callLlm, options.spec, log),
  );

  const detail: IncrementalLlmDetail = {
    apply: options.apply,
    since: options.since.toISOString(),
    candidates: candidates.length,
    called: selected.length,
    changed: 0,
    unchanged: 0,
    failed: 0,
    calls: 0,
    retries: 0,
    downgraded: 0,
    droppedSkillTerms: 0,
    usage: { prompt_tokens: 0, completion_tokens: 0 },
    usageMissingCalls: 0,
    budget: {
      max_rows: maxRows,
      max_prompt_tokens: maxPromptTokens,
      rows: selected.length,
      prompt_tokens_estimated: estimated,
    },
    stopped_by_budget: stop,
    skipped: { rows: candidates.length - selected.length, reason: stop },
  };

  for (let index = 0; index < outcomes.length; index += 1) {
    const outcome = outcomes[index]!;
    const row = selected[index]!.row;
    detail.calls += outcome.calls;
    detail.retries += outcome.retries;
    detail.usageMissingCalls += outcome.usageMissingCalls;
    detail.droppedSkillTerms += outcome.droppedSkillTerms ?? 0;
    detail.usage.prompt_tokens += outcome.usage?.prompt_tokens ?? 0;
    detail.usage.completion_tokens += outcome.usage?.completion_tokens ?? 0;
    if (outcome.downgraded === true) detail.downgraded += 1;
    if (outcome.status === "failed") {
      detail.failed += 1;
      continue;
    }
    if (outcome.unchanged === true) {
      detail.unchanged += 1;
      continue;
    }
    if (!options.apply || outcome.fields === undefined) {
      detail.changed += 1;
      continue;
    }
    try {
      const updated = await options.store.updateLlmFields(row.id, outcome.fields);
      if (updated > 0) detail.changed += 1;
      else detail.unchanged += 1;
    } catch (error) {
      detail.failed += 1;
      log(`  ${row.id} | ${row.title} | 写库失败: ${describeFailure(error)}`);
    }
  }
  return detail;
}

/** 未开始或没跑起来时的空汇总：cron 失败也写一份形状一致的结构化 detail。 */
export function emptyIncrementalLlmDetail(options: {
  apply: boolean;
  since: Date;
  maxRows: number;
  maxPromptTokens: number;
}): IncrementalLlmDetail {
  return {
    apply: options.apply,
    since: options.since.toISOString(),
    candidates: 0,
    called: 0,
    changed: 0,
    unchanged: 0,
    failed: 0,
    calls: 0,
    retries: 0,
    downgraded: 0,
    droppedSkillTerms: 0,
    usage: { prompt_tokens: 0, completion_tokens: 0 },
    usageMissingCalls: 0,
    budget: {
      max_rows: options.maxRows,
      max_prompt_tokens: options.maxPromptTokens,
      rows: 0,
      prompt_tokens_estimated: 0,
    },
    stopped_by_budget: null,
    skipped: { rows: 0, reason: null },
  };
}

/** 选行 SQL 与写回 SQL 都在这里，保证模块的「只写白名单列」承诺只有一处实现。 */
export class SqlIncrementalJobStore implements IncrementalCandidateStore {
  private readonly client: Sql;

  constructor(client: Sql) {
    this.client = client;
  }

  async listCandidates(since: Date): Promise<IncrementalJobRow[]> {
    return await this.client<IncrementalJobRow[]>`
      SELECT id::text AS id, title, raw_text, degree_raw, experience_raw, skills,
             experience_min_years, experience_max_years, role_family, student_friendly,
             normalizer_version, updated_at
      FROM career_jobs
      WHERE updated_at >= ${since}
        AND normalizer_version IS DISTINCT FROM ${LLM_NORMALIZER_VERSION}
        AND (role_family = 'unknown' OR student_friendly = 'unknown'
             OR skills IS NULL OR skills = '[]'::jsonb)
      -- 新出现的职位优先：预算不够时先补新入库的 unknown，旧职位（每天重新出现）排后面。
      ORDER BY first_seen_at DESC, id`;
  }

  async updateLlmFields(id: string, fields: LlmNormalizedFields): Promise<number> {
    return this.client.begin(async (tx) => {
      const result = await tx`
        UPDATE career_jobs SET
          role_family = ${fields.role_family},
          student_friendly = ${fields.student_friendly},
          skills = ${tx.json(fields.skills as JSONValue)}::jsonb,
          experience_min_years = ${fields.experience_min_years},
          experience_max_years = ${fields.experience_max_years},
          normalizer_version = ${LLM_NORMALIZER_VERSION},
          updated_at = now()
        WHERE id = ${id}
          AND normalizer_version IS DISTINCT FROM ${LLM_NORMALIZER_VERSION}`;
      return result.count;
    });
  }
}

// ===== 定时任务入口：子进程跑 CLI，显式只为本步骤打开模型调用 =====

export type IncrementalLlmCliOutcome = ModelCliOutcome;

export type IncrementalLlmCliRun = (
  args: readonly string[],
  env: NodeJS.ProcessEnv,
) => Promise<IncrementalLlmCliOutcome>;

export interface CronIncrementalOptions {
  budgetRows?: number;
  budgetTokens?: number;
  sinceHours?: number;
  /** 测试注入：替掉真实子进程。 */
  run?: IncrementalLlmCliRun;
  /** 在继承的 worker 环境上追加的变量；MODEL_CALLS_ENABLED=true 始终由本步骤显式写入。 */
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
  now?: () => Date;
}

export interface IncrementalLlmCronDetail extends IncrementalLlmDetail {
  ok: boolean;
  duration_ms: number;
  exit_code: number | null;
  error?: string;
}

/** cron 固定 --apply；预算与窗口由调用方给出，默认值与手工 CLI 一致。 */
export function incrementalLlmArgs(
  options: { budgetRows?: number; budgetTokens?: number; sinceHours?: number; apply?: boolean } = {},
): string[] {
  const args = [
    "--budget-rows",
    String(options.budgetRows ?? DEFAULT_BUDGET_ROWS),
    "--budget-tokens",
    String(options.budgetTokens ?? DEFAULT_BUDGET_PROMPT_TOKENS),
    "--since-hours",
    String(options.sinceHours ?? DEFAULT_SINCE_HOURS),
  ];
  if (options.apply ?? true) args.unshift("--apply");
  return args;
}

/** CLI 的 stdout 最后一行是汇总 JSON（人读日志走 stderr），这里按行倒着找第一条带 candidates 的汇总。 */
export function parseIncrementalLlmDetail(stdout: string): IncrementalLlmDetail | null {
  return parseLastJsonLine<IncrementalLlmDetail>(
    stdout,
    (value) => value !== null && typeof value === "object" && typeof (value as { candidates?: unknown }).candidates === "number",
  );
}

function execCli(args: readonly string[], env: NodeJS.ProcessEnv): Promise<IncrementalLlmCliOutcome> {
  return runModelCli({ script: INCREMENTAL_LLM_CLI, args, env, timeoutMs: CLI_TIMEOUT_MS, maxBuffer: CLI_MAX_BUFFER });
}

function failureDetail(
  options: {
    since: Date;
    maxRows: number;
    maxPromptTokens: number;
    durationMs: number;
    exitCode: number | null;
    error: string;
  },
): IncrementalLlmCronDetail {
  return {
    ...emptyIncrementalLlmDetail({
      apply: true,
      since: options.since,
      maxRows: options.maxRows,
      maxPromptTokens: options.maxPromptTokens,
    }),
    ok: false,
    duration_ms: options.durationMs,
    exit_code: options.exitCode,
    error: options.error,
    skipped: { rows: 0, reason: "cli_failed" },
  };
}

/**
 * 每日 cron 的兜底步骤：以子进程执行 scripts/backfill-incremental-llm.ts --apply，子进程环境里显式
 * MODEL_CALLS_ENABLED=true，worker 自己的环境不变；子进程失败（模型不可用/超时/无 key/崩溃）不抛出，
 * 而是返回结构化 detail 写进 job_runs。
 */
export async function runIncrementalLlmCron(
  options: CronIncrementalOptions = {},
): Promise<IncrementalLlmCronDetail> {
  const startedAt = Date.now();
  const log = options.log ?? (() => {});
  const maxRows = options.budgetRows ?? DEFAULT_BUDGET_ROWS;
  const maxPromptTokens = options.budgetTokens ?? DEFAULT_BUDGET_PROMPT_TOKENS;
  const sinceHours = options.sinceHours ?? DEFAULT_SINCE_HOURS;
  const since = new Date((options.now ?? (() => new Date()))().getTime() - sinceHours * 3_600_000);
  const args = incrementalLlmArgs({ budgetRows: maxRows, budgetTokens: maxPromptTokens, sinceHours });
  const env: NodeJS.ProcessEnv = { ...process.env, ...options.env, MODEL_CALLS_ENABLED: "true" };
  const run = options.run ?? execCli;
  try {
    const outcome = await run(args, env);
    const detail = parseIncrementalLlmDetail(outcome.stdout);
    const durationMs = Date.now() - startedAt;
    if (detail === null) {
      const error =
        outcome.timedOut === true
          ? "兜底子进程超时"
          : `兜底子进程退出码 ${String(outcome.code)}：${outcome.stderr.trim().slice(0, 400) || "没有输出汇总"}`;
      log(error);
      return failureDetail({ since, maxRows, maxPromptTokens, durationMs, exitCode: outcome.code, error });
    }
    const ok = outcome.code === 0;
    if (!ok) log(`兜底子进程未正常退出（码 ${String(outcome.code)}）：${outcome.stderr.trim().slice(0, 400)}`);
    return {
      ...detail,
      ok,
      duration_ms: durationMs,
      exit_code: outcome.code,
      ...(ok ? {} : { error: outcome.stderr.trim().slice(0, 400) || `兜底子进程退出码 ${String(outcome.code)}` }),
    };
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    const message = error instanceof Error ? `兜底子进程启动失败: ${error.name}: ${error.message}` : "兜底子进程启动失败";
    log(message);
    return failureDetail({ since, maxRows, maxPromptTokens, durationMs, exitCode: null, error: message.slice(0, 400) });
  }
}
