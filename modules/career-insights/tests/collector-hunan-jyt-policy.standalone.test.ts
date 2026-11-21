import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  HUNAN_JYT_COLLECTOR_VERSION,
  HUNAN_JYT_LIST_URL,
  HUNAN_JYT_SOURCE_DEFINITION,
  HUNAN_JYT_SOURCE_KEY,
  createHunanJytPolicyAdapter,
  hunanJytPolicyListPageUrl,
  parseHunanJytListDate,
  parseHunanJytPageDate,
  parseHunanJytPolicyDetail,
  parseHunanJytPolicyList,
  redactHunanJytPersonalData,
  resolveHunanJytIssuer,
  toHunanJytPolicyRef,
} from "../collector/adapters/hunan-jyt-policy.ts";
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
const SOURCE = "hunan-jyt-policy";
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

function listItem(path: string, title: string, date: string | null): string {
  const dateSpan = date === null ? "" : `<span>${date}</span>`;
  return `<li><a href="${path}" title="${title}">${title}</a>${dateSpan}</li>`;
}

function listHtml(items: readonly string[]): string {
  return `<html><body><ul class="list_gkzd_content">${items.join("")}</ul></body></html>`;
}

function detailHtml(
  title: string,
  date: string | null,
  body: string,
  source = "湖南省教育厅 jyt.hunan.gov.cn",
): string {
  const timeSpan =
    date === null
      ? '<span class="time"><i>发布时间：</i></span>'
      : `<span class="time"><i>发布时间：</i>${date}</span>`;
  return [
    "<html><body>",
    '<div class="main_content">',
    `<h2>${title}</h2>`,
    '<div class="sp_time">',
    `<span>${source}</span>`,
    timeSpan,
    "</div>",
    `<div class="main_con_zw" id="j-show-body">${body}</div>`,
    "</div></body></html>",
  ].join("");
}

/**
 * 列表样本前 3 条详情页含公示联系电话/邮箱，按 evidence 规则不能存成样本；
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

test("来源定义登记湖南省教育厅通知公告栏目，接线前保持禁用", () => {
  assert.equal(HUNAN_JYT_SOURCE_KEY, "hunan-jyt-policy");
  assert.equal(HUNAN_JYT_SOURCE_DEFINITION.source_key, "hunan-jyt-policy");
  assert.equal(HUNAN_JYT_SOURCE_DEFINITION.kind, "government_policy");
  assert.equal(HUNAN_JYT_SOURCE_DEFINITION.access, "http");
  assert.equal(HUNAN_JYT_SOURCE_DEFINITION.entry_url, HUNAN_JYT_LIST_URL);
  assert.equal(HUNAN_JYT_SOURCE_DEFINITION.enabled, false);
  assert.equal(
    HUNAN_JYT_LIST_URL,
    "https://jyt.hunan.gov.cn/jyt/sjyt/xxgk/tzgg/index.html",
  );
  assert.match(HUNAN_JYT_SOURCE_DEFINITION.notes, /robots\.txt/);
});

test("列表页解析出通知公告静态详情条目并带列表日期", async () => {
  const items = parseHunanJytPolicyList(await readSample("list.html"), HUNAN_JYT_LIST_URL);
  assert.equal(items.length, 20);
  for (const item of items) {
    assert.match(
      item.url,
      /^https:\/\/jyt\.hunan\.gov\.cn\/jyt\/sjyt\/xxgk\/tzgg\/\d{6}\/t\d+_\d+\.html$/,
    );
    assert.ok(item.title.length >= 4);
    assert.match(item.publishedAt ?? "", /^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/);
  }
  assert.equal(new Set(items.map((item) => item.url)).size, items.length);
  assert.ok(items.some((item) => item.title.includes("对口招生") || item.title.includes("招生")));
});

test("第 2 页样本按 index_N.html 地址解析，日期取同项最后一个短横线日期", async () => {
  const items = parseHunanJytPolicyList(
    await readSample("list-2.html"),
    hunanJytPolicyListPageUrl(2),
  );
  assert.equal(items.length, 20);
  assert.ok(items.every((item) => /\.html$/.test(item.url)));
  assert.ok(items.some((item) => item.publishedAt?.startsWith("2026-07")));
  assert.equal(
    parseHunanJytListDate("关于2026-01-01某事项的公示 2026-11-20"),
    "2026-11-20T00:00:00.000Z",
  );
  assert.equal(parseHunanJytListDate("关于2026年度某事项的公示"), null);
});

test("详情页解析标题、来源、发布时间与正文", async () => {
  const detail = parseHunanJytPolicyDetail(
    await readSample("detail-1.html"),
    "https://jyt.hunan.gov.cn/jyt/sjyt/xxgk/tzgg/202610/t20261029_1183844.html",
  );
  assert.equal(detail.title, "湖南省教育厅关于印发《湖南省中小学幼儿园教师培训项目管理办法》的通知");
  assert.equal(detail.issuingAuthority, "湖南省教育厅");
  assert.equal(detail.sourceLabel, "湖南省教育厅 jyt.hunan.gov.cn");
  assert.equal(detail.publishedAt, "2026-10-29T00:00:00.000Z");
  assert.ok(detail.bodyRaw.includes("教师培训项目管理办法"));
});

test("发布时间支持详情「发布时间：YYYY-MM-DD HH:MM」，非法输入为 null", () => {
  assert.equal(parseHunanJytPageDate("发布时间： 2026-10-16 15:09"), "2026-10-16T00:00:00.000Z");
  assert.equal(parseHunanJytPageDate("2026-10-16"), null);
  assert.equal(parseHunanJytPageDate(null), null);
});

test("发文机关优先取标题「关于」前缀，公示类回退详情来源，再回退栏目机关", () => {
  assert.equal(
    resolveHunanJytIssuer("湖南省教育厅关于做好2027年我省普通高等学校对口招生工作的通知", null),
    "湖南省教育厅",
  );
  assert.equal(
    resolveHunanJytIssuer("关于湖南省全国学校美育名师工作室拟推荐名单的公示", "湖南省教育厅 jyt.hunan.gov.cn"),
    "湖南省教育厅",
  );
  assert.equal(resolveHunanJytIssuer("关于某事项的公示", null), "湖南省教育厅");
});

test("摘录脱敏：邮箱、手机号、联系段落被隐去，且仍不超过 200 字", () => {
  const redacted = redactHunanJytPersonalData(
    "公示期间如有异议，请联系：张三，联系电话：0731-82990352，邮箱 jjcxtz@163.com。",
  );
  assert.equal(containsPersonalData(redacted), false);
  const detail = {
    sourceKey: HUNAN_JYT_SOURCE_KEY,
    title: "关于某教育事项的公示",
    url: "https://jyt.hunan.gov.cn/jyt/sjyt/xxgk/tzgg/202611/t20261120_1184219.html",
    issuingAuthority: "湖南省教育厅",
    sourceLabel: "湖南省教育厅 jyt.hunan.gov.cn",
    bodyRaw: "根据文件要求，现将名单公示如下。联系电话：0731-82990352。联系人：张三 邮箱 a@b.com。",
    publishedAt: "2026-11-20T00:00:00.000Z",
  };
  const ref = toHunanJytPolicyRef(detail);
  assert.equal(containsPersonalData(ref.evidence_excerpt), false);
  assert.ok(ref.evidence_excerpt.length <= 200);
  assert.ok(ref.evidence_excerpt.startsWith("根据文件要求"));
});

test("离线回放：列表 + 3 份详情样本产出 3 条 PolicyEvidenceRefV1", async () => {
  const samples = await loadSamples();
  const lists = samples.filter((sample) => sample.name.startsWith("list"));
  const details = samples.filter((sample) => sample.name.startsWith("detail"));
  const adapter = createHunanJytPolicyAdapter(mappedReplayTransport(lists, details), {
    itemLimit: 3,
    pageLimit: 1,
    sleep: async () => undefined,
  });
  const policies = await adapter.collect();
  assert.equal(policies.length, 3);
  assert.deepEqual(
    policies.map((policy) => policy.title),
    [
      "湖南省教育厅关于印发《湖南省中小学幼儿园教师培训项目管理办法》的通知",
      "湖南省教育厅关于做好2027年我省普通高等学校对口招生工作的通知",
      "湖南省教育厅关于报考2027年少数民族高层次骨干人才研究生招生计划有关事项的说明",
    ],
  );
  for (const policy of policies) {
    assert.match(policy.policy_item_id, /^t\d{8}_\d+$/);
    assert.equal(policy.issuer, "湖南省教育厅");
    assert.match(policy.published_at, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(policy.source_tier, "government_official");
    assert.match(
      policy.official_url,
      /^https:\/\/jyt\.hunan\.gov\.cn\/jyt\/sjyt\/xxgk\/tzgg\//,
    );
    assert.ok(policy.theme_ids.length <= 3);
    assert.ok(policy.evidence_excerpt.length > 0);
    assert.ok(policy.evidence_excerpt.length <= 200);
    assert.equal(containsPersonalData(policy.evidence_excerpt), false);
  }
  assert.ok(
    policies.some(
      (policy) =>
        policy.theme_ids.includes("talent_development") ||
        policy.theme_ids.includes("employment_promotion"),
    ),
  );
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
    assert.equal(sample.meta.collector_version, HUNAN_JYT_COLLECTOR_VERSION);
    assert.equal(sample.meta.body_file, `${SOURCE}/samples/${sample.name}`);
    assert.match(sample.meta.request_key, /^GET https:\/\/jyt\.hunan\.gov\.cn\//);
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
  const adapter = createHunanJytPolicyAdapter(mappedReplayTransport(lists, details), {
    itemLimit: 2,
    sleep: async (ms: number) => {
      sleeps.push(ms);
    },
  });
  const policies = await adapter.collect();
  assert.equal(policies.length, 2);
  assert.deepEqual(sleeps, [1_000, 1_000]);
});

test("分页地址按 TRS 1 基 index_N.html 约定生成，pageLimit 最多抓 3 页", async () => {
  assert.equal(hunanJytPolicyListPageUrl(1), HUNAN_JYT_LIST_URL);
  assert.equal(
    hunanJytPolicyListPageUrl(2),
    "https://jyt.hunan.gov.cn/jyt/sjyt/xxgk/tzgg/index_2.html",
  );
  assert.equal(
    hunanJytPolicyListPageUrl(3),
    "https://jyt.hunan.gov.cn/jyt/sjyt/xxgk/tzgg/index_3.html",
  );

  const requested: string[] = [];
  const transport: FetchTransport = {
    async fetchPage(request) {
      requested.push(request.url);
      if (request.url.includes("/t2026")) {
        return response(
          detailHtml(
            "关于某教育事项的通知",
            "2026-11-20 10:00",
            "根据文件要求，现将有关事项通知如下，请各单位认真组织落实。",
          ),
          request.url,
        );
      }
      const page = /index_(\d+)\.html$/.exec(request.url)?.[1] ?? "1";
      return response(
        listHtml([listItem(`./202611/t2026112${page}_118421${page}.html`, `第${page}页教育通知`, `2026-11-2${page}`)]),
        request.url,
      );
    },
  };
  const adapter = createHunanJytPolicyAdapter(transport, {
    itemLimit: 10,
    pageLimit: 99,
    sleep: async () => undefined,
  });
  const policies = await adapter.collect();
  const listRequests = requested.filter((url) => !url.includes("/t2026"));
  assert.deepEqual(listRequests, [
    HUNAN_JYT_LIST_URL,
    hunanJytPolicyListPageUrl(2),
    hunanJytPolicyListPageUrl(3),
  ]);
  assert.equal(policies.length, 3);
});

test("空列表抛 EmptyResultError，不把空结果当成功", async () => {
  const adapter = createHunanJytPolicyAdapter(
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
    assert.equal(error.sourceKey, HUNAN_JYT_SOURCE_KEY);
    return true;
  });
});

test("详情页缺正文时抛 SchemaChangedError", () => {
  assert.throws(
    () =>
      parseHunanJytPolicyDetail(
        '<html><body><div class="main_content"><h2>某教育公告</h2><div class="sp_time"><span class="time">发布时间：2026-11-20 10:00</span></div></div></body></html>',
        "https://jyt.hunan.gov.cn/jyt/sjyt/xxgk/tzgg/202611/t20261120_1184219.html",
      ),
    (error: unknown) => {
      assert.ok(error instanceof SchemaChangedError);
      assert.equal(error.sourceKey, HUNAN_JYT_SOURCE_KEY);
      return true;
    },
  );
});

test("详情页与列表都缺发布时间时整批 ParseFailedError，不返回部分成功", async () => {
  const transport: FetchTransport = {
    async fetchPage(request) {
      if (request.url.includes("/t2026")) {
        return response(
          detailHtml(
            "关于某教育事项的通知",
            null,
            "这是一段用于验证缺少发布时间时必须整批失败的政策正文内容。",
          ),
          request.url,
        );
      }
      return response(
        listHtml([
          listItem("/jyt/sjyt/xxgk/tzgg/202611/t20261120_1184219.html", "关于某教育事项的通知", null),
        ]),
        request.url,
      );
    },
  };
  const adapter = createHunanJytPolicyAdapter(transport, { sleep: async () => undefined });
  await assert.rejects(adapter.collect(), (error: unknown) => {
    assert.ok(error instanceof ParseFailedError);
    assert.equal(error.failureType, "parse_failed");
    assert.equal(error.sourceKey, HUNAN_JYT_SOURCE_KEY);
    assert.match(error.message, /发布时间/);
    return true;
  });
});

test("取消信号在采集开始前生效", async () => {
  const controller = new AbortController();
  controller.abort();
  const adapter = createHunanJytPolicyAdapter(await replayTransport(), {
    sleep: async () => undefined,
  });
  await assert.rejects(adapter.collect(controller.signal), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.name, "AbortError");
    return true;
  });
});

test("toHunanJytPolicyRef 的 policy_item_id 取详情 URL 末段", () => {
  const ref = toHunanJytPolicyRef({
    sourceKey: HUNAN_JYT_SOURCE_KEY,
    title: "湖南省教育厅关于报考2027年少数民族高层次骨干人才研究生招生计划有关事项的说明",
    url: "https://jyt.hunan.gov.cn/jyt/sjyt/xxgk/tzgg/202609/t20260930_1183184.html",
    issuingAuthority: "湖南省教育厅",
    sourceLabel: "湖南省教育厅 jyt.hunan.gov.cn",
    bodyRaw: "报考2027年少数民族高层次骨干人才研究生招生计划的考生须通过资格申请平台提交申请信息，由省就业指导中心初审。",
    publishedAt: "2026-09-30T00:00:00.000Z",
  });
  assert.equal(ref.policy_item_id, "t20260930_1183184");
  assert.equal(ref.issuer, "湖南省教育厅");
  assert.equal(ref.published_at, "2026-09-30");
  assert.equal(ref.source_tier, "government_official");
  assert.ok(ref.theme_ids.includes("employment_promotion") || ref.theme_ids.includes("talent_development"));
});
