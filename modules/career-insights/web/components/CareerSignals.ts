// 异常信号卡：四条规则（跨界组合 / 新职族首现 / 数量突增 / 技能错配）的展示口径。
// 每条信号都带后端算好的数字依据、中文理由与官方原文链接；skipped 按 rule 分组统一提示。
import { createElement as h, type ReactElement } from "react";
import { Link } from "react-router";
import type { CareerSignalSkippedV1, CareerSignalV1 } from "../../contracts/index.ts";
import { SIGNAL_EMPTY_HINT, SIGNAL_EMPTY_TITLE, SIGNAL_RULE_LABELS, careerJobHref, formatRatioPercent, skippedSurgeNotice } from "../feeds.ts";
import { careerSourceLabel, confidenceLabel, localizeDomainTerms, ROLE_FAMILY_LABELS } from "../labels.ts";
import { formatCareerDateTime } from "../time.ts";

const BADGE_CLASS = "inline-flex h-5 shrink-0 items-center rounded-full bg-amber-soft px-2 text-[11px] font-medium leading-none text-amber-ink";
const MUTED_CLASS = "mt-1 text-[12px] leading-relaxed text-ink-4 break-words";
const SOURCE_LINK_CLASS = "text-[12px] font-medium text-accent hover:underline";

/** 把后端 evidence 里该规则用到的数字转成可读依据；契约没给的字段不硬凑，避免编造数字。 */
export function signalEvidenceFacts(signal: CareerSignalV1): string[] {
  const evidence = signal.evidence;
  const facts: string[] = [];

  if (signal.rule === "cross_industry") {
    if (evidence.company_job_count !== undefined && evidence.ai_family_job_count !== undefined) {
      const ratio = evidence.ai_family_ratio !== undefined ? ` · 占比 ${formatRatioPercent(evidence.ai_family_ratio)}` : "";
      facts.push(`公司岗位 ${evidence.company_job_count} 个 · AI 族 ${evidence.ai_family_job_count} 个${ratio}`);
    }
    if (evidence.matched_terms !== undefined && evidence.matched_terms.length > 0) {
      facts.push(`命中跨界词：${evidence.matched_terms.join("、")}`);
    }
  } else if (signal.rule === "new_family") {
    if (evidence.role_family !== undefined) facts.push(`新职族：${ROLE_FAMILY_LABELS[evidence.role_family]}`);
    if (evidence.family_job_count !== undefined) facts.push(`窗口内 ${evidence.family_job_count} 个`);
    if (evidence.window_days !== undefined) facts.push(`观察窗 ${evidence.window_days} 天`);
    const earliest = evidence.earliest_first_seen_at !== undefined ? formatCareerDateTime(evidence.earliest_first_seen_at) : null;
    if (earliest !== null) facts.push(`最早出现 ${earliest}`);
  } else if (signal.rule === "surge") {
    if (evidence.last_24h_jobs !== undefined) facts.push(`24 小时新增 ${evidence.last_24h_jobs} 个`);
    if (evidence.history_days !== undefined && evidence.history_daily_average !== undefined) {
      facts.push(`历史 ${evidence.history_days} 天日均 ${evidence.history_daily_average} 个`);
    }
    if (evidence.surge_ratio !== undefined) {
      facts.push(evidence.surge_ratio === null ? "历史日均无新增记录" : `为历史日均的 ${evidence.surge_ratio} 倍`);
    }
  } else if (signal.rule === "skill_mismatch") {
    if (evidence.matched_title_terms !== undefined && evidence.matched_title_terms.length > 0) {
      facts.push(`标题词：${evidence.matched_title_terms.join("、")}`);
    }
    if (evidence.matched_skill_terms !== undefined && evidence.matched_skill_terms.length > 0) {
      facts.push(`技能词：${evidence.matched_skill_terms.join("、")}`);
    }
  }

  return facts;
}

function SignalItem({ signal }: { signal: CareerSignalV1 }): ReactElement {
  // 旧缓存里的理由与证据可能带内部 ID（职族/技能/字段名），显示前统一中文化。
  const facts = signalEvidenceFacts(signal).map(localizeDomainTerms);
  return h(
    "li",
    { "data-signal-item": signal.rule, className: "px-4 py-3.5" },
    h(
      "div",
      { className: "flex flex-wrap items-center gap-x-2 gap-y-1" },
      h("span", { "data-signal-rule": signal.rule, className: BADGE_CLASS }, SIGNAL_RULE_LABELS[signal.rule]),
      h("span", { "data-signal-company": signal.company, className: "text-[12px] text-ink-4 break-words" }, signal.company),
      h("span", { "data-signal-confidence": signal.confidence, className: "text-[11px] text-ink-4" }, confidenceLabel(signal.confidence)),
    ),
    h(
      "h3",
      { className: "mt-1 text-[15px] font-semibold text-ink break-words" },
      h(Link, { to: careerJobHref(signal.job_id), className: "transition-colors hover:text-accent" }, h("span", { "data-signal-title": signal.job_title }, signal.job_title)),
    ),
    h("p", { "data-signal-reason": signal.rule, className: "mt-1 text-[13px] leading-relaxed text-ink-3 break-words" }, localizeDomainTerms(signal.reason_text)),
    facts.length > 0
      ? h("p", { "data-signal-evidence": signal.rule, className: MUTED_CLASS }, `数字依据：${facts.join(" · ")}`)
      : null,
    h(
      "div",
      { className: "mt-1 flex flex-wrap items-center gap-x-3 gap-y-1" },
      h("span", { className: "text-[11px] text-ink-4 break-words" }, `来源 ${careerSourceLabel(signal.source_key)}`),
      h("a", { href: signal.official_url, target: "_blank", rel: "noopener noreferrer", "data-signal-source": signal.rule, className: SOURCE_LINK_CLASS }, "官方原文"),
    ),
  );
}

function skippedNotice(skipped: readonly CareerSignalSkippedV1[]): string {
  const counts = new Map<CareerSignalSkippedV1["rule"], number>();
  for (const entry of skipped) counts.set(entry.rule, (counts.get(entry.rule) ?? 0) + 1);
  return [...counts.entries()].map(([rule, count]) => (
    rule === "surge"
      ? skippedSurgeNotice(count)
      : `另有 ${count} 家公司因历史不足 2 天暂无法判定${SIGNAL_RULE_LABELS[rule]}`
  )).join("；");
}

/** 只渲染列表与 skipped 提示，不带 section 标题；洞察页负责把它放进第 2 段。 */
export function CareerSignalItems({ signals, skipped }: { signals: readonly CareerSignalV1[]; skipped: readonly CareerSignalSkippedV1[] }): ReactElement {
  return h(
    "div",
    { "data-signal-list": "", className: "mt-3" },
    signals.length === 0
      ? h(
          "div",
          { "data-signals-empty": "", role: "status", className: "rounded-card border border-line-soft bg-bg-sunk px-4 py-5 text-center" },
          h("p", { className: "text-[14px] font-medium text-ink-2" }, SIGNAL_EMPTY_TITLE),
          h("p", { className: "mt-1 text-[12.5px] text-ink-4" }, SIGNAL_EMPTY_HINT),
        )
      : h(
          "ul",
          { className: "divide-y divide-line-soft overflow-hidden rounded-card border border-line-soft" },
          ...signals.map((signal) => h(SignalItem, { key: `${signal.rule}:${signal.job_id}:${signal.company}`, signal })),
        ),
    skipped.length > 0
      ? h("p", { "data-signals-skipped": String(skipped.length), className: "mt-3 text-[12px] text-ink-4 break-words" }, skippedNotice(skipped))
      : null,
  );
}
