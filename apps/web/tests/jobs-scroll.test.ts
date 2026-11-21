// Failures fixed before this test (热门岗位 /career-insights/jobs): a press on a filter chip used to send the
// reader back to the top of the page, and a page change was handled as a jump too. React Router's
// ScrollRestoration scrolls a new location.key to 0 unless the link opts out with preventScrollReset; the
// links here only narrow the result set (or change its page), so they opt out, and the pager also names
// #catalog-jobs so a page change lands at the job list rather than at the top. This keeps the page's own
// scroll behaviour honest in a real browser: it is the router's reset, not our components, that moves the page.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chromium, expect, type Browser, type Page } from "@playwright/test";
import type { CareerCatalogResponseV1, JobListResponseV1, JobFiltersV1 } from "@aihot/career-insights/contracts";
import { FIXTURE_AT as at, fakeApi, startWebServer, visit, type WebServer } from "./web-server.ts";

const PAGE_SIZE = 20;
const JOB_COUNT = 45;
/** Every fifth posting is not student-friendly, so the 仅学生友好 filter has to narrow the list (and the count). */
const studentFriendly = (n: number) => n % 5 !== 0;
/** How many jobs the api has for the filters it was asked for. */
const matchingJobs = (studentOnly: boolean) =>
  Array.from({ length: JOB_COUNT }, (_, i) => i + 1).filter((n) => !studentOnly || studentFriendly(n));

/** The catalog the jobs page draws its boards from; three directions keep the filter chips below the first screen. */
const CATALOG: CareerCatalogResponseV1 = {
  contract_version: "0.1", data_origin: "live", as_of: at, window_days: 30, sample_size: JOB_COUNT,
  directions: [
    {
      role_family: "ai_algorithm", job_count: 20, company_count: 8, new_in_window: 6, student_friendly_count: 12,
      top_skills: [{ skill: "python", count: 12 }, { skill: "pytorch", count: 8 }, { skill: "large_language_models", count: 6 }],
    },
    {
      role_family: "ai_application_development", job_count: 15, company_count: 6, new_in_window: 4, student_friendly_count: 9,
      top_skills: [{ skill: "java", count: 9 }, { skill: "react", count: 5 }, { skill: "docker", count: 4 }],
    },
    {
      role_family: "data", job_count: 10, company_count: 4, new_in_window: 2, student_friendly_count: 5,
      top_skills: [{ skill: "sql", count: 7 }, { skill: "data_analysis", count: 5 }, { skill: "spark", count: 3 }],
    },
  ],
  titles: [
    {
      title_key: "algorithm-engineer", title_display: "算法工程师", job_count: 18, company_count: 7, cities: ["北京", "深圳", "上海"],
      top_skills: [{ skill: "python", count: 10 }, { skill: "pytorch", count: 6 }, { skill: "machine_learning", count: 4 }],
      student_friendly_count: 9, latest_published_at: at,
    },
    {
      title_key: "data-analyst", title_display: "数据分析师", job_count: 12, company_count: 5, cities: ["北京", "深圳", "上海"],
      top_skills: [{ skill: "sql", count: 8 }, { skill: "data_analysis", count: 6 }, { skill: "python", count: 4 }],
      student_friendly_count: 6, latest_published_at: at,
    },
    {
      title_key: "product-manager", title_display: "AI 产品经理", job_count: 6, company_count: 3, cities: ["北京", "深圳", "上海"],
      top_skills: [{ skill: "product_design", count: 4 }, { skill: "data_analysis", count: 2 }, { skill: "ai_agents", count: 2 }],
      student_friendly_count: 0, latest_published_at: at,
    },
  ],
  skills: [{ skill: "python", job_count: 30, share: 0.66 }, { skill: "sql", job_count: 18, share: 0.4 }, { skill: "pytorch", job_count: 14, share: 0.31 }],
};

/** What /api/site/career-insights/jobs answers: 20 rows a page and the count for the filters it echoes back. */
function jobListResponse(url: URL): JobListResponseV1 {
  const page = Number(url.searchParams.get("page") ?? "1");
  const studentOnly = url.searchParams.get("student_friendly") === "yes";
  const matching = matchingJobs(studentOnly);
  const items = matching.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE).map((n) => ({
    id: `fixture-job-${n}`,
    company_name: `固定公司 ${n}`,
    title: `AI 开发岗位 ${n}`,
    role_family: "ai_algorithm" as const,
    locations: ["北京"],
    employment_type: "campus" as const,
    student_friendly: studentFriendly(n) ? "yes" as const : "no" as const,
    skills: ["python"],
    published_at: at,
    first_seen_at: at,
    last_seen_at: at,
    official_url: `https://example.org/jobs/${n}`,
  }));
  const filters: JobFiltersV1 = { page, page_size: PAGE_SIZE };
  const city = url.searchParams.get("city");
  if (city) filters.city = city;
  if (url.searchParams.get("student_friendly") === "yes") filters.student_friendly = "yes";
  return { contract_version: "0.1", data_origin: "live", items, page, page_size: PAGE_SIZE, total: matching.length, as_of: at, filters };
}

// The jobs page reads only these two career endpoints; the rest of the site's reads fall back to the
// synthetic api (including careerApi's own answers and its 204s for uncached blocks).
const api = fakeApi((url) => {
  if (url.pathname === "/api/site/career-insights/catalog") return CATALOG;
  if (url.pathname === "/api/site/career-insights/jobs") return jobListResponse(url);
  return undefined;
});

let web: WebServer;
let chrome: Browser;
before(async () => {
  // Started together; whatever started is stopped in after() even when another one failed.
  const started = await Promise.allSettled([
    startWebServer(api).then((started) => { web = started; }),
    chromium.launch({ channel: "chromium" }).then((browser) => { chrome = browser; }),
  ]);
  for (const result of started) if (result.status === "rejected") throw result.reason;
});
after(async () => { await chrome?.close(); await web?.stop(); });

/** A desktop window: tall enough for the boards, narrow enough that the desktop shell adds no back-to-top button. */
const VIEWPORT = { width: 1000, height: 600 };

/** Opens the jobs page and waits for the shell the chips live in. */
async function openJobsPage(page: Page): Promise<void> {
  await visit(page, web.origin + "/career-insights/jobs");
  await expect(page.getByRole("heading", { level: 2, name: "筛选岗位", exact: true })).toBeVisible();
  await expect(page.locator("[data-catalog-job='fixture-job-1']")).toBeVisible();
}

/** The scroll position the reader actually sees, read from the window rather than from our own arithmetic. */
const scrollY = (page: Page) => page.evaluate(() => window.scrollY);

test("a filter chip keeps the reader's scroll position instead of resetting the page to the top", async () => {
  const context = await chrome.newContext({ viewport: VIEWPORT });
  const page = await context.newPage();
  try {
    await openJobsPage(page);
    const chip = page.getByRole("link", { name: "仅学生友好", exact: true });
    // Put the chip in the middle of the window, as a reader who scrolled to the filters would have it.
    await chip.evaluate((el) => el.scrollIntoView({ block: "center" }));
    const before = await scrollY(page);
    assert.ok(before > 200, `the fixture should put the filter chips well below the page top (scrollY=${before})`);
    await expect(page.locator("[data-job-student-friendly='no']")).toHaveCount(4);

    await chip.click();
    await page.waitForURL(/\?student_friendly=yes/);
    // The board really redrew: student-only postings, one fewer title, and the count the api answered.
    await expect(page.locator("[data-job-student-friendly='no']")).toHaveCount(0);
    await expect(page.locator("#catalog-jobs")).toContainText("共 36 条");

    const after = await scrollY(page);
    assert.ok(after > 200, `pressing a filter chip must not reset the page to the top (scrollY=${after})`);
    await expect(chip).toBeInViewport();
  } finally { await context.close(); }
});

test("the next-page link lands on the job list instead of resetting the page to the top", async () => {
  const context = await chrome.newContext({ viewport: VIEWPORT });
  const page = await context.newPage();
  try {
    await openJobsPage(page);
    const pager = page.locator("nav[aria-label='岗位分页']");
    await expect(pager).toContainText("第 1 / 3 页");
    const next = pager.locator("[data-page='next']");
    await next.scrollIntoViewIfNeeded();
    await expect(next).toBeInViewport();
    const before = await scrollY(page);
    assert.ok(before > 1000, `the pager should sit well below the page top (scrollY=${before})`);
    await next.click();
    await page.waitForURL(/[?&]page=2(?:&|$)/);
    // Page 2 replaced the list, and the pager's #catalog-jobs anchor left the reader at the job list.
    await expect(page.locator("[data-catalog-job='fixture-job-21']")).toBeVisible();
    await expect(pager).toContainText("第 2 / 3 页");
    const after = await scrollY(page);
    assert.ok(after > 200, `pressing 下一页 must not reset the page to the top (scrollY=${after})`);
    await expect(page.getByRole("heading", { level: 2, name: "岗位明细", exact: true })).toBeInViewport();
  } finally { await context.close(); }
});


test("a direction's evidence link lands on the filtered job list, not back at the direction board", async () => {
  const context = await chrome.newContext({ viewport: VIEWPORT });
  const page = await context.newPage();
  try {
    await openJobsPage(page);
    const link = page.locator("[data-direction-evidence]").first();
    const href = await link.getAttribute("href");
    assert.ok(href?.includes("#catalog-jobs"), `direction evidence links should carry the list anchor (href=${href})`);
    await link.scrollIntoViewIfNeeded();
    await expect(link).toBeInViewport();
    await link.click();
    await page.waitForURL(/role_family=/);
    await expect(page.getByRole("heading", { level: 2, name: "岗位明细", exact: true })).toBeInViewport();
    const after = await scrollY(page);
    assert.ok(after > 200, `查看该方向岗位 must land at the job list, not the page top (scrollY=${after})`);
  } finally { await context.close(); }
});
