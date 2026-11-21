// The collector is the real writer of career_policies.policy_item_id: the last URL pathname segment
// without its .html suffix. This layer turns collector drafts into the policy batch that
// writePolicyBatch accepts, so it must reuse that identity — a second rule would store the same
// policy twice under UNIQUE (source_key, policy_item_id). Tests pin that identity, the theme and
// hash rules, and re-import idempotency.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { after, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { closeDb, sql } from "@aihot/backend/db";
import type { PolicyDetailDraft } from "../collector/index.ts";
import { parseGovPolicyList } from "../collector/adapters/policy-parse.ts";
import { GOV_POLICY_LIST_URL, createGovPolicySourceAdapter } from "../collector/adapters/policy-sources.ts";
import type { FetchTransport, TransportResponse } from "../collector/fetch/transport.ts";
import { policyBatchFromDrafts, policyItemFromDraft, policyItemIdFromDraft } from "../backend/policy-ingest.ts";
import { writePolicyBatch, listPolicyEvidence } from "../backend/policy-repository.ts";
import { SqlCareerRepository } from "../backend/sql-repository.ts";

const FETCHED_AT = "2026-11-19T08:08:00.000Z";
const repository = new SqlCareerRepository(sql);
const SAMPLES = join(dirname(fileURLToPath(import.meta.url)), "../collector/evidence/samples");

const envelope = {
  source_key: "ndrc-policy",
  source_tier: "government_official" as const,
  source_issuer: "国家发展和改革委员会",
  fetched_at: FETCHED_AT,
  collector_version: "collector/test-1",
};

/** The six policies the collector stored, with the id each row was written under. */
const STORED_POLICY_IDS: readonly (readonly [sourceKey: string, url: string, policyItemId: string])[] = [
  ["state-council-policy", "https://www.gov.cn/zhengce/202611/content_7086080.htm", "content_7086080"],
  [
    "state-council-policy",
    "https://www.gov.cn/zhengce/content/202611/content_7085591.htm",
    "content_7085591",
  ],
  ["state-council-policy", "https://www.gov.cn/zhengce/202611/content_7085529.htm", "content_7085529"],
  [
    "ndrc-policy",
    "https://www.ndrc.gov.cn/xxgk/zcfb/tz/202611/t20261113_1408810.html",
    "t20261113_1408810",
  ],
  [
    "ndrc-policy",
    "https://www.ndrc.gov.cn/xxgk/zcfb/tz/202611/t20261109_1408709.html",
    "t20261109_1408709",
  ],
  [
    "ndrc-policy",
    "https://www.ndrc.gov.cn/xxgk/zcfb/tz/202611/t20261103_1408504.html",
    "t20261103_1408504",
  ],
];

function draft(overrides: Partial<PolicyDetailDraft> = {}): PolicyDetailDraft {
  return {
    sourceKey: "ndrc-policy",
    title: "关于促进人工智能就业的通知",
    url: "https://www.ndrc.gov.cn/xxgk/zcfb/tz/202611/t20261101_1.html",
    issuingAuthority: null,
    documentNumber: "发改就业〔2026〕123号",
    bodyRaw: "大力推动人工智能人才培养和就业促进。",
    publishedAt: "2026-11-01T00:00:00.000Z",
    ...overrides,
  };
}

function response(body: string, url: string): TransportResponse {
  return {
    status: 200,
    requestUrl: url,
    finalUrl: url,
    contentType: "text/html; charset=utf-8",
    headers: { "content-type": "text/html; charset=utf-8" },
    body: Buffer.from(body),
    fetchedAt: "2026-11-18T08:00:00.000Z",
  };
}

async function sampleHtml(name: string): Promise<string> {
  return readFile(join(SAMPLES, "state-council-policy", "samples", name), "utf8");
}

async function govSamplesTransport(): Promise<FetchTransport> {
  const listHtml = await sampleHtml("list.html");
  const urls = parseGovPolicyList(listHtml, GOV_POLICY_LIST_URL)
    .slice(0, 3)
    .map((item) => item.url);
  const details = new Map<string, string>();
  for (let index = 0; index < urls.length; index += 1) {
    details.set(urls[index] as string, await sampleHtml(`detail-${index + 1}.html`));
  }
  return {
    async fetchPage(request) {
      const detail = details.get(request.url);
      if (detail !== undefined) return response(detail, request.url);
      if (request.url === GOV_POLICY_LIST_URL) return response(listHtml, request.url);
      throw new Error(`未准备的请求：${request.url}`);
    },
  };
}

after(async () => {
  await closeDb();
});

beforeEach(async () => {
  await sql`TRUNCATE career_job_observations, career_jobs, career_policies, career_ingest_runs RESTART IDENTITY`;
});

test("a draft maps to a policy item with a stable id, calendar date, themes and hash", () => {
  const item = policyItemFromDraft(draft(), envelope);

  assert.equal(item.policy_item_id, "t20261101_1");
  assert.equal(
    item.policy_item_id,
    policyItemFromDraft(draft({ documentNumber: null }), envelope).policy_item_id,
    "the document number must not be part of the identity",
  );
  assert.equal(item.published_at, "2026-11-01");
  assert.equal(item.issuer, "国家发展和改革委员会", "the source authority fills a missing issuer");
  assert.equal(item.source_tier, "government_official");
  assert.ok(item.theme_ids.includes("artificial_intelligence"));
  assert.ok(item.theme_ids.includes("talent_development"));
  assert.ok(item.theme_ids.includes("employment_promotion"));
  assert.ok(item.evidence_excerpt.length <= 500);
  assert.equal(item.content_hash.length, 64);
  assert.equal(policyItemFromDraft(draft(), envelope).content_hash, item.content_hash);
  assert.notEqual(policyItemFromDraft(draft({ bodyRaw: "仅推动人才培养。" }), envelope).content_hash, item.content_hash);
});

test("a draft keeps one id across tracking parameters and ignores the document number", () => {
  const base = draft({ documentNumber: null, url: "https://www.ndrc.gov.cn/xxgk/zcfb/tz/202611/t20261101_1.html" });
  const tracked = draft({
    documentNumber: "发改就业〔2026〕123号",
    url: "https://www.ndrc.gov.cn/xxgk/zcfb/tz/202611/t20261101_1.html?from=wechat#top",
  });

  assert.equal(policyItemIdFromDraft(base), "t20261101_1");
  assert.equal(policyItemIdFromDraft(base), policyItemIdFromDraft(tracked));
});

test("the six stored policies keep the id the collector wrote", () => {
  for (const [sourceKey, url, storedId] of STORED_POLICY_IDS) {
    const imported = policyItemIdFromDraft(draft({ sourceKey, url, documentNumber: "国发〔2026〕9号" }));
    assert.equal(imported, storedId, `${url} must keep the stored id`);
  }
});

test("the collector path and the draft import path give one policy one id", async () => {
  const adapter = createGovPolicySourceAdapter(await govSamplesTransport(), {
    itemLimit: 3,
    sleep: async () => undefined,
  });

  const collected = await adapter.collect();
  assert.equal(collected.length, 3);
  for (const ref of collected) {
    const imported = draft({
      sourceKey: "state-council-policy",
      title: ref.title,
      url: ref.official_url,
      documentNumber: "中发〔2026〕9号",
      bodyRaw: ref.evidence_excerpt,
      publishedAt: `${ref.published_at}T00:00:00.000Z`,
    });
    assert.equal(policyItemIdFromDraft(imported), ref.policy_item_id);
  }
});

test("a draft from another source is refused instead of being written under the wrong key", () => {
  assert.throws(() => policyItemFromDraft(draft({ sourceKey: "moe-policy" }), envelope), /does not match/);
});

test("drafts from one run become an idempotent policy batch that the list endpoint returns", async () => {
  const batch = policyBatchFromDrafts([draft()], envelope);
  const first = await writePolicyBatch(sql, batch);
  const second = await writePolicyBatch(sql, batch);

  assert.deepEqual(first, { accepted: 1, updated: 0, duplicates: 0, rejected: 0, errors: [] });
  assert.deepEqual(second, { accepted: 0, updated: 0, duplicates: 1, rejected: 0, errors: [] });

  const evidence = await listPolicyEvidence(sql);
  assert.equal(evidence.length, 1);

  assert.ok(evidence[0]!.theme_ids.includes("artificial_intelligence"));

  const listed = await repository.listPolicies({ theme: "artificial_intelligence", page: 1, page_size: 20 });
  assert.equal(listed.total, 1);
  assert.equal(listed.data_origin, "live");
  assert.equal(listed.items[0]!.policy_item_id, "t20261101_1");
});

test("re-importing a batch of a stored policy keeps a single row", async () => {
  const [, url, storedId] = STORED_POLICY_IDS[0]!;
  const collectEnvelope = {
    ...envelope,
    source_key: "state-council-policy",
    source_issuer: "国务院",
  };
  const batch = policyBatchFromDrafts(
    [
      draft({
        sourceKey: "state-council-policy",
        title: "关于做好高校毕业生就业创业工作的通知",
        url,
        documentNumber: "国发〔2026〕9号",
        bodyRaw: "促进高校毕业生就业创业。",
        publishedAt: "2026-11-15T00:00:00.000Z",
      }),
    ],
    collectEnvelope,
  );

  const first = await writePolicyBatch(sql, batch);
  const second = await writePolicyBatch(sql, batch);

  assert.equal(batch.policies[0]!.policy_item_id, storedId);
  assert.deepEqual(first, { accepted: 1, updated: 0, duplicates: 0, rejected: 0, errors: [] });
  assert.deepEqual(second, { accepted: 0, updated: 0, duplicates: 1, rejected: 0, errors: [] });

  const rows = await sql<{ n: number }[]>`
    SELECT COUNT(*)::int AS n FROM career_policies WHERE policy_item_id = ${storedId}`;
  assert.equal(rows[0]!.n, 1);
});

test("a draft without any theme keyword still writes with an empty theme array", async () => {
  const batch = policyBatchFromDrafts(
    [
      // 相关但没有任何主题关键词：判定只要求就业/产业发展相关，不要求能归到某个主题。
      draft({
        title: "关于规范劳务派遣用工管理的通知",
        bodyRaw: "规范劳务派遣用工管理。",
        documentNumber: "发改就业〔2026〕9号",
      }),
    ],
    envelope,
  );
  assert.deepEqual(batch.policies[0]!.theme_ids, []);

  const result = await writePolicyBatch(sql, batch);
  assert.equal(result.accepted, 1);

  const listed = await repository.listPolicies({ page: 1, page_size: 20 });
  assert.equal(listed.total, 1);
  assert.deepEqual(listed.items[0]!.theme_ids, []);
});