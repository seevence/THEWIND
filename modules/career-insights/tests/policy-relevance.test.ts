// 政策相关性口径（P0-policy）：政策页来自通用政府文件库，必须把与就业/产业发展无关的文件挡在
// 库里（采集拒绝并计数）和读路径上（列表/分面/日报计数/研判与评论输入）。判定与 SQL 条件共用
// 同一份标题词表，本文件先钉规则本身，再用真实生产库的 6 条标题验证口径，最后验证页面数字一致。
import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { buildCareerBriefInput } from "../backend/brief.ts";
import { loadCareerDaily } from "../backend/career-analytics.ts";
import { loadDailyCommentInput } from "../backend/career-daily-comment.ts";
import {
  assessPolicyRelevance,
  careerPolicyRelevanceSql,
  isCareerRelevantPolicy,
} from "../backend/policy-relevance.ts";
import {
  listPolicyEvidence,
  writePolicyBatch,
  type PolicyBatchInputV1,
  type PolicyItemInputV1,
} from "../backend/policy-repository.ts";
import { SqlCareerRepository } from "../backend/sql-repository.ts";

const repository = new SqlCareerRepository(sql);
const FETCHED_AT = "2026-11-21T00:00:00.000Z";

/** 生产库 career_policies 现有的 6 条，按采集时间原样复刻；读侧过滤要能解释每一项去留。 */
const DEPLOYED_POLICIES: ReadonlyArray<{
  id: string;
  source_key: string;
  title: string;
  published_at: string;
  theme_ids: string[];
}> = [
  {
    id: "content_7086080",
    source_key: "state-council-policy",
    title: "中共中央印发《中国共产党地方委员会工作条例》",
    published_at: "2026-11-15",
    theme_ids: [],
  },
  {
    id: "t20261113_1408810",
    source_key: "ndrc-policy",
    title: "关于印发《“十五五”新型储能实施方案》的通知(发改能源〔2026〕1565号)",
    published_at: "2026-11-13",
    theme_ids: [],
  },
  {
    id: "content_7085591",
    source_key: "state-council-policy",
    title: "中医药传统知识保护条例",
    published_at: "2026-11-09",
    theme_ids: ["talent_development"],
  },
  {
    id: "t20261109_1408709",
    source_key: "ndrc-policy",
    title: "关于印发《全国守信激励措施基础清单(2026年版)》的通知(发改财金〔2026〕1593号)",
    published_at: "2026-11-09",
    theme_ids: [],
  },
  {
    id: "content_7085529",
    source_key: "state-council-policy",
    title: "中共中央发出通知 部署党的二十一大代表选举工作",
    published_at: "2026-11-07",
    theme_ids: ["employment_promotion"],
  },
  {
    id: "t20261103_1408504",
    source_key: "ndrc-policy",
    title: "关于印发《实施全面节约战略行动方案》的通知(发改环资〔2026〕1424号)",
    published_at: "2026-11-04",
    theme_ids: [],
  },
];

function policy(overrides: Partial<PolicyItemInputV1> = {}): PolicyItemInputV1 {
  return {
    policy_item_id: "policy-1",
    source_key: "ndrc-policy",
    source_tier: "government_official",
    title: "关于做好高校毕业生就业创业工作的通知",
    issuer: "国家发展和改革委员会",
    published_at: "2026-11-20",
    official_url: "https://www.ndrc.gov.cn/xxgk/zcfb/tz/202611/policy-1.html",
    theme_ids: ["employment_promotion"],
    evidence_excerpt: "政策摘录",
    content_hash: "a".repeat(64),
    collector_version: "test-collector-1",
    fetched_at: FETCHED_AT,
    ...overrides,
  };
}

function batchOf(policies: PolicyItemInputV1[], overrides: Partial<PolicyBatchInputV1> = {}): PolicyBatchInputV1 {
  return {
    source_key: policies[0]?.source_key ?? "ndrc-policy",
    fetched_at: policies[0]?.fetched_at ?? FETCHED_AT,
    collector_version: "test-collector-1",
    data_origin: "live",
    policies,
    ...overrides,
  };
}

/** 模拟生产库里已经存在、当年由旧采集写进来的行：采集侧拒绝不会删除它们，读侧必须自己过滤。 */
async function insertStoredPolicy(policy: {
  id: string;
  source_key: string;
  title: string;
  published_at: string | null;
  theme_ids?: string[];
  first_seen_at?: string;
}): Promise<void> {
  const firstSeenAt = policy.first_seen_at ?? "2026-11-19T08:30:00.000Z";
  await sql`
    INSERT INTO career_policies (
      policy_item_id, source_key, source_tier, title, issuer, published_at, official_url,
      theme_ids, evidence_excerpt, content_hash, collector_version, data_origin,
      fetched_at, first_seen_at, last_seen_at
    ) VALUES (
      ${policy.id}, ${policy.source_key}, 'government_official', ${policy.title}, '国家发展和改革委员会',
      ${policy.published_at}, ${"https://www.gov.cn/zhengce/" + policy.id},
      ${sql.json(policy.theme_ids ?? [])}::jsonb, '政策摘录', ${"b".repeat(64)},
      'test-collector-1', 'live',
      ${firstSeenAt}::timestamptz, ${firstSeenAt}::timestamptz, ${firstSeenAt}::timestamptz
    )`;
}

after(async () => {
  await closeDb();
});

beforeEach(async () => {
  await sql`TRUNCATE career_daily_comments, career_briefs, career_job_observations, career_jobs, career_policies, career_ingest_runs RESTART IDENTITY`;
});

test("就业相关政策判为相关", () => {
  for (const title of [
    "关于做好高校毕业生就业创业工作的通知",
    "关于印发《职业技能提升行动方案》的通知",
    "关于建设统一规范人力资源市场的指导意见",
    "关于支持中小企业稳岗扩岗的通知",
    "关于规范劳务派遣用工管理的通知",
    "关于促进民营经济发展壮大的意见",
    "国务院关于印发制造业数字化转型行动方案的通知",
    "国务院关于深入实施“人工智能+”行动的意见",
  ]) {
    assert.equal(isCareerRelevantPolicy(title), true, title);
  }
});

test("支持、指导行业发展的政策也算相关（新型储能、中医药、人工智能、制造业转型）", () => {
  for (const title of [
    "关于印发《“十五五”新型储能实施方案》的通知",
    "中医药传统知识保护条例",
    "关于推动中医药产业高质量发展的指导意见",
    "国务院关于深入实施“人工智能+”行动的意见",
    "关于加快推进制造业数字化转型的实施意见",
    "关于培育壮大文化旅游产业的指导意见",
  ]) {
    assert.equal(isCareerRelevantPolicy(title), true, title);
  }
});

test("国家战略/行动方案与守信激励/信用/营商环境类政策也算相关", () => {
  for (const title of [
    "关于印发《实施全面节约战略行动方案》的通知",
    "关于深入实施国家重大区域发展战略的意见",
    "关于印发《扩大内需战略规划纲要》的通知",
    "关于印发《全国守信激励措施基础清单(2026年版)》的通知",
    "关于完善社会信用体系建设构建以信用为基础的新型监管机制的指导意见",
    "关于持续优化营商环境的实施意见",
    "关于印发涉企收费清单的通知",
  ]) {
    assert.equal(isCareerRelevantPolicy(title), true, title);
  }
});

test("选举、任免、外事、军事、纪念表彰等与经济社会发展无关的政务文件判为无关", () => {
  for (const title of [
    "中共中央发出通知 部署党的二十一大代表选举工作",
    "关于任免国家工作人员的通知",
    "关于做好外事会见活动安排的通知",
    "中华人民共和国国防动员法",
    "关于举行纪念活动周年庆典的通知",
    "关于表彰全国就业创业先进集体和个人的决定",
    "中共中央印发《中国共产党地方委员会工作条例》",
    "关于做好2027年元旦春节期间有关工作的通知",
  ]) {
    assert.equal(isCareerRelevantPolicy(title), false, title);
  }
});

test("判定结果带命中词和原因，采集拒绝可复用同一句解释", () => {
  assert.deepEqual(assessPolicyRelevance("中医药传统知识保护条例"), {
    relevant: true,
    reason: "career_keyword",
    matched: "中医药",
  });
  assert.deepEqual(assessPolicyRelevance("中共中央发出通知 部署党的二十一大代表选举工作"), {
    relevant: false,
    reason: "excluded_topic",
    matched: "选举",
  });
  assert.deepEqual(assessPolicyRelevance("中共中央印发《中国共产党地方委员会工作条例》"), {
    relevant: false,
    reason: "no_career_keyword",
    matched: null,
  });
});

test("生产库现有 6 条按宽口径保留 4 条：储能、中医药、守信清单、节约战略", () => {
  const shown = DEPLOYED_POLICIES.filter((policy) => isCareerRelevantPolicy(policy.title));
  assert.deepEqual(
    shown.map((policy) => policy.id),
    ["t20261113_1408810", "content_7085591", "t20261109_1408709", "t20261103_1408504"],
    "产业发展、守信清单与国家战略行动方案都显示；党委条例与选举通知隐藏",
  );
});

test("读侧 SQL 条件与函数判定对同一批标题逐条一致", async () => {
  const titles = [
    ...DEPLOYED_POLICIES.map((policy) => policy.title),
    "关于做好高校毕业生就业创业工作的通知",
    "关于促进民营经济发展壮大的意见",
    "关于任免国家工作人员的通知",
    "关于举行纪念活动的通知",
    "关于规范劳务派遣用工管理的通知",
    "关于做好2027年元旦春节期间有关工作的通知",
  ];
  const rows = await sql<{ title: string; hit: boolean }[]>`
    SELECT t.title, (${careerPolicyRelevanceSql()}) AS hit
    FROM unnest(${titles}::text[]) AS t(title)`;
  assert.equal(rows.length, titles.length);
  for (const row of rows) assert.equal(row.hit, isCareerRelevantPolicy(row.title), row.title);
});

test("列表、分面、日报计数、研判与评论输入只含相关政策", async () => {
  for (const policy of DEPLOYED_POLICIES) await insertStoredPolicy(policy);
  // 读取路径按「今天」统计新增：补一条今天入库的相关和一条今天入库的无关，验证两边都被区分。
  const today = new Date().toISOString();
  await insertStoredPolicy({
    id: "t20261121_900001",
    source_key: "ndrc-policy",
    title: "关于促进人工智能产业发展的指导意见",
    published_at: "2026-11-21",
    theme_ids: ["artificial_intelligence"],
    first_seen_at: today,
  });
  await insertStoredPolicy({
    id: "content_20261121_party",
    source_key: "state-council-policy",
    title: "关于召开纪念活动的通知",
    published_at: "2026-11-21",
    first_seen_at: today,
  });

  const listed = await repository.listPolicies({ page: 1, page_size: 20 });
  assert.equal(listed.total, 5);
  assert.deepEqual(
    listed.items.map((item) => item.policy_item_id),
    [
      "t20261121_900001",
      "t20261113_1408810",
      "content_7085591",
      "t20261109_1408709",
      "t20261103_1408504",
    ],
  );
  assert.ok(listed.items.every((item) => isCareerRelevantPolicy(item.title)));
  assert.deepEqual(listed.facets.sources, [
    { source_key: "ndrc-policy", count: 4 },
    { source_key: "state-council-policy", count: 1 },
  ]);
  assert.deepEqual(listed.facets.themes, [
    { theme_id: "artificial_intelligence", count: 1 },
    { theme_id: "talent_development", count: 1 },
  ]);

  const evidence = await listPolicyEvidence(sql);
  assert.equal(evidence.length, 5);
  assert.ok(evidence.every((ref) => isCareerRelevantPolicy(ref.title)));

  const daily = await loadCareerDaily(sql);
  assert.equal(daily.policies_total, 5);
  assert.equal(daily.new_policies_today, 1, "今天新增的两条里只有相关的那条计数");

  const commentInput = await loadDailyCommentInput(sql, daily.date);
  assert.equal(commentInput.new_policy_count, 1);
  assert.deepEqual(
    commentInput.new_policies.map((policy) => policy.title),
    ["关于促进人工智能产业发展的指导意见"],
  );
  assert.deepEqual(
    commentInput.evidence_candidates.filter((candidate) => candidate.kind === "policy").map((candidate) => candidate.title),
    ["关于促进人工智能产业发展的指导意见"],
    "评论输入的可引用政策 id 是行 id，标题才能证明过滤的是这一条",
  );

  const brief = await buildCareerBriefInput(sql, { limit: 10, window_days: 30 });
  const policyEvidence = brief.evidence_candidates.filter((candidate) => candidate.kind === "policy");
  assert.equal(policyEvidence.length, 5);
  assert.ok(policyEvidence.every((candidate) => isCareerRelevantPolicy(candidate.title)));
});

test("采集入库拒绝无关政策，并把拒绝数计入 rejected 与运行记录", async () => {
  const result = await writePolicyBatch(
    sql,
    batchOf([
      policy(),
      policy({
        policy_item_id: "p-credit",
        title: "关于印发《全国守信激励措施基础清单(2026年版)》的通知",
        content_hash: "c".repeat(64),
      }),
      policy({
        policy_item_id: "p-strategy",
        title: "关于印发《实施全面节约战略行动方案》的通知",
        content_hash: "d".repeat(64),
      }),
      policy({
        policy_item_id: "p-election",
        title: "中共中央发出通知 部署党的二十一大代表选举工作",
        content_hash: "e".repeat(64),
      }),
      policy({
        policy_item_id: "p-party-regulation",
        title: "中共中央印发《中国共产党地方委员会工作条例》",
        content_hash: "f".repeat(64),
      }),
    ]),
  );

  assert.equal(result.accepted, 3, "就业、守信清单、国家战略行动方案都入库");
  assert.equal(result.updated, 0);
  assert.equal(result.duplicates, 0);
  assert.equal(result.rejected, 2);
  assert.deepEqual(result.errors, [
    { index: 3, code: "policy_irrelevant", message: "title contains an excluded topic: 选举" },
    { index: 4, code: "policy_irrelevant", message: "title has no employment or industry-development keyword" },
  ]);

  const rows = await sql<{ title: string }[]>`SELECT title FROM career_policies`;
  assert.equal(rows.length, 3);
  assert.ok(rows.every((row) => isCareerRelevantPolicy(row.title)));
  assert.equal(
    rows.some((row) => row.title.includes("选举") || row.title.includes("地方委员会工作条例")),
    false,
    "被拒绝的两条不进库",
  );

  const runs = await sql<{ status: string; error: string | null }[]>`
    SELECT status, error FROM career_ingest_runs`;
  assert.equal(runs[0]!.status, "partial");
  assert.match(runs[0]!.error ?? "", /2 policy item\(s\) rejected/);
});
