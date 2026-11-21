// 每日采集后的增量 LLM 兜底 CLI：只对「--since-hours 窗口内被采集更新过、且仍未分类」的行调用模型。
// node scripts/backfill-incremental-llm.ts                                   默认 dry-run（会真实调用模型，但不写库）
// node scripts/backfill-incremental-llm.ts --apply                           写回派生字段
// node scripts/backfill-incremental-llm.ts --budget-rows 80 --budget-tokens 120000 --since-hours 2 [--apply]
//
// 定时任务（modules/career-insights/server.ts 的 career.ingest，06:10 采集成功后在同一个 job 里串行执行）
// 以子进程方式带 --apply 调用本脚本，并在子进程环境里显式 MODEL_CALLS_ENABLED=true；worker 自己的开关
// 保持原样，所以这一步不会替其它任务打开模型调用。写回只碰 role_family / student_friendly / skills /
// 经验年限 / normalizer_version / updated_at，不写观测、不动 last_seen_at 和 content_hash。
//
// 输出：人读日志与失败说明走 stderr；stdout 只有最后一行 JSON 汇总（写进 job_runs.detail.llm），定时任务直接解析。
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";
import {
  DEFAULT_BUDGET_PROMPT_TOKENS,
  DEFAULT_BUDGET_ROWS,
  DEFAULT_SINCE_HOURS,
  emptyIncrementalLlmDetail,
  runIncrementalLlm,
  SqlIncrementalJobStore,
  type IncrementalLlmDetail,
  type LlmCaller,
  type NormalizationSpec,
} from "../modules/career-insights/backend/llm-incremental.ts";
import { careerStepModel } from "../modules/career-insights/backend/models.ts";
import {
  LLM_MAX_TOKENS,
  LLM_PROMPT_VERSION,
  LLM_PURPOSE,
  LLM_TIMEOUT_MS,
  SYSTEM_PROMPT,
  buildUserPrompt,
  downgradeNonAiOperations,
  llmNormalizationSchema,
  mergeNormalizedFields,
} from "./backfill-normalizer-llm.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");

export interface BackfillArgs {
  /** 默认 dry-run：会调用模型但不写库。 */
  apply: boolean;
  budgetRows: number;
  budgetTokens: number;
  sinceHours: number;
}

export const DEFAULT_BACKFILL_ARGS: BackfillArgs = {
  apply: false,
  budgetRows: DEFAULT_BUDGET_ROWS,
  budgetTokens: DEFAULT_BUDGET_PROMPT_TOKENS,
  sinceHours: DEFAULT_SINCE_HOURS,
};

function positiveInt(flag: string, value: string | undefined): number {
  if (value === undefined || value === "" || value.startsWith("--")) throw new Error(`${flag} 需要一个正整数`);
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1 || String(parsed) !== value) throw new Error(`${flag} 需要一个正整数`);
  return parsed;
}

function intFlag(argv: readonly string[], flag: string, fallback: number): number {
  const index = argv.indexOf(flag);
  return index < 0 ? fallback : positiveInt(flag, argv[index + 1]);
}

/** 与 cron 入口的 incrementalLlmArgs 同一组参数；手工跑与定时跑语义一致。 */
export function parseBackfillArgs(argv: readonly string[]): BackfillArgs {
  return {
    apply: argv.includes("--apply"),
    budgetRows: intFlag(argv, "--budget-rows", DEFAULT_BACKFILL_ARGS.budgetRows),
    budgetTokens: intFlag(argv, "--budget-tokens", DEFAULT_BACKFILL_ARGS.budgetTokens),
    sinceHours: intFlag(argv, "--since-hours", DEFAULT_BACKFILL_ARGS.sinceHours),
  };
}

/**
 * cron 与手工回填共用同一套 prompt、输出 schema、后置校验和合并规则：实现全部来自
 * scripts/backfill-normalizer-llm.ts，这里只把它们接到增量兜底的接口上。
 */
export const careerNormalizationSpec: NormalizationSpec = {
  system: SYSTEM_PROMPT,
  user: (row) => buildUserPrompt(row),
  merge: (row, data) => {
    const parsed = llmNormalizationSchema.parse(data);
    const decision = downgradeNonAiOperations(row, parsed);
    const normalized = decision.downgraded ? { ...parsed, role_family: "unknown" as const } : parsed;
    const merged = mergeNormalizedFields(row, normalized);
    // 后置校验是确定性的，必须压过 mergeNormalizedFields 的“既有已知值不被 unknown 覆盖”保护。
    const fields = decision.downgraded ? { ...merged.fields, role_family: "unknown" as const } : merged.fields;
    return { fields, downgraded: decision.downgraded, droppedSkillTerms: merged.droppedSkillTerms };
  },
};

function printSummary(detail: IncrementalLlmDetail, log: (line: string) => void): void {
  log("");
  log(`汇总（${detail.apply ? "apply" : "dry-run"}，窗口自 ${detail.since}）:`);
  log(`  候选 ${detail.candidates} 行，调用 ${detail.called} 行 / ${detail.calls} 次（重试 ${detail.retries} 次）`);
  log(`  ${detail.apply ? "已更新" : "拟变更"} ${detail.changed} 行，无变化 ${detail.unchanged}，失败 ${detail.failed}`);
  log(`  规则降级 ${detail.downgraded} 行，技能词表映射丢弃 ${detail.droppedSkillTerms} 个词`);
  log(`  usage: prompt_tokens=${detail.usage.prompt_tokens}, completion_tokens=${detail.usage.completion_tokens}`);
  log(
    `  预算: ${detail.budget.rows}/${detail.budget.max_rows} 行，估算 ${detail.budget.prompt_tokens_estimated}/${detail.budget.max_prompt_tokens} prompt token` +
      (detail.stopped_by_budget === null
        ? ""
        : `；触顶 ${detail.stopped_by_budget}，跳过 ${detail.skipped.rows} 行`),
  );
}

function printHelp(): void {
  console.log(`用法: node scripts/backfill-incremental-llm.ts [--apply] [--budget-rows N] [--budget-tokens N] [--since-hours N]`);
  console.log("  默认 dry-run：只处理 --since-hours 窗口内被采集更新过、仍未分类的行，真实调用模型但不写库。");
  console.log(`  --apply：写回派生字段白名单；cron 兜底固定用它。`);
  console.log(`  --budget-rows N：最多调用模型的行数（默认 ${DEFAULT_BUDGET_ROWS}），超出即停止并记录。`);
  console.log(`  --budget-tokens N：prompt token 估算上限（默认 ${DEFAULT_BUDGET_PROMPT_TOKENS}），超出即停止并记录。`);
  console.log(`  --since-hours N：只处理最近 N 小时内被采集更新过的行（默认 ${DEFAULT_SINCE_HOURS}）。`);
  console.log("  需要 MODEL_CALLS_ENABLED=true（cron 子进程会显式设置），否则直接退出。");
}

function loadDotEnvIfPresent(): void {
  const file = path.join(REPO_ROOT, ".env");
  if (!existsSync(file)) return;
  const parsed = parseEnv(readFileSync(file, "utf8"));
  for (const [key, value] of Object.entries(parsed)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

/** 失败也输出形状一致的结构化汇总：cron 的 job_runs.detail 不会因为退出码丢信息。 */
function printFailure(since: Date, args: BackfillArgs, message: string): void {
  const detail = {
    ...emptyIncrementalLlmDetail({
      apply: args.apply,
      since,
      maxRows: args.budgetRows,
      maxPromptTokens: args.budgetTokens,
    }),
    ok: false,
    error: message,
  };
  console.error(`兜底失败: ${message}`);
  process.stdout.write(`${JSON.stringify(detail)}\n`);
  process.exitCode = 2;
}

async function main(): Promise<void> {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    printHelp();
    return;
  }
  let args: BackfillArgs;
  try {
    args = parseBackfillArgs(process.argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
    return;
  }
  loadDotEnvIfPresent();
  const { config } = await import("../packages/backend/src/config.ts");
  const since = new Date(Date.now() - args.sinceHours * 3_600_000);
  if (!config.modelCallsEnabled) {
    printFailure(since, args, "MODEL_CALLS_ENABLED 为 false；cron 子进程会显式打开，手工运行请设置 MODEL_CALLS_ENABLED=true");
    return;
  }

  try {
    const { chatJson } = await import("../packages/backend/src/providers/llm.ts");
    const { sql, closeDb } = await import("../packages/backend/src/db.ts");
    // 兜底这一步的模型：后台切换 > CAREER_LLM_NORMALIZE_MODEL > site/models.ts 的 DEFAULTS。
    const model = await careerStepModel("career.llm-normalize", sql);
    const callLlm: LlmCaller = async ({ subject, system, user }) => {
      const result = await chatJson({
        model,
        purpose: LLM_PURPOSE,
        subject,
        promptVersion: LLM_PROMPT_VERSION,
        system,
        user,
        schema: llmNormalizationSchema,
        temperature: 0,
        maxTokens: LLM_MAX_TOKENS,
        timeoutMs: LLM_TIMEOUT_MS,
      });
      return { data: result.data, usage: result.usage };
    };
    try {
      const detail = await runIncrementalLlm({
        since,
        apply: args.apply,
        maxRows: args.budgetRows,
        maxPromptTokens: args.budgetTokens,
        store: new SqlIncrementalJobStore(sql),
        callLlm,
        spec: careerNormalizationSpec,
        log: (line) => console.error(line),
      });
      printSummary(detail, (line) => console.error(line));
      process.stdout.write(`${JSON.stringify(detail)}\n`);
      if (!detail.apply) console.error("\n未传 --apply，未写库。");
    } finally {
      await closeDb();
    }
  } catch (error) {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : "unknown";
    printFailure(since, args, `运行失败: ${message}`);
  }
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(import.meta.dirname, "backfill-incremental-llm.ts")) {
  await main();
}
