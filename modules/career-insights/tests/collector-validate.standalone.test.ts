import assert from "node:assert/strict";
import { test } from "node:test";
import { validateRawCollectedJob } from "../collector/validate.ts";
import type { RawCollectedJobV1 } from "../contracts/index.ts";

function rawJob(overrides: Partial<RawCollectedJobV1> = {}): RawCollectedJobV1 {
  return {
    schema_version: "1.0",
    source_key: "alibaba-official-careers",
    source_job_id: "JOB-001",
    company_name: "阿里巴巴",
    title: "AI 应用后端开发工程师",
    official_url: "https://talent.alibaba.com/job/JOB-001",
    raw_text: "负责 AI 应用后端开发，熟悉 TypeScript 与 Python。",
    raw_payload: { id: "JOB-001" },
    published_at: "2026-11-10T00:00:00.000Z",
    fetched_at: "2026-11-17T08:00:00.000Z",
    collector_version: "0.1.0",
    hints: {
      role_family: "ai_application_development",
      locations: ["杭州"],
      degree_raw: null,
      experience_raw: "1-3 年",
      employment_type: "experienced",
      skill_terms: ["typescript", "python"],
    },
    ...overrides,
  };
}

test("合法原始职位记录通过校验", () => {
  const result = validateRawCollectedJob(rawJob());
  assert.equal(result.ok, true);
});

test("允许未知值保持 null、unknown 与空数组", () => {
  const result = validateRawCollectedJob(
    rawJob({
      source_job_id: null,
      published_at: null,
      hints: {
        role_family: "unknown",
        locations: [],
        degree_raw: null,
        experience_raw: null,
        employment_type: "unknown",
        skill_terms: [],
      },
    }),
  );
  assert.equal(result.ok, true);
});

test("必填原文缺失时拒绝", () => {
  for (const field of ["source_key", "company_name", "title", "raw_text", "collector_version"] as const) {
    const result = validateRawCollectedJob(rawJob({ [field]: "  " } as Partial<RawCollectedJobV1>));
    assert.equal(result.ok, false, `${field} 为空时应失败`);
  }
});

test("official_url 必须是公开 http(s) 链接", () => {
  const result = validateRawCollectedJob(rawJob({ official_url: "/jobs/1" }));
  assert.equal(result.ok, false);
});

test("published_at 不得晚于 fetched_at，且两者都必须为 UTC ISO", () => {
  assert.equal(
    validateRawCollectedJob(rawJob({ published_at: "2026-11-18T00:00:00.000Z" })).ok,
    false,
  );
  assert.equal(validateRawCollectedJob(rawJob({ published_at: "2026-11-10" })).ok, false);
  assert.equal(
    validateRawCollectedJob(rawJob({ fetched_at: "2026-11-17T08:00:00+08:00" })).ok,
    false,
  );
});

test("原始正文含个人联系方式时拒绝收录", () => {
  assert.equal(validateRawCollectedJob(rawJob({ raw_text: "投递邮箱 hr@example.com" })).ok, false);
  assert.equal(validateRawCollectedJob(rawJob({ raw_text: "联系电话 13800138000" })).ok, false);
  assert.equal(validateRawCollectedJob(rawJob({ raw_text: "联系人：张三" })).ok, false);
});

test("hints 不允许出现契约外的派生字段", () => {
  const result = validateRawCollectedJob(
    rawJob({ hints: { role_family: "unknown", skill_terms: [], normalized_title: "后端工程师" } as never }),
  );
  assert.equal(result.ok, false);
});

test("hints 枚举必须是契约取值", () => {
  assert.equal(validateRawCollectedJob(rawJob({ hints: { role_family: "backend" as never } })).ok, false);
  assert.equal(
    validateRawCollectedJob(rawJob({ hints: { employment_type: "full_time" as never } })).ok,
    false,
  );
});

test("非法记录返回全部问题而不是只报第一条", () => {
  const result = validateRawCollectedJob(rawJob({ title: "", official_url: "ftp://x", fetched_at: "y" }));
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(result.errors.length >= 3);
  }
});