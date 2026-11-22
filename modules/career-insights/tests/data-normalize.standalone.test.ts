import assert from "node:assert/strict";
import { test } from "node:test";
import type { RawCollectedJobV1 } from "../contracts/index.ts";
import {
  isCurrentNormalizerVersion,
  NORMALIZER_VERSION,
  normalizeRawJob,
  normalizeRawJobs,
  resolveRoleFamily,
} from "../data/normalize.ts";

function rawJob(overrides: Partial<RawCollectedJobV1> = {}): RawCollectedJobV1 {
  return {
    schema_version: "1.0",
    source_key: "alibaba-official-careers",
    source_job_id: "job-001",
    company_name: "示例公司",
    title: "AI 应用后端开发工程师",
    official_url: "https://careers.example/jobs/1",
    raw_text:
      "负责 AI 应用后端开发，熟悉 Python、Java、Docker 与 RAG。要求本科及以上学历，1-3 年经验。工作地点：深圳。",
    published_at: "2026-11-10",
    fetched_at: "2026-11-16T12:00:00.000Z",
    collector_version: "test/1.0",
    hints: {},
    ...overrides,
  };
}

test("归一化映射职族、地点、学历、经验与技能证据", () => {
  const job = normalizeRawJob(rawJob());

  assert.equal(job.schema_version, "1.0");
  assert.equal(job.normalizer_version, NORMALIZER_VERSION);
  assert.equal(job.role_family, "ai_application_development");
  assert.deepEqual(job.locations, ["深圳"]);
  assert.equal(job.degree, "bachelor");
  assert.match(job.degree_raw ?? "", /本科/);
  assert.equal(job.experience_min_years, 1);
  assert.equal(job.experience_max_years, 3);
  assert.equal(job.experience_raw, "1-3 年经验");
  assert.equal(job.published_at, "2026-11-10");

  assert.ok(job.skills.includes("python"));
  assert.ok(job.skills.includes("java"));
  assert.ok(job.skills.includes("docker"));
  assert.ok(job.skills.includes("retrieval_augmented_generation"));
  for (const evidence of job.skill_evidence) {
    assert.ok(job.skills.includes(evidence.skill_id));
    assert.ok(evidence.evidence_text.length > 0);
  }

  assert.equal(job.job_key, "job-001");
  assert.match(job.content_hash, /^[0-9a-f]{64}$/);
});

test("未写学历和经验时保持 unknown 与 null，不补成 0 年", () => {
  const job = normalizeRawJob(
    rawJob({
      title: "数据分析师",
      raw_text: "负责业务数据分析，熟悉 SQL 与 Python。工作地点：北京。",
    }),
  );

  assert.equal(job.degree, "unknown");
  assert.equal(job.degree_raw, null);
  assert.equal(job.experience_min_years, null);
  assert.equal(job.experience_max_years, null);
  assert.equal(job.experience_raw, null);
  assert.equal(job.student_friendly, "unknown");
  assert.notEqual(job.experience_min_years, 0);
});

test("学历不限是 any_explicit，未写学历才是 unknown", () => {
  assert.equal(
    normalizeRawJob(rawJob({ raw_text: "学历不限，欢迎投递。工作地点：杭州。" })).degree,
    "any_explicit",
  );
  assert.equal(
    normalizeRawJob(rawJob({ raw_text: "负责后端开发。工作地点：杭州。" })).degree,
    "unknown",
  );
});

test("学生友好只按明确证据判定", () => {
  const campus = normalizeRawJob(
    rawJob({
      title: "AI 应用开发工程师（校园招聘）",
      raw_text: "2027 届校园招聘，欢迎应届生投递。工作地点：深圳。",
    }),
  );
  assert.equal(campus.employment_type, "campus");
  assert.equal(campus.student_friendly, "yes");

  const internship = normalizeRawJob(
    rawJob({
      title: "算法实习生",
      raw_text: "日常实习，参与大模型应用开发。工作地点：北京。",
    }),
  );
  assert.equal(internship.employment_type, "internship");
  assert.equal(internship.student_friendly, "yes");

  const experienced = normalizeRawJob(
    rawJob({
      title: "资深算法工程师",
      raw_text: "要求 3 年以上相关经验，熟悉推荐算法。工作地点：上海。",
    }),
  );
  assert.equal(experienced.experience_min_years, 3);
  assert.equal(experienced.student_friendly, "no");

  const unknown = normalizeRawJob(
    rawJob({
      title: "数据分析师",
      raw_text: "负责业务数据分析。工作地点：北京。",
    }),
  );
  assert.equal(unknown.student_friendly, "unknown", "未写经验不能判为 yes");
});

test("经验不限保留原文但不转换为 0 年", () => {
  const job = normalizeRawJob(
    rawJob({
      title: "AI 产品经理",
      raw_text: "经验不限，欢迎应届生投递。工作地点：杭州。",
    }),
  );

  assert.equal(job.experience_min_years, null);
  assert.equal(job.experience_max_years, null);
  assert.equal(job.experience_raw, "经验不限");
  assert.equal(job.student_friendly, "yes");
});

test("批量归一化把非法样本放入 rejected，不阻断合法样本", () => {
  const result = normalizeRawJobs([
    rawJob(),
    rawJob({ source_job_id: "job-002", official_url: "ftp://careers.example/jobs/2" }),
    rawJob({ source_job_id: "job-003", fetched_at: "2026-11-16T12:00:00+08:00" }),
  ]);

  assert.equal(result.normalized.length, 1);
  assert.equal(result.rejected.length, 2);
  assert.equal(result.normalized[0]?.job_key, "job-001");
});
// C-ROLE-KEYWORDS@2 负例：裸「运营」「大模型」「架构师」不再单独决定职族。
test("负例 1：安全运营岗位不被算作 AI 产品运营", () => {
  assert.equal(resolveRoleFamily("unknown", "高级安全运营工程师"), "unknown");
});

test("负例 2：游戏运营不被算作 AI 产品运营", () => {
  assert.equal(resolveRoleFamily("unknown", "游戏运营"), "unknown");
  assert.equal(resolveRoleFamily("unknown", "K6合作部-游戏运营-社区及用户运营"), "unknown");
});

test("负例 3：大模型销售归销售，不被算作算法岗", () => {
  const family = resolveRoleFamily("unknown", "大模型即云计算大客户销售-华南游戏方向（J107254）");
  assert.notEqual(family, "ai_algorithm");
  assert.equal(family, "sales_business");
});

test("负例 4：大客户技术支持不被算作算法岗", () => {
  assert.notEqual(
    resolveRoleFamily("unknown", "大客户技术支持-大模型方向（J107350）"),
    "ai_algorithm",
  );
});

test("负例 5：售前架构师归销售/商务，不被算作开发岗", () => {
  const family = resolveRoleFamily("unknown", "腾讯云-云和AI售前架构师（物流方向）-北/上/深");
  assert.notEqual(family, "ai_application_development");
  assert.equal(family, "sales_business");
});

test("负例 6：商务/渠道归销售，接待/顾问仍保持 unknown", () => {
  assert.equal(resolveRoleFamily("unknown", "通讯-商务拓展专家-运营商方向"), "sales_business");
  assert.equal(resolveRoleFamily("unknown", "渠道经理（J107385）"), "sales_business");
  for (const title of ["客工部接待经理（J101012）", "海外服务顾问（J107080）"]) {
    assert.equal(resolveRoleFamily("unknown", title), "unknown", title);
  }
});

test("明确的 AI 产品/工程标题仍然被识别，不受负例收窄影响", () => {
  assert.equal(resolveRoleFamily("unknown", "AI产品运营岗"), "ai_product_operations");
  assert.equal(resolveRoleFamily("unknown", "ima-高级产品经理（基础框架）"), "ai_product_operations");
  assert.equal(resolveRoleFamily("unknown", "全栈开发工程师（J107271）"), "ai_application_development");
  assert.equal(resolveRoleFamily("data", "AI后端开发工程师"), "data", "已知提示仍然优先于标题");
});

test("归一化版本随 B1 规则 bump 到 normalizer/0.3.0", () => {
  assert.equal(NORMALIZER_VERSION, "normalizer/0.3.0");
});

test("判定当前归一化版本：0.3.0 与 LLM 兜底版本有效，其余无效", () => {
  assert.equal(isCurrentNormalizerVersion(NORMALIZER_VERSION), true);
  assert.equal(isCurrentNormalizerVersion("normalizer/llm-0.1"), true);
  assert.equal(isCurrentNormalizerVersion(null), false);
  assert.equal(isCurrentNormalizerVersion("normalizer/0.2.0"), false);
  assert.equal(isCurrentNormalizerVersion("normalizer/0.1.0"), false);
  assert.equal(isCurrentNormalizerVersion("unknown"), false);
});
