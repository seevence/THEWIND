// 就业热点（/hot，企业招聘热度榜）回到主导航：电脑侧栏与手机底栏都有可见入口，而仍然隐藏的
// /all、/topics 不在导航里出现。Production SSR + 合成 api。
import assert from "node:assert/strict";
import { test } from "node:test";
import * as cheerio from "cheerio";
import { CAREER_SOURCE_DEFINITIONS } from "../../../modules/career-insights/collector/sources.ts";
import { isSafeExternalUrl } from "../../../modules/career-insights/web/labels.ts";
import { fakeApi, startWebServer } from "./web-server.ts";

async function page(path: string, route: (url: URL) => unknown = () => undefined): Promise<{ status: number; $: cheerio.CheerioAPI; html: string }> {
  const web = await startWebServer(fakeApi((url) => route(url)));
  try {
    const response = await fetch(web.origin + path);
    const html = await response.text();
    return { status: response.status, html, $: cheerio.load(html) };
  } finally {
    await web.stop();
  }
}

test("the desktop sidebar and the phone tab bar both offer the career hot list", async () => {
  const { status, $ } = await page("/");
  assert.equal(status, 200);

  const sidebar = $('nav[aria-label="主导航"] a[href="/hot"]');
  assert.ok(sidebar.length > 0, "hot is in the desktop navigation");
  assert.ok(sidebar.toArray().some((link) => $(link).text().includes("就业热点")), "it is named 就业热点");

  const tabs = $('nav[aria-label="底部导航"] a[href="/hot"]');
  assert.ok(tabs.length > 0, "hot has a phone tab bar entry");
  assert.ok(tabs.toArray().some((link) => $(link).text().includes("热点")));

  // The engine pages the site still hides stay out of the navigation.
  assert.equal($('nav[aria-label="主导航"] a[href="/all"]').length, 0);
  assert.equal($('nav[aria-label="主导航"] a[href="/topics"]').length, 0);
});

test("the hot page opens its list and the home page links to it", async () => {
  const at = "2026-10-04T08:00:00.000Z";
  const response = {
    contract_version: "0.1",
    data_origin: "live",
    as_of: at,
    window_days: 30,
    entries: [{ company: "固定企业", career_url: null, job_count: 12, latest_published_at: at, role_families: [] }],
  };
  const hot = await page("/hot", (url) => (url.pathname === "/api/site/career-insights/hot" ? response : undefined));
  assert.equal(hot.status, 200);
  assert.match(hot.$("h1").first().text(), /企业招聘热度榜/);
  assert.equal(hot.$("[data-hot-entry]").length, 1);
  const home = await page("/");
  assert.ok(home.html.includes('href="/hot"'), "the home page links to /hot");
});

test("a company with a career url becomes an external link and the others stay plain text", async () => {
  const at = "2026-10-04T08:00:00.000Z";
  const entryUrls = new Set(CAREER_SOURCE_DEFINITIONS.map((source) => source.entry_url));
  const response = {
    contract_version: "0.1",
    data_origin: "live",
    as_of: at,
    window_days: 30,
    entries: [
      { company: "链接企业", career_url: "https://careers.tencent.com/", job_count: 9, latest_published_at: at, role_families: [] },
      { company: "纯文本企业", career_url: null, job_count: 4, latest_published_at: at, role_families: [] },
      // 运行时的旧版本 API 没有该字段，按无链接处理，而不是渲染出 href=undefined 的假链接。
      { company: "旧契约企业", job_count: 2, latest_published_at: at, role_families: [] },
    ],
  };
  const hot = await page("/hot", (url) => (url.pathname === "/api/site/career-insights/hot" ? response : undefined));
  assert.equal(hot.status, 200);

  const rows = hot.$("[data-hot-entry]");
  assert.equal(rows.length, 3);

  const linked = rows.eq(0).find('a[data-hot-company]');
  assert.equal(linked.length, 1, "the company with a career url is a link");
  assert.equal(linked.text(), "链接企业");
  assert.ok(entryUrls.has(linked.attr("href") ?? ""), "the link points at a registered official careers page");
  assert.equal(linked.attr("target"), "_blank");
  const rel = (linked.attr("rel") ?? "").split(/\s+/);
  assert.ok(rel.includes("noopener"), "the link carries rel=noopener");
  assert.ok(rel.includes("noreferrer"), "the link carries rel=noreferrer");

  const plain = rows.eq(1).find("[data-hot-company]");
  assert.equal(plain.length, 1, "the company without a career url keeps its company marker");
  assert.equal(plain.text(), "纯文本企业");
  assert.equal(plain.get(0)?.tagName, "span", "it stays plain text");
  assert.equal(rows.eq(1).find("a").length, 0, "no link is rendered for it");

  const missing = rows.eq(2).find("[data-hot-company]");
  assert.equal(missing.length, 1, "a missing career_url keeps the company marker");
  assert.equal(missing.text(), "旧契约企业");
  assert.equal(missing.get(0)?.tagName, "span", "a missing career_url stays plain text");
  assert.equal(rows.eq(2).find("a").length, 0, "no fake link is rendered for it");
});
test("only http(s) career urls become links, the unsafe schemes stay plain text", async () => {
  const at = "2026-10-04T08:00:00.000Z";
  const entries = [
    { company: "http 企业", career_url: "http://careers.example.cn/", job_count: 7 },
    { company: "大写协议企业", career_url: "HTTPS://careers.example.cn/", job_count: 6 },
    { company: "脚本企业", career_url: "javascript:alert(1)", job_count: 5 },
    { company: "数据企业", career_url: "data:text/html,x", job_count: 4 },
    { company: "协议相对企业", career_url: "//evil.example", job_count: 3 },
    { company: "空串企业", career_url: "", job_count: 2 },
    { company: "空值企业", career_url: null, job_count: 1 },
    { company: "缺字段企业", job_count: 1 },
  ].map((entry) => ({ ...entry, latest_published_at: at, role_families: [] }));
  const response = { contract_version: "0.1", data_origin: "live", as_of: at, window_days: 30, entries };
  const hot = await page("/hot", (url) => (url.pathname === "/api/site/career-insights/hot" ? response : undefined));
  assert.equal(hot.status, 200);

  const rows = hot.$("[data-hot-entry]");
  assert.equal(rows.length, entries.length);

  for (const index of [0, 1]) {
    const linked = rows.eq(index).find("a[data-hot-company]");
    assert.equal(linked.length, 1, `${entries[index].company} is a link`);
    assert.match(linked.attr("href") ?? "", /^https?:\/\//i, "it keeps its http(s) href");
    assert.equal(linked.attr("target"), "_blank");
  }

  entries.slice(2).forEach((entry, offset) => {
    const index = offset + 2;
    const plain = rows.eq(index).find("[data-hot-company]");
    assert.equal(plain.length, 1, `${entry.company} keeps its company marker`);
    assert.equal(plain.text(), entry.company);
    assert.equal(plain.get(0)?.tagName, "span", `${entry.company} stays plain text`);
    assert.equal(rows.eq(index).find("a").length, 0, `${entry.company} renders no link`);
  });
});

test("isSafeExternalUrl only accepts http(s) strings", () => {
  assert.equal(isSafeExternalUrl("https://careers.example.cn/"), true);
  assert.equal(isSafeExternalUrl("http://careers.example.cn/"), true);
  assert.equal(isSafeExternalUrl("HTTPS://careers.example.cn/"), true);
  for (const unsafe of ["javascript:alert(1)", "data:text/html,x", "//evil.example", "", " javascript:alert(1)"]) {
    assert.equal(isSafeExternalUrl(unsafe), false, `${JSON.stringify(unsafe)} is not a safe external url`);
  }
  assert.equal(isSafeExternalUrl(null), false);
  assert.equal(isSafeExternalUrl(undefined), false);
});
