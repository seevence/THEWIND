# Career Insights 采集线

本目录登记官方候选来源与适配器边界。当前只有 `tencent-official-careers` 为 `enabled=true`，其余五源保持禁用；适配器由 `registry.ts` 的 `createCareerAdapters(transport)` 按启用状态构造，job 与 policy 分属两张注册表。未构造的适配器不会发起网络请求、数据库写入或模型调用。

## 来源与访问限制

`sources.ts` 登记阿里巴巴、腾讯、字节跳动官方招聘入口，以及中国政府网、国家发展改革委官方政策入口。招聘页面按公开动态页面预留 `playwright` 访问方式，政策页面预留 `http` 访问方式；这些选择不代表已完成真实试抓。

后续试抓只能访问公开内容，须遵守网站条款并限制频率。遇到登录、验证码、robots 限制或其他访问控制时，应记录限制并保持来源停用，不得绕过。政策页面不得被包装成职位记录。

## 原始样本

适配器只产出 `RawCollectedJobV1`，保留官方页面原文和原始响应，不在采集层归一化职位或计算指标。以下仅是字段形状示例，不是真实采集结果，不可用于指标或联调数据：

```ts
import type { RawCollectedJobV1 } from "../contracts";

const rawSample: RawCollectedJobV1 = {
  schema_version: "1.0",
  source_key: "alibaba-official-careers",
  source_job_id: null,
  company_name: "<官方页面中的公司名>",
  title: "<官方页面中的职位名>",
  official_url: "<职位官方详情页 URL>",
  raw_text: "<官方页面原文>",
  raw_payload: { /* 可选：未经改写的原始响应 */ },
  published_at: null,
  fetched_at: "<本次实际抓取时间的 UTC ISO 8601 字符串>",
  collector_version: "<适配器版本>",
  hints: {
    role_family: "unknown",
    locations: [],
    degree_raw: null,
    experience_raw: null,
    employment_type: "unknown",
    skill_terms: [],
  },
};
```

每次成功抓取都应生成新的 `fetched_at` 并记录适配器版本。官方字段未知时保留 `null`、`unknown` 或空数组，尤其不得把未知经验写成 `0`；空结果不等于市场无岗位。真实适配器验收时应保存对应原始样本及来源 URL，不能用手工编造内容替代。

## 失败记录

`collect` 应将 HTTP、解析和访问限制错误抛给调用方，并在错误上下文中保留 `source_key`，不得把失败吞掉后返回空成功。调用方的失败日志至少记录：

- `source_key` 与 `entry_url`；
- 实际尝试时间；
- 失败阶段：`fetch`、`parse` 或 `access`；
- 原始错误名称和消息，以及适用的 HTTP 状态或访问限制说明。

单次失败不得覆盖已有职位状态；本次未抓到职位也不能据此推断职位下架。

## 后续适配器挂接

1. 为真实来源新增独立适配器，实现 `CareerSourceAdapter`，令其 `definition` 使用已登记的来源定义。
2. 在 `collect(signal?)` 中尊重取消信号，只返回原始 `RawCollectedJobV1[]`，不写数据库、不计算指标、不调用前端。
3. 在 `registry.ts` 的 `createCareerAdapters` 中为新启用来源返回适配器实例；不得用伪适配器或固定样本填充注册表。
4. 完成真实试抓、原始样本验收和访问限制记录后，再按共享契约变更流程评审来源启用状态。
## 已实现的采集纪律（无真实适配器时也可验证）

本目录现已提供与真实适配器可组合的纪律层，全部为纯逻辑，可离线验证：

- `validate.ts`：按 `contracts/job.ts` 的 `RawCollectedJobV1` 校验原文保真、`published_at`/`fetched_at` 分离、UTC ISO 时间、`hints` 枚举与 `null/unknown/[]` 语义，并拒收含个人联系方式的正文。
- `fetch/`：单页 30s 超时、同域并发 1 且上次结束到本次开始至少 1s、单来源 15 分钟预算、超时最多 3 次重试（1s/2s/4s，等待计入预算）、429 仅按 `Retry-After` 重试一次、六类访问限制命中即停、回放零网络守卫。
- `evidence/`：样本 12 项元信息、路径不得越界、敏感响应头剔除与个人数据正文拒收、招聘 5 份/政策 3 份样本下限。
- `orchestration/`：单来源失败隔离（异常带 `source_key` 抛出并记录）、安全阀关闭时零调用、空结果记为失败、非法记录隔离为 `invalid`、来源/批次状态与退出码、成功率排除 rejected/skipped。

边界保持不变：只有 `enabled=true` 的来源会被构造，未启用来源零请求；不得用伪适配器或固定样本填充注册表；真实站点选择器、真实样本与 golden 回放仍需在试抓后补齐。
## 适配器骨架与传输注入（2026-11-18）

- `adapters/alibaba-official-careers.ts` 提供 `createAlibabaOfficialCareersAdapter(transport)`：只经注入的 `FetchTransport` 取页，`AbortSignal` 原样透传；真实页面结构未试抓前 `collect()` 抛 `SchemaChangedError` 并在消息中带 `source_key`，不返回占位记录，也不把空页面当成功。
- 其余四个来源在完成试抓前不建骨架，避免复制未验证的结构假设。

## 交接边界（采集层 → 归一化层）

- 采集层唯一交付 `RawCollectedJobV1[]`；`job_key`、`degree`、`experience_min_years`、`experience_max_years`、`skills`、`content_hash` 等由 `data/normalize.ts` 产出，采集层不得写入。
- `hints` 只是原文线索，不替代 `raw_text`；`hints` 缺省时下游保持 `unknown` / `null` / `[]`。
- `published_at = null` 在下游仍为 `null`，`fetched_at` 与 `collector_version` 原样透传。

## 运行失败观测字段

`orchestration/runner.ts` 的 `SourceRunResult` 提供：`source_key`、`entry_url`、`attempted_at`（UTC ISO）、`failure_stage`（`fetch` / `parse` / `access` / `config`）、`limitation_type`、`original_error_name`、`original_error_message`。失败不会退化为空成功，`status` 仍是唯一业务状态字段。
## 来源试抓记录（2026-11-18，只读探测）

| source_key | 首页 | 页面形态 | 公开 JSON 情况 | 结论 |
|---|---|---|---|---|
| `alibaba-official-careers` | 200（0.54s） | SPA（React/recore 壳，首页约 7.7KB） | `/social/position/recommendPosition.json`、`/social/position/search.json`、`/position/search.json` 均为 **403 Forbidden**（需鉴权/CSRF），未发现公开可读接口 | 暂不可自动采集；按纪律记 `access_blocked`，不绕过、不做签名逆向 |
| `tencent-official-careers` | 200（0.59s） | SPA，但存在公开 JSON | `GET /tencentcareer/api/post/Query?pageIndex=1&pageSize=10&language=zh-cn&area=cn` → 200 / `application/json` / `Count=2120`，`Posts[]` 含 `PostId`、`RecruitPostName`、`LocationName`、`CategoryName`、`Responsibility` 等 | 可零依赖接入（详情字段与正文完整性待验证） |
| `bytedance-official-careers` | 200（1.33s） | SPA（大量 JS chunk） | `/api/v1/search/job/posts` GET 返回 HTML、POST 返回 **405**；未发现公开职位 JSON | 需渲染方案（§5.2）或换备选 |
| `state-council-policy` | 200（0.80s） | 静态 HTML | 无 JSON，需 HTML 解析 | 需 §5.1 解析依赖审批 |
| `ndrc-policy` | 200（1.01s） | 静态 HTML | 无 JSON，需 HTML 解析 | 需 §5.1 解析依赖审批 |

探测约束：单次 GET/POST、同域间隔 ≥1.2s、仅访问公开首页与公开端点；未使用 UA 轮换、代理、验证码识别或签名逆向。阿里 403 与字节 405 分别按 `access_blocked` / `schema_changed` 语义处理，不重试绕过。
## 腾讯职位采集（已接入，2026-11-18）

- 列表：`GET https://careers.tencent.com/tencentcareer/api/post/Query?pageIndex=N&pageSize=10&language=zh-cn&area=cn`
- 详情：`GET https://careers.tencent.com/tencentcareer/api/post/ByPostId?postId=<PostId>&language=zh-cn`
- 两者均为公开 JSON，未触发 401/403/429/验证码；同域请求间隔 ≥1s（适配器内 `MIN_INTERVAL_MS`）。

字段映射：

| 契约字段 | 来源字段 | 说明 |
|---|---|---|
| `source_job_id` | `PostId` | 官方 ID |
| `company_name` | 固定 `"腾讯"` | 官方 `ComName` 为空 |
| `title` | `RecruitPostName` | 原文 |
| `official_url` | `PostURL` | 官方详情页 |
| `raw_text` | `Responsibility` + `Requirement` | 原文拼接，两者皆空则拒收 |
| `published_at` | `LastUpdateTime` | `2026年11月18日` → `2026-11-18T00:00:00.000Z`；无法解析保持 `null` |
| `fetched_at` | 采集时刻 | UTC ISO |
| `hints.locations` | `[LocationName]` | 缺失为 `[]` |
| `hints.experience_raw` | `RequireWorkYearsName` | 原文，缺失为 `null` |
| `hints.role_family` / `employment_type` | 固定 `unknown` | 不从职位名推断 |

真实样本：`evidence/samples/tencent-official-careers/samples/`（1 份列表 + 5 份详情，12 项 meta 齐全）。
启用状态：`sources.ts` 中 `enabled: true`，由 `createCareerAdapters` 构造为唯一 job 适配器。
## HTML 解析端口（2026-11-18）

`html/parse.ts` 提供受限 `HtmlDocument` 端口（`text` / `normalizedText` / `texts` / `attr` / `hrefs` / `html` / `entries`），适配器只依赖该端口，不直接接触 cheerio 类型；`hrefs` 与 `entries` 按 base 绝对化且只保留 http(s)，选择器无命中返回 `null` 或 `[]`，由适配器自行抛 `SchemaChangedError`。`entries` 逐项返回首个链接文本、绝对地址与整项文本（用于同项日期）。

依赖状态（2026-11-18 已授权并落地）：

- `cheerio` 1.2.0 已写入 `modules/career-insights/package.json` 的 `dependencies`（与 `packages/backend` 同版本），`npm install` 已更新 `package-lock.json`，`npm run typecheck` 通过。
## 政策源试抓与解析（2026-11-18）

已抓取每源 1 份列表 + 3 份详情真实样本，落在 `evidence/samples/<source_key>/samples/`：

- 国务院政策库：列表 `https://www.gov.cn/zhengce/index.htm`，详情 `/zhengce/202611/content_*.htm` 或 `/zhengce/content/202611/content_*.htm`
  - 正文：`#UCAP-CONTENT`（回退 `.pages_content` / `.article`）
  - 标题：`h1`；缺失时回退 `<title>` 并去掉 `_栏目_中国政府网` 后缀
  - 发布时间：`.article` 头部 `YYYY-MM-DD`
- 发改委政策发布：列表 `https://www.ndrc.gov.cn/xxgk/zcfb/tz/`，详情 `/xxgk/zcfb/tz/202611/t*.html`
  - 正文：`.TRS_Editor`（回退 `.article_con` / `.article`）
  - 标题：`<title>` 的 `【...】` 内部
  - 发布时间：`.time` 的 `发布时间：YYYY/MM/DD`
  - 文号：标题中的 `〔YYYY〕N号`

解析实现：`adapters/policy-parse.ts` 的 `parseGovPolicyList` / `parseGovPolicyDetail` / `parseNdrcPolicyList` / `parseNdrcPolicyDetail`，均为纯函数，配 4 个真实样本用例。列表只保留正式政策栏目：国务院限定 `/zhengce/`，发改委限定 `/xxgk/zcfb/tz/`，解读/一图读懂等不计入。

**政策输出复用既有契约**：采用 `contracts/job.ts` 的 `PolicyEvidenceRefV1`，不新增类型。`adapters/policy-sources.ts` 提供 `PolicySourceAdapter`（`collect()` 返回 `PolicyEvidenceRefV1[]`）与 `createGovPolicySourceAdapter` / `createNdrcPolicySourceAdapter`，3 个真实样本用例通过。

字段映射：

| 契约字段 | 规则 |
|---|---|
| `policy_item_id` | 详情 URL 末段去掉 `.html` |
| `title` / `official_url` | 详情页标题与原始链接 |
| `issuer` | 国务院源按标题/正文识别（中共中央 / 国务院办公厅 / 国务院），无法判定则该条跳过；发改委固定 `"国家发展改革委"` |
| `published_at` | 解析结果转 `YYYY-MM-DD`；详情页缺失时回退列表页同条日期，仍缺失则跳过 |
| `source_tier` | `"government_official"`（与 backend `PolicySourceTier` 对齐） |
| `theme_ids` | 复用 `data/dictionaries.ts#THEME_KEYWORDS` 对标题+正文匹配，最多 3 个 |
| `evidence_excerpt` | 正文前 200 字的原文摘录（非摘要） |

**仍未启用**：三个政策源 `enabled=false`，`createCareerAdapters` 返回的 policy 注册表为空；`sources.ts` 已新增 `moe-policy`，阿里/字节标注为暂不可采集；政策源需按 A 的门禁顺序逐源启用。

## 备选招聘源探测（2026-11-18，待定）

阿里/字节需要替换，已探测的备选均无零依赖路径：

| 站点 | 结果 |
|---|---|
| 美团 `zhaopin.meituan.com` | 首页 200；`/api/category/allData` 返回 `404 Cannot GET` |
| 百度 `talent.baidu.com` | 首页含 `window.__INITIAL_DATA__`，但混有 `undefined` 不是合法 JSON，且主要为导航配置 |
| 小米 `hr.xiaomi.com` | 200 但无职位链接、无 API，纯 SPA 壳 |
| OPPO / vivo | 200，仅 4.5KB / 1.7KB 的 SPA 壳 |
| 京东 / 网易 / 华为 | 首页可达，未发现内联职位数据或公开 API |

结论与决策（2026-11-18）：**未找到可零依赖接入的第三家招聘源**；按用户决策改用**第三家政策源——教育部公告公示（`moe-policy`）**替代阿里/字节的采集位。已抓 1 列表 + 3 详情真实样本，`parseMoePolicyList/Detail` 与 `createMoePolicySourceAdapter` 已落地（issuer 固定 `教育部`，发布时间取 `meta[name="publishdate"]`，正文 `.TRS_Editor` → `.moe-detail-box`）。招聘源实际保留腾讯 1 家。人社部首页/栏目页返回 JS 混淆挑战，按 `access_blocked` 记录，不绕过。

## 门禁修复与腾讯启用（2026-11-18，接管者）

- `CareerSourceDefinition.enabled` 由字面量 `false` 改为 `boolean`；`registry.ts` 的 `createCareerAdapters(transport)` 只构造已启用来源，job 与 policy 返回两张独立注册表。
- `HttpTransport` 拒绝 HTTPS→HTTP 重定向降级，记 `access_blocked` / `scheme_downgrade`，不再静默接受降级响应。
- 政策适配器缺 issuer 或发布时间时不再 `continue` 静默丢弃，整批抛 `ParseFailedError`。
- `runPolicySource` / `runEnabledPolicySources` 独立运行政策批次，不与 job 适配器混跑。
- 本轮只启用 `tencent-official-careers`，其余五个来源保持 `enabled=false`。
- Live 证据：`evidence/live-runs/20261118T1355Z-tencent.json`（10 条真实职位，耗时 15.3s，HTTP 200，未绕登录/验证码/403）。
- 运行方式：`npx tsx modules/career-insights/collector/cli/collect-career.ts [--out <path>]`，采集层仍不写数据库、不归一化、不计算指标。
