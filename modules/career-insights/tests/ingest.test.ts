// career_jobs has one writer, ingestBatch: these tests drive real batches through it and inspect the
// rows, because first/last seen, content hash and observation dedupe are what the read path and the
// metrics depend on.
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import type { CareerObservationBatchV1, NormalizedJobV1 } from "../contracts/index.ts";
import { InvalidParameterError } from "../backend/errors.ts";
import { ingestBatch } from "../backend/ingest.ts";
import { careerIngestQueue } from "../backend/queue.ts";
import { ingestWithRun } from "../backend/run-ingest.ts";
import { CAREER_SOURCE_DEFINITIONS } from "../collector/sources.ts";

const digest = (seed: string) => createHash("sha256").update(seed).digest("hex");
const at = (value: Date | string) => new Date(value).toISOString();
// 入库入口只接受已启用的注册来源；测试批次必须用一个真实登记的 job 源。
const TEST_SOURCE_KEY = "iflytek-official-careers";
// 已启用的政策源：能过 enabled 检查，只有 kind 守卫才挡得住。
const POLICY_SOURCE = CAREER_SOURCE_DEFINITIONS.find(
  (source) => source.source_key === "state-council-policy" && source.enabled && source.kind === "government_policy",
)!;

function job(overrides: Partial<NormalizedJobV1> = {}): NormalizedJobV1 {
  return {
    schema_version: "1.0",
    normalizer_version: "normalizer/0.2.0",
    source_key: TEST_SOURCE_KEY,
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

function batchOf(jobs: NormalizedJobV1[], fetchedAt = "2026-01-01T00:00:00.000Z"): CareerObservationBatchV1 {
  return { schema_version: "1.0", source_key: TEST_SOURCE_KEY, fetched_at: fetchedAt, collector_version: "test-collector-1", jobs };
}

async function count(table: "career_jobs" | "career_job_observations"): Promise<number> {
  const rows = await sql<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM ${sql(table)}`;
  return rows[0]!.n;
}

async function countRuns(): Promise<number> {
  const rows = await sql<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM career_ingest_runs`;
  return rows[0]!.n;
}

async function storedJob(jobKey = "job-1") {
  const [row] = await sql<
    {
      title: string;
      content_hash: string;
      normalizer_version: string;
      role_family: string;
      student_friendly: string;
      experience_min_years: number | null;
      experience_raw: string | null;
      skills: string[];
      first_seen_at: Date;
      last_seen_at: Date;
    }[]
  >`
    SELECT title, content_hash, normalizer_version, role_family, student_friendly,
           experience_min_years, experience_raw, skills, first_seen_at, last_seen_at
    FROM career_jobs
    WHERE source_key = ${TEST_SOURCE_KEY} AND job_key = ${jobKey}`;
  return row!;
}

beforeEach(async () => {
  await sql`TRUNCATE career_job_observations, career_jobs, career_ingest_runs RESTART IDENTITY`;
});

after(async () => {
  await closeDb();
});

test("a repeated batch writes each job once and counts the second run as duplicates", async () => {
  const batch = batchOf([
    job(),
    job({
      job_key: "job-2",
      title: "数据工程师",
      role_family: "data",
      locations: ["上海"],
      employment_type: "experienced",
      student_friendly: "unknown",
      skills: ["sql"],
      skill_evidence: [{ skill_id: "sql", evidence_text: "SQL" }],
    }),
  ]);

  assert.deepEqual(await ingestBatch(sql, batch), { accepted: 2, updated: 0, duplicates: 0, rejected: 0, errors: [] });
  const before = await storedJob();

  assert.deepEqual(await ingestBatch(sql, batch), { accepted: 0, updated: 0, duplicates: 2, rejected: 0, errors: [] });
  assert.equal(await count("career_jobs"), 2);
  assert.equal(await count("career_job_observations"), 2, "a repeated observation is not appended again");

  const after = await storedJob();
  assert.equal(at(after.first_seen_at), at(before.first_seen_at));
  assert.equal(at(after.last_seen_at), at(before.last_seen_at), "an identical observation never moves last_seen_at");
});

test("first_seen_at stays put while last_seen_at runs forward and never backward", async () => {
  await ingestBatch(sql, batchOf([job({ fetched_at: "2026-01-01T00:00:00.000Z" })]));
  const first = await storedJob();

  const later = await ingestBatch(sql, batchOf([job({ fetched_at: "2026-01-05T08:00:00.000Z" })], "2026-01-05T08:00:00.000Z"));
  assert.deepEqual(later, { accepted: 0, updated: 0, duplicates: 1, rejected: 0, errors: [] });

  const moved = await storedJob();
  assert.equal(at(moved.first_seen_at), at(first.first_seen_at));
  assert.equal(at(moved.last_seen_at), "2026-01-05T08:00:00.000Z");

  await ingestBatch(sql, batchOf([job({ fetched_at: "2025-12-31T00:00:00.000Z" })], "2025-12-31T00:00:00.000Z"));
  const backdated = await storedJob();
  assert.equal(at(backdated.last_seen_at), "2026-01-05T08:00:00.000Z", "an older fetch never pulls last_seen_at back");
  assert.equal(at(backdated.first_seen_at), "2026-01-01T00:00:00.000Z");
  // 内容不变也会在采集日留下观测点：三次采集分属三个 Asia/Shanghai 日，各一条。
  assert.equal(await count("career_job_observations"), 3);
});

test("a changed content hash updates the current state without touching first_seen_at", async () => {
  await ingestBatch(sql, batchOf([job({ fetched_at: "2026-01-01T00:00:00.000Z", content_hash: digest("v1") })]));

  const result = await ingestBatch(
    sql,
    batchOf([job({ fetched_at: "2026-01-02T00:00:00.000Z", content_hash: digest("v2"), title: "AI 应用开发高级工程师" })]),
  );
  assert.deepEqual(result, { accepted: 0, updated: 1, duplicates: 0, rejected: 0, errors: [] });

  const row = await storedJob();
  assert.equal(row.title, "AI 应用开发高级工程师");
  assert.equal(row.content_hash, digest("v2"));
  assert.equal(at(row.first_seen_at), "2026-01-01T00:00:00.000Z");
  assert.equal(at(row.last_seen_at), "2026-01-02T00:00:00.000Z");
  assert.equal(await count("career_jobs"), 1);
  assert.equal(await count("career_job_observations"), 2, "the new hash is a new observation");
});

test("an invalid entry is rejected by index while the valid entries of the batch are written", async () => {
  const result = await ingestBatch(
    sql,
    batchOf([
      job({ job_key: "bad-hash", content_hash: "not-a-hash" }),
      job({ job_key: "good-1" }),
      job({ job_key: "bad-title", title: " " }),
    ]),
  );

  assert.deepEqual(result.errors.map((error) => error.index), [0, 2], "errors are listed by ascending index");
  assert.ok(result.errors.every((error) => error.code === "validation_failed"));
  assert.match(result.errors[0]!.message, /content_hash/);
  assert.equal(result.rejected, 2);
  assert.equal(result.accepted, 1);
  assert.equal(result.accepted + result.updated + result.duplicates + result.rejected, 3);
  assert.equal(await count("career_jobs"), 1);
  assert.equal(await count("career_job_observations"), 1);
});

test("a batch over one hundred jobs is refused before anything is written", async () => {
  const many = Array.from({ length: 101 }, (_, index) => job({ job_key: `bulk-${index}` }));
  await assert.rejects(() => ingestBatch(sql, batchOf(many)), InvalidParameterError);
  assert.equal(await count("career_jobs"), 0);
  assert.equal(await count("career_job_observations"), 0);
});

test("an empty batch is refused before a run row and before any write", async () => {
  const empty = batchOf([]);

  await assert.rejects(
    () => ingestBatch(sql, empty),
    (error: unknown) => {
      assert.ok(error instanceof InvalidParameterError);
      assert.equal(error.code, "invalid_parameter");
      assert.equal(error.message, "A batch must contain at least one job.");
      assert.deepEqual(error.details, { parameter: "jobs" });
      return true;
    },
  );
  await assert.rejects(
    () => ingestWithRun(sql, empty),
    InvalidParameterError,
    "an empty batch must be refused before a run row is created",
  );
  assert.equal(await count("career_jobs"), 0);
  assert.equal(await count("career_job_observations"), 0);
  assert.equal(await countRuns(), 0, "an empty batch never starts a run");
});

test("a batch from an unregistered source_key is refused before anything is written", async () => {
  const unregistered = { ...batchOf([job()]), source_key: "career-test" };

  await assert.rejects(
    () => ingestBatch(sql, unregistered),
    (error: unknown) => {
      assert.ok(error instanceof InvalidParameterError);
      assert.equal(error.code, "invalid_parameter");
      assert.equal(error.message, "Unknown source: career-test");
      assert.deepEqual(error.details, { parameter: "source_key" });
      return true;
    },
  );
  assert.equal(await count("career_jobs"), 0);
  assert.equal(await count("career_job_observations"), 0);
});

test("padded source keys are trimmed before the registry lookup and stored without the padding", async () => {
  const padded = `  ${TEST_SOURCE_KEY}  `;
  const result = await ingestBatch(sql, {
    ...batchOf([job({ job_key: "padded-1", source_key: ` ${TEST_SOURCE_KEY} ` })]),
    source_key: padded,
  });

  assert.deepEqual(result, { accepted: 1, updated: 0, duplicates: 0, rejected: 0, errors: [] });
  const rows = await sql<{ source_key: string; job_key: string }[]>`
    SELECT source_key, job_key FROM career_jobs`;
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.source_key, TEST_SOURCE_KEY, "the padded key is stored without the padding");
  assert.equal(rows[0]!.job_key, "padded-1");
});

test("a whitespace-only source key is treated as unregistered", async () => {
  await assert.rejects(
    () => ingestBatch(sql, { ...batchOf([job()]), source_key: "   " }),
    (error: unknown) => {
      assert.ok(error instanceof InvalidParameterError);
      assert.equal(error.message, 'Unknown source: ""');
      assert.deepEqual(error.details, { parameter: "source_key" });
      return true;
    },
  );
  assert.equal(await count("career_jobs"), 0);
});

test("a case-mismatched source key is refused with a case-sensitivity hint", async () => {
  const wrongCase = TEST_SOURCE_KEY.toUpperCase();
  assert.notEqual(wrongCase, TEST_SOURCE_KEY);

  await assert.rejects(
    () => ingestBatch(sql, { ...batchOf([job()]), source_key: wrongCase }),
    (error: unknown) => {
      assert.ok(error instanceof InvalidParameterError);
      assert.equal(error.message, `Unknown source: ${wrongCase} (source keys are case-sensitive)`);
      assert.deepEqual(error.details, { parameter: "source_key" });
      return true;
    },
  );
  assert.equal(await count("career_jobs"), 0);
});

test("the ingest queue drops a deterministic parameter error instead of retrying it", async (t) => {
  t.mock.method(console, "error", () => {});

  assert.equal(await careerIngestQueue.run([batchOf([])]), 0);
  assert.equal(await countRuns(), 0, "a dropped batch never leaves a failed run");
  assert.equal(await count("career_jobs"), 0);
});

test("a batch from a disabled registered source is refused before anything is written", async () => {
  const disabled = CAREER_SOURCE_DEFINITIONS.find(
    (source) => source.kind === "company_careers" && !source.enabled,
  );
  assert.ok(disabled !== undefined, "the registry must keep at least one disabled source for this guard");
  const batch = { ...batchOf([job()]), source_key: disabled.source_key };

  await assert.rejects(
    () => ingestBatch(sql, batch),
    (error: unknown) => {
      assert.ok(error instanceof InvalidParameterError);
      assert.equal(error.code, "invalid_parameter");
      assert.equal(error.message, `Disabled source: ${disabled.source_key}`);
      assert.deepEqual(error.details, { parameter: "source_key" });
      return true;
    },
  );
  assert.equal(await count("career_jobs"), 0);
  assert.equal(await count("career_job_observations"), 0);
});

test("政策源 state-council-policy 整批被拒，career_jobs 零新增", async () => {
  assert.equal(POLICY_SOURCE.kind, "government_policy");
  assert.equal(POLICY_SOURCE.enabled, true, "the guard must reject by kind, not only by enabled");
  const batch = { ...batchOf([job({ source_key: POLICY_SOURCE.source_key })]), source_key: POLICY_SOURCE.source_key };

  await assert.rejects(
    () => ingestBatch(sql, batch),
    (error: unknown) => {
      assert.ok(error instanceof InvalidParameterError);
      assert.equal(error.code, "invalid_parameter");
      assert.equal(
        error.message,
        `Non-company careers source: ${POLICY_SOURCE.source_key} (kind=government_policy)`,
      );
      assert.deepEqual(error.details, { parameter: "source_key" });
      return true;
    },
  );
  assert.equal(await count("career_jobs"), 0, "an enabled policy source never reaches career_jobs");
  assert.equal(await count("career_job_observations"), 0);
});

test("未登记或政策源经 ingestWithRun 被拒后不留下 ghost run 行", async () => {
  for (const sourceKey of ["career-test", POLICY_SOURCE.source_key]) {
    await assert.rejects(
      () => ingestWithRun(sql, { ...batchOf([job({ source_key: sourceKey })]), source_key: sourceKey }),
      InvalidParameterError,
      `${sourceKey} must be refused before a run row is created`,
    );
  }
  assert.equal(await countRuns(), 0, "a refused batch must not leave a failed career_ingest_runs row");
  assert.equal(await count("career_jobs"), 0);
});

test("a job whose own source_key is unregistered or differs from the batch is rejected while the rest is written", async () => {
  const result = await ingestBatch(
    sql,
    batchOf([
      job({ job_key: "ok-1" }),
      job({ job_key: "alien-1", source_key: "career-test" }),
      job({ job_key: "other-1", source_key: "dahua-official-careers" }),
    ]),
  );

  assert.deepEqual(result.errors.map((error) => error.index), [1, 2], "errors are listed by ascending index");
  assert.ok(result.errors.every((error) => error.code === "validation_failed"));
  assert.match(result.errors[0]!.message, /source_key.*career-test/);
  assert.match(result.errors[1]!.message, /does not match the batch source/);
  assert.equal(result.rejected, 2);
  assert.equal(result.accepted, 1);
  assert.equal(await count("career_jobs"), 1);
  assert.equal(await count("career_job_observations"), 1);

  const storedKeys = await sql<{ source_key: string }[]>`SELECT DISTINCT source_key FROM career_jobs`;
  assert.deepEqual(storedKeys.map((row) => row.source_key), [TEST_SOURCE_KEY], "an unregistered job source never reaches the table");
});

test("a newer normalizer version refreshes derived fields and keeps one observation per day", async () => {
  await ingestBatch(
    sql,
    batchOf([
      job({
        fetched_at: "2026-01-01T00:00:00.000Z",
        normalizer_version: "normalizer/0.1.0",
        role_family: "unknown",
        student_friendly: "unknown",
        experience_min_years: null,
        experience_max_years: null,
        experience_raw: null,
        degree: "unknown",
        degree_raw: null,
        employment_type: "unknown",
        skills: [],
        skill_evidence: [],
      }),
    ]),
  );

  const refreshed = await ingestBatch(
    sql,
    batchOf([
      job({
        fetched_at: "2026-01-02T00:00:00.000Z",
        normalizer_version: "normalizer/0.2.0",
        role_family: "ai_application_development",
        student_friendly: "no",
        experience_min_years: 3,
        experience_max_years: null,
        experience_raw: "三年以上",
        degree: "bachelor",
        degree_raw: "本科",
        employment_type: "experienced",
        skills: ["python", "sql"],
        skill_evidence: [
          { skill_id: "python", evidence_text: "Python" },
          { skill_id: "sql", evidence_text: "SQL" },
        ],
      }),
    ]),
  );

  assert.deepEqual(refreshed, { accepted: 0, updated: 0, duplicates: 1, rejected: 0, errors: [] });
  const row = await storedJob();
  assert.equal(row.normalizer_version, "normalizer/0.2.0");
  assert.equal(row.role_family, "ai_application_development");
  assert.equal(row.student_friendly, "no");
  assert.equal(row.experience_min_years, 3);
  assert.deepEqual(row.skills, ["python", "sql"]);
  assert.equal(at(row.first_seen_at), "2026-01-01T00:00:00.000Z");
  assert.equal(at(row.last_seen_at), "2026-01-02T00:00:00.000Z");
  assert.equal(await count("career_jobs"), 1);
  assert.equal(await count("career_job_observations"), 2, "两天各一条日粒度观测");
});

test("a legacy hash from an older normalizer refreshes derivations and keeps one observation per day", async () => {
  await ingestBatch(
    sql,
    batchOf([
      job({ normalizer_version: "normalizer/0.1.0", content_hash: digest("legacy"), role_family: "unknown" }),
    ]),
  );

  const result = await ingestBatch(
    sql,
    batchOf([
      job({
        fetched_at: "2026-01-02T00:00:00.000Z",
        normalizer_version: "normalizer/0.2.0",
        content_hash: digest("new-algorithm"),
        role_family: "ai_application_development",
      }),
    ]),
  );

  assert.deepEqual(result, { accepted: 0, updated: 0, duplicates: 1, rejected: 0, errors: [] });
  const row = await storedJob();
  assert.equal(row.content_hash, digest("new-algorithm"), "the row adopts the source-content hash");
  assert.equal(row.normalizer_version, "normalizer/0.2.0");
  assert.equal(await count("career_jobs"), 1);
  assert.equal(await count("career_job_observations"), 2, "两天各一条日粒度观测");
});

test("changed derived fields under the same version still refresh and keep one observation per day", async () => {
  await ingestBatch(sql, batchOf([job({ role_family: "unknown", skills: [], skill_evidence: [] })]));

  const result = await ingestBatch(
    sql,
    batchOf([job({ fetched_at: "2026-01-02T00:00:00.000Z", role_family: "ai_application_development", skills: ["python"] })]),
  );

  assert.deepEqual(result, { accepted: 0, updated: 0, duplicates: 1, rejected: 0, errors: [] });
  const row = await storedJob();
  assert.equal(row.role_family, "ai_application_development");
  assert.deepEqual(row.skills, ["python"]);
  assert.equal(await count("career_job_observations"), 2, "两天各一条日粒度观测");
});

test("rule normalizer does not downgrade an existing LLM-classified row", async () => {
  await ingestBatch(
    sql,
    batchOf([
      job({
        normalizer_version: "normalizer/llm-0.3",
        role_family: "ai_algorithm",
        student_friendly: "yes",
        skills: ["python", "sql"],
      }),
    ]),
  );

  const result = await ingestBatch(
    sql,
    batchOf([
      job({
        fetched_at: "2026-01-02T00:00:00.000Z",
        normalizer_version: "normalizer/0.3.0",
        role_family: "unknown",
        student_friendly: "unknown",
        skills: [],
        skill_evidence: [],
      }),
    ]),
  );

  assert.deepEqual(result, { accepted: 0, updated: 0, duplicates: 1, rejected: 0, errors: [] });
  const row = await storedJob();
  assert.equal(row.normalizer_version, "normalizer/llm-0.3", "LLM 版本保留，不被规则版覆盖");
  assert.equal(row.role_family, "ai_algorithm");
  assert.equal(row.student_friendly, "yes");
  assert.deepEqual(row.skills, ["python", "sql"]);
  assert.equal(await count("career_jobs"), 1);
  assert.equal(await count("career_job_observations"), 2, "两天各一条日粒度观测");
});

test("同一天两次采集同一内容只留下一个观测点", async () => {
  await ingestBatch(sql, batchOf([job({ fetched_at: "2026-01-01T01:00:00.000Z" })]));
  const second = await ingestBatch(sql, batchOf([job({ fetched_at: "2026-01-01T13:00:00.000Z" })]));

  assert.deepEqual(second, { accepted: 0, updated: 0, duplicates: 1, rejected: 0, errors: [] });
  assert.equal(await count("career_job_observations"), 1, "同一天的重复观测不追加");

  const [row] = await sql<{ observed_at: Date }[]>`SELECT observed_at FROM career_job_observations`;
  assert.equal(at(row!.observed_at), "2025-12-31T16:00:00.000Z", "observed_at 归一到 Asia/Shanghai 当日零点");
});

test("跨两个采集日累积两个观测日，同日内容变化仍只算一个快照日", async () => {
  const changed = { content_hash: digest("v2"), title: "AI 应用开发高级工程师" };
  await ingestBatch(sql, batchOf([job({ fetched_at: "2026-01-01T01:00:00.000Z" })]));
  await ingestBatch(sql, batchOf([job({ fetched_at: "2026-01-01T09:00:00.000Z", ...changed })]));
  await ingestBatch(sql, batchOf([job({ fetched_at: "2026-01-02T01:00:00.000Z", ...changed })]));

  const [row] = await sql<{ observations: number; days: number }[]>`
    SELECT COUNT(*)::int AS observations,
           COUNT(DISTINCT date_trunc('day', observed_at AT TIME ZONE 'Asia/Shanghai'))::int AS days
    FROM career_job_observations`;
  assert.equal(row!.observations, 3, "同一天内容变化两次各留一条观测");
  assert.equal(row!.days, 2, "快照日按 Asia/Shanghai 日去重");
});
