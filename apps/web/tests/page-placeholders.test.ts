// The site is a career-trend platform now. The retired article pages say they are being rebuilt and ask
// search engines to stay away; the weekly and monthly editions say they are being prepared, with the
// career pages one link away; /about counts jobs, policies and collection sources instead of the retired
// article figures; and the terms and privacy pages say what actually happens, with no template blanks.
// Failure cases: a judge opens a page and reads "0 期", "38 个 AI 主题", "请填写", or an article count that
// belongs to the retired AI site.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import * as cheerio from "cheerio";
import { fakeApi, startWebServer, type WebServer } from "./web-server.ts";

const AT = "2026-11-21T01:29:35.303Z";

/** The career reads /about makes, with numbers a reader can check against the page. */
const CAREER = {
  summary: {
    contract_version: "0.1", data_origin: "live", as_of: AT, sample_size: 222, company_count: 3, source_count: 4,
    first_observed_at: "2026-11-19T08:08:37.234Z", last_observed_at: AT, has_multiple_snapshots: true,
    metrics: [], shared_themes: [], dictionary_version: "fixture", warnings: [],
  },
  daily: {
    contract_version: "0.1", data_origin: "live", date: "2026-11-21",
    sources: ["baidu", "meituan", "tencent", "ndrc", "gov"].map((source_key) => ({ source_key, collected: 20, accepted: 18, updated: 0, duplicates: 2, status: "ok" })),
    has_run: true, jobs_total: 222, new_jobs_today: 34, new_policies_today: 2, policies_total: 6,
    unknown_ratio: 0.25, sample_size: 222, generated_at: AT,
  },
};

/** The retired article lists: they still answer, so a page that reads them would show their content. */
const RETIRED = {
  pool: {
    filters: { channel: "all", category: null, tag: null, q: null, tab: "time" },
    items: [{ id: "retired-item", title: "旧文章：一篇 AI 报道", summary: "旧摘要", reason: "旧理由", source: { name: "旧信源" }, publishedAt: AT, timelineAt: AT, category: "ai-models", tags: [], score: 80, selected: true, channel: "news", x: null }],
    page: 1, pageCount: 1, total: 1, todayCount: 1, freshness: AT,
  },
  topics: {
    groups: [{ key: "company", name: "公司与模型", blurb: "按厂商追踪模型、产品与公司动态" }],
    topics: [{ slug: "openai", name: "OpenAI / ChatGPT", group: "company", definition: "OpenAI 的 GPT 系列模型。", brand: null, total: 9, recent: 0, indexable: true, latest: null }],
  },
};

const api = fakeApi((url) => {
  if (url.pathname === "/api/site/career-insights/summary") return CAREER.summary;
  if (url.pathname === "/api/site/career-insights/daily") return CAREER.daily;
  if (url.pathname === "/api/site/pool") return RETIRED.pool;
  if (url.pathname === "/api/site/topics") return RETIRED.topics;
});

let web: WebServer;
before(async () => { web = await startWebServer(api); });
after(() => web.stop());

/** A page's HTML and its visible text (tag and comment markers removed). */
type Doc = ReturnType<typeof cheerio.load>;

async function read(path: string): Promise<{ html: string; $: Doc; text: string }> {
  const res = await fetch(web.origin + path);
  assert.equal(res.status, 200, `${path}: ${web.logs()}`);
  const html = await res.text();
  const $ = cheerio.load(html);
  const text = html.replace(/<!--[\s\S]*?-->/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  return { html, $, text };
}

function robot($: Doc): string {
  return $('meta[name="robots"]').attr("content") ?? "";
}

for (const [path, oldText] of [
  ["/all", "旧文章：一篇 AI 报道"],
  ["/topics", "OpenAI / ChatGPT"],
] as const) {
  test(`${path} says the section is being rebuilt and does not render the retired article system`, async () => {
    const { $, text } = await read(path);
    assert.match(robot($), /noindex/);
    assert.match(text, /该板块正在改版/);
    // The three ways on: jobs, insights, the career daily.
    for (const to of ["/career-insights/jobs", "/career-insights", "/daily"]) {
      assert.ok($(`a[href="${to}"]`).length > 0, `${path} links to ${to}`);
    }
    // Nothing of the retired article system is drawn, even when its api still answers.
    assert.doesNotMatch(text, new RegExp(oldText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), path);
    assert.doesNotMatch(text, /公司与模型|OpenAI|ChatGPT|38 个主题/);
    assert.doesNotMatch(text, /一手|论文|教程|观点/, "the old category tabs are gone");
    assert.equal($('a[href*="category="]').length, 0, "no old category links");
  });
}

for (const path of ["/weekly", "/monthly", "/daily/archive"]) {
  test(`${path} says it is being prepared and links to the career daily`, async () => {
    const { $, text } = await read(path);
    assert.match(robot($), /noindex/);
    assert.match(text, /筹备中/);
    assert.ok($('a[href="/daily"]').length > 0, `${path} links to /daily`);
    assert.ok($('a[href="/career-insights"]').length > 0, `${path} links to /career-insights`);
    // No empty issue list and no old article content.
    assert.doesNotMatch(text, /共\s*0\s*期|还没有发布/);
    assert.doesNotMatch(text, /旧文章：一篇 AI 报道/);
  });
}

test("the report pages keep the weekly and monthly entry points, marked as being prepared", async () => {
  for (const [path, name] of [["/weekly", "周报"], ["/monthly", "月报"]] as const) {
    const { $ } = await read(path);
    for (const label of ["日报", "周报", "月报", "往期"]) {
      assert.ok($(`nav[aria-label="报告入口"] a`).filter((_, a) => $(a).text().trim() === label).length > 0, `${path} keeps the ${label} entry`);
    }
    assert.match($("h1").first().text(), new RegExp(name), `${path} names the edition being prepared`);
  }
});

test("/about counts jobs, policies and sources in the career wording, not the retired article figures", async () => {
  const { text } = await read("/about");
  assert.match(text, /222\s*个岗位/);
  assert.match(text, /今日新增\s*34\s*个岗位/);
  assert.match(text, /6\s*条政策/);
  assert.match(text, /5\s*个来源/);
  assert.match(text, /最新就业日报\s*2026-11-21/);
  // The retired site's figures are gone, including the AI-site source count.
  assert.doesNotMatch(text, /0\s*个信源|0\s*条动态|0\s*期日报|18\s*个信源/);
  assert.doesNotMatch(text, /精选|推荐理由/);
});

test("/about says 数据更新中 instead of inventing numbers when the career api does not answer", async () => {
  const failing = fakeApi((url, res) => {
    if (url.pathname.startsWith("/api/site/career-insights/")) {
      res.statusCode = 500;
      return { error: { code: "internal_error", message: "fixture" } };
    }
  });
  const offline = await startWebServer(failing);
  try {
    const res = await fetch(`${offline.origin}/about`);
    assert.equal(res.status, 200, offline.logs());
    const text = (await res.text()).replace(/<!--[\s\S]*?-->/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    assert.match(text, /数据更新中/);
    assert.doesNotMatch(text, /0\s*个信源|0\s*条动态|0\s*期日报/);
  } finally {
    await offline.stop();
  }
});

test("the terms and privacy pages carry real copy: no template blanks, sources, collection, local data and contact", async () => {
  const terms = await read("/terms");
  const privacy = await read("/privacy");
  for (const { text } of [terms, privacy]) {
    assert.doesNotMatch(text, /请填写/);
    assert.doesNotMatch(text, /开源框架自带的模板/);
  }
  assert.match(terms.text, /招聘网站|政策页面/);
  assert.match(terms.text, /06:10/);
  assert.match(terms.text, /免责/);
  assert.match(terms.text, /不收集账号信息/);
  assert.match(terms.text, /如有疑问请通过反馈页联系我们/);
  assert.match(privacy.text, /浏览器/);
  assert.match(privacy.text, /收藏/);
  assert.match(privacy.text, /已读/);
  assert.match(privacy.text, /如有疑问请通过反馈页联系我们/);
  for (const { $ } of [terms, privacy]) {
    assert.ok($('a[href="/feedback"]').length > 0, "the pages link to the feedback page");
  }
});
