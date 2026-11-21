import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  CHANGSHA_RSJ_COLLECTOR_VERSION,
  CHANGSHA_RSJ_LIST_URL,
  CHANGSHA_RSJ_SOURCE_DEFINITION,
  CHANGSHA_RSJ_SOURCE_KEY,
  changshaRsjPolicyListPageUrl,
  createChangshaRsjPolicyAdapter,
  parseChangshaRsjPolicyDetail,
  parseChangshaRsjPolicyList,
  parseChangshaRsjPublishedDate,
  redactChangshaRsjPersonalData,
  resolveChangshaRsjIssuer,
  toChangshaRsjPolicyRef,
} from "../collector/adapters/changsha-rsj-policy.ts";
import { EmptyResultError, ParseFailedError, SchemaChangedError } from "../collector/fetch/errors.ts";
import { ReplayTransport, computeRequestKey } from "../collector/fetch/replay-transport.ts";
import type {
  FetchTransport,
  PageRequest,
  TransportResponse,
} from "../collector/fetch/transport.ts";
import { SampleStore, sha256Hex } from "../collector/evidence/sample-store.ts";
import type { SampleMeta } from "../collector/evidence/sample-store.ts";
import { containsPersonalData, sanitizeSample } from "../collector/evidence/sanitizer.ts";

const SAMPLES_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  "../collector/evidence/samples",
);
const SOURCE = "changsha-rsj-policy";
const SAMPLES_DIR = join(SAMPLES_ROOT, SOURCE, "samples");
const SAMPLE_NAMES = ["list.html", "list-2.html", "detail-1.html", "detail-2.html", "detail-3.html"];

interface LoadedSample {
  readonly name: string;
  readonly body: Buffer;
  readonly meta: SampleMeta;
}

async function readSample(name: string): Promise<string> {
  return readFile(join(SAMPLES_DIR, name), "utf8");
}

async function loadSamples(): Promise<LoadedSample[]> {
  const store = new SampleStore(SAMPLES_ROOT);
  const names = (await readdir(SAMPLES_DIR))
    .filter((name) => !name.endsWith(".meta.json"))
    .sort();
  const samples: LoadedSample[] = [];
  for (const name of names) {
    const record = await store.load(`${SOURCE}/samples/${name}`);
    samples.push({ name, body: record.body, meta: record.meta });
  }
  return samples;
}

function sampleResponse(sample: LoadedSample, requestUrl: string): TransportResponse {
  return {
    status: sample.meta.http_status,
    requestUrl,
    finalUrl: sample.meta.final_url,
    contentType: sample.meta.content_type,
    headers: {},
    body: sample.body,
    fetchedAt: sample.meta.captured_at,
  };
}

async function replayTransport(): Promise<ReplayTransport> {
  const samples = await loadSamples();
  return new ReplayTransport(
    samples.map((sample) => ({
      request_key: sample.meta.request_key,
      captured_at: sample.meta.captured_at,
      status: sample.meta.http_status,
      request_url: sample.meta.request_url,
      final_url: sample.meta.final_url,
      content_type: sample.meta.content_type,
      headers: {},
      body: sample.body,
    })),
  );
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

function listItem(path: string, title: string, date: string): string {
  return `<li><span>${date}</span><a href="${path}">${title}</a></li>`;
}

function listHtml(items: readonly string[]): string {
  return `<html><body><div class="right_list"><ul>${items.join("")}</ul></div></body></html>`;
}

function detailHtml(title: string, date: string, body: string, source = "市人社局"): string {
  return [
    "<html><body>",
    '<div class="article article2"><div class="oneColumn pub_border">',
    `<h1 class="article-title">${title}</h1>`,
    '<div class="pages_zz ">',
    `<span class="font">来源：<font id="ly">${source}</font></span>`,
    `<span class="font">发布时间：${date} 09:35</span>`,
    "</div>",
    `<div class="pages_content">${body}</div>`,
    "</div></div></body></html>",
  ].join("");
}

/**
 * 列表样本前 3 条详情页是含公示联系方式的公告，按 evidence 规则不能存成样本；
 * 回放测试把同源、正文无个人数据的三份真实详情样本按请求顺序交给适配器，
 * 验证「列表 → 详情 → PolicyEvidenceRefV1」的离线全链路。
 */
function mappedReplayTransport(
  listSamples: readonly LoadedSample[],
  detailSamples: readonly LoadedSample[],
): FetchTransport {
  let detailIndex = 0;
  return {
    async fetchPage(request: PageRequest): Promise<TransportResponse> {
      const key = computeRequestKey(request.url, request.method, request.body);
      const listSample = listSamples.find((sample) => sample.meta.request_key === key);
      if (listSample !== undefined) {
        return sampleResponse(listSample, request.url);
      }
      const detail = detailSamples[detailIndex];
      detailIndex += 1;
      if (detail === undefined) {
        throw new Error(`缺少详情回放样本：${key}`);
      }
      return sampleResponse(detail, request.url);
    },
  };
}

test("来源定义登记长沙人社局劳动就业栏目，接线前保持禁用", () => {
  assert.equal(CHANGSHA_RSJ_SOURCE_KEY, "changsha-rsj-policy");
  assert.equal(CHANGSHA_RSJ_SOURCE_DEFINITION.source_key, "changsha-rsj-policy");
  assert.equal(CHANGSHA_RSJ_SOURCE_DEFINITION.kind, "government_policy");
  assert.equal(CHANGSHA_RSJ_SOURCE_DEFINITION.access, "http");
  assert.equal(CHANGSHA_RSJ_SOURCE_DEFINITION.entry_url, CHANGSHA_RSJ_LIST_URL);
  assert.equal(CHANGSHA_RSJ_SOURCE_DEFINITION.enabled, false);
  assert.equal(
    CHANGSHA_RSJ_LIST_URL,
    "http://rsj.changsha.gov.cn/zxzx_0/tzgg_131288/ldjy_131291/",
  );
  assert.match(CHANGSHA_RSJ_SOURCE_DEFINITION.notes, /502/);
  assert.match(CHANGSHA_RSJ_SOURCE_DEFINITION.notes, /http/);
});

test("列表页解析出劳动就业子栏目的静态详情条目并带列表日期", async () => {
  const items = parseChangshaRsjPolicyList(await readSample("list.html"), CHANGSHA_RSJ_LIST_URL);
  assert.equal(items.length, 15);
  for (const item of items) {
    assert.match(
      item.url,
      /^http:\/\/rsj\.changsha\.gov\.cn\/zxzx_0\/tzgg_131288\/ldjy_131291\/\d{6}\/t\d+_\d+\.html$/,
    );
    assert.ok(item.title.length >= 4);
    assert.match(item.publishedAt ?? "", /^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/);
  }
  assert.equal(new Set(items.map((item) => item.url)).size, items.length);
  assert.ok(items.some((item) => item.title.includes("高校毕业生")));
  assert.ok(items.some((item) => item.title.includes("培训")));
});

test("列表丢弃 csrc.changsha.gov.cn 的 SPA 公示链接，不把 SPA 壳当详情", () => {
  const html = listHtml([
    listItem("./202611/t20261116_12617930.html", "本市静态公告", "2026-11-16"),
    listItem(
      "http://www.csrc.changsha.gov.cn/csrc_portal/newsbiz/index.html#/LXInformation/TalentKnow/Detail?keyId=1",
      "外部 SPA 公示",
      "2026-11-16",
    ),
    listItem("./other/t20261116_12617931.html", "非本栏目路径", "2026-11-16"),
  ]);
  const items = parseChangshaRsjPolicyList(html, CHANGSHA_RSJ_LIST_URL);
  assert.deepEqual(items.map((item) => item.title), ["本市静态公告"]);
});

test("详情页解析标题、来源、发布时间与正文", async () => {
  const items = parseChangshaRsjPolicyList(await readSample("list.html"), CHANGSHA_RSJ_LIST_URL);
  assert.ok(items.length >= 3);
  const detail = parseChangshaRsjPolicyDetail(
    await readSample("detail-1.html"),
    "http://rsj.changsha.gov.cn/zxzx_0/tzgg_131288/202610/t20261029_12602918.html",
    items[0]?.publishedAt ?? null,
  );
  assert.equal(detail.title, "长沙市2027届高校毕业生一次性求职补贴市本级复核情况公示");
  assert.equal(detail.issuingAuthority, "长沙市人力资源和社会保障局");
  assert.equal(detail.sourceLabel, "长沙市就业服务中心高校毕业生就业服务部");
  assert.equal(detail.publishedAt, "2026-10-29T00:00:00.000Z");
  assert.ok(detail.bodyRaw.includes("2027届高校毕业生"));
});

test("发文机关优先取标题「关于」前缀，公示类回退栏目固定机关", () => {
  assert.equal(
    resolveChangshaRsjIssuer("长沙市人力资源和社会保障局关于开展2026年度市级创业孵化基地复评和申报工作的通知"),
    "长沙市人力资源和社会保障局",
  );
  assert.equal(
    resolveChangshaRsjIssuer("长沙市教育局 长沙市人力资源和社会保障局关于做好某某工作的通知"),
    "长沙市教育局 长沙市人力资源和社会保障局",
  );
  assert.equal(
    resolveChangshaRsjIssuer("长沙市2027届高校毕业生一次性求职补贴市本级复核情况公示"),
    "长沙市人力资源和社会保障局",
  );
});

test("发布时间支持列表短横线与详情「发布时间：」，非法输入为 null", () => {
  assert.equal(parseChangshaRsjPublishedDate("2026-11-16"), "2026-11-16T00:00:00.000Z");
  assert.equal(parseChangshaRsjPublishedDate("2026-11-6"), "2026-11-06T00:00:00.000Z");
  assert.equal(parseChangshaRsjPublishedDate("2026年11月6日"), null);
  assert.equal(parseChangshaRsjPublishedDate(null), null);
});

test("摘录脱敏：邮箱、手机号、联系段落被隐去，且仍不超过 200 字", () => {
  const redacted = redactChangshaRsjPersonalData(
    "公示期间如有异议，请联系：张三，联系电话：0731-84907731，邮箱 hr@example.com。",
  );
  assert.equal(containsPersonalData(redacted), false);
  const detail = {
    sourceKey: CHANGSHA_RSJ_SOURCE_KEY,
    title: "关于某就业补贴的公示",
    url: "http://rsj.changsha.gov.cn/zxzx_0/tzgg_131288/202611/t20261106_12610919.html",
    issuingAuthority: "长沙市人力资源和社会保障局",
    sourceLabel: "市人社局",
    bodyRaw:
      "根据文件规定，现将补贴情况公示如下。联系电话：0731-84907731。联系人：张三 邮箱 hr@example.com。",
    publishedAt: "2026-11-06T00:00:00.000Z",
  };
  const ref = toChangshaRsjPolicyRef(detail);
  assert.equal(containsPersonalData(ref.evidence_excerpt), false);
  assert.ok(ref.evidence_excerpt.length <= 200);
  assert.ok(ref.evidence_excerpt.startsWith("根据文件规定"));
});

test("离线回放：列表 + 3 份详情样本产出 3 条 PolicyEvidenceRefV1", async () => {
  const samples = await loadSamples();
  const lists = samples.filter((sample) => sample.name.startsWith("list"));
  const details = samples.filter((sample) => sample.name.startsWith("detail"));
  const adapter = createChangshaRsjPolicyAdapter(mappedReplayTransport(lists, details), {
    itemLimit: 3,
    pageLimit: 1,
    sleep: async () => undefined,
  });
  const policies = await adapter.collect();
  assert.equal(policies.length, 3);
  assert.deepEqual(
    policies.map((policy) => policy.title),
    [
      "长沙市2027届高校毕业生一次性求职补贴市本级复核情况公示",
      "长沙市人力资源和社会保障局关于开展2026年度长沙市示范性青年人才创业孵化基地申报及复评工作的通知",
      "新型学徒制培训情况的公示",
    ],
  );
  for (const policy of policies) {
    assert.match(policy.policy_item_id, /^t\d{8}_\d+$/);
    assert.ok(policy.issuer.length >= 2);
    assert.match(policy.published_at, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(policy.source_tier, "government_official");
    assert.match(
      policy.official_url,
      /^http:\/\/rsj\.changsha\.gov\.cn\/zxzx_0\/tzgg_131288\/ldjy_131291\//,
    );
    assert.ok(policy.theme_ids.length <= 3);
    assert.ok(policy.evidence_excerpt.length > 0);
    assert.ok(policy.evidence_excerpt.length <= 200);
    assert.equal(containsPersonalData(policy.evidence_excerpt), false);
  }
  assert.ok(policies.some((policy) => policy.theme_ids.includes("employment_promotion")));
});

test("样本元信息完整、哈希一致、通过 evidence PII 规则", async () => {
  const samples = await loadSamples();
  assert.ok(samples.length >= 5);
  assert.ok(samples.filter((sample) => sample.name.startsWith("list")).length >= 2);
  assert.ok(samples.filter((sample) => sample.name.startsWith("detail")).length >= 3);
  for (const sample of samples) {
    const text = sample.body.toString("utf8");
    assert.equal(
      sanitizeSample({ headers: {}, bodyText: text }).ok,
      true,
      `${sample.name} 含个人数据`,
    );
    assert.equal(containsPersonalData(text), false, `${sample.name} 含个人数据`);
    assert.equal(sample.meta.http_status, 200);
    assert.equal(sample.meta.sanitized, true);
    assert.equal(sample.meta.collector_version, CHANGSHA_RSJ_COLLECTOR_VERSION);
    assert.equal(sample.meta.body_file, `${SOURCE}/samples/${sample.name}`);
    assert.match(sample.meta.request_key, /^GET http:\/\/rsj\.changsha\.gov\.cn\//);
    assert.equal(sample.meta.body_sha256, sha256Hex(sample.body));
    assert.equal(sample.meta.sample_id, sample.meta.body_sha256.slice(0, 16));
  }
  assert.deepEqual(
    samples.map((sample) => sample.name),
    [...SAMPLE_NAMES].sort(),
  );
});

test("同域请求间隔不小于 1s，详情条数受 itemLimit 限制", async () => {
  const samples = await loadSamples();
  const lists = samples.filter((sample) => sample.name.startsWith("list"));
  const details = samples.filter((sample) => sample.name.startsWith("detail"));
  const sleeps: number[] = [];
  const adapter = createChangshaRsjPolicyAdapter(mappedReplayTransport(lists, details), {
    itemLimit: 2,
    sleep: async (ms: number) => {
      sleeps.push(ms);
    },
  });
  const policies = await adapter.collect();
  assert.equal(policies.length, 2);
  assert.deepEqual(sleeps, [1_000, 1_000]);
});

test("分页地址按 kkpager 0 基约定生成，pageLimit 最多抓 3 页", async () => {
  assert.equal(changshaRsjPolicyListPageUrl(1), CHANGSHA_RSJ_LIST_URL);
  assert.equal(
    changshaRsjPolicyListPageUrl(2),
    "http://rsj.changsha.gov.cn/zxzx_0/tzgg_131288/ldjy_131291/index_1.html",
  );
  assert.equal(
    changshaRsjPolicyListPageUrl(3),
    "http://rsj.changsha.gov.cn/zxzx_0/tzgg_131288/ldjy_131291/index_2.html",
  );

  const requested: string[] = [];
  const transport: FetchTransport = {
    async fetchPage(request) {
      requested.push(request.url);
      if (request.url.includes("/t2026")) {
        return response(
          detailHtml("关于某就业补贴的公示", "2026-11-06", "根据文件规定，现将审核通过的就业补贴发放情况公示如下，公示期五天。"),
          request.url,
        );
      }
      const page = /index_(\d+)\.html$/.exec(request.url)?.[1] ?? "0";
      const day = String(Number(page) + 1).padStart(2, "0");
      return response(
        listHtml([listItem(`./202611/t20261106_1261091${page}.html`, `第${page}页就业公告`, `2026-11-${day}`)]),
        request.url,
      );
    },
  };
  const adapter = createChangshaRsjPolicyAdapter(transport, {
    itemLimit: 10,
    pageLimit: 99,
    sleep: async () => undefined,
  });
  const policies = await adapter.collect();
  const listRequests = requested.filter((url) => !url.includes("/t2026"));
  assert.deepEqual(listRequests, [
    CHANGSHA_RSJ_LIST_URL,
    changshaRsjPolicyListPageUrl(2),
    changshaRsjPolicyListPageUrl(3),
  ]);
  assert.equal(policies.length, 3);
});

test("空列表抛 EmptyResultError，不把空结果当成功", async () => {
  const adapter = createChangshaRsjPolicyAdapter(
    {
      async fetchPage(request) {
        return response(listHtml([]), request.url);
      },
    },
    { sleep: async () => undefined },
  );
  await assert.rejects(adapter.collect(), (error: unknown) => {
    assert.ok(error instanceof EmptyResultError);
    assert.equal(error.failureType, "empty_result");
    assert.equal(error.sourceKey, CHANGSHA_RSJ_SOURCE_KEY);
    return true;
  });
});

test("详情页缺正文时抛 SchemaChangedError", () => {
  assert.throws(
    () =>
      parseChangshaRsjPolicyDetail(
        '<html><body><h1 class="article-title">某就业公告</h1><div class="pages_zz">发布时间：2026-11-06 10:00</div></body></html>',
        "http://rsj.changsha.gov.cn/zxzx_0/tzgg_131288/202611/t20261106_12610919.html",
      ),
    (error: unknown) => {
      assert.ok(error instanceof SchemaChangedError);
      assert.equal(error.sourceKey, CHANGSHA_RSJ_SOURCE_KEY);
      return true;
    },
  );
});

test("详情页缺发布时间时整批 ParseFailedError，不返回部分成功", async () => {
  const transport: FetchTransport = {
    async fetchPage(request) {
      if (request.url.includes("/t2026")) {
        return response(
          detailHtml("某就业公告", "", "这是一段用于验证缺少发布时间时必须整批失败的政策正文内容。"),
          request.url,
        );
      }
      return response(
        listHtml([
          listItem("/zxzx_0/tzgg_131288/ldjy_131291/202611/t20261106_12610919.html", "某就业公告", ""),
        ]),
        request.url,
      );
    },
  };
  const adapter = createChangshaRsjPolicyAdapter(transport, { sleep: async () => undefined });
  await assert.rejects(adapter.collect(), (error: unknown) => {
    assert.ok(error instanceof ParseFailedError);
    assert.equal(error.failureType, "parse_failed");
    assert.equal(error.sourceKey, CHANGSHA_RSJ_SOURCE_KEY);
    assert.match(error.message, /发布时间/);
    return true;
  });
});

test("取消信号在采集开始前生效", async () => {
  const controller = new AbortController();
  controller.abort();
  const adapter = createChangshaRsjPolicyAdapter(await replayTransport(), {
    sleep: async () => undefined,
  });
  await assert.rejects(adapter.collect(controller.signal), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.name, "AbortError");
    return true;
  });
});

test("toChangshaRsjPolicyRef 的 policy_item_id 取详情 URL 末段", () => {
  const ref = toChangshaRsjPolicyRef({
    sourceKey: CHANGSHA_RSJ_SOURCE_KEY,
    title: "关于长沙市市本级2026年第二批次小微企业招用离校2年内未就业高校毕业生社会保险补贴情况的公示",
    url: "http://rsj.changsha.gov.cn/zxzx_0/tzgg_131288/202611/t20261106_12610859.html",
    issuingAuthority: "长沙市人力资源和社会保障局",
    sourceLabel: "长沙市就业服务中心公共就业服务部",
    bodyRaw: "根据《关于印发〈湖南省就业补助资金管理办法〉的通知》文件规定，现将补贴情况予以公示。",
    publishedAt: "2026-11-06T00:00:00.000Z",
  });
  assert.equal(ref.policy_item_id, "t20261106_12610859");
  assert.equal(ref.issuer, "长沙市人力资源和社会保障局");
  assert.equal(ref.published_at, "2026-11-06");
  assert.equal(ref.source_tier, "government_official");
  assert.ok(ref.theme_ids.includes("employment_promotion"));
});

test("详情发布时间兼容无秒的「发布时间：YYYY-MM-DD HH:MM」，也兼容带秒的 meta", () => {
  const html = detailHtml("某培训补贴公示", "2026-09-18", "根据文件规定，现将培训补贴情况予以公示。");
  const detail = parseChangshaRsjPolicyDetail(
    html,
    "http://rsj.changsha.gov.cn/zxzx_0/tzgg_131288/202609/t20260918_12571183.html",
  );
  assert.equal(detail.publishedAt, "2026-09-18T00:00:00.000Z");
});
