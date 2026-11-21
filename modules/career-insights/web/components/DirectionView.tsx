import { Link } from "react-router";
import type { JobFiltersV1, JobListResponseV1, MetricResultV1, RoleFamily, SummaryResponseV1 } from "@aihot/career-insights/contracts";
import { buildDirectionHref, buildJobHref, buildJobsHref } from "../filters";
import { ROLE_FAMILY_LABELS, skillLabel } from "../labels";
import { CareerTime } from "../time";
import { MetricList } from "./MetricList";
import { SharedThemeList } from "./SharedThemeList";

export const DIRECTION_VALUES: readonly RoleFamily[] = ["ai_algorithm", "ai_application_development", "data", "ai_product_operations"];

const TOP_JOB_LIMIT = 5;

const SCOPE_NOTE = "职位计数与职位列表按所选方向过滤；指标与共享主题为全站口径，暂不按方向过滤。";

const DISCLAIMER = "以上组合基于本次公开样本与 0.1 版词典，不代表完整就业市场或录用概率。";

const UNSPECIFIED_SKILL_LABEL = "未指定技能";

function formatShare(metric: MetricResultV1): string {
  if (metric.status === "not_applicable") return "不适用";
  if (metric.status !== "ok" || metric.value === null) return "数据不足";
  if (metric.unit === "ratio") return `${(metric.value * 100).toFixed(1)}%`;
  return String(metric.value);
}

function SkillMetricItem({ metric, directionHref }: { metric: MetricResultV1; directionHref: string }) {
  const skillId = metric.dimension.skill_id;
  const unknownRatioPercent = metric.unknown_ratio !== undefined && metric.unknown_ratio !== null
    ? `${(metric.unknown_ratio * 100).toFixed(1)}%`
    : undefined;
  const unknownText = [
    metric.unknown_count !== undefined ? `未识别 ${metric.unknown_count} 个` : undefined,
    unknownRatioPercent ? `未识别占比 ${unknownRatioPercent}` : undefined,
  ].filter((part): part is string => part !== undefined).join(" · ");

  return (
    <li data-skill-id={skillId ?? "global"} className="rounded-card border border-line bg-surface p-4">
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
        <h4 className="min-w-0 break-words text-[14px] font-medium text-ink">{skillId ? skillLabel(skillId) : UNSPECIFIED_SKILL_LABEL}</h4>
        <span className="num text-[14px] text-ink-2">{formatShare(metric)}</span>
      </div>

      <dl className="mt-2 space-y-1 text-[12px] text-ink-4">
        <div className="flex gap-2">
          <dt>样本量</dt>
          <dd className="num text-ink-2">{metric.sample_size}</dd>
        </div>
        <div className="flex gap-2">
          <dt>统计时间</dt>
          <dd className="mono text-ink-2"><CareerTime value={metric.as_of} /></dd>
        </div>
      </dl>

      {unknownText && <p className="mt-1 text-[12px] text-ink-4">{unknownText}</p>}

      {metric.disclaimer && <p className="mt-2 break-words text-[12px] leading-relaxed text-ink-3">{metric.disclaimer}</p>}

      {metric.status === "ok" && metric.evidence.length > 0 && (
        <details className="mt-3 border-t border-line pt-2">
          <summary className="cursor-pointer text-[13px] font-medium text-ink-2">证据（{metric.evidence.length}）</summary>
          <ul className="mt-2 space-y-1 text-[12px]">
            {metric.evidence.map((evidence) => (
              <li key={`${evidence.kind}:${evidence.id}`} className="break-words text-ink-2">
                {evidence.kind === "job" ? (
                  <Link to={buildJobHref(evidence.id, directionHref)} className="text-accent">
                    {evidence.title}
                  </Link>
                ) : (
                  <a href={evidence.official_url} target="_blank" rel="noopener noreferrer" className="text-accent">
                    {evidence.title}
                  </a>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
    </li>
  );
}

export function DirectionView({
  roleFamily,
  summary,
  jobs,
  studentFriendlyTotal,
  filters,
}: {
  roleFamily: RoleFamily;
  summary: SummaryResponseV1;
  jobs: JobListResponseV1;
  studentFriendlyTotal: number;
  filters: JobFiltersV1;
}) {
  const skillMetrics = summary.metrics.filter((metric) => metric.metric_id === "skill_demand_share");
  const otherMetrics = summary.metrics.filter((metric) => metric.metric_id !== "skill_demand_share");
  const unknownRoleFamilyCount =
    summary.metrics.find(
      (metric) => metric.metric_id === "job_family_share" && metric.dimension.role_family === "unknown",
    )?.numerator_count ?? 0;
  const directionHref = buildDirectionHref(roleFamily);
  const allJobsHref = buildJobsHref({ ...filters, role_family: roleFamily, page: 1 });

  return (
    <section aria-labelledby="direction-title" className="space-y-6">
      <div>
        <h2 id="direction-title" className="text-[18px] font-semibold text-ink">目标岗位方向：{ROLE_FAMILY_LABELS[roleFamily]}</h2>
        <nav aria-label="切换目标方向" className="mt-3 flex flex-wrap gap-2">
          {DIRECTION_VALUES.map((value) => (
            <Link
              key={value}
              to={buildDirectionHref(value)}
              aria-current={value === roleFamily ? "page" : undefined}
              className="inline-flex h-8 items-center rounded-full border border-line-strong px-3 text-[12px] font-medium text-ink-2 aria-[current=page]:border-accent aria-[current=page]:bg-accent aria-[current=page]:text-accent-contrast"
            >
              {ROLE_FAMILY_LABELS[value]}
            </Link>
          ))}
        </nav>
      </div>

      <p data-scope-note="" className="rounded-card border border-line bg-bg-sunk p-3 text-[12px] leading-relaxed text-ink-3">
        {SCOPE_NOTE}
      </p>

      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[13px] text-ink-3">
        <span className="num">该方向职位 {jobs.total}</span>
        <span className="num">其中学生友好 {studentFriendlyTotal}</span>
        {unknownRoleFamilyCount > 0 && <span className="num">另有 {unknownRoleFamilyCount} 条未分类职位</span>}
      </div>

      <section aria-labelledby="direction-skills">
        <h3 id="direction-skills" className="text-[16px] font-semibold text-ink">技能需求（全站口径）</h3>
        {skillMetrics.length === 0 ? (
          <p className="mt-3 rounded-card border border-line bg-surface p-4 text-[13px] text-ink-3">暂无技能需求数据。</p>
        ) : (
          <ul className="mt-3 grid gap-3 lg:grid-cols-2">
            {skillMetrics.map((metric) => (
              <SkillMetricItem
                key={`${metric.metric_id}:${metric.dimension.skill_id ?? "global"}`}
                metric={metric}
                directionHref={directionHref}
              />
            ))}
          </ul>
        )}
      </section>

      <MetricList metrics={otherMetrics} />

      <SharedThemeList themes={summary.shared_themes} />

      <div>
        <h3 className="text-[16px] font-semibold text-ink">该方向职位</h3>
        {jobs.items.length === 0 ? (
          jobs.total > 0 ? (
            <div className="mt-3 rounded-card border border-line bg-surface p-6 text-center">
              <p className="text-[14px] text-ink-2">当前页没有职位，可能已超出结果页数。</p>
              <Link to={allJobsHref} className="mt-3 inline-flex h-9 items-center rounded-full border border-line-strong px-5 text-[13px] font-medium text-ink-2">
                回到第 1 页
              </Link>
            </div>
          ) : (
            <div className="mt-3 rounded-card border border-line bg-surface p-6 text-center">
              <p className="text-[14px] text-ink-3">该方向暂无职位</p>
              {filters.student_friendly === "yes" && (
                <p className="mt-2 text-[13px] leading-relaxed text-ink-3">本次样本中没有明确标注学生友好的职位。</p>
              )}
            </div>
          )
        ) : (
          <ul className="mt-3 divide-y divide-line-soft overflow-hidden rounded-card border border-line bg-surface">
            {jobs.items.slice(0, TOP_JOB_LIMIT).map((job) => (
              <li key={job.id}>
                <Link to={buildJobHref(job.id, directionHref)} className="block px-4 py-3 transition-colors hover:bg-bg-sunk">
                  <div className="break-words text-[15px] font-semibold text-ink">{job.title}</div>
                  <div className="mt-1 break-words text-[13px] text-ink-3">
                    {job.company_name} · {job.locations.length > 0 ? job.locations.join("、") : "地点未知"}
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
        <Link
          to={allJobsHref}
          className="mt-3 inline-flex h-9 items-center rounded-full border border-line-strong px-5 text-[13px] font-medium text-ink-2"
        >
          查看该方向全部职位
        </Link>
        <p className="mt-3 text-[12px] leading-relaxed text-ink-4">{DISCLAIMER}</p>
      </div>
    </section>
  );
}
