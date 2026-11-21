// 后台「就业数据」页（/admin/career）：SSR 读 /api/admin/career 后分卡片展示采集运行、来源健康、
// LLM 兜底、研判/评论与数据规模；接口失败或未接线时整页降级为「数据暂不可用」但仍 200。
// 用生产 web 服务器 + 合成 api 验证渲染，不碰真库、不调模型。Run after `npm run build -w @aihot/web`.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { CareerAdminOverview } from "@aihot/career-insights/contracts";
import { fakeApi, startWebServer } from "./web-server.ts";

const overview: CareerAdminOverview = {
  generated_at: "2026-11-21T06:14:00.000Z",
  ingest: {
    ok: true,
    data: {
      runs: [
        {
          id: "run-1", kind: "jobs", source_key: "tencent-official-careers", source_label: "腾讯官方招聘",
          status: "ok", fetched_at: "2026-11-21T06:10:30.000Z", job_count: 10, accepted: 3,
          updated: 5, duplicates: 2, rejected: 0, error: null,
        },
      ],
    },
  },
  sources: {
    ok: true,
    data: [
      {
        source_key: "tencent-official-careers", source_label: "腾讯官方招聘", kind: "jobs",
        last_status: "ok", last_fetched_at: "2026-11-21T06:10:30.000Z", last_accepted: 3,
        last_error: null, last_ok_at: "2026-11-21T06:10:30.000Z", last_ok_accepted: 3, failed_runs: 0,
      },
    ],
  },
  llm: {
    ok: true,
    data: {
      job: "career.ingest", status: "ok",
      started_at: "2026-11-21T06:10:00.000Z", finished_at: "2026-11-21T06:14:00.000Z", error: null,
      llm: {
        ok: true, candidates: 12, called: 12, changed: 9, failed: 0, calls: 12, retries: 0,
        usage: { prompt_tokens: 1200, completion_tokens: 300 },
        budget: { max_rows: 80, max_prompt_tokens: 120000, rows: 12, prompt_tokens_estimated: 1200 },
        stopped_by_budget: null, skipped: { rows: 0, reason: null }, duration_ms: 90000, exit_code: 0, error: null,
      },
      brief: {
        ok: true, skipped: false, reason: null, as_of: "2026-11-21T01:29:00.000Z", sample_size: 222,
        observation_days: 3, confidence: "medium", receipt_id: 331, model: "deepseek-flash",
        duration_ms: 12000, exit_code: 0, error: null,
      },
      comment: {
        ok: true, skipped: false, reason: null, date: "2026-11-21", as_of: "2026-11-21T02:00:00.000Z",
        sample_size: 60, new_jobs: 34, confidence: "medium", receipt_id: 334, model: "deepseek-flash",
        duration_ms: 8000, exit_code: 0, error: null,
      },
    },
  },
  briefs: {
    ok: true,
    data: [
      {
        prompt_version: "career-brief/2", as_of: "2026-11-21T01:29:00.000Z", generated_at: "2026-11-21T01:29:00.000Z",
        confidence: "medium", sample_size: 222, window_days: 30, observation_days: 3, receipt_id: 331, model: "deepseek-flash",
      },
    ],
  },
  comments: {
    ok: true,
    data: [
      {
        prompt_version: "career-daily-comment/2", date: "2026-11-21", as_of: "2026-11-21T02:00:00.000Z",
        generated_at: "2026-11-21T02:00:00.000Z", confidence: "medium", sample_size: 60, new_jobs: 34,
        receipt_id: 334, model: "deepseek-flash",
      },
    ],
  },
  scale: {
    ok: true,
    data: {
      jobs: 188, observations: 440, policies: 6, briefs: 1, comments: 1, observed_days: 3,
      latest_observation_at: "2026-11-21T01:00:00.000Z", latest_job_seen_at: "2026-11-21T01:00:00.000Z",
      latest_policy_seen_at: "2026-11-20T08:00:00.000Z", latest_policy_published_at: "2026-11-19",
    },
  },
};

type CareerAnswer = "ok" | "error" | CareerAdminOverview;

/** 合成 api：后台 layout 要的身份/角标 + 本页要的 /api/admin/career。 */
function adminApi(career: CareerAnswer = "ok") {
  return fakeApi((url, res) => {
    if (url.pathname === "/api/admin/me") return { name: "管理员", csrf: "csrf", dev: true };
    if (url.pathname === "/api/admin/nav-counts") return {};
    if (url.pathname === "/api/admin/career") {
      if (career === "error") {
        res.statusCode = 500;
        return { detail: "database unavailable" };
      }
      return career === "ok" ? overview : career;
    }
    return undefined;
  });
}

async function careerPage(career: CareerAnswer = "ok"): Promise<{ status: number; rendered: string }> {
  const api = adminApi(career);
  const web = await startWebServer(api);
  try {
    const response = await fetch(`${web.origin}/admin/career`);
    const html = await response.text();
    // Adjacent JSX text nodes are split by comment markers in SSR; the rendered sentence still reads whole.
    return { status: response.status, rendered: html.replace(/<!--[\s\S]*?-->/g, "") };
  } finally {
    await web.stop();
  }
}

test("the career admin page renders the ingest, LLM fallback, brief/comment and scale cards", async () => {
  const { status, rendered } = await careerPage();
  assert.equal(status, 200);

  for (const title of ["就业数据", "采集运行", "来源健康", "LLM 兜底", "最近研判", "最近日报评论", "数据规模与新鲜度"]) {
    assert.match(rendered, new RegExp(title), `missing card: ${title}`);
  }
  // Collection run and per-source health.
  assert.match(rendered, /腾讯官方招聘/);
  assert.match(rendered, /career\.ingest/);
  // LLM fallback numbers come from job_runs.detail.llm.
  assert.match(rendered, /候选行/);
  assert.match(rendered, /写回/);
  assert.match(rendered, /约 1,200\/120,000 prompt token/);
  // Cached brief/comment versions, confidences and receipts.
  assert.match(rendered, /career-brief\/2/);
  assert.match(rendered, /career-daily-comment\/2/);
  assert.match(rendered, /#331/);
  assert.match(rendered, /#334/);
  // Data scale.
  assert.match(rendered, /最近岗位观测/);
  assert.match(rendered, /2026-11-19/);
  assert.doesNotMatch(rendered, /数据暂不可用/);
});

test("a failed or unwired admin API degrades to 数据暂不可用 instead of failing the page", async () => {
  const { status, rendered } = await careerPage("error");
  assert.equal(status, 200, "one failed admin read is not a page error");
  assert.match(rendered, /数据暂不可用/);
  assert.doesNotMatch(rendered, /采集运行/);
});

test("one failed section shows 数据暂不可用 in its card while the others still render", async () => {
  const degraded: CareerAdminOverview = { ...overview, ingest: { ok: false, error: "relation career_ingest_runs does not exist" } };
  const { status, rendered } = await careerPage(degraded);
  assert.equal(status, 200);
  assert.match(rendered, /采集运行/);
  assert.match(rendered, /数据暂不可用/);
  assert.match(rendered, /来源健康/, "the other cards still render");
  assert.match(rendered, /腾讯官方招聘/);
});
