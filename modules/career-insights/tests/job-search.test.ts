// 岗位关键词搜索（P0）：GET /api/site/career-insights/jobs?q=… 在职位名、公司名、技能与城市里做
// 参数化 ILIKE；关键词里的 % _ \ 按字面匹配。这里用真实库表证明命中字段、转义、与其它筛选/分页/total
// 的组合，并用 Fastify inject 覆盖空关键词、超长与重复参数。
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import Fastify from "fastify";
import { closeDb, sql } from "@aihot/backend/db";
import type { JobFiltersV1, NormalizedJobV1 } from "../contracts/index.ts";
import { registerCareerHttp } from "../backend/http.ts";
import { SqlCareerRepository } from "../backend/sql-repository.ts";
import { ingestBatch } from "../backend/ingest.ts";
import { NORMALIZER_VERSION } from "../data/normalize.ts";

const repository = new SqlCareerRepository(sql);
const digest = (seed: string) => createHash("sha256").update(seed).digest("hex");

function job(overrides: Partial<NormalizedJobV1> = {}): NormalizedJobV1 {
  const jobKey = overrides.job_key ?? "job-1";
  // skill_evidence 必须与 skills 一一对应，否则入库校验会拒绝整条岗位；默认按 skills 生成。
  const skills = overrides.skills ?? ["python"];
  return {
    schema_version: "1.0",
    normalizer_version: NORMALIZER_VERSION,
    source_key: "career-search-test",
    job_key: jobKey,
    company_name: "甲公司",
    title: "数据分析工程师",
    official_url: `https://careers.example/jobs/${jobKey}`,
    role_family: "data",
    locations: ["北京"],
    degree: "bachelor",
    degree_raw: "本科",
    experience_min_years: null,
    experience_max_years: null,
    experience_raw: null,
    employment_type: "campus",
    student_friendly: "yes",
    skills,
    skill_evidence: skills.map((skill) => ({ skill_id: skill, evidence_text: skill })),
    published_at: null,
    fetched_at: "2026-01-01T00:00:00.000Z",
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
    source_key: "career-search-test",
    fetched_at: jobs[0]!.fetched_at,
    collector_version: "test-collector-1",
    jobs,
  });
}

async function titlesFor(filters: Partial<JobFiltersV1>): Promise<string[]> {
  const list = await repository.listJobs({ page: 1, page_size: 20, ...filters });
  assert.equal(list.total, list.items.length, "a single page holds every match");
  return list.items.map((item) => item.title).sort();
}

async function build() {
  const app = Fastify();
  registerCareerHttp(app, repository);
  await app.ready();
  return app;
}

const jobsUrl = (query: string) => `/api/site/career-insights/jobs${query}`;

beforeEach(async () => {
  await sql`TRUNCATE career_job_observations, career_jobs, career_policies, career_ingest_runs RESTART IDENTITY`;
});

after(async () => {
  await closeDb();
});

test("a keyword matches the title, the company, a skill and a city", async () => {
  await seed(
    job({ job_key: "title", title: "数据分析工程师", company_name: "甲公司", locations: ["北京"], skills: ["python"] }),
    job({ job_key: "company", title: "算法工程师", company_name: "数据乙有限公司", locations: ["上海"], skills: ["sql"] }),
    job({ job_key: "skill", title: "后端工程师", company_name: "丙公司", locations: ["深圳"], skills: ["data_analysis"] }),
    job({ job_key: "city", title: "产品经理", company_name: "丁公司", locations: ["杭州"], skills: ["product"] }),
  );

  // 「数据分析」也是技能 data_analysis 的中文标签：标题命中的岗位与技能命中的后端工程师一起返回。
  assert.deepEqual(await titlesFor({ q: "数据分析" }), ["后端工程师", "数据分析工程师"]);
  assert.deepEqual(await titlesFor({ q: "数据乙" }), ["算法工程师"]);
  assert.deepEqual(await titlesFor({ q: "data_analysis" }), ["后端工程师"]);
  assert.deepEqual(await titlesFor({ q: "杭州" }), ["产品经理"]);
  // 同一关键词可命中多个字段：标题、公司各一个，另有 data_analysis 技能岗位（「数据」是技能标签的一部分）。
  assert.deepEqual(await titlesFor({ q: "数据" }), ["后端工程师", "数据分析工程师", "算法工程师"]);
});

test("a Chinese skill label matches the skill id stored on the row", async () => {
  await seed(
    job({ job_key: "backend", title: "后端工程师", company_name: "甲公司", locations: ["北京"], skills: ["data_analysis"] }),
    job({ job_key: "analyst", title: "数据分析工程师", company_name: "乙公司", locations: ["上海"], skills: ["data_analysis"], fetched_at: "2026-01-02T00:00:00.000Z" }),
    job({ job_key: "ml", title: "算法工程师", company_name: "丙公司", locations: ["深圳"], skills: ["machine_learning"] }),
  );

  // 技能列里存的是 data_analysis，搜索框给的是中文标签「数据分析」：反查 ID 后两种写法命中同一批岗位。
  const byLabel = await repository.listJobs({ q: "数据分析", page: 1, page_size: 20 });
  const byId = await repository.listJobs({ q: "data_analysis", page: 1, page_size: 20 });
  assert.equal(byLabel.total, byId.total);
  assert.deepEqual(byLabel.items.map((item) => item.title), ["数据分析工程师", "后端工程师"]);
  assert.deepEqual(byId.items.map((item) => item.title), ["数据分析工程师", "后端工程师"]);
  // 中文标签只反查自己的 ID：机器学习岗位不能被「数据分析」带出来。
  assert.ok(!byLabel.items.some((item) => item.title === "算法工程师"));
  // 标签的一部分也算命中：机器 → 机器学习，这个关键词在标题、公司、城市和技能原文里都不存在。
  assert.deepEqual(await titlesFor({ q: "机器" }), ["算法工程师"]);
});

test("ASCII case does not matter while Chinese matches literally", async () => {
  await seed(
    job({ job_key: "ascii", title: "Data Analyst", company_name: "Acme Labs", skills: ["SQL"], locations: ["Shanghai"] }),
    job({ job_key: "chinese", title: "数据分析师", company_name: "乙公司", skills: ["sql"], locations: ["上海"] }),
  );

  assert.deepEqual(await titlesFor({ q: "data analyst" }), ["Data Analyst"]);
  assert.deepEqual(await titlesFor({ q: "DATA ANALYST" }), ["Data Analyst"]);
  assert.deepEqual(await titlesFor({ q: "acme" }), ["Data Analyst"]);
  assert.deepEqual(await titlesFor({ q: "数据分析师" }), ["数据分析师"]);
});

test("percent, underscore and backslash in the keyword are literals, not wildcards", async () => {
  await seed(
    job({ job_key: "underscore-literal", title: "数据_分析工程师" }),
    job({ job_key: "underscore-wildcard", title: "数据X分析工程师" }),
    job({ job_key: "percent-literal", title: "效率提升 50% 方案" }),
    job({ job_key: "percent-wildcard", title: "效率提升 500 方案" }),
    job({ job_key: "backslash-literal", title: "路径 C:\\tools" }),
    job({ job_key: "slash-other", title: "路径 C:/tools" }),
  );

  assert.deepEqual(await titlesFor({ q: "数据_分析" }), ["数据_分析工程师"]);
  assert.deepEqual(await titlesFor({ q: "50%" }), ["效率提升 50% 方案"]);
  assert.deepEqual(await titlesFor({ q: "C:\\tools" }), ["路径 C:\\tools"]);
  // 转义只把 _ 当普通字符：X 不该被当成下划线命中。
  assert.deepEqual(await titlesFor({ q: "_分析" }), ["数据_分析工程师"]);
});

test("the keyword combines with the other filters and keeps total filtered", async () => {
  await seed(
    job({ job_key: "a", title: "数据分析实习生", role_family: "data", locations: ["北京"], skills: ["sql"], student_friendly: "yes" }),
    job({ job_key: "b", title: "数据分析工程师", role_family: "data", locations: ["上海"], skills: ["python"], student_friendly: "no" }),
    job({ job_key: "c", title: "数据分析专家", role_family: "ai_algorithm", locations: ["北京"], skills: ["python"], student_friendly: "yes" }),
  );

  assert.deepEqual(await titlesFor({ q: "数据分析", city: "北京", student_friendly: "yes" }), ["数据分析专家", "数据分析实习生"].sort());
  assert.deepEqual(await titlesFor({ q: "数据分析", role_family: "ai_algorithm" }), ["数据分析专家"]);
  assert.deepEqual(await titlesFor({ q: "数据分析", skill: "python", city: "上海" }), ["数据分析工程师"]);

  const list = await repository.listJobs({ q: "数据分析", role_family: "data", page: 1, page_size: 20 });
  assert.equal(list.total, 2);
  assert.deepEqual(list.filters, { q: "数据分析", role_family: "data", page: 1, page_size: 20 });
});

test("a keyword with no match answers an empty page with total zero", async () => {
  await seed(job({ job_key: "only", title: "数据分析工程师" }));

  const list = await repository.listJobs({ q: "不存在的关键词", page: 1, page_size: 20 });
  assert.deepEqual(list.items, []);
  assert.equal(list.total, 0);
  assert.equal(list.page, 1);
  assert.equal(list.page_size, 20);
});

test("paging keeps the keyword applied and the total stable across pages", async () => {
  await seed(
    job({ job_key: "old", title: "匹配岗位 旧", fetched_at: "2026-01-01T00:00:00.000Z" }),
    job({ job_key: "mid", title: "匹配岗位 中", fetched_at: "2026-01-02T00:00:00.000Z" }),
    job({ job_key: "new", title: "匹配岗位 新", fetched_at: "2026-01-03T00:00:00.000Z" }),
    job({ job_key: "other", title: "其它岗位", fetched_at: "2026-01-04T00:00:00.000Z" }),
  );

  const first = await repository.listJobs({ q: "匹配岗位", page: 1, page_size: 2 });
  assert.equal(first.total, 3);
  assert.deepEqual(first.items.map((item) => item.title), ["匹配岗位 新", "匹配岗位 中"]);

  const second = await repository.listJobs({ q: "匹配岗位", page: 2, page_size: 2 });
  assert.equal(second.total, 3);
  assert.deepEqual(second.items.map((item) => item.title), ["匹配岗位 旧"]);
});

test("the route accepts a keyword, ignores blank keywords, and rejects oversized or repeated ones", async () => {
  await seed(
    job({ job_key: "a", title: "数据分析工程师" }),
    job({ job_key: "b", title: "算法工程师", fetched_at: "2026-01-02T00:00:00.000Z" }),
  );

  const app = await build();
  try {
    const matched = await app.inject({ url: jobsUrl("?q=%E6%95%B0%E6%8D%AE") });
    assert.equal(matched.statusCode, 200);
    assert.equal(matched.headers["cache-control"], "public, max-age=60, stale-while-revalidate=300");
    const matchedBody = matched.json();
    assert.equal(matchedBody.total, 1);
    assert.deepEqual(matchedBody.items.map((item: { title: string }) => item.title), ["数据分析工程师"]);
    assert.deepEqual(matchedBody.filters, { q: "数据", page: 1, page_size: 20 });

    // 空串与纯空白都等于没传，返回全部；响应 filters 也不带 q。
    for (const url of [jobsUrl("?q="), jobsUrl("?q=%20%20")]) {
      const ignored = await app.inject({ url });
      assert.equal(ignored.statusCode, 200, url);
      assert.equal(ignored.json().total, 2, url);
      assert.deepEqual(ignored.json().filters, { page: 1, page_size: 20 }, url);
    }

    // 关键词前后空白先去再匹配，trim 后 100 字符是上限。
    const padded = await app.inject({ url: jobsUrl(`?q=%20${"a".repeat(100)}%20`) });
    assert.equal(padded.statusCode, 200);
    const atLimit = await app.inject({ url: jobsUrl(`?q=${"a".repeat(100)}`) });
    assert.equal(atLimit.statusCode, 200);
    assert.equal(atLimit.json().total, 0);

    for (const url of [jobsUrl(`?q=${"a".repeat(101)}`), jobsUrl("?q=a&q=b")]) {
      const rejected = await app.inject({ url });
      assert.equal(rejected.statusCode, 400, url);
      assert.equal(rejected.json().error.code, "invalid_parameter", url);
      assert.equal(rejected.headers["cache-control"], "no-store", url);
    }
  } finally {
    await app.close();
  }
});
