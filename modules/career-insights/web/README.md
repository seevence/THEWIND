# Career Insights 前端

## 页面

- `/`（首页，2026-11-21 L1 + 中文化）：5 段 —— 今日概览 / AI 就业研判（只留 inferences ≤3 + actions ≤3） / 需求变化三指标（学生友好岗位带口径注） / 最新就业日报摘要+入口 / 热门方向 Top3 一行入口；不再请求 signals 与 latest jobs。
- `/career-insights`（2026-11-21 L2 + E9 二次调整）：**6 段** —— AI 趋势研判（完整 facts/inferences/actions/limitations/evidence，含「给学生的建议」子块）/ 不同寻常的信号（带数字依据与原文链接，skipped 分组提示）/ 岗位趋势 / 技能趋势 / 政策与岗位联动（无共同主题整段隐藏）/ 数据范围与方法。领域词（职族/技能 ID、英文字段名）在渲染前统一中文化；通过正式 HTTP API 并行读取 summary、catalog、signals、brief，逐块降级。
- `/career-insights/jobs`：热门岗位页 —— 方向榜 → 筛选岗位 → 岗位明细（明细带 `#catalog-jobs` 锚点，翻页落到岗位明细顶部、不回到页顶）；筛选真实生效（城市/仅学生友好收窄岗位明细）；筛选 chips 用 `preventScrollReset` 保持当前位置，方向证据链接与翻页带 `#catalog-jobs` 跳到明细。岗位行有「收藏」按钮（本地收藏，见下）。
- `/starred`：收藏页（浏览器本地）—— 文章收藏 + 「收藏的岗位」区块（岗位快照、中文职族/公司/城市/收藏时间、移除、跳职位详情）。岗位收藏存在 `aihot-starred-jobs`（上限 200），与文章收藏相互独立。
- `/career-insights/jobs/:id`：读取职位详情与观测记录。
- `/career-insights/policies`：政策列表页，通过正式 HTTP API 读取 `/api/site/career-insights/policies`，支持 `source_key`、`theme`、`page`、`page_size` 查询参数与分页；参数非法时显示页面级错误状态，不回退 fixture。
- `/hot`：企业招聘热度榜，读取 `/api/site/career-insights/hot?limit=10`（公司、岗位数、前 3 个职族、最近发布日期）。
- `/daily`：就业日报（顺序：今日概况 → AI 评论 → 各来源采集结果），读取 `/api/site/career-insights/daily`（当日各来源采集结果、今日新增与库表计数、空技能岗位占比），并读取 `/api/site/career-insights/daily-comment` 渲染「AI 评论」区块（后台预生成的当日点评 + 生成时间/置信度/当日观测样本/今日新增；无缓存或失败时整块隐藏，页面永不触发模型）。
  （已更新：`/daily` 由站点日报改为就业日报；站点日报的 `/weekly`、`/monthly` 仍走 `/api/site/reports/*`。）

正式页面只使用 `@aihot/web/lib/api.server` 请求 `/api/site/career-insights/*`，不导入 fixture、数据库或密钥。API 返回 503 时页面显示“数据尚未就绪”，不会自动回退 fixture；加载、空态、请求错误和单快照均有独立可见状态。

## 接口现状（正式 API）

- `GET /api/site/career-insights/summary`
- `GET /api/site/career-insights/jobs`
- `GET /api/site/career-insights/jobs/:id`
- `GET /api/site/career-insights/policies`：查询参数 `source_key`、`theme`、`page`（1–10000）、`page_size`（1–100，默认 20）；未知的 `source_key` / `theme`、非法页码或未支持的查询参数均返回 400 `invalid_parameter`；所有响应带 `Cache-Control: no-store`。
- `GET /api/site/career-insights/hot`：查询参数 `limit`（1–50，默认 10）、`window_days`（1–365，默认 30）；未支持参数返回 400 `invalid_parameter`。
- `GET /api/site/career-insights/daily`：不接受查询参数。
- `GET /api/site/career-insights/signals`：查询参数 `limit`（1–50，默认 10）、`window_days`（1–365，默认 30）。

## 本地 fixture 联调

在 AIHOT 仓库根目录启动独立服务：

```bash
node modules/career-insights/web/fixture-server.ts
```

另开终端，让 Web SSR 的 API 指向该服务：

```bash
API_BASE_URL=http://127.0.0.1:3101 npm run dev:web
```

fixture 服务只监听 `127.0.0.1:3101`（可用 `CAREER_FIXTURE_PORT` 改端口，避开并行测试），~~仅提供 summary、jobs 和固定职位详情三个 GET 数据响应~~（已更新：现在同时提供 `GET /api/site/career-insights/policies`，接受 `source_key`、`theme`、`page`、`page_size`；`source_key` 按 6 条样例的固定下标切分模拟后端过滤，非法参数返回 400 `invalid_parameter`，响应同样带 `no-store`），不写数据库。页面看到 `data_origin=synthetic_fixture` 时会显示“联调样例（非真实数据）”。（已更新：同时提供 `GET /api/site/career-insights/hot`、`daily`、`signals` 三个只读响应，供 `/hot`、`/daily` 与看板信号卡联调。）