import { SITE, subjectAfter } from "@aihot/site";
import { cachedPage } from "../lib/api.server";
import { pageReuse } from "../lib/page-reuse";
import { pageMeta } from "../lib/seo";
import { PhoneBar } from "../components/shell/PhoneBar";
import { SectionPlaceholder } from "../components/ui/SectionPlaceholder";
import type { Screen } from "../components/shell/screens";

export const handle: Screen = { tab: "featured", name: "全部" };
export { pageHeaders as headers } from "../lib/api.server";
// The section is under rebuild: the page reads nothing, and every address it opens at is the same page.
export const { clientLoader, shouldRevalidate } = pageReuse<typeof loader>();

const ALL_TITLE = subjectAfter("全部", "动态");

export async function loader() {
  return cachedPage(600, {});
}

export function meta() {
  return pageMeta({
    title: `${ALL_TITLE}（改版中）`,
    description: `${SITE.name} 已从行业资讯聚合转型为就业趋势平台：原来的「${ALL_TITLE}」不再更新，岗位、职业洞察与就业日报见首页导航。`,
    path: "/all",
    image: "/og/pages/all.png",
    // Nothing of its own to index until the section has content again.
    noindex: true,
  });
}

export default function AllPage() {
  return (
    <>
      <PhoneBar back={{ to: "/", label: "首页" }} title={ALL_TITLE} />
      <SectionPlaceholder
        kicker="全部动态"
        title="该板块正在改版"
        lead={`本站已从行业资讯聚合转型为就业趋势平台：跟踪企业招聘岗位与政府就业政策，每天出一份就业日报。原来的「${ALL_TITLE}」页面暂时没有内容，也不再用旧的主题分类更新。`}
        entries={[
          { to: "/career-insights/jobs", label: "热门岗位", note: "按方向、职位与技能看正在招聘的岗位。" },
          { to: "/career-insights", label: "职业洞察", note: "就业趋势、异常信号与技能需求。" },
          { to: "/daily", label: "就业日报", note: "当天新增岗位、政策与采集情况。" },
        ]}
        note="找岗位请从上面的入口进入，或回到首页看今天的就业概览。"
      />
    </>
  );
}
