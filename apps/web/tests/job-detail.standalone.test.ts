// 岗位详情页的官方入口（review I4）：zhiye 源的 official_url 是企业官方职位列表页，
// 不是单条职位详情，所以按钮文案必须写「查看官方职位列表」；同时以注册表为准全量核对中文名（review I1/S1），
// 新增来源只要登记进 CAREER_SOURCE_DEFINITIONS 就必须在本测试内被覆盖，不再逐轮手工追加断言。
import assert from "node:assert/strict";
import { test } from "node:test";
import { CAREER_SOURCE_DEFINITIONS } from "../../../modules/career-insights/collector/sources.ts";
import {
  CAREER_SOURCE_LABELS,
  OFFICIAL_JOB_LIST_LINK_LABEL,
  POLICY_SOURCE_OPTIONS,
  careerSourceLabel,
  policySourceLabel,
} from "../../../modules/career-insights/web/labels.ts";

test("the official entry on a job detail promises the job list, not that single posting", () => {
  assert.equal(OFFICIAL_JOB_LIST_LINK_LABEL, "查看官方职位列表");
  assert.ok(OFFICIAL_JOB_LIST_LINK_LABEL.includes("列表"));
});

test("every registered source has a Chinese label matching its definition", () => {
  for (const definition of CAREER_SOURCE_DEFINITIONS) {
    assert.equal(CAREER_SOURCE_LABELS[definition.source_key], definition.label, definition.source_key);
    assert.equal(careerSourceLabel(definition.source_key), definition.label, definition.source_key);
  }
  // 未登记的来源仍回落 source_key，不把猜测的名字端给读者。
  assert.equal(careerSourceLabel("unknown-source"), "unknown-source");
});

test("the policy filter offers every registered policy source with its Chinese label", () => {
  const policyKeys = CAREER_SOURCE_DEFINITIONS.filter((item) => item.kind === "government_policy").map(
    (item) => item.source_key,
  );
  assert.deepEqual(POLICY_SOURCE_OPTIONS.map((option) => option.value), policyKeys);
  for (const option of POLICY_SOURCE_OPTIONS) {
    assert.equal(policySourceLabel(option.value), option.label, option.value);
    assert.notEqual(policySourceLabel(option.value), option.value, option.value);
  }
});