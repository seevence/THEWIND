import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  evaluateManifestQuota,
  validateSampleManifest,
} from "../collector/evidence/manifest.ts";
import type { SampleManifest } from "../collector/evidence/manifest.ts";

const SAMPLES = join(dirname(fileURLToPath(import.meta.url)), "../collector/evidence/samples");

async function loadManifest(): Promise<SampleManifest> {
  return JSON.parse(await readFile(join(SAMPLES, "manifest.json"), "utf8")) as SampleManifest;
}

test("真实 manifest 通过结构校验并满足样本配额", async () => {
  const manifest = await loadManifest();
  const validation = validateSampleManifest(manifest);
  assert.deepEqual(validation.errors, []);
  assert.equal(validation.ok, true);

  const quota = evaluateManifestQuota(manifest);
  assert.equal(quota.status, "ok");
  assert.deepEqual(quota.gaps, []);

  assert.deepEqual(
    manifest.sources.map((source) => `${source.source_key}:${source.kind}:${source.sample_count}`),
    [
      "moe-policy:policy:4",
      "ndrc-policy:policy:4",
      "tencent-official-careers:job:6",
      "meituan-official-careers:job:5",
      "baidu-official-careers:job:5",
      "state-council-policy:policy:4",
    ],
  );
});

test("manifest 中每份样本的正文存在且 sha256 一致", async () => {
  const manifest = await loadManifest();
  let checked = 0;
  for (const source of manifest.sources) {
    for (const sample of source.samples) {
      const body = await readFile(join(SAMPLES, sample.body_file));
      const actual = createHash("sha256").update(body).digest("hex");
      assert.equal(actual, sample.body_sha256, `${sample.body_file} 哈希不一致`);
      checked += 1;
    }
  }
  const expected = manifest.sources.reduce((sum, source) => sum + source.samples.length, 0);
  assert.equal(checked, expected);
  assert.ok(checked >= 18, `样本总数不得少于既有基线 18，实际 ${checked}`);
});

test("manifest 拒绝计数不一致、路径越界与非法哈希", async () => {
  const manifest = await loadManifest();
  const tampered = structuredClone(manifest);
  const jobSource = tampered.sources.find((source) => source.kind === "job");
  assert.ok(jobSource);
  (jobSource as { sample_count: number }).sample_count = 999;
  (jobSource.samples[0] as { body_file: string }).body_file = "../escape.html";
  (jobSource.samples[1] as { body_sha256: string }).body_sha256 = "not-a-sha";

  const validation = validateSampleManifest(tampered);
  assert.equal(validation.ok, false);
  assert.ok(validation.errors.some((error) => error.includes("sample_count")));
  assert.ok(validation.errors.some((error) => error.includes("body_file")));
  assert.ok(validation.errors.some((error) => error.includes("body_sha256")));
});