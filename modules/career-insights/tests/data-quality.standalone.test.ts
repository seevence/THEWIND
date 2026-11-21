import assert from "node:assert/strict";
import { test } from "node:test";
import { buildSyntheticSampleDataset } from "../fixtures/sample.ts";
import { inspectMetricSample } from "../data/quality.ts";
import type { QualityJobInputV1 } from "../data/quality.ts";

const AS_OF = "2026-11-16T12:05:00.000Z";

test("样本抽查统计字段覆盖率与未知比例", () => {
  const dataset = buildSyntheticSampleDataset();
  const report = inspectMetricSample(dataset.metric_jobs, { as_of: AS_OF });

  assert.equal(report.sample_size, 6);
  assert.equal(report.company_count, 3);
  assert.equal(report.source_count, 3);

  const roleFamily = report.field_coverage.find((item) => item.field === "role_family");
  assert.equal(roleFamily?.known, 5);
  assert.equal(roleFamily?.unknown, 1);
  assert.equal(roleFamily?.known_ratio, 5 / 6);

  const studentFriendly = report.field_coverage.find((item) => item.field === "student_friendly");
  assert.equal(studentFriendly?.known, 4);
  assert.equal(studentFriendly?.unknown, 2);
  assert.equal(studentFriendly?.known_ratio, 4 / 6);

  const experience = report.field_coverage.find((item) => item.field === "experience");
  assert.equal(experience?.known, 4);
  assert.equal(experience?.unknown, 2);

  const degree = report.field_coverage.find((item) => item.field === "degree");
  assert.equal(degree?.known, 5);
  assert.equal(degree?.unknown, 1);
});

test("样本抽查统计技能识别覆盖与高频技能", () => {
  const dataset = buildSyntheticSampleDataset();
  const report = inspectMetricSample(dataset.metric_jobs, { as_of: AS_OF });

  assert.equal(report.skill_coverage.jobs_with_skills, 5);
  assert.equal(report.skill_coverage.jobs_without_skills, 1);
  assert.equal(report.skill_coverage.recognized_skill_ratio, 5 / 6);
  assert.ok(report.skill_coverage.distinct_skills >= 10);
  assert.equal(report.skill_coverage.top_skills.length, 10);
  assert.equal(report.skill_coverage.top_skills[0]?.job_count, 4, "Python 出现在 4 条职位中");
});

test("样本抽查输出去重摘要与样本限制", () => {
  const dataset = buildSyntheticSampleDataset();
  const report = inspectMetricSample(dataset.metric_jobs, {
    as_of: AS_OF,
    input_count: 8,
    duplicate_count: 2,
  });

  assert.equal(report.dedupe.input_count, 8);
  assert.equal(report.dedupe.unique_count, 6);
  assert.equal(report.dedupe.duplicate_count, 2);

  assert.ok(report.limitations.some((item) => item.includes("样本量仅 6 条")));
  assert.ok(report.limitations.some((item) => item.includes("职族未归类")));
  assert.ok(report.limitations.some((item) => item.includes("unknown 不表示不友好")));
  assert.ok(report.limitations.some((item) => item.includes("未识别技能")));
  assert.ok(report.limitations.some((item) => item.includes("2 条重复记录")));
});

test("空样本不会产生 NaN 比例", () => {
  const report = inspectMetricSample([], { as_of: AS_OF });

  assert.equal(report.sample_size, 0);
  assert.equal(report.skill_coverage.recognized_skill_ratio, null);
  for (const item of report.field_coverage) {
    assert.equal(item.known_ratio, null);
    assert.equal(item.total, 0);
  }
});

test("未提供 input_count 时按样本数计算去重摘要", () => {
  const dataset = buildSyntheticSampleDataset();
  const report = inspectMetricSample(dataset.metric_jobs, { as_of: AS_OF });

  assert.equal(report.dedupe.input_count, 6);
  assert.equal(report.dedupe.unique_count, 6);
  assert.equal(report.dedupe.duplicate_count, 0);
});

test("去重摘要不会出现 input_count 小于样本数", () => {
  const dataset = buildSyntheticSampleDataset();
  const report = inspectMetricSample(dataset.metric_jobs, {
    as_of: AS_OF,
    input_count: 2,
    duplicate_count: 0,
  });

  assert.equal(report.dedupe.input_count, 6);
  assert.equal(report.dedupe.unique_count, 6);
});

test("QualityJobInputV1 使用扩展经验字段而非 MetricJobInputV1 缺失字段", () => {
  const dataset = buildSyntheticSampleDataset();
  const job: QualityJobInputV1 | undefined = dataset.metric_jobs[0];
  assert.ok(job);
  assert.ok("experience_min_years" in job);
  assert.ok("experience_max_years" in job);
  assert.ok("experience_raw" in job);
});