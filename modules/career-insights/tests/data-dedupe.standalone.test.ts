import assert from "node:assert/strict";
import { test } from "node:test";
import {
  canonicalizeJobUrl,
  computeContentHash,
  computeJobKey,
  dedupeNormalizedJobs,
  groupNearDuplicateJobs,
  type ContentHashInputV1,
} from "../data/dedupe.ts";

function contentHashInput(overrides: Partial<ContentHashInputV1> = {}): ContentHashInputV1 {
  return {
    schema_version: "1.0",
    source_key: "alibaba-official-careers",
    job_key: "job-001",
    company_name: "示例公司",
    title: "AI 应用后端开发工程师",
    locations: ["深圳"],
    degree_raw: "本科及以上",
    experience_raw: "1-3 年经验",
    raw_text: "负责 AI 应用后端开发。",
    ...overrides,
  };
}

test("job_key 优先使用官方职位 ID，没有时使用规范化 URL 的 SHA-256", () => {
  assert.equal(
    computeJobKey({ source_job_id: "JOB-001", official_url: "https://careers.example/jobs/1" }),
    "JOB-001",
  );

  const first = computeJobKey({
    source_job_id: null,
    official_url: "https://Careers.Example/jobs/1/?utm_source=newsletter#apply",
  });
  const second = computeJobKey({ source_job_id: null, official_url: "https://careers.example/jobs/1" });

  assert.match(first, /^[0-9a-f]{64}$/);
  assert.equal(first, second);
});

test("URL 规范化只移除明确的跟踪参数和片段", () => {
  assert.equal(
    canonicalizeJobUrl("https://careers.example/jobs/1/?utm_source=newsletter&spm=abc&jobId=42#top"),
    "https://careers.example/jobs/1?jobId=42",
  );
  assert.equal(canonicalizeJobUrl("https://careers.example/jobs/1/"), "https://careers.example/jobs/1");
  assert.equal(
    canonicalizeJobUrl("https://careers.example/jobs/2?jobId=42"),
    "https://careers.example/jobs/2?jobId=42",
    "影响职位身份的参数必须保留",
  );
});

test("内容哈希只覆盖来源内容，不受派生字段与归一化版本影响", () => {
  const base = contentHashInput();
  const reordered = contentHashInput({
    locations: ["深圳", "北京"],
    raw_text: "  负责   AI 应用后端开发。 ",
  });
  const sameLocations = contentHashInput({ locations: ["北京", "深圳"] });
  assert.equal(computeContentHash(reordered), computeContentHash(sameLocations));

  const changed = contentHashInput({ title: "AI 算法工程师" });
  assert.notEqual(computeContentHash(base), computeContentHash(changed));

  // 解析后的学历枚举、经验年数、技能、职族与 normalizer_version 都不在哈希输入类型内；
  // 原始 degree_raw / experience_raw 文本属于源内容，仍参与哈希。
  assert.notEqual(
    computeContentHash(base),
    computeContentHash(contentHashInput({ experience_raw: "三年以上" })),
  );
});

test("同一来源同一 job_key 只保留首条，跨来源不互相去重", () => {
  const jobs = [
    { source_key: "alibaba-official-careers", job_key: "job-001", title: "first" },
    { source_key: "alibaba-official-careers", job_key: "job-001", title: "duplicate" },
    { source_key: "tencent-official-careers", job_key: "job-001", title: "other source" },
  ];

  const result = dedupeNormalizedJobs(jobs);

  assert.equal(result.unique.length, 2);
  assert.equal(result.duplicates.length, 1);
  assert.equal(result.duplicates[0]?.title, "duplicate");
});

test("跨来源近重复只分组提示，不自动合并", () => {
  const groups = groupNearDuplicateJobs([
    {
      source_key: "alibaba-official-careers",
      job_key: "1",
      company_name: "腾讯",
      title: "AI 应用后端开发工程师",
      locations: ["深圳"],
      official_url: "https://a.example/1",
    },
    {
      source_key: "tencent-official-careers",
      job_key: "2",
      company_name: "腾讯",
      title: "AI 应用后端开发工程师",
      locations: ["深圳"],
      official_url: "https://b.example/2",
    },
    {
      source_key: "bytedance-official-careers",
      job_key: "3",
      company_name: "字节跳动",
      title: "数据分析师",
      locations: ["北京"],
      official_url: "https://c.example/3",
    },
  ]);

  assert.equal(groups.length, 1);
  assert.equal(groups[0]?.jobs.length, 2);
});