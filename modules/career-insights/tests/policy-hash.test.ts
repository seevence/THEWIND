// One policy must have one fingerprint. These tests pin that the collector write path and the draft
// import path produce the same hash, and that the six rows written with the old collector formula
// count as one update on their next write, then stay idempotent.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, beforeEach, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import type { PolicyDetailDraft } from "../collector/index.ts";
import { policyContentHash } from "../collector/adapters/policy-fingerprint.ts";
import { policyItemIdFromUrl } from "../collector/adapters/policy-id.ts";
import { policyBatchFromDrafts, policyItemFromDraft } from "../backend/policy-ingest.ts";
import { writePolicyBatch, type PolicyItemInputV1 } from "../backend/policy-repository.ts";

const SOURCE_KEY = "ndrc-policy";
const URL = "https://www.ndrc.gov.cn/xxgk/zcfb/tz/202611/t20261101_1.html";
const TITLE = "关于促进人工智能就业的通知";
const BODY = "大力推动人工智能人才培养和就业促进。";
const PUBLISHED = "2026-11-01";
const FETCHED_AT = "2026-11-19T08:08:00.000Z";
const EXCERPT = BODY.replace(/\s+/g, " ").slice(0, 200).trim();

const envelope = {
  source_key: SOURCE_KEY,
  source_tier: "government_official" as const,
  source_issuer: "国家发展和改革委员会",
  fetched_at: FETCHED_AT,
  collector_version: "collector/test-1",
};

function collectorItem(legacyHash = false): PolicyItemInputV1 {
  return {
    policy_item_id: policyItemIdFromUrl(URL),
    source_key: SOURCE_KEY,
    source_tier: "government_official",
    title: TITLE,
    issuer: "国家发展和改革委员会",
    published_at: PUBLISHED,
    official_url: URL,
    theme_ids: ["artificial_intelligence"],
    evidence_excerpt: EXCERPT,
    content_hash: legacyHash
      ? createHash("sha256").update(`${URL}\n${EXCERPT}`).digest("hex")
      : policyContentHash({
          source_key: SOURCE_KEY,
          policy_item_id: policyItemIdFromUrl(URL),
          title: TITLE,
          published_at: PUBLISHED,
          excerpt: EXCERPT,
        }),
    collector_version: "collector/test-1",
    fetched_at: FETCHED_AT,
  };
}

function draft(): PolicyDetailDraft {
  return {
    sourceKey: SOURCE_KEY,
    title: TITLE,
    url: URL,
    issuingAuthority: null,
    documentNumber: null,
    bodyRaw: BODY,
    publishedAt: `${PUBLISHED}T00:00:00.000Z`,
  };
}

async function countPolicies(): Promise<number> {
  const rows = await sql<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM career_policies`;
  return rows[0]!.n;
}

after(async () => {
  await closeDb();
});

beforeEach(async () => {
  await sql`TRUNCATE career_job_observations, career_jobs, career_policies, career_ingest_runs RESTART IDENTITY`;
});

test("the collector path and the draft import path produce the same content hash", () => {
  const fromCollector = collectorItem();
  const fromImport = policyItemFromDraft(draft(), envelope);

  assert.equal(fromImport.policy_item_id, fromCollector.policy_item_id);
  assert.equal(fromImport.content_hash, fromCollector.content_hash);
  assert.equal(fromImport.content_hash.length, 64);
});

test("the same draft imported twice counts one accept and one duplicate", async () => {
  const first = await writePolicyBatch(sql, policyBatchFromDrafts([draft()], envelope));
  const second = await writePolicyBatch(sql, policyBatchFromDrafts([draft()], envelope));

  assert.deepEqual(first, { accepted: 1, updated: 0, duplicates: 0, rejected: 0, errors: [] });
  assert.deepEqual(second, { accepted: 0, updated: 0, duplicates: 1, rejected: 0, errors: [] });
  assert.equal(await countPolicies(), 1);
});

test("rows written with the old collector hash count one update, then stay idempotent", async () => {
  const written = await writePolicyBatch(sql, {
    source_key: SOURCE_KEY,
    fetched_at: FETCHED_AT,
    collector_version: "collector/test-1",
    data_origin: "live",
    policies: [collectorItem(true)],
  });
  assert.equal(written.accepted, 1, "the historical row is seeded with the old formula");

  const migrated = await writePolicyBatch(sql, policyBatchFromDrafts([draft()], envelope));
  assert.equal(migrated.updated, 1, "the first write after the formula change refreshes the row once");
  assert.equal(migrated.accepted, 0);
  assert.equal(migrated.duplicates, 0);
  assert.equal(await countPolicies(), 1, "the fingerprint change never creates a second row");

  const afterMigration = await writePolicyBatch(sql, policyBatchFromDrafts([draft()], envelope));
  assert.deepEqual(afterMigration, { accepted: 0, updated: 0, duplicates: 1, rejected: 0, errors: [] });
  assert.equal(await countPolicies(), 1);
});