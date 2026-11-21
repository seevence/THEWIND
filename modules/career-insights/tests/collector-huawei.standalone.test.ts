import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  HUAWEI_COLLECTOR_VERSION,
  HUAWEI_LIST_URL,
  HUAWEI_SOURCE_DEFINITION,
  createHuaweiOfficialCareersAdapter,
  parseHuaweiList,
  parseHuaweiPublishedAt,
  toHuaweiRawJob,
} from "../collector/adapters/huawei-official-careers.ts";
import { ReplayTransport } from "../collector/fetch/replay-transport.ts";
import { SampleStore } from "../collector/evidence/sample-store.ts";
import { containsPersonalData } from "../collector/evidence/sanitizer.ts";
import { validateCollectedJobs } from "../collector/orchestration/runner.ts";
import type {
  FetchTransport,
  PageRequest,
  TransportResponse,
} from "../collector/fetch/transport.ts";

const SAMPLES = join(dirname(fileURLToPath(import.meta.url)), "../collector/evidence/samples");
const SOURCE = "huawei-official-careers";
const FIXED_NOW = "2026-11-21T12:00:00.000Z";

async function listBody(page: number): Promise<Buffer> {
  return readFile(join(SAMPLES, SOURCE, "samples", `list-${page}.json`));
}

function jsonResponse(request: PageRequest, body: Buffer): TransportResponse {
  return {
    status: 200,
    requestUrl: request.url,
    finalUrl: request.url,
    contentType: "application/json;charset=UTF-8",
    headers: { "content-type": "application/json;charset=UTF-8" },
    body,
    fetchedAt: "2026-11-21T10:00:00.000Z",
  };
}

test("华为真实样本解析出 20 条，字段保真且列表自带职责要求", async () => {
  const items = parseHuaweiList(await listBody(1));
  assert.equal(items.length, 20);
  const first = items[0];
  assert.ok(first !== undefined);
  assert.match(first.jobId, /^\d+$/);
  assert.match(first.advertisementId, /^\d+$/);
  assert.ok(first.title.length > 0);
  assert.ok(Array.isArray(first.locations));
  assert.ok(items.every((item) => item.mainBusiness !== null || item.jobRequire !== null));
  assert.equal(first.raw["jobId"], Number(first.jobId));
});

test("华为 5 份真实列表样本均无个人信息且各解析 20 条", async () => {
  let checked = 0;
  for (const page of [1, 2, 3, 4, 5]) {
    const body = await listBody(page);
    assert.equal(
      containsPersonalData(body.toString("utf8")),
      false,
      `list-${page} 含个人联系方式，按证据规则不得入库`,
    );
    assert.equal(parseHuaweiList(body).length, 20);
    checked += 1;
  }
  assert.equal(checked, 5);
});

test("华为列表条目缺少 jobId / jobName 时抛 ParseFailedError", () => {
  const body = JSON.stringify({
    status: "SUCCESS",
    data: { result: [{ advertisementId: 1, jobName: "缺少 jobId" }] },
  });
  assert.throws(() => parseHuaweiList(body), /jobId \/ advertisementId \/ jobName/);
});

test("华为列表响应结构或状态变化时抛 SchemaChangedError 而不是空结果", () => {
  assert.throws(() => parseHuaweiList(JSON.stringify({ status: "FAILED", data: {} })), /status=FAILED/);
  assert.throws(() => parseHuaweiList(JSON.stringify({ status: "SUCCESS", data: {} })), /data\.result/);
});

test("华为地点按分隔符拆分去重，发布时间只接受显式日期", () => {
  const body = JSON.stringify({
    status: "SUCCESS",
    data: {
      result: [
        {
          jobId: 1,
          advertisementId: 2,
          jobName: "测试职位",
          workPlace: "东莞/深圳、东莞",
          mainBusiness: "职责",
          jobRequire: "要求",
          lastUpdateDate: "2026-11-10",
        },
      ],
    },
  });
  const [item] = parseHuaweiList(body);
  assert.deepEqual(item?.locations, ["东莞", "深圳"]);

  assert.equal(parseHuaweiPublishedAt("2026-11-10"), "2026-11-10T00:00:00.000Z");
  assert.equal(parseHuaweiPublishedAt("2026-11-10 18:30:00"), "2026-11-10T00:00:00.000Z");
  assert.equal(parseHuaweiPublishedAt("刚刚"), null);
  assert.equal(parseHuaweiPublishedAt(null), null);
});

test("华为职位用 advertisementId 拼官方详情页，职责与要求拼成原文", async () => {
  const [first] = parseHuaweiList(await listBody(1));
  assert.ok(first !== undefined);
  const job = toHuaweiRawJob(first, FIXED_NOW);
  assert.equal(
    job.official_url,
    `https://career.huawei.com/cn/job-details?advertisementId=${first.advertisementId}`,
  );
  assert.match(job.official_url, /^https:\/\//);
  assert.equal(job.raw_text, [first.mainBusiness, first.jobRequire].filter((part) => part !== null).join("\n\n"));
  assert.equal(job.published_at, parseHuaweiPublishedAt(first.lastUpdateDate));
  assert.equal(job.hints?.experience_raw, first.workYear);
  assert.deepEqual(job.hints?.locations, [...first.locations]);
});

test("华为 3 页真实样本回放产出 60 条合法原始职位，零网络请求", async () => {
  const store = new SampleStore(SAMPLES);
  const replaySamples = [];
  for (const page of [1, 2, 3]) {
    const record = await store.load(`${SOURCE}/samples/list-${page}.json`);
    replaySamples.push({
      request_key: record.meta.request_key,
      captured_at: record.meta.captured_at,
      status: record.meta.http_status,
      request_url: record.meta.request_url,
      final_url: record.meta.final_url,
      content_type: record.meta.content_type,
      headers: {},
      body: record.body,
    });
  }

  const adapter = createHuaweiOfficialCareersAdapter(new ReplayTransport(replaySamples), {
    pageLimit: 3,
    sleep: async () => {},
    now: () => FIXED_NOW,
  });
  const jobs = await adapter.collect();
  assert.equal(jobs.length, 60);
  const report = validateCollectedJobs(jobs);
  assert.equal(report.invalid.length, 0, JSON.stringify(report.invalid.slice(0, 2)));
  assert.equal(report.valid.length, 60);
  assert.ok(jobs.every((job) => job.source_key === SOURCE));
  assert.ok(jobs.every((job) => job.company_name === "华为"));
  assert.ok(jobs.every((job) => job.collector_version === HUAWEI_COLLECTOR_VERSION));
  assert.ok(jobs.every((job) => job.fetched_at === FIXED_NOW));
  assert.ok(jobs.every((job) => job.official_url.includes("advertisementId=")));
  assert.ok(jobs.every((job) => job.raw_text.length > 0));
});

test("华为 collect 最多请求 3 页，请求体按页码区分且带公开 appId", async () => {
  const calls: PageRequest[] = [];
  const body = await listBody(1);
  const transport: FetchTransport = {
    async fetchPage(request) {
      calls.push(request);
      return jsonResponse(request, body);
    },
  };
  const adapter = createHuaweiOfficialCareersAdapter(transport, {
    sleep: async () => {},
    now: () => FIXED_NOW,
  });
  const jobs = await adapter.collect(undefined, { pageLimit: 9 });

  assert.equal(calls.length, 3);
  assert.deepEqual(
    calls.map((call) => JSON.parse(call.body ?? "{}").curPage),
    [1, 2, 3],
  );
  assert.ok(calls.every((call) => call.method === "POST"));
  assert.ok(calls.every((call) => call.pageTimeoutMs === 20_000));
  assert.ok(calls.every((call) => call.sourceKey === SOURCE));
  assert.ok(calls.every((call) => call.url.startsWith(HUAWEI_LIST_URL)));
  assert.ok(calls.every((call) => call.url.includes("X-HW-ID=app_000000035886")));
  assert.equal(jobs.length, 60);
});

test("华为适配器定义与 AbortSignal 原样透传到页面请求", async () => {
  assert.equal(HUAWEI_SOURCE_DEFINITION.source_key, SOURCE);
  assert.equal(HUAWEI_SOURCE_DEFINITION.enabled, true);
  assert.equal(HUAWEI_SOURCE_DEFINITION.kind, "company_careers");

  const calls: PageRequest[] = [];
  const body = await listBody(1);
  const controller = new AbortController();
  const transport: FetchTransport = {
    async fetchPage(request) {
      calls.push(request);
      return jsonResponse(request, body);
    },
  };
  const adapter = createHuaweiOfficialCareersAdapter(transport);
  await adapter.collect(controller.signal);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.signal, controller.signal);
  assert.equal(adapter.definition.source_key, SOURCE);
});
