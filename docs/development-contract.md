# AI+ 就业趋势平台开发契约

> 文档状态：DRAFT v0.1  
> 适用项目：AIHOT `career-insights` 模块  
> 适用阶段：D1–D3 快速实现，D4–D5 调优  
> 集成负责人：A  
> 数据口径负责人：C  
> API 负责人：D  
> 采集负责人：B  
> 前端负责人：E  
> 原则：**先统一契约，再并行开发；先真实证据，再趋势表达**

## 1. 目的与范围

本契约用于让五名开发者并行实现同一条真实数据链：

`官方招聘页/政策页 → 采集 → 归一化 → 去重与观测 → 指标 → API → 学生端证据`

本契约的机器可读实现为 C-SHARED@1 与 C-API@1：

- `modules/career-insights/contracts/job.ts`：职位、指标规范、政策证据类型，以及 `CAREER_CONTRACT_VERSION=0.1`、`CAREER_SCHEMA_VERSION=1.0`。
- `modules/career-insights/contracts/api.ts`：GET 响应、观测批次、写入结果和错误结构。
- `modules/career-insights/contracts/index.ts`：`@aihot/career-insights/contracts` 统一导出入口。
- `modules/career-insights/contracts/openapi.json`：三个只读 GET 的 OpenAPI 3.1 描述；准备阶段不包含公开 POST ingest。

这些文件与本文件表达同一契约，导入类型不得触发采集、数据库或模型调用。五人分支、所有权和变更流程见 `docs/team-startup.md`。

本契约约束：

- 招聘职位的共享数据结构
- 职位当前态与历史观测的写入语义
- 指标计算与缺值处理
- 政策证据引用方式
- 对外读取 API 与内部采集写入 API
- 版本、变更、测试和验收规则

本契约不包含：

- 完整爬虫管理系统
- 简历解析、岗位匹配、录用概率预测
- 长期行业预测或因果推断
- 用户账号和个性化推荐
- 通用低代码采集平台
- 模型密钥、管理员密码或任何真实密钥

## 2. 角色与边界

| 角色 | 生产内容 | 不允许跨越的边界 |
|---|---|---|
| B：数据源开发 | 原始页面、原始字段、来源元数据、采集错误 | 不决定指标口径，不编造缺失字段 |
| C：数据治理与指标 | `NormalizedJobV1`、去重键、技能归一化、指标口径 | 不私自新增来源，不把未知值解释为确定事实 |
| D：后端与 API | 数据表、幂等写入、观测、查询、API、错误响应 | 不擅自改变 C 的指标定义 |
| E：前端 | 看板、筛选、证据展示、空态和错误态 | 不直接访问数据库，不重复计算后端指标 |
| A：技术负责人/集成 | 契约评审、版本、模块注册、合并和发布 | 不在未通知 C/D/E 时改变共享接口 |

B 的原始输出不直接进入页面。只有经过 C 校验和归一化的 `NormalizedJobV1`，才能进入 D 的正式职位表和指标计算。

## 3. 全局语义

### 3.1 时间与空值

- 所有系统时间使用 ISO 8601 UTC，例如 `2026-11-16T12:00:00Z`。
- 官方发布时间 `published_at` 只能来自原始页面。
- 官方只提供日期时保留日期精度，不擅自补时分秒。
- `fetched_at` 是采集时间，不得冒充 `published_at`。
- `null` 表示未知、未提供或无法可靠判断。
- `0` 只能表示有明确证据的零，不能用 `0` 代替未知。
- 空数组 `[]` 表示当前没有可确认项，不等于“没有要求”。

### 3.2 有效职位

用于指标计算的“有效职位”必须同时满足：

- 有 `source_key`
- 有稳定的 `job_key`
- 有 `company_name`
- 有非空 `title`
- 有可访问的 `official_url`
- 至少一次成功采集观测
- 按本契约去重

`role_family`、`skills`、`degree`、`experience` 可以未知，但不能因此编造或删除整条职位。

### 3.3 首次发现、最近发现与下架

- `first_seen_at`：本平台第一次成功采集到该职位的时间。
- `last_seen_at`：最近一次成功采集到该职位的时间。
- 首次发现不等于市场新增。
- 单次未抓到不等于下架，更不能推断停止招聘。
- 当前表保存“最近一次成功观测的状态”，不保证访问页面时职位仍在线。

### 3.4 证据优先级

1. 公司或政府官方原文。
2. 官方公开接口或官方附件。
3. 经人工核验的官方页面快照，必须标记“导入”。
4. 其他来源只能作线索，不作为 MVP 的核心趋势证据。

## 4. `NormalizedJobV1` 职位对象

### 4.1 类型定义

    export type RoleFamily =
      | "ai_algorithm"
      | "ai_application_development"
      | "data"
      | "ai_product_operations"
      | "unknown";

    export type EmploymentType =
      | "campus"
      | "internship"
      | "experienced"
      | "other"
      | "unknown";

    export type DegreeLevel =
      | "any_explicit"
      | "bachelor"
      | "master"
      | "doctor"
      | "other"
      | "unknown";

    export type StudentFriendly = "yes" | "no" | "unknown";

    export interface NormalizedJobV1 {
      schema_version: "1.0";
      source_key: string;
      job_key: string;
      company_name: string;
      title: string;
      official_url: string;

      role_family: RoleFamily;
      locations: string[];
      degree: DegreeLevel;
      degree_raw: string | null;

      experience_min_years: number | null;
      experience_max_years: number | null;
      experience_raw: string | null;
      employment_type: EmploymentType;
      student_friendly: StudentFriendly;

      skills: string[];
      skill_evidence: Array<{
        skill_id: string;
        evidence_text: string;
      }>;

      published_at: string | null;
      fetched_at: string;
      collector_version: string;
      content_hash: string;
      raw_text: string;
      raw_payload?: Record<string, unknown>;
    }

### 4.2 字段规则

| 字段 | 规则 |
|---|---|
| `schema_version` | 当前固定为 `1.0`；契约草案阶段 API 外层仍标记 `contract_version=0.1` |
| `source_key` | 稳定小写来源标识，不使用公司展示名 |
| `job_key` | 优先官方职位 ID；没有时使用规范化 URL 的 SHA-256 |
| `company_name` | 官方或团队确认的公司名称 |
| `title` | 保留官方标题，不改写成营销文案 |
| `official_url` | 具体职位详情页，不能只用招聘首页 |
| `role_family` | 只能使用约定枚举；无法判断时为 `unknown` |
| `locations` | 使用归一化地点；未知为 `[]`，远程岗位按词典标注 |
| `degree` | `any_explicit` 仅用于官方明确写“学历不限” |
| `degree_raw` | 保存学历原文，便于复核 |
| `experience_min_years` | 未知为 `null`；明确 0 年才允许为 `0` |
| `experience_max_years` | 有下限无上限时为 `null`；上下限都未知时两者均为 `null` |
| `experience_raw` | 保存经验要求原文 |
| `employment_type` | 校招、实习、社招等，无法判断为 `unknown` |
| `student_friendly` | 只能按明确规则判断，不由模型自由猜测 |
| `skills` | 只存归一化技能 ID，不存自由文本 |
| `skill_evidence` | 保存技能原文证据，便于审查误判 |
| `published_at` | 官方发布时间；未知为 `null` |
| `fetched_at` | 本次成功抓取时间，UTC |
| `collector_version` | 采集器版本或 Git 提交号 |
| `content_hash` | C 计算的规范化内容哈希 |
| `raw_text` | 用于复核的原始正文，不直接公开 |
| `raw_payload` | 可选原始 JSON；不得包含 Cookie、Token、账号或个人敏感信息 |

### 4.3 `student_friendly` 判定

`yes` 必须满足至少一项明确证据：

- `employment_type` 为 `campus` 或 `internship`
- 官方明确写“应届可投”“在校生可投”“经验不限”
- 官方明确经验要求为 0–1 年，且没有相反限制

`no` 用于：

- 官方明确不接受应届或实习生
- 明确要求 2 年及以上相关工作经验
- 明确为资深/专家岗位且没有学生入口

其他情况一律为 `unknown`。学历未写、经验未写、岗位名称看起来初级，都不能单独判为 `yes`。

### 4.4 去重键

唯一身份：

`(source_key, job_key)`

`job_key` 生成顺序：

1. 官方职位 ID。
2. 官方规范化 URL 的 SHA-256。

URL 规范化只移除明确的跟踪参数和片段，不删除影响职位身份的参数。不得仅凭相同职位标题去重，因为不同城市、批次和职位 ID 可能同名。

### 4.5 内容哈希

`content_hash` 由 C 对规范化字段和正文按稳定顺序计算 SHA-256。

包含：

- 职位身份、标题、公司、地点
- 学历、经验、雇佣类型
- 归一化技能
- 职位正文

不包含：

- `fetched_at`
- 页面浏览量、排名等易变展示数据
- Cookie、请求 ID、广告和推荐职位

哈希相同表示内容未变；哈希变化表示需要保存新的当前态和观测记录。

## 5. 数据库与观测契约

### 5.1 `career_jobs`：职位当前态

每个 `(source_key, job_key)` 只有一条记录。

核心字段：

| 字段 | 含义 |
|---|---|
| `id` | 内部职位 ID，API 使用 |
| `source_key` / `job_key` | 联合唯一身份 |
| 当前规范化字段 | 最近一次成功采集的职位状态 |
| `first_seen_at` | 第一次成功观测时间，写入后不改 |
| `last_seen_at` | 最近一次成功观测时间 |
| `content_hash` | 最近一次成功观测的内容哈希 |
| `created_at` / `updated_at` | 数据库记录时间 |

更新规则：

- 首次成功采集：插入职位并写一条观测。
- 再次成功采集且哈希相同：更新 `last_seen_at`，追加观测，不重复职位。
- 再次成功采集且哈希不同：更新当前字段和 `last_seen_at`，追加观测。
- 失败、超时、403、解析失败：只记失败观测或运行日志，不覆盖当前职位。

### 5.2 `career_job_observations`：采集观测

每次对职位的成功观测都应可追溯。

| 字段 | 含义 |
|---|---|
| `id` | 观测 ID |
| `job_id` | 关联 `career_jobs.id` |
| `observed_at` | 观测时间 |
| `content_hash` | 当次内容哈希 |
| `collector_version` | 当次采集器版本 |
| `source_url` | 当次官方页面地址 |
| `raw_excerpt` | 用于复核的有限原文片段 |
| `created_at` | 入库时间 |

观测只追加，不用新观测覆盖旧观测。公开页面只暴露必要证据，不暴露完整原始抓取内容。

### 5.3 采集失败

来源级失败至少记录：

- `source_key`
- `fetched_at`
- 错误类型
- HTTP 状态或解析错误
- 采集器版本
- 可公开的官方来源地址

失败不得被转换成“职位减少”或“行业下降”。

## 6. `MetricSpecV1` 指标契约

### 6.1 通用结构

    export interface MetricSpecV1 {
      metric_id: string;
      version: "1.0";
      label: string;
      definition: string;
      unit: "count" | "ratio" | "theme_list";
      numerator: string;
      denominator: string | null;
      window: string;
      dedupe: string;
      null_policy: string;
      evidence_type: "job" | "observation" | "policy" | "mixed";
      disclaimer: string;
    }

API 返回指标时还必须带：

- `status`: `ok | insufficient_data | not_applicable`
- `value`: 数字或 `null`
- `numerator_count`
- `denominator_count`
- `sample_size`
- `as_of`
- `evidence`
- `disclaimer`

分母为 0、没有有效观测或样本不满足指标前提时，`value=null`，不能返回 0 冒充结论。

### 6.2 岗位结构 `job_family_share`

- 分子：某 `role_family` 的有效去重职位数。
- 分母：全部有效去重职位数。
- 时间：当前最近观测状态。
- `unknown` 单独展示，不强行归类。

### 6.3 技能需求占比 `skill_demand_share`

- 分子：明确要求某技能的有效去重职位数。
- 分母：全部有效去重职位数。
- 一个职位可贡献多个技能，因此各技能占比之和可以超过 100%。
- 必须返回 `dictionary_version` 和未识别技能比例。
- 原始技能词通过 `skill_evidence` 回溯。

### 6.4 应届友好占比 `student_friendly_share`

- 分子：`student_friendly=yes` 的有效去重职位数。
- 分母：全部有效去重职位数。
- 另行返回 `unknown_count` 和 `unknown_ratio`。
- 未写经验或学历不能被计入 `yes`。

### 6.5 观察窗新增职位 `observed_new_jobs`

- 分子：`first_seen_at` 落在观察窗内的有效职位数。
- 分母：观察窗内有效职位总数，或按页面明确说明仅展示数量。
- 只有至少两个可区分的真实观测时点且覆盖相同来源时，才显示变化。
- 只有一个观测时点时：`status=insufficient_data`，前端隐藏涨跌图。
- 文案必须写“平台首次发现”，不得写“市场净增”。

### 6.6 政策—岗位共同方向 `policy_job_shared_themes`

- 输出主题列表，不输出伪精确综合分。
- 每个主题包含：
  - `theme_id`
  - 中文名称
  - 政策证据数量
  - 职位证据数量
  - 政策证据 ID/链接
  - 职位证据 ID/链接
- 只表示共同方向，不表示政策导致招聘变化。

## 7. 政策证据契约

政策继续使用 AIHOT 的采集、去重、正文处理、摘要和 publication 能力。`career-insights` 只引用可公开的政策证据，不复制一套政策发布系统。

`PolicyEvidenceRefV1` 最小字段：

| 字段 | 说明 |
|---|---|
| `policy_item_id` | AIHOT 公开条目 ID |
| `title` | 官方标题 |
| `issuer` | 发布机关 |
| `published_at` | 官方发布时间 |
| `official_url` | 官方原文链接 |
| `source_tier` | 官方来源级别 |
| `theme_ids` | 归一化政策主题 ID |
| `evidence_excerpt` | 支持该主题的原文片段 |

要求：

- 区分正式政策、政策解读和新闻报道。
- 正式政策与解读不能混为同一证据等级。
- 政策主题和岗位主题使用同一套规范化 `theme_id`。
- 不使用无法回到官方原文的政策摘要作为核心证据。

## 8. HTTP API 契约

### 8.1 通用规则

- 基础路径：`/api/site/career-insights`
- 响应外层包含 `contract_version`
- 草案阶段为 `0.1`，D2 验收后升级为 `1.0`
- 所有 GET 只读数据库，不调用模型
- 前端不接触数据库连接、模型密钥和采集密钥
- 默认 `Cache-Control: no-store`
- 时间均为 ISO 8601 UTC
- 页面需要的样本范围、观测时间和限制必须随响应返回

通用错误：

    {
      "error": {
        "code": "invalid_parameter | not_found | data_unavailable | internal_error",
        "message": "可供用户理解的错误说明",
        "details": {}
      }
    }

状态码：

- `400`：筛选参数、分页或 ID 格式错误
- `404`：职位或政策证据不存在
- `503`：数据尚未就绪或数据库不可用
- `500`：未预期内部错误，日志保留追踪 ID，不暴露堆栈

### 8.2 `GET /summary`

用途：就业看板总览。

响应必须包含：

| 字段 | 说明 |
|---|---|
| `contract_version` | 契约版本 |
| `as_of` | 数据截止时间 |
| `sample_size` | 有效职位数 |
| `company_count` | 覆盖公司数 |
| `source_count` | 成功来源数 |
| `first_observed_at` | 最早观测时间 |
| `last_observed_at` | 最近观测时间 |
| `has_multiple_snapshots` | 是否满足多时点展示前提 |
| `metrics` | 按本契约计算的指标 |
| `shared_themes` | 政策—岗位共同方向 |
| `dictionary_version` | 技能词典版本 |
| `warnings` | 来源失败、样本不足、字段未知比例等 |

### 8.3 `GET /jobs`

支持的查询参数：

| 参数 | 规则 |
|---|---|
| `role_family` | 使用约定枚举 |
| `company` | 使用公司稳定标识或精确名称 |
| `city` | 使用归一化地点 |
| `employment_type` | 使用约定枚举 |
| `student_friendly` | `yes/no/unknown` |
| `skill` | 归一化技能 ID |
| `page` | 从 1 开始，默认 1 |
| `page_size` | 默认 20，最大 100 |

响应包含：

- `items`
- `page`
- `page_size`
- `total`
- `as_of`
- `filters`

列表项至少包含：

- `id`
- `company_name`
- `title`
- `role_family`
- `locations`
- `employment_type`
- `student_friendly`
- `skills`
- `published_at`
- `first_seen_at`
- `last_seen_at`
- `official_url`

### 8.4 `GET /jobs/:id`

响应包含：

- 完整职位公开字段
- 官方链接
- 首次和最近发现时间
- 技能证据
- 最近观测摘要
- 数据来源和采集器版本
- 必要的“当前状态以最近观测为准”提示

不返回 Cookie、请求头、完整原始 HTML、内部错误堆栈或任何密钥。

### 8.5 内部采集写入

优先方式：B/C/D 在同一后端进程内通过模块函数写入。

需要外部 Playwright 脚本时：

- 路径：`POST /api/ingest/career-insights/observations`
- 仅内部网络或本机使用，不作为公开互联网接口
- 使用现有采集令牌认证，令牌只在采集端和后端
- 请求包含 `schema_version`、`source_key`、`fetched_at`、`collector_version`、`jobs`
- 单批职位数量限制 100
- 响应返回 `accepted`、`updated`、`duplicates`、`rejected` 和逐项错误
- 逐项错误结构为 `{ index, code, message }`；校验失败时 `code="validation_failed"`，`message` 为 `path: message` 拼接（`path` 为空时只写 `message`）
- 写入必须符合本契约的唯一键、哈希和观测语义
- 认证失败返回 `401`，权限不足返回 `403`，校验失败返回 `400`

## 9. 前端展示契约

E 可以决定布局和视觉，但不能改变数据含义。

必须做到：

- 显示样本量、公司数、来源数和最近观测时间。
- 指标可展开到真实职位或政策证据。
- `status=insufficient_data` 时显示“数据不足”，不能画成 0 或下降。
- `unknown` 单独展示，不能合并到“否”或“不限”。
- 只有一个观测时点时隐藏趋势变化。
- 政策—岗位共同方向必须同时提供两侧证据。
- 就业建议注明“基于本次公开样本，不代表完整就业市场或录用概率”。
- 页面加载、空态、错误态和超时状态可用。
- 不在浏览器中保存或输出模型 Key、数据库密码和采集令牌。

## 10. 来源标识约定

招聘候选来源标识：

| 来源 | `source_key` 建议 |
|---|---|
| 阿里 | `alibaba-official-careers` |
| 腾讯 | `tencent-official-careers` |
| 字节 | `bytedance-official-careers` |
| DeepSeek | `deepseek-official-careers` |
| 智谱 | `zhipu-official-careers` |
| Google | `google-official-careers` |
| OpenAI | `openai-official-careers` |
| Anthropic | `anthropic-official-careers` |

政策候选来源标识：

| 来源 | `source_key` 建议 |
|---|---|
| 国务院政策文件 | `state-council-policy` |
| 国家发展改革委 | `ndrc-policy` |
| 地方省市政府 | `<region>-government-policy` |
| 地方发改委 | `<region>-drc-policy` |

具体 URL、是否自动采集和首发名单由 D1 真实试抓后确认。本契约不预先宣称这些来源一定可抓取。

## 11. 安全与合规

- 只采集公开、允许访问的页面和接口。
- 不绕过登录、验证码、反爬、付费墙和访问频率限制。
- 不采集个人简历、候选人信息、账号、Cookie 或其他个人敏感信息。
- 原始页面只保留复核所需内容，公开展示最小必要字段。
- 官方链接只允许合法 `http/https`，不接受内网、本机云服务元数据地址或 `file:` 等协议。
- 写入 API 默认不暴露到公网。
- 不在 Git、日志、截图、演示视频和前端响应中保存密钥。
- 模型只辅助字段提取和政策摘要，不直接生成指标数字。
- 所有模型付费调用继续走 AIHOT 回执和预算熔断。

## 12. 版本与变更流程

### 12.1 版本节奏

| 阶段 | 版本 | 允许的变化 |
|---|---|---|
| D1 | `0.1` | 字段草案、接口 stub、真实样本校验 |
| D2 | `1.0` | 冻结职位字段、数据库语义和 API |
| D3 | `1.0` 指标冻结 | 冻结指标口径，不再加功能 |
| D4–D5 | `1.0.x` | 只修错误、数据质量和展示问题 |

### 12.2 变更等级

- **补丁**：文案、注释、非语义错误修复。
- **兼容变更**：新增可选字段，不改变旧字段含义，需要 C/D/E 知会。
- **破坏性变更**：删除字段、改名、改类型、改枚举含义、改指标分子分母，需要升级主版本、迁移和 A/C/D/E 共同评审。

D3 后不接受破坏性变更，除非它修复的是数据真实性或安全问题。

### 12.3 PR 必须包含

1. 契约文档变更。
2. 共享类型或 Schema 变更。
3. 真实样本校验结果。
4. 受影响的测试。
5. 对 B/C/D/E 的影响说明。
6. 数据库变更时的迁移与回退说明。

## 13. 验收测试

### 13.1 职位与观测

- [ ] 同一来源、同一 `job_key` 连续写入两次只有一条当前职位。
- [ ] 每次成功写入都有观测，失败不覆盖当前职位。
- [ ] 官方职位 ID 缺失时，规范化 URL 能生成稳定 `job_key`。
- [ ] 内容哈希不受 `fetched_at` 和页面跟踪参数影响。
- [ ] `first_seen_at` 不随后续采集改变，`last_seen_at` 正常推进。
- [ ] 单次未抓到不生成“下架”结论。

### 13.2 字段语义

- [ ] 未写学历时为 `unknown`，不是 `any_explicit`。
- [ ] 未写经验时为 `unknown`，不是 0 年。
- [ ] 官方明确 0 年才允许 `experience_min_years=0`。
- [ ] 官方发布时间缺失时为 `null`，不使用采集时间补齐。
- [ ] 技能均能通过 `skill_evidence` 回溯。

### 13.3 指标与 API

- [ ] 分母为 0 时返回 `value=null` 和 `insufficient_data`。
- [ ] 单快照时新增职位指标不展示趋势。
- [ ] 应届友好指标单独返回未知数量。
- [ ] 同一技能可被多个职位共同计数，比例可超过 100%。
- [ ] 所有指标都有样本量、时间和证据。
- [ ] 非法筛选参数返回 `400`，不存在的 ID 返回 `404`。
- [ ] 数据库未就绪返回 `503`，不伪造空结果。
- [ ] GET 请求不触发模型调用。

### 13.4 安全

- [ ] `.env` 和密钥不在响应、日志和 Git 中。
- [ ] 采集写入接口无令牌时不可写。
- [ ] 原始 HTML 和内部错误堆栈不会出现在公开 API。
- [ ] 官方 URL 校验拒绝内网和非 HTTP 协议。

## 14. D1–D3 签署条件

### D1：草案确认

- [ ] B/C/D/E 对字段和枚举无异议。
- [ ] 至少一个真实招聘样本通过 `NormalizedJobV1` 校验。
- [ ] API 路径和错误结构确定。
- [ ] 首批来源标识确定。

### D2：API v1 冻结

- [ ] 两家公司字段可映射，重复采集幂等。
- [ ] 数据表和观测语义验证通过。
- [ ] summary/jobs/jobs:id 可被前端联调。
- [ ] 契约升级为 `1.0`。

### D3：指标冻结

- [ ] 四类指标和政策共同方向均通过真实样本验证。
- [ ] 页面不再自行推导指标。
- [ ] 所有指标可回到真实证据。
- [ ] 冻结后只修错误，不扩大范围。

## 15. 待确认事项

以下事项不阻塞 v0.1 评审，但在对应开发前必须确认：

- 首发 3 家招聘来源和 2 家备选的具体 URL。
- 首发 2 个政策来源和 1 个地方备选的具体 URL。
- 技能词典与政策主题词典的初始版本。
- 外部 Playwright 采集脚本是否确实需要，以及其部署位置。
- 官方页面没有发布时间时，页面如何提示样本时效。
- 多次未抓到职位时，后续版本如何定义“疑似下架”，MVP 不做此判断。