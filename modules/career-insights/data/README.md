# Career Insights 数据契约

本目录提供 `C-DATA@1`：原始职位归一化、去重与内容哈希、五项指标计算、运行时校验，以及 0.1 版技能/主题词典。所有导出均为纯数据或纯函数，不触发采集、网络、数据库或模型调用。

## 职位校验

```ts
import { validateNormalizedJobV1 } from "@aihot/career-insights/data";

const result = validateNormalizedJobV1(input);
if (!result.ok) {
  console.error(result.errors); // Array<{ path: string; message: string }>
}
```

校验器不修改输入、不补全缺值，并尽可能一次返回全部错误。`unknown`、`null` 与空数组是未知信息的合法约定空值；不得把未知经验转换为 0，也不得把未知职族或学生友好状态转换为确定分类。`skills` 与 `skill_evidence.skill_id` 必须指向同一技能集合。

## 归一化

```ts
import { normalizeRawJob, normalizeRawJobs } from "@aihot/career-insights/data";

const job = normalizeRawJob(raw); // RawCollectedJobV1 → NormalizedJobV1
const { normalized, rejected } = normalizeRawJobs(raws);
```

归一化只使用确定性规则：职族、地点、学历、经验、用工类型、学生友好与技能均可回到原文证据。未知字段保持 `null` / `unknown` / `[]`；`experience_min_years=0` 只在官方明确写 0 年时出现。`student_friendly` 按开发契约 4.3 判定，未写经验的初级岗位一律 `unknown`。

## 去重与内容哈希

```ts
import { computeJobKey, computeContentHash, dedupeNormalizedJobs } from "@aihot/career-insights/data";

const jobKey = computeJobKey({ source_job_id, official_url });
const hash = computeContentHash(normalizedJob);
const { unique, duplicates } = dedupeNormalizedJobs(jobs);
```

`job_key` 优先使用官方职位 ID，没有时使用规范化 URL 的 SHA-256。URL 规范化只移除明确的跟踪参数与片段。唯一身份为 `(source_key, job_key)`。内容哈希不包含 `fetched_at` 和易变展示数据，相同内容重复采集得到相同哈希；跨来源近重复只做人工复核分组，不自动合并。

## 指标语义

`METRIC_SPECS_V1` 固定包含以下五项，顺序不得调整：

1. `job_family_share`
2. `skill_demand_share`
3. `student_friendly_share`
4. `observed_new_jobs`
5. `policy_job_shared_themes`

`computeCareerMetrics({ jobs, snapshots, policies, options })` 直接返回 `metric_id` 顺序固定的 `MetricResultV1[]` 与 `SharedThemeV1[]`，供后端 `summary()` 使用。规则：

- 分母为 0 或证据不足时使用 `status="insufficient_data"`、`value=null`，不得返回 0 冒充结论。
- `observed_new_jobs` 至少需要两个不同观测快照；单快照返回 `value=null`，不展示趋势。
- `student_friendly_share` 单独返回 `unknown_count` 与 `unknown_ratio`；`unknown` 计入分母，不转换为 `yes` 或 `no`。
- `skill_demand_share` 每个技能一个维度，一个职位可贡献多个技能，各技能占比之和可以超过 100%。
- `policy_job_shared_themes` 只承载 `shared_themes` 列表，`value=null`；只表示文本证据重合，不表示因果。

## 样本抽查

`QualityJobInputV1` 在指标输入上补充三个经验字段，`inspectMetricSample` 输出字段覆盖率、技能识别覆盖、去重摘要与 `limitations`。空样本比例返回 `null`，不产生 `NaN`；用于 D3 抽查未知字段和生成 API 样本限制文案。

## 明确样例

`../fixtures/sample.ts` 提供 6 条虚构职位、2 条虚构政策和两个观测快照，通过真实 `normalizeRawJobs` 与 `computeCareerMetrics` 生成，覆盖学生友好 `yes` / `no` / `unknown`、未知学历与经验、未识别技能和政策共享主题，固定标记 `synthetic_fixture`。

## 词典

`SKILL_ALIASES` 将技能别名映射到稳定技能 ID，`SKILL_LABELS` 提供展示名，`THEME_LABELS` 与 `THEME_KEYWORDS` 提供主题展示名和识别关键词。版本常量均为 `0.1`；词典只提供映射与确定性规则，不自动修改职位数据。

## 联调数据

`../fixtures/api.ts` 提供 summary、jobs、detail 三份固定联调对象，`data_origin` 均为 `synthetic_fixture`。这些对象完全虚构，不表示真实公司、真实政策或真实趋势，不得接入正式 repository。