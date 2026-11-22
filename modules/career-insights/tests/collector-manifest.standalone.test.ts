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
/** 86 个 zhiye 源：只用它们验收个人数据打码，不把既有 8 个岗位源算进来。 */
const ZHIYE_SOURCE_KEYS = new Set(ZHIYE_SOURCES.map((source) => source.source_key));

async function loadManifest(): Promise<SampleManifest> {
  return JSON.parse(await readFile(join(SAMPLES, "manifest.json"), "utf8")) as SampleManifest;
}

test("真实 manifest 通过结构校验并如实暴露稀疏源配额缺口", async () => {
  const manifest = await loadManifest();
  const validation = validateSampleManifest(manifest);
  assert.deepEqual(validation.errors, []);
  assert.equal(validation.ok, true);

  // 稀疏源（在招 1–3 条）的真实响应只有 Count+1 份互不相同的正文，全局去重空页后必然低于 5 份配额；
  // 契约 @12 要求如实暴露缺口而不是伪造样本，这里逐一钉住缺口来源。
  const quota = evaluateManifestQuota(manifest);
  assert.equal(quota.status, "insufficient");
  assert.deepEqual(
    quota.gaps.map((gap) => `${gap.source_key}:${gap.actual}/${gap.required}`),
    [
      "apsystems-official-careers:2/5",
      "benq-official-careers:4/5",
      "hwatsing-official-careers:1/5",
      "amphenol-official-careers:1/5",
      "sosen-official-careers:1/5",
    ],
  );

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
      "venustech-official-careers:job:5",
      "xinje-official-careers:job:5",
      "roborock-official-careers:job:5",
      "dreame-official-careers:job:5",
      "aac-official-careers:job:5",
      "piotech-official-careers:job:5",
      "siasun-official-careers:job:5",
      "efort-official-careers:job:5",

      "hopewind-official-careers:job:5",
      "sofarsolar-official-careers:job:5",
      "deye-official-careers:job:5",
      "chipone-official-careers:job:5",
      "mornsun-official-careers:job:5",
      "unitree-official-careers:job:5",

      "maxscend-official-careers:job:5",
      "chipsea-official-careers:job:5",
      "delixi-official-careers:job:5",
      "tengen-official-careers:job:5",
      "goldwind-official-careers:job:5",
      "wetown-official-careers:job:5",
      "cicc-official-careers:job:5",
      "guosen-official-careers:job:5",
      "iqiyi-official-careers:job:5",
      "dptech-official-careers:job:5",
      "topsec-official-careers:job:5",
      "zhonghuan-official-careers:job:5",
      "edan-official-careers:job:5",
      "jaka-official-careers:job:5",
      "eoptolink-official-careers:job:5",
      "medcaptain-official-careers:job:5",
      "siglent-official-careers:job:5",
      "mininglamp-official-careers:job:5",
      "rokid-official-careers:job:5",
      "unisound-official-careers:job:5",
      "hellobike-official-careers:job:5",
      "nexchip-official-careers:job:5",
      "pylontech-official-careers:job:5",
      "dobot-official-careers:job:5",
      "infypower-official-careers:job:5",
      "joulwatt-official-careers:job:5",
      "ucloud-official-careers:job:5",

      "beisen-official-careers:job:5",
      "fxiaoke-official-careers:job:5",
      "autochips-official-careers:job:5",
      "bestechnic-official-careers:job:5",
      "biwin-official-careers:job:5",
      "cxmt-official-careers:job:5",
      "longsys-official-careers:job:5",
      "nanxin-official-careers:job:5",
      "risen-official-careers:job:5",
      "tongwei-official-careers:job:5",
      "ymtc-official-careers:job:5",
      "aqara-official-careers:job:5",
      "awinic-official-careers:job:5",
      "digitalchina-official-careers:job:5",
      "snibe-official-careers:job:5",
      "yusys-official-careers:job:5",
      "leapmotor-official-careers:job:5",
      "sunlord-official-careers:job:5",
      "winline-official-careers:job:5",
      "changan-official-careers:job:5",
      "chery-official-careers:job:5",
      "wondershare-official-careers:job:5",
      "jmc-official-careers:job:5",
      "fibocom-official-careers:job:5",
      "neoway-official-careers:job:5",
      "zhihuiya-official-careers:job:5",
      "advantech-official-careers:job:5",
      "liteon2-official-careers:job:5",
      "cosmx-official-careers:job:5",
      "apsystems-official-careers:job:2",
      "benq-official-careers:job:4",
      "hwatsing-official-careers:job:1",
      "amphenol-official-careers:job:1",
      "sosen-official-careers:job:1",
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
  assert.equal(zhiyeSources.length, 86);
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

test("同源样本按正文 sha256 去重，稀疏空页样本 meta 如实说明空页为真实响应", async () => {
  const manifest = await loadManifest();
  for (const source of manifest.sources) {
    const shas = source.samples.map((sample) => sample.body_sha256);
    assert.equal(
      new Set(shas).size,
      shas.length,
      `${source.source_key} 存在正文完全相同的重复样本（未按 body sha 去重）`,
    );
  }

  const emptyPageSamples = [
    "risen-official-careers/samples/list-5.json",
    "apsystems-official-careers/samples/list-2.json",
    "benq-official-careers/samples/list-4.json",
  ];
  for (const bodyFile of emptyPageSamples) {
    const body = JSON.parse(await readFile(join(SAMPLES, bodyFile), "utf8")) as { Data?: unknown };
    assert.deepEqual(body.Data, [], `${bodyFile} 应为 Data=[] 的空页`);
    const meta = JSON.parse(
      await readFile(join(SAMPLES, `${bodyFile}.meta.json`), "utf8"),
    ) as { sanitize_note?: string };
    assert.match(meta.sanitize_note ?? "", /空页/, `${bodyFile} meta 缺少空页说明`);
    assert.match(meta.sanitize_note ?? "", /真实响应/, `${bodyFile} meta 未说明空页为真实响应`);
  }
});

test("beisen/edan 重抓样本的 Id 保持完整 UUID，未被打码改写", async () => {
  const manifest = await loadManifest();
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  for (const sourceKey of ["beisen-official-careers", "edan-official-careers"]) {
    const source = manifest.sources.find((item) => item.source_key === sourceKey);
    assert.ok(source !== undefined, sourceKey);
    let checked = 0;
    for (const sample of source.samples) {
      const body = JSON.parse(await readFile(join(SAMPLES, sample.body_file), "utf8")) as {
        Data?: { Id?: unknown }[];
      };
      for (const item of body.Data ?? []) {
        checked += 1;
        assert.match(String(item.Id), uuidPattern, `${sample.body_file} 的 Id 不是完整 UUID`);
        assert.doesNotMatch(String(item.Id), /redacted/, `${sample.body_file} 的 Id 被打码篡改`);
      }
    }
    assert.ok(checked > 0, `${sourceKey} 未解析到任何条目`);
  }
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