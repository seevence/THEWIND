// Policy ingestion and shared-theme reads are the D2 data path. These tests drive writePolicyBatch
// with real batches against PostgreSQL and then assert what the public summary will report, because
// the value of this chain is the evidence it can defend, not the rows it stores.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, beforeEach, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import type { NormalizedJobV1 } from "../contracts/index.ts";
import { ingestBatch } from "../backend/ingest.ts";
import { InvalidParameterError } from "../backend/errors.ts";
import {
  listPolicyEvidence,
  writePolicyBatch,
  type PolicyBatchInputV1,
  type PolicyItemInputV1,
} from "../backend/policy-repository.ts";
import { SqlCareerRepository } from "../backend/sql-repository.ts";

const FETCHED_AT = "2026-11-18T00:00:00.000Z";
const repository = new SqlCareerRepository(sql);

function policy(overrides: Partial<PolicyItemInputV1> = {}): PolicyItemInputV1 {
  return {
    policy_item_id: "policy-1",
    source_key: "gov-test",
    source_tier: "government_official",
    title: "人工智能人才发展政策",
    issuer: "测试机关",
    published_at: "2026-11-01",
    official_url: "https://www.gov.cn/zhengce/test-policy",
    theme_ids: ["artificial_intelligence"],
    evidence_excerpt: "支持人工智能人才培养。",
    content_hash: "b".repeat(64),
    collector_version: "test-collector-1",
    fetched_at: FETCHED_AT,
    ...overrides,
  };
}

function batchOf(policies: PolicyItemInputV1[], overrides: Partial<PolicyBatchInputV1> = {}): PolicyBatchInputV1 {
  return {
    source_key: policies[0]?.source_key ?? "gov-test",
    fetched_at: policies[0]?.fetched_at ?? FETCHED_AT,
    collector_version: "test-collector-1",
    data_origin: "verified_import",
    policies,
    ...overrides,
  };
}

function job(overrides: Partial<NormalizedJobV1> = {}): NormalizedJobV1 {
  return {
    schema_version: "1.0",
    normalizer_version: "normalizer/0.2.0",
    source_key: "iflytek-official-careers",
    job_key: "job-1",
    company_name: "测试科技有限公司",
    title: "机器学习工程师",
    official_url: "https://careers.example/jobs/job-1",
    role_family: "ai_algorithm",
    locations: ["北京"],
    degree: "bachelor",
    degree_raw: "本科",
    experience_min_years: 0,
    experience_max_years: 3,
    experience_raw: "1-3 年",
    employment_type: "campus",
    student_friendly: "yes",
    skills: ["python"],
    skill_evidence: [{ skill_id: "python", evidence_text: "熟悉 Python" }],
    published_at: null,
    fetched_at: FETCHED_AT,
    collector_version: "test-collector-1",
    content_hash: "a".repeat(64),
    raw_text: "岗位文本",
    raw_payload: { id: "job-1" },
    ...overrides,
  };
}

async function seedJobs(jobs: NormalizedJobV1[]): Promise<void> {
  await ingestBatch(sql, {
    schema_version: "1.0",
    source_key: jobs[0]!.source_key,
    fetched_at: jobs[0]!.fetched_at,
    collector_version: "test-collector-1",
    jobs,
  });
}

async function count(table: "career_policies" | "career_ingest_runs"): Promise<number> {
  const rows = await sql<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM ${sql(table)}`;
  return rows[0]!.n;
}

after(async () => {
  await closeDb();
});

beforeEach(async () => {
  await sql`TRUNCATE career_job_observations, career_jobs, career_policies, career_ingest_runs RESTART IDENTITY`;
});

test("a policy batch stores theme ids as a jsonb array and repeats count as duplicates", async () => {
  const first = await writePolicyBatch(sql, batchOf([policy()]));
  assert.deepEqual(first, { accepted: 1, updated: 0, duplicates: 0, rejected: 0, errors: [] });

  const rows = await sql<{ kind: string; themes: string[] }[]>`
    SELECT jsonb_typeof(theme_ids) AS kind, theme_ids AS themes FROM career_policies`;
  assert.equal(rows[0]!.kind, "array");
  assert.deepEqual(rows[0]!.themes, ["artificial_intelligence"]);

  const second = await writePolicyBatch(sql, batchOf([policy()]));
  assert.deepEqual(second, { accepted: 0, updated: 0, duplicates: 1, rejected: 0, errors: [] });
  assert.equal(await count("career_policies"), 1);
  assert.equal(await count("career_ingest_runs"), 1);
});

test("an invalid policy is rejected by index while the valid entries are written", async () => {
  const result = await writePolicyBatch(
    sql,
    batchOf([
      policy({ policy_item_id: "policy-bad-url", official_url: "https://example.com/policy" }),
      policy({ policy_item_id: "policy-2" }),
    ]),
  );
  assert.equal(result.rejected, 1);
  assert.equal(result.accepted, 1);
  assert.equal(result.errors[0]!.index, 0);
  assert.equal(result.errors[0]!.code, "validation_failed");
  assert.equal(await count("career_policies"), 1);
});

test("a batch that fails in the middle rolls back the rows it already accepted", async () => {
  await assert.rejects(() =>
    writePolicyBatch(
      sql,
      batchOf([
        policy({ policy_item_id: "policy-ok" }),
        // An unparsable timestamptz reaches PostgreSQL and fails after the first row was accepted.
        policy({ policy_item_id: "policy-bad-time", fetched_at: "2026-13-01T00:00:00.000Z" }),
      ]),
    ),
  );

  assert.equal(await count("career_policies"), 0);
  const runs = await sql<{ status: string; error: string | null }[]>`
    SELECT status, error FROM career_ingest_runs`;
  assert.equal(runs[0]!.status, "failed");
  assert.ok((runs[0]!.error ?? "").length > 0);
});

test("a date that does not exist on the calendar is rejected instead of drifting", async () => {
  const result = await writePolicyBatch(
    sql,
    batchOf([policy({ policy_item_id: "policy-bad-day", published_at: "2026-02-30" })]),
  );
  assert.equal(result.rejected, 1);
  assert.equal(result.accepted, 0);
  assert.equal(await count("career_policies"), 0);
});

test("policy evidence keeps only dated policies, newest first", async () => {
  await writePolicyBatch(
    sql,
    batchOf([
      policy({ policy_item_id: "policy-old", published_at: "2026-10-01" }),
      policy({ policy_item_id: "policy-new", published_at: "2026-11-10" }),
      policy({ policy_item_id: "policy-undated", published_at: null, content_hash: "c".repeat(64) }),
    ]),
  );

  const refs = await listPolicyEvidence(sql);
  assert.deepEqual(refs.map((ref) => ref.policy_item_id), ["policy-new", "policy-old"]);
  assert.deepEqual(refs[0]!.theme_ids, ["artificial_intelligence"]);
  assert.equal(refs[0]!.source_tier, "government_official");
});

test("a shared theme appears only when a policy theme meets an ingested job skill", async () => {
  await writePolicyBatch(sql, batchOf([policy()]));
  await seedJobs([
    job({
      skills: ["machine_learning"],
      skill_evidence: [{ skill_id: "machine_learning", evidence_text: "机器学习" }],
    }),
  ]);

  const summary = await repository.summary();
  assert.equal(summary.shared_themes.length, 1);
  const theme = summary.shared_themes[0]!;
  assert.equal(theme.theme_id, "artificial_intelligence");
  assert.equal(theme.policy_count, 1);
  assert.equal(theme.job_count, 1);

  const metric = summary.metrics.find((entry) => entry.metric_id === "policy_job_shared_themes")!;
  assert.equal(metric.status, "ok");
  assert.equal(metric.numerator_count, 1);
  assert.ok(metric.evidence.some((entry) => entry.kind === "policy"));
  assert.ok(metric.evidence.some((entry) => entry.kind === "job"));
});

test("policies without a matching job theme keep shared themes empty and explain why", async () => {
  await writePolicyBatch(sql, batchOf([policy({ theme_ids: ["talent_development"] })]));
  await seedJobs([job()]);

  const summary = await repository.summary();
  assert.deepEqual(summary.shared_themes, []);
  const metric = summary.metrics.find((entry) => entry.metric_id === "policy_job_shared_themes")!;
  assert.equal(metric.status, "insufficient_data");
  assert.equal(metric.value, null);
  assert.ok(
    summary.warnings.some((warning) => warning.message === "政策与职位暂未出现同一主题，不代表无共同方向。"),
  );
});
test("a leap day is accepted and stored as the same calendar date", async () => {
  const result = await writePolicyBatch(
    sql,
    batchOf([policy({ policy_item_id: "policy-leap", published_at: "2028-02-29" })]),
  );
  assert.equal(result.accepted, 1);
  const rows = await sql<{ day: string }[]>`SELECT published_at::text AS day FROM career_policies`;
  assert.equal(rows[0]!.day, "2028-02-29");
});

test("a policy batch over one hundred items is refused before anything is written", async () => {
  const many = Array.from({ length: 101 }, (_, index) => policy({ policy_item_id: `policy-${index}` }));
  await assert.rejects(() => writePolicyBatch(sql, batchOf(many)), InvalidParameterError);
  assert.equal(await count("career_policies"), 0);
});
test("the policy list pages newest first and filters by source and theme", async () => {
  await writePolicyBatch(
    sql,
    batchOf([
      policy({ source_key: "ndrc-policy", policy_item_id: "p-old", published_at: "2026-10-01", theme_ids: ["employment_promotion"] }),
      policy({
        source_key: "ndrc-policy",
        policy_item_id: "p-new",
        published_at: "2026-11-10",
        theme_ids: ["artificial_intelligence"],
      }),
    ]),
  );
  await writePolicyBatch(
    sql,
    batchOf([
      policy({
        source_key: "state-council-policy",
        policy_item_id: "p-other",
        published_at: "2026-11-05",
        theme_ids: ["employment_promotion"],
      }),
    ]),
  );

  const firstPage = await repository.listPolicies({ page: 1, page_size: 2 });
  assert.equal(firstPage.total, 3);
  assert.deepEqual(firstPage.items.map((item) => item.policy_item_id), ["p-new", "p-other"]);
  assert.deepEqual(firstPage.filters, { page: 1, page_size: 2 });

  const bySource = await repository.listPolicies({ source_key: "ndrc-policy", page: 1, page_size: 20 });
  assert.equal(bySource.total, 2);
  assert.deepEqual(bySource.items.map((item) => item.policy_item_id), ["p-new", "p-old"]);

  const byTheme = await repository.listPolicies({ theme: "employment_promotion", page: 1, page_size: 20 });
  assert.deepEqual(byTheme.items.map((item) => item.policy_item_id), ["p-other", "p-old"]);
});

test("the policy list reports the conservative origin and refuses synthetic rows", async () => {
  await writePolicyBatch(sql, batchOf([policy({ source_key: "ndrc-policy", policy_item_id: "p-import" })]));
  await writePolicyBatch(
    sql,
    batchOf([policy({ source_key: "state-council-policy", policy_item_id: "p-live", content_hash: "e".repeat(64) })], {
      data_origin: "live",
    }),
  );

  const listed = await repository.listPolicies({ page: 1, page_size: 20 });
  assert.equal(listed.data_origin, "verified_import");

  await writePolicyBatch(
    sql,
    batchOf([policy({ source_key: "synthetic-source", policy_item_id: "p-synthetic" })], {
      data_origin: "synthetic_fixture",
    }),
  );
  await assert.rejects(() => repository.listPolicies({ page: 1, page_size: 20 }));
});

test("an empty policy table lists nothing with an explicit empty origin", async () => {
  const listed = await repository.listPolicies({ page: 1, page_size: 20 });
  assert.deepEqual(listed.items, []);
  assert.equal(listed.total, 0);
  assert.equal(listed.data_origin, "live");
  assert.equal(listed.as_of, "1970-01-01T00:00:00.000Z");
  assert.deepEqual(listed.facets, { sources: [], themes: [] });
});
test("the repository refuses out-of-range paging instead of clamping it", async () => {
  for (const filters of [
    { page: 1, page_size: 1000 },
    { page: 1, page_size: 0 },
    { page: 10_001, page_size: 20 },
  ]) {
    await assert.rejects(() => repository.listPolicies(filters), InvalidParameterError);
  }
});
test("policy facets match the real grouping and ignore paging and filters", async () => {
  await writePolicyBatch(
    sql,
    batchOf([
      policy({
        source_key: "ndrc-policy",
        policy_item_id: "facet-1",
        published_at: "2026-11-01",
        theme_ids: ["artificial_intelligence"],
      }),
      policy({
        source_key: "ndrc-policy",
        policy_item_id: "facet-2",
        published_at: "2026-11-02",
        theme_ids: ["artificial_intelligence", "talent_development"],
        content_hash: "f".repeat(64),
      }),
    ]),
  );
  await writePolicyBatch(
    sql,
    batchOf([
      policy({
        source_key: "state-council-policy",
        policy_item_id: "facet-3",
        published_at: "2026-11-03",
        theme_ids: ["employment_promotion"],
        content_hash: "1".repeat(64),
      }),
    ]),
  );

  const page = await repository.listPolicies({ page: 1, page_size: 1 });
  assert.deepEqual(page.facets.sources, [
    { source_key: "ndrc-policy", count: 2 },
    { source_key: "state-council-policy", count: 1 },
  ]);
  assert.deepEqual(page.facets.themes, [
    { theme_id: "artificial_intelligence", count: 2 },
    { theme_id: "employment_promotion", count: 1 },
    { theme_id: "talent_development", count: 1 },
  ]);
  assert.equal(page.total, 3);
  assert.equal(page.items.length, 1, "paging does not shrink the facets");
  assert.equal(
    page.facets.sources.some((source) => source.source_key === "moe-policy"),
    false,
    "a source with no rows never appears in the facets",
  );

  const filtered = await repository.listPolicies({
    source_key: "ndrc-policy",
    theme: "talent_development",
    page: 2,
    page_size: 1,
  });
  assert.equal(filtered.total, 1);
  assert.deepEqual(filtered.facets, page.facets, "filters do not change the facets");
});
test("the openapi contract registers the hot, daily and signals endpoints", () => {
  const contract = JSON.parse(
    readFileSync(new URL("../contracts/openapi.json", import.meta.url), "utf8"),
  ) as {
    paths: Record<string, unknown>;
    components: { schemas: Record<string, unknown> };
  };

  for (const path of [
    "/api/site/career-insights/hot",
    "/api/site/career-insights/daily",
    "/api/site/career-insights/daily-comment",
    "/api/site/career-insights/signals",
    "/api/site/career-insights/jobs/availability",
  ]) {
    assert.ok(contract.paths[path], `missing path ${path}`);
  }
  for (const schema of [
    "CareerHotResponseV1",
    "CareerDailyResponseV1",
    "CareerDailyCommentResponseV1",
    "CareerSignalsResponseV1",
    "CareerHotEntryV1",
    "CareerDailySourceV1",
    "CareerSignalV1",
    "CareerSignalEvidenceV1",
    "CareerSignalSkippedV1",
    "CareerHotRoleFamilyCountV1",
    "JobAvailabilityStatus",
    "JobAvailabilityResponseV1",
  ]) {
    assert.ok(contract.components.schemas[schema], `missing schema ${schema}`);
  }
});