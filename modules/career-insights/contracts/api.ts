import type {
  DataOrigin,
  DegreeLevel,
  EmploymentType,
  MetricSpecV1,
  NormalizedJobV1,
  PolicyEvidenceRefV1,
  RoleFamily,
  StudentFriendly,
} from "./job.ts";

export interface EvidenceLinkV1 {
  kind: "job" | "observation" | "policy";
  id: string;
  title: string;
  official_url: string;
}

export interface CareerWarningV1 {
  code: "source_failed" | "insufficient_data" | "unknown_fields" | "stale_data" | "synthetic_fixture";
  message: string;
}

export interface MetricResultV1 {
  metric_id: MetricSpecV1["metric_id"];
  version: "1.0";
  label: string;
  unit: MetricSpecV1["unit"];
  status: "ok" | "insufficient_data" | "not_applicable";
  value: number | null;
  numerator_count: number;
  denominator_count: number | null;
  sample_size: number;
  as_of: string;
  dimension: { role_family?: RoleFamily; skill_id?: string; theme_id?: string };
  unknown_count?: number;
  unknown_ratio?: number | null;
  dictionary_version?: string;
  evidence: EvidenceLinkV1[];
  disclaimer: string;
}

export interface SharedThemeV1 {
  theme_id: string;
  label: string;
  policy_count: number;
  job_count: number;
  policies: PolicyEvidenceRefV1[];
  jobs: EvidenceLinkV1[];
}

export interface SummaryResponseV1 {
  contract_version: "0.1";
  data_origin: DataOrigin;
  as_of: string;
  sample_size: number;
  company_count: number;
  source_count: number;
  first_observed_at: string;
  last_observed_at: string;
  has_multiple_snapshots: boolean;
  metrics: MetricResultV1[];
  shared_themes: SharedThemeV1[];
  dictionary_version: string;
  warnings: CareerWarningV1[];
}

export interface JobFiltersV1 {
  role_family?: RoleFamily;
  company?: string;
  city?: string;
  employment_type?: EmploymentType;
  student_friendly?: StudentFriendly;
  skill?: string;
  /** 关键词：同时匹配职位名、公司名、技能与城市；不区分大小写，空串忽略，最长 100 字符。 */
  q?: string;
  page: number;
  page_size: number;
}

export interface JobListItemV1 {
  id: string;
  company_name: string;
  title: string;
  role_family: RoleFamily;
  locations: string[];
  employment_type: EmploymentType;
  student_friendly: StudentFriendly;
  skills: string[];
  published_at: string | null;
  first_seen_at: string;
  last_seen_at: string;
  official_url: string;
}

export interface JobListResponseV1 {
  contract_version: "0.1";
  data_origin: DataOrigin;
  items: JobListItemV1[];
  page: number;
  page_size: number;
  total: number;
  as_of: string;
  filters: JobFiltersV1;
}

export interface ObservationPublicV1 {
  id: string;
  observed_at: string;
  content_hash: string;
  collector_version: string;
  source_url: string;
  evidence_excerpt: string;
}

export interface JobDetailV1 extends JobListItemV1 {
  source_key: string;
  job_key: string;
  degree: DegreeLevel;
  degree_raw: string | null;
  experience_min_years: number | null;
  experience_max_years: number | null;
  experience_raw: string | null;
  skill_evidence: Array<{ skill_id: string; evidence_text: string }>;
  collector_version: string;
}

export interface JobDetailResponseV1 {
  contract_version: "0.1";
  data_origin: DataOrigin;
  job: JobDetailV1;
  observations: ObservationPublicV1[];
  notice: string;
}

export interface CareerObservationBatchV1 {
  schema_version: "1.0";
  /**
   * 必须为已启用的注册来源（CAREER_SOURCE_DEFINITIONS 中 kind 为 job 类别的条目）；
   * 未登记或停用的来源整批拒绝，返回 invalid_parameter（details.parameter = "source_key"）。
   * 逐条闭合：每个 job 自带的 source_key（若存在）也必须已登记、启用且与本字段一致，否则该条
   * 计入 rejected 并记 validation_failed，不写库。
   */
  source_key: string;
  fetched_at: string;
  collector_version: string;
  jobs: NormalizedJobV1[];
}

export interface IngestResultV1 {
  accepted: number;
  updated: number;
  duplicates: number;
  rejected: number;
  errors: Array<{ index: number; code: string; message: string }>;
}

export interface ApiErrorResponseV1 {
  error: {
    code: "invalid_parameter" | "not_found" | "data_unavailable" | "internal_error";
    message: string;
    details?: Record<string, unknown>;
  };
}