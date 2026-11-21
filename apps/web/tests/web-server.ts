// Runs the production web server (apps/web/server.ts, after `npm run build -w @aihot/web`) in front of
// a synthetic api, for tests that read pages over HTTP or in a browser; and that api with its reports.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createInterface } from "node:readline";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";
import type { DataRouter } from "react-router";
import type { FeedItemSummary, SiteItemDetail } from "@aihot/contracts/site";
import type { CareerBriefV1, CareerDailyCommentResponseV1 } from "@aihot/career-insights/contracts";
import type { CareerDailyHistoryResponseV1 } from "../../../modules/career-insights/contracts/history.ts";

/** When the synthetic reports were published. */
export const FIXTURE_AT = "2026-10-04T08:00:00.000Z";

/** What /daily-comment answers: the cached fixture, 204 (nothing generated yet), or 500 (the read failed). */
export type CareerDailyCommentAnswer = "missing" | "error" | CareerDailyCommentResponseV1;

export interface CareerApiOverrides {
  dailyComment?: CareerDailyCommentAnswer;
}

/**
 * The career reads the public career pages make. Answers fixtures a page can render without a block
 * falling to "本区块暂时不可用"; `brief` answers 204 (no cached analysis yet) and `dailyComment`
 * answers a cached comment, as the api does. Tests that own a deadline can set `X-Accel-Expires` before
 * calling this.
 */
export function careerApi(url: URL, res: ServerResponse, overrides: CareerApiOverrides = {}): unknown {
  const at = FIXTURE_AT;
  switch (url.pathname) {
    case "/api/site/career-insights/summary":
      return {
        contract_version: "0.1", data_origin: "live", as_of: at, sample_size: 0, company_count: 0, source_count: 0,
        first_observed_at: at, last_observed_at: at, has_multiple_snapshots: false, metrics: [], shared_themes: [],
        dictionary_version: "fixture", warnings: [],
      };
    case "/api/site/career-insights/catalog":
      return { contract_version: "0.1", data_origin: "live", as_of: at, window_days: 30, sample_size: 0, directions: [], titles: [], skills: [] };
    case "/api/site/career-insights/signals":
      return { contract_version: "0.1", data_origin: "live", window_days: 30, signals: [], skipped: [], generated_at: at };
    case "/api/site/career-insights/daily":
      return {
        contract_version: "0.1", data_origin: "live", date: "2026-10-15", sources: [], has_run: true,
        jobs_total: 0, new_jobs_today: 0, new_policies_today: 0, policies_total: 0, unknown_ratio: null, sample_size: 0, generated_at: at,
      };
    case "/api/site/career-insights/jobs":
      return {
        contract_version: "0.1", data_origin: "live", items: [], page: 1, page_size: 20, total: 0, as_of: at,
        filters: { page: 1, page_size: 20 },
      };
    case "/api/site/career-insights/daily-comment":
      // The cached comment the daily page reads; without it the block must not render at all.
      switch (overrides.dailyComment ?? "fixture") {
        case "missing":
          res.statusCode = 204;
          res.end();
          return undefined;
        case "error":
          res.statusCode = 500;
          return { error: { code: "internal_error", message: "fixture" } };
        case "fixture":
          return careerDailyCommentFixture();
        default:
          return overrides.dailyComment;
      }
    case "/api/site/career-insights/daily/history":
      // 往期目录默认是空的：还没有第二期时页面落回「筹备中」空态；要一页历史数据的测试
      // 在自己的 fakeApi 路由里返回 careerDailyHistoryFixture()。
      return careerDailyHistoryFixture();
    case "/api/site/career-insights/brief":
      res.statusCode = 204;
      res.end();
      return undefined;
    default:
      return undefined;
  }
}

/**
 * A cached brief (the api's 200 answer) with five inferences/actions and marker text for the parts
 * only the insights page may show. Tests inject it where the home would otherwise read the 204.
 */
export function careerBriefFixture(overrides: Partial<CareerBriefV1> = {}): CareerBriefV1 {
  const at = FIXTURE_AT;
  return {
    contract_version: "0.1", generated_at: at, as_of: at, sample_size: 12, window_days: 30,
    facts: ["FACT-ONLY-IN-INSIGHTS"],
    inferences: ["INFERENCE-1", "INFERENCE-2", "INFERENCE-3", "INFERENCE-4", "INFERENCE-5"],
    actions: ["ACTION-1", "ACTION-2", "ACTION-3", "ACTION-4", "ACTION-5"],
    evidence: [{ kind: "job", id: "EVIDENCE-ONLY-IN-INSIGHTS", title: "EVIDENCE-ONLY-IN-INSIGHTS" }],
    limitations: ["LIMITATION-ONLY-IN-INSIGHTS"], confidence: "medium",
    ...overrides,
  };
}

/** A page of the daily archive; empty by default so pages fall back to their "being prepared" state. */
export function careerDailyHistoryFixture(overrides: Partial<CareerDailyHistoryResponseV1> = {}): CareerDailyHistoryResponseV1 {
  return {
    contract_version: "0.1",
    data_origin: "live",
    page: 1,
    page_size: 20,
    total: overrides.entries?.length ?? 0,
    entries: [],
    ...overrides,
  };
}

/** One archived day, with the fields a page shows. */
export function careerDailyHistoryEntry(fields: Partial<CareerDailyHistoryResponseV1["entries"][number]> & Pick<CareerDailyHistoryResponseV1["entries"][number], "date">): CareerDailyHistoryResponseV1["entries"][number] {
  return {
    sample_size: 0,
    new_jobs: 0,
    new_policies: 0,
    confidence: null,
    comment_summary: null,
    ...fields,
  };
}

/** A cached daily AI comment (the api's 200 answer) with marker text a page must show only when cached. */
export function careerDailyCommentFixture(overrides: Partial<CareerDailyCommentResponseV1> = {}): CareerDailyCommentResponseV1 {
  return {
    contract_version: "0.1", date: "2026-10-15", as_of: FIXTURE_AT, generated_at: FIXTURE_AT,
    sample_size: 12, new_jobs: 3, confidence: "medium",
    comment: "今日新增岗位集中在 AI 应用开发方向，样本仍以官方招聘页为准。",
    facts: ["今日新增 3 个岗位"], evidence: [],
    ...overrides,
  };
}

/** A report as list cards show it; the fields a test does not name are fixed. */
export function feedItem(fields: Partial<FeedItemSummary> & Pick<FeedItemSummary, "id" | "title">): FeedItemSummary {
  return {
    summary: "固定摘要", reason: "固定推荐理由", source: { name: "Fixture" }, publishedAt: FIXTURE_AT, timelineAt: FIXTURE_AT,
    category: "ai-models", tags: [], score: 80, selected: true, channel: "news", x: null, ...fields,
  };
}

/** A report as its article page shows it; the fields a test does not name are fixed. */
export function itemDetail(fields: Partial<SiteItemDetail> & Pick<SiteItemDetail, "id" | "title">): SiteItemDetail {
  return {
    ...feedItem({ id: fields.id, title: fields.title }), x: null, originalTitle: null, links: { original: "https://example.org/article" },
    discoveredAt: FIXTURE_AT, story: null, readingMode: "full", author: null,
    body: { zh: "<p>固定正文</p>", original: null, zhKind: "translation", complete: true },
    outline: [], relatedStories: [], topics: [], tagTopics: {}, daily: null, indexable: true, googleNoindex: false, markdownAvailable: true, group: null, hasTranslation: true, bodyLanguage: "zh", mentions: [],
    ...fields,
  };
}

/**
 * A synthetic api. `route` answers first: a value it returns is sent as JSON (with any status it set), and
 * a response it ends itself is left alone. What it leaves unanswered gets the reads every page makes (site
 * metadata, the analytics beacon, health), and anything else a 404.
 */
export function fakeApi(route: (url: URL, res: ServerResponse, req: IncomingMessage) => unknown = () => undefined): Server {
  return createServer(async (req, res) => {
    const url = new URL(req.url!, `http://${req.headers.host}`);
    res.setHeader("Content-Type", "application/json");
    const body = await route(url, res, req);
    if (res.writableEnded) return;
    if (body !== undefined) return res.end(JSON.stringify(body));
    if (url.pathname === "/api/site/meta") return res.end(JSON.stringify({ changelogVersion: "fixture" }));
    if (url.pathname === "/api/site/track") { res.statusCode = 204; return res.end(); }
    if (url.pathname === "/api/health") return res.end("{}");
    const career = careerApi(url, res);
    if (res.writableEnded) return;
    if (career !== undefined) return res.end(JSON.stringify(career));
    res.statusCode = 404;
    res.end(JSON.stringify({ code: "not_found" }));
  });
}

export interface WebServer {
  origin: string;
  port: number;
  /** What the server wrote to stderr so far: its error lines. */
  logs: () => string;
  /** Stops the web server and the api. */
  stop: () => Promise<void>;
}

/** Starts `api` and a web server that reads it. `env` adds to or overrides the web server's environment. */
export async function startWebServer(api: Server, env: NodeJS.ProcessEnv = {}): Promise<WebServer> {
  api.listen(0, "127.0.0.1");
  await once(api, "listening");
  let logs = "";
  const web = spawn(process.execPath, [fileURLToPath(new URL("../server.ts", import.meta.url))], {
    env: { ...process.env, WEB_PORT: "0", SITE_URL: "http://127.0.0.1:0", TRUST_PROXY: "false", API_BASE_URL: `http://127.0.0.1:${(api.address() as AddressInfo).port}`, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stop = async () => {
    if (web.exitCode === null) {
      web.kill("SIGTERM");
      await once(web, "exit");
    }
    api.closeAllConnections();
    await new Promise<void>((resolve) => api.close(() => resolve()));
  };
  let port: number;
  try {
    port = await new Promise<number>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`web did not start: ${logs}`)), 15_000);
      web.once("exit", () => { clearTimeout(timeout); reject(new Error(`web exited: ${logs}`)); });
      web.stderr!.on("data", (chunk) => { logs += String(chunk); });
      const output = createInterface({ input: web.stdout! });
      output.on("line", line => {
        const record = JSON.parse(line);
        if (record.msg === "web started") { clearTimeout(timeout); output.close(); web.stdout!.resume(); resolve(record.port); }
      });
    });
  } catch (error) {
    await stop();
    throw error;
  }
  return { origin: `http://127.0.0.1:${port}`, port, logs: () => logs, stop };
}

/**
 * Opens `url` for a test that acts on the page; reading the server's HTML needs only `goto`. `goto` resolves
 * at the load event, but the client entry is imported after it and can run later: a press before hydration
 * reaches no handler, and going offline before then leaves the page without its client data. The router is
 * initialized once hydration has run each route's client loader on the HTML's own result.
 */
export async function visit(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await page.waitForFunction(() => (globalThis as { __reactRouterDataRouter?: DataRouter }).__reactRouterDataRouter?.state.initialized);
}
