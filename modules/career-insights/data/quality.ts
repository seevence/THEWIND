import type { MetricJobInputV1 } from "./metrics.ts";

/** 质量抽查比指标计算多需要经验字段，避免把“未写经验”当成 0 年。 */
export interface QualityJobInputV1 extends MetricJobInputV1 {
  experience_min_years: number | null;
  experience_max_years: number | null;
  experience_raw: string | null;
}

export interface FieldCoverageV1 {
  field: string;
  known: number;
  unknown: number;
  total: number;
  known_ratio: number | null;
}

export interface SkillCoverageV1 {
  jobs_with_skills: number;
  jobs_without_skills: number;
  /** 至少识别到一个技能的职位占比，不是单个技能的需求占比。 */
  recognized_skill_ratio: number | null;
  distinct_skills: number;
  top_skills: Array<{ skill_id: string; job_count: number }>;
}

export interface DedupeSummaryV1 {
  input_count: number;
  unique_count: number;
  duplicate_count: number;
}

export interface SampleInspectionOptionsV1 {
  as_of: string;
  /** 去重前输入条数；未提供时等于 jobs.length。 */
  input_count?: number;
  /** 被去重掉的条数；未提供时按 input_count - jobs.length 计算。 */
  duplicate_count?: number;
}

export interface SampleInspectionV1 {
  sample_size: number;
  company_count: number;
  source_count: number;
  as_of: string;
  field_coverage: FieldCoverageV1[];
  skill_coverage: SkillCoverageV1;
  dedupe: DedupeSummaryV1;
  limitations: string[];
}

/**
 * C 的样本抽查：只读归一化后的职位，统计字段覆盖率、技能识别率与未知比例，
 * 同时输出样本限制，供 API summary 与页面文案复用。不修改任何输入。
 */
export function inspectMetricSample(
  jobs: readonly QualityJobInputV1[],
  options: SampleInspectionOptionsV1,
): SampleInspectionV1 {
  const sampleSize = jobs.length;
  const fieldCoverage: FieldCoverageV1[] = [
    coverage("role_family", jobs, (job) => job.role_family !== "unknown"),
    coverage("locations", jobs, (job) => job.locations.length > 0),
    coverage("degree", jobs, (job) => job.degree !== "unknown"),
    coverage("experience", jobs, (job) => hasExperience(job)),
    coverage("employment_type", jobs, (job) => job.employment_type !== "unknown"),
    coverage("student_friendly", jobs, (job) => job.student_friendly !== "unknown"),
    coverage("published_at", jobs, (job) => job.published_at !== null),
  ];

  const jobsWithSkills = jobs.filter((job) => job.skills.length > 0).length;
  const skillCounts = new Map<string, number>();
  for (const job of jobs) {
    for (const skillId of job.skills) {
      skillCounts.set(skillId, (skillCounts.get(skillId) ?? 0) + 1);
    }
  }
  const topSkills = [...skillCounts.entries()]
    .map(([skill_id, job_count]) => ({ skill_id, job_count }))
    .sort(
      (left, right) =>
        right.job_count - left.job_count || left.skill_id.localeCompare(right.skill_id),
    )
    .slice(0, 10);

  const inputCount = Math.max(options.input_count ?? sampleSize, sampleSize);
  const duplicateCount =
    options.duplicate_count ?? Math.max(0, inputCount - sampleSize);
  const dedupe: DedupeSummaryV1 = {
    input_count: inputCount,
    unique_count: sampleSize,
    duplicate_count: duplicateCount,
  };

  const roleFamily = fieldCoverage.find((item) => item.field === "role_family");
  const studentFriendly = fieldCoverage.find((item) => item.field === "student_friendly");
  const limitations = [
    "样本仅反映已接入来源与观测窗口，不代表整体招聘市场。",
    "未写经验的职位不视为经验不限；观察窗新增不等于市场净增。",
    "政策—岗位共同方向只表示文本证据重合，不表示政策与招聘需求之间存在因果关系。",
  ];

  if (sampleSize < 20) {
    limitations.push(`当前样本量仅 ${sampleSize} 条，比例指标波动较大，不应外推。`);
  }
  if (roleFamily !== undefined && roleFamily.known_ratio !== null && roleFamily.known_ratio < 1) {
    limitations.push(
      `职族未归类 ${formatRatio(roleFamily.unknown, sampleSize)}；岗位结构需结合未归类比例解读。`,
    );
  }
  if (
    studentFriendly !== undefined &&
    studentFriendly.known_ratio !== null &&
    studentFriendly.known_ratio < 1
  ) {
    limitations.push(
      `学生友好状态未写明 ${formatRatio(studentFriendly.unknown, sampleSize)}；unknown 不表示不友好。`,
    );
  }
  if (sampleSize > 0 && jobsWithSkills < sampleSize) {
    limitations.push(
      `未识别技能的职位 ${formatRatio(sampleSize - jobsWithSkills, sampleSize)}；技能占比只统计已识别部分。`,
    );
  }
  if (duplicateCount > 0) {
    limitations.push(
      `本次输入含 ${duplicateCount} 条重复记录，指标按去重后的 ${dedupe.unique_count} 条计算。`,
    );
  }

  return {
    sample_size: sampleSize,
    company_count: new Set(jobs.map((job) => job.company_name)).size,
    source_count: new Set(jobs.map((job) => job.source_key)).size,
    as_of: options.as_of,
    field_coverage: fieldCoverage,
    skill_coverage: {
      jobs_with_skills: jobsWithSkills,
      jobs_without_skills: sampleSize - jobsWithSkills,
      recognized_skill_ratio: sampleSize === 0 ? null : jobsWithSkills / sampleSize,
      distinct_skills: skillCounts.size,
      top_skills: topSkills,
    },
    dedupe,
    limitations,
  };
}

function coverage(
  field: string,
  jobs: readonly QualityJobInputV1[],
  isKnown: (job: QualityJobInputV1) => boolean,
): FieldCoverageV1 {
  const known = jobs.filter(isKnown).length;
  const total = jobs.length;
  return {
    field,
    known,
    unknown: total - known,
    total,
    known_ratio: total === 0 ? null : known / total,
  };
}

function hasExperience(job: QualityJobInputV1): boolean {
  return (
    job.experience_min_years !== null ||
    job.experience_max_years !== null ||
    job.experience_raw !== null
  );
}

function formatRatio(count: number, total: number): string {
  if (total === 0) return "0%";
  return `${Math.round((count / total) * 1000) / 10}%`;
}