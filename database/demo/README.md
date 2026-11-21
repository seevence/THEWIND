# 演示数据（无需 API Key）

这是一份 **2026-11-21 的真实采集快照**，用于让评委/读者**不配置任何密钥**也能看到完整页面。

## 内容

- 岗位：369 条（腾讯 / 美团 / 百度 / 华为 / 网易 / 滴滴 / 荣耀 / 中国建筑）
- 观测记录：659 条
- 政策：10 条（中国政府网 / 发改委 / 教育部 / 人社部中国就业网 / 长沙人社局 / 湖南省教育厅）
- AI 研判缓存：4 条；就业日报评论：1 条
- 全部为公开招聘/政策页面聚合结果，**不含任何个人联系方式、账号或密钥**。

## 导入（本地 Docker，1 分钟）

```bash
# 1. 启动（会先执行数据库迁移与 seed）
cp .env.example .env
docker compose up -d --build

# 2. 导入演示数据（Linux/macOS/Git Bash）
docker compose exec -T db psql -U aihot -d aihot < database/demo/demo-data.sql

# Windows PowerShell：
# Get-Content database/demo/demo-data.sql | docker compose exec -T db psql -U aihot -d aihot

# 3. 打开 http://localhost:3000
```

此时**不需要** `.env` 里的 `LLM_API_KEY`：岗位、洞察、日报、政策都直接读快照与预生成缓存。

## 什么时候才需要 API Key

| 操作 | 需要 LLM Key |
|---|---|
| 浏览岗位 / 洞察 / 日报 / 政策 / Agent 页 | 否（读缓存与演示数据） |
| 重新采集最新岗位、重新生成 AI 研判/日报评论 | 是（在 `.env` 填 `LLM_*` 并设置 `MODEL_CALLS_ENABLED=true`） |

快照日期 2026-11-21，如需最新数据请配置 Key 后运行采集（每日 06:10 自动）。
