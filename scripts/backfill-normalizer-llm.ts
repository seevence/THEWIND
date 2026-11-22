// 一次性回填：对 career_jobs 中职族/学生友好度未知或技能为空的行，调用模型做归一化兜底。
// node scripts/backfill-normalizer-llm.ts                  默认 dry-run，会真实调用模型但不写库
// node scripts/backfill-normalizer-llm.ts --apply          逐行独立事务写入，失败行不影响其它行
// node scripts/backfill-normalizer-llm.ts --limit 5        限制本次处理的行数
// node scripts/backfill-normalizer-llm.ts --rerun-aipo --apply
//   只重判「当前是 ai_product_operations 且标题命中非 AI 领域词」的嫌疑行，其余行不动；用同一套
//   prompt + 后置校验，降级为 unknown 并写回版本号，因此重复执行是幂等的。
// 只更新 role_family / student_friendly / skills / experience_min_years / experience_max_years /
// normalizer_version / updated_at；不写 career_job_observations，不动 last_seen_at / content_hash /
// created_at / raw_payload 等来源侧字段。日志只输出 job id 与 title，不输出 JD 正文或密钥。
//
// 数据安全：模型输出只做增量。skills 与既有值取并集，经验年限仅在模型给出非 null 时覆盖，
// role_family / student_friendly 仅在既有为 unknown 时才接受模型的 unknown。模型是低置信兜底，
// 用它抹掉已确认的结构化字段是净损失，因此宁可少改也不回退既有数据。
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import postgres, { type JSONValue } from "postgres";
import { z } from "zod";
import type {
  RoleFamily,
  StudentFriendly,
} from "../modules/career-insights/contracts/index.ts";
import { SKILL_ALIASES, SKILL_LABELS } from "../modules/career-insights/data/dictionaries.ts";
import { LLM_NORMALIZER_VERSION } from "../modules/career-insights/data/normalize.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");

// 0.3 收紧了 aipo 正文主体短语豁免。版本号前进，让默认回填重新审视旧版本行。
// 版本号定义在模块的 data/normalize.ts 里，每日 cron 兜底与手工回填共用；这里保持既有导出。
export { LLM_NORMALIZER_VERSION };
export const LLM_PURPOSE = "career-normalize";
export const LLM_PROMPT_VERSION = "career-normalize/2";
export const LLM_MODEL = "default";
export const LLM_MAX_TOKENS = 512;
export const LLM_TIMEOUT_MS = 60_000;
export const MAX_LLM_SKILLS = 8;
export const DESCRIPTION_LIMIT = 1500;
export const DEFAULT_CONCURRENCY = 3;

export const ROLE_FAMILY_VALUES = [
    "ai_algorithm",
  "ai_application_development",
  "data",
  "ai_product_operations",
  "hardware_engineering",
  "manufacturing_quality",
  "sales_business",
  "corporate_functions",
  "unknown",
] as const;
export const STUDENT_FRIENDLY_VALUES = ["yes", "no", "unknown"] as const;

/** 标题命中这些词说明岗位主体就是 AI/搜索推荐，后置校验不降级。 */
export const AI_TITLE_TERMS = [
  "ai",
  "人工智能",
  "大模型",
  "算法",
  "机器学习",
  "深度学习",
  "llm",
  "agent",
  "智能体",
  "智能产品",
  "智能硬件",
  "搜索",
  "推荐",
  "搜推",
  "数据标注",
  "模型",
] as const;

/**
 * 正文命中这些短语说明职责主体是 AI 产品/能力（例如“负责大模型产品的运营”），后置校验不降级。
 * 只出现“AI 工具/大模型工具/AI 辅助/AI 提效/智能客服/智能质检”等使用型说法不在此列——这正是
 * 传统运营岗被误判成 aipo 的根源。“AI 应用机会”“AI 产品形态”等探索/任职要求语境也不构成豁免。
 */
export const AI_SUBJECT_PHRASES = [
  "ai产品经理",
  "ai产品运营",
  "ai产品开发",
  "ai产品设计",
  "ai产品规划",
  "ai产品策划",
  "ai产品功能",
  "大模型产品",
  "ai应用开发",
  "大模型应用",
  "ai平台",
  "大模型平台",
  "算法工程",
  "算法研发",
  "算法策略",
  "推荐算法",
  "搜索算法",
  "模型训练",
  "模型微调",
  "机器学习工程",
  "深度学习",
  "智能体开发",
  "智能体搭建",
  "agent搭建",
  "提示词工程",
  "prompt工程",
  "大模型研发",
] as const;

/** 标题命中这些词视为传统岗位：AI 不是岗位主体。 */
export const NON_AI_DOMAIN_TERMS = [
  "运营",
  "采购",
  "客服",
  "市场",
  "营销",
  "推广",
  "投放",
  "渠道",
  "人力",
  "hr",
  "行政",
  "助理",
  "品控",
  "供应链",
  "物流",
  "门店",
  "家装",
  "建材",
  "厨具",
  "社区",
  "赛事",
  "电竞",
  "商务",
  "销售",
  "电销",
  "权益",
  "策略",
  "经营",
  "履约",
  "外包",
  "顾问",
  "教研",
  "培训",
  // 第二轮收紧：传统产品/架构/策划/售前职能岗的标题主体。故意不含裸「产品」——AI 产品经理是真正的 aipo。
  "产品经理",
  "产品策划",
  "产品专家",
  "架构师",
  "解决方案",
  "合作商",
  "方案策划",
  "客户经理",
  "项目管理",
  "实施",
  "operations",
  "supply",
  "logistics",
  "sales",
  "marketing",
  "support",
] as const;

/** 中文文本里空白不携带语义（“AI 产品” 与 “AI产品” 是同一个词），比较前统一压缩。 */
function squeeze(text: string): string {
  return text.toLowerCase().replace(/\s+/gu, "");
}

/** 纯 ASCII 词要求词边界，避免 “email”/“maintain” 里的 ai 被当成 AI 关键词。 */
function containsTerm(text: string, squeezed: string, term: string): boolean {
  const needle = squeeze(term);
  if (needle === "") return false;
  if (/^[a-z0-9]+$/.test(needle)) {
    // ASCII 词必须在**压缩空白前**的文本上判断词边界：squeeze 会把 “AI Agent” 变成 “aiagent”，
    // 于是 “…ai([^a-z0-9])” 永远不命中，AI Agent / AI Coding 这类标题会被误判成非 AI 主体。
    return new RegExp(`(^|[^a-z0-9])${needle}([^a-z0-9]|$)`, "u").test(text.toLowerCase());
  }
  return squeezed.includes(needle);
}

export function firstMatchingTerm(text: string, terms: readonly string[]): string | null {
  const squeezed = squeeze(text);
  for (const term of terms) {
    if (containsTerm(text, squeezed, term)) return term;
  }
  return null;
}

/**
 * 任职要求/资格行不是「岗位职责主体」的证据：那是对候选人的经历要求，不是这个岗位做什么。
 * 例：「优先具备…大模型平台…项目经验」「对 AI 产品形态有真实的实践」不能拿来豁免降级。
 */
const REQUIREMENT_LINE = /优先|具备|熟悉|掌握|了解|能够|任职|要求|资格|学历|经验|加分/u;

export function responsibilityText(rawText: string): string {
  return (rawText ?? "")
    .split(/\r?\n/u)
    .filter((line) => line.trim() !== "" && !REQUIREMENT_LINE.test(line))
    .join("\n");
}

export interface DowngradeDecision {
  role_family: RoleFamily;
  downgraded: boolean;
  /** 命中的非 AI 领域词，写进日志便于审计。 */
  domainTerm: string | null;
}

/**
 * 确定性后置校验：模型把传统岗位判成 ai_product_operations 时回退为 unknown。
 * 判定顺序是「标题是不是 AI 主体 → 标题是不是传统领域 → 正文有没有 AI 主体职责」，
 * 任一条不满足就保持模型结果；只有三条都指向“AI 只是工具”时才降级。
 */
export function downgradeNonAiOperations(
  job: Pick<CareerJobRow, "title" | "raw_text">,
  result: Pick<LlmNormalization, "role_family">,
): DowngradeDecision {
  const keep: DowngradeDecision = { role_family: result.role_family, downgraded: false, domainTerm: null };
  if (result.role_family !== "ai_product_operations") return keep;
  const title = job.title ?? "";
  if (firstMatchingTerm(title, AI_TITLE_TERMS) !== null) return keep;
  const domainTerm = firstMatchingTerm(title, NON_AI_DOMAIN_TERMS);
  if (domainTerm === null) return keep;
  if (firstMatchingTerm(responsibilityText(job.raw_text ?? ""), AI_SUBJECT_PHRASES) !== null) return keep;
  return { role_family: "unknown", downgraded: true, domainTerm };
}

/** 模型输出必须整行通过校验；枚举越界、多出字段、min > max 都判该行失败，不猜。 */
export const llmNormalizationSchema = z
  .object({
    role_family: z.enum(ROLE_FAMILY_VALUES),
    student_friendly: z.enum(STUDENT_FRIENDLY_VALUES),
    skills: z.array(z.string()).max(MAX_LLM_SKILLS),
    experience_min_years: z.number().int().min(0).max(50).nullable(),
    experience_max_years: z.number().int().min(0).max(50).nullable(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.experience_min_years !== null &&
      value.experience_max_years !== null &&
      value.experience_min_years > value.experience_max_years
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["experience_min_years"],
        message: "experience_min_years must not exceed experience_max_years",
      });
    }
  });

export type LlmNormalization = z.infer<typeof llmNormalizationSchema>;

/** 允许写入 career_jobs 的列（除 normalizer_version / updated_at 外的业务字段）。 */
export interface LlmNormalizedFields {
  role_family: RoleFamily;
  student_friendly: StudentFriendly;
  skills: string[];
  experience_min_years: number | null;
  experience_max_years: number | null;
}

export interface CareerJobRow {
  id: string;
  title: string;
  raw_text: string;
  degree_raw: string | null;
  experience_raw: string | null;
  skills: string[] | null;
  experience_min_years: number | null;
  experience_max_years: number | null;
  role_family: string;
  student_friendly: string;
  normalizer_version: string;
}

export interface LlmRequest {
  subject: string;
  system: string;
  user: string;
}

export interface LlmResponse {
  data: unknown;
  usage?: Record<string, unknown> | null;
}

export type LlmCaller = (request: LlmRequest) => Promise<LlmResponse>;

export interface CandidateStore {
  listCandidates(limit: number | null): Promise<CareerJobRow[]>;
  /** --rerun-aipo 的候选：当前 aipo 且标题命中非 AI 领域词的嫌疑行。 */
  listRerunAipoCandidates(limit: number | null): Promise<CareerJobRow[]>;
  /** --force-ids 的候选：按完整 id 直接取行，不受版本与本轮兜底范围限制（定向修复用）。 */
  listByIds(ids: readonly string[]): Promise<CareerJobRow[]>;
  /** 单行独立事务；返回实际更新行数（0 表示该行已被别的进程改过）。force 时跳过版本护栏。 */
  updateLlmFields(id: string, fields: LlmNormalizedFields, force?: boolean): Promise<number>;
}

export interface RunSummary {
  candidates: number;
  called: number;
  changed: number;
  unchanged: number;
  /** 最终失败（含 schema 非法），这些行不会被写入。 */
  failed: number;
  /** 最终失败中因 schema/枚举不合法的行数。 */
  schemaRejected: number;
  calls: number;
  retries: number;
  droppedSkillTerms: number;
  /** 被后置校验从 ai_product_operations 回退为 unknown 的行数。 */
  downgraded: number;
  /** --rerun-aipo 下模型重判为 unknown、撤销既有 aipo 的行数（后置校验之外的另一条降级路径）。 */
  revoked: number;
  usage: { prompt_tokens: number; completion_tokens: number };
  /** 未返回 usage 的调用次数：这些调用的 token 未计入上面的 usage。 */
  usageMissingCalls: number;
}

export interface RunOptions {
  apply: boolean;
  limit: number | null;
  callLlm: LlmCaller;
  store: CandidateStore;
  concurrency?: number;
  /** 只重判 aipo 嫌疑行；不影响其余行。 */
  rerunAipo?: boolean;
  /** 在候选查询后、模型调用前按完整 id 过滤。 */
  onlyIds?: readonly string[];
  /** --force-ids：只处理 onlyIds 指定的行，且跳过“版本已是当前版本就不写”的护栏（显式定向修复）。 */
  force?: boolean;
  log?: (line: string) => void;
}

interface RowOutcome {
  row: CareerJobRow;
  status: "ok" | "failed";
  fields?: LlmNormalizedFields;
  unchanged?: boolean;
  downgraded?: boolean;
  revoked?: boolean;
  droppedSkillTerms?: number;
  usage?: { prompt_tokens: number; completion_tokens: number };
  failure?: string;
  schemaRejected?: boolean;
  usageMissingCalls?: number;
  calls: number;
  retries: number;
}

/** 与 SQL 选行条件保持一致，供内存实现与测试复用。 */
export function needsLlmNormalization(row: Pick<CareerJobRow, "role_family" | "student_friendly" | "skills">): boolean {
  return (
    row.role_family === "unknown" ||
    row.student_friendly === "unknown" ||
    row.skills === null ||
    row.skills.length === 0
  );
}

/** 与 --rerun-aipo 的 SQL 条件保持一致，供内存实现与测试复用。 */
export function isRerunAipoCandidate(
  row: Pick<CareerJobRow, "title" | "role_family" | "normalizer_version">,
): boolean {
  if (row.role_family !== "ai_product_operations") return false;
  if (row.normalizer_version === LLM_NORMALIZER_VERSION) return false;
  const title = row.title ?? "";
  if (firstMatchingTerm(title, AI_TITLE_TERMS) !== null) return false;
  return firstMatchingTerm(title, NON_AI_DOMAIN_TERMS) !== null;
}

function skillVocabulary(): string {
  return Object.entries(SKILL_LABELS)
    .map(([id, label]) => `${id}（${label}）`)
    .join("、");
}

export const SYSTEM_PROMPT = [
  "你是招聘岗位信息归一化分类器。只依据给定文本做分类，不得编造文本中没有出现的信息；",
  "无法判断时输出 \"unknown\" 或 null，不要猜测。",
  "",
  "role_family 只能取以下 9 类之一：",
  "- ai_algorithm：算法/机器学习/深度学习/NLP/计算机视觉/推荐搜索算法",
  "- ai_application_development：前后端/服务端/客户端/全栈/测试开发/AI 应用工程",
  "- data：数据分析/数据开发/数据仓库/大数据/BI/数据科学",
  "- ai_product_operations：AI 产品/产品经理/产品运营/增长运营",
  "- hardware_engineering：硬件/电子/机械/结构/射频/FPGA/芯片/PCB/光学/封装",
  "- manufacturing_quality：制造/工艺/生产/设备/质量/品质/装配/技工",
  "- sales_business：销售/商务/客户经理/渠道/市场/售前",
  "- corporate_functions：财务/会计/人力/行政/法务/采购/供应链/审计",
  "- unknown：文本不足以判断",
  "",
  "★ 传统岗位即便职责里提到“使用 AI 工具/AI 提效/AI 赋能/AI 辅助”，也属于使用 AI 而不是做 AI 产品，",
  "  必须按实际职能归类，不得判成 ai_product_operations：销售/商务/渠道/市场 → sales_business；",
  "  财务/人力/行政/法务/采购/供应链 → corporate_functions；制造/工艺/质量/设备 → manufacturing_quality；",
  "  硬件/电子/机械/结构/射频/FPGA/芯片 → hardware_engineering；客服、门店、助理等无法归入上述职能时才判 unknown。",
  "只有 title 或职责明确以 AI 产品、大模型、算法、机器学习、智能产品为对象（做这些产品的运营/产品/研发），",
  "才判 ai_product_operations / ai_application_development / ai_algorithm。",
  "",
  "student_friendly 只能取 yes|no|unknown：",
  "- yes：校招/实习，或明确接受应届/在校生/经验不限，或明确 0-1 年经验",
  "- no：明确不接受应届，或明确要求 2 年以上，或资深/专家且无学生入口",
  "- unknown：其他；未写经验的初级岗位不能判为 yes",
  "",
  `skills 只能从下列技能 ID 中选择，最多 ${MAX_LLM_SKILLS} 个，只选文本明确出现或明确要求的技能：`,
  skillVocabulary(),
  "",
  "experience_min_years / experience_max_years：只填文本中明确写出的年限整数，未写则为 null；",
  "不得把“未写”当成 0 年，也不得把“经验不限”当成 0 年。",
  "",
  "只输出一个 JSON 对象，不要输出解释：",
  `{"role_family":"...","student_friendly":"...","skills":["..."],"experience_min_years":null,"experience_max_years":null}`,
].join("\n");

/** 输入只含 title、raw_text 前 1500 字、学历/经验原文与现有技能，不含 company/url 等无关字段。 */
export function buildUserPrompt(row: CareerJobRow): string {
  return JSON.stringify({
    title: row.title,
    description: row.raw_text.slice(0, DESCRIPTION_LIMIT),
    degree_raw: row.degree_raw,
    experience_raw: row.experience_raw,
    existing_skills: row.skills ?? [],
  });
}


/** 模型给的技能词按既有词表映射；映射不上的丢弃并返回，供汇总计数。 */
export function mapSkillsToKnown(terms: readonly string[]): { skills: string[]; dropped: string[] } {
  const knownIds = new Set(Object.keys(SKILL_LABELS));
  const skills: string[] = [];
  const dropped: string[] = [];
  for (const term of terms) {
    const key = term.trim().toLowerCase();
    if (key === "") {
      dropped.push(term);
      continue;
    }
    const id = knownIds.has(key) ? key : SKILL_ALIASES[key];
    if (id === undefined) {
      dropped.push(term);
      continue;
    }
    if (!skills.includes(id)) skills.push(id);
  }
  return { skills, dropped };
}

/** 既有技能只增不减：并集后按字典序稳定排序，保证同一输入两次运行结果一致。 */
export function mergeSkills(existing: readonly string[] | null, fromModel: readonly string[]): string[] {
  const merged = new Set<string>(existing ?? []);
  for (const id of fromModel) merged.add(id);
  return [...merged].sort();
}

/** 模型判不出（unknown）时不覆盖既有的已分类枚举值。 */
function preferKnownValue<T extends string>(existing: string, fromModel: T, values: readonly T[]): T {
  if (fromModel === "unknown" && existing !== "unknown") {
    const known = values.find((value) => value === existing);
    if (known !== undefined) return known;
  }
  return fromModel;
}

/**
 * 把模型输出并入既有行：skills 取并集，年限仅在模型给出非 null 时覆盖，
 * 枚举仅在既有为 unknown 时接受模型的 unknown。
 * revokeRoleFamily：--rerun-aipo 是在专门重判嫌疑行，此时模型给出的 unknown 必须压过既有 aipo；
 * 默认回填仍然保留“低置信模型不抹掉已确认职族”的保护。
 */
export function mergeNormalizedFields(
  row: CareerJobRow,
  parsed: LlmNormalization,
  options: { revokeRoleFamily?: boolean } = {},
): { fields: LlmNormalizedFields; droppedSkillTerms: number } {
  const mapped = mapSkillsToKnown(parsed.skills);
  const min = parsed.experience_min_years ?? row.experience_min_years;
  const max = parsed.experience_max_years ?? row.experience_max_years;
  // 单边覆盖可能把既有的一对年限拼成 min > max；这种组合宁可保持既有整对。
  const inverted = min !== null && max !== null && min > max;
  const roleFamily = options.revokeRoleFamily === true && parsed.role_family === "unknown"
    ? "unknown"
    : preferKnownValue(row.role_family, parsed.role_family, ROLE_FAMILY_VALUES);
  const fields: LlmNormalizedFields = {
    role_family: roleFamily,
    student_friendly: preferKnownValue(row.student_friendly, parsed.student_friendly, STUDENT_FRIENDLY_VALUES),
    skills: mergeSkills(row.skills, mapped.skills),
    experience_min_years: inverted ? row.experience_min_years : min,
    experience_max_years: inverted ? row.experience_max_years : max,
  };
  return { fields, droppedSkillTerms: mapped.dropped.length };
}

function usageOf(usage: Record<string, unknown> | null | undefined): { prompt_tokens: number; completion_tokens: number } {
  const number = (key: string): number => {
    const value = usage?.[key];
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
  };
  return { prompt_tokens: number("prompt_tokens"), completion_tokens: number("completion_tokens") };
}

/** 只暴露错误类别与 schema 字段路径，不把模型原文或 JD 写进日志。 */
export function describeFailure(error: unknown): string {
  if (error instanceof z.ZodError) {
    const issues = error.issues
      .slice(0, 3)
      .map((issue) => `${issue.path.join(".") || "(root)"}:${issue.code}`)
      .join(", ");
    return `schema 非法: ${issues}`;
  }
  if (error instanceof Error) {
    const name = error.name !== "Error" ? error.name : error.constructor.name;
    return `调用失败: ${name}`;
  }
  return "调用失败: unknown";
}

export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(Math.max(limit, 1), items.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await worker(items[index]!);
    }
  });
  await Promise.all(runners);
  return results;
}

/** 版本也要比较：内容相同但版本不同仍必须写库，否则下一轮还会被选为候选并重复付费。 */
function alreadyNormalized(row: CareerJobRow, fields: LlmNormalizedFields): boolean {
  const listKey = (values: readonly string[]): string => [...new Set(values)].sort().join("\u0000");
  return (
    row.normalizer_version === LLM_NORMALIZER_VERSION &&
    row.role_family === fields.role_family &&
    row.student_friendly === fields.student_friendly &&
    listKey(row.skills ?? []) === listKey(fields.skills) &&
    row.experience_min_years === fields.experience_min_years &&
    row.experience_max_years === fields.experience_max_years
  );
}

async function processRow(
  row: CareerJobRow,
  callLlm: LlmCaller,
  log: (line: string) => void,
  revokeRoleFamily: boolean,
): Promise<RowOutcome> {
  const system = SYSTEM_PROMPT;
  const user = buildUserPrompt(row);
  let calls = 0;
  let retries = 0;
  let lastFailure = "";
  let schemaRejected = false;
  let usageMissingCalls = 0;
  for (let attempt = 0; attempt <= 1; attempt += 1) {
    calls += 1;
    if (attempt > 0) retries += 1;
    let response: LlmResponse;
    try {
      response = await callLlm({ subject: row.id, system, user });
    } catch (error) {
      lastFailure = describeFailure(error);
      usageMissingCalls += 1;
      continue;
    }
    const parsed = llmNormalizationSchema.safeParse(response.data);
    if (!parsed.success) {
      schemaRejected = true;
      lastFailure = describeFailure(parsed.error);
      usageMissingCalls += 1;
      continue;
    }
    const decision = downgradeNonAiOperations(row, parsed.data);
    const normalized: LlmNormalization = decision.downgraded
      ? { ...parsed.data, role_family: "unknown" }
      : parsed.data;
    const merged = mergeNormalizedFields(row, normalized, { revokeRoleFamily });
    // 后置校验是确定性的，必须压过 mergeNormalizedFields 的“既有已知值不被 unknown 覆盖”保护。
    const fields = decision.downgraded ? { ...merged.fields, role_family: "unknown" as const } : merged.fields;
    const revoked = !decision.downgraded && fields.role_family !== row.role_family;
    log(
      `  ${row.id} | ${row.title} | role: ${row.role_family}→${fields.role_family} | ` +
        `student: ${row.student_friendly}→${fields.student_friendly} | skills: ${(row.skills ?? []).length}→${fields.skills.length} | ` +
        `exp: ${formatRange(row.experience_min_years, row.experience_max_years)}→${formatRange(fields.experience_min_years, fields.experience_max_years)}` +
        (decision.downgraded
          ? ` | downgradedByRule: true（命中非 AI 领域词“${decision.domainTerm}”）`
          : revoked
            ? " | 重判撤销既有职族"
            : ""),
    );
    return {
      row,
      status: "ok",
      fields,
      unchanged: alreadyNormalized(row, fields),
      downgraded: decision.downgraded,
      revoked,
      droppedSkillTerms: merged.droppedSkillTerms,
      usage: usageOf(response.usage),
      schemaRejected: false,
      usageMissingCalls,
      calls,
      retries,
    };
  }
  log(`  ${row.id} | ${row.title} | ${lastFailure}`);
  return {
    row,
    status: "failed",
    failure: lastFailure,
    schemaRejected,
    usageMissingCalls,
    calls,
    retries,
    droppedSkillTerms: 0,
  };
}

function formatRange(min: number | null, max: number | null): string {
  if (min === null && max === null) return "null";
  return `${min === null ? "?" : min}-${max === null ? "?" : max}`;
}

/** 核心流程与 IO 解耦：模型与存储都由调用方注入，便于测试用 fake 覆盖。 */
export async function runBackfill(options: RunOptions): Promise<RunSummary> {
  const log = options.log ?? (() => {});
  const rerunAipo = options.rerunAipo === true;
  const onlyIds = options.onlyIds === undefined ? null : new Set(options.onlyIds);
  const forced = options.force === true && onlyIds !== null;
  const candidates = forced
    ? await options.store.listByIds([...onlyIds])
    : rerunAipo
      ? await options.store.listRerunAipoCandidates(options.limit)
      : await options.store.listCandidates(options.limit);
  const rows = forced || onlyIds === null ? candidates : candidates.filter((row) => onlyIds.has(row.id));
  log(`候选行: ${rows.length}${rerunAipo ? "（--rerun-aipo：仅 aipo 且标题命中非 AI 领域词）" : ""}`);
  if (forced) log(`--force-ids：指定 ${onlyIds!.size} 个 id，跳过版本护栏`);
  else if (onlyIds !== null) log(`--only-ids：指定 ${onlyIds.size} 个 id，过滤前候选 ${candidates.length} 行`);
  log(`将调用模型行数: ${rows.length}`);

  const estimatedInput = rows.reduce((sum, row) => sum + Math.ceil((SYSTEM_PROMPT.length + buildUserPrompt(row).length) / 1.5), 0);
  log(`预计 token 上限: 输入 ≈${estimatedInput}，输出 ≤${rows.length * LLM_MAX_TOKENS}`);

  const outcomes = await mapWithConcurrency(rows, options.concurrency ?? DEFAULT_CONCURRENCY, (row): Promise<RowOutcome> =>
    processRow(row, options.callLlm, log, rerunAipo).catch((error: unknown) => ({
      row,
      status: "failed" as const,
      failure: describeFailure(error),
      schemaRejected: false,
      usageMissingCalls: 0,
      calls: 0,
      retries: 0,
      droppedSkillTerms: 0,
    })),
  );

  const summary: RunSummary = {
    candidates: rows.length,
    called: rows.length,
    changed: 0,
    unchanged: 0,
    failed: 0,
    schemaRejected: 0,
    calls: 0,
    retries: 0,
    droppedSkillTerms: 0,
    downgraded: 0,
    revoked: 0,
    usage: { prompt_tokens: 0, completion_tokens: 0 },
    usageMissingCalls: 0,
  };

  for (const outcome of outcomes) {
    summary.calls += outcome.calls;
    summary.retries += outcome.retries;
    if (outcome.downgraded === true) summary.downgraded += 1;
    if (outcome.revoked === true) summary.revoked += 1;
    summary.usageMissingCalls += outcome.usageMissingCalls ?? 0;
    summary.droppedSkillTerms += outcome.droppedSkillTerms ?? 0;
    summary.usage.prompt_tokens += outcome.usage?.prompt_tokens ?? 0;
    summary.usage.completion_tokens += outcome.usage?.completion_tokens ?? 0;
    if (outcome.status === "failed") {
      summary.failed += 1;
      if (outcome.schemaRejected === true) summary.schemaRejected += 1;
      continue;
    }
    if (outcome.unchanged === true) {
      summary.unchanged += 1;
      continue;
    }
    if (!options.apply) {
      summary.changed += 1;
      continue;
    }
    try {
      const updated = await options.store.updateLlmFields(outcome.row.id, outcome.fields!, forced);
      if (updated > 0) summary.changed += 1;
      else summary.unchanged += 1;
    } catch (error) {
      summary.failed += 1;
      log(`  ${outcome.row.id} | ${outcome.row.title} | 写库失败: ${describeFailure(error)}`);
    }
  }
  return summary;
}

export function printSummary(summary: RunSummary, apply: boolean, log: (line: string) => void): void {
  log("");
  log(`汇总（${apply ? "apply" : "dry-run"}）:`);
  log(`  候选/调用行: ${summary.candidates}，模型调用: ${summary.calls} 次（重试 ${summary.retries} 次）`);
  log(`  ${apply ? "已更新" : "拟变更"}行: ${summary.changed}`);
  log(`  无变化行:   ${summary.unchanged}`);
  log(`  失败行:     ${summary.failed}（其中 schema 非法 ${summary.schemaRejected}）`);
  log(`  规则降级行: ${summary.downgraded}（aipo→unknown，downgradedByRule）`);
  log(`  重判撤销行: ${summary.revoked}（模型重判 unknown、撤销既有 aipo）`);
  log(`  usage: prompt_tokens=${summary.usage.prompt_tokens}, completion_tokens=${summary.usage.completion_tokens}`);
  if (summary.usageMissingCalls > 0) {
    log(`  另有 ${summary.usageMissingCalls} 次失败调用未返回 usage（token 未计入上面的数字）`);
  }
  log(`  技能词表映射丢弃: ${summary.droppedSkillTerms} 个词`);
}

function loadDotEnvIfPresent(): void {
  const file = path.join(REPO_ROOT, ".env");
  if (!existsSync(file)) return;
  const parsed = parseEnv(readFileSync(file, "utf8"));
  for (const [key, value] of Object.entries(parsed)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function describeDatabase(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname}:${parsed.port || "5432"}${parsed.pathname}`;
  } catch {
    return "(DATABASE_URL 无法解析)";
  }
}

function printHelp(): void {
  console.log("用法: node scripts/backfill-normalizer-llm.ts [--apply] [--limit N] [--rerun-aipo] [--only-ids id1,id2]");
  console.log("  默认 dry-run：真实调用模型，打印候选行与逐行拟变更，但不写库。");
  console.log("  --apply：逐行独立事务写入 role_family / student_friendly / skills / 经验年限 / normalizer_version。");
  console.log("  --limit N：只处理前 N 行。");
  console.log("  --rerun-aipo：只重判 ai_product_operations 且标题命中非 AI 领域词的嫌疑行，其余行不动。");
  console.log("  --only-ids id1,id2：候选查询后、模型调用前只保留指定完整 id。");
  console.log("  --force-ids id1,id2：按 id 定向修复，跳过“已是当前版本就不写”的护栏（用于规则修正后的一次性纠偏）。");
  console.log("  需要 MODEL_CALLS_ENABLED=true，否则直接退出。");
}

/** 中文词按子串匹配；纯 ASCII 词要求词边界，避免把 “email” 里的 ai 当成 AI。 */
function toSqlAlternation(terms: readonly string[]): string {
  return terms.map((term) => (/^[a-z]+$/.test(term) ? `(^|[^a-z])${term}([^a-z]|$)` : term)).join("|");
}

const AI_TITLE_SQL_PATTERN = toSqlAlternation(AI_TITLE_TERMS);
const NON_AI_DOMAIN_SQL_PATTERN = toSqlAlternation(NON_AI_DOMAIN_TERMS);

class PostgresCareerJobStore implements CandidateStore {
  private readonly client: ReturnType<typeof postgres>;

  constructor(client: ReturnType<typeof postgres>) {
    this.client = client;
  }

  async listCandidates(limit: number | null): Promise<CareerJobRow[]> {
    const rows = limit === null
      ? await this.client<CareerJobRow[]>`
          SELECT id::text AS id, title, raw_text, degree_raw, experience_raw, skills,
                 experience_min_years, experience_max_years,
                 role_family, student_friendly, normalizer_version
          FROM career_jobs
          WHERE normalizer_version IS DISTINCT FROM ${LLM_NORMALIZER_VERSION}
            AND (role_family = 'unknown' OR student_friendly = 'unknown'
                 OR skills IS NULL OR skills = '[]'::jsonb)
          ORDER BY id`
      : await this.client<CareerJobRow[]>`
          SELECT id::text AS id, title, raw_text, degree_raw, experience_raw, skills,
                 experience_min_years, experience_max_years,
                 role_family, student_friendly, normalizer_version
          FROM career_jobs
          WHERE normalizer_version IS DISTINCT FROM ${LLM_NORMALIZER_VERSION}
            AND (role_family = 'unknown' OR student_friendly = 'unknown'
                 OR skills IS NULL OR skills = '[]'::jsonb)
          ORDER BY id
          LIMIT ${limit}`;
    return rows;
  }

  async listRerunAipoCandidates(limit: number | null): Promise<CareerJobRow[]> {
    if (limit === null) {
      return await this.client<CareerJobRow[]>`
          SELECT id::text AS id, title, raw_text, degree_raw, experience_raw, skills,
                 experience_min_years, experience_max_years,
                 role_family, student_friendly, normalizer_version
          FROM career_jobs
          WHERE role_family = 'ai_product_operations'
            AND normalizer_version IS DISTINCT FROM ${LLM_NORMALIZER_VERSION}
            AND title ~* ${NON_AI_DOMAIN_SQL_PATTERN}
            AND title !~* ${AI_TITLE_SQL_PATTERN}
          ORDER BY id`;
    }
    return await this.client<CareerJobRow[]>`
          SELECT id::text AS id, title, raw_text, degree_raw, experience_raw, skills,
                 experience_min_years, experience_max_years,
                 role_family, student_friendly, normalizer_version
          FROM career_jobs
          WHERE role_family = 'ai_product_operations'
            AND normalizer_version IS DISTINCT FROM ${LLM_NORMALIZER_VERSION}
            AND title ~* ${NON_AI_DOMAIN_SQL_PATTERN}
            AND title !~* ${AI_TITLE_SQL_PATTERN}
          ORDER BY id
          LIMIT ${limit}`;
  }

  async listByIds(ids: readonly string[]): Promise<CareerJobRow[]> {
    if (ids.length === 0) return [];
    return await this.client<CareerJobRow[]>`
      SELECT id::text AS id, title, raw_text, degree_raw, experience_raw, skills,
             experience_min_years, experience_max_years,
             role_family, student_friendly, normalizer_version
      FROM career_jobs
      WHERE id::text IN ${this.client([...ids])}
      ORDER BY id`;
  }

  async updateLlmFields(id: string, fields: LlmNormalizedFields, force = false): Promise<number> {
    return this.client.begin(async (tx) => {
      const result = await tx`
        UPDATE career_jobs SET
          role_family = ${fields.role_family},
          student_friendly = ${fields.student_friendly},
          skills = ${tx.json(fields.skills as JSONValue)}::jsonb,
          experience_min_years = ${fields.experience_min_years},
          experience_max_years = ${fields.experience_max_years},
          normalizer_version = ${LLM_NORMALIZER_VERSION},
          updated_at = now()
        WHERE id = ${id}
          AND (${force} OR normalizer_version IS DISTINCT FROM ${LLM_NORMALIZER_VERSION})`;
      return result.count;
    });
  }
}

async function main(): Promise<void> {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    printHelp();
    return;
  }
  const apply = process.argv.includes("--apply");
  const rerunAipo = process.argv.includes("--rerun-aipo");
  const onlyIdsIndex = process.argv.indexOf("--only-ids");
  const forceIdsIndex = process.argv.indexOf("--force-ids");
  const onlyIdsArg = onlyIdsIndex >= 0 ? process.argv[onlyIdsIndex + 1] : undefined;
  const forceIdsArg = forceIdsIndex >= 0 ? process.argv[forceIdsIndex + 1] : undefined;
  if (onlyIdsIndex >= 0 && (onlyIdsArg === undefined || onlyIdsArg.startsWith("--"))) {
    throw new Error("--only-ids 需要逗号分隔的完整 id 列表");
  }
  if (forceIdsIndex >= 0 && (forceIdsArg === undefined || forceIdsArg.startsWith("--"))) {
    throw new Error("--force-ids 需要逗号分隔的完整 id 列表");
  }
  if (forceIdsIndex >= 0 && onlyIdsIndex >= 0) throw new Error("--force-ids 与 --only-ids 只能用一个");
  const idsArg = forceIdsArg ?? onlyIdsArg;
  const onlyIds = idsArg === undefined
    ? undefined
    : [...new Set(idsArg.split(",").map((id) => id.trim()).filter((id) => id !== ""))];
  if (onlyIds !== undefined && onlyIds.length === 0) {
    throw new Error("--force-ids/--only-ids 需要逗号分隔的完整 id 列表");
  }
  const force = forceIdsIndex >= 0;
  const limitIndex = process.argv.indexOf("--limit");
  const limit = limitIndex >= 0 ? Number.parseInt(process.argv[limitIndex + 1] ?? "", 10) : null;
  if (limitIndex >= 0 && (limit === null || !Number.isFinite(limit) || limit < 1)) {
    throw new Error("--limit 需要一个正整数");
  }

  loadDotEnvIfPresent();
  const { config } = await import("../packages/backend/src/config.ts");
  if (!config.modelCallsEnabled) {
    console.error("MODEL_CALLS_ENABLED 为 false。本脚本会真实调用模型；请设置 MODEL_CALLS_ENABLED=true 后再运行。");
    process.exitCode = 1;
    return;
  }

  const databaseUrl = process.env.DATABASE_URL?.trim() || config.databaseUrl;
  const sql = postgres(databaseUrl, { max: 2, connect_timeout: 10, onnotice: () => {} });
  console.log(`=== LLM normalizer backfill（${apply ? "apply" : "dry-run"}${rerunAipo ? "，--rerun-aipo" : ""}） ===`);
  console.log(`目标版本: ${LLM_NORMALIZER_VERSION}`);
  console.log(`数据库:   ${describeDatabase(databaseUrl)}`);

  try {
    const { chatJson } = await import("../packages/backend/src/providers/llm.ts");
    const callLlm: LlmCaller = async ({ subject, system, user }) => {
      const result = await chatJson({
        model: LLM_MODEL,
        purpose: LLM_PURPOSE,
        subject,
        promptVersion: LLM_PROMPT_VERSION,
        system,
        user,
        schema: llmNormalizationSchema,
        temperature: 0,
        maxTokens: LLM_MAX_TOKENS,
        timeoutMs: LLM_TIMEOUT_MS,
      });
      return { data: result.data, usage: result.usage };
    };

    const store = new PostgresCareerJobStore(sql);
    const summary = await runBackfill({
      apply,
      limit,
      rerunAipo,
      onlyIds,
      force,
      callLlm,
      store,
      log: (line) => console.log(line),
    });
    printSummary(summary, apply, (line) => console.log(line));
    if (!apply) console.log("\n未传 --apply，未写库。");
    if (summary.failed > 0) process.exitCode = 1;
  } finally {
    await sql.end({ timeout: 5 });
    const { closeDb } = await import("../packages/backend/src/db.ts");
    await closeDb();
  }
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
