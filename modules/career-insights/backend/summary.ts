import type { Db } from "@aihot/backend/db";
import { BEIJING_TIMEZONE } from "@aihot/contracts/time";
import type {
  CareerWarningV1,
  EvidenceLinkV1,
  MetricResultV1,
  SummaryResponseV1,
} from "../contracts/api.ts";
import type { MetricSpecV1, RoleFamily } from "../contracts/job.ts";
import { SKILL_DICTIONARY_VERSION } from "../data/dictionaries.ts";
import { LLM_NORMALIZER_VERSION_PREFIX, NORMALIZER_VERSION } from "../data/index.ts";
import {
  computePolicyJobSharedThemesMetric,
  computeSharedThemes,
  METRIC_SPECS_V1,
} from "../data/metrics.ts";

import { listMetricJobs, listPolicyEvidence } from "./policy-repository.ts";
import { resolveDataOrigin } from "./provenance.ts";

const ROLE_FAMILY_ORDER: readonly RoleFamily[] = [
  "ai_algorithm",
  "ai_application_development",
  "data",
  "ai_product_operations",
  "unknown",
];
const EVIDENCE_LIMIT = 5;
const SKILL_METRIC_LIMIT = 10;
const EMPTY_TIMESTAMP = "1970-01-01T00:00:00.000Z";
// SQL 里无法调用 isCurrentNormalizerVersion（data/normalize.ts），这里用等价条件：
// 无版本信息（NULL）按旧数据；只有既不是 NORMALIZER_VERSION 也不带 LLM 前缀的才算旧版本。
const LLM_NORMALIZER_VERSION_LIKE = `${LLM_NORMALIZER_VERSION_PREFIX}%`;

interface SummaryCounts {
  sample_size: number;
  company_count: number;
  source_count: number;
  live_count: number;
  import_count: number;
  synthetic_count: number;
  first_observed_at: Date | null;
  last_observed_at: Date | null;
}

interface RoleFamilyCount {
  role_family: string;
  job_count: number;
}

interface SkillCount {
  skill_id: string;
  job_count: number;
}

interface StudentCounts {
  yes_count: number;
  unknown_count: number;
}

interface EvidenceRow {
  id: string;
  title: string;
  official_url: string;
}

function toIsoOrEpoch(value: Date | null): string {
  return value === null ? EMPTY_TIMESTAMP : new Date(value).toISOString();
}

function toEvidence(rows: readonly EvidenceRow[]): EvidenceLinkV1[] {
  return rows.map((row) => ({
    kind: "job",
    id: String(row.id),
    title: row.title,
    official_url: row.official_url,
  }));
}

function ratioValue(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

function metric(
  metricId: MetricSpecV1["metric_id"],
  fields: Omit<MetricResultV1, "metric_id" | "version" | "label" | "unit" | "disclaimer">,
): MetricResultV1 {
  const spec = METRIC_SPECS_V1.find((candidate) => candidate.metric_id === metricId);
  if (spec === undefined) throw new Error(`Missing metric spec: ${metricId}`);
  return {
    metric_id: metricId,
    version: spec.version,
    label: spec.label,
    unit: spec.unit,
    ...fields,
    disclaimer: spec.disclaimer,
  };
}

async function roleFamilyEvidence(db: Db, roleFamily: RoleFamily): Promise<EvidenceLinkV1[]> {
  const rows = await db<EvidenceRow[]>`
    SELECT id, title, official_url
    FROM career_jobs
    WHERE role_family = ${roleFamily}
    ORDER BY last_seen_at DESC, id ASC
    LIMIT ${EVIDENCE_LIMIT}`;
  return toEvidence(rows);
}

async function skillEvidence(db: Db, skillId: string): Promise<EvidenceLinkV1[]> {
  const rows = await db<EvidenceRow[]>`
    SELECT id, title, official_url
    FROM career_jobs
    WHERE skills @> to_jsonb(ARRAY[${skillId}::text])
    ORDER BY last_seen_at DESC, id ASC
    LIMIT ${EVIDENCE_LIMIT}`;
  return toEvidence(rows);
}

async function studentEvidence(db: Db): Promise<EvidenceLinkV1[]> {
  const rows = await db<EvidenceRow[]>`
    SELECT id, title, official_url
    FROM career_jobs
    WHERE student_friendly = 'yes'
    ORDER BY last_seen_at DESC, id ASC
    LIMIT ${EVIDENCE_LIMIT}`;
  return toEvidence(rows);
}

export async function buildSummary(db: Db): Promise<SummaryResponseV1> {
  const [counts, familyRows, skillRows, student, snapshots, unknownSkill, staleNormalizer] = await Promise.all([
    db<SummaryCounts[]>`
      SELECT COUNT(*)::int AS sample_size,
             COUNT(DISTINCT company_name)::int AS company_count,
             COUNT(DISTINCT source_key)::int AS source_count,
             COUNT(*) FILTER (WHERE data_origin = 'live')::int AS live_count,
             COUNT(*) FILTER (WHERE data_origin = 'verified_import')::int AS import_count,
             COUNT(*) FILTER (WHERE data_origin = 'synthetic_fixture')::int AS synthetic_count,
             MIN(first_seen_at) AS first_observed_at,
             MAX(last_seen_at) AS last_observed_at
      FROM career_jobs`,
    db<RoleFamilyCount[]>`
      SELECT role_family, COUNT(*)::int AS job_count
      FROM career_jobs
      GROUP BY role_family`,
    db<SkillCount[]>`
      SELECT skill.skill_id, COUNT(DISTINCT job.id)::int AS job_count
      FROM career_jobs job
      CROSS JOIN LATERAL jsonb_array_elements_text(job.skills) AS skill(skill_id)
      GROUP BY skill.skill_id
      ORDER BY job_count DESC, skill.skill_id ASC
      LIMIT ${SKILL_METRIC_LIMIT}`,
    db<StudentCounts[]>`
      SELECT COUNT(*) FILTER (WHERE student_friendly = 'yes')::int AS yes_count,
             COUNT(*) FILTER (WHERE student_friendly = 'unknown')::int AS unknown_count
      FROM career_jobs`,
    db<{ observed_at: Date }[]>`
      SELECT DISTINCT date_trunc('day', observed_at AT TIME ZONE ${BEIJING_TIMEZONE}) AT TIME ZONE ${BEIJING_TIMEZONE} AS observed_at
      FROM career_job_observations
      ORDER BY observed_at DESC
      LIMIT 2`,
    db<{ unknown_count: number }[]>`
      SELECT COUNT(*) FILTER (WHERE COALESCE(skills, '[]'::jsonb) = '[]'::jsonb)::int AS unknown_count
      FROM career_jobs`,
    db<{ stale_count: number }[]>`
      SELECT COUNT(*) FILTER (
        WHERE normalizer_version IS NULL
           OR (normalizer_version <> ${NORMALIZER_VERSION} AND normalizer_version NOT LIKE ${LLM_NORMALIZER_VERSION_LIKE})
      )::int AS stale_count
      FROM career_jobs`,
  ]);

  const count = counts[0];
  const students = student[0];
  if (count === undefined || students === undefined) throw new Error("Summary aggregates returned no row");

  const sampleSize = count.sample_size;
  const asOf = toIsoOrEpoch(count.last_observed_at);
  const hasMultipleSnapshots = snapshots.length >= 2;
  const staleNormalizerCount = staleNormalizer[0]?.stale_count ?? 0;
  const unknownSkillCount = unknownSkill[0]?.unknown_count ?? 0;
  const unknownSkillRatio = ratioValue(unknownSkillCount, sampleSize);
  const familyCounts = new Map<RoleFamily, number>(
    familyRows.map((row) => [row.role_family as RoleFamily, row.job_count]),
  );

  const jobFamilyMetrics: MetricResultV1[] =
    sampleSize === 0
      ? ROLE_FAMILY_ORDER.map((roleFamily) =>
          metric("job_family_share", {
            status: "insufficient_data",
            value: null,
            numerator_count: 0,
            denominator_count: 0,
            sample_size: 0,
            as_of: asOf,
            dimension: { role_family: roleFamily },
            ...(roleFamily === "unknown" ? { unknown_count: 0, unknown_ratio: null } : {}),
            evidence: [],
          }),
        )
      : (
          await Promise.all(
            ROLE_FAMILY_ORDER.flatMap((roleFamily) => {
              const numeratorCount = familyCounts.get(roleFamily) ?? 0;
              // unknown is a coverage bucket, not a role: always report it so a fully classified
              // sample is distinguishable from "we never looked".
              if (numeratorCount === 0 && roleFamily !== "unknown") return [];
              return [
                roleFamilyEvidence(db, roleFamily).then((evidence) =>
                  metric("job_family_share", {
                    status: "ok",
                    value: ratioValue(numeratorCount, sampleSize),
                    numerator_count: numeratorCount,
                    denominator_count: sampleSize,
                    sample_size: sampleSize,
                    as_of: asOf,
                    dimension: { role_family: roleFamily },
                    ...(roleFamily === "unknown"
                      ? { unknown_count: numeratorCount, unknown_ratio: ratioValue(numeratorCount, sampleSize) }
                      : {}),
                    evidence,
                  }),
                ),
              ];
            }),
          )
        ).flat();

  const skillMetrics: MetricResultV1[] =
    skillRows.length === 0
      ? [
          metric("skill_demand_share", {
            status: "insufficient_data",
            value: null,
            numerator_count: 0,
            denominator_count: sampleSize,
            sample_size: sampleSize,
            as_of: asOf,
            dimension: {},
            dictionary_version: SKILL_DICTIONARY_VERSION,
            unknown_count: unknownSkillCount,
            unknown_ratio: unknownSkillRatio,
            evidence: [],
          }),
        ]
      : await Promise.all(
          skillRows.map(async (row) => {
            const evidence = await skillEvidence(db, row.skill_id);
            return metric("skill_demand_share", {
              status: "ok",
              value: ratioValue(row.job_count, sampleSize),
              numerator_count: row.job_count,
              denominator_count: sampleSize,
              sample_size: sampleSize,
              as_of: asOf,
              dimension: { skill_id: row.skill_id },
              dictionary_version: SKILL_DICTIONARY_VERSION,
              unknown_count: unknownSkillCount,
              unknown_ratio: unknownSkillRatio,
              evidence,
            });
          }),
        );

  const studentFriendlyMetric = metric("student_friendly_share", {
    status: sampleSize === 0 ? "insufficient_data" : "ok",
    value: ratioValue(students.yes_count, sampleSize),
    numerator_count: students.yes_count,
    denominator_count: sampleSize,
    sample_size: sampleSize,
    as_of: asOf,
    dimension: {},
    unknown_count: students.unknown_count,
    unknown_ratio: ratioValue(students.unknown_count, sampleSize),
    evidence: students.yes_count === 0 ? [] : await studentEvidence(db),
  });

  const observedNewJobsMetric = hasMultipleSnapshots
    ? await newJobsMetric(db, snapshots[0].observed_at, sampleSize, asOf)
    : metric("observed_new_jobs", {
        status: "insufficient_data",
        value: null,
        numerator_count: 0,
        denominator_count: null,
        sample_size: sampleSize,
        as_of: asOf,
        dimension: {},
        evidence: [],
      });

  const [policies, metricJobs] = await Promise.all([listPolicyEvidence(db), listMetricJobs(db)]);
  const sharedThemes = computeSharedThemes(policies, metricJobs);
  const policyMetric = computePolicyJobSharedThemesMetric(policies, metricJobs, sharedThemes, { as_of: asOf });

  const warnings: CareerWarningV1[] = [];
  if (sampleSize === 0) {
    warnings.push({ code: "insufficient_data", message: "尚未采集到任何职位。" });
  }
  // 术语分工：职族维度用「未分类（unknown）」；技能维度保留「未识别」（指技能未命中词典），两者不混用。
  if (sampleSize > 0 && (familyCounts.get("unknown") ?? 0) > 0) {
    warnings.push({ code: "unknown_fields", message: "存在未分类的职位，已单列未分类（unknown）。" });
  }
  if (sampleSize > 0 && students.unknown_count > 0) {
    warnings.push({ code: "unknown_fields", message: "存在未标记应届友好度的职位，unknown 不表示不友好。" });
  }
  if (sampleSize > 0 && staleNormalizerCount > 0) {
    warnings.push({ code: "stale_data", message: "部分职位仍为旧归一化版本，重入库后刷新。" });
  }
  if (policies.length === 0) {
    warnings.push({ code: "insufficient_data", message: "尚未接入政策证据，共享主题暂不计算。" });
  } else if (sharedThemes.length === 0) {
    warnings.push({ code: "insufficient_data", message: "政策与职位暂未出现同一主题，不代表无共同方向。" });
  }

  const dataOrigin = resolveDataOrigin(
    {
      live: count.live_count,
      verified_import: count.import_count,
      synthetic_fixture: count.synthetic_count,
    },
    warnings,
  );

  return {
    contract_version: "0.1",
    data_origin: dataOrigin,
    as_of: asOf,
    sample_size: sampleSize,
    company_count: count.company_count,
    source_count: count.source_count,
    first_observed_at: toIsoOrEpoch(count.first_observed_at),
    last_observed_at: asOf,
    has_multiple_snapshots: hasMultipleSnapshots,
    metrics: [...jobFamilyMetrics, ...skillMetrics, studentFriendlyMetric, observedNewJobsMetric, policyMetric],
    shared_themes: sharedThemes,
    dictionary_version: SKILL_DICTIONARY_VERSION,
    warnings,
  };
}

/**
 * latestDay 是最新快照日的 Asia/Shanghai 零点，窗口取当日 24 小时：
 * 观测时间按日归一时，同日稍后首次出现的 job 仍算在这一天里。
 */
async function newJobsMetric(
  db: Db,
  latestDay: Date,
  sampleSize: number,
  asOf: string,
): Promise<MetricResultV1> {
  const [counts, evidence] = await Promise.all([
    db<{ new_jobs: number }[]>`
      SELECT COUNT(*)::int AS new_jobs
      FROM career_jobs
      WHERE first_seen_at >= ${latestDay} AND first_seen_at < ${latestDay} + interval '1 day'`,
    db<EvidenceRow[]>`
      SELECT id, title, official_url
      FROM career_jobs
      WHERE first_seen_at >= ${latestDay} AND first_seen_at < ${latestDay} + interval '1 day'
      ORDER BY last_seen_at DESC, id ASC
      LIMIT ${EVIDENCE_LIMIT}`,
  ]);
  const newJobs = counts[0]?.new_jobs ?? 0;
  return metric("observed_new_jobs", {
    status: "ok",
    value: newJobs,
    numerator_count: newJobs,
    denominator_count: null,
    sample_size: sampleSize,
    as_of: asOf,
    dimension: {},
    evidence: toEvidence(evidence),
  });
}