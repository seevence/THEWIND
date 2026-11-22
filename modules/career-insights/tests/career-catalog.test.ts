// The catalog endpoint serves the direction/title/skill leaderboards. These tests seed real jobs
// through ingest, then assert the ranking, the cross-city title merge, the skill share denominator
// and the route's parameter bounds and public cache header.
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import Fastify from "fastify";
import { closeDb, sql } from "@aihot/backend/db";
import type { NormalizedJobV1 } from "../contracts/index.ts";
import { loadCareerCatalog } from "../backend/career-catalog.ts";
import { registerCareerHttp } from "../backend/http.ts";
import { ingestBatch } from "../backend/ingest.ts";
import { SqlCareerRepository } from "../backend/sql-repository.ts";
import { NORMALIZER_VERSION } from "../data/normalize.ts";

const repository = new SqlCareerRepository(sql);
const digest = (seed: string) => createHash("sha256").update(seed).digest("hex");
const nowIso = () => new Date().toISOString();

function job(overrides: Partial<NormalizedJobV1> = {}): NormalizedJobV1 {
  const jobKey = overrides.job_key ?? "job-1";
  const skills = overrides.skills ?? ["python"];
  return {
    schema_version: "1.0",
    normalizer_version: NORMALIZER_VERSION,
    source_key: "dahua-official-careers",
    job_key: jobKey,
    company_name: "测试科技有限公司",
    title: "算法工程师",
    official_url: `https://careers.example/jobs/${jobKey}`,
    role_family: "ai_algorithm",
    locations: ["北京"],
    degree: "bachelor",
    degree_raw: "本科",
    experience_min_years: 0,
    experience_max_years: 3,
    experience_raw: "1-3 年",
    employment_type: "experienced",
    student_friendly: "no",
    skills,
    skill_evidence: skills.map((skillId) => ({ skill_id: skillId, evidence_text: `熟悉 ${skillId}` })),
    published_at: null,
    fetched_at: nowIso(),
    collector_version: "test-collector-1",
    content_hash: digest(jobKey),
    raw_text: "岗位文本",
    raw_payload: { id: jobKey },
    ...overrides,
  };
}

async function seed(...jobs: NormalizedJobV1[]): Promise<void> {
  await ingestBatch(sql, {
    schema_version: "1.0",
    source_key: "dahua-official-careers",
    fetched_at: jobs[0]!.fetched_at,
    collector_version: "test-collector-1",
    jobs,
  });
}

async function ageJob(jobKey: string, days: number): Promise<void> {
  await sql`UPDATE career_jobs SET first_seen_at = now() - make_interval(days => ${days}::int) WHERE job_key = ${jobKey}`;
}

beforeEach(async () => {
  await sql`TRUNCATE career_job_observations, career_jobs, career_policies, career_ingest_runs RESTART IDENTITY`;
});

after(async () => {
  await closeDb();
});

test("directions aggregate by role_family without the unknown bucket and honour the window", async () => {
  await seed(
    job({ job_key: "dir-1", company_name: "深智公司", title: "算法工程师", skills: ["python", "大模型"], student_friendly: "yes" }),
    job({ job_key: "dir-2", company_name: "云图公司", title: "推荐算法工程师", skills: ["python"] }),
    job({ job_key: "dir-3", company_name: "深智公司", title: "大模型算法工程师", skills: ["大模型"] }),
    job({ job_key: "dir-4", company_name: "深智公司", title: "数据工程师", role_family: "data", skills: ["sql"] }),
    job({ job_key: "dir-5", company_name: "深智公司", title: "机械设计工程师", role_family: "unknown", skills: ["cad"], student_friendly: "yes" }),
  );
  await ageJob("dir-4", 45);

  const result = await loadCareerCatalog(sql, { limit: 6, window_days: 30 });

  assert.equal(result.sample_size, 5);
  assert.deepEqual(result.directions.map((entry) => entry.role_family), ["ai_algorithm", "data"]);

  const algorithm = result.directions[0]!;
  assert.equal(algorithm.job_count, 3);
  assert.equal(algorithm.company_count, 2);
  assert.equal(algorithm.new_in_window, 3);
  assert.equal(algorithm.student_friendly_count, 1);
  assert.equal(algorithm.top_skills.length, 2);
  const skillCounts = new Map(algorithm.top_skills.map((entry) => [entry.skill, entry.count]));
  assert.equal(skillCounts.get("python"), 2);
  assert.equal(skillCounts.get("大模型"), 2);

  const data = result.directions[1]!;
  assert.equal(data.job_count, 1);
  assert.equal(data.new_in_window, 0, "a job first seen 45 days ago is outside a 30 day window");
  assert.equal(result.window_days, 30);
  assert.ok(Number.isFinite(Date.parse(result.as_of)));

  // 方向榜只统计已归类岗位；未归类岗位的数量、其中学生友好数与占比单独披露。
  assert.equal(result.unclassified_job_count, 1);
  assert.equal(result.unclassified_student_friendly_count, 1);
  assert.equal(result.unclassified_ratio, 1 / 5);
  assert.equal(
    result.directions.reduce((sum, direction) => sum + direction.job_count, 0) + result.unclassified_job_count!,
    result.sample_size,
    "directions + unclassified account for the whole sample",
  );
});

test("titles merge city and bracket variants of the same title without double counting", async () => {
  await seed(
    job({
      job_key: "title-1",
      company_name: "甲科技",
      title: "北京-算法工程师（大模型）",
      locations: ["北京"],
      published_at: "2026-11-10",
    }),
    job({
      job_key: "title-2",
      company_name: "乙科技",
      title: "上海·算法工程师",
      locations: ["上海"],
      published_at: "2026-11-12",
    }),
    job({ job_key: "title-3", company_name: "甲科技", title: "深圳 算法工程师", locations: ["深圳"] }),
    job({ job_key: "title-4", company_name: "甲科技", title: "数据工程师", role_family: "data", locations: ["杭州"] }),
  );

  const result = await loadCareerCatalog(sql, { limit: 6, window_days: 30 });
  const merged = result.titles[0]!;

  assert.equal(merged.title_key, "算法工程师");
  assert.match(merged.title_display, /算法工程师/);
  assert.equal(merged.job_count, 3);
  assert.equal(merged.company_count, 2);
  assert.equal(merged.cities.length, 3);
  for (const city of ["北京", "上海", "深圳"]) assert.ok(merged.cities.includes(city), city);
  assert.equal(merged.latest_published_at, "2026-11-12");
  assert.deepEqual(result.titles.map((entry) => entry.title_key), ["算法工程师", "数据工程师"]);
});

test("skill share is computed over jobs that list skills", async () => {
  await seed(
    job({ job_key: "skill-1", title: "算法工程师", skills: ["python", "大模型"] }),
    job({ job_key: "skill-2", title: "推荐算法工程师", skills: ["python"] }),
    job({ job_key: "skill-3", title: "大模型算法工程师", skills: ["python", "大模型"] }),
    job({ job_key: "skill-4", title: "数据工程师", role_family: "data", skills: [] }),
  );

  const result = await loadCareerCatalog(sql, { limit: 6, window_days: 30 });

  assert.equal(result.sample_size, 4);
  assert.deepEqual(result.skills[0], { skill: "python", job_count: 3, share: 1 });
  assert.equal(result.skills[1]!.skill, "大模型");
  assert.equal(result.skills[1]!.job_count, 2);
  assert.equal(result.skills[1]!.share, 2 / 3, "the job without skills stays out of the denominator");
});

test("the catalog route enforces parameter bounds, a public cache, defaults, and an empty table", async () => {
  const app = Fastify();
  registerCareerHttp(app, repository);
  await app.ready();

  for (const query of ["limit=0", "limit=51", "limit=abc", "window_days=0", "window_days=366", "sort=jobs"]) {
    const response = await app.inject({ url: `/api/site/career-insights/catalog?${query}` });
    assert.equal(response.statusCode, 400, query);
    assert.equal(response.json().error.code, "invalid_parameter", query);
  }

  const empty = await app.inject({ url: "/api/site/career-insights/catalog" });
  assert.equal(empty.statusCode, 200);
  assert.equal(empty.headers["cache-control"], "public, max-age=60, stale-while-revalidate=300");
  assert.deepEqual(empty.json().directions, []);
  assert.deepEqual(empty.json().titles, []);
  assert.deepEqual(empty.json().skills, []);
  assert.equal(empty.json().sample_size, 0);
  assert.equal(empty.json().unclassified_job_count, 0);
  assert.equal(empty.json().unclassified_student_friendly_count, 0);
  assert.equal(empty.json().unclassified_ratio, null, "an empty sample has no coverage ratio");
  assert.equal(empty.json().window_days, 30);
  assert.equal(empty.json().as_of, "1970-01-01T00:00:00.000Z");

  await app.close();
});

test("limit caps directions and titles while skills keep their own top 10", async () => {
  const elevenSkills = Array.from({ length: 11 }, (_, index) => `skill-${index + 1}`);
  await seed(
    job({ job_key: "cap-1", company_name: "甲科技", title: "算法工程师", skills: elevenSkills }),
    job({ job_key: "cap-2", company_name: "甲科技", title: "推荐算法工程师", role_family: "data", skills: ["python"] }),
    job({ job_key: "cap-3", company_name: "乙科技", title: "数据工程师", role_family: "data", skills: [] }),
  );

  const app = Fastify();
  registerCareerHttp(app, repository);
  await app.ready();
  const response = await app.inject({ url: "/api/site/career-insights/catalog?limit=1" });
  await app.close();

  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.directions.length, 1);
  assert.equal(body.titles.length, 1);
  assert.equal(body.skills.length, 10);
  assert.equal(body.directions[0].job_count, 2, "role_family data is the largest family after the tie-break");
});