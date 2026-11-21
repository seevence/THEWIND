// 就业 RSS 三条公开出口，standalone：不连数据库，注入假 repository 直接驱动 Fastify 路由与 XML 构造函数。
// 断言：200 + RSS Content-Type + public max-age=300；岗位/政策各最多 50 条、日报取最近 30 天；XML 转义；
// 空数据是合法空 channel；单条坏数据与单日读取失败只跳过自己；整次查询失败 503；联调样例不外发。
import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";
import * as cheerio from "cheerio";
import { addDays, beijingDate } from "@aihot/contracts/time";
import { SITE } from "@aihot/site";
import type { JobListItemV1, JobListResponseV1 } from "../contracts/api.ts";
import type { CareerDailyCommentResponseV1 } from "../contracts/insights.ts";
import type { PolicyListResponseV1 } from "../backend/policy-read.ts";
import { FIXTURE_JOB_LIST_V1, FIXTURE_POLICY_LIST_V1 } from "../fixtures/api.ts";
import {
  CAREER_FEED_CACHE_CONTROL,
  CAREER_FEED_LIMITS,
  CAREER_FEED_PATHS,
  careerDailyFeed,
  jobsFeed,
  policiesFeed,
  registerCareerFeeds,
  type CareerFeedsRepository,
} from "../backend/routes/feeds.ts";

const uuid = (index: number): string => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
const jobBase = FIXTURE_JOB_LIST_V1.items[0]!;
const policyBase = FIXTURE_POLICY_LIST_V1.items[0]!;

/** 真实岗位列表（fixture 的形状，data_origin=live）：feed 只对真实数据输出条目。 */
function liveJobs(count: number, overrides: Partial<JobListItemV1> = {}): JobListResponseV1 {
  return {
    ...FIXTURE_JOB_LIST_V1,
    data_origin: "live",
    total: count,
    items: Array.from({ length: count }, (_, index) => ({
      ...jobBase,
      id: uuid(index + 1),
      title: `AI 应用开发工程师 ${index + 1}`,
      ...overrides,
    })),
  };
}

const LIVE_POLICIES = (count: number): PolicyListResponseV1 => ({
  ...FIXTURE_POLICY_LIST_V1,
  data_origin: "live",
  facets: { sources: [], themes: [] },
  total: count,
  items: Array.from({ length: count }, (_, index) => ({
    ...policyBase,
    policy_item_id: `live-policy-${index + 1}`,
    title: `就业政策 ${index + 1}（真实数据形状）`,
    official_url: `https://example.com/policies/live-${index + 1}`,
  })),
});

function dailyComment(date: string, overrides: Partial<CareerDailyCommentResponseV1> = {}): CareerDailyCommentResponseV1 {
  return {
    contract_version: "0.1",
    date,
    as_of: `${date}T00:00:00.000Z`,
    generated_at: `${date}T00:00:00.000Z`,
    sample_size: 128,
    new_jobs: 15,
    confidence: "medium",
    comment: "今日新增 15 个岗位，AI 算法方向占比最高。",
    facts: ["今日新增 15 个岗位"],
    evidence: [],
    ...overrides,
  };
}

function repository(overrides: Partial<CareerFeedsRepository> = {}): CareerFeedsRepository {
  return {
    listJobs: async () => liveJobs(2),
    listPolicies: async () => LIVE_POLICIES(2),
    careerDailyComment: async () => null,
    ...overrides,
  };
}

async function appFor(repositoryImpl: CareerFeedsRepository) {
  const app = Fastify();
  registerCareerFeeds(app, repositoryImpl);
  await app.ready();
  return app;
}

const xml = (body: string): cheerio.CheerioAPI => cheerio.load(body, { xmlMode: true });

test("三条 feed：200、RSS Content-Type、public max-age=300", async (t) => {
  const app = await appFor(repository());
  t.after(() => app.close());
  for (const path of Object.values(CAREER_FEED_PATHS)) {
    const response = await app.inject(path);
    assert.equal(response.statusCode, 200, path);
    assert.equal(response.headers["content-type"], "application/rss+xml; charset=utf-8", path);
    assert.equal(response.headers["cache-control"], CAREER_FEED_CACHE_CONTROL, path);
    assert.match(response.body, /^<\?xml version="1\.0" encoding="UTF-8"\?>/, path);
  }
});

test("岗位 feed：标题是岗位/公司/城市，link 是站内详情绝对地址，description 是技能与学生友好", async () => {
  const body = await jobsFeed(repository());
  const $ = xml(body);
  const channel = $("channel");
  assert.equal(channel.find("> title").text(), `${SITE.name} 就业岗位`);
  assert.match(channel.find("> link").text(), /\/career-insights\/jobs$/);
  assert.equal(channel.find("> language").text(), "zh-CN");
  assert.equal(channel.find("> atom\\:link").attr("rel"), "self");

  const items = channel.find("> item");
  assert.equal(items.length, 2);
  const first = items.first();
  assert.equal(first.find("title").text(), "AI 应用开发工程师 1｜虚构样例科技有限公司 · 虚构市");
  assert.match(first.find("link").text(), /\/career-insights\/jobs\/00000000-0000-4000-8000-000000000001$/);
  assert.match(first.find("description").text(), /技能：Python、大语言模型/);
  assert.match(first.find("description").text(), /学生友好：是/);
  assert.equal(first.find("guid").attr("isPermaLink"), "false");
  assert.equal(first.find("guid").text(), "career-job-00000000-0000-4000-8000-000000000001");
  assert.equal(first.find("pubDate").text(), new Date(jobBase.last_seen_at).toUTCString(), "no published_at: pubDate falls back to last_seen");
});

test("XML 转义：标题里的 & < > \" ' 只作为文本出现，解析回来是原值", async () => {
  const title = 'AI & <算法> "岗" \'位\' 工程师';
  const company = "A&B 科技有限公司";
  const body = await jobsFeed(repository({ listJobs: async () => liveJobs(1, { title, company_name: company }) }));
  assert.match(body, /&amp;/);
  assert.match(body, /&lt;算法&gt;/);
  assert.match(body, /&quot;岗&quot;/);
  assert.match(body, /&apos;位&apos;/);
  assert.doesNotMatch(body, /<算法>/);

  const $ = xml(body);
  assert.equal($("channel > item > title").text(), `${title}｜${company} · 虚构市`);
});

test("空数据仍是 200 的空 channel，不是 404/204", async (t) => {
  const app = await appFor(repository({ listJobs: async () => liveJobs(0), listPolicies: async () => LIVE_POLICIES(0) }));
  t.after(() => app.close());
  for (const path of [CAREER_FEED_PATHS.jobs, CAREER_FEED_PATHS.policies, CAREER_FEED_PATHS.daily]) {
    const response = await app.inject(path);
    assert.equal(response.statusCode, 200, path);
    const $ = xml(response.body);
    assert.equal($("channel").length, 1, path);
    assert.equal($("channel > item").length, 0, path);
  }
});

test("岗位与政策各最多 50 条；查询只取第一页 50 条", async () => {
  const jobFilters: Array<{ page: number; page_size: number }> = [];
  const policyFilters: Array<{ page: number; page_size: number }> = [];
  const jobs = await jobsFeed(repository({
    listJobs: async (filters) => {
      jobFilters.push(filters);
      return liveJobs(60);
    },
  }));
  assert.equal(xml(jobs)("channel > item").length, CAREER_FEED_LIMITS.jobs);
  assert.deepEqual(jobFilters, [{ page: 1, page_size: CAREER_FEED_LIMITS.jobs }]);

  const policies = await policiesFeed(repository({
    listPolicies: async (filters) => {
      policyFilters.push(filters);
      return LIVE_POLICIES(60);
    },
  }));
  assert.equal(xml(policies)("channel > item").length, CAREER_FEED_LIMITS.policies);
  assert.deepEqual(policyFilters, [{ page: 1, page_size: CAREER_FEED_LIMITS.policies }]);
});

test("政策 feed：标题是政策标题，link 是政府原文地址，description 带发布机构与原文要点", async () => {
  const body = await policiesFeed(repository());
  const $ = xml(body);
  assert.equal($("channel > title").text(), `${SITE.name} 就业政策`);
  assert.match($("channel > link").text(), /\/career-insights\/policies$/);
  const first = $("channel > item").first();
  assert.equal(first.find("title").text(), "就业政策 1（真实数据形状）");
  assert.equal(first.find("link").text(), "https://example.com/policies/live-1");
  assert.match(first.find("description").text(), /发布机构：示例国家部门/);
  assert.match(first.find("description").text(), /原文要点：/);
  assert.equal(first.find("pubDate").text(), new Date(`${policyBase.published_at}T00:00:00.000Z`).toUTCString());
});

test("日报 feed：最近 30 天的缓存，倒序、单日读取失败跳过、每个自然日只问一次", async () => {
  const now = new Date("2026-11-21T04:00:00.000Z");
  const today = beijingDate(now);
  const asked: string[] = [];
  const repo = repository({
    careerDailyComment: async (date) => {
      asked.push(date);
      if (date === today) return dailyComment(today);
      if (date === addDays(today, -2)) throw new Error("comment row unreadable");
      if (date === addDays(today, -1)) return dailyComment(addDays(today, -1), { sample_size: 99, new_jobs: 7, confidence: "low" });
      return null;
    },
  });

  const body = await careerDailyFeed(repo, { now });
  assert.deepEqual(asked, Array.from({ length: CAREER_FEED_LIMITS.dailyDays }, (_, index) => addDays(today, -index)));
  assert.equal(new Set(asked).size, CAREER_FEED_LIMITS.dailyDays, "every calendar day asked once");

  const $ = xml(body);
  const items = $("channel > item");
  assert.equal(items.length, 2, "the day whose read failed and the days without a cache are skipped");
  assert.equal(items.first().find("title").text(), `${SITE.name} 就业日报 · ${today}`, "newest first");
  assert.match(items.first().find("description").text(), /当日观测样本 128 个岗位/);
  assert.match(items.first().find("description").text(), /今日新增 15；置信度：中置信/);
  assert.match(items.last().find("description").text(), /样本 99 个岗位，今日新增 7；置信度：低置信/);
  assert.equal(new URL(items.first().find("link").text()).pathname, "/daily");
  assert.equal(items.first().find("guid").text(), `career-daily-${today}`);
});

test("日报路由：有缓存时 200 并带出条目标题", async (t) => {
  const today = beijingDate(new Date());
  const app = await appFor(repository({ careerDailyComment: async (date) => (date === today ? dailyComment(today) : null) }));
  t.after(() => app.close());
  const response = await app.inject(CAREER_FEED_PATHS.daily);
  assert.equal(response.statusCode, 200);
  const $ = xml(response.body);
  assert.equal($("channel > item").length, 1);
  assert.match($("channel > item > title").text(), /就业日报/);
});

test("整次查询失败回 503 与 Retry-After，不把 500 错误页当 feed 发出去", async (t) => {
  const app = await appFor(repository({ listJobs: async () => { throw new Error("db down"); } }));
  t.after(() => app.close());
  const response = await app.inject(CAREER_FEED_PATHS.jobs);
  assert.equal(response.statusCode, 503);
  assert.equal(response.headers["retry-after"], "60");
  assert.equal(response.headers["cache-control"], "no-store");
  assert.equal(response.headers["content-type"], "text/plain; charset=utf-8");
});

test("单条坏数据只跳过自己，其余岗位照常输出", async () => {
  const good = liveJobs(1);
  const body = await jobsFeed(repository({
    listJobs: async () => ({
      ...good,
      total: 2,
      items: [good.items[0]!, { ...good.items[0]!, id: uuid(2), locations: null as unknown as string[] }],
    }),
  }));
  const $ = xml(body);
  assert.equal($("channel > item").length, 1, "the malformed item is skipped, the feed is still valid");
  assert.match($("channel > item > title").text(), /工程师 1/);
});

test("联调样例（synthetic_fixture）不外发虚构岗位与政策", async () => {
  const body = await jobsFeed(repository({ listJobs: async () => FIXTURE_JOB_LIST_V1 }));
  assert.equal(xml(body)("channel > item").length, 0);
  const syntheticPolicies: PolicyListResponseV1 = { ...FIXTURE_POLICY_LIST_V1, facets: { sources: [], themes: [] } };
  const policies = await policiesFeed(repository({ listPolicies: async () => syntheticPolicies }));
  assert.equal(xml(policies)("channel > item").length, 0);
});

test("未知查询参数不影响内容（与引擎现有 feed 一致）", async (t) => {
  const app = await appFor(repository());
  t.after(() => app.close());
  const plain = await app.inject(CAREER_FEED_PATHS.jobs);
  const withQuery = await app.inject(`${CAREER_FEED_PATHS.jobs}?utm_source=reader&page=2`);
  assert.equal(withQuery.statusCode, 200);
  assert.equal(withQuery.body, plain.body);
});
