import type { DataOrigin, RoleFamily } from "./job.ts";

export interface CareerHotRoleFamilyCountV1 {
  role_family: RoleFamily;
  count: number;
}

export interface CareerHotEntryV1 {
  company: string;
  /** 代表来源（`source_key` 众数）在注册表里的官方招聘页；无定义/停用/非 company_careers 时为 null。 */
  career_url: string | null;
  job_count: number;
  latest_published_at: string | null;
  role_families: CareerHotRoleFamilyCountV1[];
}

/**
 * 企业招聘热度榜：按 company_name 聚合最近 window_days 天内有观测的职位，
 * 排序为 job_count DESC、latest_published_at DESC（无效时间排后）、company ASC。
 */
export interface CareerHotResponseV1 {
  contract_version: "0.1";
  data_origin: DataOrigin;
  as_of: string;
  window_days: number;
  entries: CareerHotEntryV1[];
}

/** 当日某个采集来源的采集结果汇总；status 取当天该来源所有 run 的最差状态。 */
export interface CareerDailySourceV1 {
  source_key: string;
  collected: number;
  accepted: number;
  updated: number;
  duplicates: number;
  status: "ok" | "partial" | "failed";
}

/**
 * 今日就业日报（Asia/Shanghai 日）。当天没有任何 run 时 sources 为空且 has_run=false，
 * 其余计数仍按当前库表如实返回。
 */
export interface CareerDailyResponseV1 {
  contract_version: "0.1";
  data_origin: DataOrigin;
  date: string;
  sources: CareerDailySourceV1[];
  has_run: boolean;
  jobs_total: number;
  new_jobs_today: number;
  new_policies_today: number;
  policies_total: number;
  unknown_ratio: number | null;
  sample_size: number;
  /** 数据截止时间（全库最后一次岗位观测，稳定值用于缓存/ETag）；无岗位时为 1970-01-01T00:00:00.000Z。 */
  generated_at: string;
}
/**
 * 异常信号规则：
 * - cross_industry：算法/AI 族占多数的公司出现机械/硬件等非 AI 岗位；
 * - new_family：公司在近 window_days 天内首次出现某职族（此前无该族）；数据覆盖不足 window_days 时
 *   只描述「本站观察到首次出现」，confidence=low，不断言近 N 天首次；
 * - surge：最近 24h 新岗位 ≥5 且达到历史日均 3 倍；
 * - skill_mismatch：算法/大模型类标题的岗位要求机械/硬件类技能。
 */
export type CareerSignalRule = "cross_industry" | "new_family" | "surge" | "skill_mismatch";

/** 数据覆盖不足 window_days 时 new_family 记 low：只能说明「本站观察到」，不能断言「近 N 天首次」。 */
export type CareerSignalConfidence = "high" | "medium" | "low";

/** 每条信号都带可复算的数字依据；未用于该规则的字段不出现。 */
export interface CareerSignalEvidenceV1 {
  /** cross_industry：公司总岗位数、算法/AI 族岗位数与占比。 */
  company_job_count?: number;
  ai_family_job_count?: number;
  ai_family_ratio?: number;
  /** cross_industry / skill_mismatch：命中的跨界词、标题词、技能词。 */
  matched_terms?: string[];
  matched_title_terms?: string[];
  matched_skill_terms?: string[];
  /** new_family：新职族、该族岗位数、窗口天数、该族最早出现时间、全站数据覆盖天数。 */
  role_family?: RoleFamily;
  family_job_count?: number;
  window_days?: number;
  earliest_first_seen_at?: string;
  /** new_family：全站最早一次观测至今覆盖的天数；小于 window_days 时 confidence 为 low。 */
  data_coverage_days?: number;
  /** surge：24h 内新岗位数、历史天数、历史日均、倍数；历史日均 0 时倍数为 null。 */
  last_24h_jobs?: number;
  history_days?: number;
  history_daily_average?: number;
  surge_ratio?: number | null;
}

export interface CareerSignalV1 {
  rule: CareerSignalRule;
  company: string;
  job_id: string;
  job_title: string;
  evidence: CareerSignalEvidenceV1;
  reason_text: string;
  source_key: string;
  official_url: string;
  first_seen_at: string;
  confidence: CareerSignalConfidence;
}

/** 因历史不足而未判定的规则项（当前只有 surge 会跳过）。 */
export interface CareerSignalSkippedV1 {
  rule: "surge";
  company: string;
  reason: "insufficient_history";
  history_days: number;
}

/**
 * 就业异常信号：按 confidence（high 优先）、first_seen_at DESC 排序，
 * 同 company+rule+family 只保留最新一条。空表时 signals 与 skipped 均为空数组。
 */
export interface CareerSignalsResponseV1 {
  contract_version: "0.1";
  data_origin: DataOrigin;
  window_days: number;
  signals: CareerSignalV1[];
  skipped: CareerSignalSkippedV1[];
  /** 数据截止时间（全库最后一次岗位观测，稳定值用于缓存/ETag）；无岗位时为 1970-01-01T00:00:00.000Z。 */
  generated_at: string;
}
/** 方向榜：按 role_family 聚合，unknown 不进入榜单，未归类数量与占比由 catalog 的 unclassified_* 字段单列披露。 */
export interface CareerDirectionV1 {
  role_family: RoleFamily;
  job_count: number;
  company_count: number;
  new_in_window: number;
  student_friendly_count: number;
  top_skills: Array<{ skill: string; count: number }>;
}

/** 职位榜：同一 title_key 的岗位跨城市只计一次，cities 与 top_skills 各取前 3。 */
export interface CareerTitleV1 {
  title_key: string;
  title_display: string;
  job_count: number;
  company_count: number;
  cities: string[];
  top_skills: Array<{ skill: string; count: number }>;
  student_friendly_count: number;
  latest_published_at: string | null;
}

/** 技能榜：share = job_count / 有技能岗位数，未识别技能的岗位不进分母。 */
export interface CareerSkillV1 {
  skill: string;
  job_count: number;
  share: number;
}

/**
 * 岗位目录：方向榜、职位榜、技能榜共用一次全库快照。
 * directions 与 titles 各受 limit 限制；skills 固定取前 10。空表时三个数组都为空。
 * 方向榜只统计已归类（role_family != unknown）的岗位，未归类岗位的数量与占比单独披露，
 * 页面据此说明榜单口径，并解释「仅学生友好」时方向榜合计与岗位明细的差额。
 */
export interface CareerCatalogResponseV1 {
  contract_version: "0.1";
  data_origin: DataOrigin;
  as_of: string;
  window_days: number;
  sample_size: number;
  /** 未归类（role_family=unknown）的岗位数；方向榜不含这些岗位。 */
  unclassified_job_count?: number;
  /** 未归类岗位中学生友好（student_friendly=yes）的岗位数；方向榜的学生友好口径同样不含它们。 */
  unclassified_student_friendly_count?: number;
  /** 未归类岗位占 sample_size 的比例；空表为 null。 */
  unclassified_ratio?: number | null;
  directions: CareerDirectionV1[];
  titles: CareerTitleV1[];
  skills: CareerSkillV1[];
}

/**
 * 离线 LLM 研判缓存：学生访问直接读最近一次生成结果，无缓存时 API 返回 204。
 * 数字来自聚合指标，模型只产出文字；观测日不足 2 天时 confidence="low" 且不做走势断言。
 */
export interface CareerBriefV1 {
  contract_version: "0.1";
  generated_at: string;
  as_of: string;
  sample_size: number;
  window_days: number;
  facts: string[];
  inferences: string[];
  actions: string[];
  evidence: Array<{ kind: "job" | "policy"; id: string; title: string }>;
  limitations: string[];
  confidence: "low" | "medium" | "high";
}

/**
 * 就业日报 AI 评论缓存（后台预生成）：每日管线按 (comment_date, prompt_version) upsert，
 * 学生访问 /daily-comment 只读这一行，无缓存时 API 返回 204，页面不触发模型调用。
 * comment 里的数字只来自输入 facts 与聚合字段（sample_size / new_jobs / Top3 计数），模型不参与数字计算；
 * evidence 是当日新增岗位/政策的可引用 id，title 以库内为准。
 */
export interface CareerDailyCommentResponseV1 {
  contract_version: "0.1";
  /** Asia/Shanghai 自然日（YYYY-MM-DD）。 */
  date: string;
  as_of: string;
  generated_at: string;
  sample_size: number;
  new_jobs: number;
  confidence: "low" | "medium" | "high";
  comment: string;
  facts: string[];
  evidence: Array<{ kind: "job" | "policy"; id: string; title: string }>;
}

/** 收藏的岗位在站内是否还能打开详情页。 */
export type JobAvailabilityStatus = "visible" | "missing";

/**
 * 收藏页的岗位可用性批量探测（GET /api/site/career-insights/jobs/availability）。
 * 收藏快照只存在浏览器本地，收藏页无法从列表判断岗位是否还在；这里只回答「详情页现在是否存在」，
 * 可见性与 jobDetail 一致（career_jobs 有该行即可见）。未知 id 记 missing，不泄露岗位的其它信息。
 */
export interface JobAvailabilityResponseV1 {
  contract_version: "0.1";
  /** 键为小写 UUID，每个请求 id（去重后）都有一项。 */
  ids: Record<string, JobAvailabilityStatus>;
}
