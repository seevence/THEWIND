// The search overlay's "在岗位中搜索" row (phone search) links to the jobs page's own search. The overlay
// itself is phone-only and unreachable while the old 全部动态 section is retired, so the address it offers is
// kept as a plain function and tested without a browser: the same keyword, trimmed and encoded, on /career-insights/jobs.
import assert from "node:assert/strict";
import { test } from "node:test";
import { jobsSearchHref } from "../app/features/search/jobs-search.ts";

test("a typed query becomes the jobs page's search address", () => {
  assert.equal(jobsSearchHref("数据分析"), "/career-insights/jobs?q=%E6%95%B0%E6%8D%AE%E5%88%86%E6%9E%90");
  assert.equal(jobsSearchHref("  Data Analyst  "), "/career-insights/jobs?q=Data%20Analyst");
  // Encoding, not string concatenation: & and = in a keyword stay one query value.
  assert.equal(jobsSearchHref("a&b=c"), "/career-insights/jobs?q=a%26b%3Dc");
  assert.equal(jobsSearchHref("岗位 搜索"), "/career-insights/jobs?q=%E5%B2%97%E4%BD%8D%20%E6%90%9C%E7%B4%A2");
});

test("a blank query offers no jobs search", () => {
  assert.equal(jobsSearchHref(""), null);
  assert.equal(jobsSearchHref("   "), null);
});
