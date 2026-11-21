// 就业日报归档的响应契约（GET /api/site/career-insights/daily/history）。
// 只有类型、没有运行时代码：后端路由与网页 loader 都从这里取形状，避免两边各写一份漂移。
import type { DataOrigin } from "./job.ts";

/** 一期历史日报的一行：日期、当日样本与新增、置信度与评论摘要（≤120 字）。 */
export interface CareerDailyHistoryEntryV1 {
  /** Asia/Shanghai 自然日（YYYY-MM-DD）。 */
  date: string;
  /** 当日有观测的岗位数（日评缓存里有就用缓存里的，老日期用当日观测聚合兜底）。 */
  sample_size: number;
  /** 当日首次观测到的岗位数。 */
  new_jobs: number;
  /** 当日首次收录的相关政策数（与政策页/日报同一份相关性规则）。 */
  new_policies: number;
  /** 当日 AI 评论的置信度；那天没有评论缓存时为 null。 */
  confidence: "low" | "medium" | "high" | null;
  /** 评论摘要：最多 120 字，超长以「…」结尾；没有评论时为 null。 */
  comment_summary: string | null;
}

/** 历史日报的一页：按日期倒序，带总期数。 */
export interface CareerDailyHistoryResponseV1 {
  contract_version: "0.1";
  data_origin: DataOrigin;
  page: number;
  page_size: number;
  /** 有记录的历史期数（不限本页）。 */
  total: number;
  /** 按日期倒序（最新的一期在前）。 */
  entries: CareerDailyHistoryEntryV1[];
}
