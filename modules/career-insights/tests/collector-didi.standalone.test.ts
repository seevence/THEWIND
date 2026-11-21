import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  DIDI_COLLECTOR_VERSION,
  DIDI_LIST_URL,
  DIDI_SOURCE_DEFINITION,
  createDidiOfficialCareersAdapter,
  didiDetailPageUrl,
  parseDidiDetail,
  parseDidiList,
  parseDidiPublishedAt,
  toDidiRawJob,
} from "../collector/adapters/didi-official-careers.ts";
import { SampleStore } from "../collector/evidence/sample-store.ts";
import { containsPersonalData } from "../collector/evidence/sanitizer.ts";
import { ReplayTransport } from "../collector/fetch/replay-transport.ts";
import type { FetchTransport, PageRequest } from "../collector/fetch/transport.ts";
import { validateCollectedJobs } from "../collector/orchestration/runner.ts";
import { validateRawCollectedJob } from "../collector/validate.ts";

const SAMPLES = join(dirname(fileURLToPath(import.meta.url)), "../collector/evidence/samples");
const SOURCE = "didi-official-careers";
const SAMPLES_DIR = join(SAMPLES, SOURCE, "samples");
const ADAPTER_OPTIONS = {
  definition: DIDI_SOURCE_DEFINITION,
  sleep: async () => {},
  now: () => "2026-11-21T12:00:00.000Z",
};

async function readSample(name: string): Promise<string> {
  return readFile(join(SAMPLES_DIR, name), "utf8");
}

async function replaySamples(): Promise<ReplayTransport> {
  const store = new SampleStore(SAMPLES);
  const entries = (await readdir(SAMPLES_DIR)).filter(
    (name) => name.endsWith(".json") && !name.endsWith(".meta.json"),
  );
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

test("滴滴列表真实样本解析出 10 条且字段保真", async () => {
  const items = parseDidiList(await readSample("list-1.json"));
  assert.equal(items.length, 10);
  const first = items[0];
  assert.ok(first !== undefined);
  assert.ok(first.jdId.length > 0);
  assert.ok(first.title.length > 0);
  assert.ok(first.duty !== null);
  assert.ok(first.qualification !== null);
  assert.ok(first.locations.length >= 1);
  assert.equal(didiDetailPageUrl(first.jdId), `https://talent.didiglobal.com/social/jobDetail?jdId=${first.jdId}`);
});

test("滴滴列表条目缺少 jdId 或 jobName 时抛 ParseFailedError", () => {
  const body = JSON.stringify({ meta: { code: 0 }, data: { items: [{ jobName: "缺少主键" }] } });
  assert.throws(() => parseDidiList(body), /缺少 jdId \/ jobName/);
});

test("滴滴列表响应结构变化时抛 SchemaChangedError 而不是空结果", () => {
  assert.throws(() => parseDidiList(JSON.stringify({ meta: { code: 0 }, data: {} })), /data\.items/);
  assert.throws(() => parseDidiList(JSON.stringify({ data: null })), /data\.items/);
});

test("滴滴发布时间按 +08:00 读成 UTC ISO，非法格式返回 null", () => {
  assert.equal(parseDidiPublishedAt("2026-11-09 10:35:35", null), "2026-11-09T02:35:35.000Z");
  assert.equal(parseDidiPublishedAt(null, "2026-11-20"), "2026-11-19T16:00:00.000Z");
  assert.equal(parseDidiPublishedAt(null, null, 1794191735000), "2026-11-09T02:35:35.000Z");
  assert.equal(parseDidiPublishedAt("昨天", "刚刚"), null);
  assert.equal(parseDidiPublishedAt(null, null), null);
});

test("滴滴 3 页列表回放产出 30 条合法原始职位，且零网络请求", async () => {
  const adapter = createDidiOfficialCareersAdapter(await replaySamples(), {
    ...ADAPTER_OPTIONS,
    pageLimit: 3,
  });
  const jobs = await adapter.collect();
  assert.equal(jobs.length, 30);
  const report = validateCollectedJobs(jobs);
  assert.equal(report.invalid.length, 0, JSON.stringify(report.invalid.slice(0, 2)));
  assert.equal(report.valid.length, 30);
  assert.ok(jobs.every((job) => job.company_name === "滴滴"));
  assert.ok(jobs.every((job) => job.source_key === SOURCE));
  assert.ok(jobs.every((job) => job.collector_version === DIDI_COLLECTOR_VERSION));
  assert.ok(jobs.every((job) => job.official_url.startsWith("https://talent.didiglobal.com/social/jobDetail?jdId=")));
  assert.ok(jobs.every((job) => job.published_at !== null));
  assert.ok(jobs.every((job) => job.hints?.locations?.length === 1));
  assert.equal(new Set(jobs.map((job) => job.source_job_id)).size, 30);
});

test("滴滴列表缺正文时回退公开详情接口，产出 1 条合法职位", async () => {
  const list = JSON.parse(await readSample("list-1.json")) as {
    data: { items: Array<Record<string, unknown>> };
  };
  const target = list.data.items.find((item) => item["jdId"] === 63724);
  assert.ok(target, "list-1 样本应包含 jdId=63724");
  delete target["jobDuty"];
  delete target["jobQualification"];
  list.data.items = [target];
  const strippedBody = Buffer.from(JSON.stringify(list));

  const store = new SampleStore(SAMPLES);
  const listSample = await store.load(`${SOURCE}/samples/list-1.json`);
  const detail = await store.load(`${SOURCE}/samples/detail-63724.json`);
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
  const adapter = createDidiOfficialCareersAdapter(replay, { ...ADAPTER_OPTIONS, pageLimit: 1 });
  const jobs = await adapter.collect();
  assert.equal(jobs.length, 1);
  const [job] = jobs;
  assert.ok(job !== undefined);
  assert.equal(validateRawCollectedJob(job).ok, true);
  assert.equal(job.source_job_id, "63724");
  assert.ok(job.raw_text.length > 100);
  assert.equal(job.published_at, "2026-11-09T02:35:35.000Z");
});

test("滴滴列表已含正文时不请求详情接口，页数不超过 3", async () => {
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
  const adapter = createDidiOfficialCareersAdapter(transport, { ...ADAPTER_OPTIONS, pageLimit: 9 });
  const jobs = await adapter.collect();
  assert.equal(jobs.length, 30);
  assert.equal(calls.length, 3);
  assert.ok(calls.every((call) => call.method === "GET"));
  assert.deepEqual(
    calls.map((call) => new URLSearchParams(new URL(call.url).search).get("page")),
    ["1", "2", "3"],
  );
  assert.ok(calls.every((call) => call.url.startsWith(DIDI_LIST_URL)));
});

test("滴滴样本元信息完整、已脱敏且正文不含个人联系方式", async () => {
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
    assert.equal(meta.collector_version, DIDI_COLLECTOR_VERSION);
    assert.ok(meta.request_key.length > 0);
    const bodyFile = entry.replace(/\.meta\.json$/, "");
    assert.equal(containsPersonalData(await readFile(join(SAMPLES_DIR, bodyFile), "utf8")), false);
  }
  assert.ok(entries.filter((name) => name.startsWith("list-")).length >= 3, "至少 3 份列表样本");
  assert.ok(entries.filter((name) => name.startsWith("detail-")).length >= 2, "至少 2 份详情样本");
});

test("滴滴详情样本可与摘要合并映射为合法职位", async () => {
  const items = parseDidiList(await readSample("list-1.json"));
  const summary = items.find((item) => item.jdId === "63724");
  assert.ok(summary);
  const detail = parseDidiDetail(await readSample("detail-63724.json"), summary);
  const job = toDidiRawJob(detail, "2026-11-21T12:00:00.000Z");
  assert.equal(validateRawCollectedJob(job).ok, true);
  assert.equal(job.source_job_id, "63724");
  assert.equal(job.hints?.locations?.[0], "北京市");
  assert.equal(parseDidiPublishedAt(detail.createTime, detail.refreshTime, detail.publishTimeMs), detail.publishTimeMs === null ? null : new Date(detail.publishTimeMs).toISOString());
});
