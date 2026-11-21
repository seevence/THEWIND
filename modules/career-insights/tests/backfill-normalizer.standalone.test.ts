import assert from "node:assert/strict";
import { test } from "node:test";
import { NORMALIZER_VERSION } from "../../career-insights/data/normalize.ts";
import {
  planRows,
  rebuildRaw,
  signature,
  type DerivedFields,
  type JobRow,
} from "../../../scripts/backfill-normalizer.ts";

function job(overrides: Partial<JobRow> = {}): JobRow {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    source_key: "baidu",
    company_name: "示例公司",
    title: "机器学习算法工程师",
    official_url: "https://example.test/job/1",
    data_origin: "live",
    normalizer_version: "normalizer/0.1.0",
    role_family: "unknown",
    degree: "unknown",
    employment_type: "unknown",
    student_friendly: "unknown",
    experience_min_years: null,
    experience_max_years: null,
    degree_raw: "本科",
    experience_raw: "3-5年",
    locations: ["北京"],
    skills: [],
    skill_evidence: [],
    raw_text: "负责推荐算法研发，熟悉 Python。",
    raw_payload: null,
    published_at: "2026-11-01T00:00:00.000Z",
    fetched_at: new Date("2026-11-01T00:00:00.000Z"),
    collector_version: "baidu/1.0.0",
    ...overrides,
  };
}

function derived(overrides: Partial<DerivedFields> = {}): DerivedFields {
  return {
    role_family: "ai_algorithm",
    degree: "bachelor",
    employment_type: "experienced",
    student_friendly: "no",
    experience_min_years: 3,
    experience_max_years: 5,
    skills: ["python", "sql"],
    skill_evidence: [
      { skill_id: "python", evidence_text: "熟悉 Python" },
      { skill_id: "sql", evidence_text: "熟悉 SQL" },
    ],
    normalizer_version: NORMALIZER_VERSION,
    ...overrides,
  };
}

test("signature 对 skills / skill_evidence 的顺序与重复不敏感", () => {
  const reference = signature(derived());
  const reordered = derived({
    skills: ["sql", "python", "python"],
    skill_evidence: [
      { skill_id: "sql", evidence_text: "熟悉 SQL" },
      { skill_id: "python", evidence_text: "熟悉 Python" },
      { skill_id: "python", evidence_text: "熟悉 Python" },
    ],
  });
  assert.equal(signature(reordered), reference);
  assert.notEqual(signature(derived({ role_family: "data" })), reference);
});

test("rebuildRaw 优先取 raw_payload 里的采集原始 hints", () => {
  const rebuilt = rebuildRaw(
    job({
      raw_payload: {
        education: "硕士",
        workYears: "5-8年",
        jobFamily: "ai_application_development",
        locations: ["上海"],
        skillTerms: ["PyTorch"],
      },
    }),
  );
  assert.equal(rebuilt.hasPayload, true);
  assert.equal(rebuilt.raw.hints.degree_raw, "硕士");
  assert.equal(rebuilt.raw.hints.experience_raw, "5-8年");
  assert.equal(rebuilt.raw.hints.role_family, "ai_application_development");
  assert.deepEqual(rebuilt.raw.hints.locations, ["上海"]);
  assert.deepEqual(rebuilt.raw.hints.skill_terms, ["PyTorch"]);
  assert.deepEqual(rebuilt.fromPayload.sort(), [
    "degree_raw",
    "experience_raw",
    "locations",
    "role_family",
    "skill_terms",
  ]);
});

test("rebuildRaw 在 raw_payload 缺字段时回退 DB 列，非法 role_family 被忽略", () => {
  const rebuilt = rebuildRaw(job({ raw_payload: { jobFamily: "研发" } }));
  assert.equal(rebuilt.raw.hints.degree_raw, "本科");
  assert.equal(rebuilt.raw.hints.experience_raw, "3-5年");
  assert.deepEqual(rebuilt.raw.hints.locations, ["北京"]);
  assert.equal(rebuilt.raw.hints.role_family, undefined);
  assert.deepEqual(rebuilt.fromPayload, []);
});

test("planRows 幂等：写入后的派生值再跑一次不再产生待变更行", () => {
  const first = planRows([job()]);
  assert.equal(first.planned.length, 1);
  const after = first.planned[0]?.after;
  assert.ok(after !== undefined);

  const second = planRows([job({ ...after })]);
  assert.equal(second.planned.length, 0);
  assert.equal(second.unchanged, 1);
});

test("planRows 统计 raw_payload hints 覆盖率", () => {
  const withHints = planRows([job({ raw_payload: { education: "本科" } })]);
  assert.equal(withHints.hints.withPayload, 1);
  assert.equal(withHints.hints.payloadUsed, 1);
  assert.equal(withHints.hints.degreeRaw, 1);

  const withoutHints = planRows([job({ raw_payload: { id: 42 } })]);
  assert.equal(withoutHints.hints.withPayload, 1);
  assert.equal(withoutHints.hints.payloadUsed, 0);
});