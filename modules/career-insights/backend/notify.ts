// 就业日报推送（默认关闭）：每天 06:30（Asia/Shanghai）把当天的就业日报摘要（日期、新增岗位/政策、
// 要闻与方向 Top3）和站内链接，通过消息引擎现有的飞书自定义机器人 webhook 发到群里。
//
// 开关与地址都从环境变量读：CAREER_PUSH_ENABLED=true 且 CAREER_PUSH_WEBHOOK_URL 非空时才发；默认关着，
// 没配 webhook 时只往 worker 日志写一条，不报错、不发任何请求。数据只读每日聚合（与 AI 评论共用
// loadDailyCommentInput），不调用模型，也不碰页面路由。
//
// 本文件是独立的能力对象，由 server.ts 把 careerPushDailySchedule() 接进 worker 的 schedules：
//   { name: "career.push-daily", cron: "30 6 * * *", missed: "once" }
// 开关在 run 里再判一次，所以关着时任务照常到点、记一条 skipped，不会因为改配置而需要重启。
import { beijingDate } from "@aihot/contracts/time";
import { sql } from "@aihot/backend/db";
import type { Scheduled } from "@aihot/backend/modules";
import { config } from "@aihot/backend/config";
import { sendWebhook } from "@aihot/backend/notify/feishu";
import { loadDailyCommentInput } from "./career-daily-comment.ts";
import { ROLE_FAMILY_LABELS } from "../data/dictionaries.ts";

export const CAREER_PUSH_SCHEDULE = "career.push-daily";
export const CAREER_PUSH_CRON = "30 6 * * *";
/** 推送里的站内入口；日报页是 /daily（就业日报），其余是 career-insights 模块的索引页。 */
export const CAREER_PUSH_PATHS = {
  daily: "/daily",
  insights: "/career-insights",
  jobs: "/career-insights/jobs",
  policies: "/career-insights/policies",
} as const;

/** 推送摘要：只放日报读者需要的少量数字与标题，不包含 URL 以外的原文。 */
export interface CareerPushSummary {
  /** Asia/Shanghai 自然日（YYYY-MM-DD）。 */
  date: string;
  new_jobs: number;
  new_policies: number;
  /** 当日有观测的岗位样本数。 */
  sample_size: number;
  /** 要闻：当天新增政策（标题 + 发布机构），与 AI 评论的输入同口径。 */
  headlines: Array<{ title: string; from: string }>;
  /** 方向 Top3（与日报点评同口径，unknown 不进榜单）。 */
  directions: Array<{ label: string; count: number }>;
  /** 岗位 Top3（按标题聚合）。 */
  titles: Array<{ title: string; count: number }>;
}

export type CareerPushSend = (url: string, message: unknown) => Promise<{ status: "sent" | "failed" | "unknown"; body: string }>;

export interface CareerPushDeps {
  env?: NodeJS.ProcessEnv;
  /** 推送的“今天”，默认 now；测试注入固定日期。 */
  now?: Date;
  /** 站内链接的根，默认 config.siteUrl（SITE_URL）。 */
  siteUrl?: string;
  /** 读当日聚合；默认查库，测试注入固定摘要。 */
  load?: (date: string) => Promise<CareerPushSummary>;
  /** 发送；默认引擎的 notify/feishu.sendWebhook（自定义机器人 webhook）。 */
  send?: CareerPushSend;
  log?: (line: string) => void;
}

export interface CareerPushResult {
  ok: boolean;
  skipped: boolean;
  reason?: "disabled" | "no_webhook";
  date?: string;
  new_jobs?: number;
  new_policies?: number;
  webhook_status?: "sent" | "failed" | "unknown";
  bytes?: number;
}

/** 只认 true，与站点其它安全阀一致。 */
export function careerPushEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CAREER_PUSH_ENABLED === "true";
}

/** 飞书群自定义机器人的 webhook 地址；不配就只 log。 */
export function careerPushWebhook(env: NodeJS.ProcessEnv = process.env): string | null {
  const url = env.CAREER_PUSH_WEBHOOK_URL?.trim();
  return url ? url : null;
}

/** 当天的摘要，数字与政策标题来自每日聚合（没有当天数据时都是 0 / 空数组）。 */
export async function loadCareerPushSummary(date: string): Promise<CareerPushSummary> {
  const input = await loadDailyCommentInput(sql, date);
  return {
    date: input.date,
    new_jobs: input.new_jobs,
    new_policies: input.new_policy_count,
    sample_size: input.sample_size,
    headlines: input.new_policies.map((policy) => ({ title: policy.title, from: policy.issuer })),
    directions: input.directions.map((entry) => ({ label: ROLE_FAMILY_LABELS[entry.role_family], count: entry.job_count })),
    titles: input.titles.map((entry) => ({ title: entry.title, count: entry.job_count })),
  };
}

/** 飞书文本消息的内容（纯文本，自定义机器人直接收；不用卡片，群里复制链接方便）。 */
export function formatCareerPushText(summary: CareerPushSummary, siteUrl: string): string {
  const base = siteUrl.replace(/\/+$/, "");
  const lines = [
    `【就业日报】${summary.date}（北京时间）`,
    `今日新增岗位 ${summary.new_jobs} 个 · 新增政策 ${summary.new_policies} 条` +
      (summary.sample_size > 0 ? `｜当日样本 ${summary.sample_size} 个岗位` : ""),
    "",
    "要闻",
  ];
  for (const headline of summary.headlines) lines.push(`· 政策：${headline.title}（${headline.from}）`);
  if (summary.directions.length > 0) {
    lines.push(`· 方向：${summary.directions.map((entry) => `${entry.label} ${entry.count} 个岗位`).join("；")}`);
  }
  if (summary.titles.length > 0) {
    lines.push(`· 岗位：${summary.titles.map((entry) => `${entry.title} ${entry.count} 个岗位`).join("；")}`);
  }
  if (summary.headlines.length === 0 && summary.directions.length === 0 && summary.titles.length === 0) {
    lines.push("今日暂无新增岗位与政策。");
  }
  lines.push(
    "",
    `完整日报：${base}${CAREER_PUSH_PATHS.daily}`,
    `职业洞察：${base}${CAREER_PUSH_PATHS.insights}`,
    `岗位目录：${base}${CAREER_PUSH_PATHS.jobs}`,
    `政策文件：${base}${CAREER_PUSH_PATHS.policies}`,
  );
  return lines.join("\n");
}

function logLine(level: "info" | "warn", msg: string, fields: Record<string, unknown> = {}): string {
  return JSON.stringify({ level, msg, ...fields });
}

/**
 * 发一次就业日报推送。默认关闭：未打开开关或没配 webhook 都返回 skipped、只记日志、不发请求；
 * 发送失败（HTTP 非 2xx 或机器人未确认）抛错，让 job_runs 里能看见，下一次自动重试（retryLimit 1 + missed once）。
 */
export async function runCareerPushDaily(deps: CareerPushDeps = {}): Promise<CareerPushResult> {
  const env = deps.env ?? process.env;
  const log = deps.log ?? ((line: string) => console.log(line));
  if (!careerPushEnabled(env)) {
    log(logLine("info", `${CAREER_PUSH_SCHEDULE} skipped: CAREER_PUSH_ENABLED is off`));
    return { ok: true, skipped: true, reason: "disabled" };
  }
  const webhook = careerPushWebhook(env);
  if (webhook === null) {
    log(logLine("info", `${CAREER_PUSH_SCHEDULE} skipped: CAREER_PUSH_WEBHOOK_URL is empty (only logging)`));
    return { ok: true, skipped: true, reason: "no_webhook" };
  }

  const now = deps.now ?? new Date();
  const date = beijingDate(now);
  const summary = await (deps.load ?? loadCareerPushSummary)(date);
  const text = formatCareerPushText(summary, deps.siteUrl ?? config.siteUrl);
  const result = await (deps.send ?? sendWebhook)(webhook, { msg_type: "text", content: { text } });
  if (result.status !== "sent") {
    throw new Error(`就业日报推送失败（${result.status}）：${result.body.slice(0, 300) || "没有响应内容"}`);
  }
  log(logLine("info", `${CAREER_PUSH_SCHEDULE} sent`, { date, new_jobs: summary.new_jobs, new_policies: summary.new_policies, chars: text.length }));
  return {
    ok: true,
    skipped: false,
    date,
    new_jobs: summary.new_jobs,
    new_policies: summary.new_policies,
    webhook_status: "sent",
    bytes: Buffer.byteLength(text),
  };
}

/**
 * 能力对象：由 server.ts 接进 schedules，与 career.ingest 并列（每天 06:30，漏跑只补一次）。
 * 开关在 run 内部判断，所以关着时任务仍会到点并记 skipped，不会留下“改配置要重启”的坑。
 */
export function careerPushDailySchedule(deps: CareerPushDeps = {}): Scheduled {
  return { name: CAREER_PUSH_SCHEDULE, cron: CAREER_PUSH_CRON, missed: "once", run: () => runCareerPushDaily(deps) };
}
