import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ZHIYE_COLLECTOR_VERSION,
  ZHIYE_DISPLAY_FIELDS,
  ZHIYE_LIST_PATH,
  ZHIYE_SOURCE_SPECS,
  ZHIYE_SOURCES,
  buildZhiyeListBody,
  createZhiyeOfficialCareersAdapter,
  parseZhiyeList,

  toZhiyeRawJob,
  zhiyeJobsPageUrl,
  zhiyeSiteUrl,
} from "../collector/adapters/zhiye-official-careers.ts";
import {
  ConfigError,
  EmptyResultError,
  ParseFailedError,
  SchemaChangedError,
} from "../collector/fetch/errors.ts";
import type {
  FetchTransport,
  PageRequest,
  TransportResponse,
} from "../collector/fetch/transport.ts";
import type { CareerSourceDefinition } from "../collector/index.ts";
import { validateRawCollectedJob } from "../collector/validate.ts";

const SOURCE = "iflytek-official-careers";

const DEFINITION: CareerSourceDefinition = {
  source_key: SOURCE,
  label: "科大讯飞官方招聘",
  kind: "company_careers",
  entry_url: "https://iflytek.zhiye.com/social/jobs",
  access: "http",
  enabled: true,
  notes: "测试夹具",
};

const ADAPTER_OPTIONS = {
  tenant: "iflytek",
  sourceKey: SOURCE,
  companyName: "科大讯飞",
  definition: DEFINITION,
  sleep: async () => {},
  now: () => "2026-11-22T00:00:00.000Z",
};

const RAW_JOB_CONTEXT = {
  sourceKey: SOURCE,
  companyName: "科大讯飞",
  jobsPageUrl: "https://iflytek.zhiye.com/social/jobs",
  fetchedAt: "2026-11-22T00:00:00.000Z",
};

const JOB_FULL = {
  JobAdId: 1001,
  JobAdName: "AI 算法工程师",
  LocNames: ["合肥市", "北京市"],
  Duty: "负责语音识别算法研发与优化",
  Require: "硕士及以上学历，3 年以上相关经验",
  Degree: "硕士",
  YearsOfWorking: "3-5年",
  PostDate: "2026-11-10T14:12:17",
  Kind: "全职",
  Org: "讯飞研究院",
  Salary: "20-40K",
  Category: ["1"],
};

function listBody(items: readonly unknown[], code: unknown = 200): string {
  return JSON.stringify({ Code: code, Message: "success", Data: items });
}

interface RecordingTransport extends FetchTransport {
  readonly requests: PageRequest[];
}

function createTransport(
  handler: (request: PageRequest) => string | Buffer,
  fetchedAt = "2026-11-22T00:00:00.000Z",
): RecordingTransport {
  const requests: PageRequest[] = [];
  return {
    requests,
    async fetchPage(request): Promise<TransportResponse> {
      requests.push(request);
      const body = handler(request);
      return {
        status: 200,
        requestUrl: request.url,
        finalUrl: request.url,
        contentType: "application/json;charset=UTF-8",
        headers: { "content-type": "application/json;charset=UTF-8" },
        body: Buffer.isBuffer(body) ? body : Buffer.from(body, "utf8"),
        fetchedAt,
      };
    },
  };
}

test("ZHIYE_SOURCES 为 86 家企业社招源且顺序与入口固定", () => {
  assert.deepEqual(
    ZHIYE_SOURCES.map((item) => item.source_key),
    [
      "iflytek-official-careers",
      "dahua-official-careers",
      "inovance-official-careers",
      "sunwoda-official-careers",
      "boe-official-careers",
      "sugon-official-careers",
      "h3c-official-careers",
      "mindray-official-careers",
      "united-imaging-official-careers",
      "invt-official-careers",
      "sany-official-careers",
      "venustech-official-careers",
      "xinje-official-careers",
      "roborock-official-careers",
      "dreame-official-careers",
      "aac-official-careers",
      "piotech-official-careers",
      "siasun-official-careers",
      "efort-official-careers",

      "hopewind-official-careers",
      "sofarsolar-official-careers",
      "deye-official-careers",
      "chipone-official-careers",
      "mornsun-official-careers",
      "unitree-official-careers",
      "maxscend-official-careers",
      "chipsea-official-careers",
      "delixi-official-careers",
      "tengen-official-careers",
      "goldwind-official-careers",
      "wetown-official-careers",
      "cicc-official-careers",
      "guosen-official-careers",
      "iqiyi-official-careers",
      "dptech-official-careers",
      "topsec-official-careers",
      "zhonghuan-official-careers",
      "edan-official-careers",
      "jaka-official-careers",
      "eoptolink-official-careers",
      "medcaptain-official-careers",
      "siglent-official-careers",
      "mininglamp-official-careers",
      "rokid-official-careers",
      "unisound-official-careers",
      "hellobike-official-careers",
      "nexchip-official-careers",
      "pylontech-official-careers",
      "dobot-official-careers",
      "infypower-official-careers",
      "joulwatt-official-careers",
      "ucloud-official-careers",
      "beisen-official-careers",
      "fxiaoke-official-careers",
      "autochips-official-careers",
      "bestechnic-official-careers",
      "biwin-official-careers",
      "cxmt-official-careers",
      "longsys-official-careers",
      "nanxin-official-careers",
      "risen-official-careers",
      "tongwei-official-careers",
      "ymtc-official-careers",
      "aqara-official-careers",
      "awinic-official-careers",
      "digitalchina-official-careers",
      "snibe-official-careers",
      "yusys-official-careers",
      "leapmotor-official-careers",
      "sunlord-official-careers",
      "winline-official-careers",
      "changan-official-careers",
      "chery-official-careers",
      "wondershare-official-careers",
      "jmc-official-careers",
      "fibocom-official-careers",
      "neoway-official-careers",
      "zhihuiya-official-careers",
      "advantech-official-careers",
      "liteon2-official-careers",
      "cosmx-official-careers",
      "apsystems-official-careers",
      "benq-official-careers",
      "hwatsing-official-careers",
      "amphenol-official-careers",
      "sosen-official-careers",
    ],
  );
  assert.deepEqual(
    ZHIYE_SOURCES.map((item) => item.entry_url),
    [
      "https://iflytek.zhiye.com/social/jobs",
      "https://dahua.zhiye.com/social/jobs",
      "https://inovance.zhiye.com/social/jobs",
      "https://sunwoda.zhiye.com/social/jobs",
      "https://boe.zhiye.com/social/jobs",
      "https://sugon.zhiye.com/social/jobs",
      "https://h3c.zhiye.com/social/jobs",
      "https://mindray.zhiye.com/social/jobs",
      "https://united-imaging.zhiye.com/social/jobs",
      "https://invt.zhiye.com/social/jobs",
      "https://sany.zhiye.com/social/jobs",
      "https://venustech.zhiye.com/social/jobs",
      "https://xinje.zhiye.com/social/jobs",
      "https://roborock.zhiye.com/social/jobs",
      "https://dreame.zhiye.com/social/jobs",
      "https://aac.zhiye.com/social/jobs",
      "https://piotech.zhiye.com/social/jobs",
      "https://siasun.zhiye.com/social/jobs",
      "https://efort.zhiye.com/social/jobs",

      "https://hopewind.zhiye.com/social/jobs",
      "https://sofarsolar.zhiye.com/social/jobs",
      "https://deye.zhiye.com/social/jobs",
      "https://chipone.zhiye.com/social/jobs",
      "https://mornsun.zhiye.com/social/jobs",
      "https://unitree.zhiye.com/social/jobs",
      "https://maxscend.zhiye.com/social/jobs",
      "https://chipsea.zhiye.com/social/jobs",
      "https://delixi.zhiye.com/social/jobs",
      "https://tengen.zhiye.com/social/jobs",
      "https://goldwind.zhiye.com/social/jobs",
      "https://wetown.zhiye.com/social/jobs",
      "https://cicc.zhiye.com/social/jobs",
      "https://guosen.zhiye.com/social/jobs",
      "https://iqiyi.zhiye.com/social/jobs",
      "https://dptech.zhiye.com/social/jobs",
      "https://topsec.zhiye.com/social/jobs",
      "https://zhonghuan.zhiye.com/social/jobs",
      "https://edan.zhiye.com/social/jobs",
      "https://jaka.zhiye.com/social/jobs",
      "https://eoptolink.zhiye.com/social/jobs",
      "https://medcaptain.zhiye.com/social/jobs",
      "https://siglent.zhiye.com/social/jobs",
      "https://mininglamp.zhiye.com/social/jobs",
      "https://rokid.zhiye.com/social/jobs",
      "https://unisound.zhiye.com/social/jobs",
      "https://hellobike.zhiye.com/social/jobs",
      "https://nexchip.zhiye.com/social/jobs",
      "https://pylontech.zhiye.com/social/jobs",
      "https://dobot.zhiye.com/social/jobs",
      "https://infypower.zhiye.com/social/jobs",
      "https://joulwatt.zhiye.com/social/jobs",
      "https://ucloud.zhiye.com/social/jobs",
      "https://beisen.zhiye.com/social/jobs",
      "https://fxiaoke.zhiye.com/social/jobs",
      "https://autochips.zhiye.com/social/jobs",
      "https://bestechnic.zhiye.com/social/jobs",
      "https://biwin.zhiye.com/social/jobs",
      "https://cxmt.zhiye.com/social/jobs",
      "https://longsys.zhiye.com/social/jobs",
      "https://nanxin.zhiye.com/social/jobs",
      "https://risen.zhiye.com/social/jobs",
      "https://tongwei.zhiye.com/social/jobs",
      "https://ymtc.zhiye.com/social/jobs",
      "https://aqara.zhiye.com/social/jobs",
      "https://awinic.zhiye.com/social/jobs",
      "https://digitalchina.zhiye.com/social/jobs",
      "https://snibe.zhiye.com/social/jobs",
      "https://yusys.zhiye.com/social/jobs",
      "https://leapmotor.zhiye.com/social/jobs",
      "https://sunlord.zhiye.com/social/jobs",
      "https://winline.zhiye.com/social/jobs",
      "https://changan.zhiye.com/social/jobs",
      "https://chery.zhiye.com/social/jobs",
      "https://wondershare.zhiye.com/social/jobs",
      "https://jmc.zhiye.com/social/jobs",
      "https://fibocom.zhiye.com/social/jobs",
      "https://neoway.zhiye.com/social/jobs",
      "https://zhihuiya.zhiye.com/social/jobs",
      "https://advantech.zhiye.com/social/jobs",
      "https://liteon2.zhiye.com/social/jobs",
      "https://cosmx.zhiye.com/social/jobs",
      "https://apsystems.zhiye.com/social/jobs",
      "https://benq.zhiye.com/social/jobs",
      "https://hwatsing.zhiye.com/social/jobs",
      "https://amphenol.zhiye.com/social/jobs",
      "https://sosen.zhiye.com/social/jobs",
    ],
  );
  assert.deepEqual(
    ZHIYE_SOURCES.map((item) => item.label),
    [
      "科大讯飞官方招聘",
      "大华股份官方招聘",
      "汇川技术官方招聘",
      "欣旺达官方招聘",
      "京东方官方招聘",
      "中科曙光官方招聘",
      "新华三官方招聘",
      "迈瑞医疗官方招聘",
      "联影医疗官方招聘",
      "英威腾官方招聘",
      "三一重工官方招聘",
      "启明星辰官方招聘",
      "信捷电气官方招聘",
      "石头科技官方招聘",
      "追觅科技官方招聘",
      "瑞声科技官方招聘",
      "拓荆科技官方招聘",
      "新松机器人官方招聘",
      "埃夫特官方招聘",
      "禾望电气官方招聘",
      "首航新能源官方招聘",
      "德业股份官方招聘",
      "集创北方官方招聘",
      "金升阳官方招聘",
      "宇树科技官方招聘",
      "卓胜微电子官方招聘",
      "芯海科技官方招聘",
      "德力西官方招聘",
      "天正电气官方招聘",
      "金风科技官方招聘",
      "威腾电气集团官方招聘",
      "中金公司官方招聘",
      "国信证券官方招聘",
      "爱奇艺线下业务官方招聘",
      "迪普科技官方招聘",
      "天融信官方招聘",
      "TCL中环官方招聘",
      "理邦仪器官方招聘",
      "节卡机器人官方招聘",
      "新易盛官方招聘",
      "麦科田医疗官方招聘",
      "鼎阳科技官方招聘",
      "明略科技官方招聘",
      "Rokid官方招聘",
      "云知声官方招聘",
      "哈啰官方招聘",
      "晶合集成官方招聘",
      "中兴派能官方招聘",
      "越疆机器人官方招聘",
      "英飞源官方招聘",
      "杰华特官方招聘",
      "UCloud官方招聘",
      "北森官方招聘",
      "纷享销客官方招聘",
      "杰发科技官方招聘",
      "恒玄科技官方招聘",
      "佰维存储官方招聘",
      "长鑫存储官方招聘",
      "江波龙官方招聘",
      "南芯半导体官方招聘",
      "东方日升官方招聘",
      "通威股份官方招聘",
      "长江存储官方招聘",
      "绿米联创官方招聘",
      "艾为电子官方招聘",
      "神州数码官方招聘",
      "新产业生物官方招聘",
      "宇信科技官方招聘",
      "零跑汽车官方招聘",
      "南京商络电子官方招聘",
      "永联科技官方招聘",
      "长安汽车官方招聘",
      "奇瑞汽车官方招聘",
      "万兴科技官方招聘",
      "江铃汽车官方招聘",
      "广和通官方招聘",
      "有方科技官方招聘",
      "智慧芽官方招聘",
      "研华科技官方招聘",
      "光宝科技官方招聘",
      "珠海冠宇官方招聘",
      "领储宇能官方招聘",
      "明基BenQ官方招聘",
      "华海清科官方招聘",
      "安费诺光纤官方招聘",
      "崧盛电子官方招聘",
    ],
  );
  assert.ok(ZHIYE_SOURCES.every((item) => item.kind === "company_careers"));
  assert.ok(ZHIYE_SOURCES.every((item) => item.access === "http" && item.enabled));
  assert.equal(ZHIYE_SOURCES.length, 86);
  assert.equal(ZHIYE_SOURCE_SPECS.length, 86);
  assert.equal(ZHIYE_LIST_PATH, "/api/Jobad/GetJobAdPageList");
  assert.equal(ZHIYE_COLLECTOR_VERSION, "collector/0.2.0");
  assert.equal(zhiyeSiteUrl("dahua"), "https://dahua.zhiye.com");
  assert.equal(zhiyeJobsPageUrl("sunwoda"), "https://sunwoda.zhiye.com/social/jobs");
  assert.equal(zhiyeSiteUrl("united-imaging"), "https://united-imaging.zhiye.com");
  assert.equal(zhiyeJobsPageUrl("united-imaging"), "https://united-imaging.zhiye.com/social/jobs");
  assert.equal(zhiyeJobsPageUrl("sany"), "https://sany.zhiye.com/social/jobs");
});

test("ZHIYE_SOURCE_SPECS 为三元组唯一来源，顺序与 ZHIYE_SOURCES / C-REGISTRY@1 一致", () => {
  assert.deepEqual(
    ZHIYE_SOURCE_SPECS.map((spec) => [spec.sourceKey, spec.tenant, spec.companyName]),
    [
      ["iflytek-official-careers", "iflytek", "科大讯飞"],
      ["dahua-official-careers", "dahua", "浙江大华技术股份有限公司"],
      ["inovance-official-careers", "inovance", "汇川技术"],
      ["sunwoda-official-careers", "sunwoda", "欣旺达"],
      ["boe-official-careers", "boe", "京东方"],
      ["sugon-official-careers", "sugon", "中科曙光"],
      ["h3c-official-careers", "h3c", "新华三"],
      ["mindray-official-careers", "mindray", "迈瑞医疗"],
      ["united-imaging-official-careers", "united-imaging", "联影医疗"],
      ["invt-official-careers", "invt", "英威腾"],
      ["sany-official-careers", "sany", "三一重工"],
      ["venustech-official-careers", "venustech", "启明星辰"],
      ["xinje-official-careers", "xinje", "信捷电气"],
      ["roborock-official-careers", "roborock", "石头科技"],
      ["dreame-official-careers", "dreame", "追觅科技"],
      ["aac-official-careers", "aac", "瑞声科技"],
      ["piotech-official-careers", "piotech", "拓荆科技"],
      ["siasun-official-careers", "siasun", "新松机器人"],
      ["efort-official-careers", "efort", "埃夫特"],

      ["hopewind-official-careers", "hopewind", "禾望电气"],
      ["sofarsolar-official-careers", "sofarsolar", "首航新能源"],
      ["deye-official-careers", "deye", "德业股份"],
      ["chipone-official-careers", "chipone", "集创北方"],
      ["mornsun-official-careers", "mornsun", "金升阳"],
      ["unitree-official-careers", "unitree", "宇树科技"],
      ["maxscend-official-careers", "maxscend", "卓胜微电子"],
      ["chipsea-official-careers", "chipsea", "芯海科技"],
      ["delixi-official-careers", "delixi", "德力西"],
      ["tengen-official-careers", "tengen", "天正电气"],
      ["goldwind-official-careers", "goldwind", "金风科技"],
      ["wetown-official-careers", "wetown", "威腾电气集团"],
      ["cicc-official-careers", "cicc", "中金公司"],
      ["guosen-official-careers", "guosen", "国信证券"],
      ["iqiyi-official-careers", "iqiyi", "爱奇艺线下业务"],
      ["dptech-official-careers", "dptech", "杭州迪普科技股份有限公司"],
      ["topsec-official-careers", "topsec", "天融信科技集团"],
      ["zhonghuan-official-careers", "zhonghuan", "TCL中环"],
      ["edan-official-careers", "edan", "理邦仪器"],
      ["jaka-official-careers", "jaka", "节卡机器人"],
      ["eoptolink-official-careers", "eoptolink", "成都新易盛通信技术股份有限公司"],
      ["medcaptain-official-careers", "medcaptain", "麦科田医疗"],
      ["siglent-official-careers", "siglent", "鼎阳科技"],
      ["mininglamp-official-careers", "mininglamp", "明略科技"],
      ["rokid-official-careers", "rokid", "Rokid"],
      ["unisound-official-careers", "unisound", "云知声"],
      ["hellobike-official-careers", "hellobike", "上海哈啰普惠科技有限公司"],
      ["nexchip-official-careers", "nexchip", "合肥晶合集成电路股份有限公司"],
      ["pylontech-official-careers", "pylontech", "中兴派能"],
      ["dobot-official-careers", "dobot", "越疆机器人"],
      ["infypower-official-careers", "infypower", "英飞源"],
      ["joulwatt-official-careers", "joulwatt", "杰华特"],
      ["ucloud-official-careers", "ucloud", "UCloud"],
      ["beisen-official-careers", "beisen", "北森"],
      ["fxiaoke-official-careers", "fxiaoke", "纷享销客"],
      ["autochips-official-careers", "autochips", "杰发科技"],
      ["bestechnic-official-careers", "bestechnic", "恒玄科技"],
      ["biwin-official-careers", "biwin", "佰维存储"],
      ["cxmt-official-careers", "cxmt", "长鑫存储"],
      ["longsys-official-careers", "longsys", "江波龙"],
      ["nanxin-official-careers", "nanxin", "南芯半导体"],
      ["risen-official-careers", "risen", "东方日升"],
      ["tongwei-official-careers", "tongwei", "通威股份"],
      ["ymtc-official-careers", "ymtc", "长江存储"],
      ["aqara-official-careers", "aqara", "绿米联创"],
      ["awinic-official-careers", "awinic", "艾为电子"],
      ["digitalchina-official-careers", "digitalchina", "神州数码"],
      ["snibe-official-careers", "snibe", "新产业生物"],
      ["yusys-official-careers", "yusys", "宇信科技"],
      ["leapmotor-official-careers", "leapmotor", "零跑汽车"],
      ["sunlord-official-careers", "sunlord", "南京商络电子股份有限公司"],
      ["winline-official-careers", "winline", "深圳永联科技股份有限公司"],
      ["changan-official-careers", "changan", "长安汽车"],
      ["chery-official-careers", "chery", "奇瑞汽车"],
      ["wondershare-official-careers", "wondershare", "万兴科技"],
      ["jmc-official-careers", "jmc", "江铃汽车"],
      ["fibocom-official-careers", "fibocom", "广和通"],
      ["neoway-official-careers", "neoway", "有方科技"],
      ["zhihuiya-official-careers", "zhihuiya", "智慧芽"],
      ["advantech-official-careers", "advantech", "研华科技"],
      ["liteon2-official-careers", "liteon2", "光宝科技"],
      ["cosmx-official-careers", "cosmx", "珠海冠宇"],
      ["apsystems-official-careers", "apsystems", "领储宇能科技有限公司"],
      ["benq-official-careers", "benq", "明基BenQ"],
      ["hwatsing-official-careers", "hwatsing", "华海清科"],
      ["amphenol-official-careers", "amphenol", "安费诺光纤技术(深圳)有限公司"],
      ["sosen-official-careers", "sosen", "深圳市崧盛电子股份有限公司"],
    ],
  );
  assert.deepEqual(
    ZHIYE_SOURCE_SPECS.map((spec) => spec.sourceKey),
    ZHIYE_SOURCES.map((item) => item.source_key),
  );
  assert.deepEqual(
    ZHIYE_SOURCE_SPECS.map((spec) => zhiyeJobsPageUrl(spec.tenant)),
    ZHIYE_SOURCES.map((item) => item.entry_url),
  );
});

test("invt / sany 源定义 notes 声明官方分页不生效，其余源不声明", () => {
  for (const sourceKey of ["invt-official-careers", "sany-official-careers"]) {
    const definition = ZHIYE_SOURCES.find((entry) => entry.source_key === sourceKey);
    assert.ok(definition !== undefined, sourceKey);
    assert.match(definition.notes ?? "", /分页不生效/, sourceKey);
  }
  const paged = ZHIYE_SOURCES.filter(
    (entry) => entry.source_key !== "invt-official-careers" && entry.source_key !== "sany-official-careers",
  );
  assert.ok(paged.every((entry) => !(entry.notes ?? "").includes("分页不生效")));
});

test("稀疏源 notes 如实标注在招条数，仅落盘空页样本的源声明空页为真实响应", () => {
  const expected: readonly [string, number][] = [
    ["risen-official-careers", 4],
    ["apsystems-official-careers", 1],
    ["benq-official-careers", 3],
    ["hwatsing-official-careers", 1],
    ["amphenol-official-careers", 1],
    ["sosen-official-careers", 1],
  ];
  const emptyPageSampleKeys = new Set([
    "risen-official-careers",
    "apsystems-official-careers",
    "benq-official-careers",
  ]);
  for (const [sourceKey, count] of expected) {
    const definition = ZHIYE_SOURCES.find((entry) => entry.source_key === sourceKey);
    assert.ok(definition !== undefined, sourceKey);
    assert.match(definition.notes ?? "", new RegExp(`在招岗位极少（${count} 条）`), sourceKey);
    if (emptyPageSampleKeys.has(sourceKey)) {
      assert.match(definition.notes ?? "", /样本中空页属真实响应/, sourceKey);
    } else {
      assert.ok(!(definition.notes ?? "").includes("样本中空页"), sourceKey);
    }
  }
  const sparseKeys = new Set(expected.map(([sourceKey]) => sourceKey));
  const nonSparse = ZHIYE_SOURCES.filter((entry) => !sparseKeys.has(entry.source_key));
  assert.ok(nonSparse.every((entry) => !(entry.notes ?? "").includes("在招岗位极少")));

  assert.deepEqual(
    ZHIYE_SOURCE_SPECS.filter((spec) => spec.sparseJobCount !== undefined)
      .map((spec) => [spec.sourceKey, spec.sparseJobCount, spec.sparseEmptyPageSample === true]),
    expected.map(([sourceKey, count]) => [sourceKey, count, emptyPageSampleKeys.has(sourceKey)]),
  );
});

test("buildZhiyeListBody 字段固定且 PageIndex 由调用方给出", () => {
  assert.deepEqual(buildZhiyeListBody(2, 20), {
    PageIndex: 2,
    PageSize: 20,
    Category: ["1"],
    KeyWords: "",
    SpecialType: 0,
    PortalId: "",
    DisplayFields: ZHIYE_DISPLAY_FIELDS,
  });
});

test("zhiye 列表解析保留标题/城市/职责/要求/机构/薪资与原始条目", () => {
  const items = parseZhiyeList(listBody([JOB_FULL]));
  assert.equal(items.length, 1);
  const job = items[0];
  assert.ok(job !== undefined);
  assert.equal(job.id, "1001");
  assert.equal(job.title, "AI 算法工程师");
  assert.deepEqual(job.locations, ["合肥市", "北京市"]);
  assert.equal(job.duty, "负责语音识别算法研发与优化");
  assert.equal(job.requirement, "硕士及以上学历，3 年以上相关经验");
  assert.equal(job.degreeRaw, "硕士");
  assert.equal(job.experienceRaw, "3-5年");
  assert.equal(job.org, "讯飞研究院");
  assert.equal(job.salary, "20-40K");
  assert.equal(job.raw["JobAdId"], 1001);
});

test("zhiye 列表条目缺 JobAdId / JobAdName 时抛 ParseFailedError", () => {
  assert.throws(() => parseZhiyeList(listBody([{ JobAdName: "缺少主键" }])), ParseFailedError);
  assert.throws(() => parseZhiyeList(listBody([{ JobAdId: 1 }])), ParseFailedError);
});

test("zhiye PostDate 截断为日期，零值与不可解析值返回 null", () => {
  const cases: ReadonlyArray<readonly [unknown, string | null]> = [
    ["2026-11-10T14:12:17", "2026-11-10"],
    ["0001-01-01T00:00:00", null],
    ["", null],
    ["not-a-date", null],
    [undefined, null],
  ];
  for (const [postDate, expected] of cases) {
    const items = parseZhiyeList(listBody([{ ...JOB_FULL, PostDate: postDate }]));
    assert.equal(items[0]?.publishedAt, expected, `PostDate=${String(postDate)}`);
  }
  const zero = parseZhiyeList(listBody([{ ...JOB_FULL, PostDate: "0001-01-01T00:00:00" }]));
  assert.equal(toZhiyeRawJob(zero[0]!, RAW_JOB_CONTEXT).published_at, null);
});

test("zhiye Kind 映射实习/全职/社招缺省/其他", () => {
  const cases = [
    ["实习", "internship"],
    ["全职", "experienced"],
    ["社会招聘", "experienced"],
    ["兼职", "unknown"],
  ] as const;
  for (const [kind, expected] of cases) {
    const items = parseZhiyeList(listBody([{ ...JOB_FULL, Kind: kind }]));
    assert.equal(items[0]?.employmentType, expected, `Kind=${kind}`);
  }
  const missing = parseZhiyeList(listBody([{ ...JOB_FULL, Kind: "" }]));
  assert.equal(missing[0]?.employmentType, "experienced");
});

test("zhiye Code 非 200 抛 SchemaChangedError 而不是空结果", () => {
  assert.throws(() => parseZhiyeList(listBody([JOB_FULL], 500)), SchemaChangedError);
  assert.throws(() => parseZhiyeList(listBody([], "500")), SchemaChangedError);
});

test("zhiye 空 Data 抛 EmptyResultError，结构缺失/非法 JSON 抛 SchemaChangedError", () => {
  assert.throws(() => parseZhiyeList(listBody([])), EmptyResultError);
  assert.throws(() => parseZhiyeList(JSON.stringify({ Code: 200, Data: null })), SchemaChangedError);
  assert.throws(() => parseZhiyeList(JSON.stringify({ Code: 200 })), SchemaChangedError);
  assert.throws(() => parseZhiyeList("{"), SchemaChangedError);
  assert.throws(() => parseZhiyeList(JSON.stringify([])), SchemaChangedError);
});

test("zhiye 职责与要求同时空白时 toZhiyeRawJob 抛 ParseFailedError", () => {
  const items = parseZhiyeList(listBody([{ ...JOB_FULL, Duty: "", Require: "  " }]));
  const job = items[0];
  assert.ok(job !== undefined);
  assert.equal(job.duty, null);
  assert.equal(job.requirement, null);
  assert.throws(() => toZhiyeRawJob(job, RAW_JOB_CONTEXT), ParseFailedError);
});

test("zhiye 单页采集发出一次 POST 请求并按契约映射为原始职位", async () => {
  const transport = createTransport(() => listBody([JOB_FULL]));
  const adapter = createZhiyeOfficialCareersAdapter(transport, ADAPTER_OPTIONS);
  const jobs = await adapter.collect();
  assert.equal(transport.requests.length, 1);
  const request = transport.requests[0];
  assert.ok(request !== undefined);
  assert.equal(request.method, "POST");
  assert.equal(request.url, "https://iflytek.zhiye.com/api/Jobad/GetJobAdPageList");
  assert.equal(request.sourceKey, SOURCE);
  assert.equal(request.pageTimeoutMs, 20_000);
  assert.equal(request.headers["content-type"], "application/json");
  assert.equal(request.headers["accept"], "application/json");
  const body = JSON.parse(request.body ?? "{}") as Record<string, unknown>;
  assert.equal(body["PageIndex"], 0);
  assert.equal(body["PageSize"], 20);
  assert.deepEqual(body["Category"], ["1"]);
  assert.deepEqual(body["DisplayFields"], ZHIYE_DISPLAY_FIELDS);

  assert.equal(jobs.length, 1);
  const job = jobs[0];
  assert.ok(job !== undefined);
  assert.equal(job.schema_version, "1.0");
  assert.equal(job.source_key, SOURCE);
  assert.equal(job.source_job_id, "1001");
  assert.equal(job.company_name, "科大讯飞");
  assert.equal(job.title, "AI 算法工程师");
  assert.equal(job.official_url, "https://iflytek.zhiye.com/social/jobs");
  assert.equal(job.raw_text, "负责语音识别算法研发与优化\n\n硕士及以上学历，3 年以上相关经验");
  assert.equal(job.published_at, "2026-11-09T16:00:00.000Z");
  assert.equal(job.fetched_at, "2026-11-22T00:00:00.000Z");
  assert.equal(job.collector_version, ZHIYE_COLLECTOR_VERSION);
  assert.deepEqual(job.hints.locations, ["合肥市", "北京市"]);
  assert.equal(job.hints.degree_raw, "硕士");
  assert.equal(job.hints.experience_raw, "3-5年");
  assert.equal(job.hints.employment_type, "experienced");
  assert.deepEqual(job.hints.skill_terms, []);
  assert.equal(job.raw_payload?.["JobAdId"], 1001);
  assert.equal(validateRawCollectedJob(job).ok, true);
});

test("zhiye 按 PageIndex 0 基翻页，每页一次请求且页间 sleep 1000ms", async () => {
  const sleeps: number[] = [];
  const transport = createTransport((request) => {
    const body = JSON.parse(request.body ?? "{}") as Record<string, number>;
    return listBody([{ ...JOB_FULL, JobAdId: 2000 + body["PageIndex"], JobAdName: `岗位 ${body["PageIndex"]}` }]);
  });
  const adapter = createZhiyeOfficialCareersAdapter(transport, {
    ...ADAPTER_OPTIONS,
    pageLimit: 2,
    sleep: async (ms: number) => {
      sleeps.push(ms);
    },
  });
  const jobs = await adapter.collect();
  assert.deepEqual(
    transport.requests.map((request) => (JSON.parse(request.body ?? "{}") as Record<string, number>)["PageIndex"]),
    [0, 1],
  );
  assert.deepEqual(sleeps, [1_000]);
  assert.deepEqual(
    jobs.map((job) => job.source_job_id),
    ["2000", "2001"],
  );
});

test("zhiye 后续页空 Data 结束采集并保留已采结果", async () => {
  const transport = createTransport((request) => {
    const body = JSON.parse(request.body ?? "{}") as Record<string, number>;
    return body["PageIndex"] === 0 ? listBody([JOB_FULL]) : listBody([]);
  });
  const adapter = createZhiyeOfficialCareersAdapter(transport, {
    ...ADAPTER_OPTIONS,
    pageLimit: 3,
  });
  const jobs = await adapter.collect();
  assert.equal(transport.requests.length, 2);
  assert.deepEqual(jobs.map((job) => job.source_job_id), ["1001"]);
});

test("zhiye 跨页重复 JobAdId 只保留首条", async () => {
  const pages: Record<number, readonly unknown[]> = {
    0: [JOB_FULL, { ...JOB_FULL, JobAdId: 1002, JobAdName: "算法平台工程师" }],
    1: [{ ...JOB_FULL, JobAdName: "重复首页岗位" }, { ...JOB_FULL, JobAdId: 1003, JobAdName: "嵌入式工程师" }],
  };
  const transport = createTransport((request) => {
    const body = JSON.parse(request.body ?? "{}") as Record<string, number>;
    return listBody(pages[body["PageIndex"]] ?? []);
  });
  const adapter = createZhiyeOfficialCareersAdapter(transport, {
    ...ADAPTER_OPTIONS,
    pageLimit: 2,
  });
  const jobs = await adapter.collect();
  assert.deepEqual(jobs.map((job) => job.source_job_id), ["1001", "1002", "1003"]);
  assert.deepEqual(jobs.map((job) => job.title), ["AI 算法工程师", "算法平台工程师", "嵌入式工程师"]);
});

test("zhiye fetched_at 取响应采集时刻而非适配器本地时钟", async () => {
  const transport = createTransport(() => listBody([JOB_FULL]), "2026-11-20T08:30:00.000Z");
  const adapter = createZhiyeOfficialCareersAdapter(transport, {
    ...ADAPTER_OPTIONS,
    now: () => "2026-11-22T00:00:00.000Z",
  });
  const jobs = await adapter.collect();
  assert.equal(jobs[0]?.fetched_at, "2026-11-20T08:30:00.000Z");
});

test("zhiye pageLimit 上限为 3", async () => {
  const transport = createTransport((request) => {
    const body = JSON.parse(request.body ?? "{}") as Record<string, number>;
    return listBody([{ ...JOB_FULL, JobAdId: body["PageIndex"] + 1 }]);
  });
  const adapter = createZhiyeOfficialCareersAdapter(transport, {
    ...ADAPTER_OPTIONS,
    pageLimit: 9,
  });
  const jobs = await adapter.collect();
  assert.equal(transport.requests.length, 3);
  assert.equal(jobs.length, 3);
});

test("zhiye 透传 AbortSignal 给传输层", async () => {
  const controller = new AbortController();
  const transport = createTransport(() => listBody([JOB_FULL]));
  const adapter = createZhiyeOfficialCareersAdapter(transport, ADAPTER_OPTIONS);
  await adapter.collect(controller.signal);
  assert.equal(transport.requests[0]?.signal, controller.signal);
});

test("zhiye 已取消的 signal 不发起请求并抛 AbortError", async () => {
  const controller = new AbortController();
  controller.abort();
  const transport = createTransport(() => listBody([JOB_FULL]));
  const adapter = createZhiyeOfficialCareersAdapter(transport, ADAPTER_OPTIONS);
  await assert.rejects(
    () => adapter.collect(controller.signal),
    (error: unknown) => (error as Error).name === "AbortError",
  );
  assert.equal(transport.requests.length, 0);
});

test("zhiye 工厂优先使用注入定义，未登记 sourceKey 抛 ConfigError", () => {
  const transport = createTransport(() => listBody([JOB_FULL]));
  const adapter = createZhiyeOfficialCareersAdapter(transport, ADAPTER_OPTIONS);
  assert.equal(adapter.definition, DEFINITION);
  assert.throws(
    () =>
      createZhiyeOfficialCareersAdapter(transport, {
        tenant: "iflytek",
        sourceKey: "zhiye-unregistered-source",
        companyName: "科大讯飞",
      }),
    ConfigError,
  );
});

test("zhiye 空 Data 经适配器抛 EmptyResultError 并携带 sourceKey", async () => {
  const transport = createTransport(() => listBody([]));
  const adapter = createZhiyeOfficialCareersAdapter(transport, ADAPTER_OPTIONS);
  await assert.rejects(
    () => adapter.collect(),
    (error: unknown) => error instanceof EmptyResultError && error.sourceKey === SOURCE,
  );
});

test("zhiye 缺职责与要求的条目经适配器抛 ParseFailedError，不产出空正文岗位", async () => {
  const transport = createTransport(() => listBody([{ ...JOB_FULL, Duty: null, Require: null }]));
  const adapter = createZhiyeOfficialCareersAdapter(transport, ADAPTER_OPTIONS);
  await assert.rejects(
    () => adapter.collect(),
    (error: unknown) => error instanceof ParseFailedError && error.sourceKey === SOURCE,
  );
});

test("zhiye 结构变更经适配器抛携带 sourceKey 的 SchemaChangedError", async () => {
  const transport = createTransport(() => JSON.stringify({ Code: 200, Data: { list: [] } }));
  const adapter = createZhiyeOfficialCareersAdapter(transport, ADAPTER_OPTIONS);
  await assert.rejects(
    () => adapter.collect(),
    (error: unknown) => error instanceof SchemaChangedError && error.sourceKey === SOURCE,
  );
});