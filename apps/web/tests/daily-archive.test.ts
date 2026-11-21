// /daily/archive 现在是真的往期目录：loader 读 GET /api/site/career-insights/daily/history，列出日期、
// 摘要、当日统计并链接到 /daily?date=；没有往期（或接口读不到）时保留「筹备中」空态。
// /daily?date= 是历史期视图，只展示那天缓存的 AI 评论。Production SSR + 合成 HTTP api，不访问外部服务。
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ServerResponse } from "node:http";
import * as cheerio from "cheerio";
import type { CareerDailyHistoryResponseV1 } from "../../../modules/career-insights/contracts/history.ts";
import {
  careerDailyCommentFixture,
  careerDailyHistoryEntry,
  careerDailyHistoryFixture,
  fakeApi,
  startWebServer,
} from "./web-server.ts";

type Route = (url: URL, res: ServerResponse) => unknown;

/** The built site in front of the synthetic api; hits records the career reads the loader made. */
async function read(path: string, route: Route = () => undefined): Promise<{ status: number; html: string; hits: string[]; $: cheerio.CheerioAPI }> {
  const hits: string[] = [];
  const api = fakeApi((url, res) => {
    if (url.pathname.startsWith("/api/site/career-insights/")) hits.push(url.pathname + url.search);
    return route(url, res);
  });
  const web = await startWebServer(api);
  try {
    const response = await fetch(web.origin + path);
    const html = await response.text();
    return { status: response.status, html, hits, $: cheerio.load(html) };
  } finally {
    await web.stop();
  }
}

/** The archive answer a route gives for /daily/history. */
function historyRoute(history: CareerDailyHistoryResponseV1): Route {
  return (url) => (url.pathname === "/api/site/career-insights/daily/history" ? history : undefined);
}

const HISTORY_PATH = "/api/site/career-insights/daily/history";

const TWO_DAYS = careerDailyHistoryFixture({
  total: 2,
  entries: [
    careerDailyHistoryEntry({
      date: "2026-11-21",
      sample_size: 60,
      new_jobs: 34,
      new_policies: 2,
      confidence: "low",
      comment_summary: "今日新增岗位 34 个，方向榜以 AI 应用开发为主。",
    }),
    careerDailyHistoryEntry({
      date: "2026-11-20",
      sample_size: 60,
      new_jobs: 25,
      new_policies: 1,
      confidence: null,
      comment_summary: null,
    }),
  ],
});

test("the archive lists each archived day with its summary, counts and that day's link", async () => {
  const { status, $, hits } = await read("/daily/archive", historyRoute(TWO_DAYS));

  assert.equal(status, 200);
  assert.equal($("meta[name=robots]").attr("content"), "noindex, follow");
  assert.ok($("link[rel=canonical]").attr("href")!.endsWith("/daily/archive"));
  assert.doesNotMatch($("body").text(), /筹备中/, "with history there is no placeholder copy");

  const rows = $("[data-daily-archive-date]");
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((_, row) => $(row).attr("data-daily-archive-date")).get(), ["2026-11-21", "2026-11-20"]);
  const newest = rows.first();
  assert.equal(newest.find("time").attr("datetime"), "2026-11-21");
  assert.match(newest.text(), /今日新增岗位 34 个/);
  assert.match(newest.text(), /当日观测样本 60 个岗位/);
  assert.match(newest.text(), /新增政策 2/);
  assert.match(newest.text(), /低置信/);
  assert.ok(newest.find('a[href="/daily?date=2026-11-21"]').length > 0, "the row opens that day's report view");
  // A day whose comment was never generated still lists, without a summary or confidence.
  const older = rows.eq(1);
  assert.match(older.text(), /没有 AI 评论缓存/);
  assert.equal(older.find("[data-daily-archive-summary]").length, 0);
  assert.ok(older.find('a[href="/daily?date=2026-11-20"]').length > 0);
  // The loader asked for one page of the default size.
  assert.deepEqual(hits, [`${HISTORY_PATH}?page=1&page_size=20`]);
});

test("no archived day, or a failed archive read, keeps the being-prepared placeholder at 200", async () => {
  const empty = await read("/daily/archive");
  assert.equal(empty.status, 200);
  assert.match(empty.$("title").text(), /合订本筹备中/);
  assert.match(empty.$("body").text(), /正在筹备/);
  assert.equal(empty.$("meta[name=robots]").attr("content"), "noindex, follow");
  assert.ok(empty.$('a[href="/daily"]').length > 0);
  assert.ok(empty.$('a[href="/career-insights"]').length > 0);

  const failed = await read("/daily/archive", (url, res) => {
    if (url.pathname !== HISTORY_PATH) return undefined;
    res.statusCode = 500;
    return { error: { code: "internal_error", message: "fixture" } };
  });
  assert.equal(failed.status, 200, "a failed archive read does not fail the page");
  assert.match(failed.$("body").text(), /正在筹备/);
});

test("pagination asks the api for the requested page and links the neighbours", async () => {
  const pageTwo = careerDailyHistoryFixture({
    page: 2,
    total: 45,
    entries: [careerDailyHistoryEntry({ date: "2026-11-02", comment_summary: "第二页的一期。" })],
  });
  const { status, $, hits } = await read("/daily/archive?page=2", historyRoute(pageTwo));
  assert.equal(status, 200);
  assert.ok(hits.includes(`${HISTORY_PATH}?page=2&page_size=20`));
  assert.ok($('a[href="/daily/archive?page=1"]').length > 0, "previous page");
  assert.ok($('a[href="/daily/archive?page=3"]').length > 0, "next page");
  assert.match($('[aria-label="往期分页"]').text(), /第 2 \/ 3 页/);
  assert.match($('[aria-label="往期分页"]').text(), /共 45 期/);
});

test("/daily?date= shows that day's cached comment as a history view, not today's report", async () => {
  const date = "2026-11-20";
  const comment = careerDailyCommentFixture({
    date,
    as_of: "2026-11-20T02:00:00.000Z",
    generated_at: "2026-11-20T03:00:00.000Z",
    sample_size: 60,
    new_jobs: 25,
    confidence: "medium",
    comment: `${date} 当日有观测的岗位 60 个，算法方向仍是主要需求。`,
  });
  const { status, html, hits, $ } = await read(`/daily?date=${date}`, (url) => (url.pathname === "/api/site/career-insights/daily-comment" ? comment : undefined));

  assert.equal(status, 200);
  const body = html.replace(/<!--[\s\S]*?-->/g, "");
  assert.match(body, /data-career-daily-history/);
  assert.match(body, new RegExp(`data-daily-history-date="${date}"`));
  assert.match(body, /当日有观测的岗位 60 个/);
  assert.match(body, new RegExp(`data-daily-comment-date="${date}"`));
  assert.doesNotMatch(body, /data-career-daily=""/, "today's figures are not shown for a history day");
  assert.doesNotMatch(body, /各来源采集结果/);
  assert.ok($('a[href="/daily/archive"]').length > 0, "a way back to the archive");
  assert.equal($("meta[name=robots]").attr("content"), "noindex, follow");
  // Only that day's comment is read; today's daily summary is not.
  assert.deepEqual(hits, [`/api/site/career-insights/daily-comment?date=${date}`]);
});

test("/daily?date= without a cached comment says so and keeps the page at 200", async () => {
  const { status, $ } = await read("/daily?date=2026-11-20", (url, res) => {
    if (url.pathname !== "/api/site/career-insights/daily-comment") return undefined;
    res.statusCode = 204;
    res.end();
    return undefined;
  });
  assert.equal(status, 200);
  assert.equal($("[data-daily-history-empty]").length, 1);
  assert.ok($('a[href="/daily/archive"]').length > 0);
});

test("a malformed ?date= falls back to today's report", async () => {
  const { status, hits, $ } = await read("/daily?date=not-a-date");
  assert.equal(status, 200);
  assert.equal($("[data-career-daily-history]").length, 0, "a malformed date is not shown as a history day");
  assert.equal($("[data-career-daily]").length, 1, "it falls back to today's report");
  assert.match($("body").text(), /各来源采集结果/);
  assert.deepEqual(hits.sort(), ["/api/site/career-insights/daily", "/api/site/career-insights/daily-comment"]);
});
