// 后台「就业数据」视图（GET /api/admin/career）的返回形状：采集运行、来源健康、LLM 兜底、
// 研判与日报评论、数据规模与新鲜度。只读，仅管理员可见；聚合在
// modules/career-insights/backend/admin-overview.ts，页面在 apps/web/app/routes/admin/career.tsx。

/** 读一段数据的结果：某段查询失败时该段是 failed，页面显示「数据暂不可用」，其余段照常展示。 */
export type CareerAdminSection<T> = { ok: true; data: T } | { ok: false; error: string };

/** 一次采集 run（career_ingest_runs 的一行）。 */
export interface CareerAdminIngestRun {
  id: string;
  /** 岗位采集还是政策采集。 */
  kind: "jobs" | "policy";
  source_key: string;
  /** 来源的中文名；库里出现未登记的来源时回落为 source_key。 */
  source_label: string;
  status: "ok" | "partial" | "failed";
  fetched_at: string;
  job_count: number;
  accepted: number;
  updated: number;
  duplicates: number;
  rejected: number;
  error: string | null;
}

/** 按来源聚合的最新状态：最近一次 run，以及最近一次成功。 */
export interface CareerAdminSourceHealth {
  source_key: string;
  source_label: string;
  kind: "jobs" | "policy";
  last_status: "ok" | "partial" | "failed";
  last_fetched_at: string;
  last_accepted: number;
  last_error: string | null;
  last_ok_at: string | null;
  /** 最近一次成功时的 accepted（新增岗位/政策数）。 */
  last_ok_accepted: number | null;
  /** 全部历史里失败的 run 数。 */
  failed_runs: number;
}

/** job_runs.detail.llm：LLM 兜底子进程的汇总（形状同 IncrementalLlmCronDetail，这里只放后台要显示的字段）。 */
export interface CareerAdminLlmStep {
  ok: boolean | null;
  candidates: number | null;
  called: number | null;
  changed: number | null;
  failed: number | null;
  calls: number | null;
  retries: number | null;
  usage: { prompt_tokens: number; completion_tokens: number } | null;
  budget: { max_rows: number; max_prompt_tokens: number; rows: number; prompt_tokens_estimated: number } | null;
  stopped_by_budget: string | null;
  skipped: { rows: number; reason: string | null } | null;
  duration_ms: number | null;
  exit_code: number | null;
  error: string | null;
}

/** job_runs.detail.brief：研判子进程的汇总。 */
export interface CareerAdminBriefStep {
  ok: boolean | null;
  skipped: boolean | null;
  reason: string | null;
  as_of: string | null;
  sample_size: number | null;
  observation_days: number | null;
  confidence: string | null;
  receipt_id: number | null;
  model: string | null;
  duration_ms: number | null;
  exit_code: number | null;
  error: string | null;
}

/** job_runs.detail.comment：日报评论子进程的汇总。 */
export interface CareerAdminCommentStep {
  ok: boolean | null;
  skipped: boolean | null;
  reason: string | null;
  date: string | null;
  as_of: string | null;
  sample_size: number | null;
  new_jobs: number | null;
  confidence: string | null;
  receipt_id: number | null;
  model: string | null;
  duration_ms: number | null;
  exit_code: number | null;
  error: string | null;
}

/** 最近一次 career 相关定时任务（career.ingest），四步的汇总都在 detail 里。 */
export interface CareerAdminJobRun {
  job: string;
  status: "running" | "ok" | "failed" | "skipped";
  started_at: string;
  finished_at: string | null;
  error: string | null;
  llm: CareerAdminLlmStep | null;
  brief: CareerAdminBriefStep | null;
  comment: CareerAdminCommentStep | null;
}

/** career_briefs 里的一份研判缓存。 */
export interface CareerAdminBrief {
  prompt_version: string;
  as_of: string;
  generated_at: string;
  confidence: "low" | "medium" | "high";
  sample_size: number;
  window_days: number;
  observation_days: number;
  receipt_id: number | null;
  model: string | null;
}

/** career_daily_comments 里的一份日报评论缓存。 */
export interface CareerAdminComment {
  prompt_version: string;
  /** Asia/Shanghai 自然日（YYYY-MM-DD）。 */
  date: string;
  as_of: string;
  generated_at: string;
  confidence: "low" | "medium" | "high";
  sample_size: number;
  new_jobs: number;
  receipt_id: number | null;
  model: string | null;
}

/** 库里的数据规模与新鲜度。 */
export interface CareerAdminScale {
  jobs: number;
  observations: number;
  policies: number;
  briefs: number;
  comments: number;
  /** 有岗位观测的自然日数（Asia/Shanghai），即可出日报的天数。 */
  observed_days: number;
  latest_observation_at: string | null;
  latest_job_seen_at: string | null;
  latest_policy_seen_at: string | null;
  /** 最新一条政策的发布日期（YYYY-MM-DD）。 */
  latest_policy_published_at: string | null;
}

/** GET /api/admin/career：每段独立降级，一段失败不影响其余段。 */
export interface CareerAdminOverview {
  generated_at: string;
  ingest: CareerAdminSection<{ runs: CareerAdminIngestRun[] }>;
  sources: CareerAdminSection<CareerAdminSourceHealth[]>;
  /** 还没有 career 相关 job_runs 时是 ok 且 data 为 null。 */
  llm: CareerAdminSection<CareerAdminJobRun | null>;
  briefs: CareerAdminSection<CareerAdminBrief[]>;
  comments: CareerAdminSection<CareerAdminComment[]>;
  scale: CareerAdminSection<CareerAdminScale>;
}
