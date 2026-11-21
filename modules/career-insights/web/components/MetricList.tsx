import type { MetricResultV1 } from "@aihot/career-insights/contracts";
import { ROLE_FAMILY_LABELS, skillLabel } from "../labels";
import { CareerTime } from "../time";
import { EvidenceList } from "./EvidenceList";

function formatValue(metric: MetricResultV1): string {
  if (metric.status === "insufficient_data") return "数据不足";
  if (metric.status === "not_applicable") return "不适用";
  if (metric.value === null) return "数据不足";
  if (metric.unit === "ratio") return `${(metric.value * 100).toFixed(1)}%`;
  if (metric.unit === "count") return `${metric.value} 个`;
  return String(metric.value);
}

function getMetricKey(metric: MetricResultV1): string {
  const dimensions = [
    metric.dimension.role_family,
    metric.dimension.skill_id,
    metric.dimension.theme_id,
  ].filter((value): value is string => value !== undefined);

  return [metric.metric_id, ...dimensions].join(":");
}

function MetricCard({ metric }: { metric: MetricResultV1 }) {
  const expandable = metric.status === "ok" && metric.evidence.length > 0;
  const unknownRatioPercent = metric.unknown_ratio !== undefined && metric.unknown_ratio !== null
    ? `${(metric.unknown_ratio * 100).toFixed(1)}%`
    : undefined;
  const unknownParts = [
    metric.unknown_count !== undefined ? `未识别 ${metric.unknown_count} 个` : undefined,
    unknownRatioPercent ? `未识别占比 ${unknownRatioPercent}` : undefined,
  ].filter((part): part is string => part !== undefined);
  const unknownText = unknownParts.length > 0 ? unknownParts.join(" · ") : undefined;
  const roleFamily = metric.dimension.role_family;
  const roleFamilyLabel = roleFamily ? ROLE_FAMILY_LABELS[roleFamily] ?? roleFamily : undefined;
  const dimensionSuffix = roleFamily
    ? ROLE_FAMILY_LABELS[roleFamily] ?? roleFamily
    : metric.dimension.skill_id
      ? skillLabel(metric.dimension.skill_id)
      : metric.dimension.theme_id;
  const isUnknownFamily = metric.metric_id === "job_family_share" && roleFamily === "unknown";
  const isStudentFriendly = metric.metric_id === "student_friendly_share";
  const studentUnavailable = isStudentFriendly && (metric.status !== "ok" || metric.sample_size === 0);
  const studentYes = metric.numerator_count ?? 0;
  const studentUnknown = metric.unknown_count ?? 0;
  // 明确非学生友好数由 sample_size − yes − unknown 前端派生，API 未提供该字段；仅用于展示，不回写任何指标。
  const studentNo = Math.max(metric.sample_size - studentYes - studentUnknown, 0);
  const studentNoPercent = metric.sample_size > 0 ? `${((studentNo / metric.sample_size) * 100).toFixed(1)}%` : "—";
  const title = isUnknownFamily ? "未分类职位占比" : metric.label;
  const titleSuffix = isUnknownFamily ? "" : dimensionSuffix ? ` · ${dimensionSuffix}` : "";
  const unknownCoverageText = isUnknownFamily && metric.unknown_count !== undefined
    ? [
        `未分类 ${metric.unknown_count} 个`,
        metric.unknown_ratio !== undefined && metric.unknown_ratio !== null
          ? `占比 ${(metric.unknown_ratio * 100).toFixed(1)}%`
          : undefined,
      ].filter((part): part is string => part !== undefined).join(" · ")
    : unknownText;
  const valueText = isStudentFriendly
    ? studentUnavailable
      ? metric.status === "not_applicable"
        ? "不适用"
        : "数据不足"
      : `${studentYes} 个`
    : formatValue(metric);

  return (
    <article data-metric-id={metric.metric_id} className="rounded-card border border-line bg-surface p-5">
      <h3 className="text-[13px] font-medium text-ink-3">
        {title}
        {titleSuffix}
      </h3>
      <p className="mt-2 text-[26px] font-bold leading-none text-ink">{valueText}</p>

      <dl className="mt-4 space-y-1 text-[12px] text-ink-4">
        <div className="flex gap-2">
          <dt>样本</dt>
          <dd className="text-ink-2">{metric.sample_size}</dd>
        </div>
        <div className="flex gap-2">
          <dt>统计时间</dt>
          <dd className="mono text-ink-2"><CareerTime value={metric.as_of} /></dd>
        </div>

        {roleFamilyLabel !== undefined && !isUnknownFamily && (
          <div className="flex gap-2">
            <dt>方向</dt>
            <dd className="text-ink-2">{roleFamilyLabel}</dd>
          </div>
        )}

        {metric.dictionary_version !== undefined && (
          <div className="flex gap-2">
            <dt>词典</dt>
            <dd className="mono text-ink-2">词典 v{metric.dictionary_version}</dd>
          </div>
        )}
      </dl>

      {isStudentFriendly ? (
        !studentUnavailable && (
          <div className="mt-1 space-y-1 text-[12px] text-ink-4">
            <p>明确标注学生友好的职位：{studentYes} 个（{metric.sample_size} 条中 {studentUnknown} 条未标注）</p>
            {studentYes === 0 && <p>当前窗口暂无明确标注学生友好的样本。</p>}
            <p>明确非学生友好 {studentNo}（{studentNoPercent}）</p>
          </div>
        )
      ) : (
        unknownCoverageText !== undefined && <p className="mt-1 text-[12px] text-ink-4">{unknownCoverageText}</p>
      )}

      {isUnknownFamily && (
        <p className="mt-1 text-[12px] text-ink-4">未分类（unknown）表示未归入四个方向，不代表存在该职族。</p>
      )}

      <p className="mt-4 text-[12px] leading-relaxed text-ink-3">{metric.disclaimer}</p>

      {expandable && (
        <details className="mt-4 border-t border-line pt-3">
          <summary className="cursor-pointer text-[13px] font-medium text-ink-2">证据（{metric.evidence.length}）</summary>
          <EvidenceList evidence={metric.evidence} />
        </details>
      )}
    </article>
  );
}

export function MetricList({ metrics }: { metrics: MetricResultV1[] }) {
  if (metrics.length === 0) return null;

  return (
    <div className="grid gap-4 sm:grid-cols-2">
{metrics.map((metric) => (
        <MetricCard key={getMetricKey(metric)} metric={metric} />
      ))}
    </div>
  );
}
