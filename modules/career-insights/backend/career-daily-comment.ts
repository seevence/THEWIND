// 就业日报 AI 评论：脚本读当日聚合 → 调模型写 2-3 句点评 → 按 (comment_date, prompt_version)
// upsert 到 career_daily_comments；读者只经 loadCareerDailyComment 读缓存，不触碰模型。
// 模型输入只有当日聚合数字、可引用的岗位/政策 id 与由这些数字拼出的 facts，输出里的任何数字
// 都必须已在输入中出现（与研判共用 brief.ts 的数字白名单校验）。
import type { Db } from "@aihot/backend/db";
import { BEIJING_TIMEZONE, beijingDate, isValidDate } from "@aihot/contracts/time";
import type { CareerDailyCommentResponseV1 } from "../contracts/insights.ts";
import type { RoleFamily } from "../contracts/job.ts";
import { ROLE_FAMILY_LABELS, SKILL_LABELS } from "../data/dictionaries.ts";
import { assertKnownNumbers, CareerBriefValidationError } from "./brief.ts";
import { InvalidParameterError } from "./errors.ts";
import { careerPolicyRelevanceSql } from "./policy-relevance.ts";

export const CAREER_DAILY_COMMENT_PROMPT_VERSION = "career-daily-comment/1";
export const CAREER_DAILY_COMMENT_PURPOSE = "career-daily-comment";
export const CAREER_DAILY_COMMENT_CONTRACT_VERSION = "0.1" as const;

/** comment 的长度上限（按字符数，一个汉字算一个字符）：2-3 句点评，超长说明模型跑题。 */
export const MAX_COMMENT_CHARS = 400;
const TOP_DIRECTIONS = 3;
const TOP_TITLES = 3;
const TOP_SKILLS = 3;
/** 当日新增岗位/政策最多带几条可引用证据。 */
const NEW_SAMPLE_LIMIT = 3;
/** 政策标题进模型输入时只取前缀：日报点评不需要完整标题，前缀也让 prompt 与缓存更短。 */
const POLICY_TITLE_CHARS = 60;
const EPOCH_ISO = "1970-01-01T00:00:00.000Z";
const CONFIDENCE_VALUES = ["low", "medium", "high"] as const;

const SYSTEM_PROMPT = [
  "你是学生就业数据点评助手。输入是一份 JSON：某个 Asia/Shanghai 自然日的就业数据汇总（当日样本、当日新增岗位与政策、方向/职位/技能 Top3、观察日数）以及由此整理的 facts。",
  "只输出一个 JSON 对象，字段为 comment、confidence，不要输出 JSON 之外的文字。",
  "comment：用 2-3 句中文点评当日的岗位、技能与政策变化，并说明这对学生意味着什么（值得关注的方向、需要准备的技能）；只依据输入里的数字与 facts，不要复述整份汇总。",
  `只能使用输入里已经出现的数字，禁止编造或自行推算新数字；comment 不超过 ${MAX_COMMENT_CHARS} 个字。`,
  "当日新增岗位为 0 且当日没有新增政策时，如实写「今日无新增」，不要编造变化；输入里没有的方向、职位或技能不要写。",
  "引用技能占比（share）时必须同时说明分母：「当日带技能岗位 N 个」；未归类（unknown）岗位单列，不进入任何占比的分母，不要把 unknown 计入方向或技能占比。",
  "confidence：low、medium、high 之一；样本量小或观察日数不足两个时用 low。",
].join("\n");

export type CareerDailyCommentEvidenceV1 = CareerDailyCommentResponseV1["evidence"][number];

/** 模型可见的全部输入：只有当日聚合结果与可引用的岗位/政策 id，没有公司名、URL 或原文。 */
export interface CareerDailyCommentInputV1 {
  /** Asia/Shanghai 自然日（YYYY-MM-DD）。 */
  date: string;
  /** 当日样本里最近一次观测时间（ISO）。 */
  as_of: string;
  sample_size: number;
  new_jobs: number;
  observation_days: number;
  directions: Array<{ role_family: RoleFamily; job_count: number }>;
  titles: Array<{ title: string; job_count: number }>;
  skills: Array<{ skill: string; job_count: number; share: number }>;
  new_policy_count: number;
  new_policies: Array<{ title: string; issuer: string }>;
  /** 当日带技能岗位数：技能占比（share）的分母，模型引用占比时必须能一并说明分母。 */
  skills_sample_size: number;
  /** 当日方向未归类（unknown）岗位数：单列，不进方向榜/占比分母。 */
  unknown_direction_count: number;
  evidence_candidates: CareerDailyCommentEvidenceV1[];
  /** 给模型的可引用事实；数字都来自上面的聚合字段。 */
  facts: string[];
}

export interface CareerDailyCommentRecordV1 extends CareerDailyCommentResponseV1 {
  prompt_version: string;
  receipt_id: number | null;
  model: string | null;
}

export interface CareerDailyCommentModelResultV1 {
  draft: unknown;
  receipt_id?: number | null;
  model?: string | null;
}

export type CareerDailyCommentLlmCaller = (
  input: CareerDailyCommentInputV1,
  prompt: { system: string; user: string },
) => Promise<CareerDailyCommentModelResultV1>;

export interface GenerateCareerDailyCommentOptions {
  date: string;
  prompt_version?: string;
  dry_run?: boolean;
  now?: () => Date;
}

export interface ComposeCareerDailyCommentOptions {
  generated_at: string;
  prompt_version?: string;
  receipt_id?: number | null;
  model?: string | null;
}

/** 评论专属的校验失败：与研判错误同源（继承 CareerBriefValidationError），脚本按同一处捕获。 */
export class CareerCommentValidationError extends CareerBriefValidationError {
  constructor(message: string) {
    super(message);
    this.name = "CareerCommentValidationError";
  }
}

interface DailyJobRow {
  id: string;
  title: string;
  role_family: RoleFamily;
  skills: string[] | null;
  first_seen_at: Date;
  last_seen_at: Date;
}

interface DailyPolicyRow {
  id: string;
  title: string;
  issuer: string;
  new_policy_count: number;
}

interface ObservationDaysRow {
  days: number;
}

interface NewJobsRow {
  count: number;
}

interface CareerDailyCommentRow {
  date: string;
  as_of: Date;
  generated_at: Date;
  sample_size: number;
  new_jobs: number;
  confidence: string;
  comment: string;
  facts: string[];
  evidence: CareerDailyCommentEvidenceV1[];
}

function assertCalendarDate(date: string): string {
  if (!isValidDate(date)) {
    throw new InvalidParameterError(`Query parameter must be a calendar date (YYYY-MM-DD): date.`, { parameter: "date" });
  }
  return date;
}

function byDescendingCount<K>(counts: Map<K, number>): Array<[K, number]> {
  return [...counts].sort((left, right) => right[1] - left[1] || String(left[0]).localeCompare(String(right[0])));
}

/** 方向榜与岗位目录同口径：unknown 不进榜单（未归类占多数时方向 Top3 会全是「未归类」）。 */
function topDirections(jobs: readonly DailyJobRow[]): CareerDailyCommentInputV1["directions"] {
  const counts = new Map<RoleFamily, number>();
  for (const job of jobs) {
    if (job.role_family === "unknown") continue;
    counts.set(job.role_family, (counts.get(job.role_family) ?? 0) + 1);
  }
  return byDescendingCount(counts)
    .slice(0, TOP_DIRECTIONS)
    .map(([role_family, job_count]) => ({ role_family, job_count }));
}

/** 职位榜按原始标题分组：日报只点评当日 Top3，不在这里复刻岗位目录的跨城市合并。 */
function topTitles(jobs: readonly DailyJobRow[]): CareerDailyCommentInputV1["titles"] {
  const counts = new Map<string, number>();
  for (const job of jobs) counts.set(job.title, (counts.get(job.title) ?? 0) + 1);
  return byDescendingCount(counts)
    .slice(0, TOP_TITLES)
    .map(([title, job_count]) => ({ title, job_count }));
}

/** 技能 share = 技能岗位数 / 当日带技能岗位数，与岗位目录同口径（未识别技能的岗位不进分母）。 */
function topSkills(jobs: readonly DailyJobRow[]): CareerDailyCommentInputV1["skills"] {
  const withSkills = jobs.filter((job) => (job.skills ?? []).length > 0);
  const counts = new Map<string, number>();
  for (const job of withSkills) {
    for (const skill of new Set(job.skills ?? [])) counts.set(skill, (counts.get(skill) ?? 0) + 1);
  }
  return byDescendingCount(counts)
    .slice(0, TOP_SKILLS)
    .map(([skill, job_count]) => ({ skill, job_count, share: job_count / withSkills.length }));
}

/** 两位小数不够表达 1/3 这类占比；统一保留一位小数的百分比，模型可以直接引用这个写法。 */
function percentText(share: number): string {
  return (share * 100).toFixed(1) + "%";
}

function skillLabel(skill: string): string {
  return SKILL_LABELS[skill] ?? skill;
}

function clipTitle(title: string): string {
  const characters = [...title];
  return characters.length <= POLICY_TITLE_CHARS ? title : characters.slice(0, POLICY_TITLE_CHARS).join("");
}

function buildFacts(input: Omit<CareerDailyCommentInputV1, "facts">): string[] {
  const facts = [
    `数据日期：${input.date}（Asia/Shanghai），数据截止：${input.as_of}`,
    `当日有观测的岗位：${input.sample_size} 个`,
    `当日首次观测到的新岗位：${input.new_jobs} 个`,
    `观察日数：${input.observation_days} 天`,
  ];
  if (input.directions.length > 0) {
    facts.push(
      "方向 Top3：" +
        input.directions.map((entry) => `${ROLE_FAMILY_LABELS[entry.role_family]} ${entry.job_count} 个岗位`).join("；"),
    );
  }
  if (input.titles.length > 0) {
    facts.push("职位 Top3：" + input.titles.map((entry) => `${entry.title} ${entry.job_count} 个岗位`).join("；"));
  }
  if (input.skills.length > 0) {
    facts.push(
      "技能 Top3：" +
        input.skills
          .map((entry) => `${skillLabel(entry.skill)} ${entry.job_count} 个岗位（占比 ${percentText(entry.share)}）`)
          .join("；"),
    );
    facts.push(
      `技能占比的分母：当日带技能岗位 ${input.skills_sample_size} 个（未识别技能的岗位不进分母，占比不等于岗位需求概率）`,
    );
  }
  facts.push(
    `当日方向未归类（unknown）岗位 ${input.unknown_direction_count} 个：单列，不进入方向榜与任何占比的分母`,
  );
  if (input.new_policy_count === 0) {
    facts.push("当日无新增政策");
  } else {
    facts.push(`当日新增政策 ${input.new_policy_count} 条：${input.new_policies.map((policy) => policy.title).join("；")}`);
  }
  if (input.new_jobs === 0) facts.push("当日无新增岗位");
  return facts;
}

/**
 * 当日（Asia/Shanghai）聚合输入：当日有观测的岗位为样本（观测行是「仍在招聘」的证据），
 * 方向/职位/技能 Top3 只统计这个样本；new_jobs 与新增政策按当日 first_seen 计数。
 * 无样本时 sample_size=0，调用方据此跳过模型、不写缓存。
 */
export async function loadDailyCommentInput(db: Db, date: string): Promise<CareerDailyCommentInputV1> {
  assertCalendarDate(date);
  const [jobs, newJobs, policies, observationDays] = await Promise.all([
    db<DailyJobRow[]>`
      SELECT job.id::text AS id, job.title, job.role_family, job.skills, job.first_seen_at, job.last_seen_at
      FROM career_jobs job
      WHERE EXISTS (
        SELECT 1 FROM career_job_observations observation
        WHERE observation.job_id = job.id
          AND (observation.observed_at AT TIME ZONE ${BEIJING_TIMEZONE})::date = ${date}::date
      )
      ORDER BY job.last_seen_at DESC, job.id ASC`,
    db<NewJobsRow[]>`
      SELECT COUNT(*)::int AS count
      FROM career_jobs
      WHERE (first_seen_at AT TIME ZONE ${BEIJING_TIMEZONE})::date = ${date}::date`,
    db<DailyPolicyRow[]>`
      SELECT policy.id::text AS id, policy.title, policy.issuer, (COUNT(*) OVER ())::int AS new_policy_count
      FROM career_policies policy
      WHERE (policy.first_seen_at AT TIME ZONE ${BEIJING_TIMEZONE})::date = ${date}::date
        AND ${careerPolicyRelevanceSql()}
      ORDER BY policy.first_seen_at DESC, policy.id ASC
      LIMIT ${NEW_SAMPLE_LIMIT}::int`,
    db<ObservationDaysRow[]>`
      SELECT COUNT(DISTINCT (observed_at AT TIME ZONE ${BEIJING_TIMEZONE})::date)::int AS days
      FROM career_job_observations
      WHERE (observed_at AT TIME ZONE ${BEIJING_TIMEZONE})::date <= ${date}::date`,
  ]);

  const newJobEvidence = jobs
    .filter((job) => beijingDate(new Date(job.first_seen_at)) === date)
    .sort((left, right) => new Date(right.first_seen_at).getTime() - new Date(left.first_seen_at).getTime())
    .slice(0, NEW_SAMPLE_LIMIT)
    .map<CareerDailyCommentEvidenceV1>((job) => ({ kind: "job", id: job.id, title: job.title }));

  const asOf =
    jobs.length === 0
      ? EPOCH_ISO
      : new Date(Math.max(...jobs.map((job) => new Date(job.last_seen_at).getTime()))).toISOString();

  const base: Omit<CareerDailyCommentInputV1, "facts"> = {
    date,
    as_of: asOf,
    sample_size: jobs.length,
    new_jobs: newJobs[0]?.count ?? 0,
    observation_days: observationDays[0]?.days ?? 0,
    directions: topDirections(jobs),
    titles: topTitles(jobs),
    skills: topSkills(jobs),
    new_policy_count: policies[0]?.new_policy_count ?? 0,
    new_policies: policies.map((policy) => ({ title: clipTitle(policy.title), issuer: policy.issuer })),
    skills_sample_size: jobs.filter((job) => (job.skills ?? []).length > 0).length,
    unknown_direction_count: jobs.filter((job) => job.role_family === "unknown").length,
    evidence_candidates: [
      ...newJobEvidence,
      ...policies.map<CareerDailyCommentEvidenceV1>((policy) => ({ kind: "policy", id: policy.id, title: policy.title })),
    ],
  };
  return { ...base, facts: buildFacts(base) };
}

export function buildCareerDailyCommentPrompt(input: CareerDailyCommentInputV1): { system: string; user: string } {
  return { system: SYSTEM_PROMPT, user: JSON.stringify(input) };
}

function parseDraft(rawDraft: unknown): { comment: string; confidence: CareerDailyCommentResponseV1["confidence"] } {
  if (typeof rawDraft !== "object" || rawDraft === null || Array.isArray(rawDraft)) {
    throw new CareerCommentValidationError("Model output must be a JSON object.");
  }
  const draft = rawDraft as Record<string, unknown>;
  if (typeof draft.comment !== "string" || draft.comment.trim() === "") {
    throw new CareerCommentValidationError("Model output field comment must be a non-empty string.");
  }
  const comment = draft.comment.trim();
  const length = [...comment].length;
  if (length > MAX_COMMENT_CHARS) {
    throw new CareerCommentValidationError(
      `Model output comment must be at most ${MAX_COMMENT_CHARS} characters (got ${length}).`,
    );
  }
  if (typeof draft.confidence !== "string" || !(CONFIDENCE_VALUES as readonly string[]).includes(draft.confidence)) {
    throw new CareerCommentValidationError(`Model output confidence must be one of ${CONFIDENCE_VALUES.join(", ")}.`);
  }
  return { comment, confidence: draft.confidence as CareerDailyCommentResponseV1["confidence"] };
}

/**
 * 把模型草稿变成可缓存的记录：comment 数字白名单校验（数据日期与 as_of 的年月日片段可引用），
 * evidence 固定取输入里当日新增岗位/政策的可引用 id（模型不产出证据）。
 */
export function composeCareerDailyComment(
  input: CareerDailyCommentInputV1,
  rawDraft: unknown,
  options: ComposeCareerDailyCommentOptions,
): CareerDailyCommentRecordV1 {
  const draft = parseDraft(rawDraft);
  try {
    assertKnownNumbers(input, [input.date, input.as_of], [draft.comment]);
  } catch (error) {
    if (error instanceof CareerBriefValidationError) throw new CareerCommentValidationError(error.message);
    throw error;
  }
  return {
    contract_version: CAREER_DAILY_COMMENT_CONTRACT_VERSION,
    date: input.date,
    as_of: input.as_of,
    generated_at: options.generated_at,
    sample_size: input.sample_size,
    new_jobs: input.new_jobs,
    confidence: draft.confidence,
    comment: draft.comment,
    facts: input.facts,
    evidence: input.evidence_candidates,
    prompt_version: options.prompt_version ?? CAREER_DAILY_COMMENT_PROMPT_VERSION,
    receipt_id: options.receipt_id ?? null,
    model: options.model ?? null,
  };
}

/** 读某日最近生成的一条评论缓存（同一天可能留有不同 prompt_version 的行）；没有则 null。 */
export async function loadCareerDailyComment(
  db: Db,
  date: string,
): Promise<CareerDailyCommentResponseV1 | null> {
  assertCalendarDate(date);
  const rows = await db<CareerDailyCommentRow[]>`
    SELECT to_char(comment_date, 'YYYY-MM-DD') AS date, as_of, generated_at, sample_size, new_jobs,
           confidence, comment, facts, evidence
    FROM career_daily_comments
    WHERE comment_date = ${date}::date
    ORDER BY generated_at DESC, prompt_version DESC
    LIMIT 1`;
  const row = rows[0];
  if (row === undefined) return null;
  return {
    contract_version: CAREER_DAILY_COMMENT_CONTRACT_VERSION,
    date: row.date,
    as_of: new Date(row.as_of).toISOString(),
    generated_at: new Date(row.generated_at).toISOString(),
    sample_size: row.sample_size,
    new_jobs: row.new_jobs,
    confidence: row.confidence as CareerDailyCommentResponseV1["confidence"],
    comment: row.comment,
    facts: row.facts,
    evidence: row.evidence,
  };
}

export async function saveCareerDailyComment(db: Db, record: CareerDailyCommentRecordV1): Promise<void> {
  await db`
    INSERT INTO career_daily_comments (
      contract_version, comment_date, as_of, generated_at, sample_size, new_jobs, prompt_version,
      confidence, comment, facts, evidence, receipt_id, model
    ) VALUES (
      ${record.contract_version}, ${record.date}::date, ${record.as_of}::timestamptz,
      ${record.generated_at}::timestamptz, ${record.sample_size}, ${record.new_jobs}, ${record.prompt_version},
      ${record.confidence}, ${record.comment}, ${db.json(record.facts)}::jsonb,
      ${db.json(record.evidence)}::jsonb, ${record.receipt_id}, ${record.model}
    )
    ON CONFLICT (comment_date, prompt_version) DO UPDATE SET
      contract_version = EXCLUDED.contract_version,
      as_of = EXCLUDED.as_of,
      generated_at = EXCLUDED.generated_at,
      sample_size = EXCLUDED.sample_size,
      new_jobs = EXCLUDED.new_jobs,
      confidence = EXCLUDED.confidence,
      comment = EXCLUDED.comment,
      facts = EXCLUDED.facts,
      evidence = EXCLUDED.evidence,
      receipt_id = EXCLUDED.receipt_id,
      model = EXCLUDED.model,
      updated_at = now()`;
}

/** 无当日样本时不调用模型也不写库，返回 null（脚本据此报告 skipped）。 */
export async function generateCareerDailyComment(
  db: Db,
  callLlm: CareerDailyCommentLlmCaller,
  options: GenerateCareerDailyCommentOptions,
): Promise<CareerDailyCommentRecordV1 | null> {
  const input = await loadDailyCommentInput(db, options.date);
  if (input.sample_size === 0) return null;
  const result = await callLlm(input, buildCareerDailyCommentPrompt(input));
  const record = composeCareerDailyComment(input, result.draft, {
    generated_at: (options.now ?? (() => new Date()))().toISOString(),
    ...(options.prompt_version === undefined ? {} : { prompt_version: options.prompt_version }),
    receipt_id: result.receipt_id ?? null,
    model: result.model ?? null,
  });
  if (options.dry_run !== true) await saveCareerDailyComment(db, record);
  return record;
}
