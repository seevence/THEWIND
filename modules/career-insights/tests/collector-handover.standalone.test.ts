import assert from "node:assert/strict";
import { test } from "node:test";
import type { RawCollectedJobV1 } from "../contracts/index.ts";
import { validateRawCollectedJob } from "../collector/validate.ts";
import { normalizeRawJob } from "../data/normalize.ts";

function rawJob(overrides: Partial<RawCollectedJobV1> = {}): RawCollectedJobV1 {
  return {
    schema_version: "1.0",
    source_key: "alibaba-official-careers",
    source_job_id: "JOB-001",
    company_name: "阿里巴巴",
    title: "后端开发工程师",
    official_url: "https://talent.alibaba.com/job/JOB-001",
    raw_text: "负责服务端接口开发与联调。",
    fetched_at: "2026-11-18T08:00:00.000Z",
    published_at: null,
    collector_version: "collector/0.1.0",
    hints: {
      role_family: "unknown",
      locations: [],
      degree_raw: null,
      experience_raw: null,
      employment_type: "unknown",
      skill_terms: [],
    },
    ...overrides,
  };
}

const NORMALIZED_ONLY_KEYS: readonly string[] = [
  "job_key",
  "degree",
  "experience_min_years",
  "experience_max_years",
  "student_friendly",
  "skills",
  "skill_evidence",
  "content_hash",
];

test("校验通过的原始记录可直接交给 normalizeRawJob，不抛错", () => {
  const checked = validateRawCollectedJob(rawJob());
  assert.equal(checked.ok, true);
  if (!checked.ok) return;

  const normalized = normalizeRawJob(checked.value);
  assert.equal(normalized.source_key, "alibaba-official-careers");
  assert.equal(normalized.title, "后端开发工程师");
});

test("hints 缺省语义在下游保持为 unknown / null / 空数组", () => {
  const checked = validateRawCollectedJob(
    rawJob({
      hints: undefined,
    }),
  );
  assert.equal(checked.ok, true);
  if (!checked.ok) return;

  const normalized = normalizeRawJob(checked.value);
  assert.equal(normalized.degree, "unknown");
  assert.equal(normalized.experience_min_years, null);
  assert.equal(normalized.experience_max_years, null);
  assert.deepEqual(normalized.locations, []);
  assert.deepEqual(normalized.skills, []);
});

test("采集层产出不含任何归一化字段", () => {
  const raw = rawJob();
  const keys = Object.keys(raw);
  for (const key of NORMALIZED_ONLY_KEYS) {
    assert.ok(!keys.includes(key), `采集层不得产出 ${key}`);
  }
});

test("published_at 缺失在下游仍为 null，fetched_at 与 collector_version 原样透传", () => {
  const checked = validateRawCollectedJob(rawJob({ published_at: null }));
  assert.equal(checked.ok, true);
  if (!checked.ok) return;

  const normalized = normalizeRawJob(checked.value);
  assert.equal(normalized.published_at, null);
  assert.equal(normalized.fetched_at, "2026-11-18T08:00:00.000Z");
  assert.equal(normalized.collector_version, "collector/0.1.0");
  assert.equal(normalized.raw_text, "负责服务端接口开发与联调。");
});