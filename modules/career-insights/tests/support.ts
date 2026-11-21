// career-insights 路由/能力测试共用的假数据：只构造公开契约要求的最小字段，
// 不碰数据库、不读真实数据。测试按需 override，用到未提供的读取方法时直接抛错。
import type {
  JobDetailResponseV1,
  JobFiltersV1,
  JobListResponseV1,
} from "../contracts/api.ts";
import type {
  CareerBriefV1,
  CareerCatalogResponseV1,
  CareerDailyCommentResponseV1,
  CareerDailyResponseV1,
  CareerHotResponseV1,
  CareerSignalsResponseV1,
} from "../contracts/insights.ts";
import type { PolicyFiltersV1, PolicyListResponseV1 } from "../backend/policy-read.ts";
import type { CareerRepository } from "../backend/repository.ts";

export const AS_OF = "2026-11-21T00:00:00.000Z";

export const JOB_ID = "0b6f3a3c-5f6e-4b0e-9d5e-2f4f1a2b3c4d";

export function jobItem(overrides: Partial<JobListResponseV1["items"][number]> = {}): JobListResponseV1["items"][number] {
  return {
    id: JOB_ID,
    company_name: "示例科技",
    title: "数据分析工程师",
    role_family: "data",
    locations: ["北京"],
    employment_type: "campus",
    student_friendly: "yes",
    skills: ["python", "sql"],
    published_at: null,
    first_seen_at: "2026-11-01T00:00:00.000Z",
    last_seen_at: AS_OF,
    official_url: "https://careers.example/jobs/1",
    ...overrides,
  };
}

export function jobList(overrides: Partial<JobListResponseV1> = {}): JobListResponseV1 {
  const filters: JobFiltersV1 = { page: 1, page_size: 20 };
  return {
    contract_version: "0.1",
    data_origin: "live",
    items: [jobItem()],
    page: 1,
    page_size: 20,
    total: 1,
    as_of: AS_OF,
    filters,
    ...overrides,
  };
}

export function jobDetail(overrides: Partial<JobDetailResponseV1> = {}): JobDetailResponseV1 {
  return {
    contract_version: "0.1",
    data_origin: "live",
    job: {
      ...jobItem(),
      source_key: "career-test",
      job_key: "job-1",
      degree: "bachelor",
      degree_raw: "本科",
      experience_min_years: null,
      experience_max_years: null,
      experience_raw: null,
      skill_evidence: [{ skill_id: "python", evidence_text: "熟悉 Python" }],
      collector_version: "test-collector-1",
    },
    observations: [
      {
        id: "42",
        observed_at: AS_OF,
        content_hash: "a".repeat(64),
        collector_version: "test-collector-1",
        source_url: "https://careers.example/jobs/1",
        evidence_excerpt: "岗位职责节选",
      },
    ],
    notice: "当前状态以最近一次成功观测为准；单次未采集到不代表职位已下架。",
    ...overrides,
  };
}

export function policyList(overrides: Partial<PolicyListResponseV1> = {}): PolicyListResponseV1 {
  const filters: PolicyFiltersV1 = { page: 1, page_size: 20 };
  return {
    contract_version: "0.1",
    data_origin: "live",
    as_of: AS_OF,
    items: [
      {
        policy_item_id: "policy-1",
        title: "关于促进高校毕业生就业的通知",
        issuer: "示例部门",
        published_at: "2026-11-10",
        official_url: "https://example.gov/policy/1",
        source_tier: "government_official",
        theme_ids: ["employment_promotion"],
        evidence_excerpt: "政策原文节选",
      },
    ],
    page: 1,
    page_size: 20,
    total: 1,
    filters,
    facets: { sources: [{ source_key: "career-test", count: 1 }], themes: [{ theme_id: "employment_promotion", count: 1 }] },
    ...overrides,
  };
}

export function brief(overrides: Partial<CareerBriefV1> = {}): CareerBriefV1 {
  return {
    contract_version: "0.1",
    generated_at: "2026-11-21T01:00:00.000Z",
    as_of: AS_OF,
    sample_size: 12,
    window_days: 30,
    facts: ["当前样本量为 12 个岗位"],
    inferences: ["观察窗 30 天内方向结构保持稳定"],
    actions: ["先补齐常用技能的项目经历"],
    evidence: [{ kind: "job", id: JOB_ID, title: "数据分析工程师" }],
    limitations: ["只覆盖已采集的官方岗位"],
    confidence: "medium",
    ...overrides,
  };
}

export function dailyComment(): CareerDailyCommentResponseV1 {
  return {
    contract_version: "0.1",
    date: "2026-11-21",
    as_of: AS_OF,
    generated_at: "2026-11-21T01:00:00.000Z",
    sample_size: 12,
    new_jobs: 3,
    confidence: "medium",
    comment: "今日新增岗位以数据方向为主。",
    facts: ["新增 3 个岗位"],
    evidence: [{ kind: "job", id: JOB_ID, title: "数据分析工程师" }],
  };
}

/** 只用于缓存头测试：每个只读端点都有一份最小合法响应，内容本身不参与断言。 */
export function readOnlyRepository(overrides: Partial<CareerRepository> = {}): CareerRepository {
  const empty = async (): Promise<never> => {
    throw new Error("writeBatch is not available in a read-only test repository");
  };
  return {
    summary: async () => ({
      contract_version: "0.1",
      data_origin: "live",
      as_of: AS_OF,
      sample_size: 1,
      company_count: 1,
      source_count: 1,
      first_observed_at: AS_OF,
      last_observed_at: AS_OF,
      has_multiple_snapshots: false,
      metrics: [],
      shared_themes: [],
      dictionary_version: "0.1",
      warnings: [],
    }),
    listJobs: async (filters) => jobList({ filters }),
    jobDetail: async () => jobDetail(),
    jobAvailability: async (ids) => ({ contract_version: "0.1", ids: Object.fromEntries(ids.map((id) => [id, "missing"])) }),
    listPolicies: async (filters) => policyList({ filters }),
    hotCompanies: async (): Promise<CareerHotResponseV1> => ({
      contract_version: "0.1",
      data_origin: "live",
      as_of: AS_OF,
      window_days: 30,
      entries: [],
    }),
    dailySummary: async (): Promise<CareerDailyResponseV1> => ({
      contract_version: "0.1",
      data_origin: "live",
      date: "2026-11-21",
      sources: [],
      has_run: false,
      jobs_total: 1,
      new_jobs_today: 0,
      new_policies_today: 0,
      policies_total: 1,
      unknown_ratio: null,
      sample_size: 1,
      generated_at: AS_OF,
    }),
    careerSignals: async (): Promise<CareerSignalsResponseV1> => ({
      contract_version: "0.1",
      data_origin: "live",
      window_days: 30,
      signals: [],
      skipped: [],
      generated_at: AS_OF,
    }),
    careerCatalog: async (): Promise<CareerCatalogResponseV1> => ({
      contract_version: "0.1",
      data_origin: "live",
      as_of: AS_OF,
      window_days: 30,
      sample_size: 1,
      directions: [],
      titles: [],
      skills: [],
    }),
    careerBrief: async () => brief(),
    careerDailyComment: async () => dailyComment(),
    writeBatch: empty,
    ...overrides,
  };
}
