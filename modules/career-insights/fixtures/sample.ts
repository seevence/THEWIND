import type {
  NormalizedJobV1,
  PolicyEvidenceRefV1,
  RawCollectedJobV1,
} from "../contracts/index.ts";
import { dedupeNormalizedJobs } from "../data/dedupe.ts";
import {
  computeCareerMetrics,
  type CareerMetricsResultV1,
  type ObservationSnapshotV1,
  type QualityJobInputV1,
} from "../data/index.ts";
import { normalizeRawJobs, type NormalizeResultV1 } from "../data/normalize.ts";

/**
 * C 的明确样例（synthetic_fixture）。全部公司、职位与政策均为虚构，
 * 只用于验证归一化、去重、未知字段与五项指标，不得当作真实数据。
 */
export const SAMPLE_FETCHED_AT = "2026-11-16T12:00:00.000Z";
export const SAMPLE_GENERATED_AT = "2026-11-16T12:05:00.000Z";

const SAMPLE_IDS = [
  "10000000-0000-4000-8000-000000000001",
  "10000000-0000-4000-8000-000000000002",
  "10000000-0000-4000-8000-000000000003",
  "10000000-0000-4000-8000-000000000004",
  "10000000-0000-4000-8000-000000000005",
  "10000000-0000-4000-8000-000000000006",
] as const;

const SAMPLE_FIRST_SEEN = [
  "2026-11-10T00:00:00.000Z",
  "2026-11-12T00:00:00.000Z",
  "2026-11-14T00:00:00.000Z",
  "2026-11-15T00:00:00.000Z",
  "2026-11-15T00:00:00.000Z",
  "2026-11-16T00:00:00.000Z",
] as const;

export const FIXTURE_RAW_JOBS: readonly RawCollectedJobV1[] = [
  {
    schema_version: "1.0",
    source_key: "synthetic-sample-jia",
    source_job_id: "sample-001",
    company_name: "示例科技甲",
    title: "大模型算法工程师",
    official_url: "https://example.com/careers/sample/001",
    raw_text:
      "负责大模型训练与推理优化，熟悉 Python、PyTorch、大语言模型与 Transformer。要求硕士及以上学历，3-5 年经验。工作地点：北京。",
    published_at: "2026-11-10",
    fetched_at: SAMPLE_FETCHED_AT,
    collector_version: "fixture/0.1.0",
    hints: { locations: ["北京"] },
  },
  {
    schema_version: "1.0",
    source_key: "synthetic-sample-yi",
    source_job_id: "sample-002",
    company_name: "示例科技乙",
    title: "AI 应用后端开发工程师",
    official_url: "https://example.com/careers/sample/002",
    raw_text:
      "负责 AI 应用后端服务开发，熟悉 Python、Java、Docker 与 RAG 检索增强。要求本科及以上学历，1-3 年经验。工作地点：深圳。",
    published_at: "2026-11-12",
    fetched_at: SAMPLE_FETCHED_AT,
    collector_version: "fixture/0.1.0",
    hints: { locations: ["深圳"] },
  },
  {
    schema_version: "1.0",
    source_key: "synthetic-sample-bing",
    source_job_id: "sample-003",
    company_name: "示例科技丙",
    title: "数据分析师（校园招聘）",
    official_url: "https://example.com/careers/sample/003",
    raw_text:
      "2027 届校园招聘，欢迎应届生投递。负责业务数据分析与指标建设，熟悉 SQL、Python 与 Spark。学历不限。工作地点：北京。",
    published_at: "2026-11-14",
    fetched_at: SAMPLE_FETCHED_AT,
    collector_version: "fixture/0.1.0",
    hints: { locations: ["北京"] },
  },
  {
    schema_version: "1.0",
    source_key: "synthetic-sample-jia",
    source_job_id: "sample-004",
    company_name: "示例科技甲",
    title: "AI 产品经理",
    official_url: "https://example.com/careers/sample/004",
    raw_text:
      "负责 AI 产品设计与需求文档，参与用户研究与 A/B 测试。经验不限，欢迎应届生。要求本科及以上学历。工作地点：杭州。",
    published_at: "2026-11-08",
    fetched_at: SAMPLE_FETCHED_AT,
    collector_version: "fixture/0.1.0",
    hints: { locations: ["杭州"] },
  },
  {
    schema_version: "1.0",
    source_key: "synthetic-sample-yi",
    source_job_id: "sample-005",
    company_name: "示例科技乙",
    title: "计算机视觉算法实习生",
    official_url: "https://example.com/careers/sample/005",
    raw_text:
      "日常实习，参与计算机视觉与深度学习算法研发，熟悉 Python 与 PyTorch。本科及以上学历。工作地点：上海。",
    published_at: "2026-11-15",
    fetched_at: SAMPLE_FETCHED_AT,
    collector_version: "fixture/0.1.0",
    hints: { locations: ["上海"] },
  },
  {
    schema_version: "1.0",
    source_key: "synthetic-sample-bing",
    source_job_id: "sample-006",
    company_name: "示例科技丙",
    title: "平台开发工程师",
    official_url: "https://example.com/careers/sample/006",
    raw_text: "负责内部平台稳定性与工具维护。工作地点：北京。",
    published_at: null,
    fetched_at: SAMPLE_FETCHED_AT,
    collector_version: "fixture/0.1.0",
    hints: { locations: ["北京"] },
  },
];

export const SAMPLE_POLICIES: readonly PolicyEvidenceRefV1[] = [
  {
    policy_item_id: "synthetic-policy-001",
    title: "示例政策：人工智能应用方向（虚构）",
    issuer: "示例部门",
    published_at: "2026-08-26",
    official_url: "https://example.com/policies/sample-001",
    source_tier: "national",
    theme_ids: ["artificial_intelligence", "employment_promotion"],
    evidence_excerpt: "推动人工智能应用与高校毕业生就业。",
  },
  {
    policy_item_id: "synthetic-policy-002",
    title: "示例政策：数据基础设施方向（虚构）",
    issuer: "示例部门",
    published_at: "2026-10-09",
    official_url: "https://example.com/policies/sample-002",
    source_tier: "national",
    theme_ids: ["data_infrastructure", "talent_development"],
    evidence_excerpt: "优化数据基础设施布局，加强人才培养。",
  },
];

export interface SyntheticSampleDatasetV1 {
  data_origin: "synthetic_fixture";
  generated_at: string;
  raw_jobs: readonly RawCollectedJobV1[];
  normalized_jobs: readonly NormalizedJobV1[];
  metric_jobs: readonly QualityJobInputV1[];
  snapshots: readonly ObservationSnapshotV1[];
  policies: readonly PolicyEvidenceRefV1[];
  rejected: NormalizeResultV1["rejected"];
}

/** 走真实归一化与去重链路生成样例，保证样例与生产函数一致。 */
export function buildSyntheticSampleDataset(): SyntheticSampleDatasetV1 {
  const { normalized, rejected } = normalizeRawJobs(FIXTURE_RAW_JOBS);
  const { unique } = dedupeNormalizedJobs(normalized);

  const metricJobs: QualityJobInputV1[] = unique.map((job, index) => {
    const id = SAMPLE_IDS[index] ?? SAMPLE_IDS[0];
    const firstSeenAt = SAMPLE_FIRST_SEEN[index] ?? SAMPLE_FETCHED_AT;
    return {
      id,
      source_key: job.source_key,
      job_key: job.job_key,
      company_name: job.company_name,
      title: job.title,
      role_family: job.role_family,
      locations: job.locations,
      degree: job.degree,
      employment_type: job.employment_type,
      student_friendly: job.student_friendly,
      skills: job.skills,
      published_at: job.published_at,
      first_seen_at: firstSeenAt,
      last_seen_at: SAMPLE_FETCHED_AT,
      official_url: job.official_url,
      experience_min_years: job.experience_min_years,
      experience_max_years: job.experience_max_years,
      experience_raw: job.experience_raw,
    };
  });

  const snapshots: ObservationSnapshotV1[] = [
    { observed_at: "2026-11-15T00:00:00.000Z", job_ids: metricJobs.slice(0, 5).map((job) => job.id) },
    { observed_at: SAMPLE_FETCHED_AT, job_ids: metricJobs.map((job) => job.id) },
  ];

  return {
    data_origin: "synthetic_fixture",
    generated_at: SAMPLE_GENERATED_AT,
    raw_jobs: FIXTURE_RAW_JOBS,
    normalized_jobs: unique,
    metric_jobs: metricJobs,
    snapshots,
    policies: SAMPLE_POLICIES,
    rejected,
  };
}

/** 用样例直接跑五项指标，供 D 的 summary 与 E 的看板联调。 */
export function buildSyntheticSampleMetrics(): CareerMetricsResultV1 {
  const dataset = buildSyntheticSampleDataset();
  return computeCareerMetrics({
    jobs: dataset.metric_jobs,
    snapshots: dataset.snapshots,
    policies: dataset.policies,
    options: { as_of: SAMPLE_GENERATED_AT },
  });
}