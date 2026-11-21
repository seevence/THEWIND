# Career Insights 后端边界

阶段 1 已落地 `SqlCareerRepository`：读取走 SQL 聚合，写入委托 `ingestBatch`。正式 server 不导入 fixture；三个 GET 在调用 repository 前完成参数校验，数据库不可用返回 503，空表返回 200 与 `insufficient_data` 语义，不伪造成功的数字。

## HTTP

- `GET /api/site/career-insights/summary`
- `GET /api/site/career-insights/jobs`
- `GET /api/site/career-insights/jobs/:id`

列表只接受 `role_family`、`company`、`city`、`employment_type`、`student_friendly`、`skill`、`page`、`page_size`。`page` 默认 1，`page_size` 默认 20 且范围为 1..100，详情 ID 必须是 UUID。参数错误返回 400，详情不存在返回 404，数据不可用返回 503，其他异常返回不暴露堆栈的 500。所有成功和错误 GET 响应均带 `Cache-Control: no-store`。准备阶段不注册公开 ingest POST。

## SQL repository 约束

`writeBatch` 逐条调用 `validateNormalizedJobV1`；批次最多 100 条。整批在一个事务内写入：先按 `(source_key, job_key)` 锁定或写入 `career_jobs`，再追加 `career_job_observations`。jsonb 列（`locations`、`skills`、`skill_evidence`、`raw_payload`）必须经 `sql.json()` 传参，不能先 `JSON.stringify`。校验失败按条计入 `rejected`/`errors`，不触发回滚；SQL 失败整批回滚。

首次成功写入当前态和观测；同哈希新时点只推进 `last_seen_at` 并追加观测；不同哈希新时点更新当前态并追加观测；旧观测只追加，不回写当前态。`(job_id, observed_at, content_hash)` 唯一约束负责精确重试去重。`accepted`、`updated`、`duplicates`、`rejected` 分别表示新职位数、较新且哈希变化数、当前态未改变数和拒绝数，四项之和等于输入条数。失败采集不覆盖当前态，未抓到不生成下架状态。