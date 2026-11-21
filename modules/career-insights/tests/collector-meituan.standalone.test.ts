import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  createMeituanOfficialCareersAdapter,
  parseMeituanList,
  parseMeituanPublishedAt,
} from "../collector/adapters/meituan-official-careers.ts";
import { ReplayTransport } from "../collector/fetch/replay-transport.ts";
import { SampleStore } from "../collector/evidence/sample-store.ts";
import { validateCollectedJobs } from "../collector/orchestration/runner.ts";

const SAMPLES = join(dirname(fileURLToPath(import.meta.url)), "../collector/evidence/samples");
const SOURCE = "meituan-official-careers";

async function listBody(page: number): Promise<string> {
  return readFile(join(SAMPLES, SOURCE, "samples", `list-${page}.json`), "utf8");
}

test("美团列表解析出职位主键、标题、地点与职责要求", async () => {
  const items = parseMeituanList(await listBody(1));
  assert.equal(items.length, 10);
  const first = items[0];
  assert.ok(first !== undefined);
  assert.ok(first.jobUnionId.length > 0);
  assert.ok(first.title.length > 0);
  assert.ok(items.every((item) => Array.isArray(item.locations)));
});

test("美团列表条目缺少 jobUnionId 或 name 时抛 ParseFailedError", () => {
  const body = JSON.stringify({ data: { list: [{ name: "缺少主键" }] } });
  assert.throws(() => parseMeituanList(body), /jobUnionId \/ name/);
});

test("美团列表响应结构变化时抛 SchemaChangedError 而不是空结果", () => {
  assert.throws(() => parseMeituanList(JSON.stringify({ data: {} })), /data\.list/);
});

test("美团地点去重且过滤空值", () => {
  const body = JSON.stringify({
    data: {
      list: [
        {
          jobUnionId: "1",
          name: "测试职位",
          cityList: [{ name: "北京市" }, { name: "北京市" }, { name: "" }, { name: null }, { name: "上海市" }],
          jobDuty: "职责",
          jobRequirement: "要求",
        },
      ],
    },
  });
  const [item] = parseMeituanList(body);
  assert.deepEqual(item?.locations, ["北京市", "上海市"]);
});

test("美团发布时间解析为 UTC 日期，非法格式返回 null", () => {
  assert.equal(parseMeituanPublishedAt("2026-11-18"), "2026-11-18T00:00:00.000Z");
  assert.equal(parseMeituanPublishedAt("2026-11-18 10:22:33"), "2026-11-18T00:00:00.000Z");
  assert.equal(parseMeituanPublishedAt("昨天"), null);
  assert.equal(parseMeituanPublishedAt(null), null);
});

test("美团回放产出 10 条合法原始职位，且零网络请求", async () => {
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
  const adapter = createMeituanOfficialCareersAdapter(replay, {
    pageLimit: 1,
    sleep: async () => {},
    now: () => "2026-11-18T12:00:00.000Z",
  });
  const jobs = await adapter.collect();
  assert.equal(jobs.length, 10);
  const report = validateCollectedJobs(jobs);
  assert.equal(report.invalid.length, 0, JSON.stringify(report.invalid.slice(0, 2)));
  assert.equal(report.valid.length, 10);
  assert.ok(jobs.every((job) => job.company_name === "美团"));
  assert.ok(jobs.every((job) => job.official_url.includes("jobUnionId=")));
});