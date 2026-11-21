// 职业洞察页的六段板块（IA-2）：完整研判（含给学生的建议）与异常信号在本页，完整榜单与岗位明细在 /career-insights/jobs。
// 纯展示：只读 loader 给出的契约数据，不发起请求、不做统计加工，所以 SSR 与 standalone 断言共用同一份渲染。
import { createElement as h, type ReactElement } from "react";
import { Link } from "react-router";
import type { JobFiltersV1, MetricResultV1, SummaryResponseV1 } from "@aihot/career-insights/contracts";
import type { CareerBriefV1, CareerCatalogResponseV1, CareerSignalsResponseV1 } from "../../contracts/index.ts";
import { formatRatioPercent } from "../feeds.ts";
import { JOB_PAGE_SIZES } from "../filters.ts";
import { confidenceLabel, localizeDomainTerms, ROLE_FAMILY_LABELS, skillLabel } from "../labels.ts";
import { CareerTime } from "../time.ts";
import { CareerSignalItems } from "./CareerSignals.ts";
import { CATALOG_PATH, buildCatalogHref } from "./JobsCatalogBoard.ts";

export const INSUFFICIENT_DATA_TEXT = "继续积累观测";
export const INSUFFICIENT_DATA_HINT = "观测日不足 2 天或样本过少，只展示已有观测，不给出趋势预测。";
export const BLOCK_UNAVAILABLE_TEXT = "本区块暂时不可用";
export const BRIEF_EMPTY_TEXT = "暂无研判";
export const HOT_DEFINITION = "热门指当前有效岗位数量，不表示新闻热度、公司热度或未来增长。";
export const SIGNAL_DEFINITION = "按跨界组合、新职族首现、数量突增、技能错配四条规则自动判定；每条附后端算好的数字依据与官方原文链接。";
export const SKILL_DEFINITION = "技能计数为岗位提及次数，同一岗位提及一次计一次；share 是已识别技能岗位中的提及占比，不等于岗位需求概率。";
export const COLLECTOR_CITATION = "采集路线图要求「口径披露必须随数字一起引用」：每个趋势数字都要与采集来源数、采集窗口和数据截止时间同屏出现；unknown 单列，不并入已分类子集的分母。本页数字全部直接取自聚合接口，不做二次推算，也不补造数字。";
export const ADVICE_DIRECTION_LIMIT = 3;
export const ADVICE_SKILL_LIMIT = 5;

const CARD_CLASS = "rounded-card border border-line bg-surface p-5";
const SUBTITLE_CLASS = "mt-4 text-[14px] font-semibold text-ink";
const MUTED_CLASS = "text-[12px] leading-relaxed text-ink-4 break-words";
const BODY_CLASS = "mt-2 text-[13px] leading-relaxed text-ink-3 break-words";
const CHIP_CLASS = "inline-flex h-6 items-center rounded-full border border-line-strong px-2.5 text-[11.5px] text-ink-2";
const LINK_CLASS = "font-medium text-accent hover:underline";
const ADVICE_CLASS = "mt-4 rounded-card border border-line bg-bg-sunk p-4";
const ADVICE_TITLE_CLASS = "text-[14px] font-semibold text-ink";
const ADVICE_SUBTITLE_CLASS = "mt-3 text-[13px] font-semibold text-ink";

export interface InsightSectionV1 {
  id: string;
  title: string;
}

/** 页面板块顺序即渲染顺序；政策联动的整块隐藏由数据决定，不改变其余段的相对顺序。 */
export const INSIGHT_SECTIONS = [
  { id: "career-brief", title: "AI 趋势研判" },
  { id: "career-signals", title: "不同寻常的信号" },
  { id: "career-job-trend", title: "岗位趋势" },
  { id: "career-skill-trend", title: "技能趋势" },
  { id: "career-policy-jobs", title: "政策与岗位联动" },
  { id: "career-method", title: "数据范围与方法" },
] as const satisfies readonly InsightSectionV1[];

export type InsightSectionId = (typeof INSIGHT_SECTIONS)[number]["id"];

/** 段标题只有 INSIGHT_SECTIONS 一个来源：渲染与断言同取这份常量，避免标题和 aria 标签双写走散。 */
const INSIGHT_SECTION_TITLES: Readonly<Record<InsightSectionId, string>> = Object.fromEntries(
  INSIGHT_SECTIONS.map((item) => [item.id, item.title]),
) as Record<InsightSectionId, string>;

/** 岗位页是完整榜单与明细的落点；研判段的建议只带筛选链接，不重复榜单。 */
const JOB_LINK_FILTERS: JobFiltersV1 = { page: 1, page_size: JOB_PAGE_SIZES[0] };

function jobsHref(patch: Partial<JobFiltersV1>): string {
  return buildCatalogHref(JOB_LINK_FILTERS, patch);
}

function section(id: InsightSectionId, children: ReadonlyArray<ReactElement | null>): ReactElement {
  return h(
    "section",
    { key: id, "aria-labelledby": id, "data-insight-section": id, className: CARD_CLASS },
    h("h2", { id, className: "text-[17px] font-semibold text-ink" }, INSIGHT_SECTION_TITLES[id]),
    ...children.filter((child): child is ReactElement => child !== null),
  );
}

const UNAVAILABLE_HINT = "请求失败或接口暂不可用；不影响其它区块，可稍后重试。";

/**
 * 区块级状态提示，两种状态共用一套外壳、只换文案与归因：
 * - insufficient：样本不足/继续积累观测，带“观测日不足”的归因；
 * - unavailable：API 失败/降级，只说明本块不可用，不套用样本不足的归因。
 * 失败态统一 data-section-unavailable；样本不足按区块用各自的 data 属性。
 */
function statusNote(kind: "insufficient" | "unavailable", dataAttr: string): ReactElement {
  const insufficient = kind === "insufficient";
  return h(
    "div",
    { [dataAttr]: "", role: "status", className: "mt-3 rounded-card border border-line-soft bg-bg-sunk px-4 py-4" },
    h("p", { className: "text-[14px] font-medium text-ink-2" }, insufficient ? INSUFFICIENT_DATA_TEXT : BLOCK_UNAVAILABLE_TEXT),
    h("p", { className: "mt-1 text-[12.5px] leading-relaxed text-ink-4 break-words" }, insufficient ? INSUFFICIENT_DATA_HINT : UNAVAILABLE_HINT),
  );
}

function mutedLine(text: string, dataAttr?: string): ReactElement {
  const attrs: Record<string, string> = { className: MUTED_CLASS };
  if (dataAttr !== undefined) attrs[dataAttr] = "";
  return h("p", attrs, text);
}

function bullets(items: readonly string[], dataAttr: string): ReactElement {
  return h(
    "ul",
    { className: "mt-2 space-y-1.5" },
    ...items.map((item, index) =>
      h("li", { key: `${dataAttr}:${index}`, [dataAttr]: "", className: "text-[13px] leading-relaxed text-ink-2 break-words" }, item),
    ),
  );
}

/** 研判文本可能来自旧缓存、带内部 ID（职族/技能/字段名），显示前统一中文化。 */
function localizedBullets(items: readonly string[], dataAttr: string): ReactElement {
  return bullets(items.map(localizeDomainTerms), dataAttr);
}

function skillChips(skills: readonly { skill: string; count: number }[]): ReactElement | null {
  if (skills.length === 0) return null;
  return h(
    "div",
    { className: "mt-2 flex flex-wrap gap-1.5" },
    ...skills.map((entry) =>
      h("span", { key: entry.skill, "data-skill-chip": entry.skill, className: CHIP_CLASS }, `${skillLabel(entry.skill)} ${entry.count}`),
    ),
  );
}

/**
 * 技能未识别口径优先取 summary 的全局 skill_demand_share 指标（dimension 为空）。
 * 有已识别技能时聚合侧只发按 skill_id 的维度指标，每条都带同一组全局 unknown_count/unknown_ratio，
 * 此时从维度指标取这组口径，避免把有值的未识别比例误显示成「暂无数据」。
 */
export function unknownSkillMetric(summary: SummaryResponseV1 | null): MetricResultV1 | undefined {
  if (summary === null) return undefined;
  const skillMetrics = summary.metrics.filter((metric) => metric.metric_id === "skill_demand_share");
  const global = skillMetrics.find(
    (metric) =>
      metric.dimension.skill_id === undefined &&
      metric.dimension.role_family === undefined &&
      metric.dimension.theme_id === undefined,
  );
  return global ?? skillMetrics.find((metric) => metric.unknown_count !== undefined);
}

/** 未分类职位的口径来自 job_family_share 的 unknown 维度。 */
export function unknownFamilyMetric(summary: SummaryResponseV1 | null): MetricResultV1 | undefined {
  return summary?.metrics.find((metric) => metric.metric_id === "job_family_share" && metric.dimension.role_family === "unknown");
}

function unknownMetricText(metric: MetricResultV1 | undefined, label: string): string {
  if (!metric) return `${label}暂无数据`;
  const ratio = metric.unknown_ratio !== undefined && metric.unknown_ratio !== null
    ? ` · 占比 ${formatRatioPercent(metric.unknown_ratio)}`
    : "";
  return `${label} ${metric.unknown_count ?? 0} 个${ratio}`;
}

function briefEvidence(evidence: CareerBriefV1["evidence"]): ReactElement {
  return h(
    "ul",
    { className: "mt-2 space-y-1.5" },
    ...evidence.map((item) =>
      h(
        "li",
        { key: `${item.kind}:${item.id}`, "data-brief-evidence": item.kind, className: "text-[13px] break-words" },
        item.kind === "job"
          ? h(Link, { to: `/career-insights/jobs/${encodeURIComponent(item.id)}`, className: `text-accent hover:underline` }, item.title)
          : h(Link, { to: "/career-insights/policies", className: "text-accent hover:underline" }, item.title),
      ),
    ),
  );
}

function briefEmptyNote(): ReactElement {
  return h(
    "div",
    { "data-brief-empty": "", role: "status", className: "mt-3 rounded-card border border-line-soft bg-bg-sunk px-4 py-4" },
    h("p", { className: "text-[14px] font-medium text-ink-2" }, BRIEF_EMPTY_TEXT),
    h("p", { className: "mt-1 text-[12.5px] leading-relaxed text-ink-4 break-words" }, "离线研判尚未生成或暂不可用；其它区块照常展示，读者访问不会触发模型调用。"),
  );
}

function briefMeta(brief: CareerBriefV1): ReactElement {
  return h(
    "div",
    { className: "mt-2 flex flex-wrap items-baseline gap-x-3 gap-y-1" },
    h("span", { "data-brief-confidence": brief.confidence, className: CHIP_CLASS }, confidenceLabel(brief.confidence)),
    h("span", { "data-brief-as-of": brief.as_of, className: MUTED_CLASS }, "数据截至 ", h(CareerTime, { value: brief.as_of })),
    h("span", { "data-brief-sample": String(brief.sample_size), className: MUTED_CLASS }, `样本 ${brief.sample_size} 个岗位`),
    h("span", { className: MUTED_CLASS }, `观察窗 ${brief.window_days} 天`),
    h("span", { "data-brief-generated-at": brief.generated_at, className: MUTED_CLASS }, "离线生成于 ", h(CareerTime, { value: brief.generated_at })),
  );
}

/**
 * 研判段末尾的「给学生的建议」：可投方向 Top3 / 需补技能 / 一行岗位证据跳转。
 * 全部从 catalog 的当前窗口派生，不重复研判的行动建议；数据不可用时只降级这一子块。
 */
function StudentAdviceBlock({ catalog }: { catalog: CareerCatalogResponseV1 | null }): ReactElement {
  const adviceTitle = h("h3", { className: ADVICE_TITLE_CLASS }, "给学生的建议");
  if (!catalog) {
    return h("div", { "data-student-advice": "", className: ADVICE_CLASS }, adviceTitle, statusNote("unavailable", "data-advice-unavailable"));
  }
  if (catalog.sample_size === 0 || catalog.directions.length === 0) {
    return h("div", { "data-student-advice": "", className: ADVICE_CLASS }, adviceTitle, statusNote("insufficient", "data-advice-empty"));
  }

  const directions = catalog.directions.slice(0, ADVICE_DIRECTION_LIMIT);
  const skills = catalog.skills.slice(0, ADVICE_SKILL_LIMIT);

  return h(
    "div",
    { "data-student-advice": "", className: ADVICE_CLASS },
    adviceTitle,
    mutedLine("按当前有效岗位数给出可投方向与需补技能；只用于准备方向，不构成录用保证。", "data-advice-definition"),
    h("h4", { className: ADVICE_SUBTITLE_CLASS }, "可投方向"),
    h(
      "ul",
      { className: "mt-2 space-y-2" },
      ...directions.map((direction) =>
        h(
          "li",
          { key: direction.role_family, "data-advice-direction": direction.role_family, className: "rounded-card border border-line bg-surface px-3 py-2.5" },
          h(
            "div",
            { className: "flex flex-wrap items-baseline justify-between gap-x-2" },
            h("span", { className: "text-[13px] font-medium text-ink break-words" }, ROLE_FAMILY_LABELS[direction.role_family]),
            h("span", { "data-advice-direction-friendly": String(direction.student_friendly_count), className: "num text-[12px] text-ink-3 whitespace-nowrap" }, `学生友好 ${direction.student_friendly_count} 个岗位`),
          ),
          h("p", { className: `mt-1 ${MUTED_CLASS}` }, `当前 ${direction.job_count} 个岗位 · 公司 ${direction.company_count} 家 · 近 ${catalog.window_days} 天新增 ${direction.new_in_window}`),
          h(Link, { to: jobsHref({ role_family: direction.role_family, page: 1 }), className: `mt-1 inline-flex py-2 -my-2 text-[12.5px] ${LINK_CLASS}` }, "看该方向岗位"),
        ),
      ),
    ),
    skills.length > 0 ? h("h4", { className: ADVICE_SUBTITLE_CLASS }, "需补技能") : null,
    skills.length > 0
      ? h(
          "ul",
          { className: "mt-2 flex flex-wrap gap-2" },
          ...skills.map((entry) =>
            h("li", { key: entry.skill },
              h(
                Link,
                Object.assign(
                  { to: jobsHref({ skill: entry.skill, page: 1 }), className: `inline-flex h-9 items-center rounded-full border border-line-strong px-3 text-[12px] sm:h-7 ${LINK_CLASS}` },
                  { "data-advice-skill": entry.skill },
                ),
                `${skillLabel(entry.skill)} · ${entry.job_count} 个岗位提及`,
              ),
            ),
          ),
        )
      : null,
    h("p", { "data-advice-evidence": "", className: `mt-3 ${MUTED_CLASS}` },
      "岗位证据就是岗位明细本身：",
      h(Link, { to: jobsHref({ student_friendly: "yes", page: 1 }), className: LINK_CLASS }, "仅学生友好岗位"),
      " · ",
      h(Link, { to: CATALOG_PATH, className: LINK_CLASS }, "全部岗位明细"),
      "。完整榜单与筛选在岗位页，本页不重复展示。",
    ),
  );
}

/** 第 1 段：完整研判（facts / inferences / actions / limitations / evidence）；行动建议之后接「给学生的建议」。 */
function BriefSection({ brief, catalog }: { brief: CareerBriefV1 | null; catalog: CareerCatalogResponseV1 | null }): ReactElement {
  if (!brief) return section("career-brief", [briefEmptyNote(), h(StudentAdviceBlock, { catalog })]);

  return section("career-brief", [
    briefMeta(brief),
    brief.facts.length > 0 ? h("h3", { className: SUBTITLE_CLASS }, "数据事实") : null,
    brief.facts.length > 0 ? localizedBullets(brief.facts, "data-brief-fact") : null,
    brief.inferences.length > 0 ? h("h3", { className: SUBTITLE_CLASS }, "趋势推断") : null,
    brief.inferences.length > 0 ? localizedBullets(brief.inferences, "data-brief-inference") : null,
    brief.actions.length > 0 ? h("h3", { className: SUBTITLE_CLASS }, "行动建议") : null,
    brief.actions.length > 0 ? localizedBullets(brief.actions, "data-brief-action") : null,
    h(StudentAdviceBlock, { catalog }),
    brief.limitations.length > 0 ? h("h3", { className: SUBTITLE_CLASS }, "局限") : null,
    brief.limitations.length > 0 ? localizedBullets(brief.limitations, "data-brief-limitation") : null,
    brief.evidence.length > 0 ? h("h3", { className: SUBTITLE_CLASS }, "可核查证据") : null,
    brief.evidence.length > 0 ? briefEvidence(brief.evidence) : null,
  ]);
}

/** 第 2 段：不同寻常的信号（自首页移入）。skipped 有值才提示，空数组不渲染。 */
function SignalsSection({ signals }: { signals: CareerSignalsResponseV1 | null }): ReactElement {
  if (!signals) return section("career-signals", [statusNote("unavailable", "data-section-unavailable")]);

  return section("career-signals", [
    mutedLine(SIGNAL_DEFINITION, "data-signal-definition"),
    h(
      "p",
      { "data-signals-as-of": signals.generated_at, className: `mt-1 ${MUTED_CLASS}` },
      `观察窗 ${signals.window_days} 天 · 数据截至 `,
      h(CareerTime, { value: signals.generated_at }),
    ),
    h(CareerSignalItems, { signals: signals.signals, skipped: signals.skipped }),
  ]);
}

function jobTrendRows(catalog: CareerCatalogResponseV1): ReactElement {
  return h(
    "ul",
    { className: "mt-3 divide-y divide-line-soft" },
    ...catalog.directions.map((direction) =>
      h(
        "li",
        { key: direction.role_family, "data-direction-row": direction.role_family, className: "py-3" },
        h(
          "div",
          { className: "flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1" },
          h("span", { className: "text-[14px] font-medium text-ink break-words" }, ROLE_FAMILY_LABELS[direction.role_family]),
          h(
            "span",
            { "data-direction-jobs": String(direction.job_count), className: "num text-[14px] font-semibold text-ink whitespace-nowrap" },
            `${direction.job_count} 个岗位`,
          ),
        ),
        h(
          "p",
          { className: `mt-1 ${MUTED_CLASS}` },
          `公司 ${direction.company_count} 家 · 近 ${catalog.window_days} 天新增 ${direction.new_in_window} · 学生友好 ${direction.student_friendly_count}`,
        ),
        skillChips(direction.top_skills),
      ),
    ),
  );
}

/** 第 3 段：职族结构与观察窗新增；unknown 单列，不混进方向结构。 */
function JobTrendSection({ summary, catalog }: { summary: SummaryResponseV1 | null; catalog: CareerCatalogResponseV1 | null }): ReactElement {
  if (!catalog) return section("career-job-trend", [statusNote("unavailable", "data-section-unavailable")]);
  if (catalog.directions.length === 0 || catalog.sample_size === 0) {
    return section("career-job-trend", [statusNote("insufficient", "data-job-trend-empty")]);
  }

  const unknownFamily = unknownFamilyMetric(summary);
  return section("career-job-trend", [
    h(
      "p",
      { className: BODY_CLASS },
      `按职族聚合当前有效岗位；观察窗 ${catalog.window_days} 天，样本 ${catalog.sample_size} 个岗位。`,
    ),
    mutedLine(`${unknownMetricText(unknownFamily, "未分类职位")}；未分类单列，不进入方向结构，也不并入已分类职族的分母。`, "data-job-trend-unknown"),
    jobTrendRows(catalog),
  ]);
}

/** 第 4 段：高频技能与组合，并说明计数口径（提及次数，不是需求概率）。 */
function SkillTrendSection({ summary, catalog }: { summary: SummaryResponseV1 | null; catalog: CareerCatalogResponseV1 | null }): ReactElement {
  // 高频技能与组合来自 catalog；catalog 失败时本段整体不可用，不用空数据冒充“样本不足”。
  if (!catalog) return section("career-skill-trend", [statusNote("unavailable", "data-section-unavailable")]);

  const skills = catalog.skills;
  const unknownSkill = unknownSkillMetric(summary);
  const unknownText = unknownSkill
    ? `${unknownMetricText(unknownSkill, "未识别技能岗位")}`
    : "未识别技能比例暂无数据";
  const groups = catalog.directions.filter((direction) => direction.top_skills.length > 0);

  if (skills.length === 0) {
    return section("career-skill-trend", [
      mutedLine(SKILL_DEFINITION, "data-skill-definition"),
      statusNote("insufficient", "data-skill-trend-empty"),
    ]);
  }

  return section("career-skill-trend", [
    mutedLine(SKILL_DEFINITION, "data-skill-definition"),
    h("p", { "data-skill-unknown": "", className: `mt-1 ${MUTED_CLASS}` }, unknownText),
    h("h3", { className: SUBTITLE_CLASS }, "高频技能"),
    h(
      "ul",
      { className: "mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2" },
      ...skills.map((entry) =>
        h(
          "li",
          { key: entry.skill, "data-skill-row": entry.skill, className: "rounded-card border border-line bg-bg-sunk px-3 py-2" },
          h("div", { className: "flex flex-wrap items-baseline justify-between gap-x-2" },
            h("span", { className: "text-[13px] font-medium text-ink break-words" }, skillLabel(entry.skill)),
            h("span", { className: "num text-[12px] text-ink-3 whitespace-nowrap" }, `${entry.job_count} 个岗位提及 · ${formatRatioPercent(entry.share)}`),
          ),
        ),
      ),
    ),
    groups.length > 0 ? h("h3", { className: SUBTITLE_CLASS }, "方向内高频技能组合") : null,
    groups.length > 0
      ? h("p", { className: MUTED_CLASS }, "按方向统计的高频技能清单，不是同一职位的共现统计。")
      : null,
    groups.length > 0
      ? h(
          "ul",
          { className: "mt-2 space-y-2" },
          ...groups.map((direction) =>
            h(
              "li",
              { key: direction.role_family, className: "rounded-card border border-line bg-bg-sunk px-3 py-2" },
              h("div", { className: "text-[13px] font-medium text-ink break-words" }, ROLE_FAMILY_LABELS[direction.role_family]),
              skillChips(direction.top_skills),
            ),
          ),
        )
      : null,
  ]);
}

/** 第 5 段：政策与岗位联动；没有共同主题时整段隐藏，不留空卡片。 */
function PolicyJobsSection({ summary }: { summary: SummaryResponseV1 | null }): ReactElement | null {
  if (!summary) return section("career-policy-jobs", [statusNote("unavailable", "data-section-unavailable")]);
  if (summary.shared_themes.length === 0) return null;

  return section("career-policy-jobs", [
    h("p", { className: MUTED_CLASS }, "只表示政策方向与招聘需求的呼应，不表示因果关系。"),
    h(
      "ul",
      { className: "mt-3 space-y-3" },
      ...summary.shared_themes.map((theme) =>
        h(
          "li",
          { key: theme.theme_id, "data-shared-theme": theme.theme_id, className: "rounded-card border border-line bg-bg-sunk p-4" },
          h(
            "div",
            { className: "flex flex-wrap items-baseline gap-x-3 gap-y-1" },
            h("h3", { className: "text-[15px] font-semibold text-ink break-words" }, theme.label),
            h("span", { className: MUTED_CLASS }, `政策 ${theme.policy_count} 条`),
            h("span", { className: MUTED_CLASS }, `岗位 ${theme.job_count} 个`),
          ),
          theme.policies.length > 0
            ? h(
                "ul",
                { className: "mt-2 space-y-1.5" },
                ...theme.policies.map((policy) =>
                  h(
                    "li",
                    { key: policy.policy_item_id, className: "text-[13px] break-words" },
                    h(
                      "a",
                      { href: policy.official_url, target: "_blank", rel: "noopener noreferrer", className: "text-accent hover:underline" },
                      policy.title,
                    ),
                  ),
                ),
              )
            : null,
        ),
      ),
    ),
  ]);
}

/** 第 6 段：数据范围与方法。口径按采集路线图「必须随数字一起引用」披露，不在这里编数字。 */
function MethodSection({ summary, catalog }: {
  summary: SummaryResponseV1 | null;
  catalog: CareerCatalogResponseV1 | null;
}): ReactElement {
  if (!summary) return section("career-method", [statusNote("unavailable", "data-section-unavailable")]);

  const unknownFamily = unknownFamilyMetric(summary);
  const unknownSkill = unknownSkillMetric(summary);
  const unknownLines = [
    unknownFamily ? unknownMetricText(unknownFamily, "未分类职位") : undefined,
    unknownSkill ? unknownMetricText(unknownSkill, "未识别技能岗位") : undefined,
    ...summary.warnings.filter((warning) => warning.code === "unknown_fields").map((warning) => warning.message),
  ].filter((line): line is string => line !== undefined);

  return section("career-method", [
    h(
      "dl",
      { className: "mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2" },
      h("div", null, h("dt", { className: MUTED_CLASS }, "采集来源"), h("dd", { "data-method-source": String(summary.source_count), className: "text-[13px] text-ink-2" }, `${summary.source_count} 个来源`)),
      h("div", null, h("dt", { className: MUTED_CLASS }, "样本量"), h("dd", { "data-method-sample": String(catalog?.sample_size ?? summary.sample_size), className: "text-[13px] text-ink-2" }, `${catalog?.sample_size ?? summary.sample_size} 个有效岗位 · ${summary.company_count} 家公司`)),
      h("div", null, h("dt", { className: MUTED_CLASS }, "数据截止"), h("dd", { className: "text-[13px] text-ink-2" }, h(CareerTime, { value: summary.as_of }))),
      h("div", null, h("dt", { className: MUTED_CLASS }, "采集窗口"), h("dd", { "data-method-window": catalog ? String(catalog.window_days) : "unknown", className: "text-[13px] text-ink-2" }, catalog ? `${catalog.window_days} 天` : "窗口未知")),
      h("div", null, h("dt", { className: MUTED_CLASS }, "观测日"), h("dd", { "data-method-observed-days": summary.has_multiple_snapshots ? "multi" : "single", className: "text-[13px] text-ink-2" }, summary.has_multiple_snapshots ? "≥2 个观测日" : "仅 1 个快照")),
      h("div", null, h("dt", { className: MUTED_CLASS }, "词典版本"), h("dd", { className: "text-[13px] text-ink-2" }, `v${summary.dictionary_version}`)),
    ),
    h("h3", { className: SUBTITLE_CLASS }, "unknown 口径"),
    h("p", { "data-method-unknown-policy": "", className: MUTED_CLASS }, "未分类职位与未识别技能单列展示，不并入已分类子集的分母，也不代表这些岗位与 AI 无关。"),
    unknownLines.length > 0 ? bullets(unknownLines, "data-method-unknown") : null,
    h("h3", { className: SUBTITLE_CLASS }, "引用口径"),
    h("p", { "data-method-citation": "", className: MUTED_CLASS }, COLLECTOR_CITATION),
    h("h3", { className: SUBTITLE_CLASS }, "说明"),
    bullets(
      [
        HOT_DEFINITION,
        "热点会随采集窗口和来源变化；页面只代表当前窗口的公开样本，不代表完整就业市场。",
        "采集层只保留官方原文与来源链接；本页不展示完整榜单与岗位明细，完整榜单在「热门岗位」页。",
      ],
      "data-method-limitation",
    ),
  ]);
}

export function CareerInsightsBoard({ summary, catalog, signals, brief }: {
  summary: SummaryResponseV1 | null;
  catalog: CareerCatalogResponseV1 | null;
  signals: CareerSignalsResponseV1 | null;
  brief: CareerBriefV1 | null;
}): ReactElement {
  const fixture = summary?.data_origin === "synthetic_fixture" || catalog?.data_origin === "synthetic_fixture";
  const singleSnapshot = summary !== null && summary.sample_size > 0 && !summary.has_multiple_snapshots;

  return h(
    "div",
    { className: "space-y-6 pb-10 pt-3" },
    h(
      "header",
      null,
      h("h1", { "data-page-title": "", className: "text-[24px] font-semibold text-ink" }, "职业洞察"),
      h("p", { className: "mt-1 text-[13px] leading-relaxed text-ink-3" }, "完整研判、异常信号、岗位与技能变化、政策联动与数据口径；完整榜单与岗位明细在「热门岗位」页。"),
    ),
    fixture
      ? h("div", { role: "note", className: "rounded-card border border-amber-300 bg-amber-50 px-4 py-3 text-[13px] font-medium text-amber-900 break-words" }, "联调样例（非真实数据）")
      : null,
    singleSnapshot
      ? h("div", { role: "note", className: "rounded-card border border-line bg-bg-sunk px-4 py-3 text-[13px] leading-relaxed text-ink-3 break-words" }, "当前仅有单快照，新增岗位与变化趋势数据不足，不作趋势推断。")
      : null,
    h(BriefSection, { brief, catalog }),
    h(SignalsSection, { signals }),
    h(JobTrendSection, { summary, catalog }),
    h(SkillTrendSection, { summary, catalog }),
    h(PolicyJobsSection, { summary }),
    h(MethodSection, { summary, catalog }),
  );
}
