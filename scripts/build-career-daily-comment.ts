// 每日离线生成就业日报 AI 评论并缓存；读者访问 /daily-comment 只读缓存，不触发模型调用。
// node scripts/build-career-daily-comment.ts                     调用模型，并按 (comment_date, prompt_version) upsert 缓存
// node scripts/build-career-daily-comment.ts --json              供每日管线解析：人读日志走 stderr，stdout 只有最后一行 JSON 汇总
// node scripts/build-career-daily-comment.ts --dry-run           调用模型并打印结果，不写库
// node scripts/build-career-daily-comment.ts --date 2026-11-20   指定 Asia/Shanghai 自然日，默认今天
// 需要 MODEL_CALLS_ENABLED=true 与 LLM_* 配置；模型输入只有当日聚合数字、可引用 id 和由此拼出的 facts。
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

import { beijingDate, isValidDate } from "@aihot/contracts/time";
import { z } from "zod";
import {
  CAREER_DAILY_COMMENT_PROMPT_VERSION,
  CAREER_DAILY_COMMENT_PURPOSE,
  CareerCommentValidationError,
  generateCareerDailyComment,
} from "../modules/career-insights/backend/career-daily-comment.ts";
import { careerStepModel } from "../modules/career-insights/backend/models.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const LLM_MAX_TOKENS = 800;
const LLM_TIMEOUT_MS = 120_000;

const careerDailyCommentDraftSchema = z.object({
  comment: z.string(),
  confidence: z.enum(["low", "medium", "high"]),
});

/**
 * --json 模式 stdout 唯一的输出，每日管线（modules/career-insights/server.ts 的 career.ingest）直接解析：
 * - 成功：{"ok":true,"skipped":false,"date":"YYYY-MM-DD","as_of":...,"sample_size":...,"new_jobs":...,"confidence":...,"receipt_id":...,"model":...}
 * - 当日无观测样本：{"ok":true,"skipped":true,"reason":"no_samples"}
 * - 校验失败/异常：{"ok":false,"error":"..."}，退出码非 0
 * 不加 --json 时行为与输出保持可读（人工使用）。
 */
export type CareerDailyCommentScriptSummary =
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
  | { ok: true; skipped: true; reason: "no_samples" }
  | { ok: false; error: string };

/** 汇总只输出一行 JSON：cron 解析 stdout 的最后一行，人读日志一律走 stderr。 */
export function formatCareerDailyCommentSummary(summary: CareerDailyCommentScriptSummary): string {
  return JSON.stringify(summary);
}

function emitSummary(summary: CareerDailyCommentScriptSummary): void {
  process.stdout.write(formatCareerDailyCommentSummary(summary) + "\n");
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.name + ": " + error.message;
  return String(error);
}

function loadDotEnvIfPresent(): void {
  const file = path.join(REPO_ROOT, ".env");
  if (!existsSync(file)) return;
  const parsed = parseEnv(readFileSync(file, "utf8"));
  for (const [key, value] of Object.entries(parsed)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function describeDatabase(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.hostname + ":" + (parsed.port || "5432") + parsed.pathname;
  } catch {
    return "(DATABASE_URL 无法解析)";
  }
}

/** --date 缺省为今天（Asia/Shanghai）：日报评论按自然日缓存，默认点评今天。 */
function dateArg(): string {
  const index = process.argv.indexOf("--date");
  if (index < 0) return beijingDate(new Date());
  const raw = process.argv[index + 1] ?? "";
  if (!isValidDate(raw)) throw new Error("--date 需要一个 YYYY-MM-DD 的日历日期");
  return raw;
}

/** --json 时帮助也走 stderr，保证 stdout 的「只有一行汇总」契约不被 --help 打破。 */
function printHelp(toStderr: boolean): void {
  const write = toStderr ? console.error : console.log;
  write("用法: node scripts/build-career-daily-comment.ts [--date YYYY-MM-DD] [--dry-run] [--json]");
  write("  默认调用模型并按 (comment_date, prompt_version) 写入 career_daily_comments。");
  write("  --date：Asia/Shanghai 自然日，默认今天。");
  write("  --dry-run：调用模型、打印结果，但不写库。");
  write("  --json：人读日志走 stderr，stdout 只输出最后一行 JSON 汇总（每日管线的子进程模式）。");
  write("  需要 MODEL_CALLS_ENABLED=true；当日没有观测样本时不调用模型。");
}

async function run(jsonMode: boolean): Promise<void> {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    printHelp(jsonMode);
    return;
  }
  const dryRun = process.argv.includes("--dry-run");
  const date = dateArg();

  loadDotEnvIfPresent();
  const { config } = await import("../packages/backend/src/config.ts");
  if (!config.modelCallsEnabled) {
    const message = "MODEL_CALLS_ENABLED 为 false。本脚本会真实调用模型；请设置 MODEL_CALLS_ENABLED=true 后再运行。";
    if (jsonMode) emitSummary({ ok: false, error: message });
    else console.error(message);
    process.exitCode = 1;
    return;
  }

  const databaseUrl = process.env.DATABASE_URL?.trim() || config.databaseUrl;
  const { sql, closeDb } = await import("../packages/backend/src/db.ts");
  // --json 时人读日志全部走 stderr，stdout 只留最后一行汇总。
  const log = (line: string): void => {
    if (jsonMode) console.error(line);
    else console.log(line);
  };
  log("=== 就业日报 AI 评论（" + (dryRun ? "dry-run" : "apply") + "） ===");
  log("prompt_version: " + CAREER_DAILY_COMMENT_PROMPT_VERSION);
  log("日期:     " + date);
  log("数据库:   " + describeDatabase(databaseUrl));

  try {
    const { chatJson } = await import("../packages/backend/src/providers/llm.ts");
    // 日报评论这一步的模型：后台切换 > CAREER_DAILY_COMMENT_MODEL > site/models.ts 的 DEFAULTS。
    const model = await careerStepModel("career.daily-comment", sql);
    const record = await generateCareerDailyComment(
      sql,
      async (input, prompt) => {
        const result = await chatJson({
          model,
          purpose: CAREER_DAILY_COMMENT_PURPOSE,
          subject: "career-daily-comment:" + input.date,
          promptVersion: CAREER_DAILY_COMMENT_PROMPT_VERSION,
          system: prompt.system,
          user: prompt.user,
          schema: careerDailyCommentDraftSchema,
          temperature: 0.2,
          maxTokens: LLM_MAX_TOKENS,
          timeoutMs: LLM_TIMEOUT_MS,
        });
        return { draft: result.data, receipt_id: result.receiptId, model: result.model };
      },
      { date, prompt_version: CAREER_DAILY_COMMENT_PROMPT_VERSION, dry_run: dryRun },
    );

    if (record === null) {
      log("当日没有观测样本，未调用模型；等待采集积累当日观测后再生成。");
      if (jsonMode) emitSummary({ ok: true, skipped: true, reason: "no_samples" });
      return;
    }
    log("as_of: " + record.as_of);
    log("样本量: " + record.sample_size + "，当日新增岗位: " + record.new_jobs + "，置信度: " + record.confidence);
    log("评论: " + record.comment);
    if (dryRun) log(JSON.stringify(record, null, 2));
    else log("已写入 career_daily_comments（按 comment_date + prompt_version upsert）。");
    if (jsonMode) {
      emitSummary({
        ok: true,
        skipped: false,
        date: record.date,
        as_of: record.as_of,
        sample_size: record.sample_size,
        new_jobs: record.new_jobs,
        confidence: record.confidence,
        receipt_id: record.receipt_id,
        model: record.model,
      });
    }
  } catch (error) {
    if (error instanceof CareerCommentValidationError) {
      const message = "模型输出不合规，未写库：" + error.message;
      if (jsonMode) emitSummary({ ok: false, error: message });
      else console.error(message);
      process.exitCode = 1;
      return;
    }
    throw error;
  } finally {
    await closeDb();
  }
}

async function main(): Promise<void> {
  const jsonMode = process.argv.includes("--json");
  try {
    await run(jsonMode);
  } catch (error) {
    // 非 --json 保持原样：异常照旧抛出。--json 时把参数错误、连库失败等也收成一行结构化失败，
    // 让每日管线拿到 ok:false 而不是靠退出码猜原因。
    if (!jsonMode) throw error;
    process.exitCode = 1;
    emitSummary({ ok: false, error: describeError(error) });
  }
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
