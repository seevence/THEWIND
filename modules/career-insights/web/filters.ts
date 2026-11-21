import type { EmploymentType, JobFiltersV1, RoleFamily, StudentFriendly } from "@aihot/career-insights/contracts";

export const JOB_PAGE_SIZES: readonly [20, 50] = [20, 50];

export type DashboardView = "overview" | "direction";

const ROLE_FAMILIES: readonly RoleFamily[] = ["ai_algorithm", "ai_application_development", "data", "ai_product_operations", "unknown"];
const EMPLOYMENT_TYPES: readonly EmploymentType[] = ["campus", "internship", "experienced", "other", "unknown"];
const STUDENT_FRIENDLY_VALUES: readonly StudentFriendly[] = ["yes", "no", "unknown"];

export function serializeJobFilters(filters: Partial<JobFiltersV1>): string {
  const params = new URLSearchParams();
  const keys = ["role_family", "company", "city", "employment_type", "student_friendly", "skill", "q", "page", "page_size"] as const;
  for (const key of keys) {
    const value = filters[key];
    if (value !== undefined) params.set(key, String(value));
  }
  return params.toString();
}

function pickEnum<T extends string>(value: string | null, allowed: readonly T[]): T | undefined {
  if (value === null) return undefined;
  return (allowed as readonly string[]).includes(value) ? (value as T) : undefined;
}

const MAX_PAGE = 1_000_000;

function parsePage(raw: string | null): number {
  if (raw === null || !/^[1-9]\d*$/.test(raw)) return 1;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value <= MAX_PAGE ? value : 1;
}

function parsePageSize(raw: string | null): number {
  const value = Number(raw);
  return (JOB_PAGE_SIZES as readonly number[]).includes(value) ? value : JOB_PAGE_SIZES[0];
}

export function parseDashboardFilters(search: URLSearchParams): JobFiltersV1 {
  const filters: JobFiltersV1 = {
    page: parsePage(search.get("page")),
    page_size: parsePageSize(search.get("page_size")),
  };

  const roleFamily = pickEnum(search.get("role_family"), ROLE_FAMILIES);
  if (roleFamily) filters.role_family = roleFamily;
  const employmentType = pickEnum(search.get("employment_type"), EMPLOYMENT_TYPES);
  if (employmentType) filters.employment_type = employmentType;
  const studentFriendly = pickEnum(search.get("student_friendly"), STUDENT_FRIENDLY_VALUES);
  if (studentFriendly) filters.student_friendly = studentFriendly;

  for (const key of ["company", "city", "skill", "q"] as const) {
    const value = search.get(key)?.trim();
    if (value) filters[key] = value;
  }

  return filters;
}

export function buildJobsHref(filters: JobFiltersV1): string {
  return `/career-insights?${serializeJobFilters(filters)}`;
}

/** 岗位明细区块的锚点：分页链接带上它，换页后停在明细处而不是回到页面顶部；筛选 chip 不带。 */
export const JOBS_LIST_ANCHOR = "#catalog-jobs";

/** 只给分页链接追加锚点，buildJobsHref / buildCatalogHref 本身的输出保持不变。 */
export function withJobsListAnchor(href: string): string {
  return `${href}${JOBS_LIST_ANCHOR}`;
}

export function parseDirectionView(search: URLSearchParams): { view: DashboardView; roleFamily?: RoleFamily } {
  if (search.get("view") !== "direction") return { view: "overview" };
  const roleFamily = pickEnum(search.get("role_family"), ROLE_FAMILIES);
  return roleFamily ? { view: "direction", roleFamily } : { view: "direction" };
}

export function buildDirectionHref(roleFamily: RoleFamily): string {
  return `/career-insights?view=direction&role_family=${encodeURIComponent(roleFamily)}&page=1&page_size=${JOB_PAGE_SIZES[0]}`;
}

export function buildJobHref(jobId: string, back: string): string {
  return `/career-insights/jobs/${encodeURIComponent(jobId)}?back=${encodeURIComponent(back)}`;
}

/**
 * 详情页「返回职位列表」只接受站内职业洞察路径：洞察页与岗位目录（列表传入的 back 是带筛选的目录 URL，
 * 见 JobsCatalogBoard 的 buildCatalogHref）。其它 origin、协议相对地址和其它路径一律回退洞察页，
 * 避免 back 参数被拿来做开放重定向。
 */
const CAREER_BACK_PATHS = ["/career-insights", "/career-insights/jobs"] as const;

export function safeBackHref(raw: string | null): string {
  if (raw === null || raw.includes("//") || raw.includes(":")) return "/career-insights";
  const isCareerPath = CAREER_BACK_PATHS.some((path) => raw === path || raw.startsWith(`${path}?`));
  return isCareerPath ? raw : "/career-insights";
}
