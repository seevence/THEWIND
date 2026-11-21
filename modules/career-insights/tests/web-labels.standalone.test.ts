// web/labels.ts 的领域词必须与 data/dictionaries.ts 全量同步：旧缓存或新文本里出现任何内部 ID
// 都要能换成中文，漏一个就会在洞察页原样露出英文。standalone：不连数据库、不连 API。
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ROLE_FAMILY_LABELS as DICTIONARY_ROLE_FAMILY_LABELS,
  SKILL_LABELS as DICTIONARY_SKILL_LABELS,
} from "../data/dictionaries.ts";
import { localizeDomainTerms, ROLE_FAMILY_LABELS, SKILL_LABELS } from "../web/labels.ts";

test("the web skill dictionary matches data/dictionaries.ts exactly", () => {
  // 键集完全相等：一个不缺、一个不多；值也保持一致，避免同一 ID 在两处显示不同文案。
  assert.deepEqual(Object.keys(SKILL_LABELS).sort(), Object.keys(DICTIONARY_SKILL_LABELS).sort());
  assert.equal(Object.keys(SKILL_LABELS).length, 45);
  for (const [id, label] of Object.entries(DICTIONARY_SKILL_LABELS)) {
    assert.equal(SKILL_LABELS[id], label, `技能 ${id} 的展示名与词典不一致`);
  }
});

test("the web role family labels match data/dictionaries.ts exactly", () => {
  assert.deepEqual(ROLE_FAMILY_LABELS, DICTIONARY_ROLE_FAMILY_LABELS);
  assert.equal(ROLE_FAMILY_LABELS.unknown, "未归类");
});

test("localizeDomainTerms replaces every skill and role family id with Chinese", () => {
  for (const [id, label] of Object.entries(DICTIONARY_SKILL_LABELS)) {
    assert.equal(localizeDomainTerms(`技能 ${id} 出现`), `技能 ${label} 出现`, `技能 ${id} 未被中文化`);
    assert.equal(localizeDomainTerms(id), label, `技能 ${id} 单独出现时未被中文化`);
  }
  for (const [id, label] of Object.entries(DICTIONARY_ROLE_FAMILY_LABELS)) {
    assert.equal(localizeDomainTerms(`职族 ${id} 岗位`), `职族 ${label} 岗位`, `职族 ${id} 未被中文化`);
    assert.equal(localizeDomainTerms(id), label, `职族 ${id} 单独出现时未被中文化`);
  }
});

test("common English field names are localized too", () => {
  assert.equal(localizeDomainTerms("student_friendly=yes"), "学生友好=yes");
  assert.equal(localizeDomainTerms("job_count=6"), "岗位数=6");
  assert.equal(localizeDomainTerms("company_count=2"), "公司数=2");
  assert.equal(localizeDomainTerms("role_family=unknown"), "职族=未归类");
});
