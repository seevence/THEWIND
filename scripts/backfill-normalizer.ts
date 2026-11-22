// 一次性回填：把 career_jobs 中仍停留在旧 normalizer 版本的职位行按当前 normalizer 重算派生字段。
// node scripts/backfill-normalizer.ts                     默认 dry-run，只统计不写库
// node scripts/backfill-normalizer.ts --apply             在单个事务内写库，失败整体回滚
// node scripts/backfill-normalizer.ts --include-imported  连同 data_origin='verified_import' 的行一起处理
// 默认只处理 data_origin='live'；synthetic_fixture 始终不处理（演示数据不参与回填）。
// 只更新派生的分析字段与 normalizer_version；不写 career_job_observations，不动 last_seen_at /
// content_hash / created_at / degree_raw / experience_raw / locations / raw_text / raw_payload 等来源侧字段。
//
// 重建输入口径与 hints 限制：重建 RawCollectedJobV1 时优先从 raw_payload 的采集原始字段
// （education / workYears / jobFamily / locations / employmentType / skillTerms）取 hints；
// raw_payload 缺少对应字段时回退 career_jobs 现有列（degree_raw / experience_raw / locations），
// 再缺失则按默认值（空串、null、空数组）交给 normalizer 从标题与正文扫描。
// 因此本脚本只能证明「重建输入 → DB 派生值」在同一个 normalizer 下可复现；
// 它无法回溯当初采集侧 hints 本应得到的值——旧版本由 hints 决定的 role_family /
// employment_type 与文本扫描结果可能不同，报告里的 hints 覆盖率说明有多少行受了这个限制。
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";
import postgres, { type JSONValue } from "postgres";
import type {
  EmploymentType,
  RawCollectedJobV1,
  RoleFamily,
} from "../modules/career-insights/contracts/index.ts";
import {
  LLM_NORMALIZER_VERSION_PREFIX,
  NORMALIZER_VERSION,
  normalizeRawJob,
} from "../modules/career-insights/data/normalize.ts";
import { validateNormalizedJobV1 } from "../modules/career-insights/data/validate.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");

export interface JobRow {
  id: string;
  source_key: string;
  company_name: string;
  title: string;
  official_url: string;
  data_origin: string;
  normalizer_version: string;
  role_family: string;
  degree: string;
  employment_type: string;
  student_friendly: string;
  experience_min_years: number | null;
  experience_max_years: number | null;
  degree_raw: string | null;
  experience_raw: string | null;
  locations: string[] | null;
  skills: string[] | null;
  skill_evidence: Array<{ skill_id: string; evidence_text: string }> | null;
  raw_text: string;
  raw_payload: Record<string, unknown> | null;
  published_at: string | null;
  fetched_at: Date;
  collector_version: string;
}

export interface DerivedFields {
  role_family: string;
  degree: string;
  employment_type: string;
  student_friendly: string;
  experience_min_years: number | null;
  experience_max_years: number | null;
  skills: string[];
  skill_evidence: Array<{ skill_id: string; evidence_text: string }>;
  normalizer_version: string;
}

export interface PlannedRow {
  row: JobRow;
  before: DerivedFields;
  after: DerivedFields;
}

export interface SkippedRow {
  row: JobRow;
  reason: string;
}

export type HintField =
  | "degree_raw"
  | "experience_raw"
  | "role_family"
  | "locations"
  | "employment_type"
  | "skill_terms";

export interface RebuiltRaw {
  raw: RawCollectedJobV1;
  hasPayload: boolean;
  fromPayload: HintField[];
}

export interface HintCoverage {
  withPayload: number;
  payloadUsed: number;
  degreeRaw: number;
  experienceRaw: number;
  roleFamily: number;
  locations: number;
  employmentType: number;
  skillTerms: number;
}

export interface PlanResult {
  candidates: number;
  planned: PlannedRow[];
  skipped: SkippedRow[];
  unchanged: number;
  hints: HintCoverage;
}

// 采集原始载荷里各站点用过的字段名（Baidu: education/workYears/workPlace，
// Meituan: workYear/jobFamily/cityList，Tencent: RequireWorkYearsName/LocationName/CategoryName）。
const DEGREE_KEYS = ["education", "degree", "degree_raw", "educationLevel"] as const;
const EXPERIENCE_KEYS = [
  "workYears",
  "workYear",
  "RequireWorkYearsName",
  "workExperience",
  "experience",
  "experience_raw",
] as const;
const LOCATION_KEYS = [
  "workPlace",
  "cityList",
  "LocationName",
  "locations",
  "cities",
  "location",
  "city",
] as const;
const ROLE_FAMILY_KEYS = ["jobFamily", "jobFamilyGroup", "job_family", "role_family"] as const;
const EMPLOYMENT_KEYS = ["employmentType", "employment_type"] as const;
const SKILL_KEYS = ["skillTerms", "skill_terms"] as const;

const ROLE_FAMILY_VALUES: ReadonlySet<string> = new Set<RoleFamily>([
  "ai_algorithm",
  "ai_application_development",
  "data",
  "ai_product_operations",
  "hardware_engineering",
  "manufacturing_quality",
  "sales_business",
  "corporate_functions",
  "unknown",
]);
const EMPLOYMENT_TYPE_VALUES: ReadonlySet<string> = new Set<EmploymentType>([
  "campus",
  "internship",
  "experienced",
  "other",
  "unknown",
]);

function loadDatabaseUrl(): string {
  const fromEnv = process.env.DATABASE_URL?.trim();
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  const envFile = path.join(REPO_ROOT, ".env");
  if (!existsSync(envFile)) {
    throw new Error(`未设置 DATABASE_URL，且找不到 ${envFile}；请在 .env 里配置 DATABASE_URL。`);
  }
  const parsed = parseEnv(readFileSync(envFile, "utf8"));
  const fromFile = parsed.DATABASE_URL?.trim();
  if (fromFile === undefined || fromFile === "") {
    throw new Error(`${envFile} 中没有 DATABASE_URL。`);
  }
  return fromFile;
}

/** 只用于输出，避免把密码打进日志。 */
function describeDatabase(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname}:${parsed.port || "5432"}${parsed.pathname}`;
  } catch {
    return "(DATABASE_URL 无法解析)";
  }
}

function readPayloadString(payload: Record<string, unknown> | null, keys: readonly string[]): string | null {
  if (payload === null) return null;
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return null;
}

function readPayloadStrings(payload: Record<string, unknown> | null, keys: readonly string[]): string[] | null {
  if (payload === null) return null;
  for (const key of keys) {
    const value = payload[key];
    if (Array.isArray(value)) {
      const items = value
        .map((item) => {
          if (typeof item === "string") return item.trim();
          // Meituan 的 cityList 是 [{ code, name, ... }]。
          if (typeof item === "object" && item !== null && "name" in item) {
            const name = (item as { name?: unknown }).name;
            return typeof name === "string" ? name.trim() : "";
          }
          return "";
        })
        .filter((item) => item !== "");
      if (items.length > 0) return items;
    }
    if (typeof value === "string" && value.trim() !== "") return [value.trim()];
  }
  return null;
}

/**
 * career_jobs 没有 source_job_id 列：raw_payload 是来源原始载荷，可能含采集侧 hints 的原始字段。
 * hints 因此先取 raw_payload，再回退 DB 现有列，最后按默认值重建——role_family 不能回灌旧列值，
 * 否则 0.2.0 的字典修正永远不会生效。
 */
export function rebuildRaw(row: JobRow): RebuiltRaw {
  const payload = row.raw_payload;
  const fromPayload: HintField[] = [];

  const payloadDegree = readPayloadString(payload, DEGREE_KEYS);
  const degreeRaw = payloadDegree ?? row.degree_raw;
  if (payloadDegree !== null) fromPayload.push("degree_raw");

  const payloadExperience = readPayloadString(payload, EXPERIENCE_KEYS);
  const experienceRaw = payloadExperience ?? row.experience_raw;
  if (payloadExperience !== null) fromPayload.push("experience_raw");

  const payloadLocations = readPayloadStrings(payload, LOCATION_KEYS);
  const locations = payloadLocations ?? row.locations ?? [];
  if (payloadLocations !== null) fromPayload.push("locations");

  const payloadRole = readPayloadString(payload, ROLE_FAMILY_KEYS);
  const roleFamily =
    payloadRole !== null && payloadRole !== "unknown" && ROLE_FAMILY_VALUES.has(payloadRole)
      ? (payloadRole as RoleFamily)
      : undefined;
  if (roleFamily !== undefined) fromPayload.push("role_family");

  const payloadEmployment = readPayloadString(payload, EMPLOYMENT_KEYS);
  const employmentType =
    payloadEmployment !== null &&
    payloadEmployment !== "unknown" &&
    EMPLOYMENT_TYPE_VALUES.has(payloadEmployment)
      ? (payloadEmployment as EmploymentType)
      : undefined;
  if (employmentType !== undefined) fromPayload.push("employment_type");

  const skillTerms = readPayloadStrings(payload, SKILL_KEYS);
  if (skillTerms !== null) fromPayload.push("skill_terms");

  return {
    raw: {
      schema_version: "1.0",
      source_key: row.source_key,
      source_job_id: null,
      company_name: row.company_name,
      title: row.title,
      official_url: row.official_url,
      raw_text: row.raw_text,
      published_at: row.published_at,
      fetched_at: row.fetched_at.toISOString(),
      collector_version: row.collector_version,
      hints: {
        ...(roleFamily === undefined ? {} : { role_family: roleFamily }),
        locations,
        degree_raw: degreeRaw,
        experience_raw: experienceRaw,
        ...(employmentType === undefined ? {} : { employment_type: employmentType }),
        ...(skillTerms === null ? {} : { skill_terms: skillTerms }),
      },
    },
    hasPayload: payload !== null && Object.keys(payload).length > 0,
    fromPayload,
  };
}

function derivedOf(row: JobRow): DerivedFields {
  return {
    role_family: row.role_family,
    degree: row.degree,
    employment_type: row.employment_type,
    student_friendly: row.student_friendly,
    experience_min_years: row.experience_min_years,
    experience_max_years: row.experience_max_years,
    skills: row.skills ?? [],
    skill_evidence: row.skill_evidence ?? [],
    normalizer_version: row.normalizer_version,
  };
}

/** 签名只回答「派生值是否需要重写」：列表维度排序去重，顺序与重复不算内容变化。 */
export function signature(fields: DerivedFields): string {
  return JSON.stringify({
    role_family: fields.role_family,
    degree: fields.degree,
    employment_type: fields.employment_type,
    student_friendly: fields.student_friendly,
    experience_min_years: fields.experience_min_years ?? null,
    experience_max_years: fields.experience_max_years ?? null,
    skills: listKey(fields.skills),
    skill_evidence: evidenceKey(fields.skill_evidence),
    normalizer_version: fields.normalizer_version,
  });
}

function listKey(values: readonly string[]): string {
  return [...new Set(values)].sort().join("\u0000");
}

function evidenceKey(values: ReadonlyArray<{ skill_id: string; evidence_text: string }>): string {
  return [...new Set(values.map((item) => `${item.skill_id}\u0000${item.evidence_text}`))]
    .sort()
    .join("\n");
}

function emptyHintCoverage(): HintCoverage {
  return {
    withPayload: 0,
    payloadUsed: 0,
    degreeRaw: 0,
    experienceRaw: 0,
    roleFamily: 0,
    locations: 0,
    employmentType: 0,
    skillTerms: 0,
  };
}

/** 纯函数：给定候选行，算出待写入、无需变更与被跳过的行。 */
export function planRows(rows: readonly JobRow[]): PlanResult {
  const planned: PlannedRow[] = [];
  const skipped: SkippedRow[] = [];
  const hints = emptyHintCoverage();
  let unchanged = 0;

  for (const row of rows) {
    const rebuilt = rebuildRaw(row);
    if (rebuilt.hasPayload) hints.withPayload += 1;
    if (rebuilt.fromPayload.length > 0) hints.payloadUsed += 1;
    for (const field of rebuilt.fromPayload) {
      if (field === "degree_raw") hints.degreeRaw += 1;
      else if (field === "experience_raw") hints.experienceRaw += 1;
      else if (field === "role_family") hints.roleFamily += 1;
      else if (field === "locations") hints.locations += 1;
      else if (field === "employment_type") hints.employmentType += 1;
      else hints.skillTerms += 1;
    }

    let after: DerivedFields;
    try {
      const normalized = normalizeRawJob(rebuilt.raw);
      const checked = validateNormalizedJobV1(normalized);
      if (!checked.ok) {
        const issues = checked.errors
          .slice(0, 3)
          .map((issue) => (issue.path === "" ? issue.message : `${issue.path}: ${issue.message}`))
          .join("; ");
        skipped.push({ row, reason: `校验失败: ${issues}` });
        continue;
      }
      after = {
        role_family: checked.value.role_family,
        degree: checked.value.degree,
        employment_type: checked.value.employment_type,
        student_friendly: checked.value.student_friendly,
        experience_min_years: checked.value.experience_min_years,
        experience_max_years: checked.value.experience_max_years,
        skills: checked.value.skills,
        skill_evidence: checked.value.skill_evidence,
        normalizer_version: checked.value.normalizer_version,
      };
    } catch (error) {
      skipped.push({ row, reason: `重算异常: ${(error as Error).message}` });
      continue;
    }

    const before = derivedOf(row);
    if (signature(before) === signature(after)) {
      unchanged += 1;
      continue;
    }
    planned.push({ row, before, after });
  }

  return { candidates: rows.length, planned, skipped, unchanged, hints };
}

function countBy(
  rows: readonly PlannedRow[],
  pick: (fields: DerivedFields) => string,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of rows) {
    const key = pick(item.after);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function printDistribution(title: string, before: Map<string, number>, after: Map<string, number>) {
  const keys = [...new Set([...before.keys(), ...after.keys()])].sort();
  console.log(`\n${title}（候选行 before → after）`);
  for (const key of keys) {
    console.log(
      `  ${key.padEnd(28)} ${String(before.get(key) ?? 0).padStart(4)} → ${String(after.get(key) ?? 0).padStart(4)}`,
    );
  }
}

function printTransitions(rows: readonly PlannedRow[], dimension: "role_family" | "student_friendly") {
  const moves = new Map<string, number>();
  for (const item of rows) {
    const from = item.before[dimension];
    const to = item.after[dimension];
    if (from === to) continue;
    const key = `${from} → ${to}`;
    moves.set(key, (moves.get(key) ?? 0) + 1);
  }
  console.log(`\n${dimension} 迁移（before → after）`);
  if (moves.size === 0) {
    console.log("  无变化");
    return;
  }
  for (const [key, count] of [...moves.entries()].sort()) {
    console.log(`  ${key}: ${count}`);
  }
}

function printHints(coverage: HintCoverage, candidates: number): void {
  const pct = (value: number): string =>
    candidates === 0 ? "0.0%" : `${((value / candidates) * 100).toFixed(1)}%`;
  console.log("\nraw_payload hints 覆盖率（候选行内）");
  console.log(`  有 raw_payload:            ${coverage.withPayload} / ${candidates}（${pct(coverage.withPayload)}）`);
  console.log(`  至少命中一项 hints:        ${coverage.payloadUsed} / ${candidates}（${pct(coverage.payloadUsed)}）`);
  console.log(`  degree_raw:                ${coverage.degreeRaw}`);
  console.log(`  experience_raw:            ${coverage.experienceRaw}`);
  console.log(`  role_family:               ${coverage.roleFamily}`);
  console.log(`  locations:                 ${coverage.locations}`);
  console.log(`  employment_type:           ${coverage.employmentType}`);
  console.log(`  skill_terms:               ${coverage.skillTerms}`);
}

function printLimits(includeImported: boolean): void {
  console.log("\n重建输入口径与已知限制");
  console.log("  来源字段取自 career_jobs 现有列: raw_text、title、company_name、official_url、published_at、fetched_at、collector_version。");
  console.log("  hints 优先取 raw_payload 的采集原始字段（education / workYears / jobFamily / locations / employmentType / skillTerms）；");
  console.log("  raw_payload 缺少对应字段时才回退 degree_raw / experience_raw / locations 列，再缺失按默认值重建，");
  console.log("  因此 role_family / employment_type / skill_terms 在 hints 缺失时由当前 normalizer 从标题与正文扫描；");
  console.log("  本脚本只能证明重建输入 → DB 派生值可复现，无法回溯原始 hints 应得的 role_family / employment_type。");
  console.log(`  数据来源过滤: 默认只处理 data_origin='live'${includeImported ? "；本次已包含 verified_import" : "（verified_import 需 --include-imported）"}；synthetic_fixture 始终不处理。`);
  console.log(`  版本过滤: normalizer_version 为 ${NORMALIZER_VERSION} 或 ${LLM_NORMALIZER_VERSION_PREFIX}* 的行视为当前版本，不重算（LLM 判定不由文本扫描覆盖）。`);
  console.log("  只写 role_family、degree、employment_type、student_friendly、experience_min/max_years、skills、skill_evidence、normalizer_version、updated_at；");
  console.log("  不写 career_job_observations，不改 last_seen_at、content_hash、created_at、degree_raw、experience_raw、locations、raw_text、raw_payload。");
}

function printReport(options: {
  plan: PlanResult;
  mode: "dry-run" | "apply";
  databaseUrl: string;
  includeImported: boolean;
  writeSkipped: readonly SkippedRow[];
  applied: number | null;
}): void {
  const { plan, mode, databaseUrl, includeImported, writeSkipped, applied } = options;
  const allSkipped = [...plan.skipped, ...writeSkipped];

  console.log(`=== normalizer backfill（${mode}） ===`);
  console.log(`目标版本: ${NORMALIZER_VERSION}`);
  console.log(`数据库:   ${describeDatabase(databaseUrl)}`);
  console.log(`候选行（normalizer_version 非当前版本）: ${plan.candidates}`);
  console.log(`待变更行: ${plan.planned.length}`);
  console.log(`无需变更行: ${plan.unchanged}`);
  console.log(`跳过行:   ${allSkipped.length}`);

  const beforeRoleFamily = new Map<string, number>();
  for (const item of plan.planned) {
    const key = item.before.role_family;
    beforeRoleFamily.set(key, (beforeRoleFamily.get(key) ?? 0) + 1);
  }
  const beforeStudentFriendly = new Map<string, number>();
  for (const item of plan.planned) {
    const key = item.before.student_friendly;
    beforeStudentFriendly.set(key, (beforeStudentFriendly.get(key) ?? 0) + 1);
  }
  printDistribution("role_family 桶", beforeRoleFamily, countBy(plan.planned, (f) => f.role_family));
  printDistribution(
    "student_friendly 桶",
    beforeStudentFriendly,
    countBy(plan.planned, (f) => f.student_friendly),
  );
  printTransitions(plan.planned, "role_family");
  printTransitions(plan.planned, "student_friendly");
  printHints(plan.hints, plan.candidates);

  if (allSkipped.length > 0) {
    console.log("\n跳过行及原因（这些行不会被写入）");
    for (const item of allSkipped) {
      console.log(
        `  ${item.row.source_key} | ${item.row.title} | ${item.row.id} | ${item.reason}`,
      );
    }
  }

  if (plan.planned.length > 0 && plan.planned.length <= 50) {
    console.log("\n待变更明细");
    for (const item of plan.planned) {
      const changed: string[] = [];
      if (item.before.role_family !== item.after.role_family) changed.push("role_family");
      if (item.before.degree !== item.after.degree) changed.push("degree");
      if (item.before.employment_type !== item.after.employment_type) changed.push("employment_type");
      if (item.before.student_friendly !== item.after.student_friendly) changed.push("student_friendly");
      if (item.before.experience_min_years !== item.after.experience_min_years) changed.push("experience_min_years");
      if (item.before.experience_max_years !== item.after.experience_max_years) changed.push("experience_max_years");
      if (listKey(item.before.skills) !== listKey(item.after.skills)) changed.push("skills");
      if (evidenceKey(item.before.skill_evidence) !== evidenceKey(item.after.skill_evidence)) {
        changed.push("skill_evidence");
      }
      console.log(
        `  ${item.row.source_key} | ${item.row.title} | 变更: ${changed.length === 0 ? "仅 normalizer_version" : changed.join(", ")}`,
      );
    }
  }

  printLimits(includeImported);

  if (applied === null) {
    console.log("\n未传 --apply，dry-run 结束，未写库。");
    return;
  }
  console.log(`\n已提交: 更新 ${applied} 行，跳过 ${allSkipped.length} 行。`);
}

async function main(): Promise<void> {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log("用法: node scripts/backfill-normalizer.ts [--apply] [--include-imported]");
    console.log("  默认 dry-run：只统计将变更的行、分桶对比与跳过原因，不写库。");
    console.log("  --apply：在单个事务内更新派生字段与 normalizer_version，失败整体回滚。");
    console.log("  --include-imported：默认只处理 data_origin='live'，加此开关一并处理 verified_import。");
    return;
  }
  const apply = process.argv.includes("--apply");
  const includeImported = process.argv.includes("--include-imported");
  const databaseUrl = loadDatabaseUrl();
  const sql = postgres(databaseUrl, { max: 2, connect_timeout: 10, onnotice: () => {} });

  try {
    const originFilter = includeImported
      ? sql`data_origin IN ('live', 'verified_import')`
      : sql`data_origin = 'live'`;
    // llm-* 是 LLM 兜底回填的当前版本（见 isCurrentNormalizerVersion）：它由模型判定，
    // 不能被本次文本扫描覆盖，否则已确认的派生值会退化为 unknown。
    const staleVersions = sql`(
      normalizer_version IS NULL
      OR (
        normalizer_version IS DISTINCT FROM ${NORMALIZER_VERSION}
        AND normalizer_version NOT LIKE ${`${LLM_NORMALIZER_VERSION_PREFIX}%`}
      )
    )`;
    const columns = sql`
      id, source_key, company_name, title, official_url, data_origin, normalizer_version,
      role_family, degree, employment_type, student_friendly,
      experience_min_years, experience_max_years, degree_raw, experience_raw,
      locations, skills, skill_evidence, raw_text, raw_payload,
      published_at, fetched_at, collector_version`;

    if (!apply) {
      const rows = await sql<JobRow[]>`
        SELECT ${columns}
        FROM career_jobs
        WHERE ${originFilter} AND ${staleVersions}
        ORDER BY source_key, title, id`;

      const plan = planRows(rows);
      printReport({
        plan,
        mode: "dry-run",
        databaseUrl,
        includeImported,
        writeSkipped: [],
        applied: null,
      });
      return;
    }

    // 事务内重新读取并锁行：避免 dry-run 之后的并发改动被陈旧的重算结果覆盖。
    // SKIP LOCKED 让被采集进程锁住的行本次跳过并计入 skipped，而不是阻塞采集。
    const outcome = await sql.begin(async (tx) => {
      const rows = await tx<JobRow[]>`
        SELECT ${columns}
        FROM career_jobs
        WHERE ${originFilter} AND ${staleVersions}
        ORDER BY source_key, title, id
        FOR UPDATE SKIP LOCKED`;

      const plan = planRows(rows);
      const writeSkipped: SkippedRow[] = [];
      let applied = 0;
      for (const item of plan.planned) {
        const result = await tx`
          UPDATE career_jobs SET
            role_family = ${item.after.role_family},
            degree = ${item.after.degree},
            employment_type = ${item.after.employment_type},
            student_friendly = ${item.after.student_friendly},
            experience_min_years = ${item.after.experience_min_years},
            experience_max_years = ${item.after.experience_max_years},
            skills = ${sql.json(item.after.skills as JSONValue)}::jsonb,
            skill_evidence = ${sql.json(item.after.skill_evidence as unknown as JSONValue)}::jsonb,
            normalizer_version = ${item.after.normalizer_version},
            updated_at = now()
          WHERE id = ${item.row.id}
            AND normalizer_version IS DISTINCT FROM ${NORMALIZER_VERSION}`;
        if (result.count !== 1) {
          writeSkipped.push({
            row: item.row,
            reason: `UPDATE 影响 ${result.count} 行（期望 1 行），行可能已被并发修改`,
          });
          continue;
        }
        applied += 1;
      }
      return { plan, applied, writeSkipped };
    });

    if (outcome.plan.planned.length === 0) {
      printReport({
        plan: outcome.plan,
        mode: "apply",
        databaseUrl,
        includeImported,
        writeSkipped: outcome.writeSkipped,
        applied: null,
      });
      console.log("\n没有需要变更的行。");
      return;
    }

    printReport({
      plan: outcome.plan,
      mode: "apply",
      databaseUrl,
      includeImported,
      writeSkipped: outcome.writeSkipped,
      applied: outcome.applied,
    });
  } catch (error) {
    console.error(`\n失败: ${(error as Error).message}`);
    process.exitCode = 1;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

if (import.meta.main) {
  await main();
}