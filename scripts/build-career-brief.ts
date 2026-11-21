// 每日离线生成学生就业三层研判（事实/推断/建议）并缓存；读者访问 /brief 只读缓存，不触发模型调用。
// node scripts/build-career-brief.ts                    调用模型，并按 (as_of, prompt_version) upsert 缓存
// node scripts/build-career-brief.ts --json             供每日管线解析：人读日志走 stderr，stdout 只有最后一行 JSON 汇总
// node scripts/build-career-brief.ts --dry-run          调用模型并打印结果，不写库
// node scripts/build-career-brief.ts --window-days 30 --limit 6
// 需要 MODEL_CALLS_ENABLED=true 与 LLM_* 配置；模型输入只有聚合指标、时间窗、样本量和可引用 id。
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

import { z } from "zod";
import {
  CAREER_BRIEF_PROMPT_VERSION,
  CAREER_BRIEF_PURPOSE,
  CareerBriefValidationError,
  generateCareerBrief,
} from "../modules/career-insights/backend/brief.ts";
import {
  DEFAULT_CATALOG_LIMIT,
  DEFAULT_CATALOG_WINDOW_DAYS,
  MAX_CATALOG_LIMIT,
  MAX_CATALOG_WINDOW_DAYS,
} from "../modules/career-insights/backend/career-catalog.ts";
import { careerStepModel } from "../modules/career-insights/backend/models.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const LLM_MAX_TOKENS = 2000;
const LLM_TIMEOUT_MS = 120_000;

const careerBriefDraftSchema = z.object({
  facts: z.array(z.string()),
  inferences: z.array(z.string()),
  actions: z.array(z.string()),
  limitations: z.array(z.string()),
  confidence: z.enum(["low", "medium", "high"]),
  evidence: z.array(z.object({ kind: z.enum(["job", "policy"]), id: z.string(), title: z.string() })).default([]),
});

/**
 * --json 模式 stdout 唯一的输出，每日管线（modules/career-insights/server.ts 的 career.ingest）直接解析：
 * - 成功：{"ok":true,"as_of":...,"sample_size":...,"observation_days":...,"confidence":...,"receipt_id":...,"model":...,"skipped":false}
 * - 无岗位样本：{"ok":true,"skipped":true,"reason":"no_samples"}
 * - 校验失败/异常：{"ok":false,"error":"..."}，退出码非 0
 * 不加 --json 时行为与输出保持原样（人工使用）。
 */
export type CareerBriefScriptSummary =
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
  | { ok: true; skipped: true; reason: "no_samples" }
  | { ok: false; error: string };

/** 汇总只输出一行 JSON：cron 解析 stdout 的最后一行，人读日志一律走 stderr。 */
export function formatCareerBriefSummary(summary: CareerBriefScriptSummary): string {
  return JSON.stringify(summary);
}

function emitSummary(summary: CareerBriefScriptSummary): void {
  process.stdout.write(formatCareerBriefSummary(summary) + "\n");
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

function positiveIntArg(name: string, fallback: number, maximum: number): number {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const raw = process.argv[index + 1] ?? "";
  const value = Number.parseInt(raw, 10);
  if (!/^[1-9][0-9]*$/.test(raw) || !Number.isSafeInteger(value) || value > maximum) {
    throw new Error(name + " 需要一个 1-" + maximum + " 的整数");
  }
  return value;
}

/** --json 时帮助也走 stderr，保证 stdout 的「只有一行汇总」契约不被 --help 打破。 */
function printHelp(toStderr: boolean): void {
  const write = toStderr ? console.error : console.log;
  write("用法: node scripts/build-career-brief.ts [--dry-run] [--json] [--window-days N] [--limit N]");
  write("  默认调用模型并按 (as_of, prompt_version) 写入 career_briefs。");
  write("  --dry-run：调用模型、打印结果，但不写库。");
  write("  --json：人读日志走 stderr，stdout 只输出最后一行 JSON 汇总（每日管线的子进程模式）。");
  write("  --window-days：观察窗，默认 " + DEFAULT_CATALOG_WINDOW_DAYS + "，上限 " + MAX_CATALOG_WINDOW_DAYS + "。");
  write("  --limit：方向榜/职位榜条数，默认 " + DEFAULT_CATALOG_LIMIT + "，上限 " + MAX_CATALOG_LIMIT + "。");
  write("  需要 MODEL_CALLS_ENABLED=true；尚无岗位样本时不调用模型。");
}

async function run(jsonMode: boolean): Promise<void> {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    printHelp(jsonMode);
    return;
  }
  const dryRun = process.argv.includes("--dry-run");
  const windowDays = positiveIntArg("--window-days", DEFAULT_CATALOG_WINDOW_DAYS, MAX_CATALOG_WINDOW_DAYS);
  const limit = positiveIntArg("--limit", DEFAULT_CATALOG_LIMIT, MAX_CATALOG_LIMIT);

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
  log("=== 学生就业研判（" + (dryRun ? "dry-run" : "apply") + "） ===");
  log("prompt_version: " + CAREER_BRIEF_PROMPT_VERSION);
  log("数据库:   " + describeDatabase(databaseUrl));

  try {
    const { chatJson } = await import("../packages/backend/src/providers/llm.ts");
    // 研判这一步的模型：后台切换 > CAREER_BRIEF_MODEL > site/models.ts 的 DEFAULTS。
    const model = await careerStepModel("career.brief", sql);
    const record = await generateCareerBrief(
      sql,
      async (input, prompt) => {
        const result = await chatJson({
          model,
          purpose: CAREER_BRIEF_PURPOSE,
          subject: "career-brief:" + input.as_of,
          promptVersion: CAREER_BRIEF_PROMPT_VERSION,
          system: prompt.system,
          user: prompt.user,
          schema: careerBriefDraftSchema,
          temperature: 0.2,
          maxTokens: LLM_MAX_TOKENS,
          timeoutMs: LLM_TIMEOUT_MS,
        });
        return { draft: result.data, receipt_id: result.receiptId, model: result.model };
      },
      { limit, window_days: windowDays, prompt_version: CAREER_BRIEF_PROMPT_VERSION, dry_run: dryRun },
    );

    if (record === null) {
      log("尚无岗位样本，未调用模型；等待采集积累观测日后再生成。");
      if (jsonMode) emitSummary({ ok: true, skipped: true, reason: "no_samples" });
      return;
    }
    log("as_of: " + record.as_of);
    log("观测日: " + record.observation_days + "，样本量: " + record.sample_size + "，置信度: " + record.confidence);
    if (dryRun) log(JSON.stringify(record, null, 2));
    else log("已写入 career_briefs（按 as_of + prompt_version upsert）。");
    if (jsonMode) {
      emitSummary({
        ok: true,
        as_of: record.as_of,
        sample_size: record.sample_size,
        observation_days: record.observation_days,
        confidence: record.confidence,
        receipt_id: record.receipt_id,
        model: record.model,
        skipped: false,
      });
    }
  } catch (error) {
    if (error instanceof CareerBriefValidationError) {
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
