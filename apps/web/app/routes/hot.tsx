import { useLoaderData } from "react-router";
import type { Route } from "./+types/hot";
import { cachedPage } from "../lib/api.server";
import { pageReuse } from "../lib/page-reuse";
import { pageMeta } from "../lib/seo";
import { CareerHotList } from "../../../../modules/career-insights/web/components/CareerHotList.ts";
import { CareerTime } from "../../../../modules/career-insights/web/time.ts";
import { loadCareerHot } from "../../../../modules/career-insights/web/feeds.server.ts";
import { navUp } from "../components/shell/nav";
import type { Screen } from "../components/shell/screens";

export const handle: Screen = { tab: navUp("/hot").tab, name: "就业热点" };
export { pageHeaders as headers } from "../lib/api.server";
export const { clientLoader, shouldRevalidate } = pageReuse<typeof loader>();

export async function loader({ request }: { request: Request }) {
  const hot = await loadCareerHot(request.signal);
  return cachedPage(120, { hot });
}

export function meta({ loaderData }: Route.MetaArgs) {
  const hot = loaderData?.hot;
  const lead = hot?.entries.slice(0, 3).map((entry) => entry.company).join("、");
  return pageMeta({
    title: "企业招聘热度榜：按在招岗位数排序",
    description: `过去 ${hot?.window_days ?? 30} 天内有观测的企业${lead ? `，岗位最多的有 ${lead}` : ""}；按在招岗位数、最近发布时间排序。`,
    path: "/hot",
    image: "/og/pages/hot.png",
  });
}

export default function HotPage() {
  const { hot } = useLoaderData<typeof loader>();
  return (
    <div className="pb-10">
      <header className="pb-5 pt-1">
        <h1 data-page-title="" className="text-[24px] font-bold leading-[1.3] tracking-[-0.01em] text-ink lg:text-[26px]">企业招聘热度榜</h1>
        <p className="mt-1.5 text-[13.5px] text-ink-3">最近 {hot.window_days} 天内有观测的企业，按在招岗位数排序。</p>
        <p className="mt-1 text-[12px] text-ink-4">数据截至 <CareerTime value={hot.as_of} /></p>
      </header>
      <CareerHotList entries={hot.entries} />
    </div>
  );
}