import type { RawCollectedJobV1 } from "../../contracts/index.ts";
import type {
  CareerCollectOptions,
  CareerSourceAdapter,
  CareerSourceDefinition,
} from "../index.ts";
import { CAREER_SOURCE_DEFINITIONS } from "../sources.ts";
import { ConfigError, ParseFailedError, SchemaChangedError } from "../fetch/errors.ts";
import { createPageRequest } from "../fetch/transport.ts";
import type { FetchTransport, PageRequest } from "../fetch/transport.ts";

export const NETEASE_COLLECTOR_VERSION = "collector/0.1.0";
export const NETEASE_LIST_URL = "https://hr.163.com/api/hr163/position/queryPage";
export const NETEASE_DETAIL_API_URL = "https://hr.163.com/api/hr163/position/query";
export const NETEASE_DETAIL_PAGE_URL = "https://hr.163.com/job-detail.html";
const SOURCE_KEY = "netease-official-careers";
const PAGE_SIZE = 10;
const MAX_PAGE_LIMIT = 3;
const PAGE_TIMEOUT_MS = 20_000;
const MIN_INTERVAL_MS = 1_000;

/**
 * 来源定义由 sources.ts 的 CAREER_SOURCE_DEFINITIONS 登记；接线前（本文件独立提交时）由 lead 把同一份定义
 * 合入 sources.ts，适配器优先使用登记定义，测试可经由 options.definition 注入。
 */
export const NETEASE_SOURCE_DEFINITION: CareerSourceDefinition = {
  source_key: SOURCE_KEY,
  label: "网易官方招聘",
  kind: "company_careers",
  entry_url: "https://hr.163.com/",
  access: "http",
  enabled: true,
  notes:
    "2026-11-21 实测：公开 JSON——列表 POST /api/hr163/position/queryPage（无 Cookie、无 token、无签名），列表项已含 description/requirement；详情 GET /api/hr163/position/query?id=，详情页 /job-detail.html?id=。已存 3 份列表 + 2 份详情真实样本，适配器与回放用例通过。",
};

export interface NetEasePostSummary {
  readonly id: string;
  readonly title: string;
  readonly locations: readonly string[];
  readonly jobFamily: string | null;
  readonly department: string | null;
  readonly productName: string | null;
  readonly description: string | null;
  readonly requirement: string | null;
  readonly degreeRaw: string | null;
  readonly experienceRaw: string | null;
  readonly updateTime: number | null;
  readonly raw: Record<string, unknown>;
}

export type NetEasePostDetail = NetEasePostSummary;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function integer(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizeLocations(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set<string>();
  for (const entry of value) {
    const name = text(entry);
    if (name !== null) {
      seen.add(name.trim());
    }
  }
  return [...seen];
}

function toSummary(item: Record<string, unknown>, fallback?: NetEasePostSummary): NetEasePostSummary {
  const id = text(item["id"]) ?? (typeof item["id"] === "number" ? String(item["id"]) : null) ?? fallback?.id;
  const title = text(item["name"]) ?? fallback?.title;
  if (id === undefined || id === null || title === undefined || title === null) {
    throw new ParseFailedError("网易职位条目缺少 id / name", SOURCE_KEY);
  }
  return {
    id,
    title,
    locations: normalizeLocations(item["workPlaceNameList"] ?? fallback?.locations),
    jobFamily: text(item["firstPostTypeName"]) ?? fallback?.jobFamily ?? null,
    department: text(item["firstDepName"]) ?? fallback?.department ?? null,
    productName: text(item["productName"]) ?? fallback?.productName ?? null,
    description: text(item["description"]) ?? fallback?.description ?? null,
    requirement: text(item["requirement"]) ?? fallback?.requirement ?? null,
    degreeRaw: text(item["reqEducationName"]) ?? fallback?.degreeRaw ?? null,
    experienceRaw: text(item["reqWorkYearsName"]) ?? fallback?.experienceRaw ?? null,
    updateTime: integer(item["updateTime"]) ?? fallback?.updateTime ?? null,
    raw: item,
  };
}

export function parseNetEasePublishedAt(raw: number | null): string | null {
  if (raw === null) {
    return null;
  }
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function parseNetEaseList(body: Buffer | string): NetEasePostSummary[] {
  const parsed: unknown = typeof body === "string" ? JSON.parse(body) : JSON.parse(body.toString("utf8"));
  if (!isRecord(parsed) || !isRecord(parsed["data"]) || !Array.isArray(parsed["data"]["list"])) {
    throw new SchemaChangedError("网易列表响应缺少 data.list", SOURCE_KEY);
  }
  return (parsed["data"]["list"] as unknown[]).map((item) => {
    if (!isRecord(item)) {
      throw new ParseFailedError("网易列表条目不是对象", SOURCE_KEY);
    }
    return toSummary(item);
  });
}

export function parseNetEaseDetail(body: Buffer | string, summary: NetEasePostSummary): NetEasePostDetail {
  const parsed: unknown = typeof body === "string" ? JSON.parse(body) : JSON.parse(body.toString("utf8"));
  if (!isRecord(parsed) || !isRecord(parsed["data"])) {
    throw new SchemaChangedError("网易详情响应缺少 data", SOURCE_KEY);
  }
  return toSummary(parsed["data"], summary);
}

export function neteaseDetailPageUrl(id: string): string {
  return `${NETEASE_DETAIL_PAGE_URL}?id=${encodeURIComponent(id)}&lang=zh`;
}

export function toNetEaseRawJob(item: NetEasePostDetail, fetchedAt: string): RawCollectedJobV1 {
  const sections = [item.description, item.requirement].filter(
    (section): section is string => section !== null,
  );
  if (sections.length === 0) {
    throw new ParseFailedError(`网易职位 ${item.id} 缺少职责与要求正文`, SOURCE_KEY);
  }

  return {
    schema_version: "1.0",
    source_key: SOURCE_KEY,
    source_job_id: item.id,
    company_name: "网易",
    title: item.title,
    official_url: neteaseDetailPageUrl(item.id),
    raw_text: sections.join("\n\n"),
    raw_payload: item.raw,
    published_at: parseNetEasePublishedAt(item.updateTime),
    fetched_at: fetchedAt,
    collector_version: NETEASE_COLLECTOR_VERSION,
    hints: {
      role_family: "unknown",
      locations: [...item.locations],
      degree_raw: item.degreeRaw,
      experience_raw: item.experienceRaw,
      employment_type: "unknown",
      skill_terms: [],
    },
  };
}

export interface NetEaseAdapterOptions {
  readonly pageLimit?: number;
  readonly definition?: CareerSourceDefinition;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => string;
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function buildListRequest(page: number, sourceKey: string, signal: AbortSignal | undefined): PageRequest {
  return createPageRequest({
    url: NETEASE_LIST_URL,
    sourceKey,
    pageTimeoutMs: PAGE_TIMEOUT_MS,
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ currentPage: page, pageSize: PAGE_SIZE }),
    ...(signal === undefined ? {} : { signal }),
  });
}

function buildDetailRequest(id: string, sourceKey: string, signal: AbortSignal | undefined): PageRequest {
  return createPageRequest({
    url: `${NETEASE_DETAIL_API_URL}?id=${encodeURIComponent(id)}`,
    sourceKey,
    pageTimeoutMs: PAGE_TIMEOUT_MS,
    headers: { accept: "application/json" },
    ...(signal === undefined ? {} : { signal }),
  });
}

export function createNetEaseOfficialCareersAdapter(
  transport: FetchTransport,
  options: NetEaseAdapterOptions = {},
): CareerSourceAdapter {
  const definition =
    options.definition ??
    CAREER_SOURCE_DEFINITIONS.find((item) => item.source_key === SOURCE_KEY);
  if (definition === undefined) {
    throw new ConfigError(`来源 ${SOURCE_KEY} 未在 CAREER_SOURCE_DEFINITIONS 中登记`);
  }
  const defaultPageLimit = Math.max(1, Math.min(options.pageLimit ?? 1, MAX_PAGE_LIMIT));
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? (() => new Date().toISOString());

  return {
    definition,
    async collect(
      signal?: AbortSignal,
      callOptions?: CareerCollectOptions,
    ): Promise<RawCollectedJobV1[]> {
      const pageLimit = Math.max(1, Math.min(callOptions?.pageLimit ?? defaultPageLimit, MAX_PAGE_LIMIT));
      const jobs: RawCollectedJobV1[] = [];
      for (let page = 1; page <= pageLimit; page += 1) {
        if (isAborted(signal)) {
          throw new DOMException("采集被取消", "AbortError");
        }
        if (page > 1) {
          await sleep(MIN_INTERVAL_MS);
        }
        const listResponse = await transport.fetchPage(
          buildListRequest(page, definition.source_key, signal),
        );
        const summaries = parseNetEaseList(listResponse.body);
        for (const summary of summaries) {
          if (isAborted(signal)) {
            throw new DOMException("采集被取消", "AbortError");
          }
          let detail: NetEasePostDetail = summary;
          if (summary.description === null && summary.requirement === null) {
            await sleep(MIN_INTERVAL_MS);
            const detailResponse = await transport.fetchPage(
              buildDetailRequest(summary.id, definition.source_key, signal),
            );
            detail = parseNetEaseDetail(detailResponse.body, summary);
          }
          jobs.push(toNetEaseRawJob(detail, now()));
        }
      }
      return jobs;
    },
  };
}
