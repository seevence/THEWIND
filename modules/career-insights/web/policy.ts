import { data } from "react-router";
import type { DataOrigin, PolicyEvidenceRefV1 } from "@aihot/career-insights/contracts";
import { THEME_LABELS } from "./labels.ts";

/** 政策列表按 API 的默认页大小取数。 */
export const POLICY_PAGE_SIZE = 20;
const MAX_PAGE = 10_000;
const MAX_PAGE_SIZE = 100;

export interface PolicyPageFilters {
  source_key?: string;
  theme?: string;
  page: number;
  page_size: number;
}

export interface PolicySourceFacetV1 {
  source_key: string;
  count: number;
}

export interface PolicyThemeFacetV1 {
  theme_id: string;
  count: number;
}

export interface PolicyFacetsV1 {
  sources: PolicySourceFacetV1[];
  themes: PolicyThemeFacetV1[];
}

export interface PolicyListResponse {
  contract_version: "0.1";
  data_origin: DataOrigin;
  as_of: string;
  items: PolicyEvidenceRefV1[];
  page: number;
  page_size: number;
  total: number;
  filters: PolicyPageFilters;
  /** 老 API 或固件没有 facets；缺失时前端回退到静态来源清单，避免白屏。 */
  facets?: PolicyFacetsV1;
}

export type PolicyFilterParameter = "source_key" | "theme" | "page" | "page_size";

export type PolicyFiltersResult =
  | { ok: true; filters: PolicyPageFilters }
  | { ok: false; error: { code: "invalid_parameter"; parameter: PolicyFilterParameter } };

function invalid(parameter: PolicyFilterParameter): PolicyFiltersResult {
  return { ok: false, error: { code: "invalid_parameter", parameter } };
}

/** null 表示未提供；提供但不是 API 接受的正整数（含越界）返回 null。 */
function parseBoundedInteger(raw: string | null, fallback: number, maximum: number): number | null {
  if (raw === null) return fallback;
  if (!/^[1-9]\d*$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value <= maximum ? value : null;
}

export function parsePolicyFilters(search: URLSearchParams): PolicyFiltersResult {
  const page = parseBoundedInteger(search.get("page"), 1, MAX_PAGE);
  if (page === null) return invalid("page");
  const pageSize = parseBoundedInteger(search.get("page_size"), POLICY_PAGE_SIZE, MAX_PAGE_SIZE);
  if (pageSize === null) return invalid("page_size");

  const filters: PolicyPageFilters = { page, page_size: pageSize };

  const sourceKey = search.get("source_key");
  if (sourceKey !== null) {
    // 来源选项由 API facets.sources 提供，静态清单只用于 fallback 与标签；这里仅做形态校验，避免 400 拒绝新源。
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(sourceKey)) return invalid("source_key");
    filters.source_key = sourceKey;
  }

  const theme = search.get("theme");
  if (theme !== null) {
    if (!Object.hasOwn(THEME_LABELS, theme)) return invalid("theme");
    filters.theme = theme;
  }

  return { ok: true, filters };
}

/** loader 用：非法筛选与 API 同语义返回 400，交给 ErrorBoundary 显示错误页而不是丢弃参数展示全量。 */
export function parsePolicyFiltersOrThrow(search: URLSearchParams): PolicyPageFilters {
  const result = parsePolicyFilters(search);
  if (!result.ok) throw data({ error: result.error }, { status: 400 });
  return result.filters;
}

export function serializePolicyFilters(filters: Partial<PolicyPageFilters>): string {
  const params = new URLSearchParams();
  const keys = ["source_key", "theme", "page", "page_size"] as const;
  for (const key of keys) {
    const value = filters[key];
    if (value !== undefined) params.set(key, String(value));
  }
  return params.toString();
}

export function buildPoliciesHref(filters: Partial<PolicyPageFilters>): string {
  return `/career-insights/policies?${serializePolicyFilters(filters)}`;
}

/** loader 与测试共用的 API 地址。 */
export function policyApiPath(filters: PolicyPageFilters): string {
  return `/policies?${serializePolicyFilters(filters)}`;
}