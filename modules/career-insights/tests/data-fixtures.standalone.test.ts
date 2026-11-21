import assert from "node:assert/strict";
import { test } from "node:test";
import {
  SAMPLE_POLICIES,
  buildSyntheticSampleDataset,
  buildSyntheticSampleMetrics,
} from "../fixtures/sample.ts";

test("明确样例走真实归一化链路且全部合法", () => {
  const dataset = buildSyntheticSampleDataset();

  assert.equal(dataset.data_origin, "synthetic_fixture");
  assert.equal(dataset.raw_jobs.length, 6);
  assert.equal(dataset.rejected.length, 0);
  assert.equal(dataset.normalized_jobs.length, 6);
  assert.equal(dataset.metric_jobs.length, 6);
  assert.equal(dataset.policies.length, SAMPLE_POLICIES.length);

  for (const job of dataset.normalized_jobs) {
    assert.equal(job.schema_version, "1.0");
    assert.match(job.content_hash, /^[0-9a-f]{64}$/);
    assert.ok(job.skill_evidence.length <= job.skills.length);
  }
});

test("样例覆盖学生友好的 yes / no / unknown 三种状态", () => {
  const states = new Set(
    buildSyntheticSampleDataset().normalized_jobs.map((job) => job.student_friendly),
  );

  assert.ok(states.has("yes"));
  assert.ok(states.has("no"));
  assert.ok(states.has("unknown"));
});

test("样例覆盖未写经验，且没有被补成 0 年", () => {
  const dataset = buildSyntheticSampleDataset();
  const unstated = dataset.normalized_jobs.find((job) => job.title === "平台开发工程师");

  assert.ok(unstated);
  assert.equal(unstated.experience_min_years, null);
  assert.equal(unstated.experience_max_years, null);
  assert.equal(unstated.experience_raw, null);
  assert.equal(unstated.student_friendly, "unknown");
});

test("样例指标包含五项指标且观测新增来自两个真实快照", () => {
  const result = buildSyntheticSampleMetrics();
  const ids = new Set(result.metrics.map((metric) => metric.metric_id));

  assert.ok(ids.has("job_family_share"));
  assert.ok(ids.has("skill_demand_share"));
  assert.ok(ids.has("student_friendly_share"));
  assert.ok(ids.has("observed_new_jobs"));
  assert.ok(ids.has("policy_job_shared_themes"));

  const observed = result.metrics.find((metric) => metric.metric_id === "observed_new_jobs");
  assert.equal(observed?.status, "ok");
  assert.equal(observed?.value, 1);
});

test("样例政策与职位共享主题同时带两侧证据", () => {
  const result = buildSyntheticSampleMetrics();

  assert.ok(result.shared_themes.length >= 2);
  for (const theme of result.shared_themes) {
    assert.ok(theme.policy_count > 0);
    assert.ok(theme.job_count > 0);
    assert.ok(theme.policies.length > 0);
    assert.ok(theme.jobs.length > 0);
  }
});

test("样例数据明确标记为 synthetic_fixture", () => {
  const dataset = buildSyntheticSampleDataset();
  assert.equal(dataset.data_origin, "synthetic_fixture");
  for (const job of dataset.normalized_jobs) {
    assert.match(job.official_url, /^https:\/\/example\.com\//);
  }
});