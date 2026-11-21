import type { DegreeLevel, EmploymentType, RoleFamily } from "../contracts/index.ts";

export const SKILL_DICTIONARY_VERSION = "0.1" as const;
export const THEME_DICTIONARY_VERSION = "0.1" as const;

/**
 * 技能别名 → 稳定技能 ID。ID 使用小写下划线，不随展示文案变化。
 * 0.1 版只做确定性匹配，不识别模型自由生成的同义词。
 */
export const SKILL_ALIASES: Readonly<Record<string, string>> = {
  python: "python",
  py: "python",
  sql: "sql",
  "机器学习": "machine_learning",
  "machine learning": "machine_learning",
  ml: "machine_learning",
  "深度学习": "deep_learning",
  "deep learning": "deep_learning",
  pytorch: "pytorch",
  tensorflow: "tensorflow",
  "大语言模型": "large_language_models",
  大模型: "large_language_models",
  llm: "large_language_models",
  llms: "large_language_models",
  "自然语言处理": "natural_language_processing",
  nlp: "natural_language_processing",
  "计算机视觉": "computer_vision",
  cv: "computer_vision",
  "数据分析": "data_analysis",
  "数据挖掘": "data_mining",
  "数据工程": "data_engineering",
  spark: "spark",
  java: "java",
  javascript: "javascript",
  typescript: "typescript",
  react: "react",
  "node.js": "nodejs",
  nodejs: "nodejs",
  cpp: "cpp",
  "c++": "cpp",
  go: "go",
  golang: "go",
  docker: "docker",
  "容器化": "docker",
  kubernetes: "kubernetes",
  k8s: "kubernetes",
  linux: "linux",
  git: "git",
  redis: "redis",
  mysql: "mysql",
  postgresql: "postgresql",
  "微服务": "microservices",
  microservices: "microservices",
  "分布式系统": "distributed_systems",
  "distributed systems": "distributed_systems",
  "推荐系统": "recommendation_systems",
  "推荐算法": "recommendation_systems",
  "搜索算法": "search_algorithms",
  rag: "retrieval_augmented_generation",
  "检索增强": "retrieval_augmented_generation",
  agent: "ai_agents",
  "智能体": "ai_agents",
  "prompt": "prompt_engineering",
  "提示词": "prompt_engineering",
  "微调": "fine_tuning",
  "fine-tune": "fine_tuning",
  "数据可视化": "data_visualization",
  "数据科学": "data_science",
  "产品设计": "product_design",
  prd: "product_design",
  "用户研究": "user_research",
  "用户调研": "user_research",
  "a/b测试": "ab_testing",
  ab测试: "ab_testing",
  "运营分析": "operations_analysis",
  "用户增长": "growth_operations",
  "数据结构": "algorithms",
  "算法基础": "algorithms",
  英语: "english",
  english: "english",
  electron: "electron",
};

/** 展示用技能名。词典新增技能时同步补充，避免页面直接展示 ID。 */
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

export const THEME_LABELS: Readonly<Record<string, string>> = {
  artificial_intelligence: "人工智能",
  ai_innovation: "人工智能创新",
  digital_economy: "数字经济",
  industrial_digitalization: "产业数字化",
  data_infrastructure: "数据基础设施",
  talent_development: "人才培养",
  employment_promotion: "就业促进",
};

/** 主题 ID → 识别关键词。政策与职位共用同一套 theme_id。 */
export const THEME_KEYWORDS: Readonly<Record<string, readonly string[]>> = {
  artificial_intelligence: ["人工智能", "artificial intelligence", "ai", "通用人工智能", "生成式"],
  ai_innovation: ["人工智能创新", "技术创新", "ai创新", "大模型", "智能体"],
  digital_economy: ["数字经济", "数字化发展", "数字产业"],
  industrial_digitalization: ["产业数字化", "智能制造", "数智化", "产业升级", "新型工业化"],
  data_infrastructure: ["数据基础设施", "数据要素", "算力", "智算", "数据中心", "数据流通"],
  talent_development: ["人才培养", "人才政策", "职业技能", "高校人才", "招才引智"],
  employment_promotion: ["就业", "高校毕业生", "稳就业", "就业促进", "就业创业"],
};

export const ROLE_FAMILY_LABELS: Readonly<Record<RoleFamily, string>> = {
  ai_algorithm: "AI 算法",
  ai_application_development: "软件 / AI 应用开发",
  data: "数据",
  ai_product_operations: "AI 产品 / 运营",
  unknown: "未归类",
};

/** 标题关键词 → 职族。未命中一律 unknown，不猜测。 */
export const ROLE_FAMILY_KEYWORDS: Readonly<
  Record<Exclude<RoleFamily, "unknown">, readonly string[]>
> = {
  ai_algorithm: [
    "算法工程师",
    "算法专家",
    "机器学习",
    "深度学习",
    "nlp",
    "自然语言",
    "计算机视觉",
    "视觉算法",
    "推荐算法",
    "搜索算法",
    "llm",
    "ai算法",
  ],
  ai_application_development: [
    "后端",
    "后台",
    "前端",
    "全栈",
    "软件开发",
    "应用开发",
    "java开发",
    "python开发",
    "go开发",
    "ai应用",
    "ai工程",
    "服务端",
    "服务器开发",
    "客户端",
    "移动端",
    "桌面端",
    "electron",
    "测试开发",
  ],
  data: [
    "数据分析",
    "数据开发",
    "数据仓库",
    "大数据",
    "数据科学",
    "数仓",
    "数据平台",
    "bi工程师",
    "分析师",
  ],
  ai_product_operations: [
    "ai产品",
    "产品经理",
    "产品运营",
    "产品策划",
    "产品营销",
    "增长运营",
    "用户增长",
  ],
};

/** 用工类型关键词。按顺序匹配，先命中者生效。 */
export const EMPLOYMENT_TYPE_KEYWORDS: Readonly<
  Record<Exclude<EmploymentType, "unknown">, readonly string[]>
> = {
  internship: ["实习", "intern", "internship", "日常实习", "暑期实习"],
  campus: ["校园招聘", "校招", "应届生", "应届", "管培生"],
  other: ["兼职", "外包", "劳务", "合同制", "part-time", "contract"],
  experienced: ["社会招聘", "社招"],
};

export const DEGREE_KEYWORDS: ReadonlyArray<{ level: DegreeLevel; keywords: readonly string[] }> = [
  { level: "doctor", keywords: ["博士", "phd", "doctor"] },
  { level: "master", keywords: ["硕士", "研究生", "master"] },
  { level: "bachelor", keywords: ["本科", "学士", "bachelor"] },
  { level: "any_explicit", keywords: ["学历不限", "不限学历"] },
  { level: "other", keywords: ["大专", "专科", "中专", "高中"] },
];

export const CITY_ALIASES: Readonly<Record<string, string>> = {
  北京市: "北京",
  北京: "北京",
  上海市: "上海",
  上海: "上海",
  深圳市: "深圳",
  深圳: "深圳",
  广州市: "广州",
  广州: "广州",
  杭州市: "杭州",
  杭州: "杭州",
  成都市: "成都",
  成都: "成都",
  南京市: "南京",
  南京: "南京",
  武汉市: "武汉",
  武汉: "武汉",
  西安市: "西安",
  西安: "西安",
  苏州市: "苏州",
  苏州: "苏州",
  重庆市: "重庆",
  重庆: "重庆",
  天津市: "天津",
  天津: "天津",
  长沙市: "长沙",
  长沙: "长沙",
  郑州市: "郑州",
  郑州: "郑州",
  合肥市: "合肥",
  合肥: "合肥",
  厦门市: "厦门",
  厦门: "厦门",
  青岛市: "青岛",
  青岛: "青岛",
  济南市: "济南",
  济南: "济南",
  大连市: "大连",
  大连: "大连",
  珠海市: "珠海",
  珠海: "珠海",
  香港: "香港",
  远程: "远程",
  remote: "远程",
};

export const CITY_NAMES: readonly string[] = [
  "北京",
  "上海",
  "深圳",
  "广州",
  "杭州",
  "成都",
  "南京",
  "武汉",
  "西安",
  "苏州",
  "重庆",
  "天津",
  "长沙",
  "郑州",
  "合肥",
  "厦门",
  "青岛",
  "济南",
  "大连",
  "珠海",
  "香港",
  "远程",
];

/** 明确接受学生的原文短语。未出现这些证据时不得判为 yes。 */
export const STUDENT_FRIENDLY_YES_PHRASES: readonly string[] = [
  "应届可投",
  "在校生可投",
  "接受应届",
  "欢迎应届",
  "经验不限",
  "不限经验",
  "无经验要求",
  "无需经验",
  "应届毕业生",
];

export const STUDENT_FRIENDLY_NO_PHRASES: readonly string[] = [
  "不接受应届",
  "不招应届",
  "仅限社招",
  "只招社招",
  "需三年以上",
  "需 3 年以上",
];

export const EXPERIENCE_UNLIMITED_PHRASES: readonly string[] = [
  "经验不限",
  "不限经验",
  "无经验要求",
  "无需经验",
];

/** 岗位技能 → 主题。只用于政策—岗位共同方向的文本证据对照。 */
export const JOB_THEME_SKILLS: Readonly<Record<string, readonly string[]>> = {
  artificial_intelligence: [
    "machine_learning",
    "deep_learning",
    "natural_language_processing",
    "computer_vision",
    "large_language_models",
    "recommendation_systems",
  ],
  ai_innovation: ["large_language_models", "retrieval_augmented_generation", "ai_agents", "fine_tuning"],
  digital_economy: ["data_analysis", "data_engineering", "spark", "data_science"],
  industrial_digitalization: ["microservices", "docker", "kubernetes", "distributed_systems"],
  data_infrastructure: ["data_engineering", "spark", "distributed_systems", "kubernetes"],
};

export const ROLE_FAMILY_THEMES: Readonly<Partial<Record<RoleFamily, readonly string[]>>> = {
  ai_algorithm: ["artificial_intelligence"],
  ai_application_development: ["ai_innovation", "industrial_digitalization"],
  data: ["data_infrastructure", "digital_economy"],
  ai_product_operations: ["ai_innovation", "digital_economy"],
};

/** 岗位标题 → 主题。技能与职族画像产不出的人才培养、就业促进方向靠标题补齐。 */
export const JOB_THEME_TITLE_KEYWORDS: Readonly<Record<string, readonly string[]>> = {
  talent_development: ["培训", "教研", "讲师", "人才", "学习发展"],
  employment_promotion: ["校招", "应届", "实习", "管培", "高校毕业生"],
};

/** 资深类标题词。命中即不按初级岗位判学生友好。 */
export const SENIOR_TITLE_KEYWORDS: readonly string[] = ["资深", "专家", "高级", "senior", "lead"];
