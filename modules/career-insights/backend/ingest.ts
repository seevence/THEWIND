import { sql as postgresSql, type Db } from "@aihot/backend/db";
import { BEIJING_TIMEZONE } from "@aihot/contracts/time";
import type { JSONValue, Parameter } from "postgres";
import type { CareerObservationBatchV1, IngestResultV1 } from "../contracts/api.ts";
import type {
  DataOrigin,
  DegreeLevel,
  EmploymentType,
  NormalizedJobV1,
  StudentFriendly,
} from "../contracts/index.ts";
import type { CareerSourceDefinition } from "../collector/index.ts";
import { CAREER_SOURCE_DEFINITIONS } from "../collector/sources.ts";
import { sourceContentEquals, type ContentHashInputV1 } from "../data/dedupe.ts";
import { validateNormalizedJobV1, type ValidationIssueV1 } from "../data/validate.ts";
import { InvalidParameterError } from "./errors.ts";
import { inTransaction } from "./transaction.ts";

const MAX_BATCH_SIZE = 100;
const MAX_REPORTED_ISSUES = 3;
const EXCERPT_LIMIT = 500;

type JobOutcome = "accepted" | "updated" | "duplicates";

export interface IngestContext {
  data_origin?: DataOrigin;
  batch_id?: string | null;
}

const DEFAULT_ORIGIN: DataOrigin = "live";

/**
 * 批次形状守卫：空批次与超限都是确定性参数错误，必须在建 run 行与任何写入之前拒绝，
 * 否则会写空源或留下 status=failed 的 ghost run 行。
 */
export function assertIngestBatch(batch: CareerObservationBatchV1): void {
  if (batch.jobs.length === 0) {
    throw new InvalidParameterError("A batch must contain at least one job.", { parameter: "jobs" });
  }
  if (batch.jobs.length > MAX_BATCH_SIZE) {
    throw new InvalidParameterError(`A batch may contain at most ${MAX_BATCH_SIZE} jobs.`, { parameter: "jobs" });
  }
}

/**
 * 入库来源守卫：榜单 career_url 由 source_key 映射注册表，只有 kind=company_careers 且 enabled 的源
 * 才能提供企业招聘入口。政策源写入 career_jobs 会让企业上榜却无链接，来源统计也失真，因此按
 * 未登记 / 停用 / 非企业岗位源三种原因分别报错。批次级与 run 级共用此函数，避免判断漂移。
 */
export function assertCareerJobSourceKey(sourceKey: string): CareerSourceDefinition {
  const definition = CAREER_SOURCE_DEFINITIONS.find((source) => source.source_key === sourceKey);
  if (definition === undefined) {
    // 空键加引号：日志里能区分「传了空串」与「注册表真的没有这个键」。
    const shown = sourceKey === "" ? '""' : sourceKey;
    // 只差大小写就能命中时给出提示，否则会被误读成源未登记。
    const caseOnlyMatch = CAREER_SOURCE_DEFINITIONS.some(
      (source) => source.source_key.toLowerCase() === sourceKey.toLowerCase(),
    );
    const hint = caseOnlyMatch ? " (source keys are case-sensitive)" : "";
    throw new InvalidParameterError(`Unknown source: ${shown}${hint}`, { parameter: "source_key" });
  }
  if (!definition.enabled) {
    throw new InvalidParameterError(`Disabled source: ${sourceKey}`, { parameter: "source_key" });
  }
  if (definition.kind !== "company_careers") {
    throw new InvalidParameterError(
      `Non-company careers source: ${sourceKey} (kind=${definition.kind})`,
      { parameter: "source_key" },
    );
  }
  return definition;
}

function jobSourceIssue(jobSourceKey: string, batchSourceKey: string): string | null {
  try {
    assertCareerJobSourceKey(jobSourceKey);
  } catch (error) {
    return `source_key: ${error instanceof Error ? error.message : String(error)}`;
  }
  return jobSourceKey === batchSourceKey
    ? null
    : `source_key: job source ${jobSourceKey} does not match the batch source ${batchSourceKey}`;
}

function jsonColumn(value: unknown): Parameter | null {
  // sql.json marks the value as JSON: a pre-stringified value would make postgres.js encode the
  // string as a JSON scalar, storing a location or skill list as one string instead of an array.
  return value === undefined || value === null ? null : postgresSql.json(value as JSONValue);
}

function describeIssues(issues: readonly ValidationIssueV1[]): string {
  return issues
    .slice(0, MAX_REPORTED_ISSUES)
    .map((issue) => (issue.path === "" ? issue.message : `${issue.path}: ${issue.message}`))
    .join("; ");
}

interface ExistingJobRow {
  id: string;
  source_key: string;
  job_key: string;
  content_hash: string;
  normalizer_version: string;
  company_name: string;
  title: string;
  locations: string[];
  role_family: NormalizedJobV1["role_family"];
  degree: DegreeLevel;
  degree_raw: string | null;
  experience_min_years: number | null;
  experience_max_years: number | null;
  experience_raw: string | null;
  employment_type: EmploymentType;
  student_friendly: StudentFriendly;
  skills: string[];
  skill_evidence: Array<{ skill_id: string; evidence_text: string }>;
  raw_text: string;
}

type DerivedJobFields = Pick<
  NormalizedJobV1,
  | "role_family"
  | "degree"
  | "degree_raw"
  | "experience_min_years"
  | "experience_max_years"
  | "experience_raw"
  | "employment_type"
  | "student_friendly"
  | "skills"
  | "skill_evidence"
>;

function sourceContentOf(row: ExistingJobRow): ContentHashInputV1 {
  return {
    schema_version: "1.0",
    source_key: row.source_key,
    job_key: row.job_key,
    company_name: row.company_name,
    title: row.title,
    locations: row.locations ?? [],
    degree_raw: row.degree_raw,
    experience_raw: row.experience_raw,
    raw_text: row.raw_text,
  };
}

/** 派生分析字段的稳定签名；与源内容无关，用于判断是否需要只刷新派生字段。 */
function derivedSignature(fields: DerivedJobFields): string {
  return JSON.stringify({
    role_family: fields.role_family,
    degree: fields.degree,
    degree_raw: fields.degree_raw ?? null,
    experience_min_years: fields.experience_min_years ?? null,
    experience_max_years: fields.experience_max_years ?? null,
    experience_raw: fields.experience_raw ?? null,
    employment_type: fields.employment_type,
    student_friendly: fields.student_friendly,
    skills: [...new Set(fields.skills)].sort(),
    skill_evidence: fields.skill_evidence
      .map((item) => `${item.skill_id}\u0000${item.evidence_text}`)
      .sort(),
  });
}

async function writeJob(tx: Db, job: NormalizedJobV1, context: IngestContext): Promise<JobOutcome> {
  const dataOrigin = context.data_origin ?? DEFAULT_ORIGIN;
  const rows = await tx<ExistingJobRow[]>`
    SELECT id, source_key, job_key, content_hash, normalizer_version, company_name, title,
           locations, role_family, degree, degree_raw, experience_min_years, experience_max_years,
           experience_raw, employment_type, student_friendly, skills, skill_evidence, raw_text
    FROM career_jobs
    WHERE source_key = ${job.source_key} AND job_key = ${job.job_key}
    FOR UPDATE`;
  const existing = rows[0];

  if (existing === undefined) {
    const inserted = await tx<{ id: string }[]>`
      INSERT INTO career_jobs (
        source_key, job_key, company_name, title, official_url, role_family, degree,
        employment_type, student_friendly, collector_version, content_hash, raw_text,
        degree_raw, experience_raw, published_at, experience_min_years, experience_max_years,
        locations, skills, skill_evidence, raw_payload, data_origin, normalizer_version,
        fetched_at, first_seen_at, last_seen_at, created_at, updated_at
      ) VALUES (
        ${job.source_key}, ${job.job_key}, ${job.company_name}, ${job.title}, ${job.official_url},
        ${job.role_family}, ${job.degree}, ${job.employment_type}, ${job.student_friendly},
        ${job.collector_version}, ${job.content_hash}, ${job.raw_text},
        ${job.degree_raw}, ${job.experience_raw}, ${job.published_at},
        ${job.experience_min_years}, ${job.experience_max_years},
        ${jsonColumn(job.locations)}::jsonb, ${jsonColumn(job.skills)}::jsonb,
        ${jsonColumn(job.skill_evidence)}::jsonb, ${jsonColumn(job.raw_payload)}::jsonb,
        ${dataOrigin}, ${job.normalizer_version},
        ${job.fetched_at}::timestamptz, ${job.fetched_at}::timestamptz, ${job.fetched_at}::timestamptz,
        ${job.fetched_at}::timestamptz, ${job.fetched_at}::timestamptz
      )
      RETURNING id`;
    // 观测时间归一为 Asia/Shanghai 日粒度：每个 job 每个采集日恰好一个观测点（历史观测仍是精确时间）。
    await tx`
      INSERT INTO career_job_observations (job_id, observed_at, content_hash, collector_version, source_url, raw_excerpt, batch_id)
      VALUES (
        ${inserted[0]!.id},
        date_trunc('day', ${job.fetched_at}::timestamptz AT TIME ZONE ${BEIJING_TIMEZONE}) AT TIME ZONE ${BEIJING_TIMEZONE},
        ${job.content_hash}, ${job.collector_version},
        ${job.official_url}, ${job.raw_text.slice(0, EXCERPT_LIMIT)}, ${context.batch_id ?? null}
      )
      ON CONFLICT (job_id, observed_at, content_hash) DO NOTHING`;
    return "accepted";
  }

  // 源内容未变：新哈希相等，或旧版本哈希不可比但来源内容字段一致（0.1.0 → 0.2.0 重入库）。
  const sameSourceContent =
    existing.content_hash === job.content_hash || sourceContentEquals(sourceContentOf(existing), job);

  if (sameSourceContent) {
    const derivedUnchanged =
      existing.normalizer_version === job.normalizer_version &&
      derivedSignature(existing) === derivedSignature(job);

    if (derivedUnchanged) {
      await tx`
        UPDATE career_jobs
        SET last_seen_at = GREATEST(last_seen_at, ${job.fetched_at}::timestamptz), updated_at = now()
        WHERE id = ${existing.id}`;
    } else {
      await tx`
        UPDATE career_jobs SET
          role_family = ${job.role_family},
          degree = ${job.degree},
          degree_raw = ${job.degree_raw},
          experience_raw = ${job.experience_raw},
          experience_min_years = ${job.experience_min_years},
          experience_max_years = ${job.experience_max_years},
          employment_type = ${job.employment_type},
          student_friendly = ${job.student_friendly},
          skills = ${jsonColumn(job.skills)}::jsonb,
          skill_evidence = ${jsonColumn(job.skill_evidence)}::jsonb,
          normalizer_version = ${job.normalizer_version},
          content_hash = ${job.content_hash},
          last_seen_at = GREATEST(last_seen_at, ${job.fetched_at}::timestamptz),
          updated_at = now()
        WHERE id = ${existing.id}`;
    }
    // 内容没变的日子同样留下观测点：同一采集日已有该内容哈希的观测时按唯一约束跳过。
    await tx`
      INSERT INTO career_job_observations (job_id, observed_at, content_hash, collector_version, source_url, raw_excerpt, batch_id)
      VALUES (
        ${existing.id},
        date_trunc('day', ${job.fetched_at}::timestamptz AT TIME ZONE ${BEIJING_TIMEZONE}) AT TIME ZONE ${BEIJING_TIMEZONE},
        ${job.content_hash}, ${job.collector_version},
        ${job.official_url}, ${job.raw_text.slice(0, EXCERPT_LIMIT)}, ${context.batch_id ?? null}
      )
      ON CONFLICT (job_id, observed_at, content_hash) DO NOTHING`;
    return "duplicates";
  }

  await tx`
    UPDATE career_jobs SET
      company_name = ${job.company_name},
      title = ${job.title},
      official_url = ${job.official_url},
      role_family = ${job.role_family},
      degree = ${job.degree},
      employment_type = ${job.employment_type},
      student_friendly = ${job.student_friendly},
      collector_version = ${job.collector_version},
      content_hash = ${job.content_hash},
      raw_text = ${job.raw_text},
      degree_raw = ${job.degree_raw},
      experience_raw = ${job.experience_raw},
      published_at = ${job.published_at},
      experience_min_years = ${job.experience_min_years},
      experience_max_years = ${job.experience_max_years},
      locations = ${jsonColumn(job.locations)}::jsonb,
      skills = ${jsonColumn(job.skills)}::jsonb,
      skill_evidence = ${jsonColumn(job.skill_evidence)}::jsonb,
      raw_payload = ${jsonColumn(job.raw_payload)}::jsonb,
      data_origin = ${dataOrigin},
      normalizer_version = ${job.normalizer_version},
      fetched_at = ${job.fetched_at}::timestamptz,
      last_seen_at = GREATEST(last_seen_at, ${job.fetched_at}::timestamptz),
      updated_at = now()
    WHERE id = ${existing.id}`;

  await tx`
    INSERT INTO career_job_observations (job_id, observed_at, content_hash, collector_version, source_url, raw_excerpt, batch_id)
    VALUES (
      ${existing.id},
      date_trunc('day', ${job.fetched_at}::timestamptz AT TIME ZONE ${BEIJING_TIMEZONE}) AT TIME ZONE ${BEIJING_TIMEZONE},
      ${job.content_hash}, ${job.collector_version},
      ${job.official_url}, ${job.raw_text.slice(0, EXCERPT_LIMIT)}, ${context.batch_id ?? null}
    )
    ON CONFLICT (job_id, observed_at, content_hash) DO NOTHING`;

  return "updated";
}

export async function ingestBatch(
  db: Db,
  batch: CareerObservationBatchV1,
  context: IngestContext = {},
): Promise<IngestResultV1> {
  assertIngestBatch(batch);

  // 整批拒绝发生在任何写入之前：未登记、停用或非企业岗位源的批次都不许进入 career_jobs。
  // 首尾空白先 trim 再查表，避免带空格的键绕过注册表守卫。
  const sourceKey = batch.source_key.trim();
  assertCareerJobSourceKey(sourceKey);

  const valid: NormalizedJobV1[] = [];
  const errors: IngestResultV1["errors"] = [];
  let rejected = 0;

  batch.jobs.forEach((candidate, index) => {
    // 逐条闭合：job 自带的 source_key 也必须满足同样的 kind/enabled 条件，且与批次来源一致，
    // 否则整条不计入（第三方不能借已登记的批次键夹带政策源或未登记来源）。逐条键同样 trim 后比对，
    // 通过时以 trim 后的值落库，避免同一源在表里出现带空白的脏键。
    const jobSourceKey = typeof candidate.source_key === "string" ? candidate.source_key.trim() : undefined;
    if (jobSourceKey !== undefined) {
      const sourceIssue = jobSourceIssue(jobSourceKey, sourceKey);
      if (sourceIssue !== null) {
        rejected += 1;
        errors.push({ index, code: "validation_failed", message: sourceIssue });
        return;
      }
    }
    const result = validateNormalizedJobV1(candidate);
    if (result.ok) {
      valid.push(jobSourceKey === undefined ? result.value : { ...result.value, source_key: jobSourceKey });
      return;
    }
    rejected += 1;
    errors.push({ index, code: "validation_failed", message: describeIssues(result.errors) });
  });

  if (valid.length === 0) {
    return { accepted: 0, updated: 0, duplicates: 0, rejected, errors };
  }

  return inTransaction(db, async (tx) => {
    const counts = { accepted: 0, updated: 0, duplicates: 0 };
    for (const job of valid) {
      const outcome = await writeJob(tx, job, context);
      counts[outcome] += 1;
    }
    return { ...counts, rejected, errors };
  });
}