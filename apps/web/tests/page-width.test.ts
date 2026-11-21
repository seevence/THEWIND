// Failures: an unbroken URL in a report's lead widened the phone layout and pushed the fifth tab off
// screen; an open "另外 N 家也报道了" took its longest title's width and scrolled a narrow desktop window
// sideways (2026-10-16). Pages must fit the window at phone, narrow-phone, unfolded-foldable (669 upright,
// 711 for an Android foldable, which reads the desktop pages beside the rail) and full-sidebar (941) widths.
// Narrow desktops read in one column (2026-10-30): what a side column holds there (an article's reason,
// topics, original and outline; the switch between reports) must stay within reach.
// The shell follows the input device: 320 and 393 are touch screens and keep the phone shell (320 in
// particular must not lose 64px of content to the rail), while 669 upwards is a mouse window and reads
// the desktop shell, so each page is waited on with what its shell actually renders.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chromium, webkit, expect, type Browser, type Page } from "@playwright/test";
import { FIXTURE_AT as at, careerDailyCommentFixture, fakeApi, feedItem, itemDetail, startWebServer, visit, type WebServer } from "./web-server.ts";

const longText = "查看完整说明 https://example.org/announcements/" + "a".repeat(100) + "。";
const longTitle = "一条很长的标题".repeat(30);
const longUrl = "https://example.org/positions/" + "c".repeat(120);
/** The career pages' data: numbers that let every block render its real layout, not just its fallback. */
const careerSummary = {
  contract_version: "0.1", data_origin: "live", as_of: at, sample_size: 12, company_count: 3, source_count: 2,
  first_observed_at: at, last_observed_at: at, has_multiple_snapshots: true, dictionary_version: "0.1", shared_themes: [], warnings: [],
  metrics: [
    { metric_id: "observed_new_jobs", version: "1.0", label: "观测新增职位数", unit: "count", status: "ok", value: 5, numerator_count: 5, denominator_count: null, sample_size: 12, as_of: at, dimension: {}, evidence: [], disclaimer: "固定口径" },
    { metric_id: "student_friendly_share", version: "1.0", label: "学生友好职位占比", unit: "ratio", status: "ok", value: 0.5, numerator_count: 6, denominator_count: 12, sample_size: 12, as_of: at, dimension: {}, unknown_count: 2, unknown_ratio: 0.17, evidence: [], disclaimer: "固定口径" },
  ],
};
const careerCatalog = {
  contract_version: "0.1", data_origin: "live", as_of: at, window_days: 30, sample_size: 12,
  directions: [{
    role_family: "ai_algorithm", job_count: 7, company_count: 3, new_in_window: 4, student_friendly_count: 5,
    top_skills: [{ skill: "python", count: 6 }, { skill: "large_language_models", count: 4 }, { skill: "pytorch", count: 3 }],
  }],
  titles: [{
    title_key: "fixture-title", title_display: longTitle, job_count: 7, company_count: 3, cities: ["北京"],
    top_skills: [{ skill: "python", count: 6 }], student_friendly_count: 5, latest_published_at: at,
  }],
  skills: [{ skill: "python", job_count: 6, share: 0.75 }, { skill: "large_language_models", job_count: 4, share: 0.5 }],
};
const outline = Array.from({ length: 4 }, (_, i) => ({ id: `part-${i}`, level: 2, text: `第${i + 1}部分` }));
const article = itemDetail({
  id: "fit", title: "宽度检查文章", topics: [{ slug: "fixture-topic", name: "固定主题" }], outline,
  body: { zh: outline.map((o) => `<h2 id="${o.id}">${o.text}</h2><p>${"固定正文。".repeat(40)}</p>`).join(""), original: null, zhKind: "original", complete: true },
});

const api = fakeApi((url) => {
  const path = url.pathname;
  if (path === "/api/site/items/fit") return article;
  if (path === "/api/site/topics") return { groups: [], topics: [] };
  if (path === "/api/site/hot") return { computedAt: at, windowHours: 48, entries: [] };
  if (path === "/api/site/career-insights/daily") {
    return {
      contract_version: "0.1", data_origin: "synthetic_fixture", date: "2026-10-15", sources: [], has_run: true,
      jobs_total: 0, new_jobs_today: 0, new_policies_today: 0, policies_total: 0, unknown_ratio: null, sample_size: 0, generated_at: at,
    };
  }
  // The daily page's AI comment carries the widest line it can: generated text with an unbroken URL.
  if (path === "/api/site/career-insights/daily-comment") {
    return careerDailyCommentFixture({ comment: longText + longText, confidence: "high" });
  }
  if (path === "/api/site/career-insights/hot") {
    return {
      contract_version: "0.1", data_origin: "synthetic_fixture", as_of: at, window_days: 30,
      entries: [{ company: "固定企业", job_count: 12, latest_published_at: at, role_families: [] }],
    };
  }
  if (path === "/api/site/career-insights/summary") return careerSummary;
  if (path === "/api/site/career-insights/catalog") return careerCatalog;
  // The insights page keeps the complete brief and the signal reasons; the home now only links there.
  if (path === "/api/site/career-insights/signals") {
    return {
      contract_version: "0.1", data_origin: "live", window_days: 30, skipped: [], generated_at: at,
      signals: [{
        rule: "cross_industry", company: "固定企业", job_id: "fixture-job", job_title: longTitle, confidence: "high",
        evidence: { company_job_count: 10, ai_family_job_count: 6, ai_family_ratio: 0.6, matched_terms: ["机械"] },
        reason_text: longText, source_key: "fixture", official_url: longUrl, first_seen_at: at,
      }],
    };
  }
  // The jobs page keeps the full ranking and every job row, whose title and official URL can be unbroken.
  if (path === "/api/site/career-insights/jobs") {
    return {
      contract_version: "0.1", data_origin: "live", as_of: at, page: 1, page_size: 20, total: 1,
      filters: { page: 1, page_size: 20 },
      items: [{
        id: "fixture-job", company_name: "固定企业", title: longTitle, role_family: "ai_algorithm",
        locations: ["北京"], employment_type: "campus", student_friendly: "yes", skills: ["python"],
        published_at: at, first_seen_at: at, last_seen_at: at, official_url: longUrl,
      }],
    };
  }
  if (path === "/api/site/pool") {
    // The list page's widest line is 同一件事，精选收录的是《…》: an unbroken long title in one row.
    return {
      filters: { channel: "all", category: null, tag: null, q: null, tab: "time" },
      items: [{ ...feedItem({ id: "rep-1", title: "代表文章" }), sameEvent: { id: "sel-1", title: longTitle } }],
      page: 1, pageCount: 1, total: 1, todayCount: 1, freshness: at,
    };
  }
});
let web: WebServer;
let chrome: Browser;
let safari: Browser;
before(async () => {
  web = await startWebServer(api);
  chrome = await chromium.launch({ channel: "chromium" });
  safari = await webkit.launch();
});
after(async () => { await chrome?.close(); await safari?.close(); await web?.stop(); });

type Shell = "phone" | "desktop";

/**
 * Each page with what widened it: a report's long lead, the career daily and hot list, the list page with its
 * same-event line, and the home workbench. What a page waits on depends on its shell: the phone's PhoneBar
 * and tab bar links only exist there, so the desktop shell waits on the page body instead.
 */
const PAGES: Array<{ path: string; ready: (page: Page, shell: Shell) => Promise<void> }> = [
  // The report latest pages now say they are being prepared; the entry row stays.
  ...["weekly", "monthly"].map((kind) => ({
    path: `/${kind}`,
    ready: async (page: Page) => {
      await expect(page.getByRole("heading", { level: 1 })).toContainText("筹备");
      await expect(page.getByRole("navigation", { name: "报告入口" })).toBeVisible();
    },
  })),
  {
    path: "/daily",
    ready: async (page: Page) => {
      await expect(page.getByRole("heading", { level: 1, name: "就业日报" })).toBeVisible();
      await expect(page.locator("time[data-daily-date='2026-10-15']")).toBeVisible();
    },
  },
  {
    path: "/hot",
    ready: async (page: Page) => {
      await expect(page.getByRole("heading", { level: 1, name: "企业招聘热度榜" })).toBeVisible();
      await expect(page.locator("[data-hot-entry]")).toHaveCount(1);
    },
  },
  {
    path: "/items/fit",
    ready: async (page: Page, shell: Shell) => {
      // Below `lg` the desktop shell has no 目录 button (it sits in the toolbar `lg` adds), so wait on the title.
      if (shell === "desktop") {
        await expect(page.getByRole("heading", { level: 1, name: "宽度检查文章" })).toBeVisible();
        return;
      }
      await expect(page.getByText("固定推荐理由", { exact: true }).filter({ visible: true })).toBeVisible();
      await expect(page.getByRole("link", { name: "固定主题" }).filter({ visible: true })).toBeVisible();
      await expect(page.getByRole("link", { name: /原文/ }).filter({ visible: true }).first()).toBeVisible();
      await page.getByRole("button", { name: "目录", exact: true }).filter({ visible: true }).click();
      await expect(page.getByRole("dialog", { name: "目录" }).getByRole("link", { name: "第4部分" })).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog", { name: "目录" })).toBeHidden();
    },
  },
  {
    path: "/all",
    ready: async (page: Page) => {
      await expect(page.getByRole("heading", { name: "该板块正在改版", exact: true })).toBeVisible();
    },
  },
  {
    path: "/topics",
    ready: async (page: Page) => {
      await expect(page.getByRole("heading", { name: "该板块正在改版", exact: true })).toBeVisible();
    },
  },
  {
    path: "/daily/archive",
    ready: async (page: Page) => {
      await expect(page.getByRole("heading", { level: 1 })).toContainText("筹备");
    },
  },
  {
    path: "/",
    ready: async (page: Page) => {
      // The home is the five-block workbench now: overview and the brief, not the job/skill boards that
      // moved to the insights and jobs pages.
      await expect(page.getByRole("heading", { level: 1, name: "就业数据工作台" })).toBeVisible();
      await expect(page.getByRole("heading", { level: 2, name: "今日概览" })).toBeVisible();
      await expect(page.getByRole("heading", { level: 2, name: "AI 就业研判" })).toBeVisible();
    },
  },
  {
    path: "/career-insights",
    ready: async (page: Page) => {
      // The insights page now holds the longest text the home gave up: the complete brief and signal reasons.
      await expect(page.getByRole("heading", { level: 1, name: "职业洞察" })).toBeVisible();
      // The signal's unbroken reason text is the widest line the home moved here.
      await expect(page.locator("[data-signal-reason='cross_industry']")).toBeVisible();
    },
  },
  {
    path: "/career-insights/jobs",
    ready: async (page: Page) => {
      // The jobs page holds the full ranking and job rows, including their unbroken official URLs.
      await expect(page.getByRole("heading", { level: 1, name: "热门岗位" })).toBeVisible();
      await expect(page.locator("[data-catalog-job='fixture-job']")).toBeVisible();
    },
  },
];

/**
 * What reaches past the screen's right edge: the page's own scrolling width (overflowing text), and boxes
 * drawn past it outside the ones that scroll or clip their content sideways.
 */
function pastEdge(width: number): string[] {
  const clipped = (el: Element) => {
    for (let box = el.parentElement; box; box = box.parentElement) if (getComputedStyle(box).overflowX !== "visible") return true;
    return false;
  };
  const page = document.documentElement.scrollWidth;
  return [
    ...(page > width + 1 ? [`the page scrolls to ${page}px`] : []),
    ...[...document.body.querySelectorAll("*")].flatMap((el) => {
      const box = el.getBoundingClientRect();
      return box.width > 0 && box.right > width + 1 && !clipped(el) ? [`${el.tagName.toLowerCase()} "${el.textContent!.slice(0, 20)}" ends at ${Math.round(box.right)}px`] : [];
    }),
  ];
}

/** Touch screens keep the phone shell; a mouse gets the desktop rail from 600px up. */
const SHELLS: Array<{ shell: Shell; widths: number[] }> = [
  { shell: "phone", widths: [320, 393] },
  { shell: "desktop", widths: [669, 711, 941] },
];

for (const engine of ["Chromium", "WebKit"] as const) test(`${engine}: pages stay within the screen at 320, 393, 669, 711 and 941 pixels`, async () => {
  const browser = engine === "Chromium" ? chrome : safari;
  for (const { shell, widths } of SHELLS) for (const width of widths) {
    const viewport = { width, height: 873 };
    const context = shell === "phone"
      ? await browser.newContext({ viewport, hasTouch: true, isMobile: true, reducedMotion: "reduce" })
      : await browser.newContext({ viewport, reducedMotion: "reduce" });
    try {
      const page = await context.newPage();
      for (const { path, ready } of PAGES) {
        await visit(page, web.origin + path);
        await ready(page, shell);
        assert.deepEqual(await page.evaluate(pastEdge, width), [], `${path} at ${width}px (${shell} shell)`);
      }
    } finally { await context.close(); }
  }
});
