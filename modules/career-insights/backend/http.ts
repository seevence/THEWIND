import { createHash } from "node:crypto";
import { beijingDate, isValidDate } from "@aihot/contracts/time";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ApiErrorResponseV1, JobFiltersV1 } from "../contracts/api.ts";
import type { EmploymentType, RoleFamily, StudentFriendly } from "../contracts/index.ts";
import { CAREER_SOURCE_DEFINITIONS } from "../collector/sources.ts";
import { THEME_KEYWORDS } from "../data/dictionaries.ts";
import { CareerApiError, InvalidParameterError, NotFoundError } from "./errors.ts";
import {
  DEFAULT_HOT_LIMIT,
  DEFAULT_HOT_WINDOW_DAYS,
  MAX_HOT_LIMIT,
  MAX_HOT_WINDOW_DAYS,
  type HotCompanyOptions,
} from "./career-analytics.ts";
import {
  DEFAULT_SIGNAL_LIMIT,
  DEFAULT_SIGNAL_WINDOW_DAYS,
  MAX_SIGNAL_LIMIT,
  MAX_SIGNAL_WINDOW_DAYS,
  type CareerSignalsOptions,
} from "./career-signals.ts";
import {
  DEFAULT_CATALOG_LIMIT,
  DEFAULT_CATALOG_WINDOW_DAYS,
  MAX_CATALOG_LIMIT,
  MAX_CATALOG_WINDOW_DAYS,
  type CareerCatalogOptions,
} from "./career-catalog.ts";
import { DEFAULT_PAGE_SIZE, MAX_PAGE, MAX_PAGE_SIZE } from "./limits.ts";
import type { PolicyFiltersV1 } from "./policy-read.ts";
import type { CareerRepository } from "./repository.ts";

const ROLE_FAMILIES = ["ai_algorithm", "ai_application_development", "data", "ai_product_operations", "unknown"] as const;
const EMPLOYMENT_TYPES = ["campus", "internship", "experienced", "other", "unknown"] as const;
const STUDENT_FRIENDLY_VALUES = ["yes", "no", "unknown"] as const;
const FILTER_KEYS = new Set(["role_family", "company", "city", "employment_type", "student_friendly", "skill", "q", "page", "page_size"]);
/** 岗位关键词的上限：前端输入框同样限制 100，超过按参数错误返回 400，不静默截断。 */
const MAX_JOB_QUERY_LENGTH = 100;
const POLICY_FILTER_KEYS = new Set(["source_key", "theme", "page", "page_size"]);
const HOT_FILTER_KEYS = new Set(["limit", "window_days"]);
const SIGNAL_FILTER_KEYS = new Set(["limit", "window_days"]);
const CATALOG_FILTER_KEYS = new Set(["limit", "window_days"]);
const DAILY_COMMENT_FILTER_KEYS = new Set(["date"]);
const JOB_AVAILABILITY_FILTER_KEYS = new Set(["ids"]);
/**
 * 后端一次接受去重后最多 200 个 id，与岗位收藏上限（STARRED_JOBS_LIMIT=200）一致。
 * 前端按 100 个一批发送：UUID 比文章 id 长，200 个的 query 约 7.8k 字符，贴近反向代理常见的 8K 请求行上限。
 * 文章侧后端一次接受 500 个、前端同样拆成 100/批，两边的上限数字因此不同。
 */
const JOB_AVAILABILITY_MAX_IDS = 200;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function invalidParameter(parameter: string, message: string): InvalidParameterError {
  return new InvalidParameterError(message, { parameter });
}

function queryRecord(query: unknown): Record<string, unknown> {
  if (query === undefined) return {};
  if (query === null || typeof query !== "object" || Array.isArray(query)) {
    throw new InvalidParameterError("Query parameters must be a flat object.");
  }
  return query as Record<string, unknown>;
}

function assertNoQuery(query: unknown): void {
  const input = queryRecord(query);
  const key = Object.keys(input)[0];
  if (key !== undefined) throw invalidParameter(key, `Unsupported query parameter: ${key}.`);
}

function optionalEnum<T extends string>(input: Record<string, unknown>, key: string, allowed: readonly T[]): T | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw invalidParameter(key, `Invalid value for query parameter: ${key}.`);
  }
  return value as T;
}

function optionalText(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "") {
    throw invalidParameter(key, `Query parameter must be a non-empty string: ${key}.`);
  }
  return value.trim();
}

/**
 * 关键词参数：trim 后为空视为没传（后端不按空白过滤）；非字符串（如重复参数 fastify 给的数组）或超长都 400。
 */
function optionalKeyword(input: Record<string, unknown>, key: string, maxLength: number): string | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw invalidParameter(key, `Query parameter must be a single string: ${key}.`);
  const keyword = value.trim();
  if (keyword === "") return undefined;
  if (keyword.length > maxLength) throw invalidParameter(key, `Query parameter must be at most ${maxLength} characters: ${key}.`);
  return keyword;
}

function pageNumber(input: Record<string, unknown>, key: string, fallback: number, maximum?: number): number {
  const raw = input[key];
  if (raw === undefined) return fallback;
  if (typeof raw !== "string" || !/^[1-9][0-9]*$/.test(raw)) {
    throw invalidParameter(key, `Query parameter must be a positive integer: ${key}.`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || (maximum !== undefined && value > maximum)) {
    throw invalidParameter(key, maximum === undefined ? `Query parameter is too large: ${key}.` : `Query parameter must be between 1 and ${maximum}: ${key}.`);
  }
  return value;
}

function parseJobFilters(query: unknown): JobFiltersV1 {
  const input = queryRecord(query);
  const unsupported = Object.keys(input).find((key) => !FILTER_KEYS.has(key));
  if (unsupported !== undefined) throw invalidParameter(unsupported, `Unsupported query parameter: ${unsupported}.`);

  const roleFamily = optionalEnum<RoleFamily>(input, "role_family", ROLE_FAMILIES);
  const employmentType = optionalEnum<EmploymentType>(input, "employment_type", EMPLOYMENT_TYPES);
  const studentFriendly = optionalEnum<StudentFriendly>(input, "student_friendly", STUDENT_FRIENDLY_VALUES);
  const company = optionalText(input, "company");
  const city = optionalText(input, "city");
  const skill = optionalText(input, "skill");
  const keyword = optionalKeyword(input, "q", MAX_JOB_QUERY_LENGTH);

  return {
    ...(roleFamily === undefined ? {} : { role_family: roleFamily }),
    ...(company === undefined ? {} : { company }),
    ...(city === undefined ? {} : { city }),
    ...(employmentType === undefined ? {} : { employment_type: employmentType }),
    ...(studentFriendly === undefined ? {} : { student_friendly: studentFriendly }),
    ...(skill === undefined ? {} : { skill }),
    ...(keyword === undefined ? {} : { q: keyword }),
    page: pageNumber(input, "page", 1, MAX_PAGE),
    page_size: pageNumber(input, "page_size", DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE),
  };
}

function parsePolicyFilters(query: unknown): PolicyFiltersV1 {
  const input = queryRecord(query);
  const unsupported = Object.keys(input).find((key) => !POLICY_FILTER_KEYS.has(key));
  if (unsupported !== undefined) throw invalidParameter(unsupported, `Unsupported query parameter: ${unsupported}.`);

  const sourceKey = optionalText(input, "source_key");
  if (sourceKey !== undefined && !CAREER_SOURCE_DEFINITIONS.some((definition) => definition.source_key === sourceKey)) {
    throw invalidParameter("source_key", `Unknown source: ${sourceKey}.`);
  }
  const theme = optionalText(input, "theme");
  if (theme !== undefined && !Object.hasOwn(THEME_KEYWORDS, theme)) {
    throw invalidParameter("theme", `Unknown theme: ${theme}.`);
  }

  return {
    ...(sourceKey === undefined ? {} : { source_key: sourceKey }),
    ...(theme === undefined ? {} : { theme }),
    page: pageNumber(input, "page", 1, MAX_PAGE),
    page_size: pageNumber(input, "page_size", DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE),
  };
}

function parseHotOptions(query: unknown): HotCompanyOptions {
  const input = queryRecord(query);
  const unsupported = Object.keys(input).find((key) => !HOT_FILTER_KEYS.has(key));
  if (unsupported !== undefined) throw invalidParameter(unsupported, `Unsupported query parameter: ${unsupported}.`);

  return {
    limit: pageNumber(input, "limit", DEFAULT_HOT_LIMIT, MAX_HOT_LIMIT),
    window_days: pageNumber(input, "window_days", DEFAULT_HOT_WINDOW_DAYS, MAX_HOT_WINDOW_DAYS),
  };
}

function parseSignalOptions(query: unknown): CareerSignalsOptions {
  const input = queryRecord(query);
  const unsupported = Object.keys(input).find((key) => !SIGNAL_FILTER_KEYS.has(key));
  if (unsupported !== undefined) throw invalidParameter(unsupported, `Unsupported query parameter: ${unsupported}.`);

  return {
    limit: pageNumber(input, "limit", DEFAULT_SIGNAL_LIMIT, MAX_SIGNAL_LIMIT),
    window_days: pageNumber(input, "window_days", DEFAULT_SIGNAL_WINDOW_DAYS, MAX_SIGNAL_WINDOW_DAYS),
  };
}

function parseCatalogOptions(query: unknown): CareerCatalogOptions {
  const input = queryRecord(query);
  const unsupported = Object.keys(input).find((key) => !CATALOG_FILTER_KEYS.has(key));
  if (unsupported !== undefined) throw invalidParameter(unsupported, `Unsupported query parameter: ${unsupported}.`);

  return {
    limit: pageNumber(input, "limit", DEFAULT_CATALOG_LIMIT, MAX_CATALOG_LIMIT),
    window_days: pageNumber(input, "window_days", DEFAULT_CATALOG_WINDOW_DAYS, MAX_CATALOG_WINDOW_DAYS),
  };
}

/**
 * /jobs/availability 的 ids：逗号分隔的 UUID，去重后最多 200 个。
 * 空列表、空片段、非 UUID 或超限都按参数错误返回 400，而不是把坏 id 当 missing 静默吞掉。
 */
function parseJobAvailabilityIds(query: unknown): string[] {
  const input = queryRecord(query);
  const unsupported = Object.keys(input).find((key) => !JOB_AVAILABILITY_FILTER_KEYS.has(key));
  if (unsupported !== undefined) throw invalidParameter(unsupported, `Unsupported query parameter: ${unsupported}.`);

  const raw = input.ids;
  if (typeof raw !== "string" || raw.trim() === "") {
    throw invalidParameter("ids", "Query parameter must be a comma-separated list of job ids: ids.");
  }

  const ids: string[] = [];
  const seen = new Set<string>();
  for (const part of raw.split(",")) {
    // UUID 不区分大小写；响应键统一为小写，和 career_jobs.id 的文本形式一致。
    const id = part.trim().toLowerCase();
    if (!UUID_PATTERN.test(id)) throw invalidParameter("ids", "Every job id must be a UUID: ids.");
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  if (ids.length > JOB_AVAILABILITY_MAX_IDS) {
    throw invalidParameter("ids", `At most ${JOB_AVAILABILITY_MAX_IDS} job ids are allowed: ids.`);
  }
  return ids;
}

/** /daily-comment 的 date 缺省为今天（Asia/Shanghai）；页面读的是后台预生成的缓存，这里只选日期。 */
function parseDailyCommentDate(query: unknown): string {
  const input = queryRecord(query);
  const unsupported = Object.keys(input).find((key) => !DAILY_COMMENT_FILTER_KEYS.has(key));
  if (unsupported !== undefined) throw invalidParameter(unsupported, `Unsupported query parameter: ${unsupported}.`);
  const raw = input.date;
  if (raw === undefined) return beijingDate(new Date());
  if (typeof raw !== "string" || !isValidDate(raw)) {
    throw invalidParameter("date", "Query parameter must be a calendar date (YYYY-MM-DD): date.");
  }
  return raw;
}

/** 公开只读内容的 Cache-Control：60 秒内可直接复用，过期后 5 分钟内先返回旧值再后台复核。 */
export const PUBLIC_CACHE_CONTROL = "public, max-age=60, stale-while-revalidate=300";

/** 弱 ETag：内容哈希的前 16 位，只在内容变化时改变。 */
export function weakEtag(prefix: string, body: string): string {
  return `W/"${prefix}-${createHash("sha256").update(body).digest("hex").slice(0, 16)}"`;
}

/** If-None-Match 是否命中（弱比较：W/ 前缀不算差异）。 */
export function etagMatches(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  const strip = (value: string) => value.trim().replace(/^W\//, "");
  return header.split(",").some((value) => value.trim() === "*" || strip(value) === strip(etag));
}

/** 公开 JSON：带弱 ETag 与 public 缓存；If-None-Match 命中时回 304，没有正文。 */
export function sendJsonWithEtag(
  request: FastifyRequest,
  reply: FastifyReply,
  body: unknown,
  etagPrefix: string,
  cacheControl: string,
): FastifyReply {
  const text = JSON.stringify(body);
  const etag = weakEtag(etagPrefix, text);
  reply.header("ETag", etag).header("Cache-Control", cacheControl).header("Vary", "Accept-Encoding");
  if (etagMatches(request.headers["if-none-match"], etag)) return reply.code(304).send();
  return reply.header("Content-Type", "application/json; charset=utf-8").send(text);
}

/** 公开错误体：模块自己的 ApiErrorResponseV1，未知错误不外泄内部信息。 */
function sendError(reply: FastifyReply, error: unknown): FastifyReply {
  const apiError = error instanceof CareerApiError
    ? error
    : new CareerApiError(500, "internal_error", "Internal server error.");
  const body: ApiErrorResponseV1 = {
    error: {
      code: apiError.code,
      message: apiError.message,
      ...(apiError.details === undefined ? {} : { details: apiError.details }),
    },
  };
  return reply.code(apiError.statusCode).send(body);
}

/** 不做缓存的只读回答（收藏探测）：错误也保持 no-store。 */
async function respond(reply: FastifyReply, read: () => Promise<unknown>): Promise<FastifyReply> {
  reply.header("Cache-Control", "no-store");
  try {
    return reply.send(await read());
  } catch (error) {
    return sendError(reply, error);
  }
}

/**
 * 公开只读回答：成功响应带 public 缓存与弱 ETag，If-None-Match 命中回 304；
 * 研判/日报评论缓存未生成时仍回 204 + no-store，错误同样 no-store。
 */
async function respondPublic(
  request: FastifyRequest,
  reply: FastifyReply,
  etagPrefix: string,
  read: () => Promise<unknown>,
): Promise<FastifyReply> {
  reply.header("Cache-Control", "no-store");
  try {
    const value = await read();
    if (value === null) return reply.code(204).send();
    return sendJsonWithEtag(request, reply, value, etagPrefix, PUBLIC_CACHE_CONTROL);
  } catch (error) {
    return sendError(reply, error);
  }
}

export function registerCareerHttp(app: FastifyInstance, repository: CareerRepository): void {
  app.get("/api/site/career-insights/summary", async (request, reply) => respondPublic(request, reply, "career-summary", async () => {
    assertNoQuery(request.query);
    return repository.summary();
  }));

  app.get("/api/site/career-insights/jobs", async (request, reply) => respondPublic(request, reply, "career-jobs", async () => {
    return repository.listJobs(parseJobFilters(request.query));
  }));

  // 收藏页在浏览器本地保存岗位快照，用这个只读接口判断哪些岗位的详情页现在还在；
  // 静态段 /availability 优先于下面的 :id，不会被当成岗位 id。
  app.get("/api/site/career-insights/jobs/availability", async (request, reply) => respond(reply, async () => {
    return repository.jobAvailability(parseJobAvailabilityIds(request.query));
  }));

  app.get<{ Params: { id: string } }>("/api/site/career-insights/jobs/:id", async (request, reply) => respondPublic(request, reply, "career-job", async () => {
    assertNoQuery(request.query);
    if (!UUID_PATTERN.test(request.params.id)) throw invalidParameter("id", "Job id must be a UUID.");
    const detail = await repository.jobDetail(request.params.id);
    if (detail === null) throw new NotFoundError();
    return detail;
  }));

  app.get("/api/site/career-insights/policies", async (request, reply) => respondPublic(request, reply, "career-policies", async () => {
    return repository.listPolicies(parsePolicyFilters(request.query));
  }));

  app.get("/api/site/career-insights/hot", async (request, reply) => respondPublic(request, reply, "career-hot", async () => {
    return repository.hotCompanies(parseHotOptions(request.query));
  }));

  app.get("/api/site/career-insights/daily", async (request, reply) => respondPublic(request, reply, "career-daily", async () => {
    assertNoQuery(request.query);
    return repository.dailySummary();
  }));

  app.get("/api/site/career-insights/daily-comment", async (request, reply) => respondPublic(request, reply, "career-daily-comment", async () => {
    return repository.careerDailyComment(parseDailyCommentDate(request.query));
  }));

  app.get("/api/site/career-insights/signals", async (request, reply) => respondPublic(request, reply, "career-signals", async () => {
    return repository.careerSignals(parseSignalOptions(request.query));
  }));

  app.get("/api/site/career-insights/catalog", async (request, reply) => respondPublic(request, reply, "career-catalog", async () => {
    return repository.careerCatalog(parseCatalogOptions(request.query));
  }));

  app.get("/api/site/career-insights/brief", async (request, reply) => respondPublic(request, reply, "career-brief", async () => {
    assertNoQuery(request.query);
    return repository.careerBrief();
  }));
}