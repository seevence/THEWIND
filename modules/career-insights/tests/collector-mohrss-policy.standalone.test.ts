import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  MOHRSS_POLICY_LIST_URL,
  MOHRSS_POLICY_SOURCE_KEY,
  MOHRSS_SOURCE_DEFINITION,
  createMohrssPolicyAdapter,
  mohrssPolicyListPageUrl,
  parseMohrssPolicyDetail,
  parseMohrssPolicyList,
  parseMohrssPublishedDate,
  toMohrssPolicyRef,
} from "../collector/adapters/mohrss-policy.ts";
import { EmptyResultError, ParseFailedError, SchemaChangedError } from "../collector/fetch/errors.ts";
import { ReplayTransport } from "../collector/fetch/replay-transport.ts";
import type { FetchTransport, TransportResponse } from "../collector/fetch/transport.ts";
import { sha256Hex } from "../collector/evidence/sample-store.ts";
import type { SampleMeta } from "../collector/evidence/sample-store.ts";
import { sanitizeSample } from "../collector/evidence/sanitizer.ts";

const SAMPLES = join(
  dirname(fileURLToPath(import.meta.url)),
  "../collector/evidence/samples/mohrss-policy/samples",
);

async function sample(name: string): Promise<string> {
  return readFile(join(SAMPLES, name), "utf8");
}

async function sampleNames(): Promise<string[]> {
  return (await readdir(SAMPLES)).filter((name) => !name.endsWith(".meta.json"));
}

async function replayTransport(): Promise<ReplayTransport> {
  const names = await sampleNames();
  const samples = [];
  for (const name of names) {
    const body = await readFile(join(SAMPLES, name));
    const meta = JSON.parse(await readFile(join(SAMPLES, `${name}.meta.json`), "utf8")) as SampleMeta;
    samples.push({
      request_key: meta.request_key,
      captured_at: meta.captured_at,
      status: meta.http_status,
      request_url: meta.request_url,
      final_url: meta.final_url,
      content_type: meta.content_type,
      headers: {},
      body,
    });
  }
  return new ReplayTransport(samples);
}

function response(body: string, url: string): TransportResponse {
  return {
    status: 200,
    requestUrl: url,
    finalUrl: url,
    contentType: "text/html; charset=utf-8",
    headers: { "content-type": "text/html; charset=utf-8" },
    body: Buffer.from(body),
    fetchedAt: "2026-11-21T00:00:00.000Z",
  };
}

function listItemHtml(path: string, title: string): string {
  return `<li><div><h4><a href="${path}" title="${title}">${title}</a></h4><p class="font12">摘要</p></div></li>`;
}

function listHtml(items: readonly string[]): string {
  return `<html><body><div class="list_con_left"><ul>${items.join("")}</ul></div></body></html>`;
}

test("来源定义登记人社部中国就业网中央政策栏目，接线前保持禁用", () => {
  assert.equal(MOHRSS_SOURCE_DEFINITION.source_key, "mohrss-policy");
  assert.equal(MOHRSS_SOURCE_DEFINITION.kind, "government_policy");
  assert.equal(MOHRSS_SOURCE_DEFINITION.access, "http");
  assert.equal(MOHRSS_SOURCE_DEFINITION.entry_url, MOHRSS_POLICY_LIST_URL);
  assert.equal(MOHRSS_SOURCE_DEFINITION.enabled, false);
  assert.match(MOHRSS_POLICY_LIST_URL, /^https:\/\/chinajob\.mohrss\.gov\.cn\/zcfg\/zxzc\/zy\/$/);
  assert.ok(MOHRSS_SOURCE_DEFINITION.notes.includes("EO_Bot_Ssid"));
});

test("列表页解析出 /c/YYYY-MM-DD/<id>.shtml 条目，日期取 URL 路径段", async () => {
  const items = parseMohrssPolicyList(await sample("list.html"), MOHRSS_POLICY_LIST_URL);
  assert.ok(items.length >= 3);
  for (const item of items) {
    assert.match(item.url, /^https:\/\/chinajob\.mohrss\.gov\.cn\/c\/\d{4}-\d{2}-\d{2}\/\d+\.shtml$/);
    assert.ok(item.title.length >= 4);
    assert.match(item.publishedAt ?? "", /^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/);
  }
  assert.equal(new Set(items.map((item) => item.url)).size, items.length);
});

test("详情页解析标题、来源、发布日期与正文", async () => {
  const items = parseMohrssPolicyList(await sample("list.html"), MOHRSS_POLICY_LIST_URL);
  assert.ok(items.length >= 4);
  const detail = parseMohrssPolicyDetail(
    await sample("detail-1.html"),
    items[0]?.url ?? MOHRSS_POLICY_LIST_URL,
    items[0]?.publishedAt ?? null,
  );
  assert.ok(detail.title.length > 10);
  assert.ok(detail.bodyRaw.length > 100);
  assert.equal(detail.sourceLabel, "人力资源和社会保障部");
  assert.match(detail.publishedAt ?? "", /^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/);
  assert.equal(detail.issuingAuthority, "人力资源社会保障部 国家发展改革委 农业农村部");
});

test("发文机关优先取标题「关于」前缀，部门规章回退到正文公布信息", async () => {
  const items = parseMohrssPolicyList(await sample("list.html"), MOHRSS_POLICY_LIST_URL);
  assert.ok(items.length >= 4);
  const multiAgency = parseMohrssPolicyDetail(
    await sample("detail-3.html"),
    items[2]?.url ?? MOHRSS_POLICY_LIST_URL,
    items[2]?.publishedAt ?? null,
  );
  assert.equal(multiAgency.issuingAuthority, "人力资源社会保障部办公厅 中央社会工作部办公厅");

  const regulation = parseMohrssPolicyDetail(
    await sample("detail-4.html"),
    items[3]?.url ?? MOHRSS_POLICY_LIST_URL,
    items[3]?.publishedAt ?? null,
  );
  assert.equal(regulation.title, "超龄劳动者基本权益保障暂行规定");
  assert.equal(
    regulation.issuingAuthority,
    "人力资源社会保障部、国家卫生健康委、应急管理部、国家税务总局、国家医保局",
  );
});

test("发布时间支持详情页点分日期与 URL 短横线日期，非法输入为 null", () => {
  assert.equal(parseMohrssPublishedDate("2026.11.06"), "2026-11-06T00:00:00.000Z");
  assert.equal(parseMohrssPublishedDate("2026-11-6"), "2026-11-06T00:00:00.000Z");
  assert.equal(parseMohrssPublishedDate("2026/11/06"), "2026-11-06T00:00:00.000Z");
  assert.equal(parseMohrssPublishedDate("2026年11月6日"), null);
  assert.equal(parseMohrssPublishedDate(null), null);
});

test("离线回放：列表 + 详情样本产出 3 条 PolicyEvidenceRefV1", async () => {
  const transport = await replayTransport();
  const adapter = createMohrssPolicyAdapter(transport, { itemLimit: 3, sleep: async () => undefined });
  const policies = await adapter.collect();
  assert.equal(policies.length, 3);
  for (const policy of policies) {
    assert.match(policy.policy_item_id, /^\d+$/);
    assert.ok(policy.title.length > 5);
    assert.ok(policy.issuer.length > 2);
    assert.match(policy.published_at, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(policy.source_tier, "government_official");
    assert.match(policy.official_url, /^https:\/\/chinajob\.mohrss\.gov\.cn\/c\//);
    assert.ok(policy.theme_ids.length <= 3);
    assert.ok(policy.evidence_excerpt.length > 0);
    assert.ok(policy.evidence_excerpt.length <= 200);
  }
  assert.deepEqual(
    policies.map((policy) => policy.issuer),
    [
      "人力资源社会保障部 国家发展改革委 农业农村部",
      "人力资源社会保障部 国家发展改革委 农业农村部",
      "人力资源社会保障部办公厅 中央社会工作部办公厅",
    ],
  );
  assert.ok(policies.some((policy) => policy.theme_ids.includes("employment_promotion")));
});

test("样本正文通过 PII 脱敏规则，样本元信息齐全", async () => {
  const names = await sampleNames();
  assert.ok(names.length >= 4);
  for (const name of names) {
    const body = await readFile(join(SAMPLES, name));
    const text = body.toString("utf8");
    assert.equal(sanitizeSample({ headers: {}, bodyText: text }).ok, true, `${name} 含个人数据`);
    const meta = JSON.parse(await readFile(join(SAMPLES, `${name}.meta.json`), "utf8")) as SampleMeta;
    assert.equal(meta.http_status, 200);
    assert.equal(meta.sanitized, true);
    assert.match(meta.request_key, /^GET https:\/\/chinajob\.mohrss\.gov\.cn\//);
    assert.match(meta.body_sha256, /^[a-f0-9]{64}$/);
    assert.equal(meta.body_sha256, sha256Hex(body), `${name} 元信息哈希与正文不一致`);
    assert.equal(meta.sample_id, meta.body_sha256.slice(0, 16));
  }
});

test("同域请求间隔不小于 1s，详情条数受 itemLimit 限制", async () => {
  const transport = await replayTransport();
  const sleeps: number[] = [];
  const adapter = createMohrssPolicyAdapter(transport, {
    itemLimit: 2,
    sleep: async (ms: number) => {
      sleeps.push(ms);
    },
  });
  const policies = await adapter.collect();
  assert.equal(policies.length, 2);
  assert.deepEqual(sleeps, [1_000, 1_000]);
  const brokenSleep = createMohrssPolicyAdapter(transport, {
    itemLimit: 2,
    sleep: async () => {
      throw new Error("不应等待");
    },
  });
  await assert.rejects(brokenSleep.collect(), /不应等待/);
});

test("分页地址按 zcms index_N.shtml 约定生成", () => {
  assert.equal(mohrssPolicyListPageUrl(1), MOHRSS_POLICY_LIST_URL);
  assert.equal(
    mohrssPolicyListPageUrl(2),
    "https://chinajob.mohrss.gov.cn/zcfg/zxzc/zy/index_2.shtml",
  );
});

test("pageLimit 最多抓 3 页且跨页去重", async () => {
  const requested: string[] = [];
  const detailHtml = await sample("detail-1.html");
  const transport: FetchTransport = {
    async fetchPage(request) {
      requested.push(request.url);
      if (request.url.includes("/c/")) {
        return response(detailHtml, request.url);
      }
      const page = /index_(\d+)\.shtml$/.exec(request.url)?.[1] ?? "1";
      return response(listHtml([listItemHtml(`/c/2026-11-0${page}/10${page}.shtml`, `第${page}页就业政策通知`)]), request.url);
    },
  };
  const adapter = createMohrssPolicyAdapter(transport, { itemLimit: 10, pageLimit: 99, sleep: async () => undefined });
  const policies = await adapter.collect();
  const listRequests = requested.filter((url) => !url.includes("/c/"));
  assert.deepEqual(listRequests, [
    MOHRSS_POLICY_LIST_URL,
    mohrssPolicyListPageUrl(2),
    mohrssPolicyListPageUrl(3),
  ]);
  assert.equal(policies.length, 3);
  assert.equal(new Set(policies.map((policy) => policy.policy_item_id)).size, 3);
});

test("空列表抛 EmptyResultError，不把空结果当成功", async () => {
  const adapter = createMohrssPolicyAdapter(
    { async fetchPage(request) { return response(listHtml([]), request.url); } },
    { sleep: async () => undefined },
  );
  await assert.rejects(adapter.collect(), (error: unknown) => {
    assert.ok(error instanceof EmptyResultError);
    assert.equal(error.failureType, "empty_result");
    assert.equal(error.sourceKey, MOHRSS_POLICY_SOURCE_KEY);
    return true;
  });
});

test("发文机关无法判定时整批 ParseFailedError，不返回部分成功", async () => {
  const transport: FetchTransport = {
    async fetchPage(request) {
      if (request.url.includes("/c/")) {
        return response(
          '<div class="detail_con"><h4>关于某就业事项的通知</h4><div class="detail_info clearfix"><div class="fl link"></div><div class="fl date">2026.11.06</div></div><div class="detail_article">这是一段用于验证发文机关无法判定时必须整批失败的正文内容，长度足够。</div></div>',
          request.url,
        );
      }
      return response(
        listHtml([listItemHtml("/c/2026-11-06/631990.shtml", "关于某就业事项的通知")]),
        request.url,
      );
    },
  };
  const adapter = createMohrssPolicyAdapter(transport, { sleep: async () => undefined });
  await assert.rejects(adapter.collect(), (error: unknown) => {
    assert.ok(error instanceof ParseFailedError);
    assert.equal(error.failureType, "parse_failed");
    assert.equal(error.sourceKey, MOHRSS_POLICY_SOURCE_KEY);
    assert.match(error.message, /发文机关/);
    return true;
  });
});

test("详情页缺正文时抛 SchemaChangedError", async () => {
  assert.throws(
    () =>
      parseMohrssPolicyDetail(
        '<div class="detail_con"><h4>某就业政策</h4><div class="detail_info clearfix"><div class="fl link">人力资源和社会保障部</div></div></div>',
        "https://chinajob.mohrss.gov.cn/c/2026-11-06/1.shtml",
      ),
    (error: unknown) => {
      assert.ok(error instanceof SchemaChangedError);
      assert.equal(error.sourceKey, MOHRSS_POLICY_SOURCE_KEY);
      return true;
    },
  );
});

test("取消信号在采集开始前生效", async () => {
  const controller = new AbortController();
  controller.abort();
  const adapter = createMohrssPolicyAdapter(await replayTransport(), { sleep: async () => undefined });
  await assert.rejects(adapter.collect(controller.signal), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.name, "AbortError");
    return true;
  });
});

test("toMohrssPolicyRef 的 policy_item_id 去掉 .shtml 后缀", () => {
  const ref = toMohrssPolicyRef({
    sourceKey: MOHRSS_POLICY_SOURCE_KEY,
    title: "人力资源社会保障部 财政部关于做好高校毕业生就业工作的通知",
    url: "https://chinajob.mohrss.gov.cn/c/2026-11-06/631916.shtml",
    issuingAuthority: "人力资源社会保障部 财政部",
    sourceLabel: "人力资源和社会保障部",
    bodyRaw: "各省人力资源社会保障厅：为做好高校毕业生就业工作，现就有关工作通知如下。",
    publishedAt: "2026-11-06T00:00:00.000Z",
  });
  assert.equal(ref.policy_item_id, "631916");
  assert.equal(ref.issuer, "人力资源社会保障部 财政部");
  assert.equal(ref.published_at, "2026-11-06");
  assert.equal(ref.source_tier, "government_official");
  assert.ok(ref.theme_ids.includes("employment_promotion"));
  assert.ok(ref.evidence_excerpt.startsWith("各省人力资源社会保障厅"));
});
