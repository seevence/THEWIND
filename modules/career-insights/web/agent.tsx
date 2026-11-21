import { SITE } from "@aihot/site";
import type { AgentPart } from "@aihot/web/modules";

/** MCP 工具名与后端 SITE.mcpPrefix 一致（thewind_*）：页面计数与工具表由引擎自动合并。 */
const tool = (name: string) => `${SITE.mcpPrefix}_${name}`;

/**
 * 就业模块在 /agent 页的接入说明：MCP 的 4 个就业工具、公开 API v1 的就业端点、三份 RSS。
 * 只写地址与一句话说明，真正的实现与字段以 /openapi-v1.json、/api/mcp 为准。
 */
const part: AgentPart = {
  tools: [
    { name: tool("search_jobs"), does: "按关键词、职族、城市、学生友好筛选当前有效岗位", ask: "搜一下数据分析相关岗位" },
    { name: tool("get_job"), does: "一个岗位的公开详情、技能要求与最近观测", ask: "这个岗位的学历和经验要求是什么？" },
    { name: tool("list_policies"), does: "就业与产业发展相关政策文件（标题、来源与原文链接）", ask: "最近有哪些就业支持政策？" },
    { name: tool("get_insights"), does: "最新就业研判：事实、推断、行动建议与置信度", ask: "本周就业市场有什么变化？" },
  ],
  api: {
    group: "就业数据（岗位 / 政策 / 研判）",
    rows: [
      ["/api/v1/career/jobs", "当前有效岗位列表：关键词、职族、城市、学生友好筛选与分页", "找岗位时"],
      ["/api/v1/career/jobs/{id}", "单个岗位的公开详情与最近观测", "看某个岗位时"],
      ["/api/v1/career/policies", "就业与产业发展相关政策（只含通过相关性判定的）", "看政策时"],
      ["/api/v1/career/insights", "最新就业研判（后台预生成，页面只读缓存）", "看趋势时"],
    ],
  },
  resources: [
    ["岗位 RSS", "/feed/jobs.xml", "订阅最近观测到的岗位，最多 50 条"],
    ["政策 RSS", "/feed/policies.xml", "订阅就业与产业发展政策"],
    ["就业日报 RSS", "/feed/career-daily.xml", "订阅每日就业日报摘要"],
  ],
  rssLead: ["就业岗位、政策与日报另外各有一份 RSS，都在 /feed/ 下"],
};

export default part;
