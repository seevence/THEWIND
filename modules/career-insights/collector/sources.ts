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
    source_key: "huawei-official-careers",
    label: "华为官方招聘",
    kind: "company_careers",
    entry_url: "https://career.huawei.com/cn/social-recruitment-job-list",
    access: "http",
    enabled: true,
    notes:
      "2026-11-21 实测：官方 job-list 组件公开调用 POST /recruitmentPosition/pub/getJobPage（apigw-dgg-b0.huawei.com/api/apig/channelhw，X-HW-ID 为前台公开 appId），匿名无 Cookie/无签名；jobType=SR 社招 603 条，列表即含 mainBusiness/jobRequire；详情页 /cn/job-details?advertisementId=<id> 公开。校招 jobType=CR 正文为占位，未纳入。已存 3 页真实样本。"
  },
  {
    source_key: "moe-policy",
    label: "教育部公告公示",
    kind: "government_policy",
    entry_url: "https://www.moe.gov.cn/jyb_xxgk/s5743/s5744/",
    access: "http",
    enabled: true,
    notes:
      "2026-11-18 试抓：列表 https://www.moe.gov.cn/jyb_xxgk/s5743/s5744/、详情正文 .TRS_Editor / .moe-detail-box、发布时间 meta publishdate；已存 1 列表 + 3 详情样本。2026-11-21 live 复验：教育部全站 HTTPS→HTTP 302 到同 host 同 path，fetch 门禁仅对该栏目路径的精确降级放行（HTTP_DOWNGRADE_ALLOWLIST，见 http-transport.ts）；明文获取存在篡改风险，仅用于公开政策原文，已启用。",
  },
  {
    source_key: "mohrss-policy",
    label: "中国就业网（人力资源社会保障部）中央就业政策",
    kind: "government_policy",
    entry_url: "https://chinajob.mohrss.gov.cn/zcfg/zxzc/zy/",
    access: "http",
    enabled: true,
    notes:
      "2026-11-21 真实试抓：www.mohrss.gov.cn 全站 EdgeOne JS 挑战（access_blocked，不绕过）；改用人社部主办的中国就业网 chinajob.mohrss.gov.cn 公开静态 HTML：列表 /zcfg/zxzc/zy/（中央）、详情 /c/YYYY-MM-DD/<id>.shtml，标题 .detail_con h4、来源 .detail_info .link、日期 .detail_info .date、正文 .detail_article。已存 1 列表 + 4 详情真实样本与回放用例；中央栏目为政策批次更新（非日更），gov.cn/ndrc 补新鲜度。",
  },
  {
    source_key: "netease-official-careers",
    label: "网易官方招聘",
    kind: "company_careers",
    entry_url: "https://hr.163.com/",
    access: "http",
    enabled: true,
    notes:
      "2026-11-21 实测：公开 JSON——列表 POST /api/hr163/position/queryPage（无 Cookie、无 token、无签名），列表项已含 description/requirement；详情 GET /api/hr163/position/query?id=，详情页 /job-detail.html?id=。已存 3 份列表 + 2 份详情真实样本，适配器与回放用例通过。",
  },
  {
    source_key: "didi-official-careers",
    label: "滴滴官方招聘",
    kind: "company_careers",
    entry_url: "https://talent.didiglobal.com/social/",
    access: "http",
    enabled: true,
    notes:
      "2026-11-21 实测：公开 JSON——列表 GET /recruit-portal-service/api/job/front/list?page=&size=（无 Cookie、无 token、无签名），列表项已含 jobDuty/jobQualification；详情 GET /recruit-portal-service/api/job/front/view/{jdId}，详情页 /social/jobDetail?jdId=。已存 3 份列表 + 2 份详情真实样本，适配器与回放用例通过。",
  },
  {
    source_key: "honor-official-careers",
    label: "荣耀官方招聘",
    kind: "company_careers",
    entry_url: "https://career.honor.com/",
    access: "http",
    enabled: true,
    notes:
      "2026-11-21 实测：官网北森托管，公开表单 JSON（无 Cookie/Token/签名）：列表 /wecruit/positionInfo/listPosition/SU5ff669649b0d78e6f4296c9a、详情 listPositionDetail（postId=）；列表含标题/地点/学历/发布时间，职责与要求需逐条取详情；详情页 /SU5ff669649b0d78e6f4296c9a/pb/posDetail.html?postId= 公开。已存 3 列表 + 2 详情真实样本，按 postId 去重。",
  },
  {
    source_key: "changsha-rsj-policy",
    label: "长沙市人力资源和社会保障局劳动就业公告",
    kind: "government_policy",
    entry_url: "http://rsj.changsha.gov.cn/zxzx_0/tzgg_131288/ldjy_131291/",
    access: "http",
    enabled: true,
    notes:
      "2026-11-21 实测：长沙人社局劳动就业公告 TRS 静态 HTML（站点 SiteDomain 为 http，https 443 持续 502）；列表 index_{N-1}.html，详情 h1.article-title/.pages_content；已存 2 列表 + 3 详情真实样本。明文 HTTP 无完整性保护，仅用于公开政策原文，notes 如实标注。",
  },
  {
    source_key: "hunan-jyt-policy",
    label: "湖南省教育厅通知公告",
    kind: "government_policy",
    entry_url: "https://jyt.hunan.gov.cn/jyt/sjyt/xxgk/tzgg/index.html",
    access: "http",
    enabled: true,
    notes:
      "2026-11-21 实测：湖南省教育厅通知公告 TRS 静态 HTML，HTTPS 200、无 Cookie/Token/签名/验证码；列表 index_N.html，详情 .main_content h2/.main_con_zw；已存 2 列表 + 3 详情真实样本。",
  },
  {
    source_key: "cscec-official-careers",
    label: "中国建筑社会招聘",
    kind: "company_careers",
    entry_url: "https://www.cscec.com/rlzy_new/rczp/",
    access: "http",
    enabled: true,
    notes:
      "2026-11-21 实测：官网公开静态 HTML（无 Cookie/Token/签名/验证码）——栏目页 /rlzy_new/rczp/ 列出集团总部+所属企业招聘公告（71 条，单页），详情 /rlzy_new/rczp/{jtzbzp,ssqyzp}/YYYYMM/<id>.html；标题 h2.gsywtpc、发布日期 .fbdate、正文 #gsxwxq > p，招聘岗位小节逐条列岗位。已存 1 列表 + 5 详情真实样本；正文含联系人/电话/邮箱的公告整条跳过。页面模板 <script> 含验证码生成器，block-detector 已在扫描前剔除 script/style。",
  },
];
