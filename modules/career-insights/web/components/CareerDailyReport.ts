import { createElement as h, type ReactElement } from "react";
import { Link } from "react-router";
import type { CareerDailyCommentResponseV1, CareerDailyResponseV1, CareerDailySourceV1 } from "../../contracts/index.ts";
import { careerSourceLabel } from "../labels.ts";
import {
  DAILY_NO_RUN_TEXT,
  DAILY_SOURCE_STATUS_LABELS,
  UNKNOWN_RATIO_LABEL,
  dailyCommentMeta,
  formatRatioPercent,
} from "../feeds.ts";

function Figure({ label, value, note }: { label: string; value: string; note?: string }): ReactElement {
  return h(
    "div",
    { className: "text-center" },
    h("div", { className: "text-[12px] text-ink-4" }, label),
    h("div", { className: "num mt-1 text-[20px] font-semibold text-ink" }, value),
    note ? h("div", { className: "mt-1 text-[11.5px] text-ink-4" }, note) : null,
  );
}

function SourceRow({ source }: { source: CareerDailySourceV1 }): ReactElement {
  return h(
    "li",
    { "data-daily-source": source.source_key, className: "grid grid-cols-1 gap-1 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center" },
    h(
      "div",
      { className: "min-w-0" },
      h("div", { className: "text-[14px] font-medium text-ink break-words" }, careerSourceLabel(source.source_key)),
      h(
        "div",
        { className: "mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[12px] text-ink-4" },
        h("span", null, "采集 ", h("span", { className: "num", "data-daily-collected": String(source.collected) }, String(source.collected))),
        h("span", null, "接受 ", h("span", { className: "num", "data-daily-accepted": String(source.accepted) }, String(source.accepted))),
        h("span", null, "更新 ", h("span", { className: "num", "data-daily-updated": String(source.updated) }, String(source.updated))),
        h("span", null, "重复 ", h("span", { className: "num", "data-daily-duplicates": String(source.duplicates) }, String(source.duplicates))),
      ),
    ),
    h(
      "span",
      { "data-daily-status": source.status, className: "text-[12px] text-ink-3" },
      DAILY_SOURCE_STATUS_LABELS[source.status],
    ),
  );
}

/**
 * 后台预生成的 AI 评论：只渲染缓存里的正文与元信息。没有缓存或请求失败时整块不渲染，
 * 由调用方传 null，页面不出现空卡片或占位。comment 可能很长且没有空格，正文按任意位置断行。
 */
function DailyComment({ comment }: { comment: CareerDailyCommentResponseV1 }): ReactElement {
  return h(
    "section",
    {
      "aria-labelledby": "career-daily-comment",
      "data-daily-comment": "",
      "data-daily-comment-date": comment.date,
      "data-daily-comment-confidence": comment.confidence,
      className: "rounded-card border border-line bg-surface p-5",
    },
    h("h2", { id: "career-daily-comment", className: "text-[16px] font-semibold text-ink" }, "AI 评论"),
    h(
      "p",
      {
        "data-daily-comment-body": "",
        className: "mt-3 break-words text-[14px] leading-relaxed text-ink-2 [overflow-wrap:anywhere]",
      },
      comment.comment,
    ),
    h(
      "p",
      { "data-daily-comment-meta": "", className: "mt-3 break-words text-[12px] text-ink-4" },
      dailyCommentMeta(comment),
    ),
  );
}

/** 日报页顶部的报告入口；与 /daily/archive、/weekly、/monthly 页的 REPORT_LINKS 同一份口径。 */
export interface CareerDailyReportLink {
  to: string;
  label: string;
  current?: boolean;
}

export function CareerDailyReport({
  daily,
  comment,
  reportLinks,
}: {
  daily: CareerDailyResponseV1;
  /** 日报 AI 评论缓存；null 表示今天还没生成或请求失败，整块隐藏。 */
  comment?: CareerDailyCommentResponseV1 | null;
  /** 日报/周报/月报/往期的入口行；不传就不渲染（联调与内嵌场景不出现站点导航）。 */
  reportLinks?: readonly CareerDailyReportLink[];
}): ReactElement {
  return h(
    "div",
    { "data-career-daily": "", className: "space-y-6 pb-10 pt-3" },
    h(
      "header",
      null,
      h("h1", { "data-page-title": "", className: "text-[24px] font-semibold text-ink" }, "就业日报"),
      h(
        "p",
        { className: "mt-1 text-[13px] leading-relaxed text-ink-3" },
        h("time", { dateTime: daily.date, "data-daily-date": daily.date, className: "num" }, daily.date),
        " · 采集来源、今日新增与库表概况",
      ),
    ),
    reportLinks !== undefined && reportLinks.length > 0
      ? h(
          "nav",
          { "aria-label": "报告入口", className: "flex flex-wrap gap-2" },
          ...reportLinks.map((link) =>
            h(
              Link,
              {
                key: link.to,
                to: link.to,
                viewTransition: true,
                "aria-current": link.current ? "page" : undefined,
                className: link.current
                  ? "rounded-full bg-accent-soft px-3.5 py-2.5 text-[13px] font-semibold text-accent sm:py-1.5"
                  : "rounded-full border border-line-strong bg-surface px-3.5 py-2.5 text-[13px] text-ink-2 transition-colors hover:border-ink-4 hover:text-ink sm:py-1.5",
              },
              link.label,
            ),
          ),
        )
      : null,
    !daily.has_run
      ? h(
          "div",
          { "data-daily-no-run": "", role: "status", className: "rounded-card border border-line bg-bg-sunk px-4 py-3 text-[13px] font-medium text-ink-2" },
          DAILY_NO_RUN_TEXT,
        )
      : null,
    h(
      "section",
      { "aria-labelledby": "career-daily-figures", className: "rounded-card border border-line bg-surface p-5" },
      h("h2", { id: "career-daily-figures", className: "text-[16px] font-semibold text-ink" }, "今日概况"),
      h(
        "dl",
        { className: "mt-4 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5" },
        h(Figure, { label: "今日新增岗位", value: String(daily.new_jobs_today) }),
        h(Figure, { label: "今日新增政策", value: String(daily.new_policies_today) }),
        h(Figure, { label: "职位库总量", value: String(daily.jobs_total) }),
        h(Figure, { label: "政策库总量", value: String(daily.policies_total) }),
        h(Figure, {
          label: "空技能岗位",
          value: formatRatioPercent(daily.unknown_ratio),
          note: UNKNOWN_RATIO_LABEL,
        }),
      ),
      h("p", { className: "mt-4 text-[12px] text-ink-4" }, `空技能岗位占比按 ${daily.sample_size} 个职位样本计算。`),
    ),
    comment ? h(DailyComment, { comment }) : null,
    h(
      "section",
      { "aria-labelledby": "career-daily-sources" },
      h("div", { className: "mb-3 flex items-baseline justify-between px-1" },
        h("h2", { id: "career-daily-sources", className: "text-[16px] font-semibold text-ink" }, "各来源采集结果"),
        h("span", { className: "num text-[12px] text-ink-4" }, `共 ${daily.sources.length} 个来源`),
      ),
      daily.sources.length === 0
        ? h("div", { "data-daily-sources-empty": "", className: "rounded-card border border-line bg-surface px-5 py-6 text-center text-[13px] text-ink-4" }, "今天还没有任何来源的采集记录。")
        : h(
            "ul",
            { className: "divide-y divide-line-soft overflow-hidden rounded-card border border-line bg-surface" },
            ...daily.sources.map((source) => h(SourceRow, { key: source.source_key, source })),
          ),
    ),
  );
}