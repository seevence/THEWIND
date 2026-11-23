import type { DegreeLevel, EmploymentType, RoleFamily, StudentFriendly } from "@aihot/career-insights/contracts";

const SAFE_EXTERNAL_URL = /^https?:\/\//i;

/**
 * 只放行 http(s) 绝对地址。字段来自采集数据，`javascript:`、`data:`、协议相对 `//host`
 * 都会把不可信内容变成可点击外链，一律退化为纯文本。
 */
export function isSafeExternalUrl(value: unknown): value is string {
  return typeof value === "string" && SAFE_EXTERNAL_URL.test(value);
}

/** 与 data/dictionaries.ts 的 THEME_LABELS 同步；data 包依赖 node:crypto，不能进浏览器构建。 */
export const THEME_LABELS: Readonly<Record<string, string>> = {
  artificial_intelligence: "人工智能",
  ai_innovation: "人工智能创新",
  digital_economy: "数字经济",
  industrial_digitalization: "产业数字化",
  data_infrastructure: "数据基础设施",
  talent_development: "人才培养",
  employment_promotion: "就业促进",
};

/** 政策来源与 collector/sources.ts 中 `enabled: true` 的政策源一致，顺序即注册表顺序。 */
export const POLICY_SOURCE_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "state-council-policy", label: "中国政府网政策文件库" },
  { value: "ndrc-policy", label: "国家发展改革委政策发布" },
  { value: "moe-policy", label: "教育部公告公示" },
  { value: "mohrss-policy", label: "中国就业网（人力资源社会保障部）中央就业政策" },
  { value: "changsha-rsj-policy", label: "长沙市人力资源和社会保障局劳动就业公告" },
  { value: "hunan-jyt-policy", label: "湖南省教育厅通知公告" },
  { value: "hunan-rsj-policy", label: "湖南省人力资源和社会保障厅通知公告" },
];

const POLICY_SOURCE_LABELS: Readonly<Record<string, string>> = Object.fromEntries(
  POLICY_SOURCE_OPTIONS.map((option) => [option.value, option.label]),
);

/** 优先用全量来源表，静态清单之外的已知来源也能显示中文名；未知来源回退 source_key，不丢筛选能力。 */
export function policySourceLabel(sourceKey: string): string {
  return CAREER_SOURCE_LABELS[sourceKey] ?? POLICY_SOURCE_LABELS[sourceKey] ?? sourceKey;
}

export const POLICY_SOURCE_TIER_LABELS: Readonly<Record<string, string>> = {
  government_official: "政府官网",
  official_media: "官方媒体",
  other_public: "其他公开来源",
};

/**
 * 岗位与采集来源的中文名，与 collector/sources.ts 的 label 逐条同步。
 * web 不能直接 import collector（那是后端包，会带进 Node 依赖），所以这里维护一份前端映射；
 * 库里出现未登记的来源时回落 source_key（旧缓存、联调样例），不把空值或猜测的名字端给读者。
 */
export const CAREER_SOURCE_LABELS: Readonly<Record<string, string>> = {
  "alibaba-official-careers": "阿里巴巴官方招聘",
  "tencent-official-careers": "腾讯官方招聘",
  "meituan-official-careers": "美团官方招聘",
  "baidu-official-careers": "百度官方招聘",
  "bytedance-official-careers": "字节跳动官方招聘",
  "state-council-policy": "中国政府网政策文件库",
  "ndrc-policy": "国家发展改革委政策发布",
  "huawei-official-careers": "华为官方招聘",
  "moe-policy": "教育部公告公示",
  "mohrss-policy": "中国就业网（人力资源社会保障部）中央就业政策",
  "netease-official-careers": "网易官方招聘",
  "didi-official-careers": "滴滴官方招聘",
  "honor-official-careers": "荣耀官方招聘",
  "changsha-rsj-policy": "长沙市人力资源和社会保障局劳动就业公告",
  "hunan-jyt-policy": "湖南省教育厅通知公告",
  "cscec-official-careers": "中国建筑社会招聘",
  "iflytek-official-careers": "科大讯飞官方招聘",
  "dahua-official-careers": "大华股份官方招聘",
  "inovance-official-careers": "汇川技术官方招聘",
  "sunwoda-official-careers": "欣旺达官方招聘",
  "boe-official-careers": "京东方官方招聘",
  "sugon-official-careers": "中科曙光官方招聘",
  "h3c-official-careers": "新华三官方招聘",
  "mindray-official-careers": "迈瑞医疗官方招聘",
  "united-imaging-official-careers": "联影医疗官方招聘",
  "invt-official-careers": "英威腾官方招聘",
  "sany-official-careers": "三一重工官方招聘",
  "venustech-official-careers": "启明星辰官方招聘",
  "xinje-official-careers": "信捷电气官方招聘",
  "roborock-official-careers": "石头科技官方招聘",
  "dreame-official-careers": "追觅科技官方招聘",
  "aac-official-careers": "瑞声科技官方招聘",
  "piotech-official-careers": "拓荆科技官方招聘",
  "siasun-official-careers": "新松机器人官方招聘",
  "efort-official-careers": "埃夫特官方招聘",
  "hopewind-official-careers": "禾望电气官方招聘",
  "sofarsolar-official-careers": "首航新能源官方招聘",
  "deye-official-careers": "德业股份官方招聘",
  "chipone-official-careers": "集创北方官方招聘",
  "mornsun-official-careers": "金升阳官方招聘",
  "unitree-official-careers": "宇树科技官方招聘",
  "maxscend-official-careers": "卓胜微电子官方招聘",
  "chipsea-official-careers": "芯海科技官方招聘",
  "delixi-official-careers": "德力西官方招聘",
  "tengen-official-careers": "天正电气官方招聘",
  "goldwind-official-careers": "金风科技官方招聘",
  "wetown-official-careers": "威腾电气集团官方招聘",
  "cicc-official-careers": "中金公司官方招聘",
  "guosen-official-careers": "国信证券官方招聘",
  "iqiyi-official-careers": "爱奇艺线下业务官方招聘",
  "dptech-official-careers": "迪普科技官方招聘",
  "topsec-official-careers": "天融信官方招聘",
  "zhonghuan-official-careers": "TCL中环官方招聘",
  "edan-official-careers": "理邦仪器官方招聘",
  "jaka-official-careers": "节卡机器人官方招聘",
  "eoptolink-official-careers": "新易盛官方招聘",
  "medcaptain-official-careers": "麦科田医疗官方招聘",
  "siglent-official-careers": "鼎阳科技官方招聘",
  "mininglamp-official-careers": "明略科技官方招聘",
  "rokid-official-careers": "Rokid官方招聘",
  "unisound-official-careers": "云知声官方招聘",
  "hellobike-official-careers": "哈啰官方招聘",
  "nexchip-official-careers": "晶合集成官方招聘",
  "pylontech-official-careers": "中兴派能官方招聘",
  "dobot-official-careers": "越疆机器人官方招聘",
  "infypower-official-careers": "英飞源官方招聘",
  "joulwatt-official-careers": "杰华特官方招聘",
  "ucloud-official-careers": "UCloud官方招聘",
  "beisen-official-careers": "北森官方招聘",
  "fxiaoke-official-careers": "纷享销客官方招聘",
  "autochips-official-careers": "杰发科技官方招聘",
  "bestechnic-official-careers": "恒玄科技官方招聘",
  "biwin-official-careers": "佰维存储官方招聘",
  "cxmt-official-careers": "长鑫存储官方招聘",
  "longsys-official-careers": "江波龙官方招聘",
  "nanxin-official-careers": "南芯半导体官方招聘",
  "risen-official-careers": "东方日升官方招聘",
  "tongwei-official-careers": "通威股份官方招聘",
  "ymtc-official-careers": "长江存储官方招聘",
  "aqara-official-careers": "绿米联创官方招聘",
  "awinic-official-careers": "艾为电子官方招聘",
  "digitalchina-official-careers": "神州数码官方招聘",
  "snibe-official-careers": "新产业生物官方招聘",
  "yusys-official-careers": "宇信科技官方招聘",
  "leapmotor-official-careers": "零跑汽车官方招聘",
  "sunlord-official-careers": "南京商络电子官方招聘",
  "winline-official-careers": "永联科技官方招聘",
  "changan-official-careers": "长安汽车官方招聘",
  "chery-official-careers": "奇瑞汽车官方招聘",
  "wondershare-official-careers": "万兴科技官方招聘",
  "jmc-official-careers": "江铃汽车官方招聘",
  "fibocom-official-careers": "广和通官方招聘",
  "neoway-official-careers": "有方科技官方招聘",
  "zhihuiya-official-careers": "智慧芽官方招聘",
  "advantech-official-careers": "研华科技官方招聘",
  "liteon2-official-careers": "光宝科技官方招聘",
  "cosmx-official-careers": "珠海冠宇官方招聘",
  "apsystems-official-careers": "领储宇能官方招聘",
  "benq-official-careers": "明基BenQ官方招聘",
  "hwatsing-official-careers": "华海清科官方招聘",
  "amphenol-official-careers": "安费诺光纤官方招聘",
  "sosen-official-careers": "崧盛电子官方招聘",
  "hunan-rsj-policy": "湖南省人力资源和社会保障厅通知公告",
};

export function careerSourceLabel(sourceKey: string): string {
  return CAREER_SOURCE_LABELS[sourceKey] ?? sourceKey;
}

/**
 * 岗位详情页的外部入口文案。zhiye 平台没有稳定的单条职位详情 URL，
 * `official_url` 指向企业官方职位列表页，因此文案必须说「列表」，不能承诺打开的就是这一条职位。
 */
export const OFFICIAL_JOB_LIST_LINK_LABEL = "查看官方职位列表";

/** 与 data/dictionaries.ts 的 ROLE_FAMILY_LABELS 一致；unknown 站内统一写「未归类」。 */
export const ROLE_FAMILY_LABELS: Record<RoleFamily, string> = {
  ai_algorithm: "AI 算法",
  ai_application_development: "软件 / AI 应用开发",
  data: "数据",
  ai_product_operations: "AI 产品 / 运营",
  hardware_engineering: "硬件 / 电子 / 机械",
  manufacturing_quality: "制造 / 工艺 / 质量",
  sales_business: "销售 / 商务",
  corporate_functions: "职能（财务/人力/行政/采购）",
  unknown: "未归类",
};

export const EMPLOYMENT_TYPE_LABELS: Record<EmploymentType, string> = {
  campus: "校园招聘",
  internship: "实习",
  experienced: "社招",
  other: "其他",
  unknown: "未知",
};

export const STUDENT_FRIENDLY_LABELS: Record<StudentFriendly, string> = {
  yes: "是",
  no: "否",
  unknown: "未知",
};

/** 后端研判（CareerBriefV1）与信号（CareerSignalV1）共用的置信度等级。 */
export type ConfidenceLevel = "low" | "medium" | "high";

const CONFIDENCE_LABELS: Readonly<Record<ConfidenceLevel, string>> = {
  low: "低置信",
  medium: "中置信",
  high: "高置信",
};

/**
 * 全站统一的置信度文案：low/medium/high → 低置信/中置信/高置信。
 * 等级由后端按观测日与样本量判定，前端只翻译，不重新判定，也不改等级顺序。
 * 洞察页（研判徽标、信号卡）已改用本函数；首页 apps/web 的 HomeWorkbench.tsx 仍是本地
 * 「置信度低/中/高」常量，下一轮由首页改为引用本函数即可对齐，不要再新增一套映射。
 */
export function confidenceLabel(confidence: ConfidenceLevel): string {
  return CONFIDENCE_LABELS[confidence];
}

/** DegreeLevel 全枚举的中文名；unknown 不是「未知学历」而是源页面没写，站内统一写「未明确」。 */
export const DEGREE_LABELS: Readonly<Record<DegreeLevel, string>> = {
  any_explicit: "学历不限",
  bachelor: "本科",
  master: "硕士",
  doctor: "博士",
  other: "其他",
  unknown: "未明确",
};

/** 接口回退的旧枚举值同样按「未明确」处理，不把英文枚举端给读者。 */
export function degreeLabel(degree: string): string {
  return (DEGREE_LABELS as Readonly<Record<string, string>>)[degree] ?? DEGREE_LABELS.unknown;
}

/** 与 data/dictionaries.ts 的 SKILL_LABELS 全量同步（45 项）；web 不能直接 import 后者，因为 data 包依赖 node:crypto。 */
export const SKILL_LABELS: Readonly<Record<string, string>> = {
  python: "Python",
  sql: "SQL",
  machine_learning: "机器学习",
  deep_learning: "深度学习",
  pytorch: "PyTorch",
  tensorflow: "TensorFlow",
  large_language_models: "大语言模型",
  natural_language_processing: "自然语言处理",
  computer_vision: "计算机视觉",
  data_analysis: "数据分析",
  data_mining: "数据挖掘",
  data_engineering: "数据工程",
  data_science: "数据科学",
  data_visualization: "数据可视化",
  spark: "Spark",
  java: "Java",
  javascript: "JavaScript",
  typescript: "TypeScript",
  react: "React",
  nodejs: "Node.js",
  cpp: "C++",
  go: "Go",
  docker: "Docker",
  kubernetes: "Kubernetes",
  linux: "Linux",
  git: "Git",
  redis: "Redis",
  mysql: "MySQL",
  postgresql: "PostgreSQL",
  microservices: "微服务",
  distributed_systems: "分布式系统",
  recommendation_systems: "推荐系统",
  search_algorithms: "搜索算法",
  retrieval_augmented_generation: "RAG 检索增强",
  ai_agents: "智能体",
  prompt_engineering: "提示词工程",
  fine_tuning: "模型微调",
  product_design: "产品设计",
  user_research: "用户研究",
  ab_testing: "A/B 测试",
  operations_analysis: "运营分析",
  growth_operations: "用户增长",
  algorithms: "数据结构与算法",
  english: "英语",
  electron: "Electron",
};

export function skillLabel(skillId: string): string {
  return SKILL_LABELS[skillId] ?? skillId.replaceAll("_", " ");
}

/**
 * 内部 ID / 英文字段名 → 中文领域词。洞察页渲染研判与信号文本时统一过一遍，
 * 旧缓存里的文本可能带 ai_application_development、data_analysis、role_family 这类内部标识。
 *
 * 两条约束：
 * - 长 id 优先：data_analysis 必须先于 data 命中；
 * - 只认 ASCII 词边界：前后是 A-Za-z0-9_ 的不算命中，避免改到 metadata / email 之类单词内部，
 *   同时允许中文紧邻（「职族：ai_algorithm」也要能替换）。
 */
const DOMAIN_FIELD_LABELS: Readonly<Record<string, string>> = {
  role_family: "职族",
  skills: "技能",
  skill: "技能",
  share: "占比",
  student_friendly: "学生友好",
  job_count: "岗位数",
  company_count: "公司数",
};

function escapeRegExp(text: string): string {
  const specials = ".+*?^$()[]{}|\\";
  return [...text].map((char) => (specials.includes(char) ? "\\" + char : char)).join("");
}

const DOMAIN_TERM_REPLACEMENTS: ReadonlyArray<{ pattern: RegExp; label: string }> = (
  [
    ...Object.entries(SKILL_LABELS),
    ...Object.entries(ROLE_FAMILY_LABELS),
    ...Object.entries(DOMAIN_FIELD_LABELS),
  ] as Array<readonly [string, string]>
)
  .sort(([left], [right]) => right.length - left.length)
  .map(([id, label]) => ({
    pattern: new RegExp(`(?<![A-Za-z0-9_])${escapeRegExp(id)}(?![A-Za-z0-9_])`, "g"),
    label,
  }));

export function localizeDomainTerms(text: string): string {
  let localized = text;
  for (const { pattern, label } of DOMAIN_TERM_REPLACEMENTS) {
    localized = localized.replace(pattern, label);
  }
  return localized;
}
