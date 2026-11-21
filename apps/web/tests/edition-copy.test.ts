// 出刊时间只有一个口径：站点配置、派生文案与页面都写 06:10（北京时间），不再出现与实际采集不符的 08:00。
// Production SSR + 合成 api；同时检查 site/site.ts 的派生常量与 README 里的默认值。
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import * as cheerio from "cheerio";
import { EDITION_TIMES, EDITION_WHEN, REPORTS, SITE } from "@aihot/site";
import { fakeApi, startWebServer } from "./web-server.ts";

async function pageText(path: string): Promise<{ status: number; text: string; $: cheerio.CheerioAPI }> {
  const web = await startWebServer(fakeApi());
  try {
    const response = await fetch(web.origin + path);
    const html = await response.text();
    const $ = cheerio.load(html);
    // 只看读者可见的正文：内联的页面数据里有固定时间戳（08:00），不能拿来否证文案。
    $("script, style").remove();
    const text = $("main").text().replace(/\s+/g, " ");
    return { status: response.status, text, $ };
  } finally {
    await web.stop();
  }
}

test("the edition time and every derived copy read 06:10 Beijing time", () => {
  assert.equal(EDITION_TIMES.daily, "06:10");
  assert.equal(EDITION_WHEN.daily, "每天 06:10");
  assert.match(SITE.description, /每天 06:10/);
  assert.match(REPORTS.descriptions.daily, /06:10/);
  assert.match(REPORTS.descriptions.daily, /北京时间/);
  assert.doesNotMatch(SITE.description, /08:00/);
});

test("the pages readers see say 06:10 and never the old 08:00", async () => {
  for (const path of ["/about", "/weekly"]) {
    const { status, text } = await pageText(path);
    assert.equal(status, 200, path);
    assert.match(text, /每天 06:10/, path);
    assert.doesNotMatch(text, /08[:：]00/, path);
  }
  const weekly = await pageText("/weekly");
  assert.match(weekly.text, /每天 06:10 更新/, "the weekly placeholder note names the daily update time");
  const agent = await pageText("/agent?tab=rss");
  assert.match(agent.text, /06:10/, "the RSS panel names the daily feed time");
  const terms = await pageText("/terms");
  assert.match(terms.text, /06:10/, "terms still say when collection happens");
});

test("the README keeps the same default instead of the old 08:00", async () => {
  const zh = await readFile(new URL("../../../README.md", import.meta.url), "utf8");
  const en = await readFile(new URL("../../../README.en.md", import.meta.url), "utf8");
  assert.match(zh, /默认 06:10/);
  assert.doesNotMatch(zh, /默认 08:00/);
  assert.match(en, /06:10 by default/);
  assert.doesNotMatch(en, /08:00 by default/);
});
