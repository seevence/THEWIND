import { Link, useLoaderData } from "react-router";
import { isValidDate } from "@aihot/contracts/time";
import type { CareerDailyCommentResponseV1 } from "@aihot/career-insights/contracts";
import type { Route } from "./+types/daily";
import { cachedPage } from "../lib/api.server";
import { logError } from "../lib/errors.server";
import { pageReuse } from "../lib/page-reuse";
import { pageMeta } from "../lib/seo";
import { CareerDailyReport, type CareerDailyReportLink } from "../../../../modules/career-insights/web/components/CareerDailyReport.ts";
import { dailyCommentMeta } from "../../../../modules/career-insights/web/feeds.ts";
import { formatCareerDate } from "../../../../modules/career-insights/web/time.ts";
import {
  careerDailyCommentPath,
  loadCareerDaily,
  loadCareerDailyComment,
} from "../../../../modules/career-insights/web/feeds.server.ts";
import type { Screen } from "../components/shell/screens";

export const handle: Screen = { tab: "daily", name: "就业日报" };
export { pageHeaders as headers } from "../lib/api.server";
export const { clientLoader, shouldRevalidate } = pageReuse<typeof loader>();

/** 日报页顶部的报告入口，与 /daily/archive、/weekly、/monthly 页的 REPORT_LINKS 同一份口径。 */
const REPORT_LINKS: readonly CareerDailyReportLink[] = [
  { to: "/daily", label: "日报", current: true },
  { to: "/weekly", label: "周报" },
  { to: "/monthly", label: "月报" },
  { to: "/daily/archive", label: "往期" },
];

/**
 * 评论区块单独降级：无缓存(204) 返回 null，请求失败也返回 null 并记一条请求日志，
 * 页面仍是 200、其它区块照常渲染；读者访问只读缓存，不触发模型调用。
 */
async function settledDailyComment(signal: AbortSignal, date?: string): Promise<CareerDailyCommentResponseV1 | null> {
  try {
    return await loadCareerDailyComment<CareerDailyCommentResponseV1>(signal, date);
  } catch (error) {
    if (!signal.aborted) logError(error, { msg: "daily comment block failed", method: "GET", path: careerDailyCommentPath(date) });
    return null;
  }
}

/**
 * 两种打开方式：
 * - /daily：今天的采集汇总 + 今天的 AI 评论（原行为不变）；
 * - /daily?date=YYYY-MM-DD：历史期（归档页链接过来），只展示那天缓存的 AI 评论与统计并标明日期。
 *   坏日期按今天处理，老链接进站不报错。历史采集明细没有按日存档，页面如实说明以评论与统计为准。
 */
export async function loader({ request }: Route.LoaderArgs) {
  const signal = request.signal;
  const url = new URL(request.url);
  const requested = url.searchParams.get("date");
  if (requested !== null && isValidDate(requested)) {
    const comment = await settledDailyComment(signal, requested);
    // 历史期只读一天，缓存 5 分钟。
    return cachedPage(300, { mode: "history" as const, date: requested, comment });
  }

  const [daily, comment] = await Promise.all([loadCareerDaily(signal), settledDailyComment(signal)]);
  return cachedPage(60, { mode: "today" as const, daily, comment });
}

export function meta({ loaderData }: Route.MetaArgs) {
  if (loaderData !== undefined && loaderData.mode === "history") {
    const date = loaderData.date;
    return pageMeta({
      title: `就业日报（${date}）`,
      description: `${date} 的就业日报：当天的 AI 评论、观测样本与新增岗位/政策摘要。`,
      path: "/daily",
      image: "/og/pages/daily.png",
      // 历史期是 ?date= 的一个视图，规范地址留给 /daily，也不单独进搜索结果。
      noindex: true,
    });
  }
  const date = loaderData?.mode === "today" ? loaderData.daily.date : undefined;
  return pageMeta({
    title: `就业日报${date ? `（${date}）` : ""}`,
    description: "今日新增岗位与政策、各来源采集结果，以及空技能岗位占比。",
    path: "/daily",
    image: "/og/pages/daily.png",
  });
}

/** 历史期：日期、当日 AI 评论（缓存没有就说明没有）与回往期的入口；不渲染今天的采集汇总。 */
function CareerDailyHistoryView({ date, comment }: { date: string; comment: CareerDailyCommentResponseV1 | null }) {
  const dateText = formatCareerDate(date) ?? date;
  return (
    <div data-career-daily-history="" className="space-y-6 pb-10 pt-3">
      <header>
        <h1 data-page-title="" className="text-[24px] font-semibold text-ink">就业日报</h1>
        <p className="mt-1 text-[13px] leading-relaxed text-ink-3">
          <time dateTime={date} data-daily-history-date={date} className="num">{dateText}</time>
          {" · 历史期：当日 AI 评论与统计"}
        </p>
      </header>
      <div className="rounded-card border border-line bg-bg-sunk px-4 py-3 text-[13px] leading-relaxed text-ink-2">
        这是历史日报。采集明细只保留最近一段时间，历史期以当日统计与 AI 评论为准；完整目录见
        <Link to="/daily/archive" className="mx-1 font-medium text-accent hover:underline">往期归档</Link>。
      </div>
      {comment === null ? (
        <div role="status" data-daily-history-empty="" className="rounded-card border border-line bg-surface px-5 py-6 text-[13px] text-ink-3">
          这一天的 AI 评论没有缓存。
          <Link to="/daily/archive" className="ml-1 font-medium text-accent hover:underline">回到往期归档</Link>
        </div>
      ) : (
        <section
          aria-labelledby="career-daily-comment"
          data-daily-comment=""
          data-daily-comment-date={comment.date}
          data-daily-comment-confidence={comment.confidence}
          className="rounded-card border border-line bg-surface p-5"
        >
          <h2 id="career-daily-comment" className="text-[16px] font-semibold text-ink">AI 评论</h2>
          <p data-daily-comment-body="" className="mt-3 break-words text-[14px] leading-relaxed text-ink-2 [overflow-wrap:anywhere]">
            {comment.comment}
          </p>
          <p data-daily-comment-meta="" className="mt-3 break-words text-[12px] text-ink-4">{dailyCommentMeta(comment)}</p>
        </section>
      )}
      <p>
        <Link to="/daily/archive" className="text-[13px] font-medium text-accent hover:underline">← 返回往期归档</Link>
      </p>
    </div>
  );
}

export default function CareerDailyPage() {
  const loaderData = useLoaderData<typeof loader>();
  if (loaderData.mode === "history") {
    return <CareerDailyHistoryView date={loaderData.date} comment={loaderData.comment} />;
  }
  return <CareerDailyReport daily={loaderData.daily} comment={loaderData.comment} reportLinks={REPORT_LINKS} />;
}
