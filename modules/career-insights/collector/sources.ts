import type { CareerSourceDefinition } from "./index.ts";

export const CAREER_SOURCE_DEFINITIONS: readonly CareerSourceDefinition[] = [
  {
    source_key: "alibaba-official-careers",
    label: "阿里巴巴官方招聘",
    kind: "company_careers",
    entry_url: "https://talent.alibaba.com/",
    access: "playwright",
    enabled: false,
    notes:
      "2026-11-18 试抓：列表/详情候选接口均返回 403（需鉴权/CSRF），页面为 SPA 且首页无职位数据；按纪律记 access_blocked，不绕过、不做签名逆向。待换源或官方接口授权。",
  },
  {
    source_key: "tencent-official-careers",
    label: "腾讯官方招聘",
    kind: "company_careers",
    entry_url: "https://careers.tencent.com/",
    access: "http",
    enabled: true,
    notes:
      "2026-11-18 试抓：公开 JSON 可用——列表 /tencentcareer/api/post/Query、详情 /tencentcareer/api/post/ByPostId；已存 1 份列表 + 5 份详情样本，适配器与 7 个用例通过。2026-11-18 门禁修复后已启用，live 10 条真实职位见 evidence/live-runs/。",
  },
  {
    source_key: "meituan-official-careers",
    label: "美团官方招聘",
    kind: "company_careers",
    entry_url: "https://zhaopin.meituan.com/web/position",
    access: "http",
    enabled: true,
    notes:
      "2026-11-18 实测：公开 JSON——POST /api/official/job/getJobList，无 Cookie/无签名，no-auth 之外无需额外头；列表即含 jobDuty/jobRequirement，可省详情请求。2026-11-18 B2 单源 gate 后启用，5 页真实样本与 live 证据见 evidence/。",
  },
  {
    source_key: "baidu-official-careers",
    label: "百度官方招聘",
    kind: "company_careers",
    entry_url: "https://talent.baidu.com/jobs/social-list",
    access: "http",
    enabled: true,
    notes:
      "2026-11-18 实测：POST /httservice/getPostListNew（form），需常规 origin/referer，否则返回 illegal-visit；列表含 workContent/serviceCondition，可省详情请求。2026-11-18 B2 单源 gate 后启用，5 页真实样本与 live 证据见 evidence/。",
  },
  {
    source_key: "bytedance-official-careers",
    label: "字节跳动官方招聘",
    kind: "company_careers",
    entry_url: "https://jobs.bytedance.com/",
    access: "playwright",
    enabled: false,
    notes:
      "2026-11-18 试抓：首页为 SPA 且未暴露 /api 数据；候选端点 /api/v1/search/job/posts GET 返回 HTML、POST 返回 405。按纪律记 schema_changed，待换源或渲染审批。",
  },
  {
    source_key: "state-council-policy",
    label: "中国政府网政策文件库",
    kind: "government_policy",
    entry_url: "https://www.gov.cn/zhengce/zhengceku/",
    access: "http",
    enabled: true,
    notes:
      "2026-11-18 试抓：列表 https://www.gov.cn/zhengce/index.htm、详情 #UCAP-CONTENT；已存 1 列表 + 3 详情样本，解析与适配器通过。2026-11-19 复抓 1 列表+3 详情，live 3/3、issuer 可判定、跳过 0，启用。",
  },
  {
    source_key: "ndrc-policy",
    label: "国家发展改革委政策发布",
    kind: "government_policy",
    entry_url: "https://www.ndrc.gov.cn/xxgk/zcfb/",
    access: "http",
    enabled: true,
    notes:
      "2026-11-18 试抓：列表 https://www.ndrc.gov.cn/xxgk/zcfb/tz/、详情 .TRS_Editor；已存 1 列表 + 3 详情样本，解析与适配器通过。2026-11-18 B2b 单源 gate 后启用。",
  },
  {
    source_key: "moe-policy",
    label: "教育部公告公示",
    kind: "government_policy",
    entry_url: "https://www.moe.gov.cn/jyb_xxgk/s5743/s5744/",
    access: "http",
    enabled: false,
    notes:
      "2026-11-18 试抓：列表 https://www.moe.gov.cn/jyb_xxgk/s5743/s5744/、详情正文 .TRS_Editor / .moe-detail-box、发布时间 meta publishdate；已存 1 列表 + 3 详情样本。作为阿里/字节的替代政策源，待启用评审。",
  },
];