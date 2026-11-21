// The /daily page renders the cached AI daily comment; no cache (204) or a failed read hides the whole
// block, leaving the page at 200 with its other blocks. Run after `npm run build -w @aihot/web`.
// Real production server/router, synthetic HTTP API only; the page only reads the cache (no model calls).
import assert from "node:assert/strict";
import { test } from "node:test";
import { careerApi, fakeApi, startWebServer, type CareerApiOverrides } from "./web-server.ts";

/** The built /daily page in front of the synthetic api; `hits` records the career reads the loader made. */
async function dailyPage(overrides: CareerApiOverrides, hits: string[] = []): Promise<{ status: number; html: string }> {
  const api = fakeApi((url, res) => {
    if (url.pathname.startsWith("/api/site/career-insights/")) hits.push(url.pathname + url.search);
    return careerApi(url, res, overrides);
  });
  const web = await startWebServer(api);
  try {
    const response = await fetch(`${web.origin}/daily`);
    return { status: response.status, html: await response.text() };
  } finally {
    await web.stop();
  }
}

test("the daily page renders the cached AI comment with its numbers and confidence", async () => {
  const hits: string[] = [];
  const { status, html } = await dailyPage({}, hits);
  assert.equal(status, 200);
  // Adjacent JSX text nodes are split by comment markers in SSR; the rendered sentence still reads whole.
  const rendered = html.replace(/<!--[\s\S]*?-->/g, "");

  assert.match(rendered, /data-daily-comment=""/);
  assert.match(rendered, /data-daily-comment-date="2026-10-15"/);
  assert.match(rendered, /data-daily-comment-confidence="medium"/);
  assert.match(rendered, /AI 评论/);
  assert.match(rendered, /今日新增岗位集中在 AI 应用开发方向/);
  assert.match(
    rendered,
    /生成于 2026年10月4日 16:00 · 中置信 · 当日观测样本 12 个岗位 · 今日新增 3/,
    "the metadata line reads the cache's generated_at in Beijing time, the shared confidence label and its counts",
  );
  // Assert the body order structurally: <head>'s meta description also names the source results.
  const body = rendered.slice(rendered.indexOf("<body"));
  const figuresAt = body.indexOf('id="career-daily-figures"');
  const commentAt = body.indexOf('data-daily-comment=""');
  const sourcesAt = body.indexOf('id="career-daily-sources"');
  assert.ok(figuresAt >= 0 && figuresAt < commentAt, "the comment follows the day's figures");
  assert.ok(commentAt < sourcesAt, "the source results sit at the bottom");
  // The comment joins the daily read in the same loader, once each; nothing else is read for this page.
  assert.deepEqual(
    hits.sort(),
    ["/api/site/career-insights/daily", "/api/site/career-insights/daily-comment"],
  );
});

test("a 204 hides the AI comment block instead of leaving an empty card", async () => {
  const { status, html } = await dailyPage({ dailyComment: "missing" });
  assert.equal(status, 200, "no cached comment is not a page error");
  assert.doesNotMatch(html, /data-daily-comment/, "the block renders nothing without a cache");
  assert.doesNotMatch(html.replace(/<!--[\s\S]*?-->/g, ""), /AI 评论/);
  assert.doesNotMatch(html, /data-daily-comment-meta/);
  // The rest of the report is unchanged.
  assert.match(html, /data-career-daily=""/);
  assert.match(html, /各来源采集结果/);
  assert.match(html, /今日概况/);
});

test("a failed comment read hides the block and keeps the page at 200", async () => {
  const { status, html } = await dailyPage({ dailyComment: "error" });
  assert.equal(status, 200, "one failed block does not fail the page");
  assert.doesNotMatch(html, /data-daily-comment/);
  assert.doesNotMatch(html.replace(/<!--[\s\S]*?-->/g, ""), /AI 评论/);
  assert.match(html, /data-career-daily=""/);
  assert.match(html, /data-daily-source/);
  assert.match(html, /今日概况/);
});
