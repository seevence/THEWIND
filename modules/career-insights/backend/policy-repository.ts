import { sql as postgresSql, type Db } from "@aihot/backend/db";
import type { JSONValue } from "postgres";
import type { IngestResultV1 } from "../contracts/api.ts";
import type { DataOrigin, PolicyEvidenceRefV1 } from "../contracts/index.ts";
import { THEME_KEYWORDS } from "../data/dictionaries.ts";
import type { MetricJobInputV1 } from "../data/metrics.ts";
import { InvalidParameterError } from "./errors.ts";
import { assessPolicyRelevance, careerPolicyRelevanceSql } from "./policy-relevance.ts";
import { finishRun, startRun } from "./run-repository.ts";
import { inTransaction } from "./transaction.ts";

export type PolicySourceTier = "government_official" | "official_media" | "other_public";

export const POLICY_SOURCE_TIERS: readonly PolicySourceTier[] = [
  "government_official",
  "official_media",
  "other_public",
];

const OFFICIAL_HOSTS: readonly string[] = [
  "gov.cn",
  "xinhuanet.com",
  "news.cn",
  "people.com.cn",
  "chinanews.com.cn",
  "ce.cn",
  "gmw.cn",
  "youth.cn",
];

const EXCERPT_LIMIT = 500;
const POLICY_EVIDENCE_LIMIT = 50;
const MAX_BATCH_SIZE = 100;
const MAX_REPORTED_ISSUES = 3;

export interface PolicyItemInputV1 {
  policy_item_id: string;
  source_key: string;
  source_tier: PolicySourceTier;
  title: string;
  issuer: string;
  published_at: string | null;
  official_url: string;
  theme_ids: string[];
  evidence_excerpt: string;
  content_hash: string;
  collector_version: string;
  fetched_at: string;
}

export interface PolicyBatchInputV1 {
  source_key: string;
  fetched_at: string;
  collector_version: string;
  data_origin: DataOrigin;
  policies: readonly PolicyItemInputV1[];
}

interface PolicyRow {
  policy_item_id: string;
  title: string;
  issuer: string;
  published_at: Date | string | null;
  official_url: string;
  source_tier: string;
  theme_ids: string[] | null;
  evidence_excerpt: string;
}

interface JobProjectionRow {
  id: string;
  source_key: string;
  job_key: string;
  company_name: string;
  title: string;
  role_family: MetricJobInputV1["role_family"];
  locations: string[] | null;
  degree: MetricJobInputV1["degree"];
  employment_type: MetricJobInputV1["employment_type"];
  student_friendly: MetricJobInputV1["student_friendly"];
  skills: string[] | null;
  published_at: string | null;
  first_seen_at: Date;
  last_seen_at: Date;
  official_url: string;
}

function jsonThemes(themeIds: readonly string[]) {
  return postgresSql.json(themeIds as unknown as JSONValue);
}

function isOfficialUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  return OFFICIAL_HOSTS.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`));
}

function validatePolicy(item: PolicyItemInputV1, index: number): string | null {
  if (item.policy_item_id.trim() === "" || item.title.trim() === "" || item.issuer.trim() === "") {
    return `${index}: policy_item_id, title and issuer are required`;
  }
  if (!POLICY_SOURCE_TIERS.includes(item.source_tier)) {
    return `${index}.source_tier: unsupported source tier ${String(item.source_tier)}`;
  }
  if (item.published_at !== null) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(item.published_at)) {
      return `${index}.published_at: expected YYYY-MM-DD or null`;
    }
    // PostgreSQL silently moves 2026-02-30 to 2026-03-02; a policy date must not drift.
    const day = new Date(`${item.published_at}T00:00:00.000Z`);
    if (Number.isNaN(day.getTime()) || day.toISOString().slice(0, 10) !== item.published_at) {
      return `${index}.published_at: not a real calendar date`;
    }
  }
  if (!isOfficialUrl(item.official_url)) {
    return `${index}.official_url: not an official https source`;
  }
  if (!Array.isArray(item.theme_ids) || item.theme_ids.some((theme) => !(theme in THEME_KEYWORDS))) {
    return `${index}.theme_ids: contains a theme outside the dictionary`;
  }
  if (item.evidence_excerpt.trim() === "" || item.content_hash.trim() === "") {
    return `${index}.evidence_excerpt: excerpt and content hash are required`;
  }
  return null;
}

function toDateOnly(value: Date | string): string {
  return typeof value === "string" ? value.slice(0, 10) : new Date(value).toISOString().slice(0, 10);
}

export async function writePolicyBatch(db: Db, batch: PolicyBatchInputV1): Promise<IngestResultV1> {
  if (batch.policies.length > MAX_BATCH_SIZE) {
    throw new InvalidParameterError(`A policy batch may contain at most ${MAX_BATCH_SIZE} items.`, {
      parameter: "policies",
    });
  }

  const key = {
    kind: "policy" as const,
    source_key: batch.source_key,
    fetched_at: batch.fetched_at,
    collector_version: batch.collector_version,
    data_origin: batch.data_origin,
  };
  await startRun(db, key);

  try {
    const result = await inTransaction(db, async (tx) => {
      const counts = { accepted: 0, updated: 0, duplicates: 0 };
      const errors: IngestResultV1["errors"] = [];
      let rejected = 0;

      for (const [index, item] of batch.policies.entries()) {
        const problem = validatePolicy(item, index);
        if (problem !== null) {
          rejected += 1;
          if (errors.length < MAX_REPORTED_ISSUES) errors.push({ index, code: "validation_failed", message: problem });
          continue;
        }
        // 通用政府文件库会混进任免、选举、外事等与就业/产业无关的文件：入库即拒绝并计数，
        // 不静默丢弃，也不让它们以后再进库。判定只看标题，与读侧过滤同一份规则。
        const relevance = assessPolicyRelevance(item.title);
        if (!relevance.relevant) {
          rejected += 1;
          if (errors.length < MAX_REPORTED_ISSUES) {
            errors.push({
              index,
              code: "policy_irrelevant",
              message: relevance.reason === "excluded_topic"
                ? `title contains an excluded topic: ${relevance.matched}`
                : "title has no employment or industry-development keyword",
            });
          }
          continue;
        }

        const existing = await tx<{ id: string; content_hash: string }[]>`
          SELECT id, content_hash FROM career_policies
          WHERE source_key = ${item.source_key} AND policy_item_id = ${item.policy_item_id}
          FOR UPDATE`;
        const row = existing[0];

        if (row === undefined) {
          await tx`
            INSERT INTO career_policies (
              policy_item_id, source_key, source_tier, title, issuer, published_at, official_url,
              theme_ids, evidence_excerpt, content_hash, collector_version, data_origin,
              fetched_at, first_seen_at, last_seen_at
            ) VALUES (
              ${item.policy_item_id}, ${item.source_key}, ${item.source_tier}, ${item.title}, ${item.issuer},
              ${item.published_at}, ${item.official_url}, ${jsonThemes(item.theme_ids)}::jsonb,
              ${item.evidence_excerpt.slice(0, EXCERPT_LIMIT)}, ${item.content_hash},
              ${item.collector_version}, ${batch.data_origin},
              ${item.fetched_at}::timestamptz, ${item.fetched_at}::timestamptz, ${item.fetched_at}::timestamptz
            )`;
          counts.accepted += 1;
        } else if (row.content_hash === item.content_hash) {
          await tx`
            UPDATE career_policies
            SET last_seen_at = GREATEST(last_seen_at, ${item.fetched_at}::timestamptz), updated_at = now()
            WHERE id = ${row.id}`;
          counts.duplicates += 1;
        } else {
          await tx`
            UPDATE career_policies SET
              source_tier = ${item.source_tier},
              title = ${item.title},
              issuer = ${item.issuer},
              published_at = ${item.published_at},
              official_url = ${item.official_url},
              theme_ids = ${jsonThemes(item.theme_ids)}::jsonb,
              evidence_excerpt = ${item.evidence_excerpt.slice(0, EXCERPT_LIMIT)},
              content_hash = ${item.content_hash},
              collector_version = ${item.collector_version},
              data_origin = ${batch.data_origin},
              fetched_at = ${item.fetched_at}::timestamptz,
              last_seen_at = GREATEST(last_seen_at, ${item.fetched_at}::timestamptz),
              updated_at = now()
            WHERE id = ${row.id}`;
          counts.updated += 1;
        }
      }

      return { ...counts, rejected, errors };
    });

    const status = result.rejected > 0 ? "partial" : "ok";
    await finishRun(
      db,
      key,
      status,
      { job_count: batch.policies.length, ...result },
      result.rejected > 0 ? `${result.rejected} policy item(s) rejected` : null,
    );
    return result;
  } catch (error) {
    await finishRun(
      db,
      key,
      "failed",
      { job_count: batch.policies.length },
      error instanceof Error ? error.message : String(error),
    );
    throw error;
  }
}

export async function listPolicyEvidence(db: Db, limit = POLICY_EVIDENCE_LIMIT): Promise<PolicyEvidenceRefV1[]> {
  const rows = await db<PolicyRow[]>`
    SELECT policy_item_id, title, issuer, published_at, official_url, source_tier, theme_ids, evidence_excerpt
    FROM career_policies
    WHERE published_at IS NOT NULL AND ${careerPolicyRelevanceSql()}
    ORDER BY published_at DESC, policy_item_id ASC
    LIMIT ${Math.min(Math.max(limit, 0), POLICY_EVIDENCE_LIMIT)}`;

  return rows.map((row) => ({
    policy_item_id: row.policy_item_id,
    title: row.title,
    issuer: row.issuer,
    published_at: toDateOnly(row.published_at!),
    official_url: row.official_url,
    source_tier: row.source_tier,
    theme_ids: row.theme_ids ?? [],
    evidence_excerpt: row.evidence_excerpt.slice(0, EXCERPT_LIMIT),
  }));
}

export async function listMetricJobs(db: Db): Promise<MetricJobInputV1[]> {
  const rows = await db<JobProjectionRow[]>`
    SELECT id, source_key, job_key, company_name, title, role_family, locations, degree,
      employment_type, student_friendly, skills, published_at, first_seen_at, last_seen_at, official_url
    FROM career_jobs
    ORDER BY last_seen_at DESC, id ASC`;

  return rows.map((row) => ({
    id: String(row.id),
    source_key: row.source_key,
    job_key: row.job_key,
    company_name: row.company_name,
    title: row.title,
    role_family: row.role_family,
    locations: row.locations ?? [],
    degree: row.degree,
    employment_type: row.employment_type,
    student_friendly: row.student_friendly,
    skills: row.skills ?? [],
    published_at: row.published_at,
    first_seen_at: new Date(row.first_seen_at).toISOString(),
    last_seen_at: new Date(row.last_seen_at).toISOString(),
    official_url: row.official_url,
  }));
}