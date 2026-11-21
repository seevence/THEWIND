// 就业热点只读接口的取数入口。服务端专用：由路由 loader 与 standalone 断言调用，
// 不进入客户端 bundle（文件名后缀 .server 由框架剥离）。
import { API_BASE_URL } from "@aihot/web/lib/api.server";
import type {
  CareerDailyResponseV1,
  CareerHotResponseV1,
  CareerSignalsResponseV1,
  SummaryResponseV1,
} from "../contracts/index.ts";
import { careerApiPath, loadCareerApi } from "./api.ts";
import { JOB_PAGE_SIZES } from "./filters.ts";

export const SIGNALS_LIMIT = 5;
export const HOT_LIMIT = 10;

export function careerSignalsPath(): string {
  return `${careerApiPath("/signals")}?limit=${SIGNALS_LIMIT}`;
}

export function careerHotPath(): string {
  return `${careerApiPath("/hot")}?limit=${HOT_LIMIT}`;
}

export function careerDailyPath(): string {
  return careerApiPath("/daily");
}

/** 日报 AI 评论缓存；date 缺省时后端按 Asia/Shanghai 的今天取，页面只读缓存。 */
export function careerDailyCommentPath(date?: string): string {
  const path = careerApiPath("/daily-comment");
  return date === undefined ? path : `${path}?date=${encodeURIComponent(date)}`;
}

export function careerSummaryPath(): string {
  return careerApiPath("/summary");
}

/** C-CATALOG@1：方向榜与职位榜共用 limit，技能榜固定前 10。 */
export function careerCatalogPath(limit: number): string {
  return `${careerApiPath("/catalog")}?limit=${limit}`;
}

export function careerLatestJobsPath(): string {
  return `${careerApiPath("/jobs")}?page=1&page_size=${JOB_PAGE_SIZES[0]}`;
}

export function careerBriefPath(): string {
  return careerApiPath("/brief");
}

export function loadCareerSignals(signal?: AbortSignal): Promise<CareerSignalsResponseV1> {
  return loadCareerApi<CareerSignalsResponseV1>(careerSignalsPath(), signal);
}

export function loadCareerHot(signal?: AbortSignal): Promise<CareerHotResponseV1> {
  return loadCareerApi<CareerHotResponseV1>(careerHotPath(), signal);
}

export function loadCareerDaily(signal?: AbortSignal): Promise<CareerDailyResponseV1> {
  return loadCareerApi<CareerDailyResponseV1>(careerDailyPath(), signal);
}

export function loadCareerSummary(signal?: AbortSignal): Promise<SummaryResponseV1> {
  return loadCareerApi<SummaryResponseV1>(careerSummaryPath(), signal);
}

/**
 * 待联调：C-CATALOG@1 / C-BRIEF@1 的响应类型合入 @aihot/career-insights/contracts 后，
 * 调用方从契约包取类型即可，这里只负责请求。
 */
export function loadCareerCatalog<T>(limit: number, signal?: AbortSignal): Promise<T> {
  return loadCareerApi<T>(careerCatalogPath(limit), signal);
}

export function loadCareerLatestJobs<T>(signal?: AbortSignal): Promise<T> {
  return loadCareerApi<T>(careerLatestJobsPath(), signal);
}

/**
 * 只读离线缓存：无缓存时接口返回 204。null 表示「还没生成」，与请求失败区分开；
 * 请求失败抛给调用方逐块降级，读者访问不触发模型调用。
 */
async function loadCachedJson<T>(path: string, signal?: AbortSignal): Promise<T | null> {
  const timeout = AbortSignal.timeout(15_000);
  const res = await fetch(`${API_BASE_URL}${path}`, {
    headers: { accept: "application/json", "x-aihot-ssr": "1" },
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  if (res.status === 204) return null;
  if (!res.ok) throw new Error(`career cached read api ${res.status}`);
  return (await res.json()) as T;
}

/** C-BRIEF@1：洞察页的研判缓存，204 → null。 */
export function loadCareerBrief<T>(signal?: AbortSignal): Promise<T | null> {
  return loadCachedJson<T>(careerBriefPath(), signal);
}

/** C-DAILY-COMMENT@1：日报页的 AI 评论缓存，204 → null；失败抛给路由，按区块隐藏。 */
export function loadCareerDailyComment<T>(signal?: AbortSignal, date?: string): Promise<T | null> {
  return loadCachedJson<T>(careerDailyCommentPath(date), signal);
}