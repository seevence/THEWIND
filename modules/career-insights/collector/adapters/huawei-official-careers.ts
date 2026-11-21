import type { RawCollectedJobV1 } from "../../contracts/index.ts";
import type { CareerCollectOptions, CareerSourceAdapter, CareerSourceDefinition } from "../index.ts";
import { CAREER_SOURCE_DEFINITIONS } from "../sources.ts";
import { ParseFailedError, SchemaChangedError } from "../fetch/errors.ts";
import { createPageRequest } from "../fetch/transport.ts";
import type { FetchTransport, PageRequest } from "../fetch/transport.ts";

export const HUAWEI_COLLECTOR_VERSION = "collector/0.1.0";
export const HUAWEI_LIST_URL =
  "https://apigw-dgg-b0.huawei.com/api/apig/channelhw/recruitmentPosition/pub/getJobPage";
export const HUAWEI_DETAIL_URL_PREFIX = "https://career.huawei.com/cn/job-details?advertisementId=";
const SOURCE_KEY = "huawei-official-careers";
/** 华为招聘前台 common.min.js 里公开的 appId，接口以 X-HW-ID 查询参数要求携带；不是登录凭证。 */
const HUAWEI_APP_ID = "app_000000035886";
const PAGE_TIMEOUT_MS = 20_000;
const MIN_INTERVAL_MS = 1_000;
/** 单次采集最多 3 页：华为在招社招职位约 600 条，取前 3 页已覆盖最新列表。 */
const MAX_PAGE_LIMIT = 3;
const PAGE_SIZE = 20;

/**
 * 适配器定义。目录约定由 lead 在 sources.ts 登记同一条目；
 * 登记前本常量保证适配器可独立构造和离线回放，登记后以 CAREER_SOURCE_DEFINITIONS 为准。
 */
export const HUAWEI_SOURCE_DEFINITION: CareerSourceDefinition = {
  source_key: SOURCE_KEY,
  label: "华为官方招聘",
  kind: "company_careers",
  entry_url: "https://career.huawei.com/cn/social-recruitment-job-list",
  access: "http",
  enabled: true,
  notes:
    "2026-11-21 实测：官网 job-list 组件公开调用 POST /recruitmentPosition/pub/getJobPage（apigw-dgg-b0.huawei.com/api/apig/channelhw，X-HW-ID 为前台公开 appId），匿名无 Cookie/无签名；jobType=SR 社招 603 条（不带 jobType 为 712 条含校招），列表即含 mainBusiness/jobRequire，可省详情请求；详情页 /cn/job-details?advertisementId=<id> 公开可访问。校招 jobType=CR 仅返回 14 字占位正文，未纳入。已存 3 页真实样本。注意：安全类岗位原文含“安全验证”字样，会被共享 fetch/block-detector 的 CAPTCHA 标记误判为 access_blocked，live 前需共享层对 JSON 响应跳过正文标记扫描。",
};

export interface HuaweiJobSummary {
  readonly jobId: string;
  readonly advertisementId: string;
  readonly title: string;
  readonly locations: readonly string[];
  readonly jobFamilyName: string | null;
  readonly jobClass: string | null;
  readonly workYear: string | null;
  readonly degree: string | null;
  readonly lastUpdateDate: string | null;
  readonly mainBusiness: string | null;
  readonly jobRequire: string | null;
  readonly deptName: string | null;
  readonly raw: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/** 官方列表把主键以 JSON number 返回，这里原样转十进制字符串，不改变数值。 */
function numericId(value: unknown): string | null {
  if (typeof value === "number" && Number.isSafeInteger(value)) {
    return String(value);
  }
  return text(value);
}

export function normalizeHuaweiLocations(value: string | null): string[] {
  if (value === null) {
    return [];
  }
  const seen = new Set<string>();
  for (const part of value.split(/[/、,，;；]/)) {
    const name = part.trim();
    if (name.length > 0) {
      seen.add(name);
    }
  }
  return [...seen];
}

export function parseHuaweiPublishedAt(raw: string | null): string | null {
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

export function parseHuaweiList(body: Buffer | string): HuaweiJobSummary[] {
  const parsed: unknown = typeof body === "string" ? JSON.parse(body) : JSON.parse(body.toString("utf8"));
  if (!isRecord(parsed)) {
    throw new SchemaChangedError("华为列表响应不是对象", SOURCE_KEY);
  }
  const status = text(parsed["status"]);
  if (status !== "SUCCESS") {
    throw new SchemaChangedError(`华为列表响应状态异常：status=${status ?? "null"}`, SOURCE_KEY);
  }
  const data = parsed["data"];
  if (!isRecord(data) || !Array.isArray(data["result"])) {
    throw new SchemaChangedError("华为列表响应缺少 data.result", SOURCE_KEY);
  }
  return (data["result"] as unknown[]).map((item) => {
    if (!isRecord(item)) {
      throw new ParseFailedError("华为列表条目不是对象", SOURCE_KEY);
    }
    const jobId = numericId(item["jobId"]);
    const advertisementId = numericId(item["advertisementId"]);
    const title = text(item["jobName"]);
    if (jobId === null || advertisementId === null || title === null) {
      throw new ParseFailedError("华为列表条目缺少 jobId / advertisementId / jobName", SOURCE_KEY);
    }
    return {
      jobId,
      advertisementId,
      title,
      locations: normalizeHuaweiLocations(text(item["workPlace"])),
      jobFamilyName: text(item["jobFamilyName"]),
      jobClass: text(item["jobClass"]),
      workYear: text(item["workYear"]),
      degree: text(item["degree"]),
      lastUpdateDate: text(item["lastUpdateDate"]),
      mainBusiness: text(item["mainBusiness"]),
      jobRequire: text(item["jobRequire"]),
      deptName: text(item["deptName"]),
      raw: item,
    };
  });
}

export function toHuaweiRawJob(item: HuaweiJobSummary, fetchedAt: string): RawCollectedJobV1 {
  const sections = [item.mainBusiness, item.jobRequire].filter(
    (section): section is string => section !== null,
  );
  if (sections.length === 0) {
    throw new ParseFailedError(`华为职位 ${item.jobId} 缺少职责与要求正文`, SOURCE_KEY);
  }

  return {
    schema_version: "1.0",
    source_key: SOURCE_KEY,
    source_job_id: item.jobId,
    company_name: "华为",
    title: item.title,
    official_url: `${HUAWEI_DETAIL_URL_PREFIX}${encodeURIComponent(item.advertisementId)}`,
    raw_text: sections.join("\n\n"),
    raw_payload: item.raw,
    published_at: parseHuaweiPublishedAt(item.lastUpdateDate),
    fetched_at: fetchedAt,
    collector_version: HUAWEI_COLLECTOR_VERSION,
    hints: {
      role_family: "unknown",
      locations: [...item.locations],
      degree_raw: item.degree,
      experience_raw: item.workYear,
      employment_type: "unknown",
      skill_terms: [],
    },
  };
}

export interface HuaweiAdapterOptions {
  readonly pageLimit?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => string;
}

function buildListRequest(page: number, sourceKey: string, signal: AbortSignal | undefined): PageRequest {
  return createPageRequest({
    url: `${HUAWEI_LIST_URL}?X-HW-ID=${HUAWEI_APP_ID}`,
    sourceKey,
    pageTimeoutMs: PAGE_TIMEOUT_MS,
    method: "POST",
    headers: {
      "content-type": "application/json;charset=UTF-8",
      accept: "application/json, text/plain, */*",
      "accept-language": "zh-CN,zh;q=0.9",
      origin: "https://career.huawei.com",
      referer: "https://career.huawei.com/",
      "X-HW-ID": HUAWEI_APP_ID,
      "x-jalor-tenantAlias": "hcm",
      "x-language": "zh_CN",
      "x-Referer": "https://career.huawei.com/cn",
      "x-alb-gray": "prod",
    },
    body: JSON.stringify({ curPage: page, pageSize: PAGE_SIZE, jobType: "SR" }),
    ...(signal === undefined ? {} : { signal }),
  });
}

export function createHuaweiOfficialCareersAdapter(
  transport: FetchTransport,
  options: HuaweiAdapterOptions = {},
): CareerSourceAdapter {
  const definition =
    CAREER_SOURCE_DEFINITIONS.find((item) => item.source_key === SOURCE_KEY) ?? HUAWEI_SOURCE_DEFINITION;
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
        if (page > 1) {
          await sleep(MIN_INTERVAL_MS);
        }
        const listResponse = await transport.fetchPage(
          buildListRequest(page, definition.source_key, signal),
        );
        const summaries = parseHuaweiList(listResponse.body);
        for (const summary of summaries) {
          jobs.push(toHuaweiRawJob(summary, now()));
        }
      }
      return jobs;
    },
  };
}
