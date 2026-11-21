// 就业热点三个只读接口的前端接入，standalone：loader 的地址与参数、信号卡、热度榜空态、
// 日报无采集文案都在这里断言，不连数据库，也不需要 Web 进程。
// 路由文件是 JSX，Node 不能直接执行；可测的渲染与口径都在 modules/career-insights/web/ 的 .ts 里，
// 由路由与这里共用同一份实现。
import assert from "node:assert/strict";
import { once } from "node:events";
import { after, test } from "node:test";
import * as cheerio from "cheerio";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import type { CareerDailyCommentResponseV1, CareerDailyResponseV1, CareerHotEntryV1, CareerSignalV1 } from "../contracts/index.ts";
import { FIXTURE_DAILY_V1, FIXTURE_HOT_V1, FIXTURE_SIGNALS_V1 } from "../fixtures/api.ts";
import { CareerSignalItems } from "../web/components/CareerSignals.ts";
import { CareerHotList } from "../web/components/CareerHotList.ts";
import { CareerDailyReport } from "../web/components/CareerDailyReport.ts";

const FIXTURE_PORT = 3102;
process.env.CAREER_FIXTURE_PORT = String(FIXTURE_PORT);
process.env.API_BASE_URL = `http://127.0.0.1:${FIXTURE_PORT}`;

const { fixtureServer, feedRequests } = await import("../web/fixture-server.ts");
const { loadCareerDaily, loadCareerHot, loadCareerSignals } = await import("../web/feeds.server.ts");

if (!fixtureServer.listening) await once(fixtureServer, "listening");
after(() => new Promise<void>((resolve) => {
  fixtureServer.closeAllConnections();
  fixtureServer.close(() => resolve());
}));

function render(page: ReturnType<typeof createElement>): cheerio.CheerioAPI {
  return cheerio.load(renderToStaticMarkup(createElement(MemoryRouter, { initialEntries: ["/"] }, page)));
}

test("the three loaders ask the feed API with their own parameters", async () => {
  feedRequests.length = 0;
  const signals = await loadCareerSignals();
  const hot = await loadCareerHot();
  const daily = await loadCareerDaily();

  assert.deepEqual(
    feedRequests.map((request) => [request.pathname, request.params.toString()]),
    [
      ["/api/site/career-insights/signals", "limit=5"],
      ["/api/site/career-insights/hot", "limit=10"],
      ["/api/site/career-insights/daily", ""],
    ],
  );
  assert.equal(signals.signals.length, 3);
  assert.equal(hot.entries.length, 2);
  assert.equal(hot.window_days, 30);
  assert.equal(daily.has_run, true);
});

test("the signal card renders rule, company, title and the backend's reason with a job link", () => {
  const html = render(createElement(CareerSignalItems, { signals: FIXTURE_SIGNALS_V1.signals, skipped: FIXTURE_SIGNALS_V1.skipped }));
  const items = html("[data-signal-item]");
  assert.equal(items.length, 3);

  const expected: Array<[CareerSignalV1, string]> = [
    [FIXTURE_SIGNALS_V1.signals[0], "跨界组合"],
    [FIXTURE_SIGNALS_V1.signals[1], "新职族首现"],
    [FIXTURE_SIGNALS_V1.signals[2], "技能错配"],
  ];
  for (const [signal, ruleLabel] of expected) {
    const item = items.filter((_, element) => html(element).attr("data-signal-item") === signal.rule).first();
    assert.equal(item.length, 1, `no signal card for ${signal.rule}`);
    assert.equal(item.find(`[data-signal-rule='${signal.rule}']`).text(), ruleLabel);
    assert.equal(item.find("[data-signal-company]").text(), signal.company);
    assert.equal(item.find("[data-signal-title]").text(), signal.job_title);
    assert.equal(item.find("[data-signal-reason]").text(), signal.reason_text);
    assert.equal(item.find("a").attr("href"), `/career-insights/jobs/${signal.job_id}`);
  }

  assert.equal(
    html("[data-signals-skipped]").text(),
    "另有 1 家公司因历史不足 2 天暂无法判定突增",
  );
});

test("the signal card groups every skipped rule and omits the notice for an empty skip list", () => {
  const skipped = [
    { ...FIXTURE_SIGNALS_V1.skipped[0]!, rule: "new_family" },
    FIXTURE_SIGNALS_V1.skipped[0]!,
    { ...FIXTURE_SIGNALS_V1.skipped[0]!, company: "虚构样例科技有限公司" },
  ] as unknown as typeof FIXTURE_SIGNALS_V1.skipped;
  const html = render(createElement(CareerSignalItems, { signals: FIXTURE_SIGNALS_V1.signals, skipped }));
  assert.equal(html("[data-signal-item]").length, 3);
  assert.equal(html("[data-signals-skipped]").attr("data-signals-skipped"), "3");
  assert.equal(
    html("[data-signals-skipped]").text(),
    "另有 1 家公司因历史不足 2 天暂无法判定新职族首现；另有 2 家公司因历史不足 2 天暂无法判定突增",
  );

  const withoutSkipped = render(createElement(CareerSignalItems, { signals: FIXTURE_SIGNALS_V1.signals, skipped: [] }));
  assert.equal(withoutSkipped("[data-signal-item]").length, 3);
  assert.equal(withoutSkipped("[data-signals-skipped]").length, 0);
});

test("the signal card explains an empty result instead of inventing one", () => {
  const html = render(createElement(CareerSignalItems, { signals: [], skipped: [] }));
  assert.equal(html("[data-signal-item]").length, 0);
  const empty = html("[data-signals-empty]");
  assert.equal(empty.length, 1);
  assert.match(empty.text(), /当前样本下暂未发现异常信号/);
  assert.match(empty.text(), /需要更多来源与更长历史/);
  assert.equal(html("[data-signals-skipped]").length, 0);
});

test("the hot list shows the top three role families and a dash for a missing publish date", () => {
  const withMissingDate = FIXTURE_HOT_V1.entries[1]!;
  const html = render(createElement(CareerHotList, { entries: FIXTURE_HOT_V1.entries }));
  const entries = html("[data-hot-entry]");
  assert.equal(entries.length, 2);

  const first = entries.first();
  assert.equal(first.find("[data-hot-company]").text(), "虚构样例科技有限公司");
  assert.equal(first.find("[data-hot-job-count]").text(), "12");
  assert.equal(first.find("[data-hot-family]").length, 3);
  assert.equal(first.find("[data-hot-family]").first().text(), "AI 算法 5");
  assert.equal(first.find("[data-hot-latest]").text(), "2026年1月1日 17:00");

  const second = entries.last();
  assert.equal(second.find("[data-hot-company]").text(), withMissingDate.company);
  assert.equal(second.find("[data-hot-latest]").text(), "—");
});

test("an empty hot list keeps the site's way into the career insights page", () => {
  const html = render(createElement(CareerHotList, { entries: [] as CareerHotEntryV1[] }));
  assert.equal(html("[data-hot-entry]").length, 0);
  const empty = html("[data-hot-empty]");
  assert.equal(empty.length, 1);
  assert.match(empty.text(), /本站内容暂未接入/);
  const link = empty.find("a").filter((_, element) => empty.find(element).text() === "就业趋势洞察").first();
  assert.ok(link.length > 0, "no link to 就业趋势洞察");
  assert.equal(link.attr("href"), "/career-insights");
});

/** The cached AI daily comment the /daily page renders; fields a test does not name are fixed. */
function dailyComment(overrides: Partial<CareerDailyCommentResponseV1> = {}): CareerDailyCommentResponseV1 {
  return {
    contract_version: "0.1",
    date: FIXTURE_DAILY_V1.date,
    as_of: FIXTURE_DAILY_V1.generated_at,
    generated_at: FIXTURE_DAILY_V1.generated_at,
    sample_size: FIXTURE_DAILY_V1.sample_size,
    new_jobs: FIXTURE_DAILY_V1.new_jobs_today,
    confidence: "medium",
    comment: "今日新增 15 个岗位，AI 算法方向占比最高；样本仍以官方招聘页为准。",
    facts: ["今日新增 15 个岗位"],
    evidence: [],
    ...overrides,
  };
}

test("the daily report says today has not been collected yet when there was no run", () => {
  const noRun: CareerDailyResponseV1 = { ...FIXTURE_DAILY_V1, has_run: false, sources: [] };
  const html = render(createElement(CareerDailyReport, { daily: noRun }));
  assert.equal(html("[data-daily-no-run]").text(), "今日尚未采集");
  assert.equal(html("[data-daily-source]").length, 0);
});

test("the daily report shows the date, each source and the unknown-skill share", () => {
  const html = render(createElement(CareerDailyReport, { daily: FIXTURE_DAILY_V1 }));
  assert.equal(html("[data-daily-date]").attr("datetime"), FIXTURE_DAILY_V1.date);
  assert.equal(html("[data-daily-no-run]").length, 0);

  const sources = html("[data-daily-source]");
  assert.equal(sources.length, 2);
  const first = sources.first();
  assert.equal(first.find("[data-daily-collected]").text(), "20");
  assert.equal(first.find("[data-daily-accepted]").text(), "15");
  assert.equal(first.find("[data-daily-updated]").text(), "3");
  assert.equal(first.find("[data-daily-duplicates]").text(), "2");
  assert.equal(first.find("[data-daily-status]").text(), "正常");
  assert.equal(sources.last().find("[data-daily-status]").text(), "部分失败");

  assert.match(html.text(), /空技能岗位占比/);
  assert.match(html.text(), /12\.5%/);
});

test("the daily report renders the cached AI comment between the day's figures and the source results", () => {
  const comment = dailyComment();
  const html = render(createElement(CareerDailyReport, { daily: FIXTURE_DAILY_V1, comment }));
  const block = html("[data-daily-comment]");
  assert.equal(block.length, 1);
  assert.equal(block.attr("data-daily-comment-date"), comment.date);
  assert.equal(block.attr("data-daily-comment-confidence"), "medium");
  assert.equal(block.find("h2").text(), "AI 评论");
  assert.equal(html("[data-daily-comment-body]").text(), comment.comment);
  assert.equal(
    html("[data-daily-comment-meta]").text(),
    "生成于 2026年1月1日 08:00 · 中置信 · 当日观测样本 128 个岗位 · 今日新增 15",
    "generated_at is read in Beijing time, the confidence uses the shared label and the counts come from the cache",
  );
  // 今日概况 → AI 评论 → 各来源采集结果：采集结果放在页面最下面。
  const text = html.text();
  const figuresAt = text.indexOf("今日概况");
  const commentAt = text.indexOf("AI 评论");
  assert.ok(figuresAt < commentAt, "the comment follows the day's figures");
  assert.ok(commentAt < text.indexOf("各来源采集结果"), "the source results sit at the bottom");
});

test("the daily report hides the AI comment block without a cache and on a failed read", () => {
  for (const comment of [undefined, null]) {
    const html = render(createElement(CareerDailyReport, { daily: FIXTURE_DAILY_V1, comment }));
    assert.equal(html("[data-daily-comment]").length, 0, "no empty card or placeholder without a cache");
    assert.doesNotMatch(html.text(), /AI 评论/);
    // The other blocks are untouched.
    assert.equal(html("[data-daily-source]").length, 2);
    assert.match(html.text(), /今日概况/);
  }
});

test("the daily comment's confidence label uses the site's three shared tiers", () => {
  const labels = { low: "低置信", medium: "中置信", high: "高置信" } as const;
  for (const confidence of ["low", "medium", "high"] as const) {
    const html = render(createElement(CareerDailyReport, { daily: FIXTURE_DAILY_V1, comment: dailyComment({ confidence }) }));
    assert.equal(html("[data-daily-comment]").attr("data-daily-comment-confidence"), confidence);
    assert.match(html("[data-daily-comment-meta]").text(), new RegExp(labels[confidence]));
  }
});

test("a long, unbroken comment keeps the block's break convention", () => {
  const html = render(createElement(CareerDailyReport, { daily: FIXTURE_DAILY_V1, comment: dailyComment({ comment: "数".repeat(400) }) }));
  const body = html("[data-daily-comment-body]");
  assert.equal(body.length, 1);
  assert.match(body.attr("class") ?? "", /\bbreak-words\b/, "generated text may have no spaces to break at");
});