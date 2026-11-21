// The career integration checker accepts a real shape only with --require-data: a non-empty,
// non-fixture sample plus one job detail carrying observation evidence. The pre-data mode keeps
// accepting 503 and does not ask for a detail. A local HTTP server answers; no database or site.
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, test } from "node:test";
import { CAREER_CONTRACT_VERSION } from "@aihot/career-insights/contracts";
import { checkCareerSite } from "../scripts/check-career-integration.ts";

interface ResponseSpec {
  status: number;
  contentType: string;
  body: string;
}

type Results = Awaited<ReturnType<typeof checkCareerSite>>;

const PATHS = {
  health: "/api/health",
  page: "/career-insights",
  summary: "/api/site/career-insights/summary",
  jobs: "/api/site/career-insights/jobs",
  detail: "/api/site/career-insights/jobs/job-1",
  invalidId: "/api/site/career-insights/jobs/not-a-uuid",
};

const json = (body: unknown, status = 200): ResponseSpec => ({ status, contentType: "application/json", body: JSON.stringify(body) });
const html = (body: string, status = 200): ResponseSpec => ({ status, contentType: "text/html; charset=utf-8", body });

const metric = {
  metric_id: "skill_demand",
  version: "1.0",
  label: "技能需求",
  unit: "ratio",
  status: "ok",
  value: 0.4,
  numerator_count: 8,
  denominator_count: 20,
  sample_size: 20,
  as_of: "2026-11-16T00:00:00Z",
  dimension: {},
  evidence: [],
  disclaimer: "",
};

const jobItem = {
  id: "job-1",
  company_name: "示例公司",
  title: "AI 应用工程师",
  role_family: "engineering",
  locations: ["深圳"],
  employment_type: "full_time",
  student_friendly: "no",
  skills: [],
  published_at: null,
  first_seen_at: "2026-11-01T00:00:00Z",
  last_seen_at: "2026-11-15T00:00:00Z",
  official_url: "https://careers.example.invalid/jobs/1",
};

const summaryBody = (patch: Record<string, unknown> = {}) => ({
  contract_version: CAREER_CONTRACT_VERSION,
  data_origin: "live",
  as_of: "2026-11-16T00:00:00Z",
  sample_size: 20,
  company_count: 5,
  source_count: 1,
  first_observed_at: "2026-11-01T00:00:00Z",
  last_observed_at: "2026-11-15T00:00:00Z",
  has_multiple_snapshots: true,
  metrics: [metric],
  shared_themes: [],
  dictionary_version: "d1",
  warnings: [],
  ...patch,
});

const jobsBody = (patch: Record<string, unknown> = {}) => ({
  contract_version: CAREER_CONTRACT_VERSION,
  data_origin: "live",
  items: [jobItem],
  page: 1,
  page_size: 20,
  total: 1,
  as_of: "2026-11-16T00:00:00Z",
  filters: { page: 1, page_size: 20 },
  ...patch,
});

const detailBody = (patch: Record<string, unknown> = {}) => ({
  contract_version: CAREER_CONTRACT_VERSION,
  data_origin: "live",
  job: {
    ...jobItem,
    source_key: "source-1",
    job_key: "job-1",
    degree: "bachelor",
    degree_raw: null,
    experience_min_years: null,
    experience_max_years: null,
    experience_raw: null,
    skill_evidence: [],
    collector_version: "collector-1",
  },
  observations: [
    {
      id: "observation-1",
      observed_at: "2026-11-01T00:00:00Z",
      content_hash: "hash-1",
      collector_version: "collector-1",
      source_url: "https://careers.example.invalid/jobs/1",
      evidence_excerpt: "AI 应用工程师",
    },
  ],
  notice: "",
  ...patch,
});

const invalidIdBody = { error: { code: "invalid_parameter", message: "非法 id" } };

const realSite = (patch: Record<string, ResponseSpec> = {}): Record<string, ResponseSpec> => ({
  [PATHS.health]: json({ ok: true, db: "ok" }),
  [PATHS.page]: html("<main>职业洞察</main>"),
  [PATHS.summary]: json(summaryBody()),
  [PATHS.jobs]: json(jobsBody()),
  [PATHS.detail]: json(detailBody()),
  [PATHS.invalidId]: json(invalidIdBody, 400),
  ...patch,
});

const preDataSite = (): Record<string, ResponseSpec> => ({
  [PATHS.health]: json({ ok: true, db: "ok" }),
  [PATHS.page]: html("<main>职业洞察</main><p>数据尚未就绪</p>", 503),
  [PATHS.summary]: json({ error: { code: "data_unavailable", message: "尚无数据" } }, 503),
  [PATHS.jobs]: json({ error: { code: "data_unavailable", message: "尚无数据" } }, 503),
  [PATHS.invalidId]: json(invalidIdBody, 400),
});

let server: Server;
let base: string;
let responses: Record<string, ResponseSpec>;
const requests: string[] = [];

before(async () => {
  server = createServer((req, res) => {
    const url = req.url ?? "";
    requests.push(url);
    const spec = responses[url];
    if (!spec) {
      res.writeHead(404, { "content-type": "text/plain" }).end("not found");
      return;
    }
    res.writeHead(spec.status, { "content-type": spec.contentType }).end(spec.body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))));

beforeEach(() => {
  responses = {};
  requests.length = 0;
});

const reasonFor = (results: Results, path: string): string => {
  const found = results.find((result) => result.path === path);
  assert.ok(found, `missing result line for ${path} in ${results.map((result) => result.path).join(", ")}`);
  assert.notEqual(found.reason, null, `${path} passed but was expected to fail`);
  return found.reason!;
};

test("--require-data passes a complete real shape and verifies the first job detail", async () => {
  responses = realSite();
  const results = await checkCareerSite(base, { requireData: true });
  assert.deepEqual(
    results.map((result) => result.path),
    [PATHS.health, PATHS.page, PATHS.summary, PATHS.jobs, PATHS.detail, PATHS.invalidId],
  );
  assert.deepEqual(results.map((result) => result.reason), [null, null, null, null, null, null]);
  assert.ok(requests.includes(PATHS.detail));
});

test("--require-data encodes the id it fetches for the detail", async () => {
  const encoded = "/api/site/career-insights/jobs/job%201";
  responses = realSite({
    [PATHS.jobs]: json(jobsBody({ items: [{ ...jobItem, id: "job 1" }] })),
    [encoded]: json(detailBody({ job: { ...jobItem, id: "job 1" } })),
  });
  const results = await checkCareerSite(base, { requireData: true });
  assert.ok(results.every((result) => result.reason === null), JSON.stringify(results));
  assert.ok(requests.includes(encoded));
});

test("--require-data rejects an empty or synthetic summary sample", async () => {
  const cases: Array<[Record<string, unknown>, RegExp]> = [
    [{ sample_size: 0 }, /^sample_size is 0, expected a number > 0$/],
    [{ company_count: 0 }, /^company_count is 0, expected a number > 0$/],
    [{ metrics: [] }, /^metrics is \[\], expected a non-empty array$/],
    [{ data_origin: "synthetic_fixture" }, /^data_origin is "synthetic_fixture", expected real data$/],
    [{ warnings: [{ code: "synthetic_fixture", message: "联调样例" }] }, /^warnings contains code "synthetic_fixture"/],
  ];
  for (const [patch, expected] of cases) {
    responses = realSite({ [PATHS.summary]: json(summaryBody(patch)) });
    const results = await checkCareerSite(base, { requireData: true });
    assert.match(reasonFor(results, PATHS.summary), expected, JSON.stringify(patch));
  }
});

test("--require-data rejects an empty jobs list and skips the detail", async () => {
  const cases: Array<[Record<string, unknown>, RegExp]> = [
    [{ items: [], total: 0 }, /^items is \[\], expected a non-empty array$/],
    [{ total: 0 }, /^total is 0, expected a number > 0$/],
    [{ data_origin: "synthetic_fixture" }, /^data_origin is "synthetic_fixture", expected real data$/],
  ];
  for (const [patch, expected] of cases) {
    responses = realSite({ [PATHS.jobs]: json(jobsBody(patch)) });
    const results = await checkCareerSite(base, { requireData: true });
    assert.match(reasonFor(results, PATHS.jobs), expected, JSON.stringify(patch));
    const skipped = results.find((result) => result.path === "/api/site/career-insights/jobs/<id>");
    assert.ok(skipped, "missing skipped detail line");
    assert.equal(skipped.reason, "skipped: jobs list has no usable item");
    assert.ok(!requests.includes(PATHS.detail));
  }
});

test("--require-data rejects the first job without display fields", async () => {
  for (const field of ["id", "company_name", "title", "official_url", "first_seen_at", "last_seen_at"]) {
    const item: Record<string, unknown> = { ...jobItem };
    delete item[field];
    responses = realSite({ [PATHS.jobs]: json(jobsBody({ items: [item] })) });
    const results = await checkCareerSite(base, { requireData: true });
    assert.match(
      reasonFor(results, PATHS.jobs),
      new RegExp(`^items\\[0\\]\\.${field} is undefined, expected a non-empty string$`),
      field,
    );
    assert.ok(!requests.includes(PATHS.detail), field);
  }
});

test("--require-data rejects a detail without observation evidence", async () => {
  const cases: Array<[Record<string, unknown>, RegExp]> = [
    [{ observations: [] }, /^observations is \[\], expected a non-empty array$/],
    [
      { observations: [{ id: "observation-1", observed_at: "2026-11-01T00:00:00Z", content_hash: "", collector_version: "collector-1", source_url: "https://careers.example.invalid/jobs/1" }] },
      /^observations\[0\]\.content_hash is "", expected a non-empty string$/,
    ],
    [{ job: { ...jobItem, id: "job-2" } }, /^job\.id is "job-2", expected "job-1"$/],
    [{ data_origin: "synthetic_fixture" }, /^data_origin is "synthetic_fixture", expected real data$/],
  ];
  for (const [patch, expected] of cases) {
    responses = realSite({ [PATHS.detail]: json(detailBody(patch)) });
    const results = await checkCareerSite(base, { requireData: true });
    assert.match(reasonFor(results, PATHS.detail), expected, JSON.stringify(patch));
    assert.ok(requests.includes(PATHS.detail));
  }
});

test("--require-data rejects a missing detail", async () => {
  responses = realSite({ [PATHS.detail]: json({ error: { code: "data_unavailable", message: "尚无数据" } }, 503) });
  const results = await checkCareerSite(base, { requireData: true });
  assert.match(reasonFor(results, PATHS.detail), /^HTTP 503, expected 200 \(--require-data\)$/);
});

test("--require-data rejects a pre-data site", async () => {
  responses = preDataSite();
  const results = await checkCareerSite(base, { requireData: true });
  assert.match(reasonFor(results, PATHS.page), /^HTTP 503, but --require-data expects real data$/);
  assert.match(reasonFor(results, PATHS.summary), /^HTTP 503, expected 200 \(--require-data\)$/);
  assert.match(reasonFor(results, PATHS.jobs), /^HTTP 503, expected 200 \(--require-data\)$/);
  const skipped = results.find((result) => result.path === "/api/site/career-insights/jobs/<id>");
  assert.equal(skipped?.reason, "skipped: jobs list has no usable item");
  assert.equal(results.find((result) => result.path === PATHS.invalidId)?.reason, null);
});

test("without --require-data a pre-data site still passes and no detail is fetched", async () => {
  responses = preDataSite();
  const results = await checkCareerSite(base);
  assert.equal(results.length, 5);
  assert.deepEqual(results.map((result) => result.reason), [null, null, null, null, null]);
  assert.ok(!requests.includes(PATHS.detail));
});

test("without --require-data a 200 needs only the contract version and arrays", async () => {
  responses = realSite({
    [PATHS.summary]: json(summaryBody({ sample_size: 0, company_count: 0, metrics: [], data_origin: "synthetic_fixture" })),
    [PATHS.jobs]: json(jobsBody({ items: [], total: 0 })),
  });
  const results = await checkCareerSite(base);
  assert.deepEqual(results.map((result) => result.reason), [null, null, null, null, null]);
});