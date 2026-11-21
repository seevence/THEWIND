import { SITE } from "@aihot/site";
import { cachedPage } from "../lib/api.server";
import { pageReuse } from "../lib/page-reuse";
import { pageMeta } from "../lib/seo";
import { PhoneBar } from "../components/shell/PhoneBar";
import { SectionPlaceholder } from "../components/ui/SectionPlaceholder";
import { navUp } from "../components/shell/nav";
import type { Screen } from "../components/shell/screens";

export const handle: Screen = { home: navUp("/topics").tab, name: "主题" };
export { pageHeaders as headers } from "../lib/api.server";
// The old topic directory belongs to the article system and is no longer read; the route stays open.
export const { clientLoader, shouldRevalidate } = pageReuse<typeof loader>();

export async function loader() {
  return cachedPage(600, {});
}

export function meta() {
  return pageMeta({
    title: "主题（改版中）",
    description: `${SITE.name} 已转型为就业趋势平台：旧的主题目录正在改版，岗位、职业洞察与就业日报见首页导航。`,
    path: "/topics",
    image: "/og/pages/topics.png",
    // The old AI topic list is gone; nothing here should be indexed until the section is rebuilt.
    noindex: true,
  });
}

export default function TopicsPage() {
  return (
    <>
      <PhoneBar back={{ to: "/", label: "首页" }} title="主题" />
      <SectionPlaceholder
        kicker="主题"
        title="该板块正在改版"
        lead={`本站已从行业资讯聚合转型为就业趋势平台，旧的主题目录（按公司、技术方向、内容类型分类）不再更新。接下来的主题会围绕岗位方向、技能与政策展开。`}
        entries={[
          { to: "/career-insights/jobs", label: "热门岗位", note: "按方向、职位与技能看正在招聘的岗位。" },
          { to: "/career-insights", label: "职业洞察", note: "就业趋势、异常信号与技能需求。" },
          { to: "/daily", label: "就业日报", note: "当天新增岗位、政策与采集情况。" },
        ]}
        note={`现在的主题入口以职业洞察与岗位方向为准；想按公司或方向筛选，请到「热门岗位」。`}
      />
    </>
  );
}
