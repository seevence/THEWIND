import { beijingAt } from "@aihot/contracts/time";
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

export const DIDI_COLLECTOR_VERSION = "collector/0.1.0";
export const DIDI_LIST_URL =
  "https://talent.didiglobal.com/recruit-portal-service/api/job/front/list";
export const DIDI_DETAIL_API_URL =
  "https://talent.didiglobal.com/recruit-portal-service/api/job/front/view";
export const DIDI_DETAIL_PAGE_URL = "https://talent.didiglobal.com/social/jobDetail";
const SOURCE_KEY = "didi-official-careers";
const PAGE_SIZE = 10;
const MAX_PAGE_LIMIT = 3;
const PAGE_TIMEOUT_MS = 20_000;
const MIN_INTERVAL_MS = 1_000;

/**
 * 来源定义由 sources.ts 的 CAREER_SOURCE_DEFINITIONS 登记；接线前由 lead 把同一份定义合入 sources.ts，
 * 适配器优先使用登记定义，测试可经由 options.definition 注入。
 */
export const DIDI_SOURCE_DEFINITION: CareerSourceDefinition = {
  source_key: SOURCE_KEY,
  label: "滴滴官方招聘",
  kind: "company_careers",
  entry_url: "https://talent.didiglobal.com/social/",
  access: "http",
  enabled: true,
  notes:
    "2026-11-21 实测：公开 JSON——列表 GET /recruit-portal-service/api/job/front/list?page=&size=（无 Cookie、无 token、无签名），列表项已含 jobDuty/jobQualification；详情 GET /recruit-portal-service/api/job/front/view/{jdId}，详情页 /social/jobDetail?jdId=。已存 3 份列表 + 2 份详情真实样本，适配器与回放用例通过。",
};

export interface DidiJobSummary {
  readonly jdId: string;
  readonly title: string;
  readonly locations: readonly string[];
  readonly duty: string | null;
  readonly qualification: string | null;
  readonly jobTypeName: string | null;
  readonly department: string | null;
  readonly createTime: string | null;
  readonly refreshTime: string | null;
  readonly publishTimeMs: number | null;
  readonly raw: Record<string, unknown>;
}

const CN_DATE_TIME_PATTERN = /^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{1,2}):(\d{1,2})$/;
const CN_DATE_PATTERN = /^(\d{4})-(\d{1,2})-(\d{1,2})$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function integer(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * 滴滴列表的 createTime 不带时区（北京时间）；详情接口的 publishTime/refreshTime 是毫秒时间戳。
 * 两者都按 +08:00 读成 UTC ISO，无法解析保持 null。
 */
export function parseDidiPublishedAt(
  createTime: string | null,
  refreshTime: string | null,
  publishTimeMs: number | null = null,
): string | null {
  if (publishTimeMs !== null) {
    const date = new Date(publishTimeMs);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  if (createTime !== null) {
    const match = CN_DATE_TIME_PATTERN.exec(createTime.trim());
    if (match !== null) {
      return buildIso(match[1], match[2], match[3], match[4], match[5], match[6]);
    }
  }
  if (refreshTime !== null) {
    const match = CN_DATE_PATTERN.exec(refreshTime.trim());
    if (match !== null) {
      return buildIso(match[1], match[2], match[3], "0", "0", "0");
    }
  }
  return null;
}

function buildIso(
  year: string | undefined,
  month: string | undefined,
  day: string | undefined,
  hour: string | undefined,
  minute: string | undefined,
  second: string | undefined,
): string | null {
  if (
    year === undefined ||
    month === undefined ||
    day === undefined ||
    hour === undefined ||
    minute === undefined ||
    second === undefined
  ) {
    return null;
  }
  const pad = (value: string) => value.padStart(2, "0");
  const base = beijingAt(
    `${year}-${pad(month)}-${pad(day)}`,
    `${pad(hour)}:${pad(minute)}`,
  );
  const date = new Date(base.getTime() + Number(pad(second)) * 1000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function toSummary(item: Record<string, unknown>, fallback?: DidiJobSummary): DidiJobSummary {
  const rawId = item["jdId"];
  const jdId =
    (typeof rawId === "number" && Number.isFinite(rawId) ? String(rawId) : null) ??
    text(rawId) ??
    fallback?.jdId;
  const title = text(item["jobName"]) ?? fallback?.title;
  if (jdId === undefined || jdId === null || title === undefined || title === null) {
    throw new ParseFailedError("滴滴职位条目缺少 jdId / jobName", SOURCE_KEY);
  }
  return {
    jdId,
    title,
    locations: normalizeLocations(item["workArea"] ?? fallback?.locations),
    duty: text(item["jobDuty"]) ?? text(item["jobDesc"]) ?? fallback?.duty ?? null,
    qualification: text(item["jobQualification"]) ?? text(item["qualification"]) ?? fallback?.qualification ?? null,
    jobTypeName: text(item["jobTypeName"]) ?? text(item["jobType"]) ?? fallback?.jobTypeName ?? null,
    department: text(item["deptName"]) ?? fallback?.department ?? null,
    createTime: text(item["createTime"]) ?? fallback?.createTime ?? null,
    refreshTime: text(item["refreshTime"]) ?? fallback?.refreshTime ?? null,
    publishTimeMs: integer(item["publishTime"]) ?? fallback?.publishTimeMs ?? null,
    raw: item,
  };
}

function normalizeLocations(value: unknown): string[] {
  if (Array.isArray(value)) {
    const seen = new Set<string>();
    for (const entry of value) {
      const name = text(entry);
      if (name !== null) {
        seen.add(name.trim());
      }
    }
    return [...seen];
  }
  const single = text(value);
  return single === null ? [] : [single.trim()];
}

export function parseDidiList(body: Buffer | string): DidiJobSummary[] {
  const parsed: unknown = typeof body === "string" ? JSON.parse(body) : JSON.parse(body.toString("utf8"));
  if (!isRecord(parsed) || !isRecord(parsed["data"]) || !Array.isArray(parsed["data"]["items"])) {
    throw new SchemaChangedError("滴滴列表响应缺少 data.items", SOURCE_KEY);
  }
  return (parsed["data"]["items"] as unknown[]).map((item) => {
    if (!isRecord(item)) {
      throw new ParseFailedError("滴滴列表条目不是对象", SOURCE_KEY);
    }
    return toSummary(item);
  });
}

export function parseDidiDetail(body: Buffer | string, summary: DidiJobSummary): DidiJobSummary {
  const parsed: unknown = typeof body === "string" ? JSON.parse(body) : JSON.parse(body.toString("utf8"));
  if (!isRecord(parsed) || !isRecord(parsed["data"])) {
    throw new SchemaChangedError("滴滴详情响应缺少 data", SOURCE_KEY);
  }
  return toSummary(parsed["data"], summary);
}

export function didiDetailPageUrl(jdId: string): string {
  return `${DIDI_DETAIL_PAGE_URL}?jdId=${encodeURIComponent(jdId)}`;
}

export function toDidiRawJob(item: DidiJobSummary, fetchedAt: string): RawCollectedJobV1 {
  const sections = [item.duty, item.qualification].filter(
    (section): section is string => section !== null,
  );
  if (sections.length === 0) {
    throw new ParseFailedError(`滴滴职位 ${item.jdId} 缺少职责与要求正文`, SOURCE_KEY);
  }

  return {
    schema_version: "1.0",
    source_key: SOURCE_KEY,
    source_job_id: item.jdId,
    company_name: "滴滴",
    title: item.title,
    official_url: didiDetailPageUrl(item.jdId),
    raw_text: sections.join("\n\n"),
    raw_payload: item.raw,
    published_at: parseDidiPublishedAt(item.createTime, item.refreshTime, item.publishTimeMs),
    fetched_at: fetchedAt,
    collector_version: DIDI_COLLECTOR_VERSION,
    hints: {
      role_family: "unknown",
      locations: [...item.locations],
      degree_raw: null,
      experience_raw: null,
      employment_type: "unknown",
      skill_terms: [],
    },
  };
}

export interface DidiAdapterOptions {
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
    url: `${DIDI_LIST_URL}?page=${page}&size=${PAGE_SIZE}`,
    sourceKey,
    pageTimeoutMs: PAGE_TIMEOUT_MS,
    headers: { accept: "application/json" },
    ...(signal === undefined ? {} : { signal }),
  });
}

function buildDetailRequest(jdId: string, sourceKey: string, signal: AbortSignal | undefined): PageRequest {
  return createPageRequest({
    url: `${DIDI_DETAIL_API_URL}/${encodeURIComponent(jdId)}`,
    sourceKey,
    pageTimeoutMs: PAGE_TIMEOUT_MS,
    headers: { accept: "application/json" },
    ...(signal === undefined ? {} : { signal }),
  });
}

export function createDidiOfficialCareersAdapter(
  transport: FetchTransport,
  options: DidiAdapterOptions = {},
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
        const summaries = parseDidiList(listResponse.body);
        for (const summary of summaries) {
          if (isAborted(signal)) {
            throw new DOMException("采集被取消", "AbortError");
          }
          let detail: DidiJobSummary = summary;
          if (summary.duty === null && summary.qualification === null) {
            await sleep(MIN_INTERVAL_MS);
            const detailResponse = await transport.fetchPage(
              buildDetailRequest(summary.jdId, definition.source_key, signal),
            );
            detail = parseDidiDetail(detailResponse.body, summary);
          }
          jobs.push(toDidiRawJob(detail, now()));
        }
      }
      return jobs;
    },
  };
}
