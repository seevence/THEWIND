import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  HONOR_COLLECTOR_VERSION,
  HONOR_DETAIL_PAGE_URL,
  HONOR_DETAIL_URL,
  HONOR_LIST_URL,
  HONOR_SOURCE_DEFINITION,
  createHonorOfficialCareersAdapter,
  honorDetailPageUrl,
  normalizeHonorLocations,
  parseHonorDetail,
  parseHonorList,
  parseHonorPublishedAt,
  toHonorRawJob,
} from "../collector/adapters/honor-official-careers.ts";
import { SampleStore } from "../collector/evidence/sample-store.ts";
import { containsPersonalData } from "../collector/evidence/sanitizer.ts";
import { ReplayTransport } from "../collector/fetch/replay-transport.ts";
import type { ReplaySample } from "../collector/fetch/replay-transport.ts";
import type { FetchTransport, PageRequest } from "../collector/fetch/transport.ts";
import { validateCollectedJobs } from "../collector/orchestration/runner.ts";
import { validateRawCollectedJob } from "../collector/validate.ts";

const SAMPLES = join(dirname(fileURLToPath(import.meta.url)), "../collector/evidence/samples");
const SOURCE = "honor-official-careers";
const SAMPLES_DIR = join(SAMPLES, SOURCE, "samples");
const FIXED_NOW = "2026-11-21T12:00:00.000Z";
const PAGE_ONE_TARGETS = ["66599aae1eb8051cd2168236", "6a389065e49e0e559f924c92"];
const ADAPTER_OPTIONS = {
  definition: HONOR_SOURCE_DEFINITION,
  sleep: async () => {},
  now: () => FIXED_NOW,
};

async function readSample(name: string): Promise<string> {
  return readFile(join(SAMPLES_DIR, name), "utf8");
}

async function readSampleBuffer(name: string): Promise<Buffer> {
  return readFile(join(SAMPLES_DIR, name));
}

test("荣耀列表真实样本解析出 12 条且字段保真", async () => {
  const items = parseHonorList(await readSample("list-1.json"));
  assert.equal(items.length, 12);
  const first = items[0];
  assert.ok(first !== undefined);
  assert.match(first.postId, /^[0-9a-f]{24}$/);
  assert.ok(first.title.length > 0);
  assert.ok(Array.isArray(first.locations));
  assert.ok(items.every((item) => item.publishedAtRaw !== null));
  assert.ok(items.some((item) => item.locations.length >= 2), "列表应含多城市职位");
  assert.ok(items.some((item) => item.degreeRaw !== null), "列表应含学历要求");
  assert.equal(honorDetailPageUrl(first.postId), `${HONOR_DETAIL_PAGE_URL}?postId=${first.postId}`);
  assert.ok(honorDetailPageUrl(first.postId).startsWith("https://career.honor.com/"));
});

test("荣耀 3 份真实列表样本均无个人信息且各解析 12 条、合计 36 个职位", async () => {
  const seen = new Set<string>();
  for (const page of [1, 2, 3]) {
    const body = await readSampleBuffer(`list-${page}.json`);
    assert.equal(
      containsPersonalData(body.toString("utf8")),
      false,
      `list-${page} 含个人联系方式，按证据规则不得入库`,
    );
    const items = parseHonorList(body);
    assert.equal(items.length, 12);
    for (const item of items) {
      seen.add(item.postId);
    }
  }
  assert.equal(seen.size, 36);
});

test("荣耀列表条目缺少 postId / postName 时抛 ParseFailedError", () => {
  const body = JSON.stringify({
    state: 200,
    data: { pageForm: { pageData: [{ postName: "缺少主键" }] } },
  });
  assert.throws(() => parseHonorList(body), /缺少 postId \/ postName/);
});

test("荣耀列表响应结构或状态变化时抛 SchemaChangedError 而不是空结果", () => {
  assert.throws(
    () => parseHonorList(JSON.stringify({ state: 500, data: {} })),
    /state=500/,
  );
  assert.throws(
    () => parseHonorList(JSON.stringify({ state: 200, data: {} })),
    /data\.pageForm\.pageData/,
  );
  assert.throws(
    () => parseHonorList(JSON.stringify({ state: 200, data: { pageForm: { pageData: "x" } } })),
    /data\.pageForm\.pageData/,
  );
});

test("荣耀发布时间按 +08:00 读成 UTC ISO，非法格式返回 null", () => {
  assert.equal(parseHonorPublishedAt("2024-05-31 17:38:54"), "2024-05-31T09:38:54.000Z");
  assert.equal(parseHonorPublishedAt("2025-08-19 00:00:00"), "2025-08-18T16:00:00.000Z");
  assert.equal(parseHonorPublishedAt("2026-06-22"), "2026-06-21T16:00:00.000Z");
  assert.equal(parseHonorPublishedAt("刚刚"), null);
  assert.equal(parseHonorPublishedAt("2026-13-40 25:61:61"), null);
  assert.equal(parseHonorPublishedAt(null), null);
});

test("荣耀地点按顿号/逗号/斜杠拆分去重", () => {
  assert.deepEqual(normalizeHonorLocations("北京市、上海市、西安市"), ["北京市", "上海市", "西安市"]);
  assert.deepEqual(normalizeHonorLocations("深圳市/东莞、深圳市"), ["深圳市", "东莞"]);
  assert.deepEqual(normalizeHonorLocations("全球范围"), ["全球范围"]);
  assert.deepEqual(normalizeHonorLocations(null), []);
});

test("荣耀详情样本与列表摘要合并为合法职位", async () => {
  const summary = parseHonorList(await readSample("list-1.json")).find(
    (item) => item.postId === "66599aae1eb8051cd2168236",
  );
  assert.ok(summary, "list-1 应包含 postId=66599aae1eb8051cd2168236");
  const detail = parseHonorDetail(await readSample("detail-66599aae1eb8051cd2168236.json"), summary);
  assert.ok(detail.duty !== null && detail.duty.length > 20);
  assert.ok(detail.requirement !== null && detail.requirement.length > 20);
  const job = toHonorRawJob(detail, FIXED_NOW);
  assert.equal(validateRawCollectedJob(job).ok, true);
  assert.equal(job.source_job_id, "66599aae1eb8051cd2168236");
  assert.equal(job.company_name, "荣耀");
  assert.equal(job.official_url, honorDetailPageUrl("66599aae1eb8051cd2168236"));
  assert.equal(job.raw_text, `${detail.duty}\n\n${detail.requirement}`);
  assert.equal(job.published_at, "2024-05-31T09:38:54.000Z");
  assert.deepEqual(job.hints?.locations, ["全球范围"]);
  assert.equal(job.hints?.degree_raw, "本科及以上");
  assert.equal(job.hints?.experience_raw, null);
  assert.equal(job.collector_version, HONOR_COLLECTOR_VERSION);
  const payload = job.raw_payload as { list?: unknown; detail?: unknown };
  assert.ok(payload.list !== undefined && payload.detail !== undefined);
});

test("荣耀详情缺职责与要求时抛 ParseFailedError", async () => {
  const summary = parseHonorList(await readSample("list-1.json"))[0];
  assert.ok(summary !== undefined);
  const detail = parseHonorDetail(
    JSON.stringify({
      state: 200,
      data: { postId: summary.postId, postName: summary.title, workContent: "", serviceCondition: "" },
    }),
    summary,
  );
  assert.throws(() => toHonorRawJob(detail, FIXED_NOW), /缺少职责与要求正文/);
});

test("荣耀详情结构或状态变化时抛 SchemaChangedError", () => {
  const summary = {
    postId: "66599aae1eb8051cd2168236",
    title: "省零售部部长（中国区）",
    locations: [] as string[],
    degreeRaw: null,
    experienceRaw: null,
    publishedAtRaw: null,
    postTypeName: null,
    company: null,
    workType: null,
    externalKey: null,
    raw: {},
  };
  assert.throws(
    () => parseHonorDetail(JSON.stringify({ state: 404, data: {} }), summary),
    /state=404/,
  );
  assert.throws(
    () => parseHonorDetail(JSON.stringify({ state: 200 }), summary),
    /缺少 data/,
  );
});

test("荣耀列表回放两页（筛选后）产出 2 条合法原始职位，零网络请求", async () => {
  const store = new SampleStore(SAMPLES);
  const listSample = await store.load(`${SOURCE}/samples/list-1.json`);
  const list = JSON.parse(listSample.body.toString("utf8")) as {
    data: { pageForm: { pageData: Array<Record<string, unknown>> } };
  };
  const filtered = list.data.pageForm.pageData.filter((item) =>
    PAGE_ONE_TARGETS.includes(item["postId"] as string),
  );
  assert.equal(filtered.length, 2);
  list.data.pageForm.pageData = filtered;
  const filteredBody = Buffer.from(JSON.stringify(list));

  const samples: ReplaySample[] = [
    {
      request_key: listSample.meta.request_key,
      captured_at: FIXED_NOW,
      status: 200,
      request_url: listSample.meta.request_url,
      final_url: listSample.meta.final_url,
      content_type: listSample.meta.content_type,
      headers: {},
      body: filteredBody,
    },
  ];
  for (const postId of PAGE_ONE_TARGETS) {
    const detail = await store.load(`${SOURCE}/samples/detail-${postId}.json`);
    samples.push({
      request_key: detail.meta.request_key,
      captured_at: detail.meta.captured_at,
      status: detail.meta.http_status,
      request_url: detail.meta.request_url,
      final_url: detail.meta.final_url,
      content_type: detail.meta.content_type,
      headers: {},
      body: detail.body,
    });
  }

  const adapter = createHonorOfficialCareersAdapter(new ReplayTransport(samples), {
    ...ADAPTER_OPTIONS,
    pageLimit: 1,
  });
  const jobs = await adapter.collect();
  assert.equal(jobs.length, 2);
  const report = validateCollectedJobs(jobs);
  assert.equal(report.invalid.length, 0, JSON.stringify(report.invalid.slice(0, 2)));
  assert.equal(report.valid.length, 2);
  assert.ok(jobs.every((job) => job.source_key === SOURCE));
  assert.ok(jobs.every((job) => job.company_name === "荣耀"));
  assert.ok(jobs.every((job) => job.collector_version === HONOR_COLLECTOR_VERSION));
  assert.ok(jobs.every((job) => job.published_at !== null));
  assert.equal(new Set(jobs.map((job) => job.source_job_id)).size, 2);
});

test("荣耀 collect 最多请求 3 页，请求体按页码区分且每条职位取一次详情", async () => {
  const listBodies = new Map<number, Buffer>([
    [1, await readSampleBuffer("list-1.json")],
    [2, await readSampleBuffer("list-2.json")],
    [3, await readSampleBuffer("list-3.json")],
  ]);
  const detailBody = await readSampleBuffer("detail-66599aae1eb8051cd2168236.json");
  const calls: PageRequest[] = [];
  const parsedDetail = JSON.parse(detailBody.toString("utf8")) as { data: Record<string, unknown> };
  const transport: FetchTransport = {
    async fetchPage(request) {
      calls.push(request);
      if (request.url === HONOR_LIST_URL) {
        const page = Number(new URLSearchParams(request.body ?? "").get("currentPage"));
        const body = listBodies.get(page);
        assert.ok(body !== undefined, `缺少第 ${page} 页列表样本`);
        return {
          status: 200,
          requestUrl: request.url,
          finalUrl: request.url,
          contentType: "application/json;charset=UTF-8",
          headers: { "content-type": "application/json;charset=UTF-8" },
          body,
          fetchedAt: FIXED_NOW,
        };
      }
      const postId = new URLSearchParams(request.body ?? "").get("postId") ?? "";
      const body = Buffer.from(
        JSON.stringify({ state: 200, data: { ...parsedDetail.data, postId } }),
      );
      return {
        status: 200,
        requestUrl: request.url,
        finalUrl: request.url,
        contentType: "application/json;charset=UTF-8",
        headers: { "content-type": "application/json;charset=UTF-8" },
        body,
        fetchedAt: FIXED_NOW,
      };
    },
  };
  const sleeps: number[] = [];
  const adapter = createHonorOfficialCareersAdapter(transport, {
    definition: HONOR_SOURCE_DEFINITION,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    now: () => FIXED_NOW,
  });
  const jobs = await adapter.collect(undefined, { pageLimit: 9 });
  assert.equal(jobs.length, 36);
  const listCalls = calls.filter((call) => call.url === HONOR_LIST_URL);
  const detailCalls = calls.filter((call) => call.url === HONOR_DETAIL_URL);
  assert.equal(listCalls.length, 3);
  assert.equal(detailCalls.length, 36);
  assert.deepEqual(
    listCalls.map((call) => new URLSearchParams(call.body ?? "").get("currentPage")),
    ["1", "2", "3"],
  );
  assert.ok(listCalls.every((call) => call.method === "POST"));
  assert.ok(listCalls.every((call) => call.pageTimeoutMs === 20_000));
  assert.ok(listCalls.every((call) => call.sourceKey === SOURCE));
  assert.ok(
    listCalls.every((call) => call.body === "isFrompb=true&recruitType=2&pageSize=12&currentPage=" + new URLSearchParams(call.body ?? "").get("currentPage")),
  );
  assert.ok(detailCalls.every((call) => call.method === "POST"));
  assert.ok(detailCalls.every((call) => call.url === HONOR_DETAIL_URL));
  assert.equal(new Set(detailCalls.map((call) => call.body)).size, 36);
  assert.equal(sleeps.length, calls.length - 1, "除首个请求外每次同域请求前都应等待");
  assert.ok(sleeps.every((ms) => ms === 1_000));
  assert.equal(validateCollectedJobs(jobs).invalid.length, 0);
});

test("荣耀适配器定义、AbortSignal 与未登记来源的配置错误", async () => {
  assert.equal(HONOR_SOURCE_DEFINITION.source_key, SOURCE);
  assert.equal(HONOR_SOURCE_DEFINITION.enabled, true);
  assert.equal(HONOR_SOURCE_DEFINITION.kind, "company_careers");
  assert.equal(HONOR_SOURCE_DEFINITION.access, "http");
  assert.ok(HONOR_SOURCE_DEFINITION.notes.includes("listPosition"));

  const calls: PageRequest[] = [];
  const listBody = await readSampleBuffer("list-1.json");
  const detailBody = await readSampleBuffer("detail-66599aae1eb8051cd2168236.json");
  const controller = new AbortController();
  const transport: FetchTransport = {
    async fetchPage(request) {
      calls.push(request);
      return {
        status: 200,
        requestUrl: request.url,
        finalUrl: request.url,
        contentType: "application/json;charset=UTF-8",
        headers: { "content-type": "application/json;charset=UTF-8" },
        body: request.url === HONOR_LIST_URL ? listBody : detailBody,
        fetchedAt: FIXED_NOW,
      };
    },
  };
  const adapter = createHonorOfficialCareersAdapter(transport, {
    ...ADAPTER_OPTIONS,
    pageLimit: 1,
  });
  await adapter.collect(controller.signal, { pageLimit: 1 });
  assert.equal(calls[0]?.signal, controller.signal);
  assert.equal(adapter.definition.source_key, SOURCE);

  const aborted = new AbortController();
  aborted.abort();
  const abortAdapter = createHonorOfficialCareersAdapter(transport, ADAPTER_OPTIONS);
  await assert.rejects(() => abortAdapter.collect(aborted.signal), /采集被取消/);
});

test("荣耀样本元信息完整、已脱敏且正文不含个人联系方式", async () => {
  const entries = (await readdir(SAMPLES_DIR)).filter((name) => name.endsWith(".meta.json"));
  assert.equal(entries.length, 5);
  for (const entry of entries) {
    const meta = JSON.parse(await readFile(join(SAMPLES_DIR, entry), "utf8")) as {
      sanitized: boolean;
      http_status: number;
      collector_version: string;
      request_key: string;
      request_url: string;
      body_file: string;
    };
    assert.equal(meta.sanitized, true, `${entry} 应已脱敏`);
    assert.equal(meta.http_status, 200, `${entry} 应为 HTTP 200`);
    assert.equal(meta.collector_version, HONOR_COLLECTOR_VERSION);
    assert.ok(meta.request_key.startsWith(`POST ${meta.request_url}#`), `${entry} request_key 应区分 POST 请求体`);
    assert.equal(meta.body_file, `${SOURCE}/samples/${entry.replace(/\.meta\.json$/, "")}`);
    const bodyFile = entry.replace(/\.meta\.json$/, "");
    assert.equal(containsPersonalData(await readFile(join(SAMPLES_DIR, bodyFile), "utf8")), false);
  }
  const lists = entries.filter((name) => name.startsWith("list-"));
  const details = entries.filter((name) => name.startsWith("detail-"));
  assert.ok(lists.length >= 3, "至少 3 份列表样本");
  assert.ok(details.length >= 2, "至少 2 份详情样本");
});
