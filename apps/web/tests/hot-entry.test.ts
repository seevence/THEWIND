// 就业热点（/hot，企业招聘热度榜）回到主导航：电脑侧栏与手机底栏都有可见入口，而仍然隐藏的
// /all、/topics 不在导航里出现。Production SSR + 合成 api。
import assert from "node:assert/strict";
import { test } from "node:test";
import * as cheerio from "cheerio";
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
    entries: [{ company: "固定企业", job_count: 12, latest_published_at: at, role_families: [] }],
  };
  const hot = await page("/hot", (url) => (url.pathname === "/api/site/career-insights/hot" ? response : undefined));
  assert.equal(hot.status, 200);
  assert.match(hot.$("h1").first().text(), /企业招聘热度榜/);
  assert.equal(hot.$("[data-hot-entry]").length, 1);
  const home = await page("/");
  assert.ok(home.html.includes('href="/hot"'), "the home page links to /hot");
});
