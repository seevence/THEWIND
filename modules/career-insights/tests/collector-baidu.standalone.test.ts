import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  createBaiduOfficialCareersAdapter,
  normalizeBaiduWorkPlace,
  parseBaiduList,
  parseBaiduPublishedAt,
} from "../collector/adapters/baidu-official-careers.ts";
import { ReplayTransport } from "../collector/fetch/replay-transport.ts";
import { SampleStore } from "../collector/evidence/sample-store.ts";
import { validateCollectedJobs } from "../collector/orchestration/runner.ts";

const SAMPLES = join(dirname(fileURLToPath(import.meta.url)), "../collector/evidence/samples");
const SOURCE = "baidu-official-careers";

async function listBody(page: number): Promise<string> {
  return readFile(join(SAMPLES, SOURCE, "samples", `list-${page}.json`), "utf8");
}

test("百度列表解析出 postId、标题、工作内容与服务条件", async () => {
  const items = parseBaiduList(await listBody(2));
  assert.equal(items.length, 10);
  const first = items[0];
  assert.ok(first !== undefined);
  assert.ok(first.postId.length > 0);
  assert.ok(first.title.length > 0);
});

test("百度响应 status 不是 ok 时抛 SchemaChangedError，不当空结果", () => {
  assert.throws(
    () => parseBaiduList(JSON.stringify({ status: "no-auth", message: "illegal-visit" })),
    /status=no-auth/,
  );
});

test("百度列表条目缺少 postId 或 name 时抛 ParseFailedError", () => {
  const body = JSON.stringify({ status: "ok", data: { list: [{ name: "缺 postId" }] } });
  assert.throws(() => parseBaiduList(body), /postId \/ name/);
});

test("百度工作地点按中英文逗号切分并去重", () => {
  assert.deepEqual(normalizeBaiduWorkPlace("北京市,上海市，北京市、深圳市"), [
    "北京市",
    "上海市",
    "深圳市",
  ]);
  assert.deepEqual(normalizeBaiduWorkPlace(null), []);
  assert.deepEqual(normalizeBaiduWorkPlace("  "), []);
});

test("百度发布日期解析为 UTC 日期，非法格式返回 null", () => {
  assert.equal(parseBaiduPublishedAt("2026-11-17"), "2026-11-17T00:00:00.000Z");
  assert.equal(parseBaiduPublishedAt(""), null);
  assert.equal(parseBaiduPublishedAt(null), null);
});

test("百度回放产出 10 条合法原始职位，且零网络请求", async () => {
  const store = new SampleStore(SAMPLES);
  const record = await store.load(`${SOURCE}/samples/list-1.json`);
  const replay = new ReplayTransport([
    {
      request_key: record.meta.request_key,
      captured_at: record.meta.captured_at,
      status: record.meta.http_status,
      request_url: record.meta.request_url,
      final_url: record.meta.final_url,
      content_type: record.meta.content_type,
      headers: {},
      body: record.body,
    },
  ]);
  const adapter = createBaiduOfficialCareersAdapter(replay, {
    pageLimit: 1,
    sleep: async () => {},
    now: () => "2026-11-18T12:00:00.000Z",
  });
  const jobs = await adapter.collect();
  assert.equal(jobs.length, 10);
  const report = validateCollectedJobs(jobs);
  assert.equal(report.invalid.length, 0, JSON.stringify(report.invalid.slice(0, 2)));
  assert.equal(report.valid.length, 10);
  assert.ok(jobs.every((job) => job.company_name === "百度"));
  assert.ok(jobs.every((job) => job.official_url.startsWith("https://talent.baidu.com/jobs/detail/")));
});