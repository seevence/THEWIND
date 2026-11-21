import type { RawCollectedJobV1 } from "../../contracts/index.ts";
import type { CareerCollectOptions, CareerSourceAdapter } from "../index.ts";
import { CAREER_SOURCE_DEFINITIONS } from "../sources.ts";
import { ConfigError, ParseFailedError, SchemaChangedError } from "../fetch/errors.ts";
import { createPageRequest } from "../fetch/transport.ts";
import type { FetchTransport, PageRequest } from "../fetch/transport.ts";

export const MEITUAN_COLLECTOR_VERSION = "collector/0.1.0";
export const MEITUAN_LIST_URL = "https://zhaopin.meituan.com/api/official/job/getJobList";
const SOURCE_KEY = "meituan-official-careers";
const PAGE_TIMEOUT_MS = 20_000;
const MIN_INTERVAL_MS = 1_000;
const DETAIL_URL_PREFIX = "https://zhaopin.meituan.com/web/position/detail?jobUnionId=";

export interface MeituanPostSummary {
  readonly jobUnionId: string;
  readonly title: string;
  readonly locations: readonly string[];
  readonly jobFamily: string | null;
  readonly jobDuty: string | null;
  readonly jobRequirement: string | null;
  readonly workYear: string | null;
  readonly firstPostTime: string | null;
  readonly refreshTime: string | null;
  readonly raw: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function normalizeLocations(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set<string>();
  for (const entry of value) {
    const name = isRecord(entry) ? text(entry["name"]) : text(entry);
    if (name !== null) {
      seen.add(name.trim());
    }
  }
  return [...seen];
}

export function parseMeituanPublishedAt(raw: string | null): string | null {
  if (raw === null) {
    return null;
  }
  const match = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(raw.trim());
  if (match === null) {
    return null;
  }
  const iso = `${match[1]}-${(match[2] ?? "").padStart(2, "0")}-${(match[3] ?? "").padStart(2, "0")}T00:00:00.000Z`;
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? null : iso;
}

export function parseMeituanList(body: Buffer | string): MeituanPostSummary[] {
  const parsed: unknown = typeof body === "string" ? JSON.parse(body) : JSON.parse(body.toString("utf8"));
  if (!isRecord(parsed) || !isRecord(parsed["data"]) || !Array.isArray(parsed["data"]["list"])) {
    throw new SchemaChangedError("美团列表响应缺少 data.list", SOURCE_KEY);
  }
  return (parsed["data"]["list"] as unknown[]).map((item) => {
    if (!isRecord(item)) {
      throw new ParseFailedError("美团列表条目不是对象", SOURCE_KEY);
    }
    const jobUnionId = text(item["jobUnionId"]);
    const title = text(item["name"]);
    if (jobUnionId === null || title === null) {
      throw new ParseFailedError("美团列表条目缺少 jobUnionId / name", SOURCE_KEY);
    }
    return {
      jobUnionId,
      title,
      locations: normalizeLocations(item["cityList"]),
      jobFamily: text(item["jobFamily"]),
      jobDuty: text(item["jobDuty"]),
      jobRequirement: text(item["jobRequirement"]),
      workYear: text(item["workYear"]),
      firstPostTime: text(item["firstPostTime"]),
      refreshTime: text(item["refreshTime"]),
      raw: item,
    };
  });
}

export function toMeituanRawJob(item: MeituanPostSummary, fetchedAt: string): RawCollectedJobV1 {
  const sections = [item.jobDuty, item.jobRequirement].filter(
    (section): section is string => section !== null,
  );
  if (sections.length === 0) {
    throw new ParseFailedError(`美团职位 ${item.jobUnionId} 缺少职责与要求正文`, SOURCE_KEY);
  }

  return {
    schema_version: "1.0",
    source_key: SOURCE_KEY,
    source_job_id: item.jobUnionId,
    company_name: "美团",
    title: item.title,
    official_url: `${DETAIL_URL_PREFIX}${encodeURIComponent(item.jobUnionId)}`,
    raw_text: sections.join("\n\n"),
    raw_payload: item.raw,
    published_at: parseMeituanPublishedAt(item.firstPostTime ?? item.refreshTime),
    fetched_at: fetchedAt,
    collector_version: MEITUAN_COLLECTOR_VERSION,
    hints: {
      role_family: "unknown",
      locations: [...item.locations],
      degree_raw: null,
      experience_raw: item.workYear,
      employment_type: "unknown",
      skill_terms: [],
    },
  };
}

export interface MeituanAdapterOptions {
  readonly pageLimit?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => string;
}

function buildListRequest(page: number, sourceKey: string, signal: AbortSignal | undefined): PageRequest {
  return createPageRequest({
    url: MEITUAN_LIST_URL,
    sourceKey,
    pageTimeoutMs: PAGE_TIMEOUT_MS,
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      page: { pageNo: page, pageSize: 10 },
      jobShareType: "1",
      keywords: "",
      cityList: [],
      department: [],
      jfJgList: [],
      jobType: [],
      typeCode: [],
      specialCode: [],
    }),
    ...(signal === undefined ? {} : { signal }),
  });
}

export function createMeituanOfficialCareersAdapter(
  transport: FetchTransport,
  options: MeituanAdapterOptions = {},
): CareerSourceAdapter {
  const definition = CAREER_SOURCE_DEFINITIONS.find((item) => item.source_key === SOURCE_KEY);
  if (definition === undefined) {
    throw new ConfigError(`来源 ${SOURCE_KEY} 未在 CAREER_SOURCE_DEFINITIONS 中登记`);
  }
  const defaultPageLimit = Math.max(1, Math.min(options.pageLimit ?? 1, 10));
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? (() => new Date().toISOString());

  return {
    definition,
    async collect(
      signal?: AbortSignal,
      callOptions?: CareerCollectOptions,
    ): Promise<RawCollectedJobV1[]> {
      const pageLimit = Math.max(1, Math.min(callOptions?.pageLimit ?? defaultPageLimit, 10));
      const jobs: RawCollectedJobV1[] = [];
      for (let page = 1; page <= pageLimit; page += 1) {
        if (page > 1) {
          await sleep(MIN_INTERVAL_MS);
        }
        const listResponse = await transport.fetchPage(
          buildListRequest(page, definition.source_key, signal),
        );
        const summaries = parseMeituanList(listResponse.body);
        for (const summary of summaries) {
          jobs.push(toMeituanRawJob(summary, now()));
        }
      }
      return jobs;
    },
  };
}