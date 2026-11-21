// 就业日报归档：按 Asia/Shanghai 自然日列出有数据的期数（日评缓存 + 当日岗位/政策聚合），
// 供 /daily/archive 页面翻看。日报页本身只展示「今天」，历史期没有独立详情路由，归档页用这里的摘要
// 与 /daily?date= 承接。
//
// 数据来源：
// - career_daily_comments：后台预生成的当日 AI 评论（样本量、新增岗位、置信度、评论正文）；
// - career_job_observations / career_jobs / career_policies：当日观测样本、当日新增岗位与政策；
// - 三者任一有记录的日子都算一期，这样评论生成失败的那天仍能出现在归档里（只是没有评论摘要）。
// 观测行 180 天后会被 retention 清掉，那之后用当日评论里存的 sample_size / new_jobs 兜底，评论也没有的
// 老日期就只剩政策与首次观测计数。
//
// 路由由 server.ts 接线（lead 统一注册）：registerCareerArchiveRoutes(app, repository)。
// 历史日报是新增读路径，本文件直接用 `sql` 聚合，不扩共享的 CareerRepository 接口（避免与 http.ts /
// repository.ts 的并行改动冲突）；repository 参数与 registerCareerHttp 保持同一签名，接线时传同一个仓储。
import { BEIJING_TIMEZONE } from "@aihot/contracts/time";
import type { FastifyInstance, FastifyReply } from "fastify";
import { sql, type Db } from "@aihot/backend/db";
import type { ApiErrorResponseV1 } from "../../contracts/api.ts";
import type {
  CareerDailyHistoryEntryV1,
  CareerDailyHistoryResponseV1,
} from "../../contracts/history.ts";
import { CareerApiError, InvalidParameterError } from "../errors.ts";
import { careerPolicyRelevanceSql } from "../policy-relevance.ts";
import { resolveDataOrigin } from "../provenance.ts";
import type { CareerRepository } from "../repository.ts";

/** 历史日报的固定地址（网站页面与测试读它）。 */
export const CAREER_DAILY_HISTORY_PATH = "/api/site/career-insights/daily/history";

export const DEFAULT_HISTORY_PAGE_SIZE = 20;
export const MAX_HISTORY_PAGE_SIZE = 50;
/** 与 http.ts 的分页上限一致：历史期数再大也翻不到这里。 */
const MAX_HISTORY_PAGE = 10_000;
/** 归档列表里每条评论只留摘要，完整评论在 /daily?date= 看。 */
export const MAX_COMMENT_SUMMARY_CHARS = 120;

const HISTORY_FILTER_KEYS = new Set(["page", "page_size"]);

export interface CareerDailyHistoryQuery {
  page: number;
  page_size: number;
}

// 契约只在 contracts/history.ts 定义一次（网页 loader 也读它），这里转出给路由调用方。
export type { CareerDailyHistoryEntryV1, CareerDailyHistoryResponseV1 } from "../../contracts/history.ts";

interface HistoryRow {
  date: string;
  sample_size: number;
  new_jobs: number;
  new_policies: number;
  confidence: string | null;
  comment: string | null;
}

interface HistoryTotalRow {
  total: number;
}

interface OriginCountRow {
  live_count: number;
  import_count: number;
  synthetic_count: number;
}

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

/** 与 http.ts 的 pageNumber 同一套校验与报错文案：正整数、给了上限就同时检查上限。 */
function pageNumber(input: Record<string, unknown>, key: string, fallback: number, maximum?: number): number {
  const raw = input[key];
  if (raw === undefined) return fallback;
  if (typeof raw !== "string" || !/^[1-9][0-9]*$/.test(raw)) {
    throw invalidParameter(key, `Query parameter must be a positive integer: ${key}.`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || (maximum !== undefined && value > maximum)) {
    throw invalidParameter(
      key,
      maximum === undefined ? `Query parameter is too large: ${key}.` : `Query parameter must be between 1 and ${maximum}: ${key}.`,
    );
  }
  return value;
}

/** /daily/history 的参数：未知参数、坏页码、超过上限的 page_size 都 400（不静默截断）。 */
export function parseCareerDailyHistoryQuery(query: unknown): CareerDailyHistoryQuery {
  const input = queryRecord(query);
  const unsupported = Object.keys(input).find((key) => !HISTORY_FILTER_KEYS.has(key));
  if (unsupported !== undefined) throw invalidParameter(unsupported, `Unsupported query parameter: ${unsupported}.`);

  return {
    page: pageNumber(input, "page", 1, MAX_HISTORY_PAGE),
    page_size: pageNumber(input, "page_size", DEFAULT_HISTORY_PAGE_SIZE, MAX_HISTORY_PAGE_SIZE),
  };
}

/**
 * 已生成日评的日期按 (generated_at DESC, prompt_version DESC) 取最近一条；同一天可能留有不同 prompt
 * 版本的行，归档只展示最新的一条，与 /daily-comment 的读法一致。
 */
const HISTORY_DAY_SOURCES = sql`
  WITH latest_comments AS (
    SELECT comment_date AS day, sample_size, new_jobs, confidence, comment,
           ROW_NUMBER() OVER (PARTITION BY comment_date ORDER BY generated_at DESC, prompt_version DESC) AS rn
    FROM career_daily_comments
  ),
  observed AS (
    -- 同一天同一岗位可能留下多条内容哈希不同的观测（职位被改写）；日报样本按去重岗位数计，
    -- 与 career_jobs 的当日新增口径一致，不把观测行数当成岗位数。
    SELECT (observed_at AT TIME ZONE ${BEIJING_TIMEZONE})::date AS day, COUNT(DISTINCT job_id)::int AS sample_size
    FROM career_job_observations
    GROUP BY 1
  ),
  jobs_first AS (
    SELECT (first_seen_at AT TIME ZONE ${BEIJING_TIMEZONE})::date AS day, COUNT(*)::int AS new_jobs
    FROM career_jobs
    GROUP BY 1
  ),
  policies_first AS (
    SELECT (first_seen_at AT TIME ZONE ${BEIJING_TIMEZONE})::date AS day, COUNT(*)::int AS new_policies
    FROM career_policies
    WHERE ${careerPolicyRelevanceSql()}
    GROUP BY 1
  ),
  days AS (
    SELECT day FROM latest_comments WHERE rn = 1
    UNION
    SELECT day FROM observed
    UNION
    SELECT day FROM jobs_first
    UNION
    SELECT day FROM policies_first
  )
`;

function historyConfidence(value: string | null): CareerDailyHistoryEntryV1["confidence"] {
  return value === "low" || value === "medium" || value === "high" ? value : null;
}

function commentSummary(comment: string | null): string | null {
  if (comment === null) return null;
  const text = comment.trim();
  if (text === "") return null;
  const characters = [...text];
  if (characters.length <= MAX_COMMENT_SUMMARY_CHARS) return text;
  // 「…」也算进 120 字里，保证摘要整体不超过上限。
  return characters.slice(0, MAX_COMMENT_SUMMARY_CHARS - 1).join("") + "…";
}

/**
 * 读一页历史日报：所有有记录的日子倒序，带当日样本、新增岗位/政策、评论置信度与摘要。
 * 两次查询（一页数据 + 总数）共用同一份 CTE，页码超出范围时 total 仍准确。
 */
export async function loadCareerDailyHistory(
  db: Db,
  query: CareerDailyHistoryQuery = { page: 1, page_size: DEFAULT_HISTORY_PAGE_SIZE },
): Promise<CareerDailyHistoryResponseV1> {
  const offset = (query.page - 1) * query.page_size;
  const [rows, totals, origins] = await Promise.all([
    db<HistoryRow[]>`${HISTORY_DAY_SOURCES}
      SELECT to_char(days.day, 'YYYY-MM-DD') AS date,
             COALESCE(latest.sample_size, observed.sample_size, 0)::int AS sample_size,
             COALESCE(latest.new_jobs, jobs_first.new_jobs, 0)::int AS new_jobs,
             COALESCE(policies_first.new_policies, 0)::int AS new_policies,
             latest.confidence,
             latest.comment
      FROM days
      LEFT JOIN latest_comments latest ON latest.day = days.day AND latest.rn = 1
      LEFT JOIN observed ON observed.day = days.day
      LEFT JOIN jobs_first ON jobs_first.day = days.day
      LEFT JOIN policies_first ON policies_first.day = days.day
      ORDER BY days.day DESC
      LIMIT ${query.page_size}::int OFFSET ${offset}::int`,
    db<HistoryTotalRow[]>`${HISTORY_DAY_SOURCES}
      SELECT COUNT(*)::int AS total FROM days`,
    db<OriginCountRow[]>`
      SELECT COUNT(*) FILTER (WHERE data_origin = 'live')::int AS live_count,
             COUNT(*) FILTER (WHERE data_origin = 'verified_import')::int AS import_count,
             COUNT(*) FILTER (WHERE data_origin = 'synthetic_fixture')::int AS synthetic_count
      FROM career_jobs`,
  ]);

  const origin = origins[0];
  return {
    contract_version: "0.1",
    data_origin: resolveDataOrigin({
      live: origin?.live_count ?? 0,
      verified_import: origin?.import_count ?? 0,
      synthetic_fixture: origin?.synthetic_count ?? 0,
    }),
    page: query.page,
    page_size: query.page_size,
    total: totals[0]?.total ?? 0,
    entries: rows.map((row) => ({
      date: row.date,
      sample_size: row.sample_size,
      new_jobs: row.new_jobs,
      new_policies: row.new_policies,
      confidence: historyConfidence(row.confidence),
      comment_summary: commentSummary(row.comment),
    })),
  };
}

/**
 * 与 backend/http.ts 的 respond 同一套约定（no-store、ApiErrorResponseV1 错误体、未预期错误 500）；
 * 那里是私有函数，这里复制一份，保持新增路由的响应契约与其它 career 路由一致。
 */
async function respond(reply: FastifyReply, read: () => Promise<unknown>): Promise<FastifyReply> {
  reply.header("Cache-Control", "no-store");
  try {
    return reply.send(await read());
  } catch (error) {
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
}

/**
 * 注册历史日报路由（GET /api/site/career-insights/daily/history?page=&page_size=）。
 * `repository` 与 registerCareerHttp 用同一个仓储签名接线；历史聚合在本文件直接查库（见文件头）。
 */
export function registerCareerArchiveRoutes(app: FastifyInstance, repository: CareerRepository): void {
  void repository;
  app.get(CAREER_DAILY_HISTORY_PATH, async (request, reply) => respond(reply, async () =>
    loadCareerDailyHistory(sql, parseCareerDailyHistoryQuery(request.query)),
  ));
}
