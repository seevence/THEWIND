import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  SampleStore,
  assertInsideRoot,
  createSample,
  sampleIdFromBody,
  sha256Hex,
} from "../collector/evidence/sample-store.ts";
import { createSample as createSampleRecord } from "../collector/evidence/sample-store.ts";
import { ReplaySampleMissingError, SampleRejectedError } from "../collector/fetch/errors.ts";
import { sanitizeSample, stripSensitiveHeaders } from "../collector/evidence/sanitizer.ts";
import { evaluateQuota } from "../collector/evidence/quota.ts";
import { ReplayTransport, computeRequestKey } from "../collector/fetch/replay-transport.ts";
import type { ReplaySample } from "../collector/fetch/replay-transport.ts";
import { installNetworkGuard } from "../collector/fetch/network-guard.ts";
import { createTransport, transportFactoryStats } from "../collector/fetch/create-transport.ts";

const META = {
  request_key: "GET https://talent.alibaba.com/jobs",
  request_url: "https://talent.alibaba.com/jobs",
  final_url: "https://talent.alibaba.com/jobs",
  http_status: 200,
  content_type: "text/html",
  captured_at: "2026-11-17T08:00:00.000Z",
  collector_version: "0.1.0",
  extraction_ref: "list",
  sanitized: true,
  body_file: "jobs.html",
};

test("样本 ID 取正文 SHA-256 前 16 位且稳定", () => {
  const body = Buffer.from("<html>jobs</html>");
  assert.equal(sha256Hex(body).length, 64);
  assert.equal(sampleIdFromBody(body).length, 16);
  assert.equal(sampleIdFromBody(body), sampleIdFromBody(body));
});

test("缺任一必填元信息即拒收样本", () => {
  for (const field of ["request_key", "final_url", "captured_at", "sanitized"] as const) {
    assert.throws(
      () => createSample({ ...META, body: Buffer.from("x"), [field]: "" } as never),
      SampleRejectedError,
    );
  }
});

test("样本路径不得越出组件目录", () => {
  assert.throws(() => assertInsideRoot("fixtures", "../other/body.html"), SampleRejectedError);
  assert.doesNotThrow(() => assertInsideRoot("fixtures", "alibaba-official-careers/body.html"));
});

test("样本可写入并读回", async () => {
  const root = await mkdtemp(join(tmpdir(), "collector-samples-"));
  const store = new SampleStore(root);
  const record = createSampleRecord({ ...META, body: Buffer.from("<html>ok</html>") });
  const path = await store.save(record, "alibaba-official-careers/jobs.html");
  assert.ok(path.startsWith(root));
  const loaded = await store.load("alibaba-official-careers/jobs.html");
  assert.equal(loaded.meta.sample_id, record.meta.sample_id);
  assert.equal(loaded.body.toString(), "<html>ok</html>");
  await writeFile(join(root, "marker.txt"), "ok");
});

test("脱敏层剔除敏感响应头，正文含个人数据直接拒收", () => {
  const stripped = stripSensitiveHeaders({
    "Set-Cookie": "sid=1",
    Authorization: "Bearer token",
    "content-type": "text/html",
  });
  assert.deepEqual(stripped.removed, ["Set-Cookie", "Authorization"]);
  assert.equal(stripped.headers["content-type"], "text/html");

  assert.equal(sanitizeSample({ headers: {}, bodyText: "投递邮箱 hr@example.com" }).ok, false);
  assert.equal(sanitizeSample({ headers: {}, bodyText: "公开职位描述" }).ok, true);
});

test("招聘源每源至少 5 份、政策源至少 3 份样本", () => {
  const report = evaluateQuota([
    { source_key: "alibaba-official-careers", kind: "job", sample_count: 4 },
    { source_key: "state-council-policy", kind: "policy", sample_count: 2 },
    { source_key: "ndrc-policy", kind: "policy", sample_count: 3 },
  ]);
  assert.equal(report.status, "insufficient");
  assert.deepEqual(report.gaps, [
    {
      source_key: "alibaba-official-careers",
      kind: "job",
      required: 5,
      actual: 4,
      missing: 1,
    },
    { source_key: "state-council-policy", kind: "policy", required: 3, actual: 2, missing: 1 },
  ]);
});

const sample: ReplaySample = {
  request_key: computeRequestKey("https://talent.alibaba.com/jobs"),
  captured_at: "2026-11-17T08:00:00.000Z",
  status: 200,
  request_url: "https://talent.alibaba.com/jobs",
  final_url: "https://talent.alibaba.com/jobs",
  content_type: "text/html",
  headers: {},
  body: Buffer.from("<html></html>"),
};

const request = {
  url: "https://talent.alibaba.com/jobs",
  method: "GET" as const,
  headers: {},
  pageTimeoutMs: 20_000,
  sourceKey: "alibaba-official-careers",
};

test("回放命中样本，缺失样本直接失败", async () => {
  const response = await new ReplayTransport([sample]).fetchPage(request);
  assert.equal(response.status, 200);
  await assert.rejects(
    new ReplayTransport([]).fetchPage({ ...request, url: "https://talent.alibaba.com/missing" }),
    ReplaySampleMissingError,
  );
});

test("回放按锚点选择不晚于锚点的最近样本", async () => {
  const older: ReplaySample = { ...sample, captured_at: "2026-11-01T00:00:00.000Z", body: Buffer.from("old") };
  const newer: ReplaySample = { ...sample, captured_at: "2026-11-10T00:00:00.000Z", body: Buffer.from("new") };
  const response = await new ReplayTransport([older, newer], "2026-11-05T00:00:00.000Z").fetchPage(request);
  assert.equal(response.body.toString(), "old");
});

test("回放模式不构造 HTTP 传输，动态渲染拒绝在库进程执行", () => {
  transportFactoryStats.reset();
  createTransport("replay", { replaySamples: [] });
  assert.equal(transportFactoryStats.httpConstructed, 0);
  assert.equal(transportFactoryStats.replayConstructed, 1);
  assert.throws(() => createTransport("dynamic"), /独立 CLI 子进程/);
});

test("网络守卫拦截回放期间的一切出网调用", async () => {
  const holder = { fetch: globalThis.fetch };
  const guard = installNetworkGuard(holder);
  await assert.rejects(holder.fetch("https://talent.alibaba.com/jobs"), /真实网络/);
  assert.equal(guard.violations(), 1);
  guard.restore();
  assert.equal(holder.fetch, globalThis.fetch);
});