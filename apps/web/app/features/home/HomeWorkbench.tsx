// 首页只回答「今天有什么机会、有什么变化」：五段——今日概览、AI 就业研判、
// 需求变化三指标、最新就业日报摘要与入口、热门方向 Top 3 入口。
// 完整事实/限制/信号、方向与职位完整榜、技能榜只在洞察页与岗位页出现一次。
// 每个区块独立降级——某一接口失败只让该区块显示「本区块暂时不可用」，其余照常渲染。
import type { ReactNode } from "react";
import { Link } from "react-router";
import type {
  CareerCatalogResponseV1,
  CareerDailyResponseV1,
  CareerDirectionV1,
  SummaryResponseV1,
} from "@aihot/career-insights/contracts";
import { ROLE_FAMILY_LABELS, confidenceLabel } from "../../../../../modules/career-insights/web/labels.ts";
import { UNKNOWN_RATIO_LABEL, formatRatioPercent } from "../../../../../modules/career-insights/web/feeds.ts";
import { CareerTime } from "../../../../../modules/career-insights/web/time.ts";
import type { HomeBriefState } from "./contracts.ts";
import { HOME_BRIEF_LIMIT, HOME_CATALOG_LIMIT } from "./contracts.ts";
import {
  BLOCK_UNAVAILABLE,
  BLOCK_UNAVAILABLE_HINT,
  KEEP_OBSERVING,
  KEEP_OBSERVING_HINT,
  homeIndicators,
} from "./view.ts";

const SECTION_CLASS = "rounded-card border border-line bg-surface p-5";
const JOBS_CATALOG_HREF = "/career-insights/jobs";

/** 区块级降级：不整页失败，也不隐藏其它区块。 */
function Unavailable({ title }: { title: string }) {
  return (
    <div role="status" className="mt-3 rounded-card border border-line-soft bg-bg-sunk px-4 py-4">
      <p className="text-[13px] font-medium text-ink-2">{title}：{BLOCK_UNAVAILABLE}</p>
      <p className="mt-1 text-[12px] leading-relaxed text-ink-4 break-words">{BLOCK_UNAVAILABLE_HINT}</p>
    </div>
  );
}

function SectionHeader({ id, title, aside }: { id: string; title: string; aside?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      <h2 id={id} className="text-[16px] font-semibold text-ink">{title}</h2>
      {aside}
    </div>
  );
}

/** 今日概览：as_of / 样本量 / 来源 / 观察窗。 */
function Overview({ summary, catalog }: { summary: SummaryResponseV1 | null; catalog: CareerCatalogResponseV1 | null }) {
  return (
    <section aria-labelledby="home-overview" className={SECTION_CLASS}>
      <SectionHeader
        id="home-overview"
        title="今日概览"
        aside={<span className="text-[12px] text-ink-4 break-words">{catalog ? `观察窗 ${catalog.window_days} 天` : "观察窗 —"}</span>}
      />
      {summary === null ? (
        <Unavailable title="今日概览" />
      ) : (
        <>
          <dl className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
            <div>
              <dt className="text-[12px] text-ink-4">有效岗位</dt>
              <dd className="num mt-1 text-[22px] font-semibold text-ink">{summary.sample_size}</dd>
            </div>
            <div>
              <dt className="text-[12px] text-ink-4">招聘企业</dt>
              <dd className="num mt-1 text-[22px] font-semibold text-ink">{summary.company_count}</dd>
            </div>
            <div>
              <dt className="text-[12px] text-ink-4">采集来源</dt>
              <dd className="num mt-1 text-[22px] font-semibold text-ink">{summary.source_count}</dd>
            </div>
            <div>
              <dt className="text-[12px] text-ink-4">数据截至</dt>
              <dd className="mt-1 text-[13px] font-medium text-ink-2"><CareerTime value={summary.as_of} /></dd>
            </div>
          </dl>
          {!summary.has_multiple_snapshots && (
            <p className="mt-3 text-[12px] leading-relaxed text-ink-4 break-words">
              当前只有一次观测；新增岗位与变化趋势的数据不足，不作趋势推断。
            </p>
          )}
        </>
      )}
    </section>
  );
}

/** 结论列表：只展示前几条；没有内容时退回「继续积累观测」。 */
function ConclusionList({ lines, limit }: { lines: readonly string[]; limit: number }) {
  if (lines.length === 0) return <p className="mt-2 text-[13px] text-ink-3">{KEEP_OBSERVING}</p>;
  return (
    <ul className="mt-2 space-y-1.5 text-[13px] leading-relaxed text-ink-2">
      {lines.slice(0, limit).map((line) => <li key={line} className="break-words">{line}</li>)}
    </ul>
  );
}

/** AI 就业研判：只留趋势判断（带置信度）与可以做的事，各最多 3 条。 */
function Brief({ brief }: { brief: HomeBriefState }) {
  return (
    <section aria-labelledby="home-brief" className={SECTION_CLASS}>
      <SectionHeader id="home-brief" title="AI 就业研判" />
      {brief.status === "failed" && <Unavailable title="AI 就业研判" />}
      {brief.status === "empty" && (
        <div role="status" className="mt-3 rounded-card border border-line-soft bg-bg-sunk px-4 py-4">
          <p className="text-[14px] font-medium text-ink-2">{KEEP_OBSERVING}</p>
          <p className="mt-1 text-[12px] leading-relaxed text-ink-4 break-words">{KEEP_OBSERVING_HINT}</p>
        </div>
      )}
      {brief.status === "ok" && (
        <>
          <dl className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
            <div>
              <dt className="flex flex-wrap items-baseline gap-2 text-[12px] font-medium text-ink-4">
                趋势判断
                <span className="rounded-full bg-bg-sunk px-2 py-0.5 text-[11px] font-normal text-ink-3">
                  {confidenceLabel(brief.data.confidence)}
                </span>
              </dt>
              <dd><ConclusionList lines={brief.data.inferences} limit={HOME_BRIEF_LIMIT} /></dd>
            </div>
            <div>
              <dt className="text-[12px] font-medium text-ink-4">可以做的事</dt>
              <dd><ConclusionList lines={brief.data.actions} limit={HOME_BRIEF_LIMIT} /></dd>
            </div>
          </dl>
          <p className="mt-3 text-[11.5px] text-ink-4 break-words">
            离线生成于 <CareerTime value={brief.data.generated_at} /> · 基于样本 {brief.data.sample_size} 个岗位，读者打开页面不调用模型。
          </p>
        </>
      )}
    </section>
  );
}

/** 需求变化三指标：学生友好岗位只计明确证据，口径写在注里。 */
function Indicators({ summary }: { summary: SummaryResponseV1 | null }) {
  return (
    <section aria-labelledby="home-indicators">
      <SectionHeader id="home-indicators" title="需求变化" />
      {summary === null ? (
        <div className="mt-3 rounded-card border border-line bg-surface px-5 py-4">
          <Unavailable title="需求变化" />
        </div>
      ) : (
        <dl className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
          {homeIndicators(summary).map((indicator) => (
            <div key={indicator.label} className="rounded-card border border-line bg-surface px-5 py-4">
              <dt className="text-[12px] text-ink-4">{indicator.label}</dt>
              <dd className={`mt-1 font-semibold text-ink ${indicator.pending ? "text-[14px]" : "num text-[26px]"}`}>
                {indicator.value}
              </dd>
              <dd className="mt-1 text-[11.5px] leading-relaxed text-ink-4 break-words">{indicator.note}</dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}

/** 最新就业日报摘要与入口；AI 评论在后续阶段接后端后加。入口属于导航而非数据，请求失败时也保留。 */
function DailySummary({ daily }: { daily: CareerDailyResponseV1 | null }) {
  return (
    <section aria-labelledby="home-daily" className={SECTION_CLASS}>
      <SectionHeader
        id="home-daily"
        title="最新就业日报"
        aside={<Link to="/daily" className="inline-flex items-center py-2 -my-2 text-[12px] font-medium text-accent hover:underline">查看今日日报 →</Link>}
      />
      {daily === null ? (
        <Unavailable title="最新就业日报" />
      ) : (
        <>
          {!daily.has_run && <p className="mt-2 text-[12px] text-ink-4">今日尚未采集，下列库表数字仍为当前值。</p>}
          <dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div>
              <dt className="text-[12px] text-ink-4">今日新增岗位</dt>
              <dd className="num mt-1 text-[20px] font-semibold text-ink">{daily.new_jobs_today}</dd>
            </div>
            <div>
              <dt className="text-[12px] text-ink-4">今日新增政策</dt>
              <dd className="num mt-1 text-[20px] font-semibold text-ink">{daily.new_policies_today}</dd>
            </div>
            <div>
              <dt className="text-[12px] text-ink-4">职位库总量</dt>
              <dd className="num mt-1 text-[20px] font-semibold text-ink">{daily.jobs_total}</dd>
            </div>
            <div>
              <dt className="text-[12px] text-ink-4">{UNKNOWN_RATIO_LABEL}</dt>
              <dd className="num mt-1 text-[20px] font-semibold text-ink">{formatRatioPercent(daily.unknown_ratio)}</dd>
            </div>
          </dl>
          <p className="mt-3 text-[12px] text-ink-4 break-words">
            <time dateTime={daily.date} className="num">{daily.date}</time> · 样本 {daily.sample_size} 个岗位
          </p>
        </>
      )}
    </section>
  );
}

/** 一行入口：只给热门方向名与岗位数，完整方向榜与职位列表在岗位页。 */
function DirectionEntry({ catalog }: { catalog: CareerCatalogResponseV1 | null }) {
  return (
    <section aria-labelledby="home-top-directions" className="rounded-card border border-line bg-surface px-5 py-4">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 id="home-top-directions" className="text-[15px] font-semibold text-ink">热门方向 Top {HOME_CATALOG_LIMIT}</h2>
        {catalog === null ? (
          <span role="status" className="text-[12px] text-ink-4">{BLOCK_UNAVAILABLE}</span>
        ) : catalog.directions.length === 0 ? (
          <span role="status" className="text-[12px] text-ink-4">{KEEP_OBSERVING}</span>
        ) : (
          <ul className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[13px] text-ink-2">
            {catalog.directions.slice(0, HOME_CATALOG_LIMIT).map((direction: CareerDirectionV1) => (
              <li key={direction.role_family} className="break-words">
                {ROLE_FAMILY_LABELS[direction.role_family]}
                <span className="num ml-1 text-ink-4">{direction.job_count} 个岗位</span>
              </li>
            ))}
          </ul>
        )}
        <Link to={JOBS_CATALOG_HREF} className="inline-flex items-center py-2 -my-2 text-[12px] font-medium text-accent hover:underline sm:ml-auto">
          查看全部岗位 →
        </Link>
      </div>
    </section>
  );
}

export function HomeWorkbench({ summary, catalog, daily, brief }: {
  summary: SummaryResponseV1 | null;
  catalog: CareerCatalogResponseV1 | null;
  daily: CareerDailyResponseV1 | null;
  brief: HomeBriefState;
}) {
  return (
    <div className="space-y-5 pb-10 pt-3">
      <header>
        <h1 data-page-title="" className="text-[24px] font-semibold text-ink">就业数据工作台</h1>
        <p className="mt-1 text-[13px] leading-relaxed text-ink-3 break-words">
          今天有什么机会、需求在怎么变——一屏看完；完整事实与完整岗位榜在洞察页和岗位页。
        </p>
      </header>

      <Overview summary={summary} catalog={catalog} />
      <Brief brief={brief} />
      <Indicators summary={summary} />
      <DailySummary daily={daily} />
      <DirectionEntry catalog={catalog} />
    </div>
  );
}
