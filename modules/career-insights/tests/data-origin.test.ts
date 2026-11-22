// data_origin is a contract value on all three read endpoints; these tests pin what each endpoint
// reports so a real live run cannot silently degrade into an import claim or the reverse.
import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import type { DataOrigin, NormalizedJobV1 } from "../contracts/index.ts";
import { ingestBatch } from "../backend/ingest.ts";
import { NORMALIZER_VERSION } from "../data/index.ts";
import { SqlCareerRepository } from "../backend/sql-repository.ts";

const FETCHED_AT = "2026-11-19T08:08:00.000Z";
const repository = new SqlCareerRepository(sql);

function job(overrides: Partial<NormalizedJobV1> = {}): NormalizedJobV1 {
  return {
    schema_version: "1.0",
    normalizer_version: NORMALIZER_VERSION,
    source_key: "iflytek-official-careers",
    job_key: "job-1",
    company_name: "甲科技有限公司",
    title: "机器学习工程师",
    official_url: "https://careers.example/jobs/job-1",
    role_family: "ai_algorithm",
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
    fetched_at: FETCHED_AT,
    collector_version: "test-collector-1",
    content_hash: "a".repeat(64),
    raw_text: "岗位文本",
    raw_payload: { id: "job-1" },
    ...overrides,
  };
}

async function seed(jobs: NormalizedJobV1[], dataOrigin: DataOrigin = "live"): Promise<void> {
  await ingestBatch(
    sql,
    {
      schema_version: "1.0",
      source_key: jobs[0]!.source_key,
      fetched_at: FETCHED_AT,
      collector_version: "test-collector-1",
      jobs,
    },
    { data_origin: dataOrigin },
  );
}

after(async () => {
  await closeDb();
});

beforeEach(async () => {
  await sql`TRUNCATE career_job_observations, career_jobs, career_policies, career_ingest_runs RESTART IDENTITY`;
});

test("a live-only table reports live from summary, list and detail", async () => {
  await seed([job()]);

  const summary = await repository.summary();
  const list = await repository.listJobs({ page: 1, page_size: 20 });
  const detail = await repository.jobDetail(list.items[0]!.id);

  assert.equal(summary.data_origin, "live");
  assert.equal(list.data_origin, "live");
  assert.equal(detail!.data_origin, "live");
  assert.equal(detail!.job.title, "机器学习工程师");
});

test("a verified import row downgrades summary and list but keeps each detail row's own origin", async () => {
  await seed([job({ company_name: "甲科技有限公司" })]);
  await seed(
    [
      job({
        source_key: "iflytek-official-careers",
        job_key: "job-2",
        company_name: "乙科技有限公司",
        content_hash: "b".repeat(64),
        official_url: "https://careers.example/jobs/job-2",
      }),
    ],
    "verified_import",
  );

  const summary = await repository.summary();
  const list = await repository.listJobs({ page: 1, page_size: 20 });
  const liveItem = list.items.find((item) => item.company_name === "甲科技有限公司")!;
  const importItem = list.items.find((item) => item.company_name === "乙科技有限公司")!;

  assert.equal(summary.data_origin, "verified_import");
  assert.ok(summary.warnings.some((warning) => warning.message.includes("verified_import")));
  assert.equal(list.data_origin, "verified_import");
  assert.equal((await repository.jobDetail(liveItem.id))!.data_origin, "live");
  assert.equal((await repository.jobDetail(importItem.id))!.data_origin, "verified_import");
});

test("the jobs list origin follows the filtered result set, not the whole table", async () => {
  await seed([job({ company_name: "甲科技有限公司" })]);
  await seed(
    [
      job({
        source_key: "iflytek-official-careers",
        job_key: "job-2",
        company_name: "乙科技有限公司",
        content_hash: "b".repeat(64),
        official_url: "https://careers.example/jobs/job-2",
      }),
    ],
    "verified_import",
  );

  const liveOnly = await repository.listJobs({ company: "甲科技有限公司", page: 1, page_size: 20 });
  const importOnly = await repository.listJobs({ company: "乙科技有限公司", page: 1, page_size: 20 });

  assert.equal(liveOnly.data_origin, "live");
  assert.equal(liveOnly.total, 1);
  assert.equal(importOnly.data_origin, "verified_import");
  assert.equal(importOnly.total, 1);
});

test("synthetic rows refuse to publish as real data on every read path", async () => {
  await seed([job()], "synthetic_fixture");

  await assert.rejects(() => repository.summary());
  await assert.rejects(() => repository.listJobs({ page: 1, page_size: 20 }));

  const [row] = await sql<{ id: string }[]>`SELECT id FROM career_jobs`;
  await assert.rejects(() => repository.jobDetail(row!.id));
});