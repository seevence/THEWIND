// 收藏页的岗位可用性接口：收藏快照只存在浏览器本地，页面用一次批量请求判断哪些岗位的详情页还在。
// 这里用真实库表证明查询与 jobDetail 的可见性一致（存在即 visible、未知即 missing），
// 并用 Fastify inject 覆盖参数校验、去重、200 上限与 no-store；不返回岗位的其它字段。
import { createHash, randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import Fastify from "fastify";
import { closeDb, sql } from "@aihot/backend/db";
import type { NormalizedJobV1 } from "../contracts/index.ts";
import { registerCareerHttp } from "../backend/http.ts";
import { SqlCareerRepository } from "../backend/sql-repository.ts";
import { ingestBatch } from "../backend/ingest.ts";
import { NORMALIZER_VERSION } from "../data/normalize.ts";

const repository = new SqlCareerRepository(sql);
const digest = (seed: string) => createHash("sha256").update(seed).digest("hex");
const missingId = () => randomUUID();

function job(overrides: Partial<NormalizedJobV1> = {}): NormalizedJobV1 {
  return {
    schema_version: "1.0",
    normalizer_version: NORMALIZER_VERSION,
    source_key: "career-availability-test",
    job_key: "job-1",
    company_name: "测试科技有限公司",
    title: "AI 应用开发工程师",
    official_url: "https://careers.example/jobs/job-1",
    role_family: "ai_application_development",
    locations: ["北京"],
    degree: "bachelor",
    degree_raw: "本科",
    experience_min_years: 0,
    experience_max_years: 3,
    experience_raw: "1-3 年",
    employment_type: "campus",
    student_friendly: "yes",
    skills: ["python"],
    skill_evidence: [{ skill_id: "python", evidence_text: "熟悉 Python" }],
    published_at: null,
    fetched_at: "2026-01-01T00:00:00.000Z",
    collector_version: "test-collector-1",
    content_hash: digest("job-1"),
    raw_text: "岗位文本",
    raw_payload: { id: "job-1" },
    ...overrides,
  };
}

async function seed(...jobs: NormalizedJobV1[]): Promise<void> {
  await ingestBatch(sql, {
    schema_version: "1.0",
    source_key: "career-availability-test",
    fetched_at: jobs[0]!.fetched_at,
    collector_version: "test-collector-1",
    jobs,
  });
}

async function seededJobId(): Promise<string> {
  await seed(job());
  const [row] = await sql<{ id: string }[]>`SELECT id::text AS id FROM career_jobs WHERE job_key = 'job-1'`;
  return row!.id;
}

async function build() {
  const app = Fastify();
  registerCareerHttp(app, repository);
  await app.ready();
  return app;
}

function availabilityUrl(ids: string[]): string {
  return `/api/site/career-insights/jobs/availability?ids=${encodeURIComponent(ids.join(","))}`;
}

beforeEach(async () => {
  await sql`TRUNCATE career_job_observations, career_jobs, career_policies, career_ingest_runs RESTART IDENTITY`;
});

after(async () => {
  await closeDb();
});

test("a stored job is visible and an unknown id is missing, with no other fields exposed", async () => {
  const id = await seededJobId();
  const unknown = missingId();

  const answer = await repository.jobAvailability([id, unknown]);

  assert.deepEqual(answer, {
    contract_version: "0.1",
    ids: { [id]: "visible", [unknown]: "missing" },
  });
});

test("duplicate ids collapse to one answer and UUID casing does not matter", async () => {
  const id = await seededJobId();

  const answer = await repository.jobAvailability([id, id, id.toUpperCase()]);

  assert.deepEqual(answer.ids, { [id]: "visible" });
});

test("the route answers every requested id and is no-store", async () => {
  const id = await seededJobId();
  const unknown = missingId();
  const app = await build();
  try {
    const response = await app.inject({ url: availabilityUrl([id, unknown]) });

    assert.equal(response.statusCode, 200);
    assert.equal(response.headers["cache-control"], "no-store");
    assert.deepEqual(response.json(), {
      contract_version: "0.1",
      ids: { [id]: "visible", [unknown]: "missing" },
    });
  } finally {
    await app.close();
  }
});

test("the route rejects a missing, empty, malformed or oversized ids parameter", async () => {
  const app = await build();
  try {
    for (const url of [
      "/api/site/career-insights/jobs/availability",
      "/api/site/career-insights/jobs/availability?ids=",
      "/api/site/career-insights/jobs/availability?ids=%20",
      "/api/site/career-insights/jobs/availability?ids=not-a-uuid",
      `/api/site/career-insights/jobs/availability?ids=${missingId()},,%20`,
      "/api/site/career-insights/jobs/availability?ids=1",
      "/api/site/career-insights/jobs/availability?ids=00000000-0000-4000-8000-00000000000",
    ]) {
      const response = await app.inject({ url });
      assert.equal(response.statusCode, 400, url);
      assert.equal(response.json().error.code, "invalid_parameter", url);
      assert.equal(response.headers["cache-control"], "no-store", url);
    }

    const unsupported = await app.inject({ url: `${availabilityUrl([missingId()])}&limit=1` });
    assert.equal(unsupported.statusCode, 400);
    assert.equal(unsupported.json().error.code, "invalid_parameter");

    // 去重后恰好 200 个可以接受；再多一个就是 400。
    const ids = Array.from({ length: 200 }, () => missingId());
    const atLimit = await app.inject({ url: availabilityUrl(ids) });
    assert.equal(atLimit.statusCode, 200);
    assert.equal(Object.keys(atLimit.json().ids).length, 200);

    const withDuplicate = await app.inject({ url: availabilityUrl([...ids, ids[0]!]) });
    assert.equal(withDuplicate.statusCode, 200, "duplicates do not count toward the limit");

    const overLimit = await app.inject({ url: availabilityUrl([...ids, missingId()]) });
    assert.equal(overLimit.statusCode, 400);
    assert.equal(overLimit.json().error.code, "invalid_parameter");
  } finally {
    await app.close();
  }
});
test("an uppercase UUID is answered under its lowercase key", async () => {
  const id = await seededJobId();
  const app = await build();
  try {
    const response = await app.inject({ url: availabilityUrl([id.toUpperCase()]) });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { contract_version: "0.1", ids: { [id]: "visible" } });
  } finally {
    await app.close();
  }
});

test("repeated ids query parameters are rejected instead of silently merged", async () => {
  const app = await build();
  try {
    const response = await app.inject({
      url: `/api/site/career-insights/jobs/availability?ids=${missingId()}&ids=${missingId()}`,
    });

    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error.code, "invalid_parameter");
    assert.equal(response.headers["cache-control"], "no-store");
  } finally {
    await app.close();
  }
});
