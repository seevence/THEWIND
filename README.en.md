# THEWIND · Employment Trends Platform

> An AI platform that turns public job postings and government policies into a daily employment brief.
> Competition entry (team: 疯狂KEC) for the Changsha University of Science & Technology "CodeArts" AI developer contest.

THEWIND collects job postings from official corporate career sites and policy documents from government portals,
normalizes roles, skills and student-friendliness, then publishes a searchable job catalog, career insights and a
daily employment report — every item links back to its official source.

## Features

- **Jobs**: direction ranking, keyword search (Chinese skill names included), city / student-friendly filters, job detail with source and observations.
- **Insights**: AI trend brief (facts, inferences, actions, limitations, confidence), anomaly signals, role and skill trends, policy/job links.
- **Daily report**: overview, AI commentary (pre-generated and cached), per-source collection results, archive.
- **Hot companies**, **policy documents** with relevance filtering.
- **Agent access**: MCP (11 read-only `thewind_*` tools), public API v1 (`/api/v1/career/*`, ETag/304) and RSS feeds.
- **Admin**: `/admin/career` for collection, source health, LLM fallback and insight/comment status.
- Mobile-first UI: 44px touch targets, sticky detail actions, safe-area handling.

## Quick start

```bash
cp .env.example .env          # DATABASE_URL / LLM_* / ADMIN_PASSWORD / SESSION_SECRET
docker compose up -d --build  # http://localhost:3000
```

Collection and the daily report run at **06:10 by default** (Asia/Shanghai); editorials are pre-generated in the
background and cached, so pages never call a model.

## Data sources & license

- Jobs (33 sources): official career sites of Tencent, Meituan, Baidu, Huawei, NetEase, Didi, HONOR and China State
  Construction, plus iFLYTEK, Dahua, Inovance, Sunwoda, BOE, Sugon, H3C, Mindray, United Imaging, INVT, SANY,
  Venustech, Xinje, Roborock, Dreame, AAC Technologies, Piotech, SIASUN, EFORT, Hopewind, SofarSolar, Deye,
  Chipone, Mornsun and Unitree
  (public pages, linked back);
- Policies (7 sources): public documents from the Chinese government portal, NDRC, Ministry of Education, the MOHRSS
  "China Employment Network", Changsha Human Resources and Social Security Bureau, Hunan Provincial Department of
  Education, and the Hunan Provincial Human Resources and Social Security Department notices;
- The 25 zhiye-hosted sources (iFLYTEK, Dahua, Inovance, Sunwoda, BOE, Sugon, H3C, Mindray, United Imaging, INVT,
  SANY, Venustech, Xinje, Roborock, Dreame, AAC Technologies, Piotech, SIASUN, EFORT, Hopewind, SofarSolar, Deye,
  Chipone, Mornsun and Unitree) come from
  their public zhiye job-list endpoints, each linked back to the official job list page
  (`https://<tenant>.zhiye.com/social/jobs`, e.g. <https://iflytek.zhiye.com/social/jobs>) as the original entry.
  INVT's and SANY's official list endpoints ignore pagination, so only the first screen is available.
- Code is MIT licensed; built on the open-source **AIHOT** framework (MIT, Copyright © 2026 数字生命卡兹克). See
  [LICENSE](LICENSE), [NOTICE](NOTICE) and [CREDITS.md](CREDITS.md).
- Chinese README: [README.md](README.md).
