// career-insights 在 /llms.txt 里的条目：岗位、政策与就业研判的公开 API、页面与轮询节奏。
// 引擎的 publication/llms.ts 从 ServerModule.llms 收集这些行并按段落拼接；server.ts 接线。
import type { LlmsLines, ServerModule } from "@aihot/backend/modules";
import { siteUrl } from "@aihot/backend/publication/links";

const u = siteUrl;

/**
 * 只列真实存在的入口：岗位/政策/研判三条页面与四个公开 API 都由本模块提供，数据为空时页面仍在。
 * 公开 API 的字段与 /api/v1/career/* 的 OpenAPI（modules/career-insights/contracts/openapi.json）一致。
 */
export function careerLlms(): LlmsLines {
  return {
    api: [
      `- [公开 API · 岗位列表](${u("/api/v1/career/jobs")}): JSON，岗位分页（page 从 1、page_size 默认 20、最多 100），支持 q、role_family、city、student_friendly、skill 筛选；只返回公开字段`,
      `- [公开 API · 岗位详情](${u("/api/v1/career/jobs/{id}")}): 单个岗位的公开要求、技能证据与观测记录；不含原始正文与内部标识，id 只来自岗位列表`,
      `- [公开 API · 政策文件](${u("/api/v1/career/policies")}): 就业与产业发展相关政策列表（分页，附来源与主题分面），按发布日期从新到旧`,
      `- [公开 API · 就业研判](${u("/api/v1/career/insights")}): 最近一次离线生成的就业趋势研判（结论、推断、建议与局限）；尚未生成时返回 404，不要假装有`,
    ],
    pages: [
      `- [职业洞察](${u("/career-insights")}): 就业研判、市场信号、技能需求与政策联动的看板`,
      `- [热门岗位](${u("/career-insights/jobs")}): 可按方向、城市、技能与应届友好度筛选的岗位目录`,
      `- [政策文件](${u("/career-insights/policies")}): 就业与产业发展政策原文与主题`,
    ],
    pace: ["岗位与政策接口最快每 60 秒一次（带 If-None-Match 可拿 304），就业研判每天更新一次；"],
    usage: [
      "- 岗位与政策接口只返回公开字段：不含原文全文、原始 payload、内部来源键与观测表 id；列表默认 20 条、最多 100 条，翻页用 page / page_size。",
    ],
  };
}

/** ServerModule.llms 插口：server.ts 里写 `llms,` 或 `llms: careerLlms`。 */
export const llms: NonNullable<ServerModule["llms"]> = () => careerLlms();
