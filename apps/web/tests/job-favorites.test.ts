// 岗位收藏的浏览器行为：详情页与岗位列表点「收藏」后，/starred 出现该岗位；点「移除」后消失；
// 整页重新打开后收藏仍在（localStorage 持久化）。真实生产 server + chromium，fakeApi 只提供岗位数据；
// 收藏只写浏览器，没有后端请求。
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chromium, expect, type Browser } from "@playwright/test";
import { FIXTURE_AT as at, fakeApi, startWebServer, visit, type WebServer } from "./web-server.ts";

const JOB_ID = "11111111-1111-4111-8111-111111111111";
/** 收藏页的可用性探测说这个岗位已不在库内（下架）。 */
const STALE_JOB_ID = "22222222-2222-4222-8222-222222222222";
/** 可用性探测本身失败：列表必须照常显示，只是不显示徽标。 */
const FAILING_JOB_ID = "33333333-3333-4333-8333-333333333333";
const JOB_TITLE = "AI 算法工程师（收藏测试）";
const LIST_ITEM = {
  id: JOB_ID,
  company_name: "示例科技有限公司",
  title: JOB_TITLE,
  role_family: "ai_algorithm",
  locations: ["北京", "上海"],
  employment_type: "campus",
  student_friendly: "yes",
  skills: ["python"],
  published_at: at,
  first_seen_at: at,
  last_seen_at: at,
  official_url: "https://example.org/jobs/job-favorites",
};
const jobList = {
  contract_version: "0.1",
  data_origin: "live",
  items: [LIST_ITEM],
  page: 1,
  page_size: 20,
  total: 1,
  as_of: at,
  filters: { page: 1, page_size: 20 },
};
const jobDetail = {
  contract_version: "0.1",
  data_origin: "live",
  job: {
    ...LIST_ITEM,
    source_key: "fixture",
    job_key: "job-favorites",
    degree: "bachelor",
    degree_raw: null,
    experience_min_years: null,
    experience_max_years: null,
    experience_raw: null,
    skill_evidence: [{ skill_id: "python", evidence_text: "固定职位文本：使用 Python。" }],
    collector_version: "fixture",
  },
  observations: [],
  notice: "固定说明：仅供测试。",
};
/** 记录每次可用性探测收到的 id 批次，供分批/过滤测试断言。 */
let availabilityProbes: string[][] = [];
const AVAILABILITY_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const api = fakeApi((url, res) => {
  if (url.pathname === "/api/site/career-insights/jobs") return jobList;
  if (url.pathname === `/api/site/career-insights/jobs/${JOB_ID}`) return jobDetail;
  if (url.pathname === "/api/site/career-insights/jobs/availability") {
    const ids = (url.searchParams.get("ids") ?? "").split(",").filter(Boolean);
    // 后端对坏 id 整批 400：前端如果没过滤旧格式 id，所有徽标都会消失。
    if (ids.some((id) => !AVAILABILITY_UUID.test(id))) {
      res.statusCode = 400;
      return { error: { code: "invalid_parameter", message: "fixture" } };
    }
    availabilityProbes.push(ids);
    if (ids.includes(FAILING_JOB_ID)) {
      res.statusCode = 500;
      return { error: { code: "internal_error", message: "fixture" } };
    }
    return { contract_version: "0.1", ids: Object.fromEntries(ids.map((id) => [id, id === STALE_JOB_ID ? "missing" : "visible"])) };
  }
  return undefined;
});

let web: WebServer;
let chrome: Browser;
before(async () => {
  const started = await Promise.allSettled([startWebServer(api).then((server) => { web = server; }), chromium.launch({ channel: "chromium" }).then((browser) => { chrome = browser; })]);
  for (const result of started) if (result.status === "rejected") throw result.reason;
});
after(async () => {
  await chrome?.close();
  await web?.stop();
});

/** 打开一个页面并收集它报的错：首屏 hydration 出错会以 console error 出现在这里。 */
async function openPage() {
  const context = await chrome.newContext();
  const page = await context.newPage();
  const errors: string[] = [];
  // 站点图标 404 与收藏无关；hydration 不一致会以 React 的 console error 出现，必须为空。
  page.on("console", (message) => { if (message.type() === "error" && !message.text().startsWith("Failed to load resource")) errors.push(message.text()); });
  page.on("pageerror", (error) => errors.push(String(error)));
  return { context, page, errors };
}

test("starring a job on its detail page lists it on /starred, and 移除 removes it", async () => {
  const { context, page, errors } = await openPage();
  try {
    await visit(page, `${web.origin}/career-insights/jobs/${JOB_ID}`);
    const detailStar = page.locator("[data-job-star]:visible");
    await expect(detailStar).toHaveText("收藏");
    await expect(detailStar).toHaveAttribute("aria-pressed", "false");
    await expect(detailStar).toHaveAttribute("data-job-star", "off");

    await detailStar.click();
    await expect(detailStar).toHaveText("已收藏");
    await expect(detailStar).toHaveAttribute("data-job-star", "on");
    await expect(detailStar).toHaveAttribute("aria-pressed", "true");

    await visit(page, `${web.origin}/starred`);
    const block = page.locator("[data-starred-jobs]");
    await expect(block.getByRole("heading", { level: 2, name: "收藏的岗位" })).toBeVisible();
    const row = block.locator(`[data-starred-job="${JOB_ID}"]`);
    await expect(row).toBeVisible();
    await expect(row).toContainText(JOB_TITLE);
    await expect(row).toContainText("示例科技有限公司");
    await expect(row).toContainText("北京、上海");
    await expect(row).toContainText("AI 算法");
    await expect(row.getByRole("link", { name: JOB_TITLE })).toHaveAttribute("href", `/career-insights/jobs/${JOB_ID}`);
    // 岗位收藏只写自己的 key，不碰文章收藏。
    const stored = await page.evaluate(() => ({ jobs: localStorage.getItem("aihot-starred-jobs"), articles: localStorage.getItem("aihot-starred-items") }));
    assert.ok(stored.jobs?.includes(JOB_ID), "the job is stored under aihot-starred-jobs");
    assert.equal(stored.articles, null, "job favorites never write the article favorites key");

    // 重新打开 /starred 是一次新的页面加载：收藏仍然在（localStorage 持久化）。
    await visit(page, `${web.origin}/starred`);
    await expect(page.locator(`[data-starred-job="${JOB_ID}"]`)).toBeVisible();

    await page.getByRole("button", { name: `移除收藏：${JOB_TITLE}` }).click();
    await expect(page.locator(`[data-starred-job="${JOB_ID}"]`)).toHaveCount(0);
    await expect(block).toContainText("还没有收藏的岗位，在热门岗位或职位详情点收藏");
    await expect(block.getByRole("link", { name: "热门岗位" })).toHaveAttribute("href", "/career-insights/jobs");
    await expect(page.getByText("还没有收藏的文章。", { exact: false })).toBeVisible();
    const afterRemove = await page.evaluate(() => ({ jobs: localStorage.getItem("aihot-starred-jobs"), articles: localStorage.getItem("aihot-starred-items") }));
    assert.equal(afterRemove.jobs, "[]");
    assert.equal(afterRemove.articles, null);

    // 回到详情页，按钮已恢复未收藏。
    await visit(page, `${web.origin}/career-insights/jobs/${JOB_ID}`);
    await expect(page.locator("[data-job-star]:visible")).toHaveAttribute("data-job-star", "off");
    assert.deepEqual(errors, [], "hydration must not log errors");
  } finally {
    await context.close();
  }
});

test("a stored job whose saved date cannot be displayed does not fail /starred", async () => {
  const { context, page, errors } = await openPage();
  try {
    // +275760-09-13 是 JS 最大瞬间：+8 小时后格式化会抛 RangeError，旧数据不能让收藏页 500。
    await page.addInitScript(() => localStorage.setItem("aihot-starred-jobs", JSON.stringify([
      { id: "11111111-1111-4111-8111-111111111111", title: "日期守卫岗位", company: "示例公司", savedAt: "+275760-09-13T00:00:00.000Z" },
    ])));
    const response = await page.goto(`${web.origin}/starred`);
    assert.equal(response?.status(), 200);
    const row = page.locator(`[data-starred-job="11111111-1111-4111-8111-111111111111"]`);
    await expect(row).toBeVisible();
    await expect(row).toContainText("日期守卫岗位");
    await expect(row).toContainText("收藏于");
    assert.deepEqual(errors, [], "hydration must not log errors");
  } finally {
    await context.close();
  }
});

test("starring a job on a list row has the same effect and survives a reload", async () => {
  const { context, page, errors } = await openPage();
  try {
    await visit(page, `${web.origin}/career-insights/jobs`);
    const rowStar = page.locator(`[data-catalog-job="${JOB_ID}"] [data-job-star]:visible`);
    await expect(rowStar).toHaveText("收藏");
    await expect(rowStar).toHaveAttribute("data-job-star", "off");
    await rowStar.click();
    await expect(rowStar).toHaveText("已收藏");
    await expect(rowStar).toHaveAttribute("data-job-star", "on");

    await visit(page, `${web.origin}/starred`);
    await expect(page.locator(`[data-starred-job="${JOB_ID}"]`)).toBeVisible();

    // 重新打开岗位列表，compact 按钮从 localStorage 恢复为已收藏。
    await visit(page, `${web.origin}/career-insights/jobs`);
    const reloadedStar = page.locator(`[data-catalog-job="${JOB_ID}"] [data-job-star]:visible`);
    await expect(reloadedStar).toHaveText("已收藏");
    await expect(reloadedStar).toHaveAttribute("data-job-star", "on");

    // 同一份收藏在详情页也是已收藏状态。
    await visit(page, `${web.origin}/career-insights/jobs/${JOB_ID}`);
    await expect(page.locator("[data-job-star]:visible")).toHaveText("已收藏");
    assert.deepEqual(errors, [], "hydration must not log errors");
  } finally {
    await context.close();
  }
});

test("a starred job the api reports missing shows the stale badge and keeps its link", async () => {
  const { context, page, errors } = await openPage();
  try {
    await page.addInitScript(() => {
      localStorage.setItem("aihot-starred-jobs", JSON.stringify([
        { id: "22222222-2222-4222-8222-222222222222", title: "已下架岗位", company: "示例公司", savedAt: "2026-10-01T00:00:00.000Z" },
        { id: "11111111-1111-4111-8111-111111111111", title: "仍在招岗位", company: "示例公司", savedAt: "2026-10-01T00:00:00.000Z" },
      ]));
    });

    // 服务端不知道这个浏览器的收藏，首帧 HTML 不可能带徽标，hydration 也就不会 mismatch。
    const html = await (await fetch(`${web.origin}/starred`)).text();
    assert.equal(html.includes("可能已下架"), false, "the SSR HTML never carries the badge");
    assert.equal(html.includes("data-starred-job-missing"), false, "the SSR HTML never carries the badge attribute");

    await visit(page, `${web.origin}/starred`);
    const staleRow = page.locator(`[data-starred-job="${STALE_JOB_ID}"]`);
    await expect(staleRow).toHaveAttribute("data-starred-job-missing", "true");
    await expect(staleRow).toContainText("可能已下架（仍可移除）");
    // 链接和移除按钮都还在：点进去是详情页自己的 404 页，收藏可以手动清掉。
    await expect(staleRow.getByRole("link", { name: "已下架岗位" })).toHaveAttribute("href", `/career-insights/jobs/${STALE_JOB_ID}`);
    await expect(staleRow.getByRole("button", { name: "移除收藏：已下架岗位" })).toBeVisible();
    // 仍在库内的收藏不显示徽标。
    await expect(page.locator('[data-starred-job-missing="true"]')).toHaveCount(1);
    await expect(page.locator(`[data-starred-job="${JOB_ID}"]`)).toContainText("仍在招岗位");

    await staleRow.getByRole("button", { name: "移除收藏：已下架岗位" }).click();
    await expect(staleRow).toHaveCount(0);
    assert.deepEqual(errors, [], "hydration must not log errors");
  } finally {
    await context.close();
  }
});

test("an availability failure is silent: the list still renders without badges", async () => {
  const { context, page, errors } = await openPage();
  try {
    await page.addInitScript(() => {
      localStorage.setItem("aihot-starred-jobs", JSON.stringify([
        { id: "33333333-3333-4333-8333-333333333333", title: "探测失败的岗位", company: "示例公司", savedAt: "2026-10-01T00:00:00.000Z" },
      ]));
    });
    const failed = page.waitForResponse((response) => response.url().includes("/api/site/career-insights/jobs/availability"));
    await visit(page, `${web.origin}/starred`);
    assert.equal((await failed).status(), 500);

    const row = page.locator(`[data-starred-job="${FAILING_JOB_ID}"]`);
    await expect(row).toBeVisible();
    await expect(row).toContainText("探测失败的岗位");
    await expect(page.locator('[data-starred-job-missing="true"]')).toHaveCount(0);
    assert.deepEqual(errors, [], "hydration must not log errors");
  } finally {
    await context.close();
  }
});

test("a stored legacy id is left out of the probe instead of failing the whole batch", async () => {
  const { context, page, errors } = await openPage();
  try {
    await page.addInitScript(() => {
      localStorage.setItem("aihot-starred-jobs", JSON.stringify([
        { id: "22222222-2222-4222-8222-222222222222", title: "已下架岗位", company: "示例公司", savedAt: "2026-10-01T00:00:00.000Z" },
        // job-favorites 的 ID_PATTERN 允许非 UUID；后端收到它会整批 400，前端必须先过滤。
        { id: "legacy_job_1", title: "旧格式收藏", company: "示例公司", savedAt: "2026-10-01T00:00:00.000Z" },
      ]));
    });
    availabilityProbes = [];
    await visit(page, `${web.origin}/starred`);
    await expect.poll(() => availabilityProbes.length).toBe(1);
    assert.deepEqual(availabilityProbes[0], [STALE_JOB_ID], "only the strict UUID is probed");
    await expect(page.locator('[data-starred-job-missing="true"]')).toHaveCount(1);
    await expect(page.locator(`[data-starred-job="${STALE_JOB_ID}"]`)).toHaveAttribute("data-starred-job-missing", "true");
    // 旧格式 id 的行照常显示，只是不参与探测。
    await expect(page.locator('[data-starred-job="legacy_job_1"]')).toContainText("旧格式收藏");
    assert.deepEqual(errors, [], "hydration must not log errors");
  } finally {
    await context.close();
  }
});

test("availability probes at most 100 ids per request", async () => {
  const { context, page, errors } = await openPage();
  try {
    await page.addInitScript(() => {
      const jobs = Array.from({ length: 101 }, (_, index) => ({
        id: `11111111-1111-4111-8111-${String(index).padStart(12, "0")}`,
        title: `岗位 ${index + 1}`,
        company: "示例公司",
        savedAt: "2026-10-01T00:00:00.000Z",
      }));
      // 第 101 个是已知下架的 id：它在第二批，验证分批后仍然会探测。
      jobs[100]!.id = "22222222-2222-4222-8222-222222222222";
      localStorage.setItem("aihot-starred-jobs", JSON.stringify(jobs));
    });
    availabilityProbes = [];
    await visit(page, `${web.origin}/starred`);
    await expect.poll(() => availabilityProbes.length).toBe(2);
    assert.deepEqual(availabilityProbes.map((batch) => batch.length), [100, 1], "batches of 100, then the remainder");
    assert.equal(availabilityProbes[1]![0], STALE_JOB_ID);
    await expect(page.locator(`[data-starred-job="${STALE_JOB_ID}"]`)).toHaveAttribute("data-starred-job-missing", "true");
    assert.deepEqual(errors, [], "hydration must not log errors");
  } finally {
    await context.close();
  }
});
