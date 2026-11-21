// 离线研判：脚本读聚合指标 → 调模型 → 按 (as_of, prompt_version) upsert 到 career_briefs；
// 读者只经 loadCareerBrief 读缓存，不触碰模型。模型输入只有聚合数字、时间窗、样本量和可引用编号：
// 职族/技能一律换成中文展示名，占比写成百分比，内部 id 不进 prompt；模型输出必须是中文，
// 落库前再做一次确定性中文化清洗，任何数字都仍然必须已在输入中出现。
import type { Db } from "@aihot/backend/db";
import { BEIJING_TIMEZONE } from "@aihot/contracts/time";
import type { CareerBriefV1 } from "../contracts/insights.ts";
import { ROLE_FAMILY_LABELS, SKILL_LABELS } from "../data/dictionaries.ts";
import { loadCareerCatalog, type CareerCatalogOptions } from "./career-catalog.ts";
import { careerPolicyRelevanceSql } from "./policy-relevance.ts";

export const CAREER_BRIEF_PROMPT_VERSION = "career-brief/2";
export const CAREER_BRIEF_PURPOSE = "career-brief";
export const CAREER_BRIEF_CONTRACT_VERSION = "0.1" as const;

const MAX_FACT_CHARS = 60;
const JOB_EVIDENCE_LIMIT = 10;
const POLICY_EVIDENCE_LIMIT = 5;
const MIN_OBSERVATION_DAYS = 2;
const MAX_TOKENS_HINT = "不超过 60 个字";

const EARLY_LIMITATION = "观测日不足两个，只反映当前已观测到的岗位，不构成走势判断。";
const EARLY_INFERENCE = "当前观测日不足两个，只陈述现状，暂不判断走势。";
const WINDOW_WORDS = ["观察窗", "观测窗", "观测日", "置信度"] as const;
const CONFIDENCE_LABELS: Readonly<Record<CareerBriefV1["confidence"], string>> = {
  low: "低",
  medium: "中",
  high: "高",
};
const TREND_TERMS = [
  "增长", "下降", "走势", "上升", "下滑", "上涨", "下跌", "回落", "攀升", "走低", "走高",
  "减少", "增加", "提升", "降低", "扩大", "收窄", "trend", "growth", "decline", "increase",
  "decrease", "rise", "fall",
] as const;
const CONFIDENCE_VALUES = ["low", "medium", "high"] as const;
const NUMBER_TOKEN = /(\d[\d,]*(?:\.\d+)?)(%?)/g;
const DATE_TOKEN = /\d{1,4}/g;
const CONTEXT_CHARS = 80;
const CONTEXT_PADDING = 24;
const RELATIVE_TOLERANCE = 1e-6;
const YEAR_MIN = 1900;
const YEAR_MAX = 2100;

const SYSTEM_PROMPT = [
  "你是学生就业数据研判助手。输入是一份中文 JSON 聚合统计：数据截止、观察窗天数、样本量、观测日数、方向、职位、技能、技能占比分母，以及可引用证据；所有名称都是中文展示值。",
  "只输出一个 JSON 对象，字段为 facts、inferences、actions、limitations、confidence、evidence，不要输出 JSON 之外的文字。",
  "正文（facts、inferences、actions、limitations 的文本）必须全部使用中文，不得出现任何内部 ID、英文标识或英文字段名（例如 role_family、skills、share、ai_application_development、data_analysis 都不得出现在正文里）；JSON 字段名（facts、inferences、actions、limitations、confidence、evidence）、枚举值（job/policy、low/medium/high）与证据编号（UUID）属于接口格式，不在此限。引用职族或技能必须使用输入里的中文名称；引用技能占比必须写成百分比并在同一处说明分母（例如「占 166 个有技能岗位的 43.4%」），不要单独写百分比、不要写小数或 share；facts、inferences、actions、limitations 都适用。",
  "facts：只陈述输入中已有的事实，每条只写一件事（不要在一句里罗列多个方向或技能），每条不超过 60 个字；inferences：趋势推断，必须写明观察窗或置信度措辞；actions：给学生可执行的准备建议；limitations：数据与方法的限制。",
  `只能使用输入中已经出现的数字，禁止编造或自行推算新数字（facts 每条${MAX_TOKENS_HINT}）。`,
  "evidence：只能引用输入「可引用证据」中已有的编号；输出时 kind 取 job（对应类型 岗位）或 policy（对应类型 政策），id 填该编号，title 原样返回；没有可引用项时给空数组。",
  "confidence：low、medium、high 之一。观测日不足两个时不要写增长、下降、走势一类判断。",
].join("\n");

/**
 * 正文里常见的 snake_case 字段名 → 中文说法。只收 snake_case 形态：share、skills 这类单词字段
 * 与 confidence 取值（low/medium/high）不做无条件替换，否则 high-paying、medium-sized 这类
 * 普通英文词会被误伤（换模型后正文里可能出现英文描述）。
 */
const FIELD_NAME_TERMS: ReadonlyArray<readonly [string, string]> = [
  ["role_family", "职族"],
  ["top_skills", "主要技能"],
  ["student_friendly_count", "学生友好岗位数"],
  ["student_friendly", "学生友好"],
  ["new_in_window", "观察窗内新增岗位数"],
  ["company_count", "公司数"],
  ["job_count", "岗位数"],
  ["job_key", "岗位"],
  ["title_display", "职位名称"],
  ["title_key", "职位"],
  ["evidence_candidates", "可引用证据"],
  ["sample_size", "样本量"],
  ["observation_days", "观测日数"],
  ["window_days", "观察窗天数"],
  ["as_of", "数据截止"],
  ["contract_version", "契约版本"],
  ["generated_at", "生成时间"],
];

/**
 * 中文化替换表：职族 id、全部技能 id、snake_case 字段名。按 id 长度降序拼成一个正则，
 * 保证 data_analysis 先于 data 命中；两侧用词边界，避免把 Google、email、metadata、
 * database 这类普通英文词拆开。词典里没有的技能不展示（宁可不出现内部 id）。
 */
const DOMAIN_TERM_ENTRIES: ReadonlyArray<readonly [string, string]> = [
  ...Object.entries(ROLE_FAMILY_LABELS),
  ...Object.entries(SKILL_LABELS),
  ...FIELD_NAME_TERMS,
];

const DOMAIN_TERM_REPLACEMENTS: ReadonlyMap<string, string> = new Map(
  DOMAIN_TERM_ENTRIES.map(([id, label]) => [id.toLowerCase(), label]),
);

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const DOMAIN_TERM_SOURCE =
  "(?<![A-Za-z0-9_])(?:" +
  [...new Set(DOMAIN_TERM_ENTRIES.map(([id]) => id))]
    .sort((left, right) => right.length - left.length || left.localeCompare(right))
    .map(escapeRegExp)
    .join("|") +
  ")(?![A-Za-z0-9_])";

const DOMAIN_TERM_PATTERN = new RegExp(DOMAIN_TERM_SOURCE, "giu");

/**
 * 残留兜底用的「内部标识形态」：snake_case（至少两段、全小写字母/数字/下划线、长度 ≥4）。
 * 与替换表相互独立，因此替换表之外的新 id（如 rust_engineer、latest_published_at）也能被判不合规，
 * 而不是静默漏过；词典展示名（Python、SQL 等）不是 snake_case，天然放行。
 */
const INTERNAL_IDENTIFIER_PATTERN = /(?<![A-Za-z0-9_])([a-z][a-z0-9]*(?:_[a-z0-9]+)+)(?![A-Za-z0-9_])/gu;
const MIN_INTERNAL_IDENTIFIER_CHARS = 4;
const DISPLAY_NAME_WHITELIST: ReadonlySet<string> = new Set([
  ...Object.values(SKILL_LABELS),
  ...Object.values(ROLE_FAMILY_LABELS),
]);

export type CareerBriefEvidenceV1 = CareerBriefV1["evidence"][number];

/**
 * 聚合输入：内部保留职族/技能 id 与小数占比，只用于拼中文 prompt 和数字白名单校验，
 * 不会原样发给模型；没有公司名、URL 或原文。
 */
export interface CareerBriefInputV1 {
  as_of: string;
  window_days: number;
  sample_size: number;
  observation_days: number;
  /** 技能占比的分母：有技能的岗位数（未识别技能的岗位不进分母）。 */
  skills_sample_size: number;
  directions: CareerCatalogResponseDirectionsV1;
  titles: CareerCatalogResponseTitlesV1;
  skills: CareerCatalogResponseSkillsV1;
  evidence_candidates: CareerBriefEvidenceV1[];
}

/** 模型可见的输入：名称全部是中文展示值，占比是百分比字符串，只有可引用证据保留编号。 */
interface CareerBriefPromptInputV1 {
  数据截止: string;
  观察窗天数: number;
  样本量: number;
  观测日数: number;
  /** 技能占比的分母：有技能的岗位数，模型引用占比时必须一并说明。 */
  技能占比分母: number;
  方向: Array<{
    职族: string;
    岗位数: number;
    公司数: number;
    观察窗内新增岗位数: number;
    学生友好岗位数: number;
    主要技能: string[];
  }>;
  职位: Array<{
    职位名称: string;
    岗位数: number;
    公司数: number;
    城市: string[];
    主要技能: string[];
    学生友好岗位数: number;
  }>;
  技能: Array<{
    技能: string;
    岗位数: number;
    占比: string;
  }>;
  可引用证据: Array<{
    类型: "岗位" | "政策";
    编号: string;
    标题: string;
  }>;
}

type CareerCatalogResponseDirectionsV1 = Awaited<ReturnType<typeof loadCareerCatalog>>["directions"];
type CareerCatalogResponseTitlesV1 = Awaited<ReturnType<typeof loadCareerCatalog>>["titles"];
type CareerCatalogResponseSkillsV1 = Awaited<ReturnType<typeof loadCareerCatalog>>["skills"];

export interface CareerBriefDraftV1 {
  facts: string[];
  inferences: string[];
  actions: string[];
  limitations: string[];
  confidence: string;
  evidence: CareerBriefEvidenceV1[];
}

export interface CareerBriefRecordV1 extends CareerBriefV1 {
  observation_days: number;
  prompt_version: string;
  receipt_id: number | null;
  model: string | null;
}

export class CareerBriefValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CareerBriefValidationError";
  }
}

export interface CareerBriefInputOptions {
  limit: number;
  window_days: number;
}

interface ObservationDaysRow {
  days: number;
}

interface JobEvidenceRow {
  id: string;
  title: string;
}

interface SkillsSampleRow {
  count: number;
}

interface PolicyEvidenceRow {
  id: string;
  title: string;
}

export async function buildCareerBriefInput(db: Db, options: CareerBriefInputOptions): Promise<CareerBriefInputV1> {
  const catalogOptions: CareerCatalogOptions = { limit: options.limit, window_days: options.window_days };
  const [catalog, observationDays, skillsSample, jobEvidence, policyEvidence] = await Promise.all([
    loadCareerCatalog(db, catalogOptions),
    db<ObservationDaysRow[]>`
      SELECT COUNT(DISTINCT (observed_at AT TIME ZONE ${BEIJING_TIMEZONE})::date)::int AS days
      FROM career_job_observations`,
    // 技能占比的分母，与 loadCareerCatalog 的 skills[].share 同口径：只算有技能的岗位。
    db<SkillsSampleRow[]>`
      SELECT COUNT(*)::int AS count
      FROM career_jobs
      WHERE jsonb_typeof(skills) = 'array' AND jsonb_array_length(skills) > 0`,
    db<JobEvidenceRow[]>`
      SELECT id::text AS id, title
      FROM career_jobs
      ORDER BY last_seen_at DESC, id ASC
      LIMIT ${JOB_EVIDENCE_LIMIT}`,
    db<PolicyEvidenceRow[]>`
      SELECT id::text AS id, title
      FROM career_policies
      WHERE ${careerPolicyRelevanceSql()}
      ORDER BY last_seen_at DESC, id ASC
      LIMIT ${POLICY_EVIDENCE_LIMIT}`,
  ]);

  return {
    as_of: catalog.as_of,
    window_days: catalog.window_days,
    sample_size: catalog.sample_size,
    observation_days: observationDays[0]?.days ?? 0,
    skills_sample_size: skillsSample[0]?.count ?? 0,
    directions: catalog.directions,
    titles: catalog.titles,
    skills: catalog.skills,
    evidence_candidates: [
      ...jobEvidence.map((row) => ({ kind: "job" as const, id: row.id, title: row.title })),
      ...policyEvidence.map((row) => ({ kind: "policy" as const, id: row.id, title: row.title })),
    ],
  };
}

/** 技能 id → 中文展示名；词典里没有的技能不展示，避免把内部 id 写进 prompt。 */
function skillLabel(skill: string): string | null {
  return SKILL_LABELS[skill] ?? null;
}

function skillLabels(skills: ReadonlyArray<{ skill: string }>): string[] {
  const labels: string[] = [];
  for (const entry of skills) {
    const label = skillLabel(entry.skill);
    if (label !== null) labels.push(label);
  }
  return labels;
}

/** 一位小数的百分比，与日报评论同一写法；模型可以直接引用这个字符串。 */
function percentText(share: number): string {
  return (share * 100).toFixed(1) + "%";
}

/** 把内部聚合输入翻成模型可见的中文输入：不出现职族/技能 id 和小数占比。 */
function buildCareerBriefPromptInput(input: CareerBriefInputV1): CareerBriefPromptInputV1 {
  return {
    数据截止: input.as_of,
    观察窗天数: input.window_days,
    样本量: input.sample_size,
    观测日数: input.observation_days,
    技能占比分母: input.skills_sample_size,
    方向: input.directions.map((entry) => ({
      职族: ROLE_FAMILY_LABELS[entry.role_family],
      岗位数: entry.job_count,
      公司数: entry.company_count,
      观察窗内新增岗位数: entry.new_in_window,
      学生友好岗位数: entry.student_friendly_count,
      主要技能: skillLabels(entry.top_skills),
    })),
    职位: input.titles.map((entry) => ({
      职位名称: entry.title_display,
      岗位数: entry.job_count,
      公司数: entry.company_count,
      城市: entry.cities,
      主要技能: skillLabels(entry.top_skills),
      学生友好岗位数: entry.student_friendly_count,
    })),
    技能: input.skills.flatMap((entry) => {
      const label = skillLabel(entry.skill);
      return label === null ? [] : [{ 技能: label, 岗位数: entry.job_count, 占比: percentText(entry.share) }];
    }),
    可引用证据: input.evidence_candidates.map((candidate) => ({
      类型: candidate.kind === "job" ? ("岗位" as const) : ("政策" as const),
      编号: candidate.id,
      标题: candidate.title,
    })),
  };
}

export function buildCareerBriefPrompt(input: CareerBriefInputV1): { system: string; user: string } {
  return { system: SYSTEM_PROMPT, user: JSON.stringify(buildCareerBriefPromptInput(input)) };
}

/**
 * 确定性中文化：把模型输出里残留的职族/技能 id 与常见英文字段名换成中文展示值。
 * 长 id 优先匹配，两侧词边界保证 Google、email、metadata、database 这类普通英文词不受影响。
 */
function localizeDomainTerms(text: string): string {
  return text.replace(DOMAIN_TERM_PATTERN, (match) => DOMAIN_TERM_REPLACEMENTS.get(match.toLowerCase()) ?? match);
}

/**
 * 兜底校验：正文里出现任何 snake_case 形态的内部标识就判模型输出不合规（而不是静默放过）。
 * 中文化替换表负责已知 id，这里负责替换表之外的未知 id：两者用不同的判定依据，互相独立，
 * 所以断言是可达的（删掉它，含 rust_engineer 的输出会从「失败」变成「写库」，测试会红）。
 */
function assertNoInternalTerms(texts: readonly string[]): void {
  for (const text of texts) {
    for (const match of text.matchAll(INTERNAL_IDENTIFIER_PATTERN)) {
      const identifier = match[1]!;
      if (identifier.length < MIN_INTERNAL_IDENTIFIER_CHARS) continue;
      if (DISPLAY_NAME_WHITELIST.has(identifier)) continue;
      throw new CareerBriefValidationError(
        `Model output contains an internal identifier: ${identifier} (context: ${text.slice(0, CONTEXT_CHARS)}).`,
      );
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textItems(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) throw new CareerBriefValidationError(`Model output field ${field} must be an array of strings.`);
  return value.map((item) => {
    if (typeof item !== "string" || item.trim() === "") {
      throw new CareerBriefValidationError(`Model output field ${field} must contain non-empty strings.`);
    }
    return item.trim();
  });
}

/** facts 超过 60 字时截断，并用省略号标出被切开的位置（避免在半句或数字中间无声硬切）。 */
function clampFact(text: string): string {
  const characters = [...text];
  if (characters.length <= MAX_FACT_CHARS) return text;
  return characters.slice(0, MAX_FACT_CHARS - 1).join("") + "…";
}

interface NumberToken {
  raw: string;
  value: number;
  percent: boolean;
  digits: number;
  index: number;
}

/** 聚合输入里的数字可能嵌在对象与数组内（如 skills[].share），全部收集为可引用值。 */
function collectNumbers(value: unknown, out: number[]): void {
  if (typeof value === "number") {
    if (Number.isFinite(value)) out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectNumbers(item, out);
    return;
  }
  if (isRecord(value)) {
    for (const item of Object.values(value)) collectNumbers(item, out);
  }
}

/**
 * 输入里所有字符串值中的连续数字片段（证据标题的职位号如 J107214、方向/技能 id、UUID 等）。
 * 这些字符串本身就是模型输入的一部分，模型引用其中的数字是 grounded 的，不能判成编造。
 * 但只在 token 与片段精确相等时放行，输入里没有的数字（如 999）仍然会被拒绝。
 */
function collectStringNumberFragments(value: unknown, out: Set<string>): void {
  if (typeof value === "string") {
    for (const fragment of value.match(/\d+/gu) ?? []) out.add(fragment);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStringNumberFragments(item, out);
    return;
  }
  if (isRecord(value)) {
    for (const item of Object.values(value)) collectStringNumberFragments(item, out);
  }
}

/** token 的纯数字文本（去掉千分位逗号与百分号），用于与输入字符串里的数字片段精确匹配。 */
function tokenDigitText(token: NumberToken): string {
  return token.raw.replaceAll(",", "").replace(/%$/u, "");
}

function decimalDigits(raw: string): number {
  const dot = raw.indexOf(".");
  return dot < 0 ? 0 : raw.length - dot - 1;
}

function numberTokens(text: string): NumberToken[] {
  const tokens: NumberToken[] = [];
  for (const match of text.matchAll(NUMBER_TOKEN)) {
    const digitsPart = match[1]!.replaceAll(",", "");
    const value = Number(digitsPart);
    if (!Number.isFinite(value)) continue;
    tokens.push({
      raw: match[0],
      value,
      percent: match[2] === "%",
      digits: decimalDigits(digitsPart),
      index: match.index ?? 0,
    });
  }
  return tokens;
}

function nearEquals(value: number, target: number): boolean {
  return Math.abs(value - target) <= Math.max(RELATIVE_TOLERANCE, Math.abs(target) * RELATIVE_TOLERANCE);
}

function equalAt(value: number, target: number, digits: number): boolean {
  const factor = 10 ** digits;
  return Math.round(value * factor) === Math.round(target * factor);
}

/** 日期文本（as_of、日报的数据日期）里的年、月、日片段可以原样引用，不算编造。 */
function dateTokens(dateTexts: readonly string[]): Set<number> {
  const tokens = new Set<number>();
  for (const text of dateTexts) {
    for (const match of text.matchAll(DATE_TOKEN)) tokens.add(Number(match[0]));
  }
  return tokens;
}

function isDateToken(token: NumberToken, dates: ReadonlySet<number>): boolean {
  if (!Number.isInteger(token.value)) return false;
  return dates.has(token.value) || (token.value >= YEAR_MIN && token.value <= YEAR_MAX);
}

/**
 * 引用判定：token 与输入字符串里的数字片段精确相等、等于某个数值、日期片段，
 * 或按输出自身精度舍入后相等。
 * 0.426573… 可被引成 0.4266（4 位）、0.43、42.7%、42.66%；
 * 整数（0 位小数）只认精确相等，因此 43%（把 42.65% 粗舍）会被拒绝。
 */
function matchesKnownNumber(
  token: NumberToken,
  known: readonly number[],
  dates: ReadonlySet<number>,
  stringFragments: ReadonlySet<string>,
): boolean {
  if (stringFragments.has(tokenDigitText(token))) return true;
  if (isDateToken(token, dates)) return true;
  return known.some((value) => {
    if (!Number.isFinite(value)) return false;
    if (nearEquals(token.value, value)) return true;
    if (nearEquals(token.value / 100, value)) return true;
    if (token.digits === 0) return false;
    if (equalAt(token.percent ? value * 100 : value, token.value, token.digits)) return true;
    return token.percent ? false : equalAt(value * 100, token.value, token.digits);
  });
}

function numberContext(text: string, token: NumberToken): string {
  const start = Math.max(0, token.index - CONTEXT_PADDING);
  const end = Math.min(text.length, token.index + token.raw.length + CONTEXT_PADDING);
  const snippet = text.slice(start, end).replace(/\s+/g, " ").trim();
  const characters = [...snippet];
  return characters.length <= CONTEXT_CHARS ? snippet : characters.slice(0, CONTEXT_CHARS).join("");
}

/**
 * 数字白名单校验（就业研判与日报 AI 评论共用）：values 里所有数值、以及所有字符串值里的连续数字片段
 * 都可以被引用；dateTexts 里的年/月/日片段同样放行。引用判定的精度规则见 matchesKnownNumber。
 */
export function assertKnownNumbers(values: unknown, dateTexts: readonly string[], texts: readonly string[]): void {
  const known: number[] = [];
  collectNumbers(values, known);
  const stringFragments = new Set<string>();
  collectStringNumberFragments(values, stringFragments);
  const dates = dateTokens(dateTexts);
  for (const text of texts) {
    for (const token of numberTokens(text)) {
      if (matchesKnownNumber(token, known, dates, stringFragments)) continue;
      throw new CareerBriefValidationError(
        `Model output contains a number absent from the aggregate input: ${token.raw} (context: ${numberContext(text, token)}).`,
      );
    }
  }
}

function assertOnlyKnownNumbers(input: CareerBriefInputV1, texts: readonly string[]): void {
  assertKnownNumbers(input, [input.as_of], texts);
}

function parseConfidence(value: unknown): CareerBriefV1["confidence"] {
  if (typeof value === "string" && (CONFIDENCE_VALUES as readonly string[]).includes(value)) {
    return value as CareerBriefV1["confidence"];
  }
  throw new CareerBriefValidationError(`Model output confidence must be one of ${CONFIDENCE_VALUES.join(", ")}.`);
}

function knownEvidence(input: CareerBriefInputV1, value: unknown): CareerBriefEvidenceV1[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new CareerBriefValidationError("Model output field evidence must be an array.");
  const candidates = new Map(input.evidence_candidates.map((candidate) => [`${candidate.kind}:${candidate.id}`, candidate]));
  const evidence: CareerBriefEvidenceV1[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!isRecord(item) || typeof item.id !== "string") continue;
    if (item.kind !== "job" && item.kind !== "policy") continue;
    const key = `${item.kind}:${item.id}`;
    const candidate = candidates.get(key);
    // 模型只能引用输入里的 id；title 以库内为准，不采信模型回写的标题。
    if (candidate === undefined || seen.has(key)) continue;
    seen.add(key);
    evidence.push({ kind: candidate.kind, id: candidate.id, title: candidate.title });
  }
  return evidence;
}

export interface ComposeCareerBriefOptions {
  generated_at: string;
  prompt_version?: string;
  receipt_id?: number | null;
  model?: string | null;
}

/**
 * 把模型草稿变成可缓存的记录：先把残留的内部英文标识换成中文（再校验没有残留），
 * 然后截断 facts、丢弃输入外的证据、校验数字来源，观测日不足两个时强制 low 置信度并移除走势断言。
 */
export function composeCareerBrief(
  input: CareerBriefInputV1,
  rawDraft: unknown,
  options: ComposeCareerBriefOptions,
): CareerBriefRecordV1 {
  if (!isRecord(rawDraft)) throw new CareerBriefValidationError("Model output must be a JSON object.");
  const localizedFacts = textItems(rawDraft.facts, "facts").map(localizeDomainTerms);
  let inferences = textItems(rawDraft.inferences, "inferences").map(localizeDomainTerms);
  let limitations = textItems(rawDraft.limitations, "limitations").map(localizeDomainTerms);
  const actions = textItems(rawDraft.actions, "actions").map(localizeDomainTerms);
  const evidence = knownEvidence(input, rawDraft.evidence);
  assertNoInternalTerms([...localizedFacts, ...inferences, ...actions, ...limitations]);
  assertOnlyKnownNumbers(input, [...localizedFacts, ...inferences, ...actions, ...limitations]);
  const facts = localizedFacts.map(clampFact);

  const earlyObservation = input.observation_days < MIN_OBSERVATION_DAYS;
  const confidence = earlyObservation ? "low" : parseConfidence(rawDraft.confidence);
  if (earlyObservation) {
    inferences = inferences.filter((item) => !TREND_TERMS.some((term) => item.toLowerCase().includes(term)));
    if (inferences.length === 0) inferences = [EARLY_INFERENCE];
    if (!limitations.includes(EARLY_LIMITATION)) limitations = [...limitations, EARLY_LIMITATION];
  }
  if (!inferences.some((item) => WINDOW_WORDS.some((word) => item.includes(word)))) {
    inferences.push(`以上基于 ${input.window_days} 天观察窗，置信度：${CONFIDENCE_LABELS[confidence]}。`);
  }

  return {
    contract_version: CAREER_BRIEF_CONTRACT_VERSION,
    generated_at: options.generated_at,
    as_of: input.as_of,
    sample_size: input.sample_size,
    window_days: input.window_days,
    facts,
    inferences,
    actions,
    evidence,
    limitations,
    confidence,
    observation_days: input.observation_days,
    prompt_version: options.prompt_version ?? CAREER_BRIEF_PROMPT_VERSION,
    receipt_id: options.receipt_id ?? null,
    model: options.model ?? null,
  };
}

interface CareerBriefRow {
  as_of: Date;
  generated_at: Date;
  sample_size: number;
  window_days: number;
  confidence: string;
  facts: string[];
  inferences: string[];
  actions: string[];
  evidence: CareerBriefEvidenceV1[];
  limitations: string[];
}

export async function loadCareerBrief(db: Db): Promise<CareerBriefV1 | null> {
  const rows = await db<CareerBriefRow[]>`
    SELECT as_of, generated_at, sample_size, window_days, confidence, facts, inferences, actions, evidence, limitations
    FROM career_briefs
    ORDER BY generated_at DESC, as_of DESC, prompt_version DESC
    LIMIT 1`;
  const row = rows[0];
  if (row === undefined) return null;
  return {
    contract_version: CAREER_BRIEF_CONTRACT_VERSION,
    generated_at: new Date(row.generated_at).toISOString(),
    as_of: new Date(row.as_of).toISOString(),
    sample_size: row.sample_size,
    window_days: row.window_days,
    facts: row.facts,
    inferences: row.inferences,
    actions: row.actions,
    evidence: row.evidence,
    limitations: row.limitations,
    confidence: row.confidence as CareerBriefV1["confidence"],
  };
}

export async function saveCareerBrief(db: Db, record: CareerBriefRecordV1): Promise<void> {
  await db`
    INSERT INTO career_briefs (
      contract_version, as_of, generated_at, sample_size, window_days, observation_days, prompt_version,
      confidence, facts, inferences, actions, evidence, limitations, receipt_id, model
    ) VALUES (
      ${record.contract_version}, ${record.as_of}, ${record.generated_at}, ${record.sample_size},
      ${record.window_days}, ${record.observation_days}, ${record.prompt_version}, ${record.confidence},
      ${db.json(record.facts)}::jsonb, ${db.json(record.inferences)}::jsonb, ${db.json(record.actions)}::jsonb,
      ${db.json(record.evidence)}::jsonb, ${db.json(record.limitations)}::jsonb, ${record.receipt_id}, ${record.model}
    )
    ON CONFLICT (as_of, prompt_version) DO UPDATE SET
      contract_version = EXCLUDED.contract_version,
      generated_at = EXCLUDED.generated_at,
      sample_size = EXCLUDED.sample_size,
      window_days = EXCLUDED.window_days,
      observation_days = EXCLUDED.observation_days,
      confidence = EXCLUDED.confidence,
      facts = EXCLUDED.facts,
      inferences = EXCLUDED.inferences,
      actions = EXCLUDED.actions,
      evidence = EXCLUDED.evidence,
      limitations = EXCLUDED.limitations,
      receipt_id = EXCLUDED.receipt_id,
      model = EXCLUDED.model,
      updated_at = now()`;
}

export interface CareerBriefModelResultV1 {
  draft: unknown;
  receipt_id?: number | null;
  model?: string | null;
}

export type CareerBriefLlmCaller = (
  input: CareerBriefInputV1,
  prompt: { system: string; user: string },
) => Promise<CareerBriefModelResultV1>;

export interface GenerateCareerBriefOptions {
  limit: number;
  window_days: number;
  prompt_version?: string;
  dry_run?: boolean;
  now?: () => Date;
}

/** 无样本时不调用模型也不写库，返回 null。 */
export async function generateCareerBrief(
  db: Db,
  callLlm: CareerBriefLlmCaller,
  options: GenerateCareerBriefOptions,
): Promise<CareerBriefRecordV1 | null> {
  const input = await buildCareerBriefInput(db, { limit: options.limit, window_days: options.window_days });
  if (input.sample_size === 0) return null;
  const result = await callLlm(input, buildCareerBriefPrompt(input));
  const record = composeCareerBrief(input, result.draft, {
    generated_at: (options.now ?? (() => new Date()))().toISOString(),
    ...(options.prompt_version === undefined ? {} : { prompt_version: options.prompt_version }),
    receipt_id: result.receipt_id ?? null,
    model: result.model ?? null,
  });
  if (options.dry_run !== true) await saveCareerBrief(db, record);
  return record;
}