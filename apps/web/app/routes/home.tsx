import { redirect, useLoaderData } from "react-router";
import { SITE } from "@aihot/site";
import type { Route } from "./+types/home";
import type {
  CareerBriefV1,
  CareerCatalogResponseV1,
  CareerDailyResponseV1,
  SummaryResponseV1,
} from "@aihot/career-insights/contracts";
import { cachedPage } from "../lib/api.server";
import { logError } from "../lib/errors.server";
import { pageReuse } from "../lib/page-reuse";
import { pageMeta, siteLd } from "../lib/seo";
import type { Screen } from "../components/shell/screens";
import { localizeDomainTerms } from "../../../../modules/career-insights/web/labels.ts";
import type { HomeBriefState } from "../features/home/contracts.ts";
import { HOME_BRIEF_LIMIT, HOME_CATALOG_LIMIT } from "../features/home/contracts.ts";
import { HomeWorkbench } from "../features/home/HomeWorkbench.tsx";
import {
  careerBriefPath,
  careerCatalogPath,
  careerDailyPath,
  careerSummaryPath,
  loadCareerBrief,
  loadCareerCatalog,
  loadCareerDaily,
  loadCareerSummary,
} from "../../../../modules/career-insights/web/feeds.server.ts";

export const handle: Screen = { tab: "featured", name: "首页" };
export { pageHeaders as headers } from "../lib/api.server";
export const { clientLoader, shouldRevalidate } = pageReuse<typeof loader>();

/** 单区块失败只降级该区块：记一条请求日志，返回 null 由页面显示「本区块暂时不可用」。 */
async function settled<T>(path: string, promise: Promise<T>, signal: AbortSignal): Promise<T | null> {
  try {
    return await promise;
  } catch (error) {
    if (!signal.aborted) logError(error, { msg: "home block failed", method: "GET", path });
    return null;
  }
}

/** 研判区块要区分「无缓存(204)」与请求失败，单独收敛；只把首页要用的结论随页下发。 */
async function settledBrief(signal: AbortSignal): Promise<HomeBriefState> {
  try {
    const data = await loadCareerBrief<CareerBriefV1>(signal);
    if (data === null) return { status: "empty" };
    const { generated_at, sample_size, confidence, inferences, actions } = data;
    // 首页只放结论：多出来的推断/建议既不渲染，也不进页面 payload。
    return {
      status: "ok",
      data: {
        generated_at,
        sample_size,
        confidence,
        // 领域词在 loader 就中文化：页面可见文本与内联 payload 都不带内部英文 ID。
        inferences: inferences.slice(0, HOME_BRIEF_LIMIT).map(localizeDomainTerms),
        actions: actions.slice(0, HOME_BRIEF_LIMIT).map(localizeDomainTerms),
      },
    };
  } catch (error) {
    if (!signal.aborted) logError(error, { msg: "home block failed", method: "GET", path: careerBriefPath() });
    return { status: "failed" };
  }
}

export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const q = url.searchParams.get("q");
  // Search lives on /all; keep the parameters so old links still land on results.
  if (q && q.trim()) throw redirect(`/all${url.search}`);

  const signal = request.signal;
  // 首页只读五段要用的数据；信号、完整方向榜、技能榜与最新岗位列表只在洞察页/岗位页取。
  const [summary, catalog, daily, brief] = await Promise.all([
    settled<SummaryResponseV1>(careerSummaryPath(), loadCareerSummary(signal), signal),
    settled<CareerCatalogResponseV1>(
      careerCatalogPath(HOME_CATALOG_LIMIT),
      loadCareerCatalog<CareerCatalogResponseV1>(HOME_CATALOG_LIMIT, signal),
      signal,
    ),
    settled<CareerDailyResponseV1>(careerDailyPath(), loadCareerDaily(signal), signal),
    settledBrief(signal),
  ]);

  // 工作台数据变化慢：共享缓存一分钟，浏览器在同一个 deadline 内复用。
  return cachedPage(60, { summary, catalog, daily, brief });
}

export function meta() {
  return [
    ...pageMeta({
      path: "/",
      description: "今天有什么机会、需求在怎么变：一屏看完今日概览、AI 就业研判与就业日报入口。",
      jsonLd: siteLd(),
    }),
    // Webmaster platforms look for their verification tag on the home page only.
    ...Object.entries(SITE.siteVerification).map(([name, content]) => ({ name, content })),
  ];
}

export default function Home() {
  const { summary, catalog, daily, brief } = useLoaderData<typeof loader>();
  return (
    <HomeWorkbench
      summary={summary}
      catalog={catalog}
      daily={daily}
      brief={brief}
    />
  );
}
