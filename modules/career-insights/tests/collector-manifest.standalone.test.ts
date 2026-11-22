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
import { redactPersonalData } from "../collector/evidence/sanitizer.ts";
import { ZHIYE_SOURCES } from "../collector/adapters/zhiye-official-careers.ts";

const SAMPLES = join(dirname(fileURLToPath(import.meta.url)), "../collector/evidence/samples");
/** 本次新增的 11 个 zhiye 源：只用它们验收个人数据打码，不把既有 8 个岗位源算进来。 */
const ZHIYE_SOURCE_KEYS = new Set(ZHIYE_SOURCES.map((source) => source.source_key));

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
      "huawei-official-careers:job:5",
      "mohrss-policy:policy:5",
      "netease-official-careers:job:5",
      "didi-official-careers:job:5",
      "honor-official-careers:job:5",
      "changsha-rsj-policy:policy:5",
      "hunan-jyt-policy:policy:5",
      "cscec-official-careers:job:6",
      "iflytek-official-careers:job:5",
      "dahua-official-careers:job:5",
      "inovance-official-careers:job:5",
      "sunwoda-official-careers:job:5",
      "boe-official-careers:job:5",
      "sugon-official-careers:job:5",
      "h3c-official-careers:job:5",
      "mindray-official-careers:job:5",
      "united-imaging-official-careers:job:5",
      "invt-official-careers:job:5",
      "sany-official-careers:job:5",
      "hunan-rsj-policy:policy:3",
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

test("manifest 内 sample_id 全局唯一，新增源样本正文不含真实个人数据", async () => {
  const manifest = await loadManifest();
  const seen = new Set<string>();
  for (const source of manifest.sources) {
    for (const sample of source.samples) {
      assert.equal(
        seen.has(sample.sample_id),
        false,
        `sample_id 重复：${sample.body_file}（${sample.sample_id}）`,
      );
      seen.add(sample.sample_id);
    }
  }

  const zhiyeSources = manifest.sources.filter(
    (source) => source.kind === "job" && ZHIYE_SOURCE_KEYS.has(source.source_key),
  );
  assert.equal(zhiyeSources.length, 11);
  for (const source of zhiyeSources) {
    for (const sample of source.samples) {
      const text = await readFile(join(SAMPLES, sample.body_file), "utf8");
      assert.deepEqual(
        redactPersonalData(text).counts,
        { email: 0, phone: 0, contact: 0 },
        `${sample.body_file} 仍含未打码的真实个人数据`,
      );
    }
  }
  assert.equal(
    zhiyeSources.some((source) => source.source_key === "united-imaging-official-careers"),
    true,
  );
});

test("manifest 内 .json 样本打码落盘后仍是合法 JSON", async () => {
  const manifest = await loadManifest();
  let checked = 0;
  for (const source of manifest.sources) {
    for (const sample of source.samples) {
      if (!sample.body_file.endsWith(".json")) {
        continue;
      }
      const text = await readFile(join(SAMPLES, sample.body_file), "utf8");
      assert.doesNotThrow(() => JSON.parse(text), `${sample.body_file} 不是合法 JSON`);
      assert.deepEqual(
        redactPersonalData(text).counts,
        { email: 0, phone: 0, contact: 0 },
        `${sample.body_file} 打码后仍有个人数据`,
      );
      checked += 1;
    }
  }
  assert.ok(checked > 0);
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