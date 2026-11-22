import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  HUNAN_RSJ_ISSUER,
  HUNAN_RSJ_LIST_URL,
  HUNAN_RSJ_SOURCE_DEFINITION,
  HUNAN_RSJ_SOURCE_KEY,
  createHunanRsjPolicyAdapter,
  parseHunanRsjDetail,
  parseHunanRsjList,
} from "../collector/adapters/hunan-rsj-policy.ts";
import { EmptyResultError, ParseFailedError } from "../collector/fetch/errors.ts";
import { loadHtmlDocument } from "../collector/html/parse.ts";
import type {
  FetchTransport,
  PageRequest,
  TransportResponse,
} from "../collector/fetch/transport.ts";

const SAMPLES = join(dirname(fileURLToPath(import.meta.url)), "../collector/evidence/samples");
const POLICY_SAMPLES_DIR = join(SAMPLES, "hunan-rsj-policy/samples");
const ARTICLE_PATH_PATTERN = /^\/rst\/xxgk\/tzgg\/\d{6}\/t\d{8}_\d+\.html$/;

const ARTICLE_1_URL = "http://rst.hunan.gov.cn/rst/xxgk/tzgg/202611/t20261120_11800001.html";
const ARTICLE_2_URL = "http://rst.hunan.gov.cn/rst/xxgk/tzgg/202610/t20261008_11800002.html";

function response(body: string, url: string): TransportResponse {
  return {
    status: 200,
    requestUrl: url,
    finalUrl: url,
    contentType: "text/html; charset=utf-8",
    headers: { "content-type": "text/html; charset=utf-8" },
    body: Buffer.from(body),
    fetchedAt: "2026-11-22T00:00:00.000Z",
  };
}

/** 真实站点的列表页骨架：导航 <i> 与「通知公告」容器 .xxgkzd-box .box ul 并存。 */
function listHtml(items: readonly string[]): string {
  return [
    "<html><body>",
    '<div class="zfxxgk-nav"><ul>',
    '<li><a href="/index.html">首页</a></li>',
    '<li><a href="/rst/xxgk/zcfg/index.html">政策法规</a></li>',
    "</ul></div>",
    '<div class="zfxxgk-content">',
    '<div class="xxgklist-title"><a href="/rst/xxgk/tzgg/index.html">通知公告</a></div>',
    '<div class="xxgkzd-box"><div class="box"><ul>',
    items.join(""),
    "</ul></div></div>",
    "</div></body></html>",
  ].join("");
}

function listItem(href: string, title: string, date: string): string {
  return `<li><a href="${href}" target="_blank">${title}</a><span>${date}</span></li>`;
}

function detailHtml(input: {
  readonly title?: string;
  readonly date?: string;
  readonly paragraphs?: readonly string[];
}): string {
  const paragraphs = input.paragraphs ?? [];
  return [
    "<html><head><title>详情 - 湖南省人力资源和社会保障厅</title></head><body>",
    '<div class="pagecont">',
    `<h1 class="articletitle">${input.title ?? ""}</h1>`,
    `<div class="pinfo">湖南省人力资源和社会保障厅${input.date === undefined ? "" : `　发布时间：${input.date} 10:30`}</div>`,
    '<div class="articleCont" id="j-show-body">',
    paragraphs.map((paragraph) => `<p>${paragraph}</p>`).join(""),
    "</div></div></body></html>",
  ].join("");
}

interface RecordingTransport extends FetchTransport {
  readonly requests: PageRequest[];
}

function recordingTransport(handler: (request: PageRequest) => string): RecordingTransport {
  const requests: PageRequest[] = [];
  return {
    requests,
    async fetchPage(request) {
      requests.push(request);
      return response(handler(request), request.url);
    },
  };
}

const DEFAULT_LIST = listHtml([
  listItem(
    "/rst/xxgk/tzgg/202611/t20261120_11800001.html",
    "关于做好  2026  年就业帮扶工作的通知",
    "2026-11-20",
  ),
  listItem(
    "./202610/t20261008_11800002.html",
    "关于开展职业技能培训补贴申报的通知",
    "2026-10-08",
  ),
]);

function detailFor(url: string): string {
  if (url === ARTICLE_2_URL) {
    return detailHtml({
      title: "关于开展职业技能培训补贴申报的通知",
      date: "2026-10-08",
      paragraphs: [
        "根据就业补助资金管理办法，现将职业技能培训补贴申报有关事项通知如下。",
        "符合条件的劳动者可按规定申请，各培训机构应按要求提交材料。",
      ],
    });
  }
  return detailHtml({
    title: "关于做好2026年就业帮扶工作的通知",
    date: "2026-11-20",
    paragraphs: [
      "为进一步做好高校毕业生等重点群体就业帮扶工作，现将有关事项通知如下。",
      "各市州人社部门要抓好落实，按月报送进展。",
    ],
  });
}

test("来源定义登记湖南人社通知公告栏目", () => {
  assert.equal(HUNAN_RSJ_SOURCE_KEY, "hunan-rsj-policy");
  assert.equal(HUNAN_RSJ_SOURCE_DEFINITION.source_key, HUNAN_RSJ_SOURCE_KEY);
  assert.equal(HUNAN_RSJ_SOURCE_DEFINITION.kind, "government_policy");
  assert.equal(HUNAN_RSJ_SOURCE_DEFINITION.access, "http");
  assert.equal(HUNAN_RSJ_SOURCE_DEFINITION.entry_url, HUNAN_RSJ_LIST_URL);
  assert.equal(HUNAN_RSJ_SOURCE_DEFINITION.enabled, true);
  assert.equal(HUNAN_RSJ_ISSUER, "湖南省人力资源和社会保障厅");
  assert.equal(HUNAN_RSJ_LIST_URL, "http://rst.hunan.gov.cn/rst/xxgk/tzgg/index.html");
  assert.match(HUNAN_RSJ_SOURCE_DEFINITION.notes ?? "", /\.xxgkzd-box \.box ul > li/);
  assert.match(HUNAN_RSJ_SOURCE_DEFINITION.notes ?? "", /http 明文/);
});

test("列表解析只取通知公告容器内的政策条目，排除导航与栏目链接", () => {
  const items = parseHunanRsjList(
    listHtml([
      listItem(
        "/rst/xxgk/tzgg/202611/t20261120_11800001.html",
        "关于做好  2026  年就业帮扶工作的通知",
        "2026-11-20",
      ),
      listItem("./202610/t20261008_11800002.html", "关于开展职业技能培训补贴申报的通知", "2026-10-08"),
      "<li><span>2026-09-01</span></li>",
      listItem("/rst/xxgk/tzgg/202608/t20260801_11800003.html", "   ", "2026-08-01"),
      listItem("/rst/xxgk/tzgg/202609/t20260901_11800004.html", "无日期条目", ""),
      listItem("/rst/xxgk/zcfg/202609/t20260902_11800005.html", "栏目外链接公告", "2026-09-02"),
      listItem("/index.html", "首页", "2026-09-03"),
    ]),
    HUNAN_RSJ_LIST_URL,
  );
  assert.deepEqual(
    items.map((item) => item.url),
    [ARTICLE_1_URL, ARTICLE_2_URL],
  );
  assert.equal(items[0]?.title, "关于做好 2026 年就业帮扶工作的通知");
  assert.equal(items[0]?.publishedAt, "2026-11-20T00:00:00.000Z");
  assert.equal(items[1]?.publishedAt, "2026-10-08T00:00:00.000Z");
});

test("真实列表样本回放只产出通知公告政策条目，不含站点导航", async () => {
  const html = await readFile(join(POLICY_SAMPLES_DIR, "list-1.html"), "utf8");
  const items = parseHunanRsjList(html, HUNAN_RSJ_LIST_URL);
  assert.ok(items.length > 0, "真实列表样本应解析出政策条目");
  assert.ok(items.length <= 30, `真实列表单页条目数异常：${items.length}`);
  for (const item of items) {
    assert.match(new URL(item.url).pathname, ARTICLE_PATH_PATTERN);
    assert.notEqual(item.title, "首页");
    assert.ok(item.title.length >= 4, `标题过短：${item.title}`);
    assert.ok(item.publishedAt !== null);
  }
  assert.equal(new Set(items.map((item) => item.url)).size, items.length);
});

test("详情解析标题、段落正文与 div.pinfo 发布时间，缺失日期回退列表日期", () => {
  const url = ARTICLE_1_URL;
  const html = detailFor(url);
  const detail = parseHunanRsjDetail(html, url);
  assert.equal(detail.sourceKey, HUNAN_RSJ_SOURCE_KEY);
  assert.equal(detail.title, "关于做好2026年就业帮扶工作的通知");
  assert.equal(detail.issuingAuthority, HUNAN_RSJ_ISSUER);
  assert.equal(detail.publishedAt, "2026-11-20T00:00:00.000Z");
  assert.ok(detail.bodyRaw.includes("高校毕业生等重点群体就业帮扶"));
  assert.equal(detail.bodyRaw.split("\n").length, 2, "正文应保留段落边界");

  const withoutDate = parseHunanRsjDetail(
    detailHtml({ title: "某培训通知", paragraphs: ["培训补贴申报正文内容。"] }),
    "http://rst.hunan.gov.cn/rst/xxgk/tzgg/202609/t20260901_1.html",
    "2026-09-01T00:00:00.000Z",
  );
  assert.equal(withoutDate.publishedAt, "2026-09-01T00:00:00.000Z");
  assert.ok(withoutDate.bodyRaw.length > 0);
});

test("真实详情样本正文可解析（非 JS 跳转壳）", async () => {
  for (const file of ["detail-1.html", "detail-2.html"]) {
    const html = await readFile(join(POLICY_SAMPLES_DIR, file), "utf8");
    const meta = JSON.parse(
      await readFile(join(POLICY_SAMPLES_DIR, `${file}.meta.json`), "utf8"),
    ) as { request_url: string };
    const detail = parseHunanRsjDetail(html, meta.request_url);
    assert.ok(detail.title.length > 0, `${file} 标题为空`);
    assert.ok(detail.bodyRaw.length >= 20, `${file} 正文过短（${detail.bodyRaw.length}）`);
    assert.ok(detail.publishedAt !== null, `${file} 缺少发布时间`);
  }
});

test("正文主体在 span/font 内（不在 <p> 里）时仍作为首段保留", () => {
  const url = ARTICLE_1_URL;
  const html = [
    "<html><body>",
    '<h1 class="articletitle">关于第六批创业孵化基地认定的公示</h1>',
    '<div class="pinfo">湖南省人力资源和社会保障厅　发布时间：2026-11-20 17:30</div>',
    '<div class="articleCont" id="j-show-body">',
    '<p></p><p></p>',
    "<span><font>根据《湖南省省级大学生创业孵化基地认定管理办法》要求，现将第六批名单公示如下。</font></span>",
    '<p><span>联系电话：0731—84900136。</span></p>',
    "</div></body></html>",
  ].join("");
  const detail = parseHunanRsjDetail(html, url);
  const paragraphs = detail.bodyRaw.split("\n");
  assert.equal(paragraphs.length, 2);
  assert.match(paragraphs[0] ?? "", /^根据《湖南省省级大学生创业孵化基地认定管理办法》/);
  assert.ok(detail.bodyRaw.includes("联系电话"));
});

test("真实 detail-1 正文取整个容器、段落数 > 1，摘录落在公告首段", async () => {
  const html = await readFile(join(POLICY_SAMPLES_DIR, "detail-1.html"), "utf8");
  const meta = JSON.parse(
    await readFile(join(POLICY_SAMPLES_DIR, "detail-1.html.meta.json"), "utf8"),
  ) as { request_url: string };
  const detail = parseHunanRsjDetail(html, meta.request_url);
  const paragraphs = detail.bodyRaw.split("\n").filter((line) => line.length > 0);

  assert.ok(paragraphs.length > 1, `正文段落数应大于 1，实际 ${paragraphs.length} 段`);
  assert.match(paragraphs[0] ?? "", /^根据《关于印发/);
  assert.ok(detail.bodyRaw.includes("第六批省级大学生创业孵化基地"));

  const containerText = loadHtmlDocument(html, meta.request_url).text("div.articleCont") ?? "";
  const bodyText = detail.bodyRaw.replace(/\s+/g, "");
  assert.ok(
    bodyText.length >= containerText.replace(/\s+/g, "").length,
    `正文未覆盖容器全文：${bodyText.length} < ${containerText.replace(/\s+/g, "").length}`,
  );

  const transport = recordingTransport((request) =>
    request.url === HUNAN_RSJ_LIST_URL
      ? listHtml([
          listItem(
            new URL(meta.request_url).pathname,
            "关于第六批省级大学生创业孵化基地认定名单的公示",
            "2026-11-20",
          ),
        ])
      : html,
  );
  const policies = await createHunanRsjPolicyAdapter(transport, {
    itemLimit: 1,
    sleep: async () => undefined,
  }).collect();
  const excerpt = policies[0]?.evidence_excerpt ?? "";
  assert.ok(excerpt.includes("根据《关于印发"), `摘录未落在正文首段：${excerpt}`);
  assert.ok(!excerpt.includes("联系电话"), `摘录落在联系方式段落：${excerpt}`);
  assert.ok(excerpt.length > 0 && excerpt.length <= 200);
});

test("采集列表 + 详情产出 PolicyEvidenceRefV1，详情间 sleep(1000)", async () => {
  const transport = recordingTransport((request) =>
    request.url === HUNAN_RSJ_LIST_URL ? DEFAULT_LIST : detailFor(request.url),
  );
  const sleeps: number[] = [];
  const adapter = createHunanRsjPolicyAdapter(transport, {
    itemLimit: 2,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  const policies = await adapter.collect();

  assert.deepEqual(
    transport.requests.map((request) => request.url),
    [HUNAN_RSJ_LIST_URL, ARTICLE_1_URL, ARTICLE_2_URL],
  );
  assert.deepEqual(sleeps, [1_000, 1_000]);
  assert.equal(policies.length, 2);
  const first = policies[0];
  assert.ok(first !== undefined);
  assert.equal(first.policy_item_id, "t20261120_11800001");
  assert.equal(first.title, "关于做好2026年就业帮扶工作的通知");
  assert.equal(first.issuer, HUNAN_RSJ_ISSUER);
  assert.equal(first.published_at, "2026-11-20");
  assert.equal(first.official_url, ARTICLE_1_URL);
  assert.equal(first.source_tier, "government_official");
  assert.ok(first.theme_ids.length <= 3);
  assert.ok(first.evidence_excerpt.length > 0);
  assert.ok(first.evidence_excerpt.length <= 200);
  assert.ok(!first.evidence_excerpt.includes("\n"));
});

test("空列表抛 EmptyResultError，不把空结果当成功", async () => {
  const adapter = createHunanRsjPolicyAdapter(
    recordingTransport(() => listHtml([])),
    { sleep: async () => undefined },
  );
  await assert.rejects(adapter.collect(), (error: unknown) => {
    assert.ok(error instanceof EmptyResultError);
    assert.equal(error.failureType, "empty_result");
    assert.equal(error.sourceKey, HUNAN_RSJ_SOURCE_KEY);
    return true;
  });
});

test("列表只剩导航条目时同样抛 EmptyResultError", async () => {
  const adapter = createHunanRsjPolicyAdapter(
    recordingTransport(() =>
      listHtml([listItem("/rst/xxgk/zcfg/202609/t20260902_1.html", "栏目外公告", "2026-09-02")]),
    ),
    { sleep: async () => undefined },
  );
  await assert.rejects(adapter.collect(), (error: unknown) => {
    assert.ok(error instanceof EmptyResultError);
    return true;
  });
});

test("详情标题或正文为空时计入 skipped 并汇总抛 ParseFailedError", async () => {
  const emptyBodyUrl = "http://rst.hunan.gov.cn/rst/xxgk/tzgg/202611/t20261121_11800009.html";
  const transport = recordingTransport((request) => {
    if (request.url === HUNAN_RSJ_LIST_URL) {
      return listHtml([
        listItem("/rst/xxgk/tzgg/202611/t20261120_11800001.html", "关于做好就业帮扶工作的通知", "2026-11-20"),
        listItem("/rst/xxgk/tzgg/202611/t20261121_11800009.html", "某空正文公告", "2026-11-21"),
      ]);
    }
    if (request.url === emptyBodyUrl) {
      return detailHtml({ title: "某空正文公告", date: "2026-11-21" });
    }
    return detailFor(request.url);
  });
  const adapter = createHunanRsjPolicyAdapter(transport, { sleep: async () => undefined });
  await assert.rejects(adapter.collect(), (error: unknown) => {
    assert.ok(error instanceof ParseFailedError);
    assert.equal(error.failureType, "parse_failed");
    assert.equal(error.sourceKey, HUNAN_RSJ_SOURCE_KEY);
    assert.match(error.message, /1\/2/);
    assert.ok(error.message.includes(emptyBodyUrl));
    return true;
  });
});

test("AbortSignal 透传给每个请求，预取消时不发起请求", async () => {
  const transport = recordingTransport((request) =>
    request.url === HUNAN_RSJ_LIST_URL ? DEFAULT_LIST : detailFor(request.url),
  );
  const controller = new AbortController();
  const adapter = createHunanRsjPolicyAdapter(transport, {
    itemLimit: 2,
    sleep: async () => undefined,
  });
  await adapter.collect(controller.signal);
  assert.equal(transport.requests.length, 3);
  for (const request of transport.requests) {
    assert.equal(request.signal, controller.signal);
  }

  const aborted = new AbortController();
  aborted.abort();
  const untouched = recordingTransport(() => DEFAULT_LIST);
  await assert.rejects(
    createHunanRsjPolicyAdapter(untouched, { sleep: async () => undefined }).collect(aborted.signal),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.name, "AbortError");
      return true;
    },
  );
  assert.equal(untouched.requests.length, 0);
});

test("itemLimit 上限 10，超出部分不请求详情", async () => {
  const items = Array.from({ length: 12 }, (_value, index) =>
    listItem(
      `/rst/xxgk/tzgg/202611/t202611${String(10 + index).padStart(2, "0")}_1180001${index}.html`,
      `第${index + 1}条就业政策公告`,
      "2026-11-20",
    ),
  );
  const transport = recordingTransport((request) =>
    request.url === HUNAN_RSJ_LIST_URL
      ? listHtml(items)
      : detailHtml({ title: "某就业政策公告", date: "2026-11-20", paragraphs: ["就业帮扶政策正文内容。"] }),
  );
  const adapter = createHunanRsjPolicyAdapter(transport, {
    itemLimit: 99,
    sleep: async () => undefined,
  });
  const policies = await adapter.collect();
  assert.equal(policies.length, 10);
  assert.equal(transport.requests.length, 11);
});