
import type {
  DataOrigin,
  DegreeLevel,
  EmploymentType,
  MetricSpecV1,
  PolicyEvidenceRefV1,
  RoleFamily,
  StudentFriendly,
} from "../contracts/index.ts";
import type { EvidenceLinkV1, MetricResultV1, SharedThemeV1 } from "../contracts/api.ts";
import {
  EXPERIENCE_UNLIMITED_PHRASES,
  JOB_THEME_SKILLS,
  JOB_THEME_TITLE_KEYWORDS,
  ROLE_FAMILY_THEMES,
  SKILL_ALIASES,
  SKILL_DICTIONARY_VERSION,
  THEME_DICTIONARY_VERSION,
  THEME_LABELS,
} from "./dictionaries.ts";


export const METRIC_SPECS_V1: readonly MetricSpecV1[] = [
  {
    metric_id: "job_family_share",
    version: "1.0",
    label: "职族职位占比",
    definition: "统计窗口内指定职族的去重职位数占全部去重职位数的比例。",
    unit: "ratio",
    numerator: "dimension.role_family 对应职族的去重职位数。",
    denominator: "同一统计窗口内全部去重职位数；unknown 保留在样本中并单独披露。",
    window: "由调用方指定起止时间，使用观测覆盖范围内的去重职位当前态。",
    dedupe: "按 source_key 与 job_key 联合去重，同一职位不重复计数。",
    null_policy: "分母为 0 时 status=insufficient_data、value=null；unknown 不推断为已知职族。",
    evidence_type: "job",
    disclaimer: "样本仅反映已接入来源与观测窗口，不代表整体招聘市场。",
  },
  {
    metric_id: "skill_demand_share",
    version: "1.0",
    label: "技能需求占比",
    definition: "统计窗口内具有指定技能及对应证据的去重职位数占全部去重职位数的比例。",
    unit: "ratio",
    numerator: "skills 含 dimension.skill_id 且 skill_evidence 存在同名 ID 的去重职位数。",
    denominator: "同一统计窗口内全部去重职位数。",
    window: "由调用方指定起止时间，使用观测覆盖范围内的去重职位当前态。",
    dedupe: "按 source_key 与 job_key 联合去重；每职位对同一技能最多计入一次。",
    null_policy: "分母为 0 或词典证据不足时 status=insufficient_data、value=null；未知技能不得补为已知技能。",
    evidence_type: "job",
    disclaimer: "技能占比依赖职位文本与 0.1 版词典覆盖率，不代表技能市场的完整需求。",
  },
  {
    metric_id: "student_friendly_share",
    version: "1.0",
    label: "学生友好职位占比",
    definition: "统计窗口内明确标记 student_friendly=yes 的去重职位数占全部去重职位数的比例。",
    unit: "ratio",
    numerator: "student_friendly=yes 的去重职位数。",
    denominator: "同一统计窗口内全部去重职位数；unknown 计入样本并单独披露。",
    window: "由调用方指定起止时间，使用观测覆盖范围内的去重职位当前态。",
    dedupe: "按 source_key 与 job_key 联合去重，同一职位不重复计数。",
    null_policy: "分母为 0 时 status=insufficient_data、value=null；unknown 不转换为 yes 或 no。",
    evidence_type: "job",
    disclaimer: "学生友好标签仅依据官方字段或明确文本证据，unknown 不表示不友好。",
  },
  {
    metric_id: "observed_new_jobs",
    version: "1.0",
    label: "观测新增职位数",
    definition: "后一观测快照首次出现、且未出现在前一观测快照的去重职位数量。",
    unit: "count",
    numerator: "在两个不同观测快照之间首次观测到的 source_key/job_key 数量。",
    denominator: null,
    window: "至少包含两个不同 fetched_at 的观测快照，并明确比较的起止时点。",
    dedupe: "按 source_key 与 job_key 联合去重；精确重试不生成新增观测。",
    null_policy: "少于两个观测快照或证据不足时 status=insufficient_data、value=null，不得返回 0 或趋势判断。",
    evidence_type: "observation",
    disclaimer: "观测新增不等于市场真实新增；未观测到也不等于职位下架。",
  },
  {
    metric_id: "policy_job_shared_themes",
    version: "1.0",
    label: "政策与职位共享主题",
    definition: "依据 0.1 版主题词典识别政策证据与职位证据共同覆盖的主题，结果由 shared_themes 列表承载。",
    unit: "theme_list",
    numerator: "同时具有政策与职位证据的 theme_id 列表及对应证据计数。",
    denominator: null,
    window: "由调用方指定政策与职位证据的共同统计窗口。",
    dedupe: "政策按 policy_item_id 去重，职位按 source_key 与 job_key 联合去重，主题按 theme_id 去重。",
    null_policy: "任一证据侧缺失或证据不足时 status=insufficient_data、value=null；主题列表不编码为数值。",
    evidence_type: "mixed",
    disclaimer: "共享主题仅表示文本证据重合，不表示政策与招聘需求之间存在因果关系。",
  },
];

export interface MetricJobInputV1 {
  id: string;
  source_key: string;
  job_key: string;
  company_name: string;
  title: string;
  role_family: RoleFamily;
  locations: string[];
  degree: DegreeLevel;
  employment_type: EmploymentType;
  student_friendly: StudentFriendly;
  skills: string[];
  published_at: string | null;
  first_seen_at: string;
  last_seen_at: string;
  official_url: string;
}

export interface ObservationSnapshotV1 {
  observed_at: string;
  job_ids: readonly string[];
}

export interface MetricComputeOptionsV1 {
  as_of: string;
  /** 观察窗起点；未提供时使用倒数第二个观测快照时间。 */
  observed_window_start?: string;
}

export interface CareerMetricsInputV1 {
  jobs: readonly MetricJobInputV1[];
  snapshots: readonly ObservationSnapshotV1[];
  policies: readonly PolicyEvidenceRefV1[];
  options: MetricComputeOptionsV1;
}

export interface CareerMetricsResultV1 {
  metrics: MetricResultV1[];
  shared_themes: SharedThemeV1[];
}

const ROLE_FAMILIES: readonly RoleFamily[] = [
  "ai_algorithm",
  "ai_application_development",
  "data",
  "ai_product_operations",
  "unknown",
];

/** 职族占比：每个职族一个维度；分母为 0 时全部返回 insufficient_data。 */
export function computeJobFamilyShareMetrics(
  jobs: readonly MetricJobInputV1[],
  options: MetricComputeOptionsV1,
): MetricResultV1[] {
  const spec = specOf("job_family_share");
  const sampleSize = jobs.length;
  const unknownCount = jobs.filter((job) => job.role_family === "unknown").length;
  const unknownRatio = sampleSize === 0 ? null : unknownCount / sampleSize;

  return ROLE_FAMILIES.map((roleFamily) => {
    const matched = jobs.filter((job) => job.role_family === roleFamily);
    return makeMetricResult({
      spec,
      status: sampleSize === 0 ? "insufficient_data" : "ok",
      value: sampleSize === 0 ? null : matched.length / sampleSize,
      numeratorCount: matched.length,
      denominatorCount: sampleSize,
      sampleSize,
      asOf: options.as_of,
      dimension: { role_family: roleFamily },
      unknownCount,
      unknownRatio,
      evidence: matched.map(toJobEvidence),
    });
  });
}

/**
 * 技能需求占比：每个识别到的技能一个维度。
 * 一个职位可贡献多个技能，因此各技能占比之和可以超过 100%。
 */
export function computeSkillDemandShareMetrics(
  jobs: readonly MetricJobInputV1[],
  options: MetricComputeOptionsV1,
): MetricResultV1[] {
  const spec = specOf("skill_demand_share");
  const sampleSize = jobs.length;
  const unknownCount = jobs.filter((job) => job.skills.length === 0).length;
  const unknownRatio = sampleSize === 0 ? null : unknownCount / sampleSize;
  const skillIds = [...new Set(jobs.flatMap((job) => job.skills))].sort();

  if (skillIds.length === 0) {
    return [
      makeMetricResult({
        spec,
        status: "insufficient_data",
        value: null,
        numeratorCount: 0,
        denominatorCount: sampleSize,
        sampleSize,
        asOf: options.as_of,
        dimension: {},
        unknownCount,
        unknownRatio,
        dictionaryVersion: SKILL_DICTIONARY_VERSION,
        evidence: [],
      }),
    ];
  }

  return skillIds.map((skillId) => {
    const matched = jobs.filter(
      (job) => job.skills.includes(skillId),
    );
    return makeMetricResult({
      spec,
      status: sampleSize === 0 ? "insufficient_data" : "ok",
      value: sampleSize === 0 ? null : matched.length / sampleSize,
      numeratorCount: matched.length,
      denominatorCount: sampleSize,
      sampleSize,
      asOf: options.as_of,
      dimension: { skill_id: skillId },
      unknownCount,
      unknownRatio,
      dictionaryVersion: SKILL_DICTIONARY_VERSION,
      evidence: matched.map(toJobEvidence),
    });
  });
}

/** 学生友好占比：unknown 计入分母并单独返回未知数量与比例。 */
export function computeStudentFriendlyShareMetric(
  jobs: readonly MetricJobInputV1[],
  options: MetricComputeOptionsV1,
): MetricResultV1 {
  const spec = specOf("student_friendly_share");
  const sampleSize = jobs.length;
  const friendly = jobs.filter((job) => job.student_friendly === "yes");
  const unknownCount = jobs.filter((job) => job.student_friendly === "unknown").length;

  return makeMetricResult({
    spec,
    status: sampleSize === 0 ? "insufficient_data" : "ok",
    value: sampleSize === 0 ? null : friendly.length / sampleSize,
    numeratorCount: friendly.length,
    denominatorCount: sampleSize,
    sampleSize,
    asOf: options.as_of,
    dimension: {},
    unknownCount,
    unknownRatio: sampleSize === 0 ? null : unknownCount / sampleSize,
    evidence: friendly.map(toJobEvidence),
  });
}

/**
 * 观测新增职位：少于两个可区分观测快照时返回 insufficient_data，
 * 不返回 0 或趋势判断。观察窗内新增仅代表平台首次发现。
 */
export function computeObservedNewJobsMetric(
  jobs: readonly MetricJobInputV1[],
  snapshots: readonly ObservationSnapshotV1[],
  options: MetricComputeOptionsV1,
): MetricResultV1 {
  const spec = specOf("observed_new_jobs");
  const sampleSize = jobs.length;
  const distinctTimes = [...new Set(snapshots.map((snapshot) => snapshot.observed_at))].sort();

  if (distinctTimes.length < 2) {
    return makeMetricResult({
      spec,
      status: "insufficient_data",
      value: null,
      numeratorCount: 0,
      denominatorCount: null,
      sampleSize,
      asOf: options.as_of,
      dimension: {},
      evidence: [],
    });
  }

  const sortedSnapshots = [...snapshots].sort(
    (left, right) => Date.parse(left.observed_at) - Date.parse(right.observed_at),
  );
  const previousSnapshot = sortedSnapshots[sortedSnapshots.length - 2];
  const latestSnapshot = sortedSnapshots[sortedSnapshots.length - 1];

  if (previousSnapshot === undefined || latestSnapshot === undefined) {
    return makeMetricResult({
      spec,
      status: "insufficient_data",
      value: null,
      numeratorCount: 0,
      denominatorCount: null,
      sampleSize,
      asOf: options.as_of,
      dimension: {},
      evidence: [],
    });
  }

  // 必须比较前后两个快照的 job_id 差集；只看 first_seen_at 会把旧职位误判为新增。
  const previousIds = new Set(previousSnapshot.job_ids);
  const newIds = new Set(
    [...latestSnapshot.job_ids].filter((jobId) => !previousIds.has(jobId)),
  );
  const windowStartMs =
    options.observed_window_start === undefined
      ? Number.NaN
      : Date.parse(options.observed_window_start);

  const matched = jobs.filter((job) => {
    if (!newIds.has(job.id)) return false;
    if (!Number.isNaN(windowStartMs)) {
      const firstSeenMs = Date.parse(job.first_seen_at);
      if (Number.isNaN(firstSeenMs) || firstSeenMs < windowStartMs) return false;
    }
    return true;
  });

  return makeMetricResult({
    spec,
    status: "ok",
    value: matched.length,
    numeratorCount: matched.length,
    denominatorCount: null,
    sampleSize,
    asOf: options.as_of,
    dimension: {},
    evidence: matched.map(toJobEvidence),
  });
}

/**
 * 政策—岗位共同方向：只返回双方同时具备证据的主题。
 * 不计算综合分，不推断因果。
 */
export function computeSharedThemes(
  policies: readonly PolicyEvidenceRefV1[],
  jobs: readonly MetricJobInputV1[],
): SharedThemeV1[] {
  const policiesByTheme = new Map<string, PolicyEvidenceRefV1[]>();
  for (const policy of policies) {
    for (const themeId of policy.theme_ids) {
      const refs = policiesByTheme.get(themeId);
      if (refs === undefined) policiesByTheme.set(themeId, [policy]);
      else refs.push(policy);
    }
  }

  const jobsByTheme = new Map<string, MetricJobInputV1[]>();
  for (const job of jobs) {
    for (const themeId of themesForJob(job)) {
      const refs = jobsByTheme.get(themeId);
      if (refs === undefined) jobsByTheme.set(themeId, [job]);
      else refs.push(job);
    }
  }

  const shared: SharedThemeV1[] = [];
  for (const [themeId, policyRefs] of policiesByTheme) {
    const jobRefs = jobsByTheme.get(themeId);
    if (jobRefs === undefined || jobRefs.length === 0) continue;
    shared.push({
      theme_id: themeId,
      label: THEME_LABELS[themeId] ?? themeId,
      policy_count: policyRefs.length,
      job_count: jobRefs.length,
      policies: policyRefs,
      jobs: jobRefs.map(toJobEvidence),
    });
  }

  return shared.sort(
    (left, right) =>
      right.job_count - left.job_count || left.theme_id.localeCompare(right.theme_id),
  );
}

/** 共享主题指标只承载列表状态，theme_list 不编码为数值。 */
export function computePolicyJobSharedThemesMetric(
  policies: readonly PolicyEvidenceRefV1[],
  jobs: readonly MetricJobInputV1[],
  sharedThemes: readonly SharedThemeV1[],
  options: MetricComputeOptionsV1,
): MetricResultV1 {
  const spec = specOf("policy_job_shared_themes");
  const hasEvidence = policies.length > 0 && jobs.length > 0 && sharedThemes.length > 0;

  const policyEvidence: EvidenceLinkV1[] = sharedThemes.flatMap((theme) =>
    theme.policies.map((policy) => ({
      kind: "policy" as const,
      id: policy.policy_item_id,
      title: policy.title,
      official_url: policy.official_url,
    })),
  );
  const jobEvidence: EvidenceLinkV1[] = sharedThemes.flatMap((theme) => theme.jobs);

  return makeMetricResult({
    spec,
    status: hasEvidence ? "ok" : "insufficient_data",
    value: null,
    numeratorCount: sharedThemes.length,
    denominatorCount: null,
    sampleSize: jobs.length,
    asOf: options.as_of,
    dimension: {},
    dictionaryVersion: THEME_DICTIONARY_VERSION,
    evidence: [...policyEvidence, ...jobEvidence],
  });
}

/** 汇总顺序固定为五项指标，供 repository.summary() 直接使用。 */
export function computeCareerMetrics(input: CareerMetricsInputV1): CareerMetricsResultV1 {
  const { jobs, snapshots, policies, options } = input;
  const sharedThemes = computeSharedThemes(policies, jobs);
  return {
    metrics: [
      ...computeJobFamilyShareMetrics(jobs, options),
      ...computeSkillDemandShareMetrics(jobs, options),
      computeStudentFriendlyShareMetric(jobs, options),
      computeObservedNewJobsMetric(jobs, snapshots, options),
      computePolicyJobSharedThemesMetric(policies, jobs, sharedThemes, options),
    ],
    shared_themes: sharedThemes,
  };
}

export function themesForJob(job: MetricJobInputV1): string[] {
  const themes = new Set<string>();
  const skills = new Set(job.skills);
  for (const [themeId, requiredSkills] of Object.entries(JOB_THEME_SKILLS)) {
    if (requiredSkills.some((skill) => skills.has(skill))) themes.add(themeId);
  }
  for (const themeId of ROLE_FAMILY_THEMES[job.role_family] ?? []) themes.add(themeId);
  for (const [themeId, keywords] of Object.entries(JOB_THEME_TITLE_KEYWORDS)) {
    if (keywords.some((keyword) => job.title.includes(keyword))) themes.add(themeId);
  }
  return [...themes];
}

function toJobEvidence(job: MetricJobInputV1): EvidenceLinkV1 {
  return {
    kind: "job",
    id: job.id,
    title: `${job.company_name} · ${job.title}`,
    official_url: job.official_url,
  };
}

function specOf(metricId: MetricSpecV1["metric_id"]): MetricSpecV1 {
  const spec = METRIC_SPECS_V1.find((item) => item.metric_id === metricId);
  if (spec === undefined) throw new Error(`Unknown metric: ${metricId}`);
  return spec;
}

interface MetricResultInputV1 {
  spec: MetricSpecV1;
  status: MetricResultV1["status"];
  value: number | null;
  numeratorCount: number;
  denominatorCount: number | null;
  sampleSize: number;
  asOf: string;
  dimension: MetricResultV1["dimension"];
  unknownCount?: number;
  unknownRatio?: number | null;
  dictionaryVersion?: string;
  evidence: EvidenceLinkV1[];
}

function makeMetricResult(input: MetricResultInputV1): MetricResultV1 {
  return {
    metric_id: input.spec.metric_id,
    version: "1.0",
    label: input.spec.label,
    unit: input.spec.unit,
    status: input.status,
    value: input.value,
    numerator_count: input.numeratorCount,
    denominator_count: input.denominatorCount,
    sample_size: input.sampleSize,
    as_of: input.asOf,
    dimension: input.dimension,
    ...(input.unknownCount === undefined ? {} : { unknown_count: input.unknownCount }),
    ...(input.unknownRatio === undefined ? {} : { unknown_ratio: input.unknownRatio }),
    ...(input.dictionaryVersion === undefined
      ? {}
      : { dictionary_version: input.dictionaryVersion }),
    evidence: input.evidence,
    disclaimer: input.spec.disclaimer,
  };
}
/**
 * 诊断输入只依赖经验与技能字段，不要求完整 MetricJobInputV1。
 * data_origin 必填：缺省视为调用方漏传来源，不允许静默当作 live 计入；
 * 非 live 的行由诊断函数自身排除，fixture/策略排除仍由调用方负责。
 */
export interface DiagnosticJobInputV1 {
  source_key: string;
  job_key: string;
  experience_raw: string | null;
  experience_min_years: number | null;
  experience_max_years: number | null;
  skills: readonly string[];
  data_origin: DataOrigin;
}

export type ExperienceBucketV1 =
  | "missing"
  | "zero"
  | "zero_to_one"
  | "two_to_three"
  | "four_to_five"
  | "six_to_nine"
  | "ten_plus"
  | "unlimited"
  | "unparsed";

export const EXPERIENCE_BUCKETS_V1: readonly ExperienceBucketV1[] = [
  "missing",
  "zero",
  "zero_to_one",
  "two_to_three",
  "four_to_five",
  "six_to_nine",
  "ten_plus",
  "unlimited",
  "unparsed",
];

export interface ExperienceBucketCountV1 {
  count: number;
  share: number | null;
}

export interface ExperienceDistributionV1 {
  sample_size: number;
  input_count: number;
  excluded_count: number;
  duplicate_count: number;
  buckets: Record<ExperienceBucketV1, ExperienceBucketCountV1>;
}

export interface EntryLevelShareV1 {
  numerator_count: number;
  denominator_count: number;
  value: number | null;
  status: MetricResultV1["status"];
  /** 分子实际包含的桶；missing/zero/zero_to_one 才是「经验缺失或 0–1 年」。 */
  numerator_buckets: readonly ExperienceBucketV1[];
  excluded_count: number;
  duplicate_count: number;
}

export interface SkillHitRateV1 {
  sample_size: number;
  input_count: number;
  excluded_count: number;
  duplicate_count: number;
  with_skill_count: number;
  value: number | null;
  status: MetricResultV1["status"];
  unknown_count: number;
  unknown_ratio: number | null;
  dictionary_version: string;
}

const KNOWN_SKILL_IDS: ReadonlySet<string> = new Set(Object.values(SKILL_ALIASES));


/**
 * 经验分布：九桶计数与占比，计数和占比合计等于去重后的 live 样本量。
 * 经验为空是 missing；写了文本但解析不出数字是 unparsed；两者都不回填 0。
 */
export function computeExperienceDistribution(
  jobs: readonly DiagnosticJobInputV1[],
): ExperienceDistributionV1 {
  const sample = liveDedupedSample(jobs);
  const counts = new Map<ExperienceBucketV1, number>(
    EXPERIENCE_BUCKETS_V1.map((bucket) => [bucket, 0]),
  );
  for (const job of sample.jobs) {
    const bucket = experienceBucketOf(job);
    counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
  }

  const buckets = {} as Record<ExperienceBucketV1, ExperienceBucketCountV1>;
  for (const bucket of EXPERIENCE_BUCKETS_V1) {
    const count = counts.get(bucket) ?? 0;
    buckets[bucket] = {
      count,
      share: sample.jobs.length === 0 ? null : count / sample.jobs.length,
    };
  }

  return {
    sample_size: sample.jobs.length,
    input_count: sample.input_count,
    excluded_count: sample.excluded_count,
    duplicate_count: sample.duplicate_count,
    buckets,
  };
}

/** 入门占比：经验缺失 + 0 年 + 0–1 年；「不限」单列，不并入分子。 */
export function computeEntryLevelShare(
  jobs: readonly DiagnosticJobInputV1[],
): EntryLevelShareV1 {
  const distribution = computeExperienceDistribution(jobs);
  const numeratorBuckets: readonly ExperienceBucketV1[] = ["missing", "zero", "zero_to_one"];
  const numeratorCount = numeratorBuckets.reduce(
    (sum, bucket) => sum + distribution.buckets[bucket].count,
    0,
  );
  const denominator = distribution.sample_size;

  return {
    numerator_count: numeratorCount,
    denominator_count: denominator,
    value: denominator === 0 ? null : numeratorCount / denominator,
    status: denominator === 0 ? "insufficient_data" : "ok",
    numerator_buckets: numeratorBuckets,
    excluded_count: distribution.excluded_count,
    duplicate_count: distribution.duplicate_count,
  };
}

/** 技能命中率：至少识别出一个技能的去重职位 / 去重职位；字典版本与未知比例一并返回。 */
export function computeSkillHitRate(
  jobs: readonly DiagnosticJobInputV1[],
): SkillHitRateV1 {
  const sample = liveDedupedSample(jobs);
  const sampleSize = sample.jobs.length;
  const withSkill = sample.jobs.filter((job) =>
    job.skills.some((skillId) => KNOWN_SKILL_IDS.has(skillId)),
  ).length;
  const unknownCount = sampleSize - withSkill;

  return {
    sample_size: sampleSize,
    input_count: sample.input_count,
    excluded_count: sample.excluded_count,
    duplicate_count: sample.duplicate_count,
    with_skill_count: withSkill,
    value: sampleSize === 0 ? null : withSkill / sampleSize,
    // 一个技能都没识别出来不等于指标成功，按证据不足处理。
    status: sampleSize === 0 || withSkill === 0 ? "insufficient_data" : "ok",
    unknown_count: unknownCount,
    unknown_ratio: sampleSize === 0 ? null : unknownCount / sampleSize,
    dictionary_version: SKILL_DICTIONARY_VERSION,
  };
}

interface DiagnosticSampleV1 {
  jobs: DiagnosticJobInputV1[];
  input_count: number;
  excluded_count: number;
  duplicate_count: number;
}

/** 排除非 live 行，并按 source_key + job_key 去重。 */
function liveDedupedSample(jobs: readonly DiagnosticJobInputV1[]): DiagnosticSampleV1 {
  const seen = new Set<string>();
  const kept: DiagnosticJobInputV1[] = [];
  let excludedCount = 0;
  let duplicateCount = 0;

  for (const job of jobs) {
    if (job.data_origin !== "live") {
      excludedCount += 1;
      continue;
    }
    const key = `${job.source_key}\u0000${job.job_key}`;
    if (seen.has(key)) {
      duplicateCount += 1;
      continue;
    }
    seen.add(key);
    kept.push(job);
  }

  return {
    jobs: kept,
    input_count: jobs.length,
    excluded_count: excludedCount,
    duplicate_count: duplicateCount,
  };
}

/**
 * 桶按“岗位要求的最高年限”划分：开放上界（max=null）取其下限。
 * 因此 `1-3年`（min=1,max=3）落 two_to_three，只有上限 ≤1 年（如 `0-1年`）才算 zero_to_one，
 * 避免把「要求 1–3 年」误算进入门分子。
 */
function experienceBucketOf(job: DiagnosticJobInputV1): ExperienceBucketV1 {
  const raw = (job.experience_raw ?? "").trim();
  const min = job.experience_min_years;
  const max = job.experience_max_years;

  if (min === null && max === null) {
    if (raw === "") return "missing";
    return isUnlimitedExperienceRaw(raw) ? "unlimited" : "unparsed";
  }

  const upper = max ?? min;
  if (upper === null) return "unparsed";
  if (upper === 0) return "zero";
  if (upper <= 1) return "zero_to_one";
  if (upper <= 3) return "two_to_three";
  if (upper <= 5) return "four_to_five";
  if (upper <= 9) return "six_to_nine";
  return "ten_plus";
}

function isUnlimitedExperienceRaw(raw: string): boolean {
  if (raw === "不限") return true;
  return EXPERIENCE_UNLIMITED_PHRASES.some((phrase) => raw.includes(phrase));
}