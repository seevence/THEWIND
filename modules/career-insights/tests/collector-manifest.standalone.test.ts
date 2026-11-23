import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  buildSampleManifest,
  evaluateManifestQuota,
  quotaItemsFromManifest,
  validateSampleManifest,
} from "../collector/evidence/manifest.ts";
import type { ManifestSampleRef, SampleManifest } from "../collector/evidence/manifest.ts";
import { evaluateQuota } from "../collector/evidence/quota.ts";
import { UNKNOWN_CONTENT_TYPE, createSample, sha256Hex } from "../collector/evidence/sample-store.ts";
import { SampleRejectedError } from "../collector/fetch/errors.ts";
import { redactPersonalData } from "../collector/evidence/sanitizer.ts";
import { ZHIYE_SOURCES, ZHIYE_SOURCE_SPECS } from "../collector/adapters/zhiye-official-careers.ts";

const SAMPLES = join(dirname(fileURLToPath(import.meta.url)), "../collector/evidence/samples");
/** 86 个 zhiye 源：只用它们验收个人数据打码，不把既有 8 个岗位源算进来。 */
const ZHIYE_SOURCE_KEYS = new Set(ZHIYE_SOURCES.map((source) => source.source_key));
/** 实测在招条数 < 5 的稀疏源；配额按 min(5, max(1, Count)) 收缩。 */
const SPARSE_JOB_COUNTS: Readonly<Record<string, number>> = Object.fromEntries(
  ZHIYE_SOURCE_SPECS.filter((spec) => spec.sparseJobCount !== undefined).map((spec) => [
    spec.sourceKey,
    spec.sparseJobCount as number,
  ]),
);

async function loadManifest(): Promise<SampleManifest> {
  return JSON.parse(await readFile(join(SAMPLES, "manifest.json"), "utf8")) as SampleManifest;
}

test("真实 manifest 通过结构校验，基线如实暴露缺口、稀疏源按实测 Count 收缩后无缺口", async () => {
  const manifest = await loadManifest();
  const validation = validateSampleManifest(manifest);
  assert.deepEqual(validation.errors, []);
  assert.equal(validation.ok, true);

  // 基线（不看 sparse_job_count）仍按每源 5 份：稀疏源天然不足，如实暴露而不是伪造样本。
  const denseQuota = evaluateManifestQuota(manifest);
  assert.equal(denseQuota.status, "insufficient");
  assert.deepEqual(
    denseQuota.gaps.map((gap) => `${gap.source_key}:${gap.actual}/${gap.required}`),
    [
      "apsystems-official-careers:2/5",
      "benq-official-careers:4/5",
      "hwatsing-official-careers:1/5",
      "amphenol-official-careers:1/5",
      "sosen-official-careers:1/5",
    ],
  );

  // 稀疏源按 min(5, Count) 收缩为「最低可接受数据页数」：
  // risen(4)、apsystems(1)、benq(3)、hwatsing(1)、amphenol(1)、sosen(1) 均无缺口。
  // 空页正文跨源字节相同且 sample_id 必须全局唯一，稀疏源物理上只落 1 份数据页，不再视为缺份。
  const quota = evaluateManifestQuota(manifest, SPARSE_JOB_COUNTS);
  assert.equal(quota.status, "ok");
  assert.deepEqual(quota.gaps, []);
  assert.deepEqual(Object.keys(SPARSE_JOB_COUNTS).sort(), [
    "amphenol-official-careers",
    "apsystems-official-careers",
    "benq-official-careers",
    "hwatsing-official-careers",
    "risen-official-careers",
    "sosen-official-careers",
  ]);
  const sparseItems = quotaItemsFromManifest(manifest, SPARSE_JOB_COUNTS).filter(
    (item) => item.sparse_job_count !== undefined,
  );
  assert.equal(sparseItems.length, 6);
  for (const item of sparseItems) {
    const count = SPARSE_JOB_COUNTS[item.source_key];
    assert.equal(item.sparse_job_count, count);
    assert.ok(item.sample_count >= Math.min(5, Math.max(1, count)));
  }

  assert.equal(manifest.sources.length, 101);
  assert.equal(
    manifest.sources.reduce((sum, source) => sum + source.sample_count, 0),
    486,
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
test("evaluateQuota 对稀疏源按 min(5, Count) 收缩（下限 1），未提供 Count 或 Count=0 均不放宽到 0", () => {
  const report = evaluateQuota([
    { source_key: "sparse-1", kind: "job", sample_count: 1, sparse_job_count: 1 },
    { source_key: "sparse-4", kind: "job", sample_count: 4, sparse_job_count: 4 },
    { source_key: "sparse-zero", kind: "job", sample_count: 1, sparse_job_count: 0 },
    { source_key: "dense", kind: "job", sample_count: 4 },
  ]);
  assert.equal(report.status, "insufficient");
  assert.deepEqual(report.gaps, [
    { source_key: "dense", kind: "job", required: 5, actual: 4, missing: 1 },
  ]);

  // Count=0 收缩到下限 1：1 份数据页即达标，但 0 份仍算缺口，不因「无在招」豁免证据。
  assert.equal(
    evaluateQuota([{ source_key: "zero", kind: "job", sample_count: 1, sparse_job_count: 0 }]).ok,
    true,
  );
  assert.deepEqual(
    evaluateQuota([{ source_key: "zero-empty", kind: "job", sample_count: 0, sparse_job_count: 0 }])
      .gaps,
    [{ source_key: "zero-empty", kind: "job", required: 1, actual: 0, missing: 1 }],
  );

  // 未提供 Count 的源不受稀疏规则影响，仍要求 5 份；Count≥5 同样按 5 份。
  assert.deepEqual(
    evaluateQuota([{ source_key: "no-count", kind: "job", sample_count: 0 }]).gaps,
    [{ source_key: "no-count", kind: "job", required: 5, actual: 0, missing: 5 }],
  );
  assert.equal(
    evaluateQuota([{ source_key: "count-5", kind: "job", sample_count: 5, sparse_job_count: 5 }])
      .ok,
    true,
  );
});

function minimalSample(body: string, overrides: Partial<ManifestSampleRef> = {}): ManifestSampleRef {
  const bodySha = sha256Hex(Buffer.from(body));
  return {
    sample_id: bodySha.slice(0, 16),
    request_key: `POST https://example.test/list|${bodySha.slice(0, 8)}`,
    request_url: "https://example.test/list",
    captured_at: "2026-01-01T00:00:00.000Z",
    extraction_ref: "list-1",
    body_file: "example/samples/list-1.json",
    body_sha256: bodySha,
    ...overrides,
  };
}

test("manifest 顶层 capture_notes 可选写入且必须是字符串数组", () => {
  const sources = [{ source_key: "example", kind: "job" as const, samples: [minimalSample("a")] }];
  const generatedAt = "2026-01-01T00:00:00.000Z";

  const withoutNotes = buildSampleManifest({ generatedAt, sources });
  assert.equal("capture_notes" in withoutNotes, false);
  assert.deepEqual(validateSampleManifest(withoutNotes).errors, []);

  const withNotes = buildSampleManifest({ generatedAt, sources }, [
    "note: example/samples/list-1.json: sanitized=true（redacted:email=1）",
    "gap: example: 缺 1 份",
  ]);
  assert.deepEqual(withNotes.capture_notes, [
    "note: example/samples/list-1.json: sanitized=true（redacted:email=1）",
    "gap: example: 缺 1 份",
  ]);
  assert.deepEqual(validateSampleManifest(withNotes).errors, []);

  const notArray = { ...withNotes, capture_notes: "gap: example" };
  assert.ok(
    validateSampleManifest(notArray).errors.some((error) => error.includes("capture_notes")),
  );

  const mixed = { ...withNotes, capture_notes: ["gap: example", 42] };
  assert.ok(
    validateSampleManifest(mixed).errors.some((error) => error.includes("capture_notes")),
  );
});

test("manifest 校验拒绝 request_key 全局重复与 sample_id 前缀不符", () => {
  const first = minimalSample("a");
  const second = minimalSample("b", { body_file: "example/samples/list-2.json" });
  const manifest = buildSampleManifest({
    generatedAt: "2026-01-01T00:00:00.000Z",
    sources: [
      { source_key: "a", kind: "job", samples: [first] },
      { source_key: "b", kind: "job", samples: [second] },
    ],
  });
  assert.deepEqual(validateSampleManifest(manifest).errors, []);

  const duplicatedKey = structuredClone(manifest) as unknown as {
    sources: { samples: { request_key: string }[] }[];
  };
  duplicatedKey.sources[1].samples[0].request_key = first.request_key;
  assert.ok(
    validateSampleManifest(duplicatedKey).errors.some((error) => error.includes("request_key")),
  );

  const badPrefix = structuredClone(manifest) as unknown as {
    sources: { samples: { sample_id: string }[] }[];
  };
  badPrefix.sources[0].samples[0].sample_id = "0000000000000000";
  assert.ok(
    validateSampleManifest(badPrefix).errors.some((error) => error.includes("sample_id")),
  );
});

test("createSample 的 content_type 统一为非空字符串，null 规范化为 application/octet-stream", () => {
  const base = {
    request_key: "GET https://example.test/list",
    request_url: "https://example.test/list",
    final_url: "https://example.test/list",
    http_status: 200,
    captured_at: "2026-01-01T00:00:00.000Z",
    collector_version: "collector/0.1.0",
    extraction_ref: "list-1",
    sanitized: false,
    body: Buffer.from("{}"),
    body_file: "example/samples/list-1.json",
  };

  const unknownType = createSample({ ...base, content_type: null });
  assert.equal(unknownType.meta.content_type, UNKNOWN_CONTENT_TYPE);

  const jsonType = createSample({ ...base, content_type: "application/json" });
  assert.equal(jsonType.meta.content_type, "application/json");
  assert.equal(jsonType.meta.sample_id, jsonType.meta.body_sha256.slice(0, 16));

  assert.throws(() => createSample({ ...base, content_type: "  " }), SampleRejectedError);
});
