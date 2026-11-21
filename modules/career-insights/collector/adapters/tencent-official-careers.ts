import type { RawCollectedJobV1 } from "../../contracts/index.ts";
import type { CareerCollectOptions, CareerSourceAdapter } from "../index.ts";
import { CAREER_SOURCE_DEFINITIONS } from "../sources.ts";
import { ConfigError, ParseFailedError, SchemaChangedError } from "../fetch/errors.ts";
import type { FetchTransport, PageRequest, TransportResponse } from "../fetch/transport.ts";

export const TENCENT_COLLECTOR_VERSION = "collector/0.1.0";
export const TENCENT_LIST_URL =
  "https://careers.tencent.com/tencentcareer/api/post/Query?pageIndex=1&pageSize=10&language=zh-cn&area=cn";
export const TENCENT_DETAIL_URL = "https://careers.tencent.com/tencentcareer/api/post/ByPostId";
const SOURCE_KEY = "tencent-official-careers";
const PAGE_TIMEOUT_MS = 20_000;
const MIN_INTERVAL_MS = 1_000;

const CN_DATE_PATTERN = /^(\d{4})年(\d{1,2})月(\d{1,2})日$/;
const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

export interface TencentPostSummary {
  readonly postId: string;
  readonly title: string;
  readonly locationName: string | null;
  readonly postUrl: string;
  readonly lastUpdateTime: string | null;
}

export interface TencentPostDetail extends TencentPostSummary {
  readonly categoryName: string | null;
  readonly responsibility: string | null;
  readonly requirement: string | null;
  readonly requireWorkYearsName: string | null;
  readonly raw: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

export function parseTencentPublishedAt(raw: string | null): string | null {
  if (raw === null) {
    return null;
  }
  const trimmed = raw.trim();
  const cn = CN_DATE_PATTERN.exec(trimmed);
  if (cn !== null) {
    return buildUtcDate(cn[1], cn[2], cn[3]);
  }
  const iso = ISO_DATE_PATTERN.exec(trimmed);
  if (iso !== null) {
    return buildUtcDate(iso[1], iso[2], iso[3]);
  }
  return null;
}

function buildUtcDate(year: string | undefined, month: string | undefined, day: string | undefined): string | null {
  if (year === undefined || month === undefined || day === undefined) {
    return null;
  }
  const iso = `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}T00:00:00.000Z`;
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? null : iso;
}

export function parseTencentList(body: Buffer | string): TencentPostSummary[] {
  const parsed: unknown = typeof body === "string" ? JSON.parse(body) : JSON.parse(body.toString("utf8"));
  if (!isRecord(parsed) || !isRecord(parsed["Data"]) || !Array.isArray(parsed["Data"]["Posts"])) {
    throw new SchemaChangedError("腾讯列表响应缺少 Data.Posts", SOURCE_KEY);
  }
  return (parsed["Data"]["Posts"] as unknown[]).map((item) => {
    if (!isRecord(item)) {
      throw new ParseFailedError("腾讯列表条目不是对象", SOURCE_KEY);
    }
    const postId = text(item["PostId"]);
    const title = text(item["RecruitPostName"]);
    const postUrl = text(item["PostURL"]);
    if (postId === null || title === null || postUrl === null) {
      throw new ParseFailedError("腾讯列表条目缺少 PostId / RecruitPostName / PostURL", SOURCE_KEY);
    }
    return {
      postId,
      title,
      locationName: text(item["LocationName"]),
      postUrl,
      lastUpdateTime: text(item["LastUpdateTime"]),
    };
  });
}

export function parseTencentDetail(body: Buffer | string, summary: TencentPostSummary): TencentPostDetail {
  const parsed: unknown = typeof body === "string" ? JSON.parse(body) : JSON.parse(body.toString("utf8"));
  if (!isRecord(parsed) || !isRecord(parsed["Data"])) {
    throw new SchemaChangedError("腾讯详情响应缺少 Data", SOURCE_KEY);
  }
  const data = parsed["Data"];
  return {
    postId: text(data["PostId"]) ?? summary.postId,
    title: text(data["RecruitPostName"]) ?? summary.title,
    locationName: text(data["LocationName"]) ?? summary.locationName,
    postUrl: text(data["PostURL"]) ?? summary.postUrl,
    lastUpdateTime: text(data["LastUpdateTime"]) ?? summary.lastUpdateTime,
    categoryName: text(data["CategoryName"]),
    responsibility: text(data["Responsibility"]),
    requirement: text(data["Requirement"]),
    requireWorkYearsName: text(data["RequireWorkYearsName"]),
    raw: data,
  };
}

export function toTencentRawJob(detail: TencentPostDetail, fetchedAt: string): RawCollectedJobV1 {
  const sections = [detail.responsibility, detail.requirement].filter(
    (section): section is string => section !== null,
  );
  if (sections.length === 0) {
    throw new ParseFailedError(`腾讯职位 ${detail.postId} 缺少职责与要求正文`, SOURCE_KEY);
  }

  return {
    schema_version: "1.0",
    source_key: SOURCE_KEY,
    source_job_id: detail.postId,
    company_name: "腾讯",
    title: detail.title,
    official_url: detail.postUrl,
    raw_text: sections.join("\n\n"),
    raw_payload: detail.raw,
    published_at: parseTencentPublishedAt(detail.lastUpdateTime),
    fetched_at: fetchedAt,
    collector_version: TENCENT_COLLECTOR_VERSION,
    hints: {
      role_family: "unknown",
      locations: detail.locationName === null ? [] : [detail.locationName],
      degree_raw: null,
      experience_raw: detail.requireWorkYearsName,
      employment_type: "unknown",
      skill_terms: [],
    },
  };
}

export interface TencentAdapterOptions {
  readonly pageLimit?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => string;
}

export function createTencentOfficialCareersAdapter(
  transport: FetchTransport,
  options: TencentAdapterOptions = {},
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
        const listUrl = TENCENT_LIST_URL.replace("pageIndex=1", `pageIndex=${page}`);
        const listResponse = await transport.fetchPage(
          buildRequest(listUrl, definition.source_key, signal),
        );
        const summaries = parseTencentList(listResponse.body);
        for (const summary of summaries) {
          if (signal?.aborted === true) {
            throw new DOMException("采集被取消", "AbortError");
          }
          await sleep(MIN_INTERVAL_MS);
          const detailUrl = `${TENCENT_DETAIL_URL}?postId=${encodeURIComponent(summary.postId)}&language=zh-cn`;
          const detailResponse = await transport.fetchPage(
            buildRequest(detailUrl, definition.source_key, signal),
          );
          jobs.push(toTencentRawJob(parseTencentDetail(detailResponse.body, summary), now()));
        }
      }
      return jobs;
    },
  };
}

function buildRequest(url: string, sourceKey: string, signal: AbortSignal | undefined): PageRequest {
  return {
    url,
    method: "GET",
    headers: { accept: "application/json" },
    pageTimeoutMs: PAGE_TIMEOUT_MS,
    sourceKey,
    ...(signal === undefined ? {} : { signal }),
  };
}

export function summarizeTencentResponse(response: TransportResponse): string {
  return `${response.status} ${response.contentType ?? "unknown"}`;
}