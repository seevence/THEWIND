import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  GOV_POLICY_LIST_URL,
  MOE_POLICY_LIST_URL,
  NDRC_POLICY_LIST_URL,
  createGovPolicySourceAdapter,
  createMoePolicySourceAdapter,
  createNdrcPolicySourceAdapter,
} from "../collector/adapters/policy-sources.ts";
import {
  parseGovPolicyList,
  parseMoePolicyList,
  parseNdrcPolicyList,
} from "../collector/adapters/policy-parse.ts";
import type { FetchTransport, TransportResponse } from "../collector/fetch/transport.ts";
import { EmptyResultError, ParseFailedError } from "../collector/fetch/errors.ts";

const SAMPLES = join(dirname(fileURLToPath(import.meta.url)), "../collector/evidence/samples");

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

async function sampleHtml(sourceKey: string, name: string): Promise<string> {
  return readFile(join(SAMPLES, sourceKey, "samples", name), "utf8");
}

async function transportFor(sourceKey: string, listUrl: string): Promise<FetchTransport> {
  const listHtml = await sampleHtml(sourceKey, "list.html");
  const parser =
    sourceKey === "state-council-policy"
      ? parseGovPolicyList
      : sourceKey === "ndrc-policy"
        ? parseNdrcPolicyList
        : parseMoePolicyList;
  const urls = parser(listHtml, listUrl)
    .slice(0, 3)
    .map((item) => item.url);
  const details = new Map<string, string>();
  for (let index = 0; index < urls.length; index += 1) {
    details.set(urls[index] as string, await sampleHtml(sourceKey, `detail-${index + 1}.html`));
  }

  return {
    async fetchPage(request) {
      const detail = details.get(request.url);
      if (detail !== undefined) return response(detail, request.url);
      if (request.url === listUrl) return response(listHtml, request.url);
      throw new Error(`未准备的请求：${request.url}`);
    },
  };
}

test("国务院政策适配器复用 PolicyEvidenceRefV1，产出 3 条", async () => {
  const transport = await transportFor("state-council-policy", GOV_POLICY_LIST_URL);
  const adapter = createGovPolicySourceAdapter(transport, {
    itemLimit: 3,
    sleep: async () => undefined,
  });

  const policies = await adapter.collect();
  assert.equal(policies.length, 3);
  for (const policy of policies) {
    assert.ok(policy.policy_item_id.length > 0);
    assert.ok(policy.title.length > 3);
    assert.ok(policy.issuer.length > 0);
    assert.match(policy.published_at, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(policy.source_tier, "government_official");
    assert.match(policy.official_url, /^https:\/\/www\.gov\.cn\//);
    assert.ok(Array.isArray(policy.theme_ids));
    assert.ok(policy.evidence_excerpt.length > 0);
    assert.ok(policy.evidence_excerpt.length <= 200);
  }
});

test("发改委政策适配器产出 3 条且发布机关固定", async () => {
  const transport = await transportFor("ndrc-policy", NDRC_POLICY_LIST_URL);
  const adapter = createNdrcPolicySourceAdapter(transport, {
    itemLimit: 3,
    sleep: async () => undefined,
  });

  const policies = await adapter.collect();
  assert.equal(policies.length, 3);
  for (const policy of policies) {
    assert.equal(policy.issuer, "国家发展改革委");
    assert.match(policy.published_at, /^\d{4}-\d{2}-\d{2}$/);
    assert.match(policy.official_url, /^https:\/\/www\.ndrc\.gov\.cn\/xxgk\/zcfb\/tz\//);
    assert.ok(policy.evidence_excerpt.length > 0);
  }
});

test("政治主题按共享词典标注，且不超过 3 个", async () => {
  const transport = await transportFor("state-council-policy", GOV_POLICY_LIST_URL);
  const adapter = createGovPolicySourceAdapter(transport, {
    itemLimit: 3,
    sleep: async () => undefined,
  });
  const policies = await adapter.collect();
  for (const policy of policies) {
    assert.ok(policy.theme_ids.length <= 3);
  }
});
test("教育部政策适配器复用 PolicyEvidenceRefV1，产出 3 条", async () => {
  const transport = await transportFor("moe-policy", MOE_POLICY_LIST_URL);
  const adapter = createMoePolicySourceAdapter(transport, {
    itemLimit: 3,
    sleep: async () => undefined,
  });

  const policies = await adapter.collect();
  assert.equal(policies.length, 3);
  for (const policy of policies) {
    assert.equal(policy.issuer, "教育部");
    assert.match(policy.published_at, /^\d{4}-\d{2}-\d{2}$/);
    assert.match(policy.official_url, /^https:\/\/www\.moe\.gov\.cn\//);
    assert.ok(policy.evidence_excerpt.length > 0);
  }
});
function govStub(listHtml: string, detailHtml: string): FetchTransport {
  return {
    async fetchPage(request) {
      return response(request.url === GOV_POLICY_LIST_URL ? listHtml : detailHtml, request.url);
    },
  };
}

test("国务院政策 issuer 无法判定时整批 ParseFailedError，不返回部分成功", async () => {
  const listHtml =
    '<ul><li><a href="https://www.gov.cn/zhengce/202611/content_9001.htm">某部门关于推动就业工作的通知</a><span>2026-11-18</span></li></ul>';
  const detailHtml =
    '<html><head><title>某部门关于推动就业工作的通知_部门_中国政府网</title></head><body><h1>某部门关于推动就业工作的通知</h1><div id="UCAP-CONTENT">为贯彻落实有关要求，现就推动就业工作通知如下，请各单位结合实际认真组织实施，确保各项措施落地见效。</div><div class="article">2026-11-18</div></body></html>';
  const adapter = createGovPolicySourceAdapter(govStub(listHtml, detailHtml), {
    sleep: async () => {},
  });

  await assert.rejects(adapter.collect(), (error: unknown) => {
    assert.ok(error instanceof ParseFailedError);
    assert.equal(error.failureType, "parse_failed");
    assert.equal(error.sourceKey, "state-council-policy");
    assert.match(error.message, /issuer 无法判定/);
    assert.match(error.message, /content_9001\.htm/);
    return true;
  });
});

test("国务院政策缺少发布时间时整批 ParseFailedError，不静默丢弃", async () => {
  const listHtml =
    '<ul><li><a href="https://www.gov.cn/zhengce/202611/content_9002.htm">国务院关于促进就业的若干意见</a></li></ul>';
  const detailHtml =
    '<html><head><title>国务院关于促进就业的若干意见_国务院_中国政府网</title></head><body><h1>国务院关于促进就业的若干意见</h1><div id="UCAP-CONTENT">国务院关于促进就业的若干意见，全文内容足够长，用于验证缺少发布时间时必须整批失败而不是静默跳过。</div></body></html>';
  const adapter = createGovPolicySourceAdapter(govStub(listHtml, detailHtml), {
    sleep: async () => {},
  });

  await assert.rejects(adapter.collect(), (error: unknown) => {
    assert.ok(error instanceof ParseFailedError);
    assert.equal(error.failureType, "parse_failed");
    assert.equal(error.sourceKey, "state-council-policy");
    assert.match(error.message, /发布时间/);
    return true;
  });
});

test("政策列表解析 0 条时抛 EmptyResultError，不把空列表当成功", async () => {
  const adapter = createGovPolicySourceAdapter(
    govStub("<ul></ul>", "<html></html>"),
    { sleep: async () => {} },
  );

  await assert.rejects(adapter.collect(), (error: unknown) => {
    assert.ok(error instanceof EmptyResultError);
    assert.equal(error.failureType, "empty_result");
    assert.equal(error.sourceKey, "state-council-policy");
    return true;
  });
});
