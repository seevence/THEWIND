// 岗位详情页的官方入口（review I4）：zhiye 源的 official_url 是企业官方职位列表页，
// 不是单条职位详情，所以按钮文案必须写「查看官方职位列表」；同时确认 12 个新源都有中文名。
import assert from "node:assert/strict";
import { test } from "node:test";
import { CAREER_SOURCE_LABELS, OFFICIAL_JOB_LIST_LINK_LABEL, careerSourceLabel } from "../../../modules/career-insights/web/labels.ts";

test("the official entry on a job detail promises the job list, not that single posting", () => {
  assert.equal(OFFICIAL_JOB_LIST_LINK_LABEL, "查看官方职位列表");
  assert.ok(OFFICIAL_JOB_LIST_LINK_LABEL.includes("列表"));
});

test("every source added in this release has a Chinese label", () => {
  const expected: ReadonlyArray<readonly [string, string]> = [
    ["iflytek-official-careers", "科大讯飞官方招聘"],
    ["dahua-official-careers", "大华股份官方招聘"],
    ["inovance-official-careers", "汇川技术官方招聘"],
    ["sunwoda-official-careers", "欣旺达官方招聘"],
    ["boe-official-careers", "京东方官方招聘"],
    ["sugon-official-careers", "中科曙光官方招聘"],
    ["h3c-official-careers", "新华三官方招聘"],
    ["mindray-official-careers", "迈瑞医疗官方招聘"],
    ["united-imaging-official-careers", "联影医疗官方招聘"],
    ["invt-official-careers", "英威腾官方招聘"],
    ["sany-official-careers", "三一重工官方招聘"],
    ["hunan-rsj-policy", "湖南省人力资源和社会保障厅通知公告"],
  ];
  for (const [sourceKey, label] of expected) {
    assert.equal(careerSourceLabel(sourceKey), label, sourceKey);
    assert.equal(CAREER_SOURCE_LABELS[sourceKey], label, sourceKey);
  }
  // 未登记的来源仍回落 source_key，不把猜测的名字端给读者。
  assert.equal(careerSourceLabel("unknown-source"), "unknown-source");
});