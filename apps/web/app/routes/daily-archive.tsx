import { Link, useLoaderData } from "react-router";
import { SITE, withSubject } from "@aihot/site";
import type { Route } from "./+types/daily-archive";
import type { CareerDailyHistoryResponseV1 } from "../../../../modules/career-insights/contracts/history.ts";
import { cachedPage } from "../lib/api.server";
import { logError } from "../lib/errors.server";
import { pageReuse } from "../lib/page-reuse";
import { pageMeta } from "../lib/seo";
import { PhoneBar } from "../components/shell/PhoneBar";
import { Kicker } from "../components/ui/Kicker";
import { SectionPlaceholder } from "../components/ui/SectionPlaceholder";
import { careerApiPath, loadCareerApi } from "../../../../modules/career-insights/web/api.ts";
import { confidenceLabel } from "../../../../modules/career-insights/web/labels.ts";
import { formatCareerDate } from "../../../../modules/career-insights/web/time.ts";
import type { Screen } from "../components/shell/screens";

export const handle: Screen = { tab: "daily", name: "往期" };
export { pageHeaders as headers } from "../lib/api.server";
export const { clientLoader, shouldRevalidate } = pageReuse<typeof loader>();

/** 归档列表每页 20 期（接口默认值也是 20，上限 50）；页面固定用默认值，翻页只改 page。 */
const ARCHIVE_PAGE_SIZE = 20;
const HISTORY_PATH = careerApiPath("/daily/history");

const REPORT_LINKS = [
  { to: "/daily", label: "日报" },
  { to: "/weekly", label: "周报" },
  { to: "/monthly", label: "月报" },
  { to: "/daily/archive", label: "往期", current: true },
] as const;

/** ?page= 只认正整数；其它值按第一页处理（老链接、手改地址都不报错）。 */
function pageFrom(url: URL): number {
  const raw = url.searchParams.get("page");
  return raw !== null && /^[1-9][0-9]*$/.test(raw) ? Number(raw) : 1;
}

/**
 * 归档接口失败时退回「筹备中」空态而不是整页 500：这个页面只是往期目录，接口短暂不可用不该挡住
 * 别的入口。接口返回空列表同样走空态（还没有积累出第二期日报时）。
 */
async function settledHistory(page: number, signal: AbortSignal): Promise<CareerDailyHistoryResponseV1 | null> {
  try {
    return await loadCareerApi<CareerDailyHistoryResponseV1>(`${HISTORY_PATH}?page=${page}&page_size=${ARCHIVE_PAGE_SIZE}`, signal);
  } catch (error) {
    if (error instanceof Error && !signal.aborted) {
      logError(error, { msg: "daily archive read failed", method: "GET", path: HISTORY_PATH });
    }
    return null;
  }
}

export async function loader({ request }: Route.LoaderArgs) {
  const page = pageFrom(new URL(request.url));
  const history = await settledHistory(page, request.signal);
  // 往期一天只变一次，共享缓存 5 分钟足够；接口本身带 no-store，页面按自己的节奏缓存。
  return cachedPage(300, { history, page });
}

export function meta({ loaderData }: Route.MetaArgs) {
  const total = loaderData?.history?.total;
  return pageMeta({
    title: total ? `${withSubject("日报")}合订本` : `${withSubject("日报")}合订本筹备中`,
    description: total
      ? `按日期翻看往期${withSubject("日报")}：每期的样本、新增岗位/政策、置信度与 AI 评论摘要。`
      : `${withSubject("日报")}合订本正在筹备，上线后会按日期归档在这里；现在可以先看最新的就业日报。`,
    path: "/daily/archive",
    image: "/og/pages/daily.png",
    // 历史页只是往期目录，不抢日报页的搜索位置。
    noindex: true,
  });
}

/** 一条往期：日期、评论摘要（没有就说明没有缓存）、当日统计，以及这一天的完整评论入口。 */
function ArchiveRow({ entry }: { entry: CareerDailyHistoryResponseV1["entries"][number] }) {
  const dateText = formatCareerDate(entry.date) ?? entry.date;
  return (
    <li data-daily-archive-date={entry.date} className="rounded-card border border-line bg-surface p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h2 className="text-[16px] font-semibold text-ink">
          <time dateTime={entry.date} className="num">{dateText}</time>
        </h2>
        {entry.confidence !== null && (
          <span className="rounded-full bg-bg-sunk px-2 py-0.5 text-[11.5px] text-ink-3">
            {confidenceLabel(entry.confidence)}
          </span>
        )}
      </div>
      {entry.comment_summary === null ? (
        <p className="mt-2 text-[13px] leading-relaxed text-ink-4">这一天没有 AI 评论缓存，下面是当日的采集汇总。</p>
      ) : (
        <p data-daily-archive-summary="" className="mt-2 break-words text-[13.5px] leading-relaxed text-ink-2 [overflow-wrap:anywhere]">
          {entry.comment_summary}
        </p>
      )}
      <div className="mt-3 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[12px] text-ink-4">
        <span>当日观测样本 <span className="num text-ink-2">{entry.sample_size}</span> 个岗位</span>
        <span>新增岗位 <span className="num text-ink-2">{entry.new_jobs}</span></span>
        <span>新增政策 <span className="num text-ink-2">{entry.new_policies}</span></span>
        <Link
          to={`/daily?date=${entry.date}`}
          className="font-medium text-accent hover:underline"
        >
          看这一天的日报 →
        </Link>
      </div>
    </li>
  );
}

/** 翻页：上一页/下一页都保留页码，超出范围不渲染链接；总期数始终显示。 */
function ArchivePagination({ page, pageSize, total }: { page: number; pageSize: number; total: number }) {
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  if (pageCount <= 1) return null;
  const linkClass = "font-medium text-accent hover:underline";
  return (
    <nav aria-label="往期分页" className="mt-6 flex flex-wrap items-center justify-between gap-3 text-[13px]">
      {page > 1 ? <Link to={`/daily/archive?page=${page - 1}`} className={linkClass}>← 上一页</Link> : <span />}
      <span className="text-ink-4">第 <span className="num">{page}</span> / <span className="num">{pageCount}</span> 页 · 共 <span className="num">{total}</span> 期</span>
      {page < pageCount ? <Link to={`/daily/archive?page=${page + 1}`} className={linkClass}>下一页 →</Link> : <span />}
    </nav>
  );
}

/** 还没有往期可翻：保留原来的「筹备中」空态与去往其它页面的入口。 */
function EmptyArchive() {
  return (
    <>
      <PhoneBar back={{ to: "/daily", label: "日报" }} title={`${withSubject("日报")}合订本`} />
      <SectionPlaceholder
        kicker={`${SITE.name} · ${withSubject("日报")}`}
        title={`${withSubject("日报")}合订本正在筹备`}
        titleId="report-start"
        lead={`按日期翻看往期${withSubject("日报")}的合订本正在筹备。${withSubject("日报")}目前每天更新，旧的期数暂不在这里归档。`}
        reportLinks={REPORT_LINKS.map((link) => ({ ...link }))}
        entries={[
          { to: "/daily", label: "今天的就业日报", note: "当天新增岗位、政策与采集情况。" },
          { to: "/career-insights", label: "职业洞察", note: "就业趋势、异常信号与技能需求。" },
          { to: "/career-insights/jobs", label: "热门岗位", note: "按方向、职位与技能看正在招聘的岗位。" },
        ]}
        note="合订本上线前，往期内容请直接看就业日报；有想法可以通过反馈页告诉我们。"
      />
    </>
  );
}

export default function DailyArchive() {
  const { history, page } = useLoaderData<typeof loader>();
  const entries = history?.entries ?? [];
  if (history === null || entries.length === 0) return <EmptyArchive />;

  return (
    <>
      <PhoneBar back={{ to: "/daily", label: "日报" }} title={`${withSubject("日报")}合订本`} />
      <div className="mx-auto max-w-[var(--page-max-reading)] pb-14 lg:pt-3">
        <div className="mx-auto max-w-[760px]">
          <header className="pt-4 lg:pt-0">
            <Kicker>{`${SITE.name} · ${withSubject("日报")}`}</Kicker>
            <h1
              id="report-start"
              data-page-title=""
              className="mt-4 text-[30px] font-black leading-[1.18] tracking-[-0.03em] text-ink [text-wrap:balance] sm:text-[38px]"
            >
              {withSubject("日报")}合订本
            </h1>
            <p className="mt-4 text-[15.5px] leading-[1.9] text-ink-3">
              按日期翻看往期{withSubject("日报")}：每期有当日观测样本、新增岗位与政策、置信度和 AI 评论摘要；点开一期可以看完整评论。
            </p>
          </header>

          <nav aria-label="报告入口" className="mt-6 flex flex-wrap gap-2">
            {REPORT_LINKS.map((link) => (
              <Link
                key={link.to}
                to={link.to}
                viewTransition
                aria-current={"current" in link ? "page" : undefined}
                className={`rounded-full px-3.5 py-2.5 text-[13px] transition-colors sm:py-1.5 ${
                  "current" in link
                    ? "bg-accent-soft font-semibold text-accent"
                    : "border border-line-strong bg-surface text-ink-2 hover:border-ink-4 hover:text-ink"
                }`}
              >
                {link.label}
              </Link>
            ))}
          </nav>

          <section aria-label="往期日报" className="mt-8">
            <ul className="space-y-3">
              {entries.map((entry) => <ArchiveRow key={entry.date} entry={entry} />)}
            </ul>
            <ArchivePagination page={page} pageSize={history.page_size} total={history.total} />
          </section>

          <p className="mt-10 border-t border-line pt-4 text-[12.5px] leading-relaxed text-ink-4">
            往期只保留摘要；完整的采集明细随时间清理，历史期以 AI 评论与当日统计为准。有想法可以通过反馈页告诉我们。
          </p>
        </div>
      </div>
    </>
  );
}
