import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createAlibabaOfficialCareersAdapter } from "../collector/adapters/alibaba-official-careers.ts";
import {
  createTencentOfficialCareersAdapter,
  parseTencentDetail,
  parseTencentList,
  parseTencentPublishedAt,
  toTencentRawJob,
} from "../collector/adapters/tencent-official-careers.ts";
import {
  ZHIYE_SOURCES,
  ZHIYE_SOURCE_SPECS,
  zhiyeJobsPageUrl,
} from "../collector/adapters/zhiye-official-careers.ts";
import { createCareerAdapters } from "../collector/index.ts";
import { CollectorError } from "../collector/fetch/errors.ts";
import type { FetchTransport, PageRequest, TransportResponse } from "../collector/fetch/transport.ts";
import { validateRawCollectedJob } from "../collector/validate.ts";

function fakeTransport(calls: PageRequest[]): FetchTransport {
  return {
    async fetchPage(request) {
      calls.push(request);
      return {
        status: 200,
        requestUrl: request.url,
        finalUrl: request.url,
        contentType: "text/html; charset=utf-8",
        headers: { "content-type": "text/html; charset=utf-8" },
        body: Buffer.from("<html><body>stub</body></html>"),
        fetchedAt: "2026-11-18T08:00:00.000Z",
      };
    },
  };
}

test("适配器骨架只经注入传输取页，且一次 collect 只取一次", async () => {
  const calls: PageRequest[] = [];
  const adapter = createAlibabaOfficialCareersAdapter(fakeTransport(calls));

  await assert.rejects(adapter.collect(), (error: unknown) => {
    assert.ok(error instanceof CollectorError);
    assert.equal(error.failureType, "schema_changed");
    assert.match(error.message, /alibaba-official-careers/);
    return true;
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.sourceKey, "alibaba-official-careers");
  assert.equal(calls[0]?.pageTimeoutMs, 20_000);
});

test("AbortSignal 透传到页面请求", async () => {
  const calls: PageRequest[] = [];
  const controller = new AbortController();
  const adapter = createAlibabaOfficialCareersAdapter(fakeTransport(calls));

  await assert.rejects(adapter.collect(controller.signal));
  assert.equal(calls[0]?.signal, controller.signal);
});

test("注册表只构造已启用来源，job 与 policy 分离且不发起网络", () => {
  const calls: PageRequest[] = [];
  const set = createCareerAdapters(fakeTransport(calls));
  assert.deepEqual(
    set.jobs.map((adapter) => adapter.definition.source_key),
    ["tencent-official-careers", "meituan-official-careers", "baidu-official-careers", "huawei-official-careers", "netease-official-careers", "didi-official-careers", "honor-official-careers", "cscec-official-careers", "iflytek-official-careers", "dahua-official-careers", "inovance-official-careers", "sunwoda-official-careers", "boe-official-careers", "sugon-official-careers", "h3c-official-careers", "mindray-official-careers", "united-imaging-official-careers", "invt-official-careers", "sany-official-careers", "venustech-official-careers", "xinje-official-careers", "roborock-official-careers", "dreame-official-careers", "aac-official-careers", "piotech-official-careers", "siasun-official-careers", "efort-official-careers", "hopewind-official-careers", "sofarsolar-official-careers", "deye-official-careers", "chipone-official-careers", "mornsun-official-careers", "unitree-official-careers"],
  );
  assert.equal(set.jobs.length, 33);
  assert.deepEqual(
    set.policies.map((adapter) => adapter.definition.source_key),
    ["state-council-policy", "ndrc-policy", "moe-policy", "mohrss-policy", "changsha-rsj-policy", "hunan-jyt-policy", "hunan-rsj-policy"],
  );
  assert.equal(set.policies.length, 7);
  assert.equal(calls.length, 0);
});

test("zhiye 源的入口与展示名均取自 ZHIYE_SOURCE_SPECS", () => {
  const set = createCareerAdapters(fakeTransport([]));
  const byKey = new Map(set.jobs.map((adapter) => [adapter.definition.source_key, adapter.definition]));

  assert.equal(ZHIYE_SOURCE_SPECS.length, 25);
  for (const spec of ZHIYE_SOURCE_SPECS) {
    const definition = byKey.get(spec.sourceKey);
    assert.ok(definition, `注册表缺少 zhiye 源 ${spec.sourceKey}`);
    assert.equal(definition.entry_url, zhiyeJobsPageUrl(spec.tenant));

    const reference = ZHIYE_SOURCES.find((item) => item.source_key === spec.sourceKey);
    assert.ok(reference, `ZHIYE_SOURCES 缺少 ${spec.sourceKey}`);
    assert.equal(definition.label, reference.label);
  }
});
const SAMPLES_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "../collector/evidence/samples/tencent-official-careers/samples",
);

function sampleResponse(body: Buffer, url: string): TransportResponse {
  return {
    status: 200,
    requestUrl: url,
    finalUrl: url,
    contentType: "application/json; charset=utf-8",
    headers: { "content-type": "application/json; charset=utf-8" },
    body,
    fetchedAt: "2026-11-18T08:00:00.000Z",
  };
}

test("腾讯列表真实样本解析出 10 条且字段保真", async () => {
  const posts = parseTencentList(await readFile(join(SAMPLES_DIR, "list.json")));
  assert.equal(posts.length, 10);
  assert.ok(posts[0]?.postId);
  assert.ok(posts[0]?.title);
  assert.match(posts[0]?.postUrl ?? "", /^https?:\/\//);
});

test("腾讯 5 条详情真实样本全部映射为合法 RawCollectedJobV1", async () => {
  const entries = await readdir(SAMPLES_DIR);
  const detailFiles = entries.filter(
    (name) => name.startsWith("detail-") && name.endsWith(".json") && !name.endsWith(".meta.json"),
  );
  assert.equal(detailFiles.length, 5);

  const posts = parseTencentList(await readFile(join(SAMPLES_DIR, "list.json")));
  const byId = new Map(posts.map((post) => [post.postId, post]));

  let checked = 0;
  for (const file of detailFiles) {
    const postId = file.replace(/^detail-/, "").replace(/\.json$/, "");
    const summary = byId.get(postId);
    assert.ok(summary, `列表样本应包含 ${postId}`);
    const detail = parseTencentDetail(await readFile(join(SAMPLES_DIR, file)), summary);
    const job = toTencentRawJob(detail, "2026-11-18T08:00:00.000Z");
    assert.equal(validateRawCollectedJob(job).ok, true, `${postId} 应通过校验`);
    assert.equal(job.published_at, "2026-11-18T00:00:00.000Z");
    assert.ok(job.raw_text.length > 0);
    assert.equal(job.hints?.locations?.length, 1);
    checked += 1;
  }
  assert.equal(checked, 5);
});

test("腾讯发布时间只接受显式中文/ISO 日期，相对时间保持 null", () => {
  assert.equal(parseTencentPublishedAt("2026年11月18日"), "2026-11-18T00:00:00.000Z");
  assert.equal(parseTencentPublishedAt("2026-11-18"), "2026-11-18T00:00:00.000Z");
  assert.equal(parseTencentPublishedAt("刚刚"), null);
  assert.equal(parseTencentPublishedAt(null), null);
});

test("腾讯 collect 经注入传输取列表与详情，产出 5 条", async () => {
  const entries = await readdir(SAMPLES_DIR);
  const detailBodies = new Map<string, Buffer>();
  for (const file of entries.filter(
    (name) => name.startsWith("detail-") && name.endsWith(".json") && !name.endsWith(".meta.json"),
  )) {
    const postId = file.replace(/^detail-/, "").replace(/\.json$/, "");
    detailBodies.set(postId, await readFile(join(SAMPLES_DIR, file)));
  }

  const list = JSON.parse(await readFile(join(SAMPLES_DIR, "list.json"), "utf8")) as {
    Data: { Count: number; Posts: Array<{ PostId: string }> };
  };
  list.Data.Posts = list.Data.Posts.filter((post) => detailBodies.has(post.PostId));
  list.Data.Count = list.Data.Posts.length;
  const listBody = Buffer.from(JSON.stringify(list));

  const transport: FetchTransport = {
    async fetchPage(request) {
      if (request.url.includes("ByPostId")) {
        const postId = new URL(request.url).searchParams.get("postId") ?? "";
        const body = detailBodies.get(postId);
        assert.ok(body, `缺少 ${postId} 的详情样本`);
        return sampleResponse(body, request.url);
      }
      return sampleResponse(listBody, request.url);
    },
  };

  const adapter = createTencentOfficialCareersAdapter(transport, {
    pageLimit: 1,
    sleep: async () => undefined,
    now: () => "2026-11-18T08:00:00.000Z",
  });
  const jobs = await adapter.collect();
  assert.equal(jobs.length, 5);
  for (const job of jobs) {
    assert.equal(validateRawCollectedJob(job).ok, true);
    assert.equal(job.fetched_at, "2026-11-18T08:00:00.000Z");
    assert.equal(job.source_key, "tencent-official-careers");
    assert.equal(job.collector_version, "collector/0.1.0");
  }
});