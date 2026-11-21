import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  NETEASE_COLLECTOR_VERSION,
  NETEASE_LIST_URL,
  NETEASE_SOURCE_DEFINITION,
  createNetEaseOfficialCareersAdapter,
  neteaseDetailPageUrl,
  parseNetEaseDetail,
  parseNetEaseList,
  parseNetEasePublishedAt,
  toNetEaseRawJob,
} from "../collector/adapters/netease-official-careers.ts";
import { SampleStore } from "../collector/evidence/sample-store.ts";
import { containsPersonalData } from "../collector/evidence/sanitizer.ts";
import { ReplayTransport } from "../collector/fetch/replay-transport.ts";
import type { FetchTransport, PageRequest } from "../collector/fetch/transport.ts";
import { validateCollectedJobs } from "../collector/orchestration/runner.ts";
import { validateRawCollectedJob } from "../collector/validate.ts";

const SAMPLES = join(dirname(fileURLToPath(import.meta.url)), "../collector/evidence/samples");
const SOURCE = "netease-official-careers";
const SAMPLES_DIR = join(SAMPLES, SOURCE, "samples");
const ADAPTER_OPTIONS = { definition: NETEASE_SOURCE_DEFINITION, sleep: async () => {}, now: () => "2026-11-21T12:00:00.000Z" };

async function readSample(name: string): Promise<string> {
  return readFile(join(SAMPLES_DIR, name), "utf8");
}

async function replaySamples(): Promise<ReplayTransport> {
  const store = new SampleStore(SAMPLES);
  const entries = (await readdir(SAMPLES_DIR)).filter((name) => name.endsWith(".json") && !name.endsWith(".meta.json"));
  const samples = [];
  for (const entry of entries) {
    const record = await store.load(`${SOURCE}/samples/${entry}`);
    samples.push({
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
  return new ReplayTransport(samples);
}

test("网易列表真实样本解析出 10 条且字段保真", async () => {
  const posts = parseNetEaseList(await readSample("list-1.json"));
  assert.equal(posts.length, 10);
  const first = posts[0];
  assert.ok(first !== undefined);
  assert.ok(first.id.length > 0);
  assert.ok(first.title.length > 0);
  assert.ok(first.description !== null);
  assert.ok(first.locations.length >= 1);
  assert.equal(neteaseDetailPageUrl(first.id), `https://hr.163.com/job-detail.html?id=${first.id}&lang=zh`);
});

test("网易列表条目缺少 id 或 name 时抛 ParseFailedError", () => {
  const body = JSON.stringify({ code: 200, data: { list: [{ name: "缺少主键" }] } });
  assert.throws(() => parseNetEaseList(body), /缺少 id \/ name/);
});

test("网易列表响应结构变化时抛 SchemaChangedError 而不是空结果", () => {
  assert.throws(() => parseNetEaseList(JSON.stringify({ code: 200, data: {} })), /data\.list/);
  assert.throws(() => parseNetEaseList(JSON.stringify({ data: null })), /data\.list/);
});

test("网易更新时间为毫秒时间戳时转 UTC ISO，非法值返回 null", () => {
  const iso = parseNetEasePublishedAt(1795190473000);
  assert.ok(iso !== null);
  assert.match(iso, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.equal(parseNetEasePublishedAt(null), null);
  assert.equal(parseNetEasePublishedAt(Number.NaN), null);
});

test("网易 3 页列表回放产出 30 条合法原始职位，且零网络请求", async () => {
  const adapter = createNetEaseOfficialCareersAdapter(await replaySamples(), {
    ...ADAPTER_OPTIONS,
    pageLimit: 3,
  });
  const jobs = await adapter.collect();
  assert.equal(jobs.length, 30);
  const report = validateCollectedJobs(jobs);
  assert.equal(report.invalid.length, 0, JSON.stringify(report.invalid.slice(0, 2)));
  assert.equal(report.valid.length, 30);
  assert.ok(jobs.every((job) => job.company_name === "网易"));
  assert.ok(jobs.every((job) => job.source_key === SOURCE));
  assert.ok(jobs.every((job) => job.collector_version === NETEASE_COLLECTOR_VERSION));
  assert.ok(jobs.every((job) => job.official_url.startsWith("https://hr.163.com/job-detail.html?id=")));
  assert.ok(jobs.every((job) => job.published_at === null || validateRawCollectedJob(job).ok));
  assert.equal(new Set(jobs.map((job) => job.source_job_id)).size, 30);
});

test("网易列表缺正文时回退公开详情接口，产出 1 条合法职位", async () => {
  const list = JSON.parse(await readSample("list-1.json")) as {
    data: { list: Array<Record<string, unknown>> };
  };
  const target = list.data.list.find((item) => item["id"] === 15318);
  assert.ok(target, "list-1 样本应包含 id=15318");
  delete target["description"];
  delete target["requirement"];
  list.data.list = [target];
  const strippedBody = Buffer.from(JSON.stringify(list));

  const store = new SampleStore(SAMPLES);
  const listSample = await store.load(`${SOURCE}/samples/list-1.json`);
  const detail = await store.load(`${SOURCE}/samples/detail-15318.json`);
  const replay = new ReplayTransport([
    {
      request_key: listSample.meta.request_key,
      captured_at: "2026-11-21T12:00:00.000Z",
      status: 200,
      request_url: listSample.meta.request_url,
      final_url: listSample.meta.final_url,
      content_type: listSample.meta.content_type,
      headers: {},
      body: strippedBody,
    },
    {
      request_key: detail.meta.request_key,
      captured_at: detail.meta.captured_at,
      status: detail.meta.http_status,
      request_url: detail.meta.request_url,
      final_url: detail.meta.final_url,
      content_type: detail.meta.content_type,
      headers: {},
      body: detail.body,
    },
  ]);
  const adapter = createNetEaseOfficialCareersAdapter(replay, { ...ADAPTER_OPTIONS, pageLimit: 1 });
  const jobs = await adapter.collect();
  assert.equal(jobs.length, 1);
  const [job] = jobs;
  assert.ok(job !== undefined);
  assert.equal(validateRawCollectedJob(job).ok, true);
  assert.ok(job.raw_text.length > 100);
  assert.equal(job.source_job_id, "15318");
});

test("网易列表已含正文时不请求详情接口，页数不超过 3", async () => {
  const listBody = await readFile(join(SAMPLES_DIR, "list-1.json"));
  const calls: PageRequest[] = [];
  const transport: FetchTransport = {
    async fetchPage(request) {
      calls.push(request);
      return {
        status: 200,
        requestUrl: request.url,
        finalUrl: request.url,
        contentType: "application/json;charset=UTF-8",
        headers: { "content-type": "application/json;charset=UTF-8" },
        body: listBody,
        fetchedAt: "2026-11-21T12:00:00.000Z",
      };
    },
  };
  const adapter = createNetEaseOfficialCareersAdapter(transport, { ...ADAPTER_OPTIONS, pageLimit: 9 });
  const jobs = await adapter.collect();
  assert.equal(jobs.length, 30);
  assert.equal(calls.length, 3);
  assert.ok(calls.every((call) => call.method === "POST"));
  assert.ok(calls.every((call) => call.url === NETEASE_LIST_URL));
  assert.deepEqual(
    calls.map((call) => JSON.parse(call.body ?? "{}").currentPage),
    [1, 2, 3],
  );
});

test("网易样本元信息完整、已脱敏且正文不含个人联系方式", async () => {
  const entries = (await readdir(SAMPLES_DIR)).filter((name) => name.endsWith(".meta.json"));
  assert.equal(entries.length, 5);
  for (const entry of entries) {
    const meta = JSON.parse(await readFile(join(SAMPLES_DIR, entry), "utf8")) as {
      sanitized: boolean;
      http_status: number;
      collector_version: string;
      request_key: string;
    };
    assert.equal(meta.sanitized, true, `${entry} 应已脱敏`);
    assert.equal(meta.http_status, 200, `${entry} 应为 HTTP 200`);
    assert.equal(meta.collector_version, NETEASE_COLLECTOR_VERSION);
    assert.ok(meta.request_key.length > 0);
    const bodyFile = entry.replace(/\.meta\.json$/, "");
    assert.equal(containsPersonalData(await readFile(join(SAMPLES_DIR, bodyFile), "utf8")), false);
  }
  const lists = entries.filter((name) => name.startsWith("list-"));
  const details = entries.filter((name) => name.startsWith("detail-"));
  assert.ok(lists.length >= 3, "至少 3 份列表样本");
  assert.ok(details.length >= 2, "至少 2 份详情样本");
});

test("网易详情样本可与摘要合并映射为合法职位", async () => {
  const posts = parseNetEaseList(await readSample("list-1.json"));
  const summary = posts.find((post) => post.id === "15318");
  assert.ok(summary);
  const detail = parseNetEaseDetail(await readSample("detail-15318.json"), summary);
  const job = toNetEaseRawJob(detail, "2026-11-21T12:00:00.000Z");
  assert.equal(validateRawCollectedJob(job).ok, true);
  assert.equal(job.source_job_id, "15318");
  assert.equal(job.hints?.locations?.[0], "杭州市");
  assert.equal(job.hints?.degree_raw, "本科");
  assert.equal(job.hints?.experience_raw, "3-5年");
  assert.equal(job.published_at, parseNetEasePublishedAt(detail.updateTime));
});
