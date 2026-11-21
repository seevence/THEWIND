import type { RawCollectedJobV1 } from "../../contracts/index.ts";
import type { CareerCollectOptions, CareerSourceAdapter } from "../index.ts";
import { CAREER_SOURCE_DEFINITIONS } from "../sources.ts";
import { ConfigError, ParseFailedError, SchemaChangedError } from "../fetch/errors.ts";
import { createPageRequest } from "../fetch/transport.ts";
import type { FetchTransport, PageRequest } from "../fetch/transport.ts";

export const BAIDU_COLLECTOR_VERSION = "collector/0.1.0";
export const BAIDU_LIST_URL = "https://talent.baidu.com/httservice/getPostListNew";
const SOURCE_KEY = "baidu-official-careers";
const PAGE_TIMEOUT_MS = 20_000;
const MIN_INTERVAL_MS = 1_000;
const DETAIL_URL_PREFIX = "https://talent.baidu.com/jobs/detail/";

export interface BaiduPostSummary {
  readonly postId: string;
  readonly title: string;
  readonly locations: readonly string[];
  readonly postType: string | null;
  readonly workContent: string | null;
  readonly serviceCondition: string | null;
  readonly workYears: string | null;
  readonly education: string | null;
  readonly publishDate: string | null;
  readonly updateDate: string | null;
  readonly raw: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

export function normalizeBaiduWorkPlace(value: string | null): string[] {
  if (value === null) {
    return [];
  }
  const seen = new Set<string>();
  for (const part of value.split(/[,，、;；]/)) {
    const name = part.trim();
    if (name.length > 0) {
      seen.add(name);
    }
  }
  return [...seen];
}

export function parseBaiduPublishedAt(raw: string | null): string | null {
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

export function parseBaiduList(body: Buffer | string): BaiduPostSummary[] {
  const parsed: unknown = typeof body === "string" ? JSON.parse(body) : JSON.parse(body.toString("utf8"));
  if (!isRecord(parsed)) {
    throw new SchemaChangedError("百度列表响应不是对象", SOURCE_KEY);
  }
  const status = text(parsed["status"]);
  const data = parsed["data"];
  if (status !== "ok" || !isRecord(data) || !Array.isArray(data["list"])) {
    throw new SchemaChangedError(
      `百度列表响应异常：status=${status ?? "null"}`,
      SOURCE_KEY,
    );
  }
  return (data["list"] as unknown[]).map((item) => {
    if (!isRecord(item)) {
      throw new ParseFailedError("百度列表条目不是对象", SOURCE_KEY);
    }
    const postId = text(item["postId"]);
    const title = text(item["name"]);
    if (postId === null || title === null) {
      throw new ParseFailedError("百度列表条目缺少 postId / name", SOURCE_KEY);
    }
    return {
      postId,
      title,
      locations: normalizeBaiduWorkPlace(text(item["workPlace"])),
      postType: text(item["postType"]),
      workContent: text(item["workContent"]),
      serviceCondition: text(item["serviceCondition"]),
      workYears: text(item["workYears"]),
      education: text(item["education"]),
      publishDate: text(item["publishDate"]),
      updateDate: text(item["updateDate"]),
      raw: item,
    };
  });
}

export function toBaiduRawJob(item: BaiduPostSummary, fetchedAt: string): RawCollectedJobV1 {
  const sections = [item.workContent, item.serviceCondition].filter(
    (section): section is string => section !== null,
  );
  if (sections.length === 0) {
    throw new ParseFailedError(`百度职位 ${item.postId} 缺少工作内容与服务条件正文`, SOURCE_KEY);
  }

  return {
    schema_version: "1.0",
    source_key: SOURCE_KEY,
    source_job_id: item.postId,
    company_name: "百度",
    title: item.title,
    official_url: `${DETAIL_URL_PREFIX}${encodeURIComponent(item.postId)}`,
    raw_text: sections.join("\n\n"),
    raw_payload: item.raw,
    published_at: parseBaiduPublishedAt(item.publishDate ?? item.updateDate),
    fetched_at: fetchedAt,
    collector_version: BAIDU_COLLECTOR_VERSION,
    hints: {
      role_family: "unknown",
      locations: [...item.locations],
      degree_raw: item.education,
      experience_raw: item.workYears,
      employment_type: "unknown",
      skill_terms: [],
    },
  };
}

export interface BaiduAdapterOptions {
  readonly pageLimit?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => string;
}

function buildListRequest(page: number, sourceKey: string, signal: AbortSignal | undefined): PageRequest {
  return createPageRequest({
    url: BAIDU_LIST_URL,
    sourceKey,
    pageTimeoutMs: PAGE_TIMEOUT_MS,
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
      origin: "https://talent.baidu.com",
      referer: "https://talent.baidu.com/jobs/social-list",
    },
    body: new URLSearchParams({
      recruitType: "SOCIAL",
      pageSize: "10",
      curPage: String(page),
      keyWord: "",
      projectType: "",
      postType: "",
      workPlace: "",
    }).toString(),
    ...(signal === undefined ? {} : { signal }),
  });
}

export function createBaiduOfficialCareersAdapter(
  transport: FetchTransport,
  options: BaiduAdapterOptions = {},
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
        const summaries = parseBaiduList(listResponse.body);
        for (const summary of summaries) {
          jobs.push(toBaiduRawJob(summary, now()));
        }
      }
      return jobs;
    },
  };
}