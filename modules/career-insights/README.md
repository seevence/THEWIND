# Career Insights 模块

`@aihot/career-insights` 是 AI+ 就业趋势平台的独立 workspace。准备阶段只提供共享契约、模块地址和各条开发线的边界，不启用真实采集、模型调用、SQL repository 或指标计算。

## 公共入口

```ts
import {
  CAREER_CONTRACT_VERSION,
  CAREER_SCHEMA_VERSION,
  type NormalizedJobV1,
  type SummaryResponseV1,
} from "@aihot/career-insights/contracts";
```

- `CAREER_CONTRACT_VERSION`：并行开发阶段固定为 `0.1`，真实样本验收后才升级。
- `CAREER_SCHEMA_VERSION`：原始及归一化职位结构固定为 `1.0`。
- `contracts/job.ts`：职位、指标规范和政策证据共享类型。
- `contracts/api.ts`：三个 GET、内部批次写入及错误响应类型。
- `contracts/openapi.json`：三个 GET 的 OpenAPI 3.1 契约。

导入契约不会触发采集、数据库或模型调用。官方字段未知时保留 `null`、`unknown` 或 `[]`，不得改写为 `0`、“经验不限”或市场下降。

## 注册地址

- 看板：`/career-insights`
- 职位详情：`/career-insights/jobs/:id`
- API：`/api/site/career-insights/summary`、`/api/site/career-insights/jobs`、`/api/site/career-insights/jobs/:id`

模块只通过 `site/modules/index.ts`、`server.ts`、`web.ts` 接入。准备阶段不注册公开 POST ingest；正式 API 在 repository 未接入时返回 `503 data_unavailable`，不得用空数据或 fixture 冒充成功。

## 协作边界

A 维护包声明、共享契约和注册；B、C、D、E 分别维护 `collector/`、`data/` 与 `fixtures/`、`server.ts` 与 `backend/` 及 `migrations/`、`web.tsx` 与 `web/`。完整分支、命令、PR 和契约变更流程见 [`docs/team-startup.md`](../../docs/team-startup.md)，字段语义见 [`docs/development-contract.md`](../../docs/development-contract.md)。