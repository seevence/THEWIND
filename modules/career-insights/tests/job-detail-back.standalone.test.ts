// 职位详情「返回职位列表」（P1）：列表传给详情的 back 是岗位目录 URL（带筛选时是一串 query），
// 详情 loader 用 safeBackHref 校验后原样回填。这里覆盖「带筛选的目录 URL 通过」与「其它 origin/路径仍回退」。
import assert from "node:assert/strict";
import { test } from "node:test";
import type { JobFiltersV1 } from "../contracts/index.ts";
import { buildJobHref, safeBackHref, serializeJobFilters } from "../web/filters.ts";

const catalogUrl = (filters: Partial<JobFiltersV1>): string => `/career-insights/jobs?${serializeJobFilters(filters)}`;

test("the job detail's back link returns to the filtered catalog it was opened from", () => {
  const back = catalogUrl({ city: "北京", q: "数据分析", page: 2, page_size: 20 });
  // 与详情页 loader 同一条链路：列表页生成 back → buildJobHref 编码进详情链接 → 读回后交给 safeBackHref。
  const detailHref = buildJobHref("job-1", back);
  assert.equal(safeBackHref(new URL(detailHref, "http://localhost").searchParams.get("back")), back);
  assert.equal(safeBackHref("/career-insights/jobs"), "/career-insights/jobs");
  assert.equal(safeBackHref(catalogUrl({ page: 1, page_size: 20 })), "/career-insights/jobs?page=1&page_size=20");

  // 洞察页（含方向视图）仍是合法回退目标；直接打开详情页时回默认的洞察页。
  const directionHref = "/career-insights?view=direction&role_family=data&page=1&page_size=20";
  assert.equal(safeBackHref(directionHref), directionHref);
  assert.equal(safeBackHref(null), "/career-insights");
});

test("foreign origins and other paths still fall back to the overview", () => {
  for (const foreign of [
    "//evil.example/career-insights/jobs",
    "https://evil.example/career-insights/jobs",
    "/career-insights/policies",
    "/career-insights/jobs/job-1",
    "/career-insights/jobs/../policies",
    "career-insights/jobs?page=1",
  ]) {
    assert.equal(safeBackHref(foreign), "/career-insights", foreign);
  }
});
