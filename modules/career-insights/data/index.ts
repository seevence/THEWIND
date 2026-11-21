export { validateNormalizedJobV1 } from "./validate.ts";
export type { ValidationIssueV1, ValidationResultV1 } from "./validate.ts";

export {
  METRIC_SPECS_V1,
  computeCareerMetrics,
  computeJobFamilyShareMetrics,
  computeObservedNewJobsMetric,
  computePolicyJobSharedThemesMetric,
  computeSharedThemes,
  computeSkillDemandShareMetrics,
  computeStudentFriendlyShareMetric,
} from "./metrics.ts";
export type {
  CareerMetricsInputV1,
  CareerMetricsResultV1,
  MetricComputeOptionsV1,
  MetricJobInputV1,
  ObservationSnapshotV1,
} from "./metrics.ts";

export {
  SKILL_ALIASES,
  SKILL_DICTIONARY_VERSION,
  SKILL_LABELS,
  THEME_DICTIONARY_VERSION,
  THEME_LABELS,
} from "./dictionaries.ts";

export {
  isCurrentNormalizerVersion,
  LLM_NORMALIZER_VERSION_PREFIX,
  NORMALIZER_VERSION,
  normalizeRawJob,
  normalizeRawJobs,
  resolveDegree,
  resolveEmploymentType,
  resolveExperience,
  resolveLocations,
  resolveRoleFamily,
  resolveSkills,
  resolveStudentFriendly,
} from "./normalize.ts";
export type { ExperienceRequirementV1, NormalizeResultV1, SkillMatchV1 } from "./normalize.ts";

export {
  canonicalizeJobUrl,
  computeContentHash,
  computeJobKey,
  dedupeNormalizedJobs,
  groupNearDuplicateJobs,
  sha256Hex,
} from "./dedupe.ts";
export type {
  ContentHashInputV1,
  DedupeResultV1,
  NearDuplicateGroupV1,
} from "./dedupe.ts";
export { inspectMetricSample } from "./quality.ts";
export type {
  DedupeSummaryV1,
  FieldCoverageV1,
  QualityJobInputV1,
  SampleInspectionOptionsV1,
  SampleInspectionV1,
  SkillCoverageV1,
} from "./quality.ts";