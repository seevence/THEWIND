import type { Db } from "@aihot/backend/db";
import type {
  CareerCatalogResponseV1,
  CareerDirectionV1,
  CareerSkillV1,
  CareerTitleV1,
} from "../contracts/insights.ts";
import type { DataOrigin, RoleFamily, StudentFriendly } from "../contracts/job.ts";
import { CITY_ALIASES, CITY_NAMES } from "../data/dictionaries.ts";
import { InvalidParameterError } from "./errors.ts";
import { resolveDataOrigin } from "./provenance.ts";

export const DEFAULT_CATALOG_LIMIT = 6;
export const MAX_CATALOG_LIMIT = 50;
export const DEFAULT_CATALOG_WINDOW_DAYS = 30;
export const MAX_CATALOG_WINDOW_DAYS = 365;

const TOP_SKILLS_PER_ITEM = 3;
const TOP_SKILLS = 10;
const TOP_CITIES = 3;
const DAY_MS = 24 * 60 * 60 * 1000;
const EPOCH_ISO = "1970-01-01T00:00:00.000Z";

const BRACKETED = /[（(][^）)]*[）)]|[【[]][^】\]]*[】\]]/g;
const CITY_SEPARATOR = /^[\s\-·:：|｜—–_.]+/;
const TITLE_CITY_PREFIXES: readonly string[] = [...new Set([...CITY_NAMES, ...Object.keys(CITY_ALIASES)])]
  .sort((left, right) => right.length - left.length);

export interface CareerCatalogOptions {
  limit: number;
  window_days: number;
}

interface CatalogJobRow {
  id: string;
  company_name: string;
  title: string;
  role_family: RoleFamily;
  locations: string[] | null;
  skills: string[] | null;
  student_friendly: StudentFriendly;
  published_at: string | null;
  first_seen_at: Date;
  last_seen_at: Date;
  data_origin: DataOrigin;
}

interface SkillCountV1 {
  skill: string;
  count: number;
}

/** 只认「城市名 + 分隔符」的前缀：「北京-算法工程师」去前缀，「数据结构工程师」不动。 */
function stripCityPrefix(text: string): string {
  for (const city of TITLE_CITY_PREFIXES) {
    if (!text.startsWith(city)) continue;
    const rest = text.slice(city.length);
    if (CITY_SEPARATOR.test(rest)) return rest.replace(CITY_SEPARATOR, "");
  }
  return text;
}

function titleKey(title: string): string {
  const key = stripCityPrefix(title.replace(BRACKETED, " ").trim())
    .replace(/\s+/g, "")
    .toLowerCase();
  return key === "" ? title.replace(/\s+/g, "").toLowerCase() : key;
}

function byDescendingCount(counts: Map<string, number>): Array<{ value: string; count: number }> {
  return [...counts]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([value, count]) => ({ value, count }));
}

function topSkills(jobs: readonly CatalogJobRow[], limit: number): SkillCountV1[] {
  const counts = new Map<string, number>();
  for (const job of jobs) {
    for (const skill of new Set(job.skills ?? [])) counts.set(skill, (counts.get(skill) ?? 0) + 1);
  }
  return byDescendingCount(counts)
    .slice(0, limit)
    .map(({ value, count }) => ({ skill: value, count }));
}

function companyCount(jobs: readonly CatalogJobRow[]): number {
  return new Set(jobs.map((job) => job.company_name)).size;
}

function directions(jobs: readonly CatalogJobRow[], windowStart: number, limit: number): CareerDirectionV1[] {
  const groups = new Map<RoleFamily, CatalogJobRow[]>();
  for (const job of jobs) {
    if (job.role_family === "unknown") continue;
    const list = groups.get(job.role_family) ?? [];
    list.push(job);
    groups.set(job.role_family, list);
  }

  return [...groups]
    .map(([role_family, familyJobs]) => ({
      role_family,
      job_count: familyJobs.length,
      company_count: companyCount(familyJobs),
      new_in_window: familyJobs.filter((job) => new Date(job.first_seen_at).getTime() >= windowStart).length,
      student_friendly_count: familyJobs.filter((job) => job.student_friendly === "yes").length,
      top_skills: topSkills(familyJobs, TOP_SKILLS_PER_ITEM),
    }))
    .sort((left, right) => right.job_count - left.job_count || left.role_family.localeCompare(right.role_family))
    .slice(0, limit);
}

function cities(jobs: readonly CatalogJobRow[]): string[] {
  const counts = new Map<string, number>();
  for (const job of jobs) {
    for (const city of new Set(job.locations ?? [])) counts.set(city, (counts.get(city) ?? 0) + 1);
  }
  return byDescendingCount(counts)
    .slice(0, TOP_CITIES)
    .map(({ value }) => value);
}

function displayTitle(jobs: readonly CatalogJobRow[]): string {
  const counts = new Map<string, number>();
  for (const job of jobs) counts.set(job.title, (counts.get(job.title) ?? 0) + 1);
  return byDescendingCount(counts)[0]!.value;
}

function latestPublishedAt(jobs: readonly CatalogJobRow[]): string | null {
  let latest: string | null = null;
  for (const job of jobs) {
    if (job.published_at === null || job.published_at === "") continue;
    if (latest === null || job.published_at > latest) latest = job.published_at;
  }
  return latest;
}

function titles(jobs: readonly CatalogJobRow[], limit: number): CareerTitleV1[] {
  const groups = new Map<string, CatalogJobRow[]>();
  for (const job of jobs) {
    const key = titleKey(job.title);
    const list = groups.get(key) ?? [];
    list.push(job);
    groups.set(key, list);
  }

  return [...groups]
    .map(([title_key, titleJobs]) => ({
      title_key,
      title_display: displayTitle(titleJobs),
      job_count: titleJobs.length,
      company_count: companyCount(titleJobs),
      cities: cities(titleJobs),
      top_skills: topSkills(titleJobs, TOP_SKILLS_PER_ITEM),
      student_friendly_count: titleJobs.filter((job) => job.student_friendly === "yes").length,
      latest_published_at: latestPublishedAt(titleJobs),
    }))
    .sort((left, right) => right.job_count - left.job_count || left.title_key.localeCompare(right.title_key))
    .slice(0, limit);
}

function skills(jobs: readonly CatalogJobRow[]): CareerSkillV1[] {
  const withSkills = jobs.filter((job) => (job.skills ?? []).length > 0);
  const counts = new Map<string, number>();
  for (const job of withSkills) {
    for (const skill of new Set(job.skills ?? [])) counts.set(skill, (counts.get(skill) ?? 0) + 1);
  }
  return byDescendingCount(counts)
    .slice(0, TOP_SKILLS)
    .map(({ value, count }) => ({
      skill: value,
      job_count: count,
      share: count / withSkills.length,
    }));
}

export async function loadCareerCatalog(db: Db, options: CareerCatalogOptions): Promise<CareerCatalogResponseV1> {
  if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > MAX_CATALOG_LIMIT) {
    throw new InvalidParameterError(`Query parameter must be between 1 and ${MAX_CATALOG_LIMIT}: limit.`, {
      parameter: "limit",
    });
  }
  if (!Number.isSafeInteger(options.window_days) || options.window_days < 1 || options.window_days > MAX_CATALOG_WINDOW_DAYS) {
    throw new InvalidParameterError(
      `Query parameter must be between 1 and ${MAX_CATALOG_WINDOW_DAYS}: window_days.`,
      { parameter: "window_days" },
    );
  }

  const rows = await db<CatalogJobRow[]>`
    SELECT id, company_name, title, role_family, locations, skills, student_friendly,
           published_at, first_seen_at, last_seen_at, data_origin
    FROM career_jobs`;

  const origins = { live: 0, verified_import: 0, synthetic_fixture: 0 };
  let asOf = 0;
  let unclassifiedJobCount = 0;
  let unclassifiedStudentFriendlyCount = 0;
  for (const row of rows) {
    origins[row.data_origin] += 1;
    asOf = Math.max(asOf, new Date(row.last_seen_at).getTime());
    // 方向榜只统计已归类岗位；未归类数量单独披露，页面据此说明榜单口径与「仅学生友好」的差额。
    if (row.role_family !== "unknown") continue;
    unclassifiedJobCount += 1;
    if (row.student_friendly === "yes") unclassifiedStudentFriendlyCount += 1;
  }

  const windowStart = Date.now() - options.window_days * DAY_MS;
  return {
    contract_version: "0.1",
    data_origin: resolveDataOrigin(origins),
    as_of: rows.length === 0 ? EPOCH_ISO : new Date(asOf).toISOString(),
    window_days: options.window_days,
    sample_size: rows.length,
    unclassified_job_count: unclassifiedJobCount,
    unclassified_student_friendly_count: unclassifiedStudentFriendlyCount,
    unclassified_ratio: rows.length === 0 ? null : unclassifiedJobCount / rows.length,
    directions: directions(rows, windowStart, options.limit),
    titles: titles(rows, options.limit),
    skills: skills(rows),
  };
}