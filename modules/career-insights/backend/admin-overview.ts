// 后台「就业数据」视图的数据层：只读聚合采集 run、来源健康、LLM 兜底/研判/评论的 job_runs.detail、
// 研判与日报评论缓存、数据规模与新鲜度。每段查询单独降级——某一段失败只让该段 ok:false（页面显示
// 「数据暂不可用」），其余段照常展示，不会把整个后台页打挂；查询全部参数化、只读、限行数。
//
// 纯后端代码：api 进程经 GET /api/admin/career 读它（registerCareerAdminOverview），web 端只经 HTTP
// 读这个 JSON，不直接连库。接线：lead 在 modules/career-insights/server.ts 的 http(app) 里加一行
// registerCareerAdminOverview(app)（或改成在 apps/api/src/routes/admin.ts 用 adminHandler 挂）均可。
import type { FastifyInstance } from "fastify";
import { BEIJING_TIMEZONE } from "@aihot/contracts/time";
import { sessionPrincipal } from "@aihot/backend/admin/auth";
import { sql as engineSql, type Db } from "@aihot/backend/db";
import { ADMIN } from "@aihot/site";
import { CAREER_SOURCE_DEFINITIONS } from "../collector/sources.ts";
import type {
  CareerAdminBrief,
  CareerAdminBriefStep,
  CareerAdminComment,
  CareerAdminCommentStep,
  CareerAdminIngestRun,
  CareerAdminJobRun,
  CareerAdminLlmStep,
  CareerAdminOverview,
  CareerAdminScale,
  CareerAdminSection,
  CareerAdminSourceHealth,
} from "../contracts/admin.ts";

/** 后台页面读的地址（apps/web/app/routes/admin/career.tsx 的 loader 用它）。 */
export const CAREER_ADMIN_OVERVIEW_PATH = "/api/admin/career";

/** 采集运行卡片：最近多少次 run。 */
const INGEST_RUN_LIMIT = 12;
/** 来源健康卡片：最多多少个来源。 */
const SOURCE_LIMIT = 20;
/** 研判/评论卡片：各展示最近几份缓存。 */
const BRIEF_LIMIT = 6;
const COMMENT_LIMIT = 6;

const SOURCE_LABELS = new Map(CAREER_SOURCE_DEFINITIONS.map((definition) => [definition.source_key, definition.label] as const));

/** 来源中文名；库里出现未登记的来源时回落为 key，不让后台因为新来源而报错。 */
function sourceLabel(sourceKey: string): string {
  return SOURCE_LABELS.get(sourceKey) ?? sourceKey;
}

function iso(value: Date | string | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

function isoRequired(value: Date | string): string {
  return new Date(value).toISOString();
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function bool(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function numObject(value: unknown): Record<string, number | null> | null {
  const object = record(value);
  if (object === null) return null;
  const out: Record<string, number | null> = {};
  for (const [key, item] of Object.entries(object)) out[key] = num(item);
  return out;
}

/** job_runs.detail.llm → 后台要显示的字段；不是对象时返回 null（旧记录/其它任务的 detail）。 */
function llmStep(value: unknown): CareerAdminLlmStep | null {
  const row = record(value);
  if (row === null) return null;
  const usage = numObject(row.usage);
  const budget = numObject(row.budget);
  const skipped = record(row.skipped);
  return {
    ok: bool(row.ok),
    candidates: num(row.candidates),
    called: num(row.called),
    changed: num(row.changed),
    failed: num(row.failed),
    calls: num(row.calls),
    retries: num(row.retries),
    usage: usage === null ? null : { prompt_tokens: usage.prompt_tokens ?? 0, completion_tokens: usage.completion_tokens ?? 0 },
    budget: budget === null ? null : {
      max_rows: budget.max_rows ?? 0,
      max_prompt_tokens: budget.max_prompt_tokens ?? 0,
      rows: budget.rows ?? 0,
      prompt_tokens_estimated: budget.prompt_tokens_estimated ?? 0,
    },
    stopped_by_budget: str(row.stopped_by_budget),
    skipped: skipped === null ? null : { rows: num(skipped.rows) ?? 0, reason: str(skipped.reason) },
    duration_ms: num(row.duration_ms),
    exit_code: num(row.exit_code),
    error: str(row.error),
  };
}

function briefStep(value: unknown): CareerAdminBriefStep | null {
  const row = record(value);
  if (row === null) return null;
  return {
    ok: bool(row.ok),
    skipped: bool(row.skipped),
    reason: str(row.reason),
    as_of: str(row.as_of),
    sample_size: num(row.sample_size),
    observation_days: num(row.observation_days),
    confidence: str(row.confidence),
    receipt_id: num(row.receipt_id),
    model: str(row.model),
    duration_ms: num(row.duration_ms),
    exit_code: num(row.exit_code),
    error: str(row.error),
  };
}

function commentStep(value: unknown): CareerAdminCommentStep | null {
  const row = record(value);
  if (row === null) return null;
  return {
    ok: bool(row.ok),
    skipped: bool(row.skipped),
    reason: str(row.reason),
    date: str(row.date),
    as_of: str(row.as_of),
    sample_size: num(row.sample_size),
    new_jobs: num(row.new_jobs),
    confidence: str(row.confidence),
    receipt_id: num(row.receipt_id),
    model: str(row.model),
    duration_ms: num(row.duration_ms),
    exit_code: num(row.exit_code),
    error: str(row.error),
  };
}

/** 后台数据来源：查询失败由 buildCareerAdminOverview 的 section 兜住。 */
export interface CareerAdminRepository {
  /** 最近 N 次采集 run（岗位与政策混排，按抓取时间倒序）。 */
  ingestRuns(limit: number): Promise<CareerAdminIngestRun[]>;
  /** 按 (source_key, kind) 聚合的最新状态与最近一次成功。 */
  sourceHealth(limit: number): Promise<CareerAdminSourceHealth[]>;
  /** 最近一次 career 相关 job_runs（detail 里有 llm/brief/comment 的四步汇总）。 */
  latestJobRun(): Promise<CareerAdminJobRun | null>;
  recentBriefs(limit: number): Promise<CareerAdminBrief[]>;
  recentComments(limit: number): Promise<CareerAdminComment[]>;
  scale(): Promise<CareerAdminScale>;
}

interface IngestRunRow {
  id: string;
  kind: "jobs" | "policy";
  source_key: string;
  status: "ok" | "partial" | "failed";
  fetched_at: Date;
  job_count: number;
  accepted: number;
  updated: number;
  duplicates: number;
  rejected: number;
  error: string | null;
}

interface SourceHealthRow {
  source_key: string;
  kind: "jobs" | "policy";
  last_status: "ok" | "partial" | "failed";
  last_fetched_at: Date;
  last_accepted: number;
  last_error: string | null;
  last_ok_at: Date | null;
  last_ok_accepted: number | null;
  failed_runs: number;
}

interface JobRunRow {
  job: string;
  status: "running" | "ok" | "failed" | "skipped";
  started_at: Date;
  finished_at: Date | null;
  error: string | null;
  llm: unknown;
  brief: unknown;
  comment: unknown;
}

interface BriefRow {
  prompt_version: string;
  as_of: Date;
  generated_at: Date;
  confidence: "low" | "medium" | "high";
  sample_size: number;
  window_days: number;
  observation_days: number;
  receipt_id: number | null;
  model: string | null;
}

interface CommentRow {
  prompt_version: string;
  comment_date: string;
  as_of: Date;
  generated_at: Date;
  confidence: "low" | "medium" | "high";
  sample_size: number;
  new_jobs: number;
  receipt_id: number | null;
  model: string | null;
}

interface ScaleRow {
  jobs: number;
  observations: number;
  policies: number;
  briefs: number;
  comments: number;
  observed_days: number;
  latest_observation_at: Date | null;
  latest_job_seen_at: Date | null;
  latest_policy_seen_at: Date | null;
  latest_policy_published_at: string | null;
}

/** 真库实现：每条查询都只是 SELECT，带 LIMIT；表不存在时抛错，由对应 section 降级。 */
export class SqlCareerAdminRepository implements CareerAdminRepository {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  async ingestRuns(limit: number): Promise<CareerAdminIngestRun[]> {
    const rows = await this.db<IngestRunRow[]>`
      SELECT id::text AS id, kind, source_key, status, fetched_at,
             job_count, accepted, updated, duplicates, rejected, error
      FROM career_ingest_runs
      ORDER BY fetched_at DESC, created_at DESC
      LIMIT ${limit}`;
    return rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      source_key: row.source_key,
      source_label: sourceLabel(row.source_key),
      status: row.status,
      fetched_at: isoRequired(row.fetched_at),
      job_count: row.job_count,
      accepted: row.accepted,
      updated: row.updated,
      duplicates: row.duplicates,
      rejected: row.rejected,
      error: row.error,
    }));
  }

  async sourceHealth(limit: number): Promise<CareerAdminSourceHealth[]> {
    const rows = await this.db<SourceHealthRow[]>`
      SELECT source_key, kind,
             (array_agg(status ORDER BY fetched_at DESC))[1] AS last_status,
             max(fetched_at) AS last_fetched_at,
             (array_agg(accepted ORDER BY fetched_at DESC))[1] AS last_accepted,
             (array_agg(error ORDER BY fetched_at DESC))[1] AS last_error,
             (array_agg(fetched_at ORDER BY fetched_at DESC) FILTER (WHERE status = 'ok'))[1] AS last_ok_at,
             (array_agg(accepted ORDER BY fetched_at DESC) FILTER (WHERE status = 'ok'))[1] AS last_ok_accepted,
             (count(*) FILTER (WHERE status = 'failed'))::int AS failed_runs
      FROM career_ingest_runs
      GROUP BY source_key, kind
      ORDER BY (max(fetched_at)) DESC, source_key
      LIMIT ${limit}`;
    return rows.map((row) => ({
      source_key: row.source_key,
      source_label: sourceLabel(row.source_key),
      kind: row.kind,
      last_status: row.last_status,
      last_fetched_at: isoRequired(row.last_fetched_at),
      last_accepted: row.last_accepted,
      last_error: row.last_error,
      last_ok_at: iso(row.last_ok_at),
      last_ok_accepted: row.last_ok_accepted,
      failed_runs: row.failed_runs,
    }));
  }

  async latestJobRun(): Promise<CareerAdminJobRun | null> {
    const rows = await this.db<JobRunRow[]>`
      SELECT job, status, started_at, finished_at, error,
             detail->'llm' AS llm, detail->'brief' AS brief, detail->'comment' AS comment
      FROM job_runs
      WHERE job LIKE '%career%' OR job LIKE '%llm-normalize%'
      ORDER BY started_at DESC, id DESC
      LIMIT 1`;
    const row = rows[0];
    if (row === undefined) return null;
    return {
      job: row.job,
      status: row.status,
      started_at: isoRequired(row.started_at),
      finished_at: iso(row.finished_at),
      error: row.error,
      llm: llmStep(row.llm),
      brief: briefStep(row.brief),
      comment: commentStep(row.comment),
    };
  }

  async recentBriefs(limit: number): Promise<CareerAdminBrief[]> {
    const rows = await this.db<BriefRow[]>`
      SELECT prompt_version, as_of, generated_at, confidence, sample_size, window_days,
             observation_days, receipt_id, model
      FROM career_briefs
      ORDER BY generated_at DESC, as_of DESC, prompt_version DESC
      LIMIT ${limit}`;
    return rows.map((row) => ({
      prompt_version: row.prompt_version,
      as_of: isoRequired(row.as_of),
      generated_at: isoRequired(row.generated_at),
      confidence: row.confidence,
      sample_size: row.sample_size,
      window_days: row.window_days,
      observation_days: row.observation_days,
      receipt_id: row.receipt_id,
      model: row.model,
    }));
  }

  async recentComments(limit: number): Promise<CareerAdminComment[]> {
    const rows = await this.db<CommentRow[]>`
      SELECT prompt_version, to_char(comment_date, 'YYYY-MM-DD') AS comment_date,
             as_of, generated_at, confidence, sample_size, new_jobs, receipt_id, model
      FROM career_daily_comments
      ORDER BY comment_date DESC, generated_at DESC, prompt_version DESC
      LIMIT ${limit}`;
    return rows.map((row) => ({
      prompt_version: row.prompt_version,
      date: row.comment_date,
      as_of: isoRequired(row.as_of),
      generated_at: isoRequired(row.generated_at),
      confidence: row.confidence,
      sample_size: row.sample_size,
      new_jobs: row.new_jobs,
      receipt_id: row.receipt_id,
      model: row.model,
    }));
  }

  async scale(): Promise<CareerAdminScale> {
    const rows = await this.db<ScaleRow[]>`
      SELECT
        (SELECT count(*)::int FROM career_jobs) AS jobs,
        (SELECT count(*)::int FROM career_job_observations) AS observations,
        (SELECT count(*)::int FROM career_policies) AS policies,
        (SELECT count(*)::int FROM career_briefs) AS briefs,
        (SELECT count(*)::int FROM career_daily_comments) AS comments,
        (SELECT count(DISTINCT (observed_at AT TIME ZONE ${BEIJING_TIMEZONE})::date)::int FROM career_job_observations) AS observed_days,
        (SELECT max(observed_at) FROM career_job_observations) AS latest_observation_at,
        (SELECT max(last_seen_at) FROM career_jobs) AS latest_job_seen_at,
        (SELECT max(last_seen_at) FROM career_policies) AS latest_policy_seen_at,
        (SELECT to_char(max(published_at), 'YYYY-MM-DD') FROM career_policies) AS latest_policy_published_at`;
    const row = rows[0];
    if (row === undefined) throw new Error("scale query returned no row");
    return {
      jobs: row.jobs,
      observations: row.observations,
      policies: row.policies,
      briefs: row.briefs,
      comments: row.comments,
      observed_days: row.observed_days,
      latest_observation_at: iso(row.latest_observation_at),
      latest_job_seen_at: iso(row.latest_job_seen_at),
      latest_policy_seen_at: iso(row.latest_policy_seen_at),
      latest_policy_published_at: row.latest_policy_published_at,
    };
  }
}

/** 一段查询失败只降级这一段；错误只留摘要，不把 SQL/密钥带进页面。 */
async function section<T>(read: () => Promise<T>): Promise<CareerAdminSection<T>> {
  try {
    return { ok: true, data: await read() };
  } catch (error) {
    return { ok: false, error: (error instanceof Error ? error.message : "unknown").slice(0, 200) };
  }
}

export interface CareerAdminOverviewOptions {
  /** 测试注入固定时间。 */
  now?: () => Date;
}

/** 六段并行读、各自降级，返回页面要的一次快照。 */
export async function buildCareerAdminOverview(
  repository: CareerAdminRepository,
  options: CareerAdminOverviewOptions = {},
): Promise<CareerAdminOverview> {
  const [ingest, sources, llm, briefs, comments, scale] = await Promise.all([
    section(async () => ({ runs: await repository.ingestRuns(INGEST_RUN_LIMIT) })),
    section(() => repository.sourceHealth(SOURCE_LIMIT)),
    section(() => repository.latestJobRun()),
    section(() => repository.recentBriefs(BRIEF_LIMIT)),
    section(() => repository.recentComments(COMMENT_LIMIT)),
    section(() => repository.scale()),
  ]);
  return {
    generated_at: (options.now ?? (() => new Date()))().toISOString(),
    ingest,
    sources,
    llm,
    briefs,
    comments,
    scale,
  };
}

/** 页面/路由用的默认入口：读引擎的库。 */
export async function loadCareerAdminOverview(db: Db = engineSql): Promise<CareerAdminOverview> {
  return buildCareerAdminOverview(new SqlCareerAdminRepository(db));
}

/**
 * GET /api/admin/career：只读 JSON，管理员会话守卫（与 /api/admin/* 其余路由同一套 cookie 会话）。
 * 接线：lead 在 modules/career-insights/server.ts 的 http(app) 里调用它；也可以在
 * apps/api/src/routes/admin.ts 里用 adminHandler 挂 loadCareerAdminOverview。
 */
export function registerCareerAdminOverview(app: FastifyInstance): void {
  app.get(CAREER_ADMIN_OVERVIEW_PATH, async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    if (!ADMIN) return reply.code(404).send({ error: { code: "not_found", message: "Not found." } });
    const admin = await sessionPrincipal(request.headers.cookie);
    if (!admin) return reply.code(401).send({ error: { code: "unauthorized", message: "Sign in to the admin first." } });
    return loadCareerAdminOverview();
  });
}
