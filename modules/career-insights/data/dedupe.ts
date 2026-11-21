import { createHash } from "node:crypto";
import type { NormalizedJobV1 } from "../contracts/index.ts";

/**
 * 只移除明确的跟踪参数和片段，不删除可能影响职位身份的参数。
 * 相同职位可能来自不同城市、批次或职位 ID，不能仅按标题去重。
 */
const TRACKING_PARAM_PATTERN = /^(utm_[a-z_]+|spm|from|ref|referrer|fbclid|gclid|yclid|mc_cid|mc_eid)$/i;

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function canonicalizeJobUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") return trimmed;
    url.hash = "";
    url.hostname = url.hostname.toLowerCase();
    for (const key of [...url.searchParams.keys()]) {
      if (TRACKING_PARAM_PATTERN.test(key)) url.searchParams.delete(key);
    }
    url.pathname = url.pathname.replace(/\/+$/, "") || "/";
    return url.toString();
  } catch {
    return trimmed;
  }
}

/** 官方职位 ID 优先；没有时使用规范化 URL 的 SHA-256。 */
export function computeJobKey(input: {
  source_job_id: string | null;
  official_url: string;
}): string {
  const sourceJobId = input.source_job_id?.trim();
  if (sourceJobId) return sourceJobId;
  return sha256Hex(canonicalizeJobUrl(input.official_url));
}

export type ContentHashInputV1 = Pick<
  NormalizedJobV1,
  | "schema_version"
  | "source_key"
  | "job_key"
  | "company_name"
  | "title"
  | "locations"
  | "degree_raw"
  | "experience_raw"
  | "raw_text"
>;

/**
 * 稳定顺序计算内容哈希。只覆盖来源内容：职位身份、标题、公司、地点、原始学历/经验文本与正文。
 * 派生分析（role_family、student_friendly、归一化 skills/skill_evidence、解析后的学历/经验）
 * 与 normalizer_version 不参与，保证同源内容在不同归一化版本下共享同一个源内容哈希。
 */
export function computeContentHash(job: ContentHashInputV1): string {
  return sha256Hex(JSON.stringify(sourceContentPayload(job)));
}

/** 跨归一化版本判断源内容是否未变：旧版本哈希已不可比时，按来源内容字段整体比较。 */
export function sourceContentEquals(
  left: ContentHashInputV1,
  right: ContentHashInputV1,
): boolean {
  return (
    JSON.stringify(sourceContentPayload(left)) === JSON.stringify(sourceContentPayload(right))
  );
}

function sourceContentPayload(job: ContentHashInputV1): Record<string, unknown> {
  return {
    schema_version: job.schema_version,
    source_key: job.source_key,
    job_key: job.job_key,
    company_name: normalizeText(job.company_name),
    title: normalizeText(job.title),
    locations: [...new Set(job.locations.map(normalizeText))].filter((item) => item !== "").sort(),
    degree_raw: normalizeNullableText(job.degree_raw),
    experience_raw: normalizeNullableText(job.experience_raw),
    raw_text: normalizeText(job.raw_text),
  };
}

export interface DedupeableJobV1 {
  source_key: string;
  job_key: string;
}

export interface DedupeResultV1<T extends DedupeableJobV1> {
  unique: T[];
  duplicates: T[];
}

/** 唯一身份 (source_key, job_key)；同一来源同一 job_key 只保留首条。 */
export function dedupeNormalizedJobs<T extends DedupeableJobV1>(
  jobs: readonly T[],
): DedupeResultV1<T> {
  const seen = new Set<string>();
  const unique: T[] = [];
  const duplicates: T[] = [];
  for (const job of jobs) {
    const identity = `${job.source_key}\u0000${job.job_key}`;
    if (seen.has(identity)) {
      duplicates.push(job);
    } else {
      seen.add(identity);
      unique.push(job);
    }
  }
  return { unique, duplicates };
}

export interface NearDuplicateGroupV1 {
  signature: string;
  jobs: Array<
    Pick<
      NormalizedJobV1,
      "source_key" | "job_key" | "company_name" | "title" | "locations" | "official_url"
    >
  >;
}

/**
 * 跨来源近重复只做人工复核分组，不自动合并。
 * 同公司、同标题、同城市仍可能是不同职位 ID 或不同批次。
 */
export function groupNearDuplicateJobs(
  jobs: ReadonlyArray<
    Pick<
      NormalizedJobV1,
      "source_key" | "job_key" | "company_name" | "title" | "locations" | "official_url"
    >
  >,
): NearDuplicateGroupV1[] {
  const groups = new Map<string, NearDuplicateGroupV1>();
  for (const job of jobs) {
    const signature = [
      normalizeText(job.company_name),
      normalizeText(job.title),
      [...job.locations].map(normalizeText).sort().join("|"),
    ].join("\u0000");
    const group = groups.get(signature);
    if (group === undefined) {
      groups.set(signature, { signature, jobs: [job] });
    } else {
      group.jobs.push(job);
    }
  }
  return [...groups.values()].filter((group) => group.jobs.length > 1);
}

function normalizeText(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim();
}

function normalizeNullableText(value: string | null): string | null {
  if (value === null) return null;
  const normalized = normalizeText(value);
  return normalized === "" ? null : normalized;
}