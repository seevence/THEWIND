import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AI_TITLE_TERMS,
  LLM_NORMALIZER_VERSION,
  downgradeNonAiOperations,
  firstMatchingTerm,
  isRerunAipoCandidate,
  llmNormalizationSchema,
  mapSkillsToKnown,
  needsLlmNormalization,
  runBackfill,
  type CandidateStore,
  type CareerJobRow,
  type LlmCaller,
  type LlmNormalizedFields,
} from "../../../scripts/backfill-normalizer-llm.ts";

interface JobRecord extends CareerJobRow {
  last_seen_at: string;
  content_hash: string;
  created_at: string;
  raw_payload: Record<string, unknown> | null;
}

function job(overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    id: overrides.id ?? "11111111-1111-1111-1111-111111111111",
    title: "机器学习平台工程师",
    raw_text: "负责机器学习平台开发，熟悉 Python 与 SQL，要求 1-3 年经验。",
    degree_raw: "本科",
    experience_raw: "1-3 年经验",
    skills: [],
    experience_min_years: null,
    experience_max_years: null,
    role_family: "unknown",
    student_friendly: "unknown",
    normalizer_version: "normalizer/0.3.0",
    last_seen_at: "2026-11-01T00:00:00.000Z",
    content_hash: "a".repeat(64),
    created_at: "2026-10-01T00:00:00.000Z",
    raw_payload: { source: "fixture" },
    ...overrides,
  };
}

class MemoryStore implements CandidateStore {
  readonly jobs: JobRecord[];
  readonly updates: Array<{ id: string; fields: LlmNormalizedFields }> = [];

  constructor(jobs: readonly JobRecord[]) {
    this.jobs = jobs.map((item) => ({ ...item }));
  }

  async listCandidates(limit: number | null): Promise<CareerJobRow[]> {
    return this.jobs
      .filter((item) => needsLlmNormalization(item) && item.normalizer_version !== LLM_NORMALIZER_VERSION)
      .slice(0, limit ?? undefined)
      .map((item) => ({ ...item }));
  }

  async listRerunAipoCandidates(limit: number | null): Promise<CareerJobRow[]> {
    return this.jobs
      .filter((item) => isRerunAipoCandidate(item))
      .slice(0, limit ?? undefined)
      .map((item) => ({ ...item }));
  }

  async listByIds(ids: readonly string[]): Promise<CareerJobRow[]> {
    const wanted = new Set(ids);
    return this.jobs.filter((item) => wanted.has(item.id)).map((item) => ({ ...item }));
  }

  async updateLlmFields(id: string, fields: LlmNormalizedFields, force = false): Promise<number> {
    const target = this.jobs.find((item) => item.id === id);
    if (target === undefined) return 0;
    if (!force && target.normalizer_version === LLM_NORMALIZER_VERSION) return 0;
    this.updates.push({ id, fields });
    target.role_family = fields.role_family;
    target.student_friendly = fields.student_friendly;
    target.skills = fields.skills;
    target.experience_min_years = fields.experience_min_years;
    target.experience_max_years = fields.experience_max_years;
    target.normalizer_version = LLM_NORMALIZER_VERSION;
    return 1;
  }
}

function fakeLlm(outputs: readonly unknown[]): { callLlm: LlmCaller; calls: () => number; maxActive: () => number } {
  let index = 0;
  let calls = 0;
  let active = 0;
  let maxActive = 0;
  return {
    callLlm: async () => {
      calls += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      const data = outputs[Math.min(index, outputs.length - 1)];
      index += 1;
      active -= 1;
      return { data, usage: { prompt_tokens: 120, completion_tokens: 30 } };
    },
    calls: () => calls,
    maxActive: () => maxActive,
  };
}

const validOutput = {
  role_family: "ai_algorithm",
  student_friendly: "yes",
  skills: ["python", "sql"],
  experience_min_years: 1,
  experience_max_years: 3,
};

test("schema 严格校验：枚举越界、额外字段与 min > max 均判失败", () => {
  assert.equal(llmNormalizationSchema.safeParse(validOutput).success, true);
  assert.equal(llmNormalizationSchema.safeParse({ ...validOutput, role_family: "sales" }).success, false);
  assert.equal(llmNormalizationSchema.safeParse({ ...validOutput, student_friendly: "maybe" }).success, false);
  assert.equal(llmNormalizationSchema.safeParse({ ...validOutput, extra: true }).success, false);
  assert.equal(
    llmNormalizationSchema.safeParse({ ...validOutput, experience_min_years: 5, experience_max_years: 2 }).success,
    false,
  );
});

test("schema 非法行重试一次后跳过，不写库", async () => {
  const store = new MemoryStore([job()]);
  const llm = fakeLlm([{ ...validOutput, role_family: "sales" }]);
  const summary = await runBackfill({ apply: true, limit: null, callLlm: llm.callLlm, store });

  assert.equal(summary.failed, 1);
  assert.equal(summary.schemaRejected, 1);
  assert.equal(summary.changed, 0);
  assert.equal(summary.calls, 2);
  assert.equal(summary.retries, 1);
  assert.equal(summary.usageMissingCalls, 2);
  assert.deepEqual(summary.usage, { prompt_tokens: 0, completion_tokens: 0 });
  assert.equal(store.updates.length, 0);
  assert.equal(store.jobs[0]!.normalizer_version, "normalizer/0.3.0");
  assert.equal(store.jobs[0]!.role_family, "unknown");
});

test("网络失败与 schema 非法分开计数，失败调用 token 标注未计入", async () => {
  const store = new MemoryStore([job()]);
  let calls = 0;
  const callLlm: LlmCaller = async () => {
    calls += 1;
    throw new Error("network down");
  };
  const summary = await runBackfill({ apply: true, limit: null, callLlm, store });

  assert.equal(calls, 2);
  assert.equal(summary.failed, 1);
  assert.equal(summary.schemaRejected, 0);
  assert.equal(summary.usageMissingCalls, 2);
  assert.deepEqual(summary.usage, { prompt_tokens: 0, completion_tokens: 0 });
  assert.equal(store.updates.length, 0);
});

test("模型给不出结论时既有 skills / 年限 / 已分类枚举不被回退，第二次 0 变更", async () => {
  const store = new MemoryStore([
    job({
      skills: ["machine_learning"],
      experience_min_years: 1,
      experience_max_years: 3,
      role_family: "ai_product_operations",
      student_friendly: "unknown",
    }),
  ]);
  const llm = fakeLlm([
    {
      role_family: "unknown",
      student_friendly: "unknown",
      skills: [],
      experience_min_years: null,
      experience_max_years: null,
    },
  ]);

  const first = await runBackfill({ apply: true, limit: null, callLlm: llm.callLlm, store });

  assert.equal(first.changed, 1);
  const fields = store.updates[0]!.fields;
  assert.deepEqual(fields.skills, ["machine_learning"]);
  assert.equal(fields.role_family, "ai_product_operations");
  assert.equal(fields.experience_min_years, 1);
  assert.equal(fields.experience_max_years, 3);
  assert.equal(fields.student_friendly, "unknown");
  assert.deepEqual(store.jobs[0]!.skills, ["machine_learning"]);
  assert.equal(store.jobs[0]!.role_family, "ai_product_operations");
  assert.equal(store.jobs[0]!.experience_min_years, 1);
  assert.equal(store.jobs[0]!.experience_max_years, 3);

  const second = await runBackfill({ apply: true, limit: null, callLlm: llm.callLlm, store });
  assert.equal(second.candidates, 0);
  assert.equal(second.changed, 0);
  assert.equal(second.calls, 0);
  assert.equal(store.updates.length, 1);
});

test("模型给出的技能与既有 skills 取并集，不丢既有项", async () => {
  const store = new MemoryStore([
    job({ skills: ["machine_learning"], role_family: "ai_algorithm", student_friendly: "unknown" }),
  ]);
  const llm = fakeLlm([{ ...validOutput, skills: ["Python", "machine_learning"] }]);

  const summary = await runBackfill({ apply: true, limit: null, callLlm: llm.callLlm, store });

  assert.equal(summary.changed, 1);
  assert.deepEqual(store.updates[0]!.fields.skills, ["machine_learning", "python"]);
  assert.equal(store.updates[0]!.fields.role_family, "ai_algorithm");
});

test("词表外的技能被丢弃并计数，其余按词表映射", async () => {
  const store = new MemoryStore([job()]);
  const llm = fakeLlm([{ ...validOutput, skills: ["Python", "量子计算", "", "SQL"] }]);
  const summary = await runBackfill({ apply: true, limit: null, callLlm: llm.callLlm, store });

  assert.equal(summary.changed, 1);
  assert.equal(summary.droppedSkillTerms, 2);
  assert.deepEqual(store.updates[0]!.fields.skills, ["python", "sql"]);
  assert.deepEqual(mapSkillsToKnown(["python", "量子计算"]), { skills: ["python"], dropped: ["量子计算"] });
});

test("第二次 --apply 为 0 变更，且不再调用模型", async () => {
  const store = new MemoryStore([job()]);
  const llm = fakeLlm([validOutput]);

  const first = await runBackfill({ apply: true, limit: null, callLlm: llm.callLlm, store });
  assert.equal(first.candidates, 1);
  assert.equal(first.changed, 1);
  assert.equal(llm.calls(), 1);

  const second = await runBackfill({ apply: true, limit: null, callLlm: llm.callLlm, store });
  assert.equal(second.candidates, 0);
  assert.equal(second.changed, 0);
  assert.equal(second.calls, 0);
  assert.equal(llm.calls(), 1);
  assert.equal(store.updates.length, 1);
});

test("只写白名单字段，观测/时间/哈希保持前后一致", async () => {
  const store = new MemoryStore([job()]);
  const before = { ...store.jobs[0]! };
  const llm = fakeLlm([validOutput]);

  await runBackfill({ apply: true, limit: null, callLlm: llm.callLlm, store });

  const after = store.jobs[0]!;
  assert.deepEqual(Object.keys(store.updates[0]!.fields).sort(), [
    "experience_max_years",
    "experience_min_years",
    "role_family",
    "skills",
    "student_friendly",
  ]);
  assert.equal(after.last_seen_at, before.last_seen_at);
  assert.equal(after.content_hash, before.content_hash);
  assert.equal(after.created_at, before.created_at);
  assert.deepEqual(after.raw_payload, before.raw_payload);
  assert.equal(after.normalizer_version, LLM_NORMALIZER_VERSION);
});

test("dry-run 不写库但仍汇总 usage", async () => {
  const store = new MemoryStore([job(), job({ id: "22222222-2222-2222-2222-222222222222", title: "数据分析师" })]);
  const llm = fakeLlm([validOutput]);

  const summary = await runBackfill({ apply: false, limit: 1, callLlm: llm.callLlm, store });

  assert.equal(summary.candidates, 1);
  assert.equal(summary.called, 1);
  assert.equal(summary.changed, 1);
  assert.equal(summary.usage.prompt_tokens, 120);
  assert.equal(summary.usage.completion_tokens, 30);
  assert.equal(store.updates.length, 0);
});

test("并发上限为 3", async () => {
  const store = new MemoryStore(
    Array.from({ length: 7 }, (_, index) =>
      job({ id: `${index}0000000-0000-0000-0000-000000000000`, title: `岗位 ${index}` }),
    ),
  );
  const llm = fakeLlm([validOutput]);

  await runBackfill({ apply: false, limit: null, callLlm: llm.callLlm, store });

  assert.equal(llm.maxActive(), 3);
});
const aipoOutput = {
  role_family: "ai_product_operations",
  student_friendly: "unknown",
  skills: [],
  experience_min_years: null,
  experience_max_years: null,
};

/** 6 条已被抽检确认为误判的行：title 是传统领域岗，正文只把 AI 当工具。 */
const misjudgedFixtures = [
  {
    id: "014d2041-0000-0000-0000-000000000001",
    title: "拼好饭-区域品牌采购策略",
    raw_text:
      "1、制定拼好饭区域品牌采购业务的短中长期发展规划。\n4、协同产品团队将策略沉淀为一线作业机制与AI工具。" +
      "\n4、熟练使用大模型工具辅助分析作业，有将重复性工作沉淀为工具/Skill的实操经验。",
  },
  {
    id: "8a2655c0-0000-0000-0000-000000000002",
    title: "服务风险客服主管",
    raw_text:
      "1.负责15人左右的组维度管理工作，包括员工日常管理、辅导改善、答疑、复盘。" +
      "\n5.探索AI工具在客服场景的应用，推动智能客服、智能质检等AI能力落地，提升团队运营效率。",
  },
  {
    id: "dacf1a49-0000-0000-0000-000000000003",
    title: "魔方市场用户研究经理（射击线）",
    raw_text:
      "1.负责跟进工作室重点产品全生命周期研发运营过程，深度分析产品问题，建立评估体系。" +
      "\n2.2年以上游戏相关从业经历，市场用户研究/游戏应用与研究/游戏测评经验者优先。",
  },
  {
    id: "50b3a612-0000-0000-0000-000000000004",
    title: "HRSSC智能运营优化专家",
    raw_text:
      "负责统筹公司各项员工服务的一项或多项运营管理工作，以“AI+HR服务”为主线进行政策规则设计。" +
      "\n服务的AI自助化、人机协同（AI做预处理与辅助），让AI成为服务运营的强大生产力。",
  },
  {
    id: "9815e68c-0000-0000-0000-000000000005",
    title: "国际化HR系统实施专家",
    raw_text:
      "把 AI（大模型、Agent、工作流）有效应用到 HR 场景——员工入离职、组织及人员调整。" +
      "\n端到端负责需求分析、流程设计、Agent编排、运营迭代；3年以上toB产品或HRIS经验优先。",
  },
  {
    id: "96c67f5e-0000-0000-0000-000000000006",
    title: "美团会员-权益经营",
    raw_text:
      "1、目标跟踪与经营分析，协助拆解会员各方向的经营目标，输出经营分析报告。" +
      "\n1、3年以上业务运营、经营分析、项目管理或相关岗位经验。",
  },
];

test("--rerun-aipo：6 条已知误判（传统领域岗 + AI 仅作工具）回退 unknown", async () => {
  const store = new MemoryStore(
    misjudgedFixtures.map((fixture) =>
      job({ ...fixture, role_family: "ai_product_operations", normalizer_version: "normalizer/llm-0.1" }),
    ),
  );
  const llm = fakeLlm([aipoOutput]);

  const summary = await runBackfill({ apply: true, limit: null, rerunAipo: true, callLlm: llm.callLlm, store });

  assert.equal(summary.candidates, 6);
  assert.equal(summary.calls, 6);
  assert.equal(summary.changed, 6);
  assert.equal(summary.downgraded, 6);
  for (const fixture of misjudgedFixtures) {
    const row = store.jobs.find((item) => item.id === fixture.id)!;
    assert.equal(row.role_family, "unknown", `${fixture.title} 应回退 unknown`);
    assert.equal(row.normalizer_version, LLM_NORMALIZER_VERSION);
  }
  assert.equal(store.updates.length, 6);
  assert.deepEqual(
    store.updates.map((update) => update.fields.role_family),
    Array.from({ length: 6 }, () => "unknown"),
  );
});

/** 第二轮收紧：标题命中产品/架构/策划/合作商职能词的传统岗（T79 残留 8 条）。 */
const roundTwoFixtures = [
  {
    id: "18f54f89-0000-0000-0000-000000000101",
    title: "差旅场景组-产品经理",
    raw_text:
      "负责差旅场景下出行/住宿产品功能的规划与设计，输出高质量产品方案；协同技术、运营、商务等团队推进落地。" +
      "\n3年以上产品经理工作经验；能熟练应用AI工具完成以项目或完整能力为目标的产品能力建设。",
  },
  {
    id: "225bfe26-0000-0000-0000-000000000102",
    title: "微信小店-产品策划-b 端产品方向",
    raw_text:
      "负责商业交易产研相关功能的策划，从产品概念提出、设计到推动实施；结合商家经营模式制定产品方向与功能规划。" +
      "\n1年及以上产品策划经验，有电商行业背景优先。",
  },
  {
    id: "365f9ba0-0000-0000-0000-000000000103",
    title: "金融解决方案架构师（J107444）",
    raw_text:
      "面向金融机构客户做需求洞察与经营，识别云与人工智能领域的建设需求；负质检云整体解决方案规划与售前全流程推进" +
      "（需求分析、方案设计、技术交流、架构评估、POC、投标）；5年以上企业级解决方案或技术售前经验。",
  },
  {
    id: "4803cd06-0000-0000-0000-000000000104",
    title: "合作商管理专家",
    raw_text:
      "制定并优化合作商管理制度与流程；负责合作商成本分析改善与绩效评估，联动前线推动改善闭环；" +
      "\n5年以上合作商管理或相关业务运营经验；熟练使用AI工具，帮助工作提效。",
  },
  {
    id: "5caff3f3-0000-0000-0000-000000000105",
    title: "产品经理（联盟 C 端产品方向）",
    raw_text:
      "负责联盟 C 端产品链路建设，覆盖用户从触达、浏览、交易到核销的全交易链路；主导关键转化环节的产品设计与迭代；" +
      "\n5年以上互联网产品经验，有导购/CPS 联盟或交易类产品经验者优先。",
  },
  {
    id: "5e7bd45f-0000-0000-0000-000000000106",
    title: "到餐交履产品经理/高级产品经理（排队快点方向）",
    raw_text:
      "负责排队快点产品的中长期规划，打通排队系统与第三方SaaS的深度对接；负责用户端选号、预点餐、支付等交互链路的设计与迭代。" +
      "\n5年以上互联网产品经验，有O2O、到店/到家交易履约经验者优先。",
  },
  {
    id: "a909889e-0000-0000-0000-000000000107",
    title: "B端产品经理",
    raw_text:
      "负责到餐商家信息采集产品的规划与全链路产品设计，推进信息采集从人工到半自动；" +
      "围绕采集准确率、覆盖率组建敏捷小组，推进需求评审、方案设计、开发上线、效果验证全流程。" +
      "\n3年以上B端产品经理工作经验；能够充分利用AI提升个人效率。",
  },
  {
    id: "da0e2e35-0000-0000-0000-000000000108",
    title: "方案策划经理（北京/上海）",
    raw_text:
      "负责营销业务的全链路营销策划，制定并执行营销策略；挖掘潜在商业机会，为不同行业客户提供定制化的营销解决方案；" +
      "与销售、产品、运营等多部门协作，推动策略落地实施并输出营销洞察报告。",
  },
];

test("--rerun-aipo 第二轮：8 条产品/架构/策划职能岗回退 unknown，第二次 0 候选", async () => {
  const store = new MemoryStore(
    roundTwoFixtures.map((fixture) =>
      job({ ...fixture, role_family: "ai_product_operations", normalizer_version: "normalizer/llm-0.1" }),
    ),
  );
  const llm = fakeLlm([aipoOutput]);

  const first = await runBackfill({ apply: true, limit: null, rerunAipo: true, callLlm: llm.callLlm, store });

  assert.equal(first.candidates, 8);
  assert.equal(first.calls, 8);
  assert.equal(first.changed, 8);
  assert.equal(first.downgraded, 8);
  for (const fixture of roundTwoFixtures) {
    const row = store.jobs.find((item) => item.id === fixture.id)!;
    assert.equal(row.role_family, "unknown", `${fixture.title} 应回退 unknown`);
    assert.equal(row.normalizer_version, LLM_NORMALIZER_VERSION);
  }

  const second = await runBackfill({ apply: true, limit: null, rerunAipo: true, callLlm: llm.callLlm, store });
  assert.equal(second.candidates, 0);
  assert.equal(second.calls, 0);
  assert.equal(llm.calls(), 8);
});

test("AI Agent / AI Coding 这类带空格的 AI 标题词仍算 AI 主体（词边界在压缩空白前判断）", () => {
  const fixtures = ["AI Agent产品经理（J106491）", "AI Coding 方向开发工程师", "AI Infra 平台产品经理", "AI 产品经理（Agent 知识引擎方向）"];
  for (const title of fixtures) {
    assert.equal(firstMatchingTerm(title, AI_TITLE_TERMS), "ai", `${title} 应命中 AI 标题词`);
    assert.equal(
      downgradeNonAiOperations({ title, raw_text: "负责 AI Agent 产品的设计与落地。" }, { role_family: "ai_product_operations" })
        .downgraded,
      false,
      `${title} 标题含 AI 主体词，不应降级`,
    );
  }
  // 纯 ASCII 词仍然要求词边界，避免把 email / maintain 里的 ai 当成 AI。
  assert.equal(firstMatchingTerm("email marketing manager", AI_TITLE_TERMS), null);
  assert.equal(firstMatchingTerm("maintain the system", AI_TITLE_TERMS), null);
});

test("标题含 AI 主体词的产品/架构岗不被降级", () => {
  const fixtures = ["AI产品经理", "大模型产品经理", "AI 解决方案架构师", "AI产品经理（Agent 知识引擎方向）"];
  for (const title of fixtures) {
    assert.equal(
      downgradeNonAiOperations(
        { title, raw_text: "负责 AI 产品规划与运营，追踪大模型能力边界。" },
        { role_family: "ai_product_operations" },
      ).downgraded,
      false,
      `${title} 标题含 AI 主体词，不应降级`,
    );
  }
});

/** 生产库里两条真实误判行的原文节选：AI 主体短语只出现在任职要求行，不能据此豁免降级。 */
const financeArchitectRawText =
  "-重点客户需求洞察与经营：面向金融机构业务机构，识别云与人工智能领域的建设需求，协同销售制定重点客户技术经营策略。" +
  "\n-保险行业AI场景拓展：围绕保险营销、客户服务、合规风控等场景，挖掘可落地的AI应用机会，推动从场景验证到平台建设及规模化应用。" +
  "\n-计算机、软件工程、人工智能或相关专业本科及以上学历" +
  "\n-具备扎实的云与AI技术基础，熟悉大模型服务（MaaS）与智能体应用。" +
  "\n-优先项：主导过金融行业AI算力、云平台、大模型平台或智能体应用项目。";
const partnerFdeRawText =
  "-伙伴FDE课程全局设计：围绕伙伴FDE培训，开发需求发现、方案设计、Agent搭建、系统集成、评测上线等专业课程。" +
  "\n-业务理解与AI应用复合能力：理解FDE或技术交付的业务链路，熟悉大模型应用（RAG、Workflow、Agent）、常见模型工具及行业动态。";

const subjectPhraseFixtures = [
  {
    id: "a909889e-f429-43b4-ad27-de8a928137f4",
    title: "B端产品经理",
    raw_text:
      "1负责到餐商家信息采集产品的AI化规划和全链路产品设计，将信息采集从人工推进到L2级Agent协同阶段。" +
      "\n2.主导信息采集AI能力建设，涵盖图像识别、智能语音外呼、商家端Agent自助采集等核心AI产品功能。" +
      "\n1. 大学本科及以上学历，计算机相关专业优先。" +
      "\n2. 3年以上B端产品经理工作经验。",
    expectedRoleFamily: "ai_product_operations",
  },
  {
    id: "5caff3f3-35a6-4053-bee0-abad981f7a3d",
    title: "产品经理（联盟 C 端产品方向）",
    raw_text:
      "1. 负责联盟 C 端产品链路建设，覆盖用户从触达、浏览、交易到核销的全交易链路。" +
      "\n3. 在 AI 背景下探索联盟业务的新产品形态，如智能导购与商品推荐Agent，定义产品形态与衡量标准。" +
      "\n1. 本科及以上学历，5年以上互联网产品经验。" +
      "\n2. 对 AI 产品形态有真实的实践或深度思考。",
    expectedRoleFamily: "unknown",
  },
  {
    id: "365f9ba0-514d-45c9-b3d1-43d8fcdbb9c9",
    title: "金融解决方案架构师（J107444）",
    raw_text: financeArchitectRawText,
    expectedRoleFamily: "unknown",
  },
  {
    id: "a1f03c68-f271-482c-8734-c3cf91d382db",
    title: "AI产品运营岗",
    raw_text: "参与美团的各类运营岗位：用户运营、商家及供给运营、内容运营、工具系统运营。",
    expectedRoleFamily: "ai_product_operations",
  },
  {
    id: "7dec1e39-4bd0-4545-9a09-4672d2a3b39c",
    title: "伙伴FDE培训设计与教研专家（J107259）",
    raw_text: partnerFdeRawText,
    expectedRoleFamily: "ai_product_operations",
  },
] as const;

test("AI 主体短语豁免排除机会/形态语境，明确产品功能与 AI 标题仍保留 aipo", () => {
  for (const fixture of subjectPhraseFixtures) {
    const decision = downgradeNonAiOperations(fixture, { role_family: "ai_product_operations" });
    assert.equal(decision.role_family, fixture.expectedRoleFamily, `${fixture.title} 职族判定`);
    assert.equal(
      decision.downgraded,
      fixture.expectedRoleFamily === "unknown",
      `${fixture.title} 后置校验降级标记`,
    );
  }
});

test("职责行才构成 AI 主体豁免，只有任职要求行命中时仍降级", () => {
  const title = "金融解决方案架构师（J107444）";
  assert.equal(
    downgradeNonAiOperations(
      { title, raw_text: "负责大模型平台的产品规划与建设。" },
      { role_family: "ai_product_operations" },
    ).downgraded,
    false,
    "职责行命中 AI 主体短语应保留 aipo",
  );
  const requirementOnly = downgradeNonAiOperations(
    { title, raw_text: "熟悉大模型平台与智能体应用；优先具备大模型项目经验。" },
    { role_family: "ai_product_operations" },
  );
  assert.equal(requirementOnly.downgraded, true, "只有任职要求行命中时仍应降级");
  assert.equal(requirementOnly.role_family, "unknown");
});

test("--force-ids 定向修复已是当前版本的行，之后默认回填不再重复调用", async () => {
  const id = "365f9ba0-514d-45c9-b3d1-43d8fcdbb9c9";
  const store = new MemoryStore([
    job({
      id,
      title: "金融解决方案架构师（J107444）",
      raw_text: financeArchitectRawText,
      role_family: "ai_product_operations",
      normalizer_version: LLM_NORMALIZER_VERSION,
    }),
  ]);
  const llm = fakeLlm([aipoOutput]);

  const first = await runBackfill({
    apply: true,
    limit: null,
    rerunAipo: true,
    onlyIds: [id],
    force: true,
    callLlm: llm.callLlm,
    store,
  });
  assert.equal(first.candidates, 1);
  assert.equal(first.calls, 1);
  assert.equal(first.downgraded, 1);
  assert.equal(store.jobs[0]!.role_family, "unknown");
  assert.equal(store.updates.length, 1);

  const second = await runBackfill({ apply: true, limit: null, callLlm: llm.callLlm, store });
  assert.equal(second.candidates, 0);
  assert.equal(second.calls, 0);
  assert.equal(llm.calls(), 1);
});

test("--rerun-aipo --only-ids 只重判指定 2 行", async () => {
  const targets = subjectPhraseFixtures.filter((fixture) => fixture.expectedRoleFamily === "unknown");
  const onlyIds = targets.map((fixture) => fixture.id);
  const store = new MemoryStore(
    subjectPhraseFixtures.map((fixture) =>
      job({
        id: fixture.id,
        title: fixture.title,
        raw_text: fixture.raw_text,
        role_family: "ai_product_operations",
        normalizer_version: "normalizer/llm-0.2",
      }),
    ),
  );
  const llm = fakeLlm([aipoOutput]);

  const first = await runBackfill({
    apply: true,
    limit: null,
    rerunAipo: true,
    onlyIds,
    callLlm: llm.callLlm,
    store,
  });

  assert.equal(first.candidates, 2);
  assert.equal(first.calls, 2);
  assert.equal(first.changed, 2);
  assert.equal(first.downgraded, 2);
  assert.deepEqual(store.updates.map((update) => update.id).sort(), [...onlyIds].sort());
  for (const fixture of subjectPhraseFixtures) {
    const row = store.jobs.find((item) => item.id === fixture.id)!;
    assert.equal(row.role_family, fixture.expectedRoleFamily, `${fixture.title} 定向重跑后的职族`);
    assert.equal(
      row.normalizer_version,
      fixture.expectedRoleFamily === "unknown" ? LLM_NORMALIZER_VERSION : "normalizer/llm-0.2",
      `${fixture.title} 非目标行不应写入`,
    );
  }

  const second = await runBackfill({
    apply: true,
    limit: null,
    rerunAipo: true,
    onlyIds,
    callLlm: llm.callLlm,
    store,
  });
  assert.equal(second.candidates, 0);
  assert.equal(second.calls, 0);
  assert.equal(llm.calls(), 2);
  assert.equal(store.updates.length, 2);
});

test("a1f03c68（AI 产品运营）与 7dec1e39（伙伴FDE教研）不进入重判候选", async () => {
  const store = new MemoryStore([
    job({
      id: "a1f03c68-f271-482c-8734-c3cf91d382db",
      title: "AI产品运营岗",
      raw_text: "参与美团的各类运营岗位：用户运营、商家及供给运营、内容运营、工具系统运营。",
      role_family: "ai_product_operations",
      normalizer_version: "normalizer/llm-0.1",
    }),
    job({
      id: "7dec1e39-4bd0-4545-9a09-4672d2a3b39c",
      title: "伙伴FDE培训设计与教研专家（J107259）",
      raw_text: "围绕百度智能云伙伴FDE培训开发需求发现、方案设计、Agent搭建、评测上线等课程；熟悉大模型应用（RAG、Workflow、Agent）。",
      role_family: "ai_product_operations",
      normalizer_version: LLM_NORMALIZER_VERSION,
    }),
  ]);
  const llm = fakeLlm([aipoOutput]);

  const summary = await runBackfill({ apply: true, limit: null, rerunAipo: true, callLlm: llm.callLlm, store });

  assert.equal(summary.candidates, 0);
  assert.equal(summary.calls, 0);
  assert.equal(summary.downgraded, 0);
  assert.equal(store.jobs.every((item) => item.role_family === "ai_product_operations"), true);
});

test("真实的 AI 产品运营岗不被后置校验降级", async () => {
  const store = new MemoryStore([
    job({
      id: "a1f03c68-0000-0000-0000-000000000007",
      title: "AI产品运营岗",
      raw_text: "参与美团的各类运营岗位：用户运营、商家及供给运营、内容运营、工具系统运营。",
    }),
  ]);
  const llm = fakeLlm([aipoOutput]);

  const summary = await runBackfill({ apply: true, limit: null, callLlm: llm.callLlm, store });

  assert.equal(summary.downgraded, 0);
  assert.equal(store.jobs[0]!.role_family, "ai_product_operations");
  assert.equal(
    downgradeNonAiOperations(
      { title: "AI产品运营岗", raw_text: "参与美团的各类运营岗位。" },
      { role_family: "ai_product_operations" },
    ).downgraded,
    false,
  );
});

test("正文出现大模型/算法主体职责的传统运营标题不降级", async () => {
  const fixtures = [
    { title: "游戏运营专家", raw_text: "负责大模型产品的运营策略制定与迭代，跟进 Agent 应用落地效果。" },
    { title: "内容运营经理", raw_text: "负责推荐算法的策略运营、效果评估与迭代。" },
  ];
  for (const fixture of fixtures) {
    assert.equal(
      downgradeNonAiOperations({ ...fixture, raw_text: fixture.raw_text }, { role_family: "ai_product_operations" })
        .downgraded,
      false,
      `${fixture.title} 正文含 AI 主体职责，不应降级`,
    );
  }

  const store = new MemoryStore([
    job({ id: "77770000-0000-0000-0000-000000000001", ...fixtures[0]!, role_family: "ai_product_operations" }),
  ]);
  const llm = fakeLlm([aipoOutput]);
  const summary = await runBackfill({ apply: true, limit: null, callLlm: llm.callLlm, store });

  assert.equal(summary.downgraded, 0);
  assert.equal(store.jobs[0]!.role_family, "ai_product_operations");
});

test("--rerun-aipo 重判为 unknown 时撤销既有 aipo；默认回填仍保留既有职族", async () => {
  const row = job({
    id: "99990000-0000-0000-0000-000000000001",
    title: "美团会员-权益经营",
    raw_text: "目标跟踪与经营分析，输出经营分析报告；3年以上业务运营经验。",
    role_family: "ai_product_operations",
    normalizer_version: "normalizer/llm-0.1",
  });
  const store = new MemoryStore([row]);
  const llm = fakeLlm([{ ...aipoOutput, role_family: "unknown" }]);

  const rerun = await runBackfill({ apply: true, limit: null, rerunAipo: true, callLlm: llm.callLlm, store });

  assert.equal(rerun.candidates, 1);
  assert.equal(rerun.changed, 1);
  assert.equal(store.jobs[0]!.role_family, "unknown");

  const defaultStore = new MemoryStore([
    job({
      id: "99990000-0000-0000-0000-000000000002",
      role_family: "data",
      student_friendly: "unknown",
    }),
  ]);
  await runBackfill({ apply: true, limit: null, callLlm: llm.callLlm, store: defaultStore });
  assert.equal(defaultStore.jobs[0]!.role_family, "data");
});

test("--rerun-aipo 只选中嫌疑行，第二次为 0 变更且不再调用模型", async () => {
  const suspect = job({
    id: "88880000-0000-0000-0000-000000000001",
    title: "服务风险客服主管",
    raw_text: "负责客服团队管理；探索AI工具在客服场景的应用，推动智能客服落地。",
    role_family: "ai_product_operations",
    normalizer_version: "normalizer/llm-0.1",
  });
  const aiTitle = job({
    id: "88880000-0000-0000-0000-000000000002",
    title: "AI产品运营岗",
    role_family: "ai_product_operations",
    normalizer_version: "normalizer/llm-0.1",
  });
  const unknownRow = job({ id: "88880000-0000-0000-0000-000000000003", title: "数据分析师" });
  const store = new MemoryStore([suspect, aiTitle, unknownRow]);

  assert.equal(isRerunAipoCandidate(suspect), true);
  assert.equal(isRerunAipoCandidate(aiTitle), false);
  assert.equal(isRerunAipoCandidate(unknownRow), false);

  const llm = fakeLlm([aipoOutput]);
  const first = await runBackfill({ apply: true, limit: null, rerunAipo: true, callLlm: llm.callLlm, store });

  assert.equal(first.candidates, 1);
  assert.equal(first.changed, 1);
  assert.equal(first.downgraded, 1);
  assert.equal(store.updates.length, 1);
  assert.equal(store.updates[0]!.id, suspect.id);
  assert.equal(store.jobs.find((item) => item.id === aiTitle.id)!.role_family, "ai_product_operations");
  assert.equal(store.jobs.find((item) => item.id === unknownRow.id)!.role_family, "unknown");

  const second = await runBackfill({ apply: true, limit: null, rerunAipo: true, callLlm: llm.callLlm, store });
  assert.equal(second.candidates, 0);
  assert.equal(second.changed, 0);
  assert.equal(second.calls, 0);
  assert.equal(llm.calls(), 1);
  assert.equal(store.updates.length, 1);
});