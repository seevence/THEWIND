import { sql, type Db } from "@aihot/backend/db";
import type { DataOrigin } from "../contracts/index.ts";
import type { PolicyEvidenceRefV1 } from "../contracts/job.ts";
import { InvalidParameterError } from "./errors.ts";
import { MAX_PAGE, MAX_PAGE_SIZE } from "./limits.ts";
import { careerPolicyRelevanceSql } from "./policy-relevance.ts";
import { resolveDataOrigin } from "./provenance.ts";
const EPOCH_ISO = "1970-01-01T00:00:00.000Z";
const EXCERPT_LIMIT = 500;

export interface PolicyFiltersV1 {
  source_key?: string;
  theme?: string;
  page: number;
  page_size: number;
}

export interface PolicySourceFacetV1 {
  source_key: string;
  count: number;
}

export interface PolicyThemeFacetV1 {
  theme_id: string;
  count: number;
}

export interface PolicyFacetsV1 {
  sources: PolicySourceFacetV1[];
  themes: PolicyThemeFacetV1[];
}

export interface PolicyListResponseV1 {
  contract_version: "0.1";
  data_origin: DataOrigin;
  as_of: string;
  items: PolicyEvidenceRefV1[];
  page: number;
  page_size: number;
  total: number;
  filters: PolicyFiltersV1;
  facets: PolicyFacetsV1;
}

interface PolicyRow {
  policy_item_id: string;
  title: string;
  issuer: string;
  published_at: Date;
  official_url: string;
  source_tier: string;
  theme_ids: string[] | null;
  evidence_excerpt: string;
}

function toDateOnly(value: Date | string): string {
  return typeof value === "string" ? value.slice(0, 10) : new Date(value).toISOString().slice(0, 10);
}

function toEvidenceRef(row: PolicyRow): PolicyEvidenceRefV1 {
  return {
    policy_item_id: row.policy_item_id,
    title: row.title,
    issuer: row.issuer,
    published_at: toDateOnly(row.published_at),
    official_url: row.official_url,
    source_tier: row.source_tier,
    theme_ids: row.theme_ids ?? [],
    evidence_excerpt: row.evidence_excerpt.slice(0, EXCERPT_LIMIT),
  };
}

/**
 * Policy list for the public site: only policies with a publication date, newest first, because
 * every item is shown with its date as evidence. Theme filtering matches one theme id inside the
 * stored theme array.
 */
export async function listPolicies(db: Db, filters: PolicyFiltersV1): Promise<PolicyListResponseV1> {
  if (!Number.isSafeInteger(filters.page) || filters.page < 1 || filters.page > MAX_PAGE) {
    throw new InvalidParameterError(`Query parameter must be between 1 and ${MAX_PAGE}: page.`, { parameter: "page" });
  }
  if (!Number.isSafeInteger(filters.page_size) || filters.page_size < 1 || filters.page_size > MAX_PAGE_SIZE) {
    throw new InvalidParameterError(`Query parameter must be between 1 and ${MAX_PAGE_SIZE}: page_size.`, {
      parameter: "page_size",
    });
  }
  const page = filters.page;
  const pageSize = filters.page_size;
  const condition = sql`
    ${filters.source_key === undefined ? sql`` : sql`AND source_key = ${filters.source_key}`}
    ${filters.theme === undefined ? sql`` : sql`AND theme_ids @> to_jsonb(ARRAY[${filters.theme}::text])`}
  `;
  // 列表、总数、分面与来源/截止时间都只统计通过相关性判定的政策（同一份标题规则），
  // 页面上的条目、分面计数和日报计数才一致。
  const [rows, totals, latest, origins, sourceFacets, themeFacets] = await Promise.all([
    db<PolicyRow[]>`
      SELECT policy_item_id, title, issuer, published_at, official_url, source_tier, theme_ids, evidence_excerpt
      FROM career_policies
      WHERE published_at IS NOT NULL AND ${careerPolicyRelevanceSql()} ${condition}
      ORDER BY published_at DESC, policy_item_id ASC
      LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`,
    db<{ total: number }[]>`
      SELECT COUNT(*)::int AS total
      FROM career_policies
      WHERE published_at IS NOT NULL AND ${careerPolicyRelevanceSql()} ${condition}`,
    db<{ as_of: Date | null }[]>`
      SELECT MAX(fetched_at) AS as_of
      FROM career_policies
      WHERE ${careerPolicyRelevanceSql()}`,
    db<{ data_origin: string; n: number }[]>`
      SELECT data_origin, COUNT(*)::int AS n
      FROM career_policies
      WHERE ${careerPolicyRelevanceSql()}
      GROUP BY data_origin`,
    db<PolicySourceFacetV1[]>`
      SELECT source_key, COUNT(*)::int AS count
      FROM career_policies
      WHERE published_at IS NOT NULL AND ${careerPolicyRelevanceSql()}
      GROUP BY source_key
      ORDER BY source_key ASC`,
    db<PolicyThemeFacetV1[]>`
      SELECT theme AS theme_id, COUNT(*)::int AS count
      FROM career_policies policy
      CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(policy.theme_ids, '[]'::jsonb)) AS theme
      WHERE policy.published_at IS NOT NULL AND ${careerPolicyRelevanceSql()}
      GROUP BY theme
      ORDER BY count DESC, theme ASC`,
  ]);

  const counts = { live: 0, verified_import: 0, synthetic_fixture: 0 };
  for (const row of origins) {
    if (row.data_origin === "live" || row.data_origin === "verified_import" || row.data_origin === "synthetic_fixture") {
      counts[row.data_origin] = row.n;
    }
  }

  return {
    contract_version: "0.1",
    data_origin: resolveDataOrigin(counts),
    as_of: latest[0]?.as_of === null || latest[0]?.as_of === undefined ? EPOCH_ISO : new Date(latest[0].as_of).toISOString(),
    items: rows.map(toEvidenceRef),
    page,
    page_size: pageSize,
    total: totals[0]?.total ?? 0,
    filters: { ...filters, page, page_size: pageSize },
    facets: {
      sources: sourceFacets.map((row) => ({ source_key: row.source_key, count: row.count })),
      themes: themeFacets.map((row) => ({ theme_id: row.theme_id, count: row.count })),
    },
  };
}