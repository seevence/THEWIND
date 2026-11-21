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

/**
 * 荣耀官方招聘（社招）适配器。
 *
 * 站点：https://career.honor.com/ 由北森社招产品 hotjob.cn 承载，前端页面为 SPA；
 * 页面自身公开调用同源 JSON 接口（POST 表单），匿名可用、无 Cookie / Token / 签名：
 * - 列表 POST /wecruit/positionInfo/listPosition/<站点ID>，表单 isFrompb=true&recruitType=2&pageSize=&currentPage=
 * - 详情 POST /wecruit/positionInfo/listPositionDetail/<站点ID>，表单 postId=
 * 列表只有标题/地点/学历/发布时间，职责与要求需逐条取详情；详情页
 * https://career.honor.com/<站点ID>/pb/posDetail.html?postId= 公开可访问，作为 official_url。
 *
 * 2026-11-21 真实试抓：3 页列表 + 2 条详情均 HTTP 200，未触发 403/405/429/验证码；
 * 同域请求间隔 >= 1s，单次最多 3 页。站点分页存在排序抖动（置顶职位跨页重复），按 postId 去重。
 */
export const HONOR_COLLECTOR_VERSION = "collector/0.1.0";
/** 荣耀在北森社招站点中的公开站点 ID（取自公开页面路径 /SU5ff669649b0d78e6f4296c9a/pb/social.html）。 */
export const HONOR_SITE_ID = "SU5ff669649b0d78e6f4296c9a";
export const HONOR_LIST_URL = `https://career.honor.com/wecruit/positionInfo/listPosition/${HONOR_SITE_ID}`;
export const HONOR_DETAIL_URL = `https://career.honor.com/wecruit/positionInfo/listPositionDetail/${HONOR_SITE_ID}`;
export const HONOR_DETAIL_PAGE_URL = `https://career.honor.com/${HONOR_SITE_ID}/pb/posDetail.html`;
const SOURCE_KEY = "honor-official-careers";
const PAGE_SIZE = 12;
const MAX_PAGE_LIMIT = 3;
const PAGE_TIMEOUT_MS = 20_000;
const MIN_INTERVAL_MS = 1_000;
const CN_DATE_TIME_PATTERN = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{1,2}):(\d{1,2}))?$/;
const LOCATION_SEPARATOR_PATTERN = /[、,，/;；]/;

/**
 * 来源定义。目录约定由 lead 在 sources.ts 登记同一条目；
 * 登记前本常量保证适配器可独立构造和离线回放，登记后以 CAREER_SOURCE_DEFINITIONS 为准。
 */
export const HONOR_SOURCE_DEFINITION: CareerSourceDefinition = {
  source_key: SOURCE_KEY,
  label: "荣耀官方招聘",
  kind: "company_careers",
  entry_url: "https://career.honor.com/",
  access: "http",
  enabled: true,
  notes:
    "2026-11-21 实测：官网由北森社招托管，页面公开调用同源 JSON（POST 表单，无 Cookie/Token/签名）：列表 /wecruit/positionInfo/listPosition/SU5ff669649b0d78e6f4296c9a（isFrompb=true&recruitType=2&pageSize=12&currentPage=N），详情 /wecruit/positionInfo/listPositionDetail/SU5ff...（postId=）。列表含标题/地点/学历/发布时间，职责与要求需逐条取详情；详情页 /SU5ff.../pb/posDetail.html?postId= 公开。已存 3 份列表 + 2 份详情真实样本。站内分页有置顶职位跨页重复，适配器按 postId 去重。",
};

export interface HonorJobSummary {
  readonly postId: string;
  readonly title: string;
  readonly locations: readonly string[];
  readonly degreeRaw: string | null;
  readonly experienceRaw: string | null;
  readonly publishedAtRaw: string | null;
  readonly postTypeName: string | null;
  readonly company: string | null;
  readonly workType: string | null;
  readonly externalKey: string | null;
  readonly raw: Record<string, unknown>;
}

export interface HonorJobDetail extends HonorJobSummary {
  readonly duty: string | null;
  readonly requirement: string | null;
  readonly detailRaw: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/** 列表 workPlaceStr 用顿号/斜杠等分隔多个城市（如「北京市、上海市、西安市」），拆开去重。 */
export function normalizeHonorLocations(value: string | null): string[] {
  if (value === null) {
    return [];
  }
  const seen = new Set<string>();
  for (const part of value.split(LOCATION_SEPARATOR_PATTERN)) {
    const name = part.trim();
    if (name.length > 0) {
      seen.add(name);
    }
  }
  return [...seen];
}

/**
 * hotjob 的 publishDate 不带时区（站点按北京时间展示），按 +08:00 读成 UTC ISO；
 * 无法解析保持 null。
 */
export function parseHonorPublishedAt(raw: string | null): string | null {
  if (raw === null) {
    return null;
  }
  const match = CN_DATE_TIME_PATTERN.exec(raw.trim());
  if (match === null) {
    return null;
  }
  const year = match[1];
  const month = match[2];
  const day = match[3];
  if (year === undefined || month === undefined || day === undefined) {
    return null;
  }
  const hour = (match[4] ?? "0").padStart(2, "0");
  const minute = (match[5] ?? "0").padStart(2, "0");
  const second = (match[6] ?? "0").padStart(2, "0");
  const base = beijingAt(
    `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`,
    `${hour}:${minute}`,
  );
  const date = new Date(base.getTime() + Number(second) * 1000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function assertState(parsed: Record<string, unknown>, label: string): void {
  const state = parsed["state"];
  if (String(state) !== "200") {
    throw new SchemaChangedError(
      `荣耀${label}响应状态异常：state=${state === undefined ? "null" : String(state)}`,
      SOURCE_KEY,
    );
  }
}

function toSummary(item: Record<string, unknown>): HonorJobSummary {
  const postId = text(item["postId"]);
  const title = text(item["postName"]);
  if (postId === null || title === null) {
    throw new ParseFailedError("荣耀列表条目缺少 postId / postName", SOURCE_KEY);
  }
  return {
    postId,
    title,
    locations: normalizeHonorLocations(text(item["workPlaceStr"])),
    degreeRaw: text(item["educationStr"]),
    experienceRaw: text(item["workYears"]),
    publishedAtRaw: text(item["publishDate"]),
    postTypeName: text(item["postTypeName"]),
    company: text(item["company"]),
    workType: text(item["workTypeStr"]),
    externalKey: text(item["externalKey"]),
    raw: item,
  };
}

export function parseHonorList(body: Buffer | string): HonorJobSummary[] {
  const parsed: unknown = typeof body === "string" ? JSON.parse(body) : JSON.parse(body.toString("utf8"));
  if (!isRecord(parsed)) {
    throw new SchemaChangedError("荣耀列表响应不是对象", SOURCE_KEY);
  }
  assertState(parsed, "列表");
  const data = parsed["data"];
  if (!isRecord(data)) {
    throw new SchemaChangedError("荣耀列表响应缺少 data", SOURCE_KEY);
  }
  const pageForm = data["pageForm"];
  if (!isRecord(pageForm) || !Array.isArray(pageForm["pageData"])) {
    throw new SchemaChangedError("荣耀列表响应缺少 data.pageForm.pageData", SOURCE_KEY);
  }
  return (pageForm["pageData"] as unknown[]).map((item) => {
    if (!isRecord(item)) {
      throw new ParseFailedError("荣耀列表条目不是对象", SOURCE_KEY);
    }
    return toSummary(item);
  });
}

export function parseHonorDetail(body: Buffer | string, summary: HonorJobSummary): HonorJobDetail {
  const parsed: unknown = typeof body === "string" ? JSON.parse(body) : JSON.parse(body.toString("utf8"));
  if (!isRecord(parsed)) {
    throw new SchemaChangedError("荣耀详情响应不是对象", SOURCE_KEY);
  }
  assertState(parsed, "详情");
  const data = parsed["data"];
  if (!isRecord(data)) {
    throw new SchemaChangedError("荣耀详情响应缺少 data", SOURCE_KEY);
  }
  const postId = text(data["postId"]) ?? summary.postId;
  const title = text(data["postName"]) ?? summary.title;
  const detailLocations = normalizeHonorLocations(text(data["workPlaceStr"]));
  return {
    postId,
    title,
    locations: detailLocations.length > 0 ? detailLocations : summary.locations,
    degreeRaw: text(data["education"]) ?? summary.degreeRaw,
    experienceRaw: summary.experienceRaw,
    publishedAtRaw: text(data["publishDate"]) ?? summary.publishedAtRaw,
    postTypeName: text(data["postTypeName"]) ?? summary.postTypeName,
    company: text(data["company"]) ?? text(data["orgName"]) ?? summary.company,
    workType: text(data["workTypeStr"]) ?? summary.workType,
    externalKey: text(data["externalPostId"]) ?? summary.externalKey,
    raw: summary.raw,
    duty: text(data["workContent"]),
    requirement: text(data["serviceCondition"]),
    detailRaw: data,
  };
}

export function honorDetailPageUrl(postId: string): string {
  return `${HONOR_DETAIL_PAGE_URL}?postId=${encodeURIComponent(postId)}`;
}

export function toHonorRawJob(detail: HonorJobDetail, fetchedAt: string): RawCollectedJobV1 {
  const sections = [detail.duty, detail.requirement].filter(
    (section): section is string => section !== null,
  );
  if (sections.length === 0) {
    throw new ParseFailedError(`荣耀职位 ${detail.postId} 缺少职责与要求正文`, SOURCE_KEY);
  }

  return {
    schema_version: "1.0",
    source_key: SOURCE_KEY,
    source_job_id: detail.postId,
    company_name: "荣耀",
    title: detail.title,
    official_url: honorDetailPageUrl(detail.postId),
    // 采集层同时保留列表摘要与详情原文，便于回放与字段溯源。
    raw_text: sections.join("\n\n"),
    raw_payload: { list: detail.raw, detail: detail.detailRaw },
    published_at: parseHonorPublishedAt(detail.publishedAtRaw),
    fetched_at: fetchedAt,
    collector_version: HONOR_COLLECTOR_VERSION,
    hints: {
      role_family: "unknown",
      locations: [...detail.locations],
      degree_raw: detail.degreeRaw,
      experience_raw: detail.experienceRaw,
      employment_type: "unknown",
      skill_terms: [],
    },
  };
}

export interface HonorAdapterOptions {
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
    url: HONOR_LIST_URL,
    sourceKey,
    pageTimeoutMs: PAGE_TIMEOUT_MS,
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json, text/plain, */*",
      origin: "https://career.honor.com",
      referer: `https://career.honor.com/${HONOR_SITE_ID}/pb/social.html`,
    },
    body: `isFrompb=true&recruitType=2&pageSize=${PAGE_SIZE}&currentPage=${page}`,
    ...(signal === undefined ? {} : { signal }),
  });
}

function buildDetailRequest(postId: string, sourceKey: string, signal: AbortSignal | undefined): PageRequest {
  return createPageRequest({
    url: HONOR_DETAIL_URL,
    sourceKey,
    pageTimeoutMs: PAGE_TIMEOUT_MS,
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json, text/plain, */*",
      origin: "https://career.honor.com",
      referer: `https://career.honor.com/${HONOR_SITE_ID}/pb/social.html`,
    },
    body: `postId=${encodeURIComponent(postId)}`,
    ...(signal === undefined ? {} : { signal }),
  });
}

export function createHonorOfficialCareersAdapter(
  transport: FetchTransport,
  options: HonorAdapterOptions = {},
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
      const seen = new Set<string>();
      let requestCount = 0;
      for (let page = 1; page <= pageLimit; page += 1) {
        if (isAborted(signal)) {
          throw new DOMException("采集被取消", "AbortError");
        }
        if (requestCount > 0) {
          await sleep(MIN_INTERVAL_MS);
        }
        requestCount += 1;
        const listResponse = await transport.fetchPage(
          buildListRequest(page, definition.source_key, signal),
        );
        const summaries = parseHonorList(listResponse.body);
        for (const summary of summaries) {
          if (seen.has(summary.postId)) {
            continue;
          }
          seen.add(summary.postId);
          if (isAborted(signal)) {
            throw new DOMException("采集被取消", "AbortError");
          }
          if (requestCount > 0) {
            await sleep(MIN_INTERVAL_MS);
          }
          requestCount += 1;
          const detailResponse = await transport.fetchPage(
            buildDetailRequest(summary.postId, definition.source_key, signal),
          );
          jobs.push(toHonorRawJob(parseHonorDetail(detailResponse.body, summary), now()));
        }
      }
      return jobs;
    },
  };
}
