import type {
  JobDetailResponseV1,
  JobListItemV1,
  JobListResponseV1,
  SummaryResponseV1,
} from "../contracts/api.ts";
import type { PolicyEvidenceRefV1 } from "../contracts/index.ts";
import type {
  CareerDailyResponseV1,
  CareerHotResponseV1,
  CareerSignalsResponseV1,
} from "../contracts/insights.ts";

const FIXTURE_AS_OF = "2026-01-01T00:00:00.000Z";
const FIXTURE_JOB_ID = "00000000-0000-4000-8000-000000000001";
const FIXTURE_OBSERVATION_ID = "00000000-0000-4000-8000-000000000002";
const FIXTURE_JOB_URL = "https://careers.example/jobs/synthetic-ai-001";
const FIXTURE_CONTENT_HASH = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const FIXTURE_JOB_LIST_ITEM: JobListItemV1 = {
  id: FIXTURE_JOB_ID,
  company_name: "虚构样例科技有限公司",
  title: "联调样例：AI 应用开发实习生（非真实职位）",
  role_family: "ai_application_development",
  locations: ["虚构市"],
  employment_type: "internship",
  student_friendly: "yes",
  skills: ["python", "large_language_models"],
  published_at: null,
  first_seen_at: FIXTURE_AS_OF,
  last_seen_at: FIXTURE_AS_OF,
  official_url: FIXTURE_JOB_URL,
};

const FIXTURE_JOB_EVIDENCE = {
  kind: "job" as const,
  id: FIXTURE_JOB_ID,
  title: FIXTURE_JOB_LIST_ITEM.title,
  official_url: FIXTURE_JOB_URL,
};

export const FIXTURE_SUMMARY_V1: SummaryResponseV1 = {
  contract_version: "0.1",
  data_origin: "synthetic_fixture",
  as_of: FIXTURE_AS_OF,
  sample_size: 1,
  company_count: 1,
  source_count: 1,
  first_observed_at: FIXTURE_AS_OF,
  last_observed_at: FIXTURE_AS_OF,
  has_multiple_snapshots: false,
  metrics: [
    {
      metric_id: "job_family_share",
      version: "1.0",
      label: "职族职位占比",
      unit: "ratio",
      status: "ok",
      value: 1,
      numerator_count: 1,
      denominator_count: 1,
      sample_size: 1,
      as_of: FIXTURE_AS_OF,
      dimension: { role_family: "ai_application_development" },
      unknown_count: 0,
      unknown_ratio: 0,
      evidence: [FIXTURE_JOB_EVIDENCE],
      disclaimer: "虚构单职位样例，仅用于联调，不代表整体招聘市场。",
    },
    {
      metric_id: "skill_demand_share",
      version: "1.0",
      label: "技能需求占比",
      unit: "ratio",
      status: "ok",
      value: 1,
      numerator_count: 1,
      denominator_count: 1,
      sample_size: 1,
      as_of: FIXTURE_AS_OF,
      dimension: { skill_id: "large_language_models" },
      dictionary_version: "0.1",
      evidence: [FIXTURE_JOB_EVIDENCE],
      disclaimer: "虚构技能与证据，仅用于验证指标展示，不代表真实技能需求。",
    },
    {
      metric_id: "student_friendly_share",
      version: "1.0",
      label: "学生友好职位占比",
      unit: "ratio",
      status: "ok",
      value: 1,
      numerator_count: 1,
      denominator_count: 1,
      sample_size: 1,
      as_of: FIXTURE_AS_OF,
      dimension: {},
      unknown_count: 0,
      unknown_ratio: 0,
      evidence: [FIXTURE_JOB_EVIDENCE],
      disclaimer: "虚构学生友好标签，仅用于联调，不构成真实职位推荐。",
    },
    {
      metric_id: "observed_new_jobs",
      version: "1.0",
      label: "观测新增职位数",
      unit: "count",
      status: "insufficient_data",
      value: null,
      numerator_count: 0,
      denominator_count: null,
      sample_size: 1,
      as_of: FIXTURE_AS_OF,
      dimension: {},
      evidence: [
        {
          kind: "observation",
          id: FIXTURE_OBSERVATION_ID,
          title: "虚构单快照观测",
          official_url: FIXTURE_JOB_URL,
        },
      ],
      disclaimer: "只有一个虚构观测快照，无法计算新增职位或趋势。",
    },
    {
      metric_id: "policy_job_shared_themes",
      version: "1.0",
      label: "政策与职位共享主题",
      unit: "theme_list",
      status: "insufficient_data",
      value: null,
      numerator_count: 0,
      denominator_count: null,
      sample_size: 1,
      as_of: FIXTURE_AS_OF,
      dimension: {},
      dictionary_version: "0.1",
      evidence: [],
      disclaimer: "未提供政策证据，不生成共享主题，也不暗示任何真实政策或趋势。",
    },
  ],
  shared_themes: [],
  dictionary_version: "0.1",
  warnings: [
    {
      code: "synthetic_fixture",
      message: "联调样例（非真实数据）：公司、职位、证据与指标均为虚构。",
    },
    {
      code: "insufficient_data",
      message: "仅有单个虚构快照，新增职位与共享主题证据不足。",
    },
  ],
};

export const FIXTURE_JOB_LIST_V1: JobListResponseV1 = {
  contract_version: "0.1",
  data_origin: "synthetic_fixture",
  items: [FIXTURE_JOB_LIST_ITEM],
  page: 1,
  page_size: 20,
  total: 1,
  as_of: FIXTURE_AS_OF,
  filters: { page: 1, page_size: 20 },
};

export const FIXTURE_JOB_DETAIL_V1: JobDetailResponseV1 = {
  contract_version: "0.1",
  data_origin: "synthetic_fixture",
  job: {
    ...FIXTURE_JOB_LIST_ITEM,
    source_key: "synthetic-careers",
    job_key: "synthetic-job-001",
    degree: "bachelor",
    degree_raw: "本科及以上（虚构样例）",
    experience_min_years: null,
    experience_max_years: null,
    experience_raw: null,
    skill_evidence: [
      {
        skill_id: "python",
        evidence_text: "虚构职位文本：使用 Python 完成样例开发。",
      },
      {
        skill_id: "large_language_models",
        evidence_text: "虚构职位文本：参与大语言模型应用联调。",
      },
    ],
    collector_version: "fixture-0.1",
  },
  observations: [
    {
      id: FIXTURE_OBSERVATION_ID,
      observed_at: FIXTURE_AS_OF,
      content_hash: FIXTURE_CONTENT_HASH,
      collector_version: "fixture-0.1",
      source_url: FIXTURE_JOB_URL,
      evidence_excerpt: "虚构观测摘录，仅用于验证详情页与单快照状态。",
    },
  ],
  notice: "联调样例（非真实数据）；公司、职位、观测与指标均为虚构。",
};
const FIXTURE_POLICY_ITEMS: PolicyEvidenceRefV1[] = [
  {
    policy_item_id: "synthetic-policy-001",
    title: "示例政策：推动人工智能人才培养（虚构）",
    issuer: "示例国家部门",
    published_at: "2026-11-18",
    official_url: "https://example.com/policies/sample-001",
    source_tier: "government_official",
    theme_ids: ["artificial_intelligence", "talent_development"],
    evidence_excerpt: "支持高校与企业联合培养人工智能人才。",
  },
  {
    policy_item_id: "synthetic-policy-002",
    title: "示例政策：数据基础设施建设（虚构）",
    issuer: "示例发展部门",
    published_at: "2026-11-16",
    official_url: "https://example.com/policies/sample-002",
    source_tier: "government_official",
    theme_ids: ["digital_economy", "data_infrastructure"],
    evidence_excerpt: "推进算力与数据要素流通。",
  },
  {
    policy_item_id: "synthetic-policy-003",
    title: "示例政策：高校毕业生就业促进（虚构）",
    issuer: "示例教育部门",
    published_at: "2026-11-14",
    official_url: "https://example.com/policies/sample-003",
    source_tier: "government_official",
    theme_ids: ["talent_development", "employment_promotion"],
    evidence_excerpt: "拓展高校毕业生就业渠道。",
  },
  {
    policy_item_id: "synthetic-policy-004",
    title: "示例政策：人工智能技术创新（虚构）",
    issuer: "示例国家部门",
    published_at: "2026-11-12",
    official_url: "https://example.com/policies/sample-004",
    source_tier: "government_official",
    theme_ids: ["ai_innovation"],
    evidence_excerpt: "鼓励大模型与智能体技术研发。",
  },
  {
    policy_item_id: "synthetic-policy-005",
    title: "示例政策：产业数字化升级（虚构）",
    issuer: "示例发展部门",
    published_at: "2026-11-10",
    official_url: "https://example.com/policies/sample-005",
    source_tier: "government_official",
    theme_ids: ["industrial_digitalization"],
    evidence_excerpt: "推动制造业数智化改造。",
  },
  {
    policy_item_id: "synthetic-policy-006",
    title: "示例政策：稳就业专项行动（虚构）",
    issuer: "示例教育部门",
    published_at: "2026-11-08",
    official_url: "https://example.com/policies/sample-006",
    source_tier: "government_official",
    theme_ids: ["employment_promotion"],
    evidence_excerpt: "开展稳就业与就业创业服务。",
  },
];

/** 联调样例：`total` 与 `items` 保持一致（6 条）；真实政策数据来自数据库，不在此处。 */
export const FIXTURE_POLICY_LIST_V1 = {
  contract_version: "0.1" as const,
  data_origin: "synthetic_fixture" as const,
  as_of: FIXTURE_AS_OF,
  items: FIXTURE_POLICY_ITEMS,
  page: 1,
  page_size: 20,
  total: 6,
  filters: { page: 1, page_size: 20 },
};
/** 联调样例：企业招聘热度榜（两个虚构企业，其中一个没有发布日期）。 */
export const FIXTURE_HOT_V1: CareerHotResponseV1 = {
  contract_version: "0.1",
  data_origin: "synthetic_fixture",
  as_of: FIXTURE_AS_OF,
  window_days: 30,
  entries: [
    {
      company: "虚构样例科技有限公司",
      job_count: 12,
      latest_published_at: "2026-01-01T09:00:00.000Z",
      role_families: [
        { role_family: "ai_algorithm", count: 5 },
        { role_family: "ai_application_development", count: 4 },
        { role_family: "data", count: 2 },
        { role_family: "ai_product_operations", count: 1 },
      ],
    },
    {
      company: "虚构智能制造有限公司",
      job_count: 3,
      latest_published_at: null,
      role_families: [{ role_family: "data", count: 2 }],
    },
  ],
};

/** 联调样例：今日就业日报（一次已完成的采集，两个来源）。 */
export const FIXTURE_DAILY_V1: CareerDailyResponseV1 = {
  contract_version: "0.1",
  data_origin: "synthetic_fixture",
  date: "2026-01-01",
  sources: [
    { source_key: "synthetic-careers", collected: 20, accepted: 15, updated: 3, duplicates: 2, status: "ok" },
    { source_key: "synthetic-policy", collected: 8, accepted: 6, updated: 0, duplicates: 2, status: "partial" },
  ],
  has_run: true,
  jobs_total: 128,
  new_jobs_today: 15,
  new_policies_today: 6,
  policies_total: 42,
  unknown_ratio: 0.125,
  sample_size: 128,
  generated_at: FIXTURE_AS_OF,
};

/** 联调样例：异常信号（三类规则）与一条因历史不足跳过的突增项。 */
export const FIXTURE_SIGNALS_V1: CareerSignalsResponseV1 = {
  contract_version: "0.1",
  data_origin: "synthetic_fixture",
  window_days: 30,
  signals: [
    {
      rule: "cross_industry",
      company: "虚构样例科技有限公司",
      job_id: FIXTURE_JOB_ID,
      job_title: "联调样例：AI 应用开发实习生（非真实职位）",
      evidence: { company_job_count: 12, ai_family_job_count: 10, ai_family_ratio: 0.833, matched_terms: ["机械工程"] },
      reason_text: "该公司 12 个岗位中有 10 个属于算法/AI 族（83.3%），同时出现机械工程岗位。",
      source_key: "synthetic-careers",
      official_url: FIXTURE_JOB_URL,
      first_seen_at: FIXTURE_AS_OF,
      confidence: "high",
    },
    {
      rule: "new_family",
      company: "虚构智能制造有限公司",
      job_id: "00000000-0000-4000-8000-000000000011",
      job_title: "联调样例：数据平台工程师（非真实职位）",
      evidence: { role_family: "data", family_job_count: 2, window_days: 30, earliest_first_seen_at: FIXTURE_AS_OF },
      reason_text: "该公司近 30 天首次出现数据职族，共 2 个岗位。",
      source_key: "synthetic-careers",
      official_url: "https://careers.example/jobs/synthetic-ai-011",
      first_seen_at: FIXTURE_AS_OF,
      confidence: "medium",
    },
    {
      rule: "skill_mismatch",
      company: "虚构新创有限公司",
      job_id: "00000000-0000-4000-8000-000000000012",
      job_title: "联调样例：大模型算法工程师（非真实职位）",
      evidence: { matched_title_terms: ["大模型"], matched_skill_terms: ["硬件调试"] },
      reason_text: "标题含大模型类关键词，但岗位要求硬件调试技能。",
      source_key: "synthetic-careers",
      official_url: "https://careers.example/jobs/synthetic-ai-012",
      first_seen_at: FIXTURE_AS_OF,
      confidence: "medium",
    },
  ],
  skipped: [{ rule: "surge", company: "虚构新创有限公司", reason: "insufficient_history", history_days: 1 }],
  generated_at: FIXTURE_AS_OF,
};
