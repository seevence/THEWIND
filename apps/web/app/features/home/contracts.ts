import type { CareerBriefV1 } from "@aihot/career-insights/contracts";

// 首页一行入口展示的热门方向数（catalog 的 limit，1..50）：只给方向名与岗位数，完整榜在岗位页。
export const HOME_CATALOG_LIMIT = 3;

// 首页研判只放结论：趋势判断与可以做的事各最多 3 条，完整内容在洞察页。
export const HOME_BRIEF_LIMIT = 3;

/**
 * 首页研判只需要结论：完整 facts / limitations / evidence 留在洞察页，
 * 不随首页 loader 数据下发——既缩短首屏，也避免同一份数据在首页重复展示。
 */
export type HomeBriefViewV1 = Pick<
  CareerBriefV1,
  "generated_at" | "sample_size" | "confidence" | "inferences" | "actions"
>;

/**
 * 研判区块的三种状态：读到缓存、接口明确没有缓存（204）、请求失败。
 * 只有前两种是正常结果，失败只降级本区块。
 */
export type HomeBriefState =
  | { status: "ok"; data: HomeBriefViewV1 }
  | { status: "empty" }
  | { status: "failed" };
