import { loadOr404 } from "@aihot/web/lib/api.server";
import type { PolicyListResponse } from "./policy.ts";

const CAREER_API_ROOT = "/api/site/career-insights";

export {
  JOB_PAGE_SIZES,
  buildDirectionHref,
  buildJobHref,
  buildJobsHref,
  parseDashboardFilters,
  parseDirectionView,
  safeBackHref,
  serializeJobFilters,
} from "./filters.ts";
export type { DashboardView } from "./filters.ts";

export function careerApiPath(path: string): string {
  return `${CAREER_API_ROOT}${path.startsWith("/") ? path : `/${path}`}`;
}

export function loadCareerApi<T>(path: string, signal?: AbortSignal): Promise<T> {
  return loadOr404<T>(path, { signal, preserveServerErrorStatus: true });
}

export function loadPolicies(path: string, signal?: AbortSignal): Promise<PolicyListResponse> {
  return loadCareerApi<PolicyListResponse>(careerApiPath(path), signal);
}