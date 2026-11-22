import { sql, type Db } from "@aihot/backend/db";
import { BEIJING_TIMEZONE } from "@aihot/contracts/time";
import type {
  CareerDailyResponseV1,
  CareerDailySourceV1,
  CareerHotEntryV1,
  CareerHotResponseV1,
  CareerHotRoleFamilyCountV1,
} from "../contracts/insights.ts";
import type { RoleFamily } from "../contracts/job.ts";
import { CAREER_SOURCE_DEFINITIONS } from "../collector/sources.ts";
import { InvalidParameterError } from "./errors.ts";
import { careerPolicyRelevanceSql } from "./policy-relevance.ts";
import { resolveDataOrigin } from "./provenance.ts";

export const DEFAULT_HOT_LIMIT = 10;
export const MAX_HOT_LIMIT = 50;
export const DEFAULT_HOT_WINDOW_DAYS = 30;
export const MAX_HOT_WINDOW_DAYS = 365;

const ROLE_FAMILY_TOP = 3;
const EPOCH_ISO = "1970-01-01T00:00:00.000Z";

export interface HotCompanyOptions {
  limit: number;
  window_days: number;
}

interface HotCompanyRow {
  company: string;
  representative_source_key: string | null;
  job_count: number;
  latest_published_at: string | null;
}

interface HotFamilyRow {
  company_name: string;
  role_family: RoleFamily;
  count: number;
}

interface WindowTotalsRow {
  as_of: Date | null;
  live_count: number;
  import_count: number;
  synthetic_count: number;
}

interface DailyJobRow {
  date: string;
  sample_size: number;
  new_jobs_today: number;
  unknown_skill_count: number;
  live_count: number;
  import_count: number;
  synthetic_count: number;
  as_of: Date | null;
}

interface DailyPolicyRow {
  policies_total: number;
  new_policies_today: number;
}

interface DailyRunRow {
  source_key: string;
  collected: number;
  accepted: number;
  updated: number;
  duplicates: number;
  any_failed: boolean;
  any_partial: boolean;
}

function isoOrEpoch(value: Date | null | undefined): string {
  return value === null || value === undefined ? EPOCH_ISO : new Date(value).toISOString();
}

function publishedAtOrNull(value: string | null): string | null {
  return value === null || value === "" ? null : value;
}

/** 外链只取代表来源注册表里的 entry_url：政策来源、停用来源与未登记来源都不产出链接。 */
function careerUrlForSourceKey(sourceKey: string | null): string | null {
  const definition =
    sourceKey === null ? undefined : CAREER_SOURCE_DEFINITIONS.find((source) => source.source_key === sourceKey);
  return definition !== undefined && definition.kind === "company_careers" && definition.enabled
    ? definition.entry_url
    : null;
}

function runStatus(row: DailyRunRow): CareerDailySourceV1["status"] {
  if (row.any_failed) return "failed";
  if (row.any_partial) return "partial";
  return "ok";
}

/**
 * 最近 windowDays 天内有观测的职位。观测行是「仍在招聘」的证据，
 * 只有当前态而没有近期观测的职位不进入热度榜。
 */
function observationWindow(windowDays: number) {
  return sql`EXISTS (
    SELECT 1 FROM career_job_observations observation
    WHERE observation.job_id = job.id
      AND observation.observed_at >= now() - make_interval(days => ${windowDays}::int)
  )`;
}

export async function loadCareerHot(db: Db, options: HotCompanyOptions): Promise<CareerHotResponseV1> {
  if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > MAX_HOT_LIMIT) {
    throw new InvalidParameterError(`Query parameter must be between 1 and ${MAX_HOT_LIMIT}: limit.`, {
      parameter: "limit",
    });
  }
  if (!Number.isSafeInteger(options.window_days) || options.window_days < 1 || options.window_days > MAX_HOT_WINDOW_DAYS) {
    throw new InvalidParameterError(
      `Query parameter must be between 1 and ${MAX_HOT_WINDOW_DAYS}: window_days.`,
      { parameter: "window_days" },
    );
  }

  const [companies, families, totals] = await Promise.all([
    db<HotCompanyRow[]>`
      SELECT company_name AS company,
             mode() WITHIN GROUP (ORDER BY source_key) AS representative_source_key,
             COUNT(*)::int AS job_count,
             MAX(published_at) AS latest_published_at
      FROM career_jobs job
      WHERE ${observationWindow(options.window_days)}
      GROUP BY company_name
      ORDER BY job_count DESC, latest_published_at DESC NULLS LAST, company ASC
      LIMIT ${options.limit}::int`,
    db<HotFamilyRow[]>`
      SELECT company_name, role_family, count
      FROM (
        SELECT company_name, role_family, COUNT(*)::int AS count,
               ROW_NUMBER() OVER (PARTITION BY company_name ORDER BY COUNT(*) DESC, role_family ASC) AS position
        FROM career_jobs job
        WHERE role_family <> 'unknown' AND ${observationWindow(options.window_days)}
        GROUP BY company_name, role_family
      ) ranked
      WHERE position <= ${ROLE_FAMILY_TOP}::int
      ORDER BY company_name ASC, position ASC`,
    db<WindowTotalsRow[]>`
      SELECT MAX(last_seen_at) AS as_of,
             COUNT(*) FILTER (WHERE data_origin = 'live')::int AS live_count,
             COUNT(*) FILTER (WHERE data_origin = 'verified_import')::int AS import_count,
             COUNT(*) FILTER (WHERE data_origin = 'synthetic_fixture')::int AS synthetic_count
      FROM career_jobs job
      WHERE ${observationWindow(options.window_days)}`,
  ]);

  const roleFamilies = new Map<string, CareerHotRoleFamilyCountV1[]>();
  for (const row of families) {
    const list = roleFamilies.get(row.company_name) ?? [];
    list.push({ role_family: row.role_family, count: row.count });
    roleFamilies.set(row.company_name, list);
  }

  const entries: CareerHotEntryV1[] = companies.map((row) => ({
    company: row.company,
    career_url: careerUrlForSourceKey(row.representative_source_key),
    job_count: row.job_count,
    latest_published_at: publishedAtOrNull(row.latest_published_at),
    role_families: roleFamilies.get(row.company) ?? [],
  }));

  const total = totals[0];
  return {
    contract_version: "0.1",
    data_origin: resolveDataOrigin({
      live: total?.live_count ?? 0,
      verified_import: total?.import_count ?? 0,
      synthetic_fixture: total?.synthetic_count ?? 0,
    }),
    as_of: isoOrEpoch(total?.as_of),
    window_days: options.window_days,
    entries,
  };
}

export async function loadCareerDaily(db: Db): Promise<CareerDailyResponseV1> {
  const dayStart = sql`date_trunc('day', now() AT TIME ZONE ${BEIJING_TIMEZONE}) AT TIME ZONE ${BEIJING_TIMEZONE}`;

  const [jobs, policies, runs] = await Promise.all([
    db<DailyJobRow[]>`
      SELECT to_char(now() AT TIME ZONE ${BEIJING_TIMEZONE}, 'YYYY-MM-DD') AS date,
             COUNT(*)::int AS sample_size,
             COUNT(*) FILTER (WHERE first_seen_at >= ${dayStart})::int AS new_jobs_today,
             COUNT(*) FILTER (WHERE COALESCE(skills, '[]'::jsonb) = '[]'::jsonb)::int AS unknown_skill_count,
             COUNT(*) FILTER (WHERE data_origin = 'live')::int AS live_count,
             COUNT(*) FILTER (WHERE data_origin = 'verified_import')::int AS import_count,
             COUNT(*) FILTER (WHERE data_origin = 'synthetic_fixture')::int AS synthetic_count,
             MAX(last_seen_at) AS as_of
      FROM career_jobs`,
    db<DailyPolicyRow[]>`
      SELECT COUNT(*)::int AS policies_total,
             COUNT(*) FILTER (WHERE first_seen_at >= ${dayStart})::int AS new_policies_today
      FROM career_policies
      WHERE ${careerPolicyRelevanceSql()}`,
    db<DailyRunRow[]>`
      SELECT source_key,
             COALESCE(SUM(job_count), 0)::int AS collected,
             COALESCE(SUM(accepted), 0)::int AS accepted,
             COALESCE(SUM(updated), 0)::int AS updated,
             COALESCE(SUM(duplicates), 0)::int AS duplicates,
             BOOL_OR(status = 'failed') AS any_failed,
             BOOL_OR(status = 'partial') AS any_partial
      FROM career_ingest_runs
      WHERE (fetched_at AT TIME ZONE ${BEIJING_TIMEZONE})::date = (now() AT TIME ZONE ${BEIJING_TIMEZONE})::date
      GROUP BY source_key
      ORDER BY source_key ASC`,
  ]);

  const job = jobs[0];
  const policy = policies[0];
  if (job === undefined || policy === undefined) throw new Error("Career daily aggregates returned no row");

  return {
    contract_version: "0.1",
    data_origin: resolveDataOrigin({
      live: job.live_count,
      verified_import: job.import_count,
      synthetic_fixture: job.synthetic_count,
    }),
    date: job.date,
    sources: runs.map((row) => ({
      source_key: row.source_key,
      collected: row.collected,
      accepted: row.accepted,
      updated: row.updated,
      duplicates: row.duplicates,
      status: runStatus(row),
    })),
    has_run: runs.length > 0,
    jobs_total: job.sample_size,
    new_jobs_today: job.new_jobs_today,
    new_policies_today: policy.new_policies_today,
    policies_total: policy.policies_total,
    unknown_ratio: job.sample_size === 0 ? null : job.unknown_skill_count / job.sample_size,
    sample_size: job.sample_size,
    // 数据截止时间（最新一次岗位观测）而不是请求时间：同一份数据下保持稳定，ETag 才能命中 304。
    generated_at: isoOrEpoch(job.as_of),
  };
}