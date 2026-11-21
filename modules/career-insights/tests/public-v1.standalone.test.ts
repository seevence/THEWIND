// 公开岗位/政策 API v1（/api/v1/career）：分页与筛选透传、公开字段裁剪、404/400、304 与缓存头。
// 用 Fastify + 假 repository 驱动，不连数据库；真实 SQL 行为由 repository 测试覆盖。
import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";
import type { JobFiltersV1 } from "../contracts/api.ts";
import { DataUnavailableError } from "../backend/errors.ts";
import type { PolicyFiltersV1 } from "../backend/policy-read.ts";
import type { CareerRepository } from "../backend/repository.ts";
import { registerCareerPublicV1 } from "../backend/routes/public-v1.ts";
import { AS_OF, JOB_ID, brief, jobDetail, jobList, policyList, readOnlyRepository } from "./support.ts";

const CACHE = "public, max-age=60, stale-while-revalidate=300";

async function build(repository: CareerRepository, cacheControl?: string) {
  const app = Fastify();
  registerCareerPublicV1(app, repository, cacheControl === undefined ? {} : { cacheControl });
  await app.ready();
  return app;
}

test("岗位列表：默认分页 20、公开字段与公开缓存头", async () => {
  let seen: JobFiltersV1 | undefined;
  const app = await build(readOnlyRepository({ listJobs: async (filters) => ((seen = filters), jobList({ filters })) }));
  const response = await app.inject({ url: "/api/v1/career/jobs" });
  await app.close();

  assert.equal(response.statusCode, 200);
  assert.deepEqual(seen, { page: 1, page_size: 20 });
  const body = response.json();
  assert.equal(body.contract_version, "0.1");
  assert.equal(body.page, 1);
  assert.equal(body.page_size, 20);
  assert.equal(body.total, 1);
  assert.deepEqual(body.items, [
    {
      id: JOB_ID,
      company_name: "示例科技",
      title: "数据分析工程师",
      role_family: "data",
      locations: ["北京"],
      employment_type: "campus",
      student_friendly: "yes",
      skills: ["python", "sql"],
      published_at: null,
      first_seen_at: "2026-11-01T00:00:00.000Z",
      last_seen_at: AS_OF,
      official_url: "https://careers.example/jobs/1",
    },
  ]);
  assert.equal(response.headers["cache-control"], CACHE);
  assert.match(String(response.headers.etag), /^W\/"career-v1-jobs-[0-9a-f]{16}"$/);
  assert.equal(response.headers["vary"], "Accept-Encoding");
  assert.equal(response.headers["access-control-allow-origin"], "*");
  assert.ok(!response.body.includes("raw_text"));
});

test("岗位列表：q、职族、城市、应届友好度、技能与分页都透传给 repository", async () => {
  let seen: JobFiltersV1 | undefined;
  const app = await build(readOnlyRepository({ listJobs: async (filters) => ((seen = filters), jobList({ filters, page: 2, page_size: 5 })) }));
  const query = new URLSearchParams({
    q: " 数据分析 ",
    role_family: "data",
    city: "北京",
    student_friendly: "yes",
    skill: "python",
    page: "2",
    page_size: "5",
  });
  const response = await app.inject({ url: `/api/v1/career/jobs?${query.toString()}` });
  await app.close();

  assert.equal(response.statusCode, 200);
  assert.deepEqual(seen, {
    q: "数据分析",
    role_family: "data",
    city: "北京",
    student_friendly: "yes",
    skill: "python",
    page: 2,
    page_size: 5,
  });
  assert.equal(response.json().page, 2);
  assert.equal(response.json().page_size, 5);
});

test("岗位列表：空白关键词等于没传；上限 100 与非法参数 400（错误 no-store）", async () => {
  let seen: JobFiltersV1 | undefined;
  const app = await build(readOnlyRepository({ listJobs: async (filters) => ((seen = filters), jobList({ filters })) }));

  const blank = await app.inject({ url: "/api/v1/career/jobs?q=%20%20" });
  assert.equal(blank.statusCode, 200);
  assert.deepEqual(seen, { page: 1, page_size: 20 });

  assert.equal((await app.inject({ url: "/api/v1/career/jobs?page_size=100" })).statusCode, 200);

  for (const query of [
    "page_size=0",
    "page_size=101",
    "page=0",
    "page=10001",
    "role_family=not-a-family",
    "student_friendly=maybe",
    "sort=date",
    "q=a&q=b",
    `q=${"a".repeat(101)}`,
  ]) {
    const rejected = await app.inject({ url: `/api/v1/career/jobs?${query}` });
    assert.equal(rejected.statusCode, 400, query);
    assert.equal(rejected.json().error.code, "invalid_parameter", query);
    assert.equal(rejected.headers["cache-control"], "no-store", query);
    assert.equal(rejected.headers.etag, undefined, query);
  }
  await app.close();
});

test("岗位列表：If-None-Match 命中回 304，内容变化后回 200", async () => {
  const app = await build(readOnlyRepository());
  const first = await app.inject({ url: "/api/v1/career/jobs" });
  assert.equal(first.statusCode, 200);
  const etag = String(first.headers.etag);

  const notModified = await app.inject({ url: "/api/v1/career/jobs", headers: { "if-none-match": etag } });
  assert.equal(notModified.statusCode, 304);
  assert.equal(notModified.body, "");
  assert.equal(notModified.headers.etag, etag);
  assert.equal(notModified.headers["cache-control"], CACHE);

  const other = await app.inject({ url: "/api/v1/career/jobs", headers: { "if-none-match": 'W/"career-v1-jobs-0000000000000000"' } });
  assert.equal(other.statusCode, 200);
  await app.close();
});

test("岗位详情：只返回公开字段，不含原始正文、内部来源键与观测表 id", async () => {
  const app = await build(readOnlyRepository({ jobDetail: async () => jobDetail() }));
  const response = await app.inject({ url: `/api/v1/career/jobs/${JOB_ID}` });
  await app.close();

  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.contract_version, "0.1");
  assert.equal(body.job.id, JOB_ID);
  assert.equal(body.job.title, "数据分析工程师");
  assert.equal(body.job.degree, "bachelor");
  assert.deepEqual(body.job.skill_evidence, [{ skill_id: "python", evidence_text: "熟悉 Python" }]);
  assert.deepEqual(body.observations, [
    { observed_at: AS_OF, source_url: "https://careers.example/jobs/1", evidence_excerpt: "岗位职责节选" },
  ]);
  for (const internal of ["raw_text", "raw_payload", "job_key", "source_key", "collector_version", "content_hash", '"id":"42"']) {
    assert.ok(!response.body.includes(internal), `detail leaked ${internal}`);
  }
  assert.equal(response.headers["cache-control"], CACHE);
});

test("岗位详情：没有这个岗位 404、非法 id 与未知参数 400，错误都 no-store", async () => {
  const app = await build(readOnlyRepository({ jobDetail: async () => null }));

  const missing = await app.inject({ url: `/api/v1/career/jobs/${JOB_ID}` });
  assert.equal(missing.statusCode, 404);
  assert.equal(missing.json().error.code, "not_found");
  assert.equal(missing.headers["cache-control"], "no-store");
  assert.equal(missing.headers.etag, undefined);

  for (const url of ["/api/v1/career/jobs/not-a-uuid", `/api/v1/career/jobs/${JOB_ID}?page=1`]) {
    const rejected = await app.inject({ url });
    assert.equal(rejected.statusCode, 400, url);
    assert.equal(rejected.json().error.code, "invalid_parameter", url);
    assert.equal(rejected.headers["cache-control"], "no-store", url);
  }
  await app.close();
});

test("政策列表：分页与公开字段，不含内部 filters 回显", async () => {
  let seen: PolicyFiltersV1 | undefined;
  const app = await build(readOnlyRepository({ listPolicies: async (filters) => ((seen = filters), policyList({ filters })) }));
  const response = await app.inject({ url: "/api/v1/career/policies?page=2&page_size=5" });
  const rejected = await app.inject({ url: "/api/v1/career/policies?page_size=101" });
  await app.close();

  assert.equal(response.statusCode, 200);
  assert.deepEqual(seen, { page: 2, page_size: 5 });
  const body = response.json();
  assert.equal(body.contract_version, "0.1");
  assert.deepEqual(body.items[0], {
    policy_item_id: "policy-1",
    title: "关于促进高校毕业生就业的通知",
    issuer: "示例部门",
    published_at: "2026-11-10",
    official_url: "https://example.gov/policy/1",
    source_tier: "government_official",
    theme_ids: ["employment_promotion"],
    evidence_excerpt: "政策原文节选",
  });
  assert.equal(body.filters, undefined);
  assert.equal(body.total, 1);
  assert.equal(response.headers["cache-control"], CACHE);
  assert.equal(rejected.statusCode, 400);
  assert.equal(rejected.headers["cache-control"], "no-store");
});

test("就业研判：有缓存返回公开研判字段，无缓存 404 no-store", async () => {
  const cached = await build(readOnlyRepository({ careerBrief: async () => brief() }));
  const served = await cached.inject({ url: "/api/v1/career/insights" });
  await cached.close();
  assert.equal(served.statusCode, 200);
  assert.deepEqual(served.json(), brief());
  assert.equal(served.headers["cache-control"], CACHE);
  assert.match(String(served.headers.etag), /^W\/"career-v1-insights-[0-9a-f]{16}"$/);

  const empty = await build(readOnlyRepository({ careerBrief: async () => null }));
  const missing = await empty.inject({ url: "/api/v1/career/insights" });
  await empty.close();
  assert.equal(missing.statusCode, 404);
  assert.equal(missing.json().error.code, "not_found");
  assert.equal(missing.headers["cache-control"], "no-store");
});

test("数据不可用映射 503，未知错误 500 且不外泄内部信息，CORS 头在错误上也在", async () => {
  const unavailable = await build(readOnlyRepository({
    listJobs: async () => {
      throw new DataUnavailableError();
    },
  }));
  const outage = await unavailable.inject({ url: "/api/v1/career/jobs" });
  await unavailable.close();
  assert.equal(outage.statusCode, 503);
  assert.equal(outage.json().error.code, "data_unavailable");
  assert.equal(outage.headers["cache-control"], "no-store");
  assert.equal(outage.headers["access-control-allow-origin"], "*");

  const broken = await build(readOnlyRepository({
    listJobs: async () => {
      throw new Error("database exploded at /internal/path");
    },
  }));
  const failure = await broken.inject({ url: "/api/v1/career/jobs" });
  await broken.close();
  assert.equal(failure.statusCode, 500);
  assert.equal(failure.json().error.code, "internal_error");
  assert.equal(failure.json().error.message, "Internal server error.");
  assert.ok(!failure.body.includes("database exploded"));
});

test("缓存策略可以由接线方传入（测试与灰度用）", async () => {
  const app = await build(readOnlyRepository(), "public, max-age=5");
  const response = await app.inject({ url: "/api/v1/career/jobs" });
  await app.close();
  assert.equal(response.headers["cache-control"], "public, max-age=5");
});
