// 就业热点三个只读接口（signals / hot / daily）的展示文案与取值口径。
// 纯函数与常量：不依赖服务端模块，客户端组件与 SSR 断言共用同一份口径。
import type { CareerDailyCommentResponseV1, CareerDailySourceV1, CareerHotEntryV1, CareerSignalRule } from "../contracts/index.ts";
import { confidenceLabel } from "./labels.ts";
import { formatCareerDate, formatCareerDateTime } from "./time.ts";

export const SIGNAL_RULE_LABELS: Record<CareerSignalRule, string> = {
  cross_industry: "跨界组合",
  new_family: "新职族首现",
  surge: "数量突增",
  skill_mismatch: "技能错配",
};

export const SIGNAL_EMPTY_TITLE = "当前样本下暂未发现异常信号";
export const SIGNAL_EMPTY_HINT = "需要更多来源与更长历史";

/** “另有 2 家公司因历史不足 2 天暂无法判定突增”. */
export function skippedSurgeNotice(count: number): string {
  return `另有 ${count} 家公司因历史不足 2 天暂无法判定突增`;
}

export const DAILY_SOURCE_STATUS_LABELS: Record<CareerDailySourceV1["status"], string> = {
  ok: "正常",
  partial: "部分失败",
  failed: "失败",
};

export const DAILY_NO_RUN_TEXT = "今日尚未采集";
export const UNKNOWN_RATIO_LABEL = "空技能岗位占比";

/**
 * 日报 AI 评论的一行元信息：生成时间按北京时间可读化，置信度用全站统一文案，
 * 样本与新增数直接取缓存字段（数字由后端算好，前端不重算）。
 */
export function dailyCommentMeta(comment: CareerDailyCommentResponseV1): string {
  const generatedAt = formatCareerDateTime(comment.generated_at) ?? comment.generated_at;
  return `生成于 ${generatedAt} · ${confidenceLabel(comment.confidence)} · 当日观测样本 ${comment.sample_size} 个岗位 · 今日新增 ${comment.new_jobs}`;
}

/** 比率按百分比展示；null 表示样本为空，没有可算的占比。 */
export function formatRatioPercent(value: number | null): string {
  return value === null ? "—" : `${(value * 100).toFixed(1)}%`;
}

/** 热度榜只展示岗位数最多的前 3 个职族。 */
export function topRoleFamilies(entry: CareerHotEntryV1): CareerHotEntryV1["role_families"] {
  return entry.role_families.slice(0, 3);
}

/** 没有发布日期时显示“—”，有则按北京时间的日期或时刻展示。 */
export function publishedAtText(value: string | null): string {
  if (value === null) return "—";
  return formatCareerDate(value) ?? formatCareerDateTime(value) ?? value;
}

export function careerJobHref(jobId: string): string {
  return `/career-insights/jobs/${encodeURIComponent(jobId)}`;
}