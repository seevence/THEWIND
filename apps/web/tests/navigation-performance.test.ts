// Failure modes fixed before changing public loaders, prefetch and enhancement:
// - returning to a page that was already open still needs the network;
// - Agent tabs choose an invalid panel or leave canonical/history behind;
// - offscreen code downloads/runs immediately, visible code stays plain, or raw copying changes;
// - tiny/linked pictures become zoom buttons, or language changes keep old handlers.
// The article feed (/all and the item lists) was retired into a "being rebuilt" page on 2026-11-21, so the
// prefetch, paging and feed-cache tests went with it; the report pages stay reachable and are checked here.
import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { chromium, webkit, expect, type Browser } from "@playwright/test";
import { fakeApi, itemDetail, startWebServer, visit, type WebServer } from "./web-server.ts";

const detail = itemDetail({ id: "reader-fixture", title: "阅读增强检查", originalTitle: "Fixture article" });
const codeSource = 'import json\n\nwith open("data.json") as file:\n    data = json.load(file)\n\nfor record in data:\n    print(record["title"])\n';
const readerBody = Array.from({ length: 30 }, (_, i) => `<p>阅读段落 ${i}：先阅读文章，再查看后面的代码和图片。正文保持可读，图片和代码在需要时增强。</p>`).join("")
  + `<pre><code>${codeSource}</code></pre><pre><code>x = 1</code></pre>`
  + Array.from({ length: 12 }, (_, i) => `<img src="/reader-image/${i}.svg" alt="正文配图 ${i}" width="640" height="360" loading="lazy">`).join("")
  + '<img src="/reader-image/tiny.svg" alt="小图标" width="16" height="16" loading="lazy"><a href="https://example.org"><img src="/reader-image/linked.svg" alt="链接图片" width="640" height="360" loading="lazy"></a>';

let web: WebServer;
let origin: string;
let chrome: Browser;
let safari: Browser;
const api = fakeApi((url) => {
  const p = url.pathname;
  if (p === "/api/site/items/reader-fixture") return { ...detail, body: { ...detail.body, zh: readerBody } };
  if (p === "/api/site/items/reader-fixture/original") return { ...detail, body: { ...detail.body, zh: null, original: "<p>Original reader text</p>" }, bodyLanguage: "original" };
});

before(async () => {
  // Started together; whatever started is stopped in after() even when another one failed.
  const started = await Promise.allSettled([
    startWebServer(api).then((w) => { web = w; origin = w.origin; }),
    chromium.launch({ channel: "chromium" }).then((b) => { chrome = b; }),
    webkit.launch().then((b) => { safari = b; }),
  ]);
  for (const result of started) if (result.status === "rejected") throw result.reason;
});
after(async () => {
  await chrome?.close(); await safari?.close();
  await web?.stop();
});

test("SSR report pages return offline with their own content; the weekly and monthly entries stay", async () => {
  const context = await chrome.newContext();
  const page = await context.newPage();
  try {
    await visit(page, origin + "/weekly");
    await expect(page.locator("#report-start")).toContainText("周报");
    await expect(page.locator("link[rel=canonical]")).toHaveAttribute("href", origin + "/weekly");
    await page.getByRole("link", { name: "月报", exact: true }).click();
    await expect(page.locator("#report-start")).toContainText("月报");
    await context.setOffline(true);
    await page.getByRole("link", { name: "周报", exact: true }).click();
    await expect(page.locator("#report-start")).toContainText("周报", { timeout: 1500 });
  } finally { await context.close(); }
});

test("Agent tabs finish offline with matching canonical; invalid direct tabs and anchored links keep a panel", async () => {
  const context = await chrome.newContext(); const page = await context.newPage();
  try {
    await visit(page, origin + "/agent");
    await context.setOffline(true);
    await page.getByRole("tablist", { name: "接入方式" }).getByRole("tab", { selected: true }).click();
    await expect(page.locator("#agent-panel")).not.toBeEmpty();
    for (const [tab, name] of [["mcp", /^MCP/], ["rss", /^RSS/], ["api", /^REST API/]] as const) {
      const choice = page.getByRole("tab", { name });
      // The active track was exercised above; compare navigation through every remaining track.
      if (await choice.getAttribute("aria-selected") === "true") continue;
      const target = await choice.getAttribute("href");
      await choice.click();
      await expect(page).toHaveURL(origin + target, { timeout: 1500 });
      await expect(page.locator("link[rel=canonical]")).toHaveAttribute("href", origin + target);
      await expect(page.locator("#agent-panel")).toHaveAttribute("aria-labelledby", "agent-tab-" + tab);
      await expect(page.locator("#agent-panel")).not.toBeEmpty();
    }
    await context.setOffline(false);
    await visit(page, origin + "/agent?tab=unknown");
    await expect(page.getByRole("tab").first()).toHaveAttribute("aria-selected", "true");
    await expect(page.locator("#agent-panel")).not.toBeEmpty();
    await visit(page, origin + "/agent#agent-api-recovery");
    await expect(page.locator("#agent-api-recovery")).toBeVisible();
  } finally { await context.close(); }
});

test("reader enhancements wait for visible code and update only the picture that loaded", async () => {
  const context = await safari.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  const scripts: string[] = [];
  page.on("request", (r) => { if (r.url().includes("/assets/") && r.url().includes("highlight-")) scripts.push(r.url()); });
  await page.route("**/reader-image/*.svg", (route) => route.fulfill({ contentType: "image/svg+xml", body: `<svg xmlns="http://www.w3.org/2000/svg" width="${route.request().url().endsWith("/tiny.svg") ? 16 : 640}" height="360"><rect width="640" height="360" fill="red"/></svg>` }));
  try {
    await visit(page, origin + "/items/reader-fixture");
    await expect(page.getByRole("heading", { name: "阅读增强检查", exact: true })).toBeVisible();
    await expect(page.locator(".code-block-copy")).toHaveCount(2);
    assert.deepEqual(scripts, [], "reading the introduction must not download the offscreen highlighter");
    const source = page.locator(".prose pre code").first();
    assert.equal(await source.textContent(), codeSource);
    await source.scrollIntoViewIfNeeded();
    await expect(source).toHaveClass(/hljs/);
    assert.equal(await source.textContent(), codeSource, "colouring preserves the copyable text");
    assert.equal(scripts.length, 1);
    await page.locator(".code-block-copy").first().click();
    await expect(page.locator(".code-block-copy").first()).toHaveText("已复制");
    assert.equal(await page.locator(".prose pre code").nth(1).textContent(), "x = 1");
    for (let i = 0; i < 12; i++) {
      const picture = page.locator(`.prose img[alt="正文配图 ${i}"]`);
      await picture.scrollIntoViewIfNeeded();
      await expect(picture).toHaveAttribute("role", "button");
    }
    const tiny = page.locator('.prose img[alt="小图标"]'); await tiny.scrollIntoViewIfNeeded();
    await expect(tiny).not.toHaveAttribute("role", "button");
    await expect(page.locator(".prose a img")).not.toHaveAttribute("role", "button");
    await page.getByRole("navigation", { name: "正文语言" }).getByRole("link", { name: "原文", exact: true }).click();
    await expect(page.getByText("Original reader text", { exact: true })).toBeVisible();
    assert.equal(await page.locator(".code-block-copy").count(), 0);
  } finally { await context.close(); }
});
