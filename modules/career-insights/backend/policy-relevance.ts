import { sql } from "@aihot/backend/db";

/**
 * 政策相关性判定：确定性关键词规则，不调用模型。
 *
 * 口径（2026-11-21 与用户确认，放宽版）：四类政策算相关——①就业相关政策（就业、招聘、毕业生、
 * 高校、人才、职业技能、劳动、社保、灵活就业、创业、人力资源、用工、岗位、薪酬、职业教育、
 * 专技、职称等）；②支持、指导行业发展的政策（产业/行业规划、指导意见、支持、促进、培育、
 * 转型、升级、数字化、智能制造、人工智能、绿色、消费、服务业、制造业、中小企业、民营经济、
 * 区域发展、产业链、供应链、新型储能、中医药、文化旅游等）；③国家战略/行动方案类（战略、
 * 规划、行动方案、实施方案、指导意见等标题，因为能收录进政策文件库的基本都涉及经济/产业/
 * 资源/消费/科技发展）；④守信激励/信用体系/营商环境/涉企清单类。
 *
 * 只有与经济社会发展和就业无关的政务活动才排除：人事任免、选举、外事会晤、军事国防、
 * 纪念庆典、表彰、天气、机构挂牌、党内学习教育等。名单按顺序匹配，第一个命中的词进判定结果，
 * 便于采集拒绝和页面口径给出同一句解释。
 *
 * 标题是唯一判定文本：库里的 theme_ids 由「标题+正文」关键词生成，正文偶发提到「就业」也会
 * 命中（生产库里选举通知就带着 employment_promotion 主题），因此主题不能反过来证明政策相关。
 * 列表、分面、日报计数、研判/评论的模型输入都按同一份标题规则（careerPolicyRelevanceSql）过滤，
 * 页面与统计因此不会自相矛盾。没有命中白名单的一律不相关，避免通用政府文件库的噪声进政策页。
 */

/** 就业/人才/教育/职业/劳动/社保 + 产业发展与支持指导类关键词。 */
export const CAREER_POLICY_KEYWORDS: readonly string[] = [
  // 就业、人才、教育、职业、劳动、社保
  "就业",
  "招聘",
  "招录",
  "招考",
  "毕业生",
  "高校",
  "人才",
  "职业技能",
  "职业培训",
  "职业教育",
  "职业资格",
  "劳动",
  "社保",
  "社会保险",
  "灵活就业",
  "创业",
  "人力资源",
  "用工",
  "岗位",
  "薪酬",
  "工资",
  "专技",
  "职称",
  "实习",
  "见习",
  "劳务",
  "稳岗",
  "扩岗",
  "求职",
  "学生",
  "教育",
  "教师",
  "技能",
  "培训",
  // 产业发展与支持指导
  "产业",
  "行业",
  "发展规划",
  "规划",
  "指导意见",
  "支持",
  "促进",
  "培育",
  "转型",
  "升级",
  "数字化",
  "智能制造",
  "人工智能",
  "绿色",
  "低碳",
  "消费",
  "服务业",
  "制造业",
  "中小企业",
  "民营经济",
  "区域发展",
  "守信激励",
  "信用",
  "营商环境",
  "涉企",
  "清单",
  "产业链",
  "供应链",
  "新型储能",
  "储能",
  "中医药",
  "文化旅游",
  "数字经济",
  "科技创新",
  "科技",
  "创新",
  "企业",
  "能源",
  "新能源",
  "汽车",
  "生物医药",
  "医药",
  "养老",
  "托育",
  "物流",
  "平台经济",
  "个体工商户",
  "乡村振兴",
  "高质量发展",
  "新质生产力",
  "营商环境",
  "招商引资",
  // 国家战略/行动方案类放在最后：同样的标题先命中更具体的产业/就业词，拒绝或展示时的解释更准确。
  "战略",
  "行动方案",
  "实施方案",
];

/** 与经济社会发展和就业无关的政务主题；命中即不相关。 */
export const CAREER_POLICY_EXCLUSION_KEYWORDS: readonly string[] = [
  // 人事任免与选举
  "选举",
  "任免",
  "任命",
  "免职",
  "干部",
  "换届",
  // 外事与军事国防
  "外事",
  "外交",
  "会见",
  "会晤",
  "会谈",
  "出访",
  "来访",
  "外宾",
  "贺电",
  "贺信",
  "军事",
  "国防",
  "阅兵",
  "军演",
  // 纪念庆典与表彰
  "纪念",
  "庆典",
  "庆祝",
  "周年",
  "表彰",
  "烈士",
  "悼念",
  // 天气与机构挂牌
  "天气",
  "挂牌",
  "揭牌",
  // 党内学习教育等非就业主题
  "党史",
  "党建",
  "党的建设",
  "主题教育",
];

export type PolicyRelevanceReason = "career_keyword" | "excluded_topic" | "no_career_keyword";

export interface PolicyRelevanceVerdict {
  relevant: boolean;
  reason: PolicyRelevanceReason;
  /** 命中的关键词（黑名单或白名单），未命中为 null。 */
  matched: string | null;
}

/** 按词表顺序取第一个命中的关键词：先黑名单后白名单时，结果与 SQL 条件一致。 */
function firstKeyword(text: string, keywords: readonly string[]): string | null {
  for (const keyword of keywords) {
    if (text.includes(keyword)) return keyword;
  }
  return null;
}

/**
 * 判定一条政策标题是否与就业或产业发展相关。规则完全确定性：
 * 先命中黑名单即不相关；否则命中白名单即相关；两者都未命中默认不相关。
 */
export function assessPolicyRelevance(title: string): PolicyRelevanceVerdict {
  const excluded = firstKeyword(title, CAREER_POLICY_EXCLUSION_KEYWORDS);
  if (excluded !== null) return { relevant: false, reason: "excluded_topic", matched: excluded };
  const matched = firstKeyword(title, CAREER_POLICY_KEYWORDS);
  if (matched === null) return { relevant: false, reason: "no_career_keyword", matched: null };
  return { relevant: true, reason: "career_keyword", matched };
}

export function isCareerRelevantPolicy(title: string): boolean {
  return assessPolicyRelevance(title).relevant;
}

function sqlAlternation(keywords: readonly string[]): string {
  return keywords.map((keyword) => keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
}

/**
 * 读侧过滤条件，与 isCareerRelevantPolicy 共用同一份词表：白名单不区分大小写地命中，且不命中黑名单。
 * 用正则而不是逐词 ILIKE，是因为词表有几十项而政策表很小（万行以内），单次全表扫描即可；两个参数
 * 都由上面的常量拼出，没有外部输入。
 */
export function careerPolicyRelevanceSql() {
  return sql`title ~* ${sqlAlternation(CAREER_POLICY_KEYWORDS)} AND title !~* ${sqlAlternation(CAREER_POLICY_EXCLUSION_KEYWORDS)}`;
}
