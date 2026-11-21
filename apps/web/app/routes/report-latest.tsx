import { useLoaderData } from "react-router";
import type { Route } from "./+types/report-latest";
import { REPORT_NAMES } from "@aihot/contracts/site";
import { EDITION_WHEN, withSubject } from "@aihot/site";
import { cachedPage } from "../lib/api.server";
import { pageReuse } from "../lib/page-reuse";
import { pageMeta } from "../lib/seo";
import { KIND_PATH, kindFromPath } from "../features/report/format";
import { PhoneBar } from "../components/shell/PhoneBar";
import { SectionPlaceholder } from "../components/ui/SectionPlaceholder";
import type { Screen } from "../components/shell/screens";

export const handle: Screen = { tab: "daily", name: "日报" };
export { pageHeaders as headers } from "../lib/api.server";
/**
 * The route stays open so old links and the 日报 navigation (which covers 周报 and 月报) still land here;
 * the page itself reads nothing while the editions are being prepared.
 */
export const { clientLoader, shouldRevalidate } = pageReuse<typeof loader>();

export async function loader({ request }: Route.LoaderArgs) {
  return cachedPage(600, { kind: kindFromPath(new URL(request.url).pathname) });
}

export function meta({ location }: Route.MetaArgs) {
  const kind = kindFromPath(location.pathname);
  const name = withSubject(REPORT_NAMES[kind]);
  return pageMeta({
    title: `${name}筹备中`,
    description: `${name}正在筹备，上线后会在这里发布；现在可以先看每天更新的就业日报与职业洞察。`,
    path: KIND_PATH[kind],
    image: `/og/pages/${kind}.png`,
    // A page with no edition of its own yet should not be indexed.
    noindex: true,
  });
}

export default function ReportLatestPage() {
  const { kind } = useLoaderData<typeof loader>();
  const name = withSubject(REPORT_NAMES[kind]);
  const when = kind === "weekly" ? "每周一" : "每月 1 日";
  return (
    <>
      <PhoneBar back={{ to: "/daily", label: "日报" }} title={name} />
      <SectionPlaceholder
        kicker={name}
        title={`${name}正在筹备`}
        titleId="report-start"
        lead={`${name}还没有上线：我们正在把岗位与政策数据整理成${when}发布的回顾，上线后会在这里发布，也会通过 RSS 与公开 API 提供。现在可以先看每天更新的就业日报。`}
        reportLinks={[
          { to: "/daily", label: "日报" },
          { to: "/weekly", label: "周报", current: kind === "weekly" },
          { to: "/monthly", label: "月报", current: kind === "monthly" },
          { to: "/daily/archive", label: "往期" },
        ]}
        entries={[
          { to: "/daily", label: "就业日报", note: `${EDITION_WHEN.daily} 更新：新增岗位、政策与采集情况。` },
          { to: "/career-insights", label: "职业洞察", note: "就业趋势、异常信号与技能需求。" },
          { to: "/career-insights/jobs", label: "热门岗位", note: "按方向、职位与技能看正在招聘的岗位。" },
        ]}
        note={`周报与月报的入口先保留在这里；有想法或希望优先看到什么内容，可以通过反馈页告诉我们。`}
      />
    </>
  );
}
