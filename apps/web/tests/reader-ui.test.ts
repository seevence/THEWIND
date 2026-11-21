// 读者可见的文案与入口：来源/学历中文化、/daily 的报告入口、404 的站点入口，以及手机底栏的高亮。
// 失败样例：信号卡与岗位详情露出 meituan-official-careers、学历写成 unknown 或直接铺开整句抓取原文；
// /daily 没有通往往期与周报月报的入口；404 仍指向已下线的「精选 / 全部动态」；手机底栏在 /daily 高亮首页。
// Production SSR + 合成 HTTP api；底栏高亮在 chromium 的手机视口里读 aria-current。
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import * as cheerio from "cheerio";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { chromium, expect } from "@playwright/test";
import type { CareerSignalV1, JobDetailResponseV1 } from "@aihot/career-insights/contracts";
import { CareerSignalItems } from "../../../modules/career-insights/web/components/CareerSignals.ts";
import { fakeApi, startWebServer, visit, type WebServer } from "./web-server.ts";

const AT = "2026-10-15T08:00:00.000Z";
const JOB_ID = "job-degree-fixture";
const UNKNOWN_DEGREE_JOB_ID = "job-degree-unknown";
/** 抓取到的整句学历原文：详情页只展示归一化枚举，原文最多截 24 字。 */
const LONG_DEGREE_RAW = "本科及以上学历，计算机、软件工程等相关专业，三年以上相关工作经验优先";

/** 今天的就业日报：两个真实来源键，页面必须显示中文名。 */
const DAILY = {
  contract_version: "0.1" as const,
  data_origin: "live" as const,
  date: "2026-10-15",
  sources: [
    { source_key: "meituan-official-careers", collected: 20, accepted: 15, updated: 3, duplicates: 2, status: "ok" as const },
    { source_key: "state-council-policy", collected: 8, accepted: 6, updated: 0, duplicates: 2, status: "partial" as const },
  ],
  has_run: true,
  jobs_total: 128,
  new_jobs_today: 15,
  new_policies_today: 6,
  policies_total: 42,
  unknown_ratio: 0.125,
  sample_size: 128,
  generated_at: AT,
};

function jobDetail(id: string, degree: JobDetailResponseV1["job"]["degree"], degreeRaw: string | null): JobDetailResponseV1 {
  return {
    contract_version: "0.1",
    data_origin: "live",
    job: {
      id,
      company_name: "固定企业",
      title: "固定岗位",
      role_family: "ai_algorithm",
      locations: ["北京"],
      employment_type: "campus",
      student_friendly: "yes",
      skills: ["python"],
      published_at: AT,
      first_seen_at: AT,
      last_seen_at: AT,
      official_url: "https://example.org/job",
      source_key: "meituan-official-careers",
      job_key: `key-${id}`,
      degree,
      degree_raw: degreeRaw,
      experience_min_years: null,
      experience_max_years: null,
      experience_raw: null,
      skill_evidence: [],
      collector_version: "fixture-0.1",
    },
    observations: [],
    notice: "固定说明",
  };
}

const api = fakeApi((url) => {
  if (url.pathname === "/api/site/career-insights/daily") return DAILY;
  if (url.pathname === `/api/site/career-insights/jobs/${JOB_ID}`) return jobDetail(JOB_ID, "bachelor", LONG_DEGREE_RAW);
  if (url.pathname === `/api/site/career-insights/jobs/${UNKNOWN_DEGREE_JOB_ID}`) return jobDetail(UNKNOWN_DEGREE_JOB_ID, "unknown", null);
});

let web: WebServer;
before(async () => { web = await startWebServer(api); });
after(() => web.stop());

/** 读者看到的正文：去掉内联脚本（SSR 的 loader 数据本来就带内部键），只看 main。 */
async function read(path: string): Promise<{ status: number; $: cheerio.CheerioAPI; text: string }> {
  const response = await fetch(web.origin + path);
  const $ = cheerio.load(await response.text());
  $("script, style").remove();
  return { status: response.status, $, text: $("main").text().replace(/\s+/g, " ") };
}

function signal(sourceKey: string): CareerSignalV1 {
  return {
    rule: "cross_industry",
    company: "固定企业",
    job_id: "fixture-job",
    job_title: "固定岗位",
    evidence: { company_job_count: 10, ai_family_job_count: 6, ai_family_ratio: 0.6, matched_terms: ["机械"] },
    reason_text: "固定理由",
    source_key: sourceKey,
    official_url: "https://example.org/job",
    first_seen_at: AT,
    confidence: "high",
  };
}

test("the signal card names its source in Chinese and keeps an unregistered key readable", () => {
  const render = (sourceKey: string): cheerio.CheerioAPI => cheerio.load(
    renderToStaticMarkup(createElement(
      MemoryRouter,
      { initialEntries: ["/career-insights"] },
      createElement(CareerSignalItems, { signals: [signal(sourceKey)], skipped: [] }),
    )),
  );

  const known = render("meituan-official-careers");
  const card = known("[data-signal-item]").text();
  assert.match(card, /来源 美团官方招聘/);
  assert.doesNotMatch(card, /meituan-official-careers/, "内部来源键不进读者可见文案");

  // 联调样例与旧缓存里的未登记来源回落 key，不显示空名字，也不丢来源信息。
  const unknown = render("synthetic-careers");
  assert.match(unknown("[data-signal-item]").text(), /来源 synthetic-careers/);
});

test("the daily page names sources in Chinese and links to every edition", async () => {
  const { status, $, text } = await read("/daily");
  assert.equal(status, 200, web.logs());

  const rows = $("[data-daily-source]");
  assert.equal(rows.length, 2);
  assert.match(rows.eq(0).text(), /美团官方招聘/);
  assert.match(rows.eq(1).text(), /中国政府网政策文件库/);
  assert.doesNotMatch(text, /meituan-official-careers|state-council-policy/, "内部来源键不进读者可见正文");

  // 从 /daily 能点到日报/周报/月报/往期，与 /daily/archive、/weekly、/monthly 页的入口行一致。
  const nav = $('nav[aria-label="报告入口"]');
  assert.equal(nav.length, 1, "/daily 有一行报告入口");
  for (const [label, href] of [["日报", "/daily"], ["周报", "/weekly"], ["月报", "/monthly"], ["往期", "/daily/archive"]] as const) {
    const link = nav.find("a").filter((_, element) => $(element).text().trim() === label);
    assert.equal(link.attr("href"), href, `${label} 入口指向 ${href}`);
  }
  assert.equal(nav.find('a[aria-current="page"]').attr("href"), "/daily", "当前是日报");
});

test("the job detail shows the normalized degree with a short evidence note and a Chinese source name", async () => {
  const { status, $, text } = await read(`/career-insights/jobs/${JOB_ID}`);
  assert.equal(status, 200, web.logs());

  const dd = $('main [data-job-fact="学历"] dd');
  assert.equal(dd.length, 1);
  assert.match(dd.text(), /^本科/, "优先展示归一化的中文学历");
  const note = dd.find("[data-job-fact-note]").text();
  assert.match(note, /^原文：/);
  const evidence = note.replace(/^原文：/, "");
  assert.ok(evidence.length <= 25, `原文截到 24 字加省略号，实际 ${evidence.length} 字`);
  assert.ok(!evidence.includes(LONG_DEGREE_RAW), "整句抓取原文不直接铺开");
  assert.doesNotMatch(text, /学历\s*本科及以上学历/, "学历一栏不再以抓取整句为主值");

  assert.equal($('main [data-job-fact="来源"] dd').text(), "美团官方招聘");
  assert.doesNotMatch(text, /meituan-official-careers/, "内部来源键不进读者可见正文");
});

test("an unresolved degree reads 未明确 instead of the enum", async () => {
  const { $, text } = await read(`/career-insights/jobs/${UNKNOWN_DEGREE_JOB_ID}`);
  assert.equal($('main [data-job-fact="学历"] dd').text(), "未明确");
  assert.doesNotMatch(text, /\bunknown\b/);
});

test("a 404 offers the current three entries and no retired /all target", async () => {
  const { status, $, text } = await read("/no-such-page");
  assert.equal(status, 404, web.logs());
  assert.match(text, /找不到这个页面/);

  for (const [label, href] of [["回首页", "/"], ["热门岗位", "/career-insights/jobs"], ["就业日报", "/daily"]] as const) {
    const link = $("main a").filter((_, element) => $(element).text().trim() === label);
    assert.equal(link.attr("href"), href, `404 有「${label}」入口指向 ${href}`);
  }
  assert.equal($('main a[href="/all"]').length, 0, "404 不再指向 /all");
  assert.doesNotMatch(text, /精选|全部动态/);
});

test("the phone tab bar leaves pages outside it unlit and still lights the home tab", async () => {
  const browser = await chromium.launch({ channel: "chromium" });
  try {
    const page = await browser.newPage({ viewport: { width: 393, height: 852 } });
    const bar = page.locator('nav[aria-label="底部导航"]');

    // /daily 不占底栏：不高亮任何一项，也不回退高亮首页。
    await visit(page, `${web.origin}/daily`);
    await expect(bar).toBeVisible();
    await expect(bar.locator('a[aria-current="page"]')).toHaveCount(0);

    // 首页仍然高亮自己的 tab。
    await visit(page, `${web.origin}/`);
    const current = bar.locator('a[aria-current="page"]');
    await expect(current).toHaveCount(1);
    await expect(current).toContainText("首页");
  } finally {
    await browser.close();
  }
});
