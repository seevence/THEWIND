// The read path is a projection of what ingestBatch wrote: these tests seed real batches and check the
// summary metrics, the filtered/paged list and the detail observations against the contract.
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import type { JobFiltersV1, MetricResultV1, NormalizedJobV1, SummaryResponseV1 } from "../contracts/index.ts";
import { ingestBatch } from "../backend/ingest.ts";
import { SqlCareerRepository } from "../backend/sql-repository.ts";

import { SKILL_DICTIONARY_VERSION } from "../data/dictionaries.ts";
import { METRIC_SPECS_V1 } from "../data/metrics.ts";
import { NORMALIZER_VERSION } from "../data/normalize.ts";

const EPOCH = "1970-01-01T00:00:00.000Z";
const NOTICE = "当前状态以最近一次成功观测为准；单次未采集到不代表职位已下架。";
const repository = new SqlCareerRepository(sql);

const digest = (seed: string) => createHash("sha256").update(seed).digest("hex");


function job(overrides: Partial<NormalizedJobV1> = {}): NormalizedJobV1 {
  return {
    schema_version: "1.0",
    normalizer_version: NORMALIZER_VERSION,
    source_key: "iflytek-official-careers",
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
  // 逐条来源闭合：job 自带 source_key 必须与批次一致，所以按来源拆批次写入。
  const bySource = new Map<string, NormalizedJobV1[]>();
  for (const entry of jobs) {
    const group = bySource.get(entry.source_key) ?? [];
    group.push(entry);
    bySource.set(entry.source_key, group);
  }
  for (const [sourceKey, group] of bySource) {
    await ingestBatch(sql, {
      schema_version: "1.0",
      source_key: sourceKey,
      fetched_at: group[0]!.fetched_at,
      collector_version: "test-collector-1",
      jobs: group,
    });
  }
}

const metric = (summary: SummaryResponseV1, id: MetricResultV1["metric_id"]) => summary.metrics.find((entry) => entry.metric_id === id)!;

async function jobIdOf(jobKey: string): Promise<string> {
  const [row] = await sql<{ id: string }[]>`SELECT id::text AS id FROM career_jobs WHERE job_key = ${jobKey}`;
  return row!.id;
}

async function titlesFor(filters: Partial<JobFiltersV1>): Promise<string[]> {
  const list = await repository.listJobs({ page: 1, page_size: 20, ...filters });
  assert.equal(list.total, list.items.length, "a single page holds every match");
  return list.items.map((item) => item.title).sort();
}

beforeEach(async () => {
  await sql`TRUNCATE career_job_observations, career_jobs, career_policies, career_ingest_runs RESTART IDENTITY`;
});

after(async () => {
  await closeDb();
});

test("an empty table answers summary with insufficient_data instead of a made-up number", async () => {
  const summary = await repository.summary();

  assert.equal(summary.contract_version, "0.1");
  assert.equal(summary.data_origin, "live");
  assert.equal(summary.dictionary_version, SKILL_DICTIONARY_VERSION);
  assert.deepEqual(summary.shared_themes, []);
  assert.equal(summary.sample_size, 0);
  assert.equal(summary.company_count, 0);
  assert.equal(summary.source_count, 0);
  assert.equal(summary.first_observed_at, EPOCH);
  assert.equal(summary.last_observed_at, EPOCH);
  assert.equal(summary.as_of, EPOCH);
  assert.equal(summary.has_multiple_snapshots, false);

  assert.deepEqual(
    [...new Set(summary.metrics.map((entry) => entry.metric_id))],
    METRIC_SPECS_V1.map((spec) => spec.metric_id),
  );
  for (const entry of summary.metrics) {
    assert.equal(entry.status, "insufficient_data");
    assert.equal(entry.value, null);
    assert.equal(entry.sample_size, 0);
    assert.equal(entry.as_of, EPOCH);
  }
  const families = summary.metrics.filter((entry) => entry.metric_id === "job_family_share");
  assert.deepEqual(
    families.map((entry) => entry.dimension.role_family),
    [
      "ai_algorithm",
      "ai_application_development",
      "data",
      "ai_product_operations",
      "hardware_engineering",
      "manufacturing_quality",
      "sales_business",
      "corporate_functions",
      "unknown",
    ],
  );
  for (const entry of families) {
    assert.equal(entry.numerator_count, 0);
    assert.equal(entry.denominator_count, 0);
    assert.deepEqual(Object.keys(entry.dimension), ["role_family"]);
    assert.deepEqual(entry.evidence, []);
  }
  const unknownFamily = families.find((entry) => entry.dimension.role_family === "unknown")!;
  assert.equal(unknownFamily.unknown_count, 0, "an empty sample reports zero unclassified jobs");
  assert.equal(unknownFamily.unknown_ratio, null, "an empty sample has no coverage ratio, not a guessed zero");
  assert.equal(metric(summary, "skill_demand_share").denominator_count, 0);
  assert.equal(metric(summary, "skill_demand_share").numerator_count, 0);
  assert.deepEqual(metric(summary, "skill_demand_share").dimension, {});
  assert.equal(metric(summary, "student_friendly_share").unknown_ratio, null);
  assert.equal(metric(summary, "observed_new_jobs").value, null, "one snapshot never claims new jobs");
  assert.equal(metric(summary, "observed_new_jobs").denominator_count, null);

  assert.deepEqual(summary.warnings.map((warning) => warning.code), ["insufficient_data", "insufficient_data"]);
  assert.ok(summary.warnings.some((warning) => warning.message === "尚未采集到任何职位。"));
  assert.ok(summary.warnings.some((warning) => warning.message === "尚未接入政策证据，共享主题暂不计算。"));

});

test("an empty table lists no jobs, echoes the filters and has no detail", async () => {
  const filters: JobFiltersV1 = { role_family: "data", city: "上海", page: 1, page_size: 20 };
  assert.deepEqual(await repository.listJobs(filters), {
    contract_version: "0.1",
    data_origin: "live",
    items: [],
    page: 1,
    page_size: 20,
    total: 0,
    as_of: EPOCH,
    filters,
  });

  assert.equal(await repository.jobDetail("00000000-0000-4000-8000-000000000000"), null);
});

test("summary counts the ingested jobs and reports the role family, skill and student shares by spec", async () => {
  await seed(
    job(),
    job({
      job_key: "job-2",
      title: "数据工程师",
      role_family: "data",
      locations: ["上海"],
      employment_type: "experienced",
      student_friendly: "unknown",
      skills: ["python", "sql"],
      skill_evidence: [
        { skill_id: "python", evidence_text: "Python" },
        { skill_id: "sql", evidence_text: "SQL" },
      ],
    }),
    job({
      job_key: "job-3",
      source_key: "dahua-official-careers",
      company_name: "乙公司",
      title: "AI 产品实习生",
      role_family: "unknown",
      employment_type: "internship",
      student_friendly: "no",
      skills: ["sql"],
      skill_evidence: [{ skill_id: "sql", evidence_text: "SQL" }],
    }),
  );

  const summary = await repository.summary();
  assert.equal(summary.sample_size, 3);
  assert.equal(summary.company_count, 2);
  assert.equal(summary.source_count, 2);
  assert.equal(summary.first_observed_at, "2026-01-01T00:00:00.000Z");
  assert.equal(summary.last_observed_at, "2026-01-01T00:00:00.000Z");
  assert.equal(summary.as_of, summary.last_observed_at);
  assert.equal(summary.has_multiple_snapshots, false);

  const family = summary.metrics.filter((entry) => entry.metric_id === "job_family_share");
  assert.deepEqual(family.map((entry) => entry.dimension.role_family), ["ai_application_development", "data", "unknown"]);
  for (const entry of family) {
    assert.equal(entry.status, "ok");
    assert.equal(entry.value, 1 / 3);
    assert.equal(entry.numerator_count, 1);
    assert.equal(entry.denominator_count, 3);
    assert.equal(entry.version, "1.0");
    assert.equal(entry.unit, "ratio");
    assert.equal(entry.evidence[0]!.kind, "job");
    assert.equal(typeof entry.evidence[0]!.id, "string");
  }

  const skills = summary.metrics.filter((entry) => entry.metric_id === "skill_demand_share");
  assert.deepEqual(skills.map((entry) => entry.dimension.skill_id), ["python", "sql"]);
  assert.deepEqual(
    skills.map((entry) => [entry.dimension.skill_id, entry.numerator_count, entry.value]),
    [
      ["python", 2, 2 / 3],
      ["sql", 2, 2 / 3],
    ],
    "the top ten skills are ordered by count then skill id",
  );
  assert.ok(skills.every((entry) => entry.dictionary_version === SKILL_DICTIONARY_VERSION && entry.denominator_count === 3));

  const student = metric(summary, "student_friendly_share");
  assert.equal(student.status, "ok");
  assert.equal(student.numerator_count, 1);
  assert.equal(student.denominator_count, 3);
  assert.equal(student.unknown_count, 1);
  assert.equal(student.unknown_ratio, 1 / 3);
  assert.deepEqual(student.dimension, {});

  const observed = metric(summary, "observed_new_jobs");
  assert.equal(observed.status, "insufficient_data");
  assert.equal(observed.value, null);
  assert.equal(observed.numerator_count, 0);
  assert.equal(observed.denominator_count, null);
  assert.equal(observed.unit, "count");

  assert.equal(metric(summary, "policy_job_shared_themes").status, "insufficient_data");
  assert.equal(metric(summary, "policy_job_shared_themes").value, null);

  assert.deepEqual(summary.warnings.map((warning) => warning.code), ["unknown_fields", "unknown_fields", "insufficient_data"]);

  for (const spec of METRIC_SPECS_V1) {
    const entry = summary.metrics.find((candidate) => candidate.metric_id === spec.metric_id)!;
    assert.deepEqual([entry.label, entry.unit, entry.disclaimer], [spec.label, spec.unit, spec.disclaimer]);
    assert.equal(entry.sample_size, 3);
    assert.equal(entry.as_of, summary.last_observed_at);
  }
});

test("summary flags skill demand as insufficient_data when jobs carry no skills", async () => {
  await seed(job({ skills: [], skill_evidence: [] }));

  const summary = await repository.summary();
  assert.equal(summary.sample_size, 1);

  const skills = summary.metrics.filter((entry) => entry.metric_id === "skill_demand_share");
  assert.equal(skills.length, 1);
  const placeholder = skills[0]!;
  assert.equal(placeholder.status, "insufficient_data");
  assert.equal(placeholder.value, null);
  assert.equal(placeholder.numerator_count, 0);
  assert.equal(placeholder.denominator_count, 1);
  assert.equal(placeholder.sample_size, 1);
  assert.equal(placeholder.as_of, summary.as_of);
  assert.deepEqual(placeholder.dimension, {});
  assert.equal(placeholder.dictionary_version, SKILL_DICTIONARY_VERSION);
  assert.deepEqual(placeholder.evidence, []);
});

test("two observation snapshots count the jobs first seen in the newer one", async () => {
  await seed(job({ fetched_at: "2026-01-01T00:00:00.000Z" }));
  await seed(
    job({ job_key: "job-1", fetched_at: "2026-01-02T00:00:00.000Z" }),
    job({ job_key: "job-2", title: "数据工程师", role_family: "data", fetched_at: "2026-01-02T00:00:00.000Z" }),
  );

  const summary = await repository.summary();
  assert.equal(summary.has_multiple_snapshots, true);
  assert.equal(summary.last_observed_at, "2026-01-02T00:00:00.000Z");

  const observed = metric(summary, "observed_new_jobs");
  assert.equal(observed.status, "ok");
  assert.equal(observed.value, 1);
  assert.equal(observed.numerator_count, 1);
  assert.equal(observed.denominator_count, null);
  assert.equal(observed.evidence[0]!.kind, "job");
});

test("同日两次观测不算新的快照日，跨日才算", async () => {
  await seed(job({ fetched_at: "2026-01-01T01:00:00.000Z" }));
  await seed(job({ fetched_at: "2026-01-01T11:00:00.000Z" }));

  const sameDay = await repository.summary();
  assert.equal(sameDay.has_multiple_snapshots, false, "同一天的两个观测点只算一个快照日");
  assert.equal(metric(sameDay, "observed_new_jobs").status, "insufficient_data");

  await seed(job({ fetched_at: "2026-01-02T01:00:00.000Z" }));
  const nextDay = await repository.summary();
  assert.equal(nextDay.has_multiple_snapshots, true);
  assert.equal(metric(nextDay, "observed_new_jobs").value, 0, "该 job 不是新一天首次出现的");
});

test("listJobs filters by every supported dimension", async () => {
  await seed(
    job({ job_key: "job-1", fetched_at: "2026-01-01T00:00:00.000Z", company_name: "甲公司", locations: ["北京", "上海"] }),
    job({
      job_key: "job-2",
      fetched_at: "2026-01-02T00:00:00.000Z",
      company_name: "乙公司",
      title: "数据工程师",
      role_family: "data",
      locations: ["上海"],
      employment_type: "experienced",
      student_friendly: "unknown",
      skills: ["python", "sql"],
      skill_evidence: [
        { skill_id: "python", evidence_text: "Python" },
        { skill_id: "sql", evidence_text: "SQL" },
      ],
    }),
    job({
      job_key: "job-3",
      fetched_at: "2026-01-03T00:00:00.000Z",
      company_name: "甲公司",
      title: "AI 产品实习生",
      role_family: "unknown",
      employment_type: "internship",
      student_friendly: "no",
      skills: ["sql"],
      skill_evidence: [{ skill_id: "sql", evidence_text: "SQL" }],
    }),
  );

  assert.deepEqual(await titlesFor({ role_family: "data" }), ["数据工程师"]);
  assert.deepEqual(await titlesFor({ company: "甲公司" }), ["AI 产品实习生", "AI 应用开发工程师"]);
  assert.deepEqual(await titlesFor({ city: "上海" }), ["AI 应用开发工程师", "数据工程师"]);
  assert.deepEqual(await titlesFor({ employment_type: "internship" }), ["AI 产品实习生"]);
  assert.deepEqual(await titlesFor({ student_friendly: "unknown" }), ["数据工程师"]);
  assert.deepEqual(await titlesFor({ skill: "sql" }), ["AI 产品实习生", "数据工程师"]);
  assert.deepEqual(await titlesFor({ role_family: "data", skill: "sql" }), ["数据工程师"]);
});

test("listJobs pages the newest jobs first and keeps total stable across pages", async () => {
  await seed(
    job({ job_key: "job-1", fetched_at: "2026-01-01T00:00:00.000Z", title: "最早的职位" }),
    job({ job_key: "job-2", fetched_at: "2026-01-02T00:00:00.000Z", title: "中间的职位" }),
    job({ job_key: "job-3", fetched_at: "2026-01-03T00:00:00.000Z", title: "最新的职位" }),
  );

  const first = await repository.listJobs({ page: 1, page_size: 2 });
  assert.equal(first.total, 3);
  assert.deepEqual(first.items.map((item) => item.title), ["最新的职位", "中间的职位"]);
  assert.equal(first.as_of, "2026-01-03T00:00:00.000Z");
  assert.equal(first.data_origin, "live");
  assert.equal(first.contract_version, "0.1");
  assert.deepEqual(first.filters, { page: 1, page_size: 2 });

  const second = await repository.listJobs({ page: 2, page_size: 2 });
  assert.equal(second.total, 3);
  assert.deepEqual(second.items.map((item) => item.title), ["最早的职位"]);
});

test("jobDetail returns the current state with its recent observations and hides raw storage", async () => {
  const rawText = "岗位描述".repeat(200);
  await seed(
    job({
      fetched_at: "2026-01-01T00:00:00.000Z",
      content_hash: digest("v1"),
      raw_text: rawText,
      official_url: "https://careers.example/jobs/job-1-v1",
    }),
  );
  const changedText = "更新后的岗位描述".repeat(100);
  await seed(
    job({
      fetched_at: "2026-01-02T00:00:00.000Z",
      content_hash: digest("v2"),
      title: "AI 应用开发高级工程师",
      raw_text: changedText,
      official_url: "https://careers.example/jobs/job-1-v2",
    }),
  );

  const id = await jobIdOf("job-1");
  const detail = await repository.jobDetail(id);
  assert.notEqual(detail, null);

  const current = detail!.job;
  assert.equal(current.id, id);
  assert.equal(typeof current.id, "string");
  assert.equal(current.job_key, "job-1");
  assert.equal(current.source_key, "iflytek-official-careers");
  assert.equal(current.title, "AI 应用开发高级工程师");
  assert.equal(current.company_name, "测试科技有限公司");
  assert.equal(current.role_family, "ai_application_development");
  assert.deepEqual(current.locations, ["北京"]);
  assert.equal(current.degree, "bachelor");
  assert.equal(current.degree_raw, "本科");
  assert.equal(current.experience_min_years, 0);
  assert.equal(current.experience_max_years, 3);
  assert.equal(current.employment_type, "campus");
  assert.equal(current.student_friendly, "yes");
  assert.deepEqual(current.skills, ["python"]);
  assert.deepEqual(current.skill_evidence, [{ skill_id: "python", evidence_text: "熟悉 Python" }]);
  assert.equal(current.first_seen_at, "2026-01-01T00:00:00.000Z");
  assert.equal(current.last_seen_at, "2026-01-02T00:00:00.000Z");
  assert.equal(current.official_url, "https://careers.example/jobs/job-1-v2");
  assert.equal("raw_text" in current, false);
  assert.equal("raw_payload" in current, false);

  assert.equal(detail!.notice, NOTICE);
  assert.equal(detail!.contract_version, "0.1");
  assert.equal(detail!.data_origin, "live");

  assert.deepEqual(
    detail!.observations.map((observation) => observation.content_hash),
    [digest("v2"), digest("v1")],
    "observations are newest first",
  );
  const [newest, oldest] = detail!.observations;
  assert.equal(typeof newest!.id, "string");
  assert.equal(newest!.observed_at, "2026-01-01T16:00:00.000Z", "观测按 Asia/Shanghai 日粒度对齐");
  assert.equal(newest!.collector_version, "test-collector-1");
  assert.equal(newest!.source_url, "https://careers.example/jobs/job-1-v2");
  assert.equal(newest!.evidence_excerpt, changedText.slice(0, 500));
  assert.equal(oldest!.evidence_excerpt, rawText.slice(0, 500));
  assert.equal(oldest!.evidence_excerpt.length, 500);
});
test("old normalizer rows raise a stale warning and the unknown bucket reports coverage", async () => {
  await seed(
    job({ normalizer_version: "normalizer/0.1.0", role_family: "unknown" }),
    job({ job_key: "job-2", content_hash: digest("j2"), role_family: "data" }),
  );

  const summary = await repository.summary();
  assert.ok(
    summary.warnings.some(
      (warning) => warning.code === "stale_data" && warning.message === "部分职位仍为旧归一化版本，重入库后刷新。",
    ),
  );

  const unknown = summary.metrics.find(
    (entry) => entry.metric_id === "job_family_share" && entry.dimension.role_family === "unknown",
  )!;
  assert.equal(unknown.numerator_count, 1);
  assert.equal(unknown.unknown_count, 1);
  assert.equal(unknown.unknown_ratio, 0.5);

  assert.equal(
    Object.keys(summary).includes("normalizer_version"),
    false,
    "the summary does not expose the normalizer version",
  );

  const list = await repository.listJobs({ page: 1, page_size: 20 });
  assert.equal(
    Object.keys(list.items[0]!).includes("normalizer_version"),
    false,
    "the job list item does not expose the normalizer version",
  );
  const detail = await repository.jobDetail(list.items[0]!.id);
  assert.equal(
    Object.keys(detail!.job).includes("normalizer_version"),
    false,
    "the job detail does not expose the normalizer version",
  );
});

test("llm-backed normalizer rows count as current and do not raise a stale warning", async () => {
  await seed(job({ normalizer_version: "normalizer/llm-0.1" }));

  const summary = await repository.summary();
  assert.equal(summary.sample_size, 1);
  assert.equal(summary.warnings.some((warning) => warning.code === "stale_data"), false);
});

test("mixed current and llm-backed rows do not raise a stale warning", async () => {
  await seed(
    job({ normalizer_version: NORMALIZER_VERSION }),
    job({ job_key: "job-2", content_hash: digest("j2"), normalizer_version: "normalizer/llm-0.1" }),
  );

  const summary = await repository.summary();
  assert.equal(summary.sample_size, 2);
  assert.equal(summary.warnings.some((warning) => warning.code === "stale_data"), false);
});

test("a pre-0.3.0 version still raises a stale warning", async () => {
  await seed(job({ normalizer_version: "normalizer/0.2.0" }));

  const summary = await repository.summary();
  assert.ok(summary.warnings.some((warning) => warning.code === "stale_data"));
});

test("a row without a normalizer version is treated as stale", async () => {
  await seed(job());
  // 该列在 schema 上是 NOT NULL：临时放开约束，覆盖「版本信息缺失」分支。
  await sql`ALTER TABLE career_jobs ALTER COLUMN normalizer_version DROP NOT NULL`;
  try {
    await sql`UPDATE career_jobs SET normalizer_version = NULL`;

    const summary = await repository.summary();
    assert.ok(summary.warnings.some((warning) => warning.code === "stale_data"));
  } finally {
    await sql`DELETE FROM career_job_observations
      WHERE job_id IN (SELECT id FROM career_jobs WHERE normalizer_version IS NULL)`;
    await sql`DELETE FROM career_jobs WHERE normalizer_version IS NULL`;
    await sql`ALTER TABLE career_jobs ALTER COLUMN normalizer_version SET NOT NULL`;
  }
});

test("a fully classified sample still reports an explicit zero unknown coverage", async () => {
  await seed(job({ role_family: "data" }));

  const summary = await repository.summary();
  const unknown = summary.metrics.find(
    (entry) => entry.metric_id === "job_family_share" && entry.dimension.role_family === "unknown",
  )!;
  assert.equal(unknown.status, "ok");
  assert.equal(unknown.value, 0);
  assert.equal(unknown.unknown_count, 0);
  assert.equal(unknown.unknown_ratio, 0);
  assert.equal(summary.warnings.some((warning) => warning.code === "stale_data"), false);
});