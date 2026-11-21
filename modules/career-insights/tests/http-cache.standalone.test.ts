// /api/site/career-insights 的缓存分级：公开列表/详情/目录/洞察带 public 缓存与 ETag（304），
// 收藏探测、204、错误仍是 no-store。这里用假 repository 驱动 Fastify，不连数据库。
import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";
import { DataUnavailableError } from "../backend/errors.ts";
import { PUBLIC_CACHE_CONTROL, registerCareerHttp } from "../backend/http.ts";
import type { CareerRepository } from "../backend/repository.ts";
import { JOB_ID, readOnlyRepository } from "./support.ts";

const CACHE = "public, max-age=60, stale-while-revalidate=300";

async function build(repository: CareerRepository) {
  const app = Fastify();
  registerCareerHttp(app, repository);
  await app.ready();
  return app;
}

const READ_URLS = [
  "/api/site/career-insights/summary",
  "/api/site/career-insights/jobs",
  `/api/site/career-insights/jobs/${JOB_ID}`,
  "/api/site/career-insights/policies",
  "/api/site/career-insights/hot",
  "/api/site/career-insights/daily",
  "/api/site/career-insights/daily-comment",
  "/api/site/career-insights/signals",
  "/api/site/career-insights/catalog",
  "/api/site/career-insights/brief",
];

test("公开只读端点：public 缓存 + 弱 ETag，If-None-Match 命中 304", async () => {
  assert.equal(PUBLIC_CACHE_CONTROL, CACHE);
  const app = await build(readOnlyRepository());
  try {
    for (const url of READ_URLS) {
      const first = await app.inject({ url });
      assert.equal(first.statusCode, 200, url);
      assert.equal(first.headers["cache-control"], CACHE, url);
      assert.match(String(first.headers.etag), /^W\/"career-[a-z-]+-[0-9a-f]{16}"$/, url);
      assert.equal(first.headers["vary"], "Accept-Encoding", url);

      const notModified = await app.inject({ url, headers: { "if-none-match": String(first.headers.etag) } });
      assert.equal(notModified.statusCode, 304, url);
      assert.equal(notModified.body, "", url);
      assert.equal(notModified.headers["cache-control"], CACHE, url);
      assert.equal(notModified.headers.etag, first.headers.etag, url);
    }
  } finally {
    await app.close();
  }
});

test("内容变化后 ETag 变化，条件请求重新拿到 200", async () => {
  let title = "数据分析工程师";
  const app = await build(readOnlyRepository({
    listJobs: async (filters) => ({
      contract_version: "0.1",
      data_origin: "live",
      items: [{
        id: JOB_ID,
        company_name: "示例科技",
        title,
        role_family: "data",
        locations: ["北京"],
        employment_type: "campus",
        student_friendly: "yes",
        skills: ["python"],
        published_at: null,
        first_seen_at: "2026-11-01T00:00:00.000Z",
        last_seen_at: "2026-11-21T00:00:00.000Z",
        official_url: "https://careers.example/jobs/1",
      }],
      page: 1,
      page_size: 20,
      total: 1,
      as_of: "2026-11-21T00:00:00.000Z",
      filters,
    }),
  }));
  try {
    const first = await app.inject({ url: "/api/site/career-insights/jobs" });
    const etag = String(first.headers.etag);
    title = "数据分析专家";
    const changed = await app.inject({ url: "/api/site/career-insights/jobs", headers: { "if-none-match": etag } });
    assert.equal(changed.statusCode, 200);
    assert.notEqual(changed.headers.etag, etag);
  } finally {
    await app.close();
  }
});

test("收藏探测保持 no-store 且没有 ETag", async () => {
  const app = await build(readOnlyRepository());
  try {
    const response = await app.inject({ url: `/api/site/career-insights/jobs/availability?ids=${JOB_ID}` });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers["cache-control"], "no-store");
    assert.equal(response.headers.etag, undefined);
  } finally {
    await app.close();
  }
});

test("缓存未生成的 204 与参数错误、数据不可用保持 no-store", async () => {
  const empty = await build(readOnlyRepository({
    careerBrief: async () => null,
    careerDailyComment: async () => null,
  }));
  try {
    for (const url of ["/api/site/career-insights/brief", "/api/site/career-insights/daily-comment"]) {
      const response = await empty.inject({ url });
      assert.equal(response.statusCode, 204, url);
      assert.equal(response.headers["cache-control"], "no-store", url);
      assert.equal(response.headers.etag, undefined, url);
    }
  } finally {
    await empty.close();
  }

  const broken = await build(readOnlyRepository({
    listPolicies: async () => {
      throw new DataUnavailableError();
    },
  }));
  try {
    const rejected = await broken.inject({ url: "/api/site/career-insights/jobs?page_size=101" });
    assert.equal(rejected.statusCode, 400);
    assert.equal(rejected.headers["cache-control"], "no-store");
    assert.equal(rejected.headers.etag, undefined);

    const outage = await broken.inject({ url: "/api/site/career-insights/policies" });
    assert.equal(outage.statusCode, 503);
    assert.equal(outage.json().error.code, "data_unavailable");
    assert.equal(outage.headers["cache-control"], "no-store");
    assert.equal(outage.headers.etag, undefined);
  } finally {
    await broken.close();
  }
});
