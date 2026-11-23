// 职业洞察六段与岗位目录页的展示口径，standalone：不连数据库、不连 API。
// 路由文件是 JSX，Node 不能直接执行；可测的渲染与筛选口径都在 web/components/*.ts，由路由与这里共用。
// 这里用 react-dom/server 的 renderToStaticMarkup + cheerio 渲染 SSR HTML，断言六段顺序与关键词。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import * as cheerio from "cheerio";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import type { JobFiltersV1, JobListResponseV1, SummaryResponseV1 } from "@aihot/career-insights/contracts";
import type { CareerCatalogResponseV1, CareerSignalsResponseV1 } from "../contracts/index.ts";
import {
  ADVICE_DIRECTION_LIMIT,
  ADVICE_SKILL_LIMIT,
  BLOCK_UNAVAILABLE_TEXT,
  BRIEF_EMPTY_TEXT,
  CareerInsightsBoard,
  COLLECTOR_CITATION,
  HOT_DEFINITION,
  INSIGHT_SECTIONS,
  INSUFFICIENT_DATA_TEXT,
  SKILL_DEFINITION,
} from "../web/components/CareerInsightsBoard.ts";
import { formatRatioPercent } from "../web/feeds.ts";
import { localizeDomainTerms, ROLE_FAMILY_LABELS } from "../web/labels.ts";
import {
  CATALOG_EMPTY_TEXT,
  JobsCatalogBoard,
  MAX_SEARCH_LENGTH,
  buildCatalogHref,
  catalogCityOptions,
  filterTitles,
  sortDirections,
} from "../web/components/JobsCatalogBoard.ts";
import { buildJobsHref, parseDashboardFilters, serializeJobFilters } from "../web/filters.ts";

const AS_OF = "2026-11-20T00:00:00.000Z";

const SUMMARY: SummaryResponseV1 = {
  contract_version: "0.1",
  data_origin: "live",
  as_of: AS_OF,
  sample_size: 12,
  company_count: 3,
  source_count: 2,
  first_observed_at: "2026-11-18T00:00:00.000Z",
  last_observed_at: AS_OF,
  has_multiple_snapshots: true,
  metrics: [
    {
      metric_id: "skill_demand_share",
      version: "1.0",
      label: "技能需求占比",
      unit: "ratio",
      status: "ok",
      value: 0.8,
      numerator_count: 8,
      denominator_count: 10,
      sample_size: 10,
      as_of: AS_OF,
      dimension: {},
      unknown_count: 2,
      unknown_ratio: 0.2,
      evidence: [],
      disclaimer: "基于公开样本。",
    },
    {
      metric_id: "job_family_share",
      version: "1.0",
      label: "职族占比",
      unit: "ratio",
      status: "ok",
      value: 0.1,
      numerator_count: 1,
      denominator_count: 12,
      sample_size: 12,
      as_of: AS_OF,
      dimension: { role_family: "unknown" },
      unknown_count: 1,
      unknown_ratio: 0.083,
      evidence: [],
      disclaimer: "基于公开样本。",
    },
  ],
  shared_themes: [
    {
      theme_id: "artificial_intelligence",
      label: "人工智能",
      policy_count: 2,
      job_count: 6,
      policies: [
        {
          policy_item_id: "policy-1",
          title: "关于加快人工智能人才培养的通知",
          issuer: "示例部门",
          published_at: "2026-11-01",
          official_url: "https://www.gov.cn/example",
          source_tier: "government_official",
          theme_ids: ["artificial_intelligence"],
          evidence_excerpt: "支持高校人工智能学科建设。",
        },
      ],
      jobs: [],
    },
  ],
  dictionary_version: "0.3",
  warnings: [],
};

const CATALOG: CareerCatalogResponseV1 = {
  contract_version: "0.1",
  data_origin: "live",
  as_of: AS_OF,
  window_days: 30,
  sample_size: 12,
  unclassified_job_count: 4,
  unclassified_student_friendly_count: 1,
  unclassified_ratio: 4 / 12,
  directions: [
    {
      role_family: "ai_algorithm",
      job_count: 6,
      company_count: 2,
      new_in_window: 3,
      student_friendly_count: 4,
      top_skills: [{ skill: "python", count: 5 }, { skill: "pytorch", count: 3 }],
    },
    {
      role_family: "data",
      job_count: 2,
      company_count: 1,
      new_in_window: 1,
      student_friendly_count: 1,
      top_skills: [{ skill: "sql", count: 2 }],
    },
  ],
  titles: [
    {
      title_key: "算法工程师",
      title_display: "算法工程师",
      job_count: 4,
      company_count: 2,
      cities: ["北京", "上海"],
      top_skills: [{ skill: "python", count: 4 }],
      student_friendly_count: 2,
      latest_published_at: "2026-11-19T00:00:00.000Z",
    },
    {
      title_key: "社招算法专家",
      title_display: "算法专家（社招）",
      job_count: 1,
      company_count: 1,
      cities: ["深圳"],
      top_skills: [{ skill: "pytorch", count: 1 }],
      student_friendly_count: 0,
      latest_published_at: null,
    },
  ],
  skills: [
    { skill: "python", job_count: 8, share: 0.8 },
    { skill: "sql", job_count: 2, share: 0.2 },
  ],
};

const BRIEF = {
  contract_version: "0.1" as const,
  generated_at: "2026-11-20T01:00:00.000Z",
  as_of: AS_OF,
  sample_size: 12,
  window_days: 30,
  facts: ["AI 算法岗位 6 个，占多数。"],
  inferences: ["近 30 天新增 3 个，低置信。"],
  actions: ["先补齐 Python 与 PyTorch 基础。"],
  evidence: [{ kind: "job" as const, id: "job-1", title: "算法工程师" }],
  limitations: ["样本仅来自公开渠道。"],
  confidence: "low" as const,
};

/** 旧缓存里常见的内部 ID 文本：渲染前必须中文化，不得把这些标识直接展示给读者。 */
const RAW_BRIEF = {
  ...BRIEF,
  facts: ["职族 ai_application_development 有 6 个岗位，其中 data_analysis 提及 3 次。"],
  inferences: ["字段 role_family=data，skills 含 data_mining、data_science 与 natural_language_processing。"],
  actions: ["补齐 prompt_engineering、retrieval_augmented_generation 与 ai_agents 相关技能。"],
  limitations: ["skills 缺失的岗位按 unknown 计数。"],
};

const SIGNALS: CareerSignalsResponseV1 = {
  contract_version: "0.1",
  data_origin: "live",
  window_days: 30,
  signals: [],
  skipped: [],
  generated_at: AS_OF,
};

const SIGNALS_WITH: CareerSignalsResponseV1 = {
  ...SIGNALS,
  signals: [
    {
      rule: "cross_industry",
      company: "示例科技",
      job_id: "job-2",
      job_title: "机械设计工程师",
      evidence: { company_job_count: 6, ai_family_job_count: 5, ai_family_ratio: 0.83, matched_terms: ["机械"] },
      reason_text: "该公司 6 个岗位中 5 个为算法/AI 族，本岗位要求 机械。",
      source_key: "tencent-official-careers",
      official_url: "https://careers.example/jobs/2",
      first_seen_at: AS_OF,
      confidence: "high",
    },
    {
      rule: "surge",
      company: "示例科技",
      job_id: "job-3",
      job_title: "算法工程师",
      evidence: { last_24h_jobs: 6, history_days: 3, history_daily_average: 1.5, surge_ratio: 4 },
      reason_text: "该公司最近 24 小时新增 6 个岗位，为历史日均（1.5 个/天，3 天）的 4 倍。",
      source_key: "tencent-official-careers",
      official_url: "https://careers.example/jobs/3",
      first_seen_at: AS_OF,
      confidence: "high",
    },
  ],
  skipped: [{ rule: "surge", company: "示例科技", reason: "insufficient_history", history_days: 1.5 }],
};

/** 四条规则各一条，覆盖 new_family / skill_mismatch / surge_ratio=null 与半值舍入。 */
const SIGNALS_RULES: CareerSignalsResponseV1 = {
  ...SIGNALS,
  signals: [
    {
      rule: "cross_industry",
      company: "舍入样例公司",
      job_id: "job-4",
      job_title: "结构设计工程师",
      evidence: { company_job_count: 8, ai_family_job_count: 7, ai_family_ratio: 0.8335, matched_terms: ["结构设计"] },
      reason_text: "该公司 8 个岗位中 7 个为算法/AI 族，本岗位要求 结构设计。",
      source_key: "tencent-official-careers",
      official_url: "https://careers.example/jobs/4",
      first_seen_at: AS_OF,
      confidence: "high",
    },
    {
      rule: "new_family",
      company: "新职族公司",
      job_id: "job-5",
      job_title: "AI 应用开发工程师",
      evidence: {
        role_family: "ai_application_development",
        family_job_count: 4,
        window_days: 30,
        earliest_first_seen_at: "2026-11-19T00:00:00.000Z",
      },
      reason_text: "该公司近 30 天首次出现「AI 应用开发」职族岗位，窗口内 4 个。",
      source_key: "tencent-official-careers",
      official_url: "https://careers.example/jobs/5",
      first_seen_at: AS_OF,
      confidence: "medium",
    },
    {
      rule: "surge",
      company: "无历史公司",
      job_id: "job-6",
      job_title: "算法工程师",
      evidence: { last_24h_jobs: 5, history_days: 2, history_daily_average: 0, surge_ratio: null },
      reason_text: "该公司最近 24 小时新增 5 个岗位，历史 2 天内没有新增记录。",
      source_key: "tencent-official-careers",
      official_url: "https://careers.example/jobs/6",
      first_seen_at: AS_OF,
      confidence: "high",
    },
    {
      rule: "skill_mismatch",
      company: "错配公司",
      job_id: "job-7",
      job_title: "大模型算法工程师",
      evidence: { matched_title_terms: ["大模型", "算法"], matched_skill_terms: ["机械", "硬件"] },
      reason_text: "岗位标题「大模型算法工程师」属于算法/AI 类，但技能要求出现 机械、硬件。",
      source_key: "tencent-official-careers",
      official_url: "https://careers.example/jobs/7",
      first_seen_at: AS_OF,
      confidence: "high",
    },
  ],
  skipped: [],
};

/** 超额目录：7 个方向 / 7 个职位 / 7 个技能，用来断言摘要卡与建议区的截断上限。 */
const MANY: CareerCatalogResponseV1 = {
  ...CATALOG,
  sample_size: 30,
  directions: ["ai_algorithm", "ai_application_development", "data", "ai_product_operations", "unknown", "ai_algorithm", "ai_application_development"].map(
    (role_family, index) => ({
      role_family: role_family as CareerCatalogResponseV1["directions"][number]["role_family"],
      job_count: 10 - index,
      company_count: 2,
      new_in_window: 1,
      student_friendly_count: 1,
      top_skills: [{ skill: `skill_${index}`, count: 3 }],
    }),
  ),
  titles: Array.from({ length: 7 }, (_, index) => ({
    title_key: `title-${index + 1}`,
    title_display: `职位 ${index + 1}`,
    job_count: 7 - index,
    company_count: 1,
    cities: ["北京"],
    top_skills: [{ skill: "python", count: 2 }],
    student_friendly_count: 1,
    latest_published_at: AS_OF,
  })),
  skills: Array.from({ length: 7 }, (_, index) => ({ skill: `skill_${index}`, job_count: 9 - index, share: 0.5 })),
};

const EXPECTED_SECTIONS = [
  "career-brief",
  "career-signals",
  "career-job-trend",
  "career-skill-trend",
  "career-policy-jobs",
  "career-method",
];

const JOBS: JobListResponseV1 = {
  contract_version: "0.1",
  data_origin: "live",
  items: [
    {
      id: "job-1",
      company_name: "示例科技",
      title: "算法工程师（校招）",
      role_family: "ai_algorithm",
      locations: ["北京"],
      employment_type: "campus",
      student_friendly: "yes",
      skills: ["python"],
      published_at: "2026-11-19T00:00:00.000Z",
      first_seen_at: AS_OF,
      last_seen_at: AS_OF,
      official_url: "https://careers.example/jobs/1",
    },
  ],
  page: 1,
  page_size: 20,
  total: 1,
  as_of: AS_OF,
  filters: { page: 1, page_size: 20 },
};

const FILTERS: JobFiltersV1 = { page: 1, page_size: 20 };

function render(page: ReactElement): cheerio.CheerioAPI {
  return cheerio.load(renderToStaticMarkup(createElement(MemoryRouter, { initialEntries: ["/career-insights"] }, page)));
}

function board(
  summary: SummaryResponseV1 | null,
  catalog: CareerCatalogResponseV1 | null,
  options: { brief?: typeof BRIEF | null; signals?: CareerSignalsResponseV1 | null } = {},
): cheerio.CheerioAPI {
  const { brief = BRIEF, signals = SIGNALS } = options;
  return render(createElement(CareerInsightsBoard, { summary, catalog, signals, brief }));
}

function sectionIds(html: cheerio.CheerioAPI): Array<string | undefined> {
  return html("[data-insight-section]").map((_, element) => html(element).attr("data-insight-section")).get();
}

function unavailableSections(html: cheerio.CheerioAPI): string[] {
  return html("[data-insight-section]")
    .filter((_, element) => html(element).find("[data-section-unavailable]").length > 0)
    .map((_, element) => html(element).attr("data-insight-section"))
    .get();
}

/** 失败态只说明“本块不可用”，不得套用“观测日不足/样本过少”的样本不足归因。 */
function assertUnavailableCopy(html: cheerio.CheerioAPI): void {
  html("[data-section-unavailable]").each((_, element) => {
    const text = html(element).text();
    assert.equal(text.includes(BLOCK_UNAVAILABLE_TEXT), true);
    assert.doesNotMatch(text, /观测日不足/);
    assert.doesNotMatch(text, new RegExp(INSUFFICIENT_DATA_TEXT));
  });
}

test("the dashboard renders the six sections in contract order", () => {
  const html = board(SUMMARY, CATALOG);
  assert.deepEqual(sectionIds(html), EXPECTED_SECTIONS);
  assert.deepEqual(sectionIds(html), INSIGHT_SECTIONS.map((section) => section.id));
  // 热门岗位段已删除：完整榜单只在 /career-insights/jobs，首页另有 Top3 入口。
  for (const removed of ["career-hot-jobs", "career-student-advice"]) {
    assert.equal(html(`[data-insight-section='${removed}']`).length, 0, `removed section ${removed} must not render`);
  }
  assert.equal(html("[data-hot-direction]").length, 0);
  assert.equal(html("[data-hot-title]").length, 0);
  for (const id of EXPECTED_SECTIONS) {
    const section = html(`[data-insight-section='${id}']`);
    assert.equal(section.length, 1, `missing section ${id}`);
    assert.equal(section.attr("aria-labelledby"), id, `aria-labelledby mismatch on ${id}`);
    assert.equal(section.find("h2").attr("id"), id, `h2 id mismatch on ${id}`);
  }
  // 六段标题只从 INSIGHT_SECTIONS 取，渲染与常量必须 6/6 一致。
  assert.equal(INSIGHT_SECTIONS.length, 6);
  for (const { id, title } of INSIGHT_SECTIONS) {
    assert.equal(html(`#${id}`).text(), title, `h2 title mismatch on ${id}`);
  }
});

test("the complete brief renders facts, inferences, actions, limitations and evidence with metadata", () => {
  const html = board(SUMMARY, CATALOG);
  const brief = html("[data-insight-section='career-brief']");
  assert.equal(brief.find("[data-brief-fact]").text(), BRIEF.facts[0]);
  assert.equal(brief.find("[data-brief-inference]").text(), BRIEF.inferences[0]);
  assert.equal(brief.find("[data-brief-action]").text(), BRIEF.actions[0]);
  assert.equal(brief.find("[data-brief-limitation]").text(), BRIEF.limitations[0]);
  assert.equal(brief.find("[data-brief-evidence]").first().text(), "算法工程师");
  assert.equal(brief.find("[data-brief-confidence]").attr("data-brief-confidence"), "low");
  assert.equal(brief.find("[data-brief-sample]").attr("data-brief-sample"), "12");
  assert.equal(brief.find("[data-brief-as-of]").attr("data-brief-as-of"), AS_OF);
  assert.match(brief.text(), /数据截至/);
  assert.match(brief.text(), /样本 12 个岗位/);
  assert.equal(brief.find("[data-brief-confidence]").text(), "低置信");
  assert.match(brief.text(), /低置信/);
  // 行动建议只完整出现在研判段内，其它段不重复。
  assert.equal(html("[data-insight-section='career-brief'] [data-brief-action]").length, 1);
  assert.equal(html("[data-brief-action]").text(), BRIEF.actions[0]);
});

test("a missing offline brief shows 暂无研判 without breaking the other sections", () => {
  const html = board(SUMMARY, CATALOG, { brief: null });
  assert.match(html("[data-brief-empty]").text(), new RegExp(BRIEF_EMPTY_TEXT));
  assert.equal(html("[data-brief-confidence]").length, 0);
  assert.equal(sectionIds(html).length, 6);
});

test("unusual signals show numeric evidence and source links, with skipped notice only when non-empty", () => {
  const html = board(SUMMARY, CATALOG, { signals: SIGNALS_WITH });
  const section = html("[data-insight-section='career-signals']");
  const items = section.find("[data-signal-item]");
  assert.equal(items.length, 2);

  const crossIndustry = items.first();
  assert.equal(crossIndustry.find("[data-signal-rule]").text(), "跨界组合");
  assert.equal(crossIndustry.find("[data-signal-confidence]").text(), "高置信");
  assert.match(crossIndustry.find("[data-signal-evidence]").text(), /公司岗位 6 个 · AI 族 5 个 · 占比 83.0%/);
  assert.equal(crossIndustry.find("[data-signal-title]").parent().attr("href"), "/career-insights/jobs/job-2");
  assert.equal(crossIndustry.find("[data-signal-source]").attr("href"), "https://careers.example/jobs/2");
  assert.equal(items.last().find("[data-signal-evidence]").text().includes("24 小时新增 6 个"), true);
  assert.match(section.find("[data-signals-skipped]").text(), /历史不足 2 天/);

  const emptySkips = board(SUMMARY, CATALOG, { signals: { ...SIGNALS_WITH, skipped: [] } });
  assert.equal(emptySkips("[data-signals-skipped]").length, 0);

  const noSignals = board(SUMMARY, CATALOG, { signals: { ...SIGNALS_WITH, signals: [] } });
  assert.equal(noSignals("[data-insight-section='career-signals'] [data-signals-empty]").length, 1);
  assert.equal(noSignals("[data-signals-skipped]").length, 1);
});

test("all four signal rules render their own numeric evidence and share one percent formatter", () => {
  const html = board(SUMMARY, CATALOG, { signals: SIGNALS_RULES });
  const items = html("[data-insight-section='career-signals'] [data-signal-item]");
  assert.equal(items.length, 4);

  const ruleItem = (rule: string) => items.filter((_, element) => html(element).attr("data-signal-item") === rule).first();

  // cross_industry：0.8335 的占比必须与公共格式化函数 formatRatioPercent 的输出完全一致。
  const crossIndustry = ruleItem("cross_industry");
  assert.ok(
    crossIndustry.find("[data-signal-evidence]").text().includes(`占比 ${formatRatioPercent(0.8335)}`),
    "signal card must reuse formatRatioPercent",
  );

  // new_family：职族、窗口内数量、观察窗与最早出现时间。
  assert.equal(ruleItem("new_family").find("[data-signal-confidence]").text(), "中置信");
  const newFamily = ruleItem("new_family").find("[data-signal-evidence]").text();
  assert.match(newFamily, new RegExp(`新职族：${ROLE_FAMILY_LABELS.ai_application_development}`));
  assert.match(newFamily, /窗口内 4 个/);
  assert.match(newFamily, /观察窗 30 天/);
  assert.match(newFamily, /最早出现 2026年11月19日/);

  // skill_mismatch：标题词与技能词。
  const skillMismatch = ruleItem("skill_mismatch").find("[data-signal-evidence]").text();
  assert.match(skillMismatch, /标题词：大模型、算法/);
  assert.match(skillMismatch, /技能词：机械、硬件/);

  // surge_ratio === null：历史日均无新增记录，不写倍数。
  const surgeNull = ruleItem("surge").find("[data-signal-evidence]").text();
  assert.match(surgeNull, /24 小时新增 5 个/);
  assert.match(surgeNull, /历史日均无新增记录/);
  assert.doesNotMatch(surgeNull, /倍/);
});

test("each block degrades on its own when one API result is missing", () => {
  const noSignals = board(SUMMARY, CATALOG, { signals: null });
  assert.deepEqual(unavailableSections(noSignals), ["career-signals"]);
  assertUnavailableCopy(noSignals);

  const noBrief = board(SUMMARY, CATALOG, { brief: null });
  assert.deepEqual(unavailableSections(noBrief), []);

  const noCatalog = board(SUMMARY, null);
  assert.deepEqual(unavailableSections(noCatalog), ["career-job-trend", "career-skill-trend"]);
  // catalog 失败只降级研判段里的学生建议子块，研判本身照常展示。
  assert.equal(noCatalog("[data-student-advice] [data-advice-unavailable]").length, 1);
  assertUnavailableCopy(noCatalog);

  const noSummary = board(null, CATALOG);
  assert.deepEqual(unavailableSections(noSummary), ["career-policy-jobs", "career-method"]);
  assertUnavailableCopy(noSummary);
  assert.equal(noSummary("[data-insight-section='career-job-trend'] [data-direction-row]").length, 2);

  const allNull = board(null, null, { brief: null, signals: null });
  assert.deepEqual(sectionIds(allNull), EXPECTED_SECTIONS);
  assert.equal(allNull("[data-brief-empty]").length, 1);
  assert.equal(allNull("[data-section-unavailable]").length, 5);
  assertUnavailableCopy(allNull);
});

test("job trend lists families with window adds and keeps unknown on its own line", () => {
  const html = board(SUMMARY, CATALOG);
  const section = html("[data-insight-section='career-job-trend']");
  assert.deepEqual(
    section.find("[data-direction-row]").map((_, element) => section.find(element).attr("data-direction-row")).get(),
    ["ai_algorithm", "data"],
  );
  assert.equal(section.find("[data-direction-row='ai_algorithm'] [data-direction-jobs]").text(), "6 个岗位");
  assert.match(section.text(), /近 30 天新增 3/);
  assert.match(section.find("[data-job-trend-unknown]").text(), /未分类职位 1 个 · 占比 8.3%/);
  assert.match(section.find("[data-job-trend-unknown]").text(), /不进入方向结构/);
});

test("skill trend states the counting rule and keeps the unknown share visible", () => {
  const html = board(SUMMARY, CATALOG);
  const section = html("[data-insight-section='career-skill-trend']");
  assert.equal(section.find("[data-skill-definition]").text(), SKILL_DEFINITION);
  assert.match(section.find("[data-skill-definition]").text(), /岗位提及次数/);
  assert.match(section.find("[data-skill-definition]").text(), /不等于岗位需求概率/);
  assert.match(section.find("[data-skill-unknown]").text(), /未识别技能岗位 2 个 · 占比 20.0%/);
  assert.deepEqual(
    section.find("[data-skill-row]").map((_, element) => section.find(element).attr("data-skill-row")).get(),
    ["python", "sql"],
  );
  assert.match(section.text(), /方向内高频技能组合/);
});

test("skill trend falls back to a per-skill metric when the summary has no global skill metric", () => {
  // 有已识别技能时聚合侧只发维度指标；每条都带全局 unknown_count/unknown_ratio，页面不能显示「暂无数据」。
  const perSkillOnly: SummaryResponseV1 = {
    ...SUMMARY,
    metrics: [
      {
        metric_id: "skill_demand_share",
        version: "1.0",
        label: "技能需求占比",
        unit: "ratio",
        status: "ok",
        value: 0.8,
        numerator_count: 8,
        denominator_count: 10,
        sample_size: 10,
        as_of: AS_OF,
        dimension: { skill_id: "python" },
        unknown_count: 2,
        unknown_ratio: 0.2,
        evidence: [],
        disclaimer: "基于公开样本。",
      },
      SUMMARY.metrics[1]!,
    ],
  };
  const html = board(perSkillOnly, CATALOG);
  assert.equal(html("[data-skill-unknown]").text(), "未识别技能岗位 2 个 · 占比 20.0%");
});

test("the brief section appends student advice after actions, with directions, skills and job evidence links", () => {
  const html = board(SUMMARY, CATALOG);
  const brief = html("[data-insight-section='career-brief']");
  const advice = brief.find("[data-student-advice]");
  assert.equal(advice.length, 1);
  assert.equal(html("[data-insight-section='career-student-advice']").length, 0);

  // 子块排在「行动建议」之后、「局限」之前；行动建议本身仍完整保留。
  const headings = brief.find("h3").map((_, element) => html(element).text()).get();
  assert.ok(headings.indexOf("行动建议") < headings.indexOf("给学生的建议"));
  assert.ok(headings.indexOf("给学生的建议") < headings.indexOf("局限"));
  assert.equal(brief.find("[data-brief-action]").text(), BRIEF.actions[0]);

  assert.equal(advice.find("[data-advice-direction]").length, 2);
  const topDirection = advice.find("[data-advice-direction='ai_algorithm']");
  assert.match(topDirection.text(), /AI 算法/);
  assert.match(topDirection.text(), /学生友好 4 个岗位/);
  assert.equal(topDirection.find("a").attr("href"), "/career-insights/jobs?role_family=ai_algorithm&page=1&page_size=20");
  assert.equal(advice.find("[data-advice-skill='python']").attr("href"), "/career-insights/jobs?skill=python&page=1&page_size=20");
  assert.match(advice.find("[data-advice-skill='python']").text(), /Python/);
  assert.equal(advice.find("[data-advice-evidence] a").first().attr("href"), "/career-insights/jobs?student_friendly=yes&page=1&page_size=20");
  assert.equal(advice.find("[data-advice-evidence] a").last().attr("href"), "/career-insights/jobs");
  assert.match(advice.text(), /可投方向/);
  assert.match(advice.text(), /需补技能/);
  assert.match(advice.text(), /岗位证据/);
});

test("student advice caps its direction and skill lists at the documented limits", () => {
  const html = board(SUMMARY, MANY);
  const advice = html("[data-insight-section='career-brief'] [data-student-advice]");
  assert.equal(advice.find("[data-advice-direction]").length, ADVICE_DIRECTION_LIMIT);
  assert.equal(advice.find("[data-advice-skill]").length, ADVICE_SKILL_LIMIT);
  assert.equal(ADVICE_DIRECTION_LIMIT, 3);
  assert.equal(ADVICE_SKILL_LIMIT, 5);
});

test("internal ids in the brief and signal text render as Chinese domain terms", () => {
  const html = board(SUMMARY, CATALOG, {
    brief: RAW_BRIEF,
    signals: {
      ...SIGNALS,
      signals: [
        {
          ...SIGNALS_RULES.signals[1],
          reason_text: "该公司岗位属于 ai_application_development 职族，role_family 字段缺失。",
        },
      ],
    },
  });
  const text = html.text();
  const leaked = [
    "ai_application_development",
    "data_analysis",
    "data_mining",
    "data_science",
    "natural_language_processing",
    "prompt_engineering",
    "retrieval_augmented_generation",
    "ai_agents",
    "role_family",
  ];
  for (const id of leaked) {
    assert.doesNotMatch(text, new RegExp(id), "内部 ID " + id + " 不得出现在读者可见文本里");
  }
  assert.match(text, new RegExp(ROLE_FAMILY_LABELS.ai_application_development));
  assert.match(text, /数据分析/);
  assert.match(text, /数据挖掘/);
  assert.match(text, /数据科学/);
  assert.match(text, /自然语言处理/);
  assert.match(text, /提示词工程/);
  assert.match(text, /RAG 检索增强/);
  assert.match(text, /智能体/);
  assert.match(text, /职族=数据/);
  assert.equal(html("[data-insight-section='career-signals'] [data-signal-reason]").text().includes(ROLE_FAMILY_LABELS.ai_application_development), true);
});

test("localizeDomainTerms only replaces ids on ascii word boundaries", () => {
  assert.equal(localizeDomainTerms("职族：ai_application_development"), "职族：" + ROLE_FAMILY_LABELS.ai_application_development);
  assert.equal(localizeDomainTerms("data_analysis 与 data"), "数据分析 与 数据");
  assert.equal(localizeDomainTerms("role_family=data 的 skills/skill、share=0.5"), "职族=数据 的 技能/技能、占比=0.5");
  assert.equal(localizeDomainTerms("data_mining、natural_language_processing"), "数据挖掘、自然语言处理");
  // 长 id 优先：data 不会抢在 data_analysis 前面替换。
  assert.equal(localizeDomainTerms("data_analysis"), "数据分析");
  // 单词内部不误伤；中文紧邻仍算命中。mysql 本身是技能 ID，用 mysqld 验证「单词内部」边界。
  assert.equal(
    localizeDomainTerms("email 与 metadata、mysqld、skillset、unknown_fields 不改"),
    "email 与 metadata、mysqld、skillset、unknown_fields 不改",
  );
  assert.equal(localizeDomainTerms("mysql"), "MySQL");
  assert.equal(localizeDomainTerms("data分析 与 ai_algorithm岗位"), "数据分析 与 AI 算法岗位");
  assert.equal(localizeDomainTerms(""), "");
});

test("policy linkage is hidden when there is no shared theme", () => {
  const withoutThemes: SummaryResponseV1 = { ...SUMMARY, shared_themes: [] };
  const hidden = board(withoutThemes, CATALOG);
  assert.equal(hidden("[data-insight-section='career-policy-jobs']").length, 0);
  assert.equal(sectionIds(hidden).length, 5);
  assert.deepEqual(sectionIds(hidden), EXPECTED_SECTIONS.filter((id) => id !== "career-policy-jobs"));

  const shown = board(SUMMARY, CATALOG);
  assert.equal(shown("[data-insight-section='career-policy-jobs']").length, 1);
  assert.match(shown("[data-insight-section='career-policy-jobs']").text(), /人工智能/);
  assert.match(shown("[data-insight-section='career-policy-jobs']").text(), /不表示因果关系/);
});

test("the method section discloses sources, window, sample, unknown semantics and the citation rule", () => {
  const html = board(SUMMARY, CATALOG);
  const section = html("[data-insight-section='career-method']");
  assert.equal(section.find("[data-method-source]").text(), "2 个来源");
  assert.equal(section.find("[data-method-sample]").text(), "12 个有效岗位 · 3 家公司");
  assert.equal(section.find("[data-method-observed-days]").attr("data-method-observed-days"), "multi");
  assert.match(section.text(), /采集窗口/);
  assert.match(section.text(), /30 天/);
  assert.equal(section.find("[data-method-unknown-policy]").length, 1);
  assert.equal(section.find("[data-method-citation]").text(), COLLECTOR_CITATION);
  assert.match(section.text(), /必须随数字一起引用/);
  assert.match(section.text(), /unknown 单列/);
  assert.equal(section.find("[data-method-limitation]").first().text(), HOT_DEFINITION);
  assert.equal(html.text().split(HOT_DEFINITION).length - 1, 1);
});

test("the method section says 窗口未知 instead of inventing a window when catalog fails", () => {
  const html = board(SUMMARY, null);
  const window = html("[data-insight-section='career-method'] [data-method-window]");
  assert.equal(window.attr("data-method-window"), "unknown");
  assert.equal(window.text(), "窗口未知");
  assert.doesNotMatch(window.text(), /30 天/);

  const full = board(SUMMARY, CATALOG)("[data-insight-section='career-method'] [data-method-window]");
  assert.equal(full.attr("data-method-window"), "30");
  assert.equal(full.text(), "30 天");
});

test("an empty catalog asks to keep observing instead of inventing trends", () => {
  const empty: CareerCatalogResponseV1 = {
    ...CATALOG,
    sample_size: 0,
    unclassified_job_count: 0,
    unclassified_student_friendly_count: 0,
    unclassified_ratio: null,
    directions: [],
    titles: [],
    skills: [],
  };
  const html = board(SUMMARY, empty);
  assert.match(html("[data-job-trend-empty]").text(), new RegExp(INSUFFICIENT_DATA_TEXT));
  assert.match(html("[data-insight-section='career-brief'] [data-advice-empty]").text(), new RegExp(INSUFFICIENT_DATA_TEXT));
  assert.match(html("[data-skill-trend-empty]").text(), new RegExp(INSUFFICIENT_DATA_TEXT));
});

test("the catalog page ranks directions and links their evidence", () => {
  const html = render(createElement(JobsCatalogBoard, { catalog: CATALOG, jobs: JOBS, filters: FILTERS }));
  const directions = html("[data-catalog-direction]").map((_, element) => html(element).attr("data-catalog-direction")).get();
  assert.deepEqual(directions, ["ai_algorithm", "data"]);

  assert.equal(html("[data-direction-evidence='ai_algorithm']").attr("href"), "/career-insights/jobs?role_family=ai_algorithm&page=1&page_size=20#catalog-jobs");
  assert.equal(html("[data-catalog-job='job-1'] [data-job-evidence]").attr("href"), "https://careers.example/jobs/1");
});

test("student-friendly and city filters drive ranking and links", () => {
  const studentFilters: JobFiltersV1 = { ...FILTERS, student_friendly: "yes" };
  const studentTitles = filterTitles(CATALOG.titles, studentFilters);
  assert.deepEqual(studentTitles.map((title) => title.title_key), ["算法工程师"]);
  assert.deepEqual(sortDirections(CATALOG.directions, studentFilters).map((direction) => direction.role_family), ["ai_algorithm", "data"]);

  const studentHtml = render(createElement(JobsCatalogBoard, { catalog: CATALOG, jobs: JOBS, filters: studentFilters }));
  assert.equal(studentHtml("[data-filter-student-friendly='active']").text(), "仅学生友好");
  assert.equal(studentHtml("[data-catalog-direction='ai_algorithm'] [data-rank-count]").text(), "4 个学生友好岗位");
  assert.equal(studentHtml("[data-filter-student-friendly='idle']").attr("href"), "/career-insights/jobs?page=1&page_size=20");

  const cityFilters: JobFiltersV1 = { ...FILTERS, city: "北京" };
  // 三个城市的计数相同，C-CATALOG@1 未定义同频时的先后；localeCompare 随环境的 ICU 排序规则而变，按集合比较。
  assert.deepEqual(new Set(catalogCityOptions(CATALOG.titles)), new Set(["北京", "上海", "深圳"]));
  assert.deepEqual(filterTitles(CATALOG.titles, cityFilters).map((title) => title.title_key), ["算法工程师"]);

  const cityHtml = render(createElement(JobsCatalogBoard, { catalog: CATALOG, jobs: JOBS, filters: cityFilters }));
  assert.equal(cityHtml("[data-filter-city='active']").text(), "北京");
  assert.equal(cityHtml("[data-filter-clear]").attr("href"), "/career-insights/jobs");
  assert.equal(buildCatalogHref(FILTERS, { city: "北京", page: 1 }), "/career-insights/jobs?city=%E5%8C%97%E4%BA%AC&page=1&page_size=20");
});

test("an empty catalog page says 继续积累观测", () => {
  const empty: CareerCatalogResponseV1 = {
    ...CATALOG,
    sample_size: 0,
    unclassified_job_count: 0,
    unclassified_student_friendly_count: 0,
    unclassified_ratio: null,
    directions: [],
    titles: [],
    skills: [],
  };
  const html = render(createElement(JobsCatalogBoard, { catalog: empty, jobs: { ...JOBS, items: [], total: 0 }, filters: FILTERS }));
  assert.equal(html("[data-direction-unclassified]").length, 0, "no unclassified line without a sample");
  assert.equal(html("[data-catalog-empty]").text(), CATALOG_EMPTY_TEXT);
  assert.equal(sectionIds(html).length, 0);
});

test("the jobs catalog route is registered by the module", () => {
  const source = readFileSync(new URL("../module.ts", import.meta.url), "utf8");
  assert.match(source, /path: "career-insights\/jobs", file: "web\/routes\/jobs-catalog\.tsx"/);
});
// 岗位目录页（热门岗位）的版面顺序、方向榜口径说明、筛选链接与分页锚点。
test("the jobs catalog page puts search and filters before the direction ranking on phones", () => {
  const html = render(createElement(JobsCatalogBoard, { catalog: CATALOG, jobs: JOBS, filters: FILTERS }));
  // DOM 顺序就是手机上的顺序（搜索/筛选 → 方向榜 → 明细）；桌面用 CSS order 把方向榜放回筛选之前。
  const order = html("[id='catalog-directions'], [id='catalog-filters'], [id='catalog-jobs']")
    .map((_, element) => html(element).attr("id"))
    .get();
  assert.deepEqual(order, ["catalog-filters", "catalog-directions", "catalog-jobs"]);
});

test("the direction ranking states its classified scope and discloses the unclassified jobs", () => {
  const html = render(createElement(JobsCatalogBoard, { catalog: CATALOG, jobs: JOBS, filters: FILTERS }));
  const note = html("[data-section='direction-ranking'] [data-direction-scope]");
  assert.equal(note.length, 1);
  assert.match(note.text(), /只统计已归类的 66\.7% 岗位/, "8 of 12 jobs are classified");
  assert.match(note.text(), /未归类岗位在下方明细单列/);
  assert.match(note.text(), /仅学生友好/);
  assert.match(note.text(), /按学生友好岗位数排序/);
  assert.match(note.text(), /城市等筛选不影响本榜/);
  assert.doesNotMatch(note.text(), /全量岗位/);
  assert.doesNotMatch(note.text(), /不随下方筛选变化/);

  const disclosure = html("[data-section='direction-ranking'] [data-direction-unclassified]");
  assert.equal(disclosure.length, 1);
  assert.equal(disclosure.text(), "另有 4 个岗位未归类（33.3%），单列在岗位明细，不进入方向榜。");
  assert.equal(disclosure.prev().is("ul"), true, "the disclosure follows the ranking list");
});

test("the unclassified disclosure follows the student-friendly scope and degrades when the API omits it", () => {
  const studentFilters: JobFiltersV1 = { ...FILTERS, student_friendly: "yes" };
  const studentHtml = render(createElement(JobsCatalogBoard, { catalog: CATALOG, jobs: JOBS, filters: studentFilters }));
  const studentDisclosure = studentHtml("[data-section='direction-ranking'] [data-direction-unclassified]");
  assert.equal(studentDisclosure.length, 1);
  assert.equal(
    studentDisclosure.text(),
    "另有 1 个学生友好岗位未归类，单列在岗位明细，不进入方向榜。",
    "the one unknown student-friendly job explains 5 in the ranking vs 6 in the list",
  );

  const legacy: CareerCatalogResponseV1 = { ...CATALOG };
  delete legacy.unclassified_job_count;
  delete legacy.unclassified_student_friendly_count;
  delete legacy.unclassified_ratio;
  const legacyHtml = render(createElement(JobsCatalogBoard, { catalog: legacy, jobs: JOBS, filters: FILTERS }));
  assert.equal(legacyHtml("[data-direction-unclassified]").length, 0);
  const legacyNote = legacyHtml("[data-section='direction-ranking'] [data-direction-scope]");
  assert.match(legacyNote.text(), /只统计已归类的岗位/);
  assert.doesNotMatch(legacyNote.text(), /全量岗位/);
});

test("the filter chips link to the filtered catalog with page reset to one", () => {
  const html = render(createElement(JobsCatalogBoard, { catalog: CATALOG, jobs: JOBS, filters: FILTERS }));
  const studentYes = html("[data-filter-student-friendly='idle']").filter((_, element) => html(element).text() === "仅学生友好");
  assert.equal(studentYes.length, 1);
  assert.equal(studentYes.attr("href"), "/career-insights/jobs?student_friendly=yes&page=1&page_size=20");

  const beijing = html("[data-filter-city]").filter((_, element) => html(element).text() === "北京");
  assert.equal(beijing.length, 1);
  assert.equal(beijing.attr("href"), "/career-insights/jobs?city=%E5%8C%97%E4%BA%AC&page=1&page_size=20");
});

test("pager links keep the job list anchor while filter links do not", () => {
  // total 45 / page_size 20 → 3 页；第 1 页有下一页。
  const pagedJobs: JobListResponseV1 = { ...JOBS, total: 45 };
  const first = render(createElement(JobsCatalogBoard, { catalog: CATALOG, jobs: pagedJobs, filters: FILTERS }));
  assert.equal(first("section#catalog-jobs").length, 1, "the job list section carries the anchor id");
  assert.equal(first("[data-page='prev']").length, 0);
  assert.equal(first("[data-page='next']").attr("href"), "/career-insights/jobs?page=2&page_size=20#catalog-jobs");

  const second = render(createElement(JobsCatalogBoard, { catalog: CATALOG, jobs: { ...pagedJobs, page: 2 }, filters: { ...FILTERS, page: 2 } }));
  assert.equal(second("[data-page='prev']").attr("href"), "/career-insights/jobs?page=1&page_size=20#catalog-jobs");
  assert.equal(second("[data-page='next']").attr("href"), "/career-insights/jobs?page=3&page_size=20#catalog-jobs");

  const cityFilters: JobFiltersV1 = { ...FILTERS, city: "北京" };
  const filtered = render(createElement(JobsCatalogBoard, { catalog: CATALOG, jobs: pagedJobs, filters: cityFilters }));
  assert.equal(filtered("[data-page='next']").attr("href"), "/career-insights/jobs?city=%E5%8C%97%E4%BA%AC&page=2&page_size=20#catalog-jobs");
  // 带 city 时「清除筛选」才渲染：它重置全部筛选，不带明细锚点。
  assert.equal(filtered("[data-filter-clear]").attr("href"), "/career-insights/jobs");
  for (const element of filtered("[data-filter-student-friendly], [data-filter-city], [data-filter-clear]").toArray()) {
    assert.doesNotMatch(filtered(element).attr("href") ?? "", /#catalog-jobs/);
  }
  // 锚点只加在分页链接上，目录链接本身不变。
  assert.equal(buildCatalogHref(FILTERS, { page: 2 }), "/career-insights/jobs?page=2&page_size=20");
});

// 岗位关键词搜索（P0）：「筛选岗位」里的搜索框、标题区的当前关键词与无结果时的两个出口。
test("the keyword search box submits to the catalog path and keeps the other filters", () => {
  const filters: JobFiltersV1 = { ...FILTERS, city: "北京", q: "数据分析" };
  const html = render(createElement(JobsCatalogBoard, { catalog: CATALOG, jobs: JOBS, filters }));
  const form = html("[data-job-search]");

  assert.equal(form.length, 1);
  assert.equal(form.attr("method"), "get");
  // 提交后落在岗位明细（#catalog-jobs），手机上不用再从页首往下滚两屏。
  assert.equal(form.attr("action"), "/career-insights/jobs#catalog-jobs");
  assert.equal(form.attr("role"), "search");

  const input = form.find("[data-search-input]");
  assert.equal(input.attr("name"), "q");
  assert.equal(input.attr("value"), "数据分析");
  assert.equal(input.attr("maxlength"), String(MAX_SEARCH_LENGTH));
  assert.match(input.attr("placeholder") ?? "", /如：数据分析/);
  assert.equal(MAX_SEARCH_LENGTH, 100);

  // 其它筛选作为隐藏域保留；页码不带，换关键词后从第 1 页看起。
  assert.deepEqual(
    form.find("input[type='hidden']").toArray().map((element) => [html(element).attr("name"), html(element).attr("value")]),
    [["city", "北京"], ["page_size", "20"]],
  );
  assert.equal(form.find("input[type='hidden'][name='page']").length, 0);
});

test("the current keyword shows next to the job list and clears without dropping the other filters", () => {
  const filters: JobFiltersV1 = { ...FILTERS, city: "北京", q: "数据分析" };
  const html = render(createElement(JobsCatalogBoard, { catalog: CATALOG, jobs: JOBS, filters }));

  assert.match(html("[data-search-summary]").text(), /搜索“数据分析” · 1 个岗位/);
  assert.match(html("[data-search-current]").text(), /当前搜索“数据分析”/);
  assert.equal(html("[data-search-clear]").text(), "清除搜索");
  assert.equal(html("[data-search-clear]").attr("href"), "/career-insights/jobs?city=%E5%8C%97%E4%BA%AC&page=1&page_size=20");

  const plain = render(createElement(JobsCatalogBoard, { catalog: CATALOG, jobs: JOBS, filters: FILTERS }));
  assert.equal(plain("[data-search-summary]").length, 0);
  assert.equal(plain("[data-search-current]").length, 0);
  assert.equal(plain("[data-search-clear]").length, 0);
  assert.equal(plain("[data-search-hint]").text().includes("也可以点方向进入对应筛选"), true);
  assert.equal(plain("[data-search-input]").attr("value"), "");
});

test("an empty keyword result offers clearing the search or seeing every job", () => {
  const filters: JobFiltersV1 = { ...FILTERS, q: "不存在的岗位" };
  const html = render(createElement(JobsCatalogBoard, { catalog: CATALOG, jobs: { ...JOBS, items: [], total: 0 }, filters }));

  assert.match(html("[data-jobs-empty]").text(), /不存在的岗位/);
  assert.equal(html("[data-job-search-empty-clear]").text(), "清除搜索");
  assert.equal(html("[data-job-search-empty-clear]").attr("href"), "/career-insights/jobs?page=1&page_size=20");
  assert.equal(html("[data-job-search-empty-all]").text(), "查看全部岗位");
  assert.equal(html("[data-job-search-empty-all]").attr("href"), "/career-insights/jobs");

  // 无关键词的普通空筛选保持原空态，不出现这两个出口。
  const noKeyword = render(
    createElement(JobsCatalogBoard, { catalog: CATALOG, jobs: { ...JOBS, items: [], total: 0 }, filters: { ...FILTERS, city: "上海" } }),
  );
  assert.equal(noKeyword("[data-job-search-empty-clear]").length, 0);
  assert.equal(noKeyword("[data-job-search-empty-all]").length, 0);
});

test("the catalog URL round-trips the keyword and the dashboard job links keep it", () => {
  const filters = parseDashboardFilters(new URLSearchParams("q=%E6%95%B0%E6%8D%AE%E5%88%86%E6%9E%90&city=%E5%8C%97%E4%BA%AC&page=2&page_size=50"));
  assert.deepEqual(filters, { page: 2, page_size: 50, city: "北京", q: "数据分析" });
  assert.equal(
    serializeJobFilters(filters),
    "city=%E5%8C%97%E4%BA%AC&q=%E6%95%B0%E6%8D%AE%E5%88%86%E6%9E%90&page=2&page_size=50",
  );

  // 空白关键词等于没搜索；洞察页跳岗位页的链接同样带上 q。
  assert.deepEqual(parseDashboardFilters(new URLSearchParams("q=%20%20")), { page: 1, page_size: 20 });
  assert.equal(
    buildJobsHref({ q: "数据分析", page: 1, page_size: 20 }),
    "/career-insights?q=%E6%95%B0%E6%8D%AE%E5%88%86%E6%9E%90&page=1&page_size=20",
  );
});
