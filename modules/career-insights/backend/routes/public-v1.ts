// 公开岗位/政策 API v1（/api/v1/career）：匿名只读，字段是站点已有的公开投影再裁一层 ——
// 岗位详情不带内部来源键（source_key / job_key）与观测表的自增 id，也不返回 raw_text / raw_payload。
// 读取复用 CareerRepository（公开读取层），这里只做参数、字段裁剪、错误映射和缓存头。
// 路由由 server.ts 接线（本文件不 import 模块入口，也不改引擎的 v1 路由）。
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { PUBLIC_API_CORS } from "@aihot/contracts/http-policy";
import type {
  ApiErrorResponseV1,
  JobDetailResponseV1,
  JobFiltersV1,
  JobListResponseV1,
} from "../../contracts/api.ts";
import type {
  DataOrigin,
  DegreeLevel,
  EmploymentType,
  PolicyEvidenceRefV1,
  RoleFamily,
  StudentFriendly,
} from "../../contracts/index.ts";
import { CareerApiError, InvalidParameterError, NotFoundError } from "../errors.ts";
import { PUBLIC_CACHE_CONTROL, sendJsonWithEtag } from "../http.ts";
import { DEFAULT_PAGE_SIZE, MAX_PAGE, MAX_PAGE_SIZE } from "../limits.ts";
import type { PolicyFacetsV1, PolicyFiltersV1, PolicyListResponseV1 } from "../policy-read.ts";
import type { CareerRepository } from "../repository.ts";

const ROLE_FAMILIES = ["ai_algorithm", "ai_application_development", "data", "ai_product_operations", "unknown"] as const;
const STUDENT_FRIENDLY_VALUES = ["yes", "no", "unknown"] as const;
/** 与站点岗位搜索一致：关键词 trim 后最长 100 字符，超过按参数错误返回 400，不静默截断。 */
const MAX_JOB_QUERY_LENGTH = 100;
const JOB_QUERY_KEYS = ["q", "role_family", "city", "student_friendly", "skill", "page", "page_size"] as const;
const POLICY_QUERY_KEYS = ["page", "page_size"] as const;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 岗位列表项：公开身份（URL 里的岗位 id）与页面展示字段，不含来源、内部键与原始正文。 */
export interface CareerJobPublicV1 {
  id: string;
  company_name: string;
  title: string;
  role_family: RoleFamily;
  locations: string[];
  employment_type: EmploymentType;
  student_friendly: StudentFriendly;
  skills: string[];
  published_at: string | null;
  first_seen_at: string;
  last_seen_at: string;
  official_url: string;
}

export interface CareerSkillEvidencePublicV1 {
  skill_id: string;
  evidence_text: string;
}

/** 岗位详情：在列表项上补要求字段；source_key / job_key / collector_version 是内部对账信息，不公开。 */
export interface CareerJobDetailPublicV1 extends CareerJobPublicV1 {
  degree: DegreeLevel;
  degree_raw: string | null;
  experience_min_years: number | null;
  experience_max_years: number | null;
  experience_raw: string | null;
  skill_evidence: CareerSkillEvidencePublicV1[];
}

/** 观测公开字段：只留能回原文核对的时间、URL 与摘录，不含观测表的自增 id 与内容哈希。 */
export interface CareerObservationPublicV1 {
  observed_at: string;
  source_url: string;
  evidence_excerpt: string;
}

export interface CareerJobListResponsePublicV1 {
  contract_version: "0.1";
  data_origin: DataOrigin;
  items: CareerJobPublicV1[];
  page: number;
  page_size: number;
  total: number;
  as_of: string;
  filters: JobFiltersV1;
}

export interface CareerJobDetailResponsePublicV1 {
  contract_version: "0.1";
  data_origin: DataOrigin;
  job: CareerJobDetailPublicV1;
  observations: CareerObservationPublicV1[];
  notice: string;
}

export interface CareerPolicyListResponsePublicV1 {
  contract_version: "0.1";
  data_origin: DataOrigin;
  as_of: string;
  items: PolicyEvidenceRefV1[];
  page: number;
  page_size: number;
  total: number;
  facets: PolicyFacetsV1;
}

/** 公开 API 的依赖注入点：测试可以固定缓存策略；缓存头默认与站点只读内容一致。 */
export interface CareerPublicV1Deps {
  cacheControl?: string;
}

function invalidParameter(parameter: string, message: string): InvalidParameterError {
  return new InvalidParameterError(message, { parameter });
}

/**
 * 公开 API 的严格查询串：只认声明过的参数，重复、NUL 与未知参数一律 400。
 * 读原始 URL 而不是 request.query，重复参数才是「错误」而不是被 Fastify 收成数组。
 */
function strictQuery(request: FastifyRequest, allowed: readonly string[]): Record<string, string> {
  const raw = request.raw.url ?? "";
  const index = raw.indexOf("?");
  const params = new URLSearchParams(index >= 0 ? raw.slice(index + 1) : "");
  const out: Record<string, string> = {};
  for (const [key, value] of params) {
    if (!allowed.includes(key)) throw invalidParameter(key, `Unsupported query parameter: ${key}.`);
    if (key in out) throw invalidParameter(key, `Query parameter must not be repeated: ${key}.`);
    if (value.includes("\0")) throw invalidParameter(key, "Query parameters must not contain NUL.");
    out[key] = value;
  }
  return out;
}

function intParam(input: Record<string, string>, key: string, fallback: number, maximum: number): number {
  const raw = input[key];
  if (raw === undefined) return fallback;
  if (!/^[1-9][0-9]*$/.test(raw)) throw invalidParameter(key, `Query parameter must be a positive integer: ${key}.`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value > maximum) {
    throw invalidParameter(key, `Query parameter must be between 1 and ${maximum}: ${key}.`);
  }
  return value;
}

function enumParam<T extends string>(input: Record<string, string>, key: string, allowed: readonly T[]): T | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (!allowed.includes(value as T)) throw invalidParameter(key, `Invalid value for query parameter: ${key}.`);
  return value as T;
}

/** 文本筛选：trim 后为空视为没传；参数值本身必须是单个字符串。 */
function optionalText(input: Record<string, string>, key: string): string | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  const text = value.trim();
  if (text === "") throw invalidParameter(key, `Query parameter must be a non-empty string: ${key}.`);
  return text;
}

/** 关键词：trim 后为空视为没传（与站点岗位搜索一致）。 */
function optionalKeyword(input: Record<string, string>, key: string): string | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  const keyword = value.trim();
  if (keyword === "") return undefined;
  if ([...keyword].length > MAX_JOB_QUERY_LENGTH) {
    throw invalidParameter(key, `Query parameter must be at most ${MAX_JOB_QUERY_LENGTH} characters: ${key}.`);
  }
  return keyword;
}

/**
 * 公开岗位筛选：q / role_family / city / student_friendly / skill 加页码；默认每页 20、最多 100。
 * 只接收已通过 strictQuery 的字符串参数，HTTP 路由与 MCP 工具共用同一份校验与默认值。
 */
export function parsePublicJobFilters(input: Record<string, string>): JobFiltersV1 {
  const roleFamily = enumParam<RoleFamily>(input, "role_family", ROLE_FAMILIES);
  const studentFriendly = enumParam<StudentFriendly>(input, "student_friendly", STUDENT_FRIENDLY_VALUES);
  const city = optionalText(input, "city");
  const skill = optionalText(input, "skill");
  const keyword = optionalKeyword(input, "q");
  return {
    ...(roleFamily === undefined ? {} : { role_family: roleFamily }),
    ...(city === undefined ? {} : { city }),
    ...(studentFriendly === undefined ? {} : { student_friendly: studentFriendly }),
    ...(skill === undefined ? {} : { skill }),
    ...(keyword === undefined ? {} : { q: keyword }),
    page: intParam(input, "page", 1, MAX_PAGE),
    page_size: intParam(input, "page_size", DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE),
  };
}

function parsePolicyFilters(request: FastifyRequest): PolicyFiltersV1 {
  const input = strictQuery(request, POLICY_QUERY_KEYS);
  return {
    page: intParam(input, "page", 1, MAX_PAGE),
    page_size: intParam(input, "page_size", DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE),
  };
}

/** 列表项只保留公开字段（与站点列表同一份，不额外暴露来源键）。 */
export function publicJob(item: JobListResponseV1["items"][number]): CareerJobPublicV1 {
  return {
    id: item.id,
    company_name: item.company_name,
    title: item.title,
    role_family: item.role_family,
    locations: item.locations,
    employment_type: item.employment_type,
    student_friendly: item.student_friendly,
    skills: item.skills,
    published_at: item.published_at,
    first_seen_at: item.first_seen_at,
    last_seen_at: item.last_seen_at,
    official_url: item.official_url,
  };
}

export function publicJobList(response: JobListResponseV1): CareerJobListResponsePublicV1 {
  return {
    contract_version: response.contract_version,
    data_origin: response.data_origin,
    items: response.items.map(publicJob),
    page: response.page,
    page_size: response.page_size,
    total: response.total,
    as_of: response.as_of,
    filters: response.filters,
  };
}

/** 详情裁剪：去 source_key / job_key / collector_version；观测去自增 id 与 content_hash。 */
export function publicJobDetail(response: JobDetailResponseV1): CareerJobDetailResponsePublicV1 {
  return {
    contract_version: response.contract_version,
    data_origin: response.data_origin,
    job: {
      ...publicJob(response.job),
      degree: response.job.degree,
      degree_raw: response.job.degree_raw,
      experience_min_years: response.job.experience_min_years,
      experience_max_years: response.job.experience_max_years,
      experience_raw: response.job.experience_raw,
      skill_evidence: response.job.skill_evidence.map((evidence) => ({
        skill_id: evidence.skill_id,
        evidence_text: evidence.evidence_text,
      })),
    },
    observations: response.observations.map((observation) => ({
      observed_at: observation.observed_at,
      source_url: observation.source_url,
      evidence_excerpt: observation.evidence_excerpt,
    })),
    notice: response.notice,
  };
}

function publicPolicy(item: PolicyEvidenceRefV1): PolicyEvidenceRefV1 {
  return {
    policy_item_id: item.policy_item_id,
    title: item.title,
    issuer: item.issuer,
    published_at: item.published_at,
    official_url: item.official_url,
    source_tier: item.source_tier,
    theme_ids: item.theme_ids,
    evidence_excerpt: item.evidence_excerpt,
  };
}

export function publicPolicyList(response: PolicyListResponseV1): CareerPolicyListResponsePublicV1 {
  return {
    contract_version: response.contract_version,
    data_origin: response.data_origin,
    as_of: response.as_of,
    items: response.items.map(publicPolicy),
    page: response.page,
    page_size: response.page_size,
    total: response.total,
    facets: response.facets,
  };
}

/** 错误体沿用模块自己的公开契约；非 CareerApiError 一律 500，不外泄内部信息。 */
function sendProblem(reply: FastifyReply, error: unknown): FastifyReply {
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
  return reply
    .header("Cache-Control", "no-store")
    .code(apiError.statusCode)
    .header("Content-Type", "application/json; charset=utf-8")
    .send(body);
}

type Handler = (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;

/** 公开 API 的共同外壳：CORS、错误映射（错误 no-store），成功响应由各路由自己带缓存头。 */
function publicV1Handler(handler: Handler): Handler {
  return async (request, reply) => {
    for (const [key, value] of Object.entries(PUBLIC_API_CORS)) reply.header(key, value);
    reply.header("Cache-Control", "no-store");
    try {
      return await handler(request, reply);
    } catch (error) {
      return sendProblem(reply, error);
    }
  };
}

/**
 * 公开岗位/政策 API v1。路由挂在 /api/v1/career 下，由 server.ts 的 http 插口接线；
 * 引擎的 /api/v1/* 404 兜底在模块之后注册，所以这些地址先命中这里。
 */
export function registerCareerPublicV1(
  app: FastifyInstance,
  repository: CareerRepository,
  deps: CareerPublicV1Deps = {},
): void {
  const cacheControl = deps.cacheControl ?? PUBLIC_CACHE_CONTROL;
  const send = (request: FastifyRequest, reply: FastifyReply, etagPrefix: string, body: unknown) =>
    sendJsonWithEtag(request, reply, body, etagPrefix, cacheControl);

  app.get("/api/v1/career/jobs", publicV1Handler(async (request, reply) => {
    const filters = parsePublicJobFilters(strictQuery(request, JOB_QUERY_KEYS));
    return send(request, reply, "career-v1-jobs", publicJobList(await repository.listJobs(filters)));
  }));

  app.get<{ Params: { id: string } }>("/api/v1/career/jobs/:id", publicV1Handler(async (request, reply) => {
    strictQuery(request, []);
    // publicV1Handler 只声明公共的 FastifyRequest；路由自己的 Params 在这里取回。
    const { id } = request.params as { id: string };
    if (!UUID_PATTERN.test(id)) throw invalidParameter("id", "Job id must be a UUID.");
    const detail = await repository.jobDetail(id);
    if (detail === null) throw new NotFoundError();
    return send(request, reply, "career-v1-job", publicJobDetail(detail));
  }));

  app.get("/api/v1/career/policies", publicV1Handler(async (request, reply) => {
    const filters = parsePolicyFilters(request);
    return send(request, reply, "career-v1-policies", publicPolicyList(await repository.listPolicies(filters)));
  }));

  app.get("/api/v1/career/insights", publicV1Handler(async (request, reply) => {
    strictQuery(request, []);
    const brief = await repository.careerBrief();
    if (brief === null) throw new NotFoundError("No employment insight has been generated yet.");
    // 研判缓存本身就是公开契约（含 contract_version），不再包一层。
    return send(request, reply, "career-v1-insights", brief);
  }));
}
