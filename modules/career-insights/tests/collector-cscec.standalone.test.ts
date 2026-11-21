import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  CSCEC_COLLECTOR_VERSION,
  CSCEC_LIST_URL,
  CSCEC_SOURCE_DEFINITION,
  createCscecOfficialCareersAdapter,
  parseCscecAnnouncement,
  parseCscecList,
  parseCscecPositions,
  parseCscecPublishedDate,
  resolveCscecCompanyName,
  toCscecRawJobs,
} from "../collector/adapters/cscec-official-careers.ts";
import { SampleStore } from "../collector/evidence/sample-store.ts";
import { containsPersonalData } from "../collector/evidence/sanitizer.ts";
import { SchemaChangedError } from "../collector/fetch/errors.ts";
import { ReplayTransport } from "../collector/fetch/replay-transport.ts";
import type { FetchTransport, PageRequest, TransportResponse } from "../collector/fetch/transport.ts";
import { validateCollectedJobs } from "../collector/orchestration/runner.ts";
import { validateRawCollectedJob } from "../collector/validate.ts";

const SAMPLES = join(dirname(fileURLToPath(import.meta.url)), "../collector/evidence/samples");
const SOURCE = "cscec-official-careers";
const SAMPLES_DIR = join(SAMPLES, SOURCE, "samples");
const DETAIL_URL_3966090 = "https://www.cscec.com/rlzy_new/rczp/jtzbzp/202611/3966090.html";
const DETAIL_URL_3959432 = "https://www.cscec.com/rlzy_new/rczp/ssqyzp/202609/3959432.html";
const DETAIL_URL_3957584 = "https://www.cscec.com/rlzy_new/rczp/jtzbzp/202608/3957584.html";
const DETAIL_URL_3956711 = "https://www.cscec.com/rlzy_new/rczp/jtzbzp/202608/3956711.html";
const DETAIL_URL_3949661 = "https://www.cscec.com/rlzy_new/rczp/ssqyzp/202606/3949661.html";
const DETAIL_URL_3955141 = "https://www.cscec.com/rlzy_new/rczp/ssqyzp/202608/3955141.html";
const ADAPTER_OPTIONS = {
  definition: CSCEC_SOURCE_DEFINITION,
  sleep: async () => {},
  now: () => "2026-11-21T12:00:00.000Z",
};

async function readSample(name: string): Promise<string> {
  return readFile(join(SAMPLES_DIR, name), "utf8");
}

async function replaySamples(): Promise<ReplayTransport> {
  const store = new SampleStore(SAMPLES);
  const entries = (await readdir(SAMPLES_DIR)).filter(
    (name) => name.endsWith(".html") && !name.endsWith(".meta.json"),
  );
  const samples = [];
  for (const entry of entries) {
    const record = await store.load(SOURCE + "/samples/" + entry);
    samples.push({
      request_key: record.meta.request_key,
      captured_at: record.meta.captured_at,
      status: record.meta.http_status,
      request_url: record.meta.request_url,
      final_url: record.meta.final_url,
      content_type: record.meta.content_type,
      headers: {},
      body: record.body,
    });
  }
  return new ReplayTransport(samples);
}

function responseFor(request: PageRequest, body: Buffer): TransportResponse {
  return {
    status: 200,
    requestUrl: request.url,
    finalUrl: request.url,
    contentType: "text/html",
    headers: { "content-type": "text/html" },
    body,
    fetchedAt: "2026-11-21T12:00:00.000Z",
  };
}

function buildAnnouncementHtml(input: {
  title: string;
  date: string;
  paragraphs: readonly string[];
}): string {
  const body = input.paragraphs.map((paragraph) => "<p>" + paragraph + "</p>").join("");
  return (
    "<!doctype html><html><body><div class=\"container mainbox_csj\">" +
    "<h2 class=\"gsywtpc\">" +
    input.title +
    "</h2><dl><dt><span class=\"fbdate\">发布日期：" +
    input.date +
    "</span></dt></dl><div id=\"gsxwxq\">" +
    body +
    "</div></div></body></html>"
  );
}

test("中国建筑栏目真实样本解析出 71 条公告，日期齐全且链接唯一", async () => {
  const items = parseCscecList(await readSample("list.html"), CSCEC_LIST_URL);
  assert.equal(items.length, 71);
  assert.ok(items.every((item) => item.publishedAt !== null));
  assert.equal(new Set(items.map((item) => item.url)).size, 71);
  const newest = items[0];
  assert.ok(newest !== undefined);
  assert.equal(newest.publishedAt, "2026-11-04T00:00:00.000Z");
  assert.ok(newest.title.includes("中国建筑股份有限公司岗位招聘公告"));
  assert.ok(newest.url.startsWith("https://www.cscec.com/rlzy_new/rczp/"));
});

test("发布日期支持短横线与中文年月日，非法值返回 null", () => {
  assert.equal(parseCscecPublishedDate("发布日期：2026-08-31"), "2026-08-31T00:00:00.000Z");
  assert.equal(parseCscecPublishedDate("2026年11月4日"), "2026-11-04T00:00:00.000Z");
  assert.equal(parseCscecPublishedDate("2026-11-04中国建筑"), "2026-11-04T00:00:00.000Z");
  assert.equal(parseCscecPublishedDate("昨天"), null);
  assert.equal(parseCscecPublishedDate(null), null);
});

test("林芝总部公告真实样本解析出 3 个岗位，公司名与发布日期保真", async () => {
  const announcement = parseCscecAnnouncement(
    await readSample("detail-3966090.html"),
    DETAIL_URL_3966090,
  );
  assert.equal(announcement.title, "中国建筑股份有限公司岗位招聘公告【中国建筑（林芝）总部】");
  assert.equal(announcement.companyName, "中国建筑股份有限公司");
  assert.equal(announcement.publishedAt, "2026-11-04T00:00:00.000Z");
  assert.ok(announcement.body.length > 300);
  assert.equal(announcement.bodyHasPersonalData, false);
  assert.deepEqual(
    announcement.positions.map((position) => position.title),
    ["安全生产监督管理岗", "履约管理岗", "行政办公岗"],
  );
  assert.equal(new Set(announcement.positions.map((position) => position.unit)).size, 1);
  assert.deepEqual(
    announcement.positions.map((position) => position.headcount),
    ["2", "2", "1"],
  );

  const jobs = toCscecRawJobs(announcement, "2026-11-21T12:00:00.000Z");
  assert.equal(jobs.length, 3);
  assert.deepEqual(
    jobs.map((job) => job.source_job_id),
    ["3966090:1", "3966090:2", "3966090:3"],
  );
  assert.equal(validateCollectedJobs(jobs).valid.length, 3);
});

test("中建中东公告真实样本解析出 29 个岗位并带单位与工作地点", async () => {
  const announcement = parseCscecAnnouncement(
    await readSample("detail-3959432.html"),
    DETAIL_URL_3959432,
  );
  assert.equal(announcement.companyName, "中建中东有限责任公司");
  assert.equal(announcement.positions.length, 29);
  const units = new Set(announcement.positions.map((position) => position.unit));
  assert.deepEqual(
    [...units].sort(),
    ["中建中东公司基础设施分公司", "中建中东公司直营项目", "中建中东公司总部"].sort(),
  );
  const locations = new Set(announcement.positions.flatMap((position) => position.locations));
  assert.ok(locations.has("阿联酋"));
  assert.ok(locations.has("科威特"));
  const finance = announcement.positions.find((position) => position.title === "财务管理岗");
  assert.ok(finance !== undefined);
  assert.equal(finance.unit, "中建中东公司总部");
  assert.equal(finance.headcount, "2");

  const jobs = toCscecRawJobs(announcement, "2026-11-21T12:00:00.000Z");
  assert.equal(validateCollectedJobs(jobs).valid.length, 29);
  assert.ok(jobs.every((job) => job.hints?.employment_type === "experienced"));
  assert.ok(jobs.every((job) => job.company_name === "中建中东有限责任公司"));
});

test("招聘岗位段落的不同真实写法都能解析", () => {
  const positions = parseCscecPositions([
    "二、招聘岗位",
    "中建中东公司总部（工作地点：阿联酋/科威特）",
    "财务管理岗（若干）",
    "深基坑支护设计工程师（岩土及地下工程）（1个）",
    "中建资本控股有限公司所属单位投融资岗2人（北京）、供金业务岗1人（北京）。",
    "商务岗2人（北京1人，深圳1人），业务承做岗1人（北京）。",
    "三、招聘基本条件",
    "1.思想政治素质过硬；",
  ]);
  const titles = positions.map((position) => position.title);
  assert.ok(titles.includes("财务管理岗"));
  assert.ok(titles.includes("深基坑支护设计工程师（岩土及地下工程）"));
  assert.ok(titles.includes("投融资岗（北京）"));
  assert.ok(titles.includes("供金业务岗（北京）"));
  assert.ok(titles.includes("商务岗（北京，深圳）"));
  assert.ok(titles.includes("业务承做岗（北京）"));
  assert.equal(positions.length, 6);

  // 没有「招聘岗位」小节时返回空数组，由调用方按空结果处理，不编造岗位。
  assert.deepEqual(parseCscecPositions(["一、公司介绍", "中建资本成立于 2015 年。"]), []);
});

test("公告标题映射招聘单位名", () => {
  assert.equal(
    resolveCscecCompanyName("中国建筑股份有限公司岗位招聘公告（海外部）"),
    "中国建筑股份有限公司",
  );
  assert.equal(
    resolveCscecCompanyName("中国建筑股份有限公司岗位招聘公告【中国建筑（林芝）总部】"),
    "中国建筑股份有限公司",
  );
  assert.equal(resolveCscecCompanyName("中建中东有限责任公司招聘公告"), "中建中东有限责任公司");
  assert.equal(
    resolveCscecCompanyName("中国建筑（南洋）发展有限公司招聘公告"),
    "中国建筑（南洋）发展有限公司",
  );
  assert.equal(
    resolveCscecCompanyName("中国建筑装饰集团有限公司公开竞聘公告"),
    "中国建筑装饰集团有限公司",
  );
  assert.equal(resolveCscecCompanyName("招聘公告"), "中国建筑");
});

test("最新 4 条公告回放产出 34 条合法原始职位，且零网络请求", async () => {
  const adapter = createCscecOfficialCareersAdapter(await replaySamples(), {
    ...ADAPTER_OPTIONS,
    itemLimit: 4,
  });
  const jobs = await adapter.collect();
  assert.equal(jobs.length, 34);
  const report = validateCollectedJobs(jobs);
  assert.equal(report.invalid.length, 0, JSON.stringify(report.invalid.slice(0, 2)));
  assert.equal(report.valid.length, 34);
  assert.ok(jobs.every((job) => job.source_key === SOURCE));
  assert.ok(jobs.every((job) => job.collector_version === CSCEC_COLLECTOR_VERSION));
  assert.ok(jobs.every((job) => job.published_at !== null));
  assert.ok(jobs.every((job) => job.raw_text.length > 100));
  assert.ok(jobs.every((job) => job.official_url.startsWith("https://www.cscec.com/rlzy_new/rczp/")));
  assert.equal(new Set(jobs.map((job) => job.source_job_id)).size, 34);
  assert.equal(jobs[0]?.company_name, "中国建筑股份有限公司");
  assert.equal(jobs[0]?.title, "安全生产监督管理岗");

  // 同一公告的多个岗位共享公告正文与详情链接，但 source_job_id 不同，内容哈希不会互撞。
  const lhasa = jobs.filter((job) => (job.source_job_id ?? "").startsWith("3966090:"));
  assert.equal(lhasa.length, 3);
  assert.equal(new Set(lhasa.map((job) => job.raw_text)).size, 1);
  assert.equal(new Set(lhasa.map((job) => job.official_url)).size, 1);
});

test("回放按发布日期从新到旧取公告，itemLimit=1 时只请求列表与最新一份详情", async () => {
  const replay = await replaySamples();
  const calls: PageRequest[] = [];
  const tracking: FetchTransport = {
    async fetchPage(request) {
      calls.push(request);
      return replay.fetchPage(request);
    },
  };
  const sleeps: number[] = [];
  const adapter = createCscecOfficialCareersAdapter(tracking, {
    ...ADAPTER_OPTIONS,
    itemLimit: 1,
    sleep: async (ms: number) => {
      sleeps.push(ms);
    },
  });
  const jobs = await adapter.collect();
  assert.equal(jobs.length, 3);
  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.url, CSCEC_LIST_URL);
  assert.equal(calls[0]?.method, "GET");
  assert.equal(calls[1]?.url, DETAIL_URL_3966090);
  assert.equal(calls[1]?.method, "GET");
  assert.equal(calls[1]?.headers["referer"], CSCEC_LIST_URL);
  assert.deepEqual(sleeps, [1000]);
});

test("itemLimit 超过上限时按 10 条公告截断并逐条限速", async () => {
  const listBody = await readFile(join(SAMPLES_DIR, "list.html"));
  const detailBody = await readFile(join(SAMPLES_DIR, "detail-3966090.html"));
  const calls: PageRequest[] = [];
  const sleeps: number[] = [];
  const transport: FetchTransport = {
    async fetchPage(request) {
      calls.push(request);
      return responseFor(
        request,
        request.url === CSCEC_LIST_URL ? listBody : detailBody,
      );
    },
  };
  const adapter = createCscecOfficialCareersAdapter(transport, {
    ...ADAPTER_OPTIONS,
    itemLimit: 99,
    sleep: async (ms: number) => {
      sleeps.push(ms);
    },
  });
  const jobs = await adapter.collect();
  assert.equal(calls.length, 11);
  assert.equal(sleeps.length, 10);
  assert.deepEqual(sleeps, new Array(10).fill(1000));
  assert.equal(jobs.length, 30);
});

test("公告正文含个人联系方式时整条跳过，不产出职位也不报错", async () => {
  const store = new SampleStore(SAMPLES);
  const listBody = await readFile(join(SAMPLES_DIR, "list.html"));
  const detailBodies = new Map<string, Buffer>();
  for (const id of ["3966090", "3959432", "3957584", "3956711"]) {
    const record = await store.load(SOURCE + "/samples/detail-" + id + ".html");
    detailBodies.set(record.meta.request_url, record.body);
  }
  // 最新 5 条公告的第 5 条（资本控股 2026-08-12）正文含招聘邮箱；按纪律不保存该页样本，
  // 这里合成同等结构页面验证「整条跳过」分支。
  const piiHtml = Buffer.from(
    buildAnnouncementHtml({
      title: "中建资本控股有限公司招聘公告",
      date: "2026-08-12",
      paragraphs: [
        "二、招聘岗位",
        "投融资岗2人（北京）。",
        "六、具体事宜",
        "邮箱：hr@example.com",
      ],
    }),
  );
  const requests: string[] = [];
  const transport: FetchTransport = {
    async fetchPage(request) {
      requests.push(request.url);
      if (request.url === CSCEC_LIST_URL) {
        return responseFor(request, listBody);
      }
      if (request.url === DETAIL_URL_3955141) {
        return responseFor(request, piiHtml);
      }
      const body = detailBodies.get(request.url);
      assert.ok(body !== undefined, "未预期的详情请求：" + request.url);
      return responseFor(request, body as Buffer);
    },
  };
  const adapter = createCscecOfficialCareersAdapter(transport, {
    ...ADAPTER_OPTIONS,
    itemLimit: 5,
  });
  const jobs = await adapter.collect();
  assert.equal(requests.length, 6);
  assert.equal(jobs.length, 34);
  assert.ok(jobs.every((job) => job.company_name !== "中建资本控股有限公司"));
  assert.ok(jobs.every((job) => containsPersonalData(job.raw_text) === false));
  assert.equal(validateCollectedJobs(jobs).invalid.length, 0);
});

test("详情页缺少标题、正文或发布日期时抛 SchemaChangedError", () => {
  assert.throws(
    () =>
      parseCscecAnnouncement(
        "<html><body><div id=\"gsxwxq\"><p>一、招聘岗位</p></div></body></html>",
        DETAIL_URL_3966090,
      ),
    /缺少标题/,
  );
  assert.throws(
    () =>
      parseCscecAnnouncement(
        buildAnnouncementHtml({
          title: "中国建筑股份有限公司岗位招聘公告（海外部）",
          date: "2026-08-31",
          paragraphs: [],
        }),
        DETAIL_URL_3957584,
      ),
    /正文缺少段落/,
  );
  assert.throws(
    () =>
      parseCscecAnnouncement(
        "<html><body><h2 class=\"gsywtpc\">中国建筑股份有限公司招聘公告</h2><div id=\"gsxwxq\"><p>一、招聘岗位</p><p>外事管理岗</p></div></body></html>",
        DETAIL_URL_3957584,
      ),
    SchemaChangedError,
  );
});

test("采集被取消时抛 AbortError", async () => {
  const adapter = createCscecOfficialCareersAdapter(await replaySamples(), {
    ...ADAPTER_OPTIONS,
    itemLimit: 2,
  });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() => adapter.collect(controller.signal), { name: "AbortError" });
});

test("公告正文结构变化时抛 SchemaChangedError 而不是空成功", async () => {
  const store = new SampleStore(SAMPLES);
  const listRecord = await store.load(SOURCE + "/samples/list.html");
  const transport: FetchTransport = {
    async fetchPage(request) {
      const body =
        request.url === CSCEC_LIST_URL
          ? listRecord.body
          : Buffer.from("<html><body><h2 class=\"gsywtpc\">某招聘公告</h2></body></html>");
      return responseFor(request, body);
    },
  };
  const adapter = createCscecOfficialCareersAdapter(transport, {
    ...ADAPTER_OPTIONS,
    itemLimit: 1,
  });
  await assert.rejects(() => adapter.collect(), /正文缺少段落/);
});

test("样本元信息完整、哈希一致、已脱敏且正文不含个人联系方式", async () => {
  const entries = (await readdir(SAMPLES_DIR)).filter((name) => name.endsWith(".meta.json"));
  assert.equal(entries.length, 6, "1 份列表 + 5 份详情真实样本");
  const lists = entries.filter((name) => name.startsWith("list.html"));
  const details = entries.filter((name) => name.startsWith("detail-"));
  assert.ok(lists.length >= 1, "至少 1 份列表样本");
  assert.ok(details.length >= 4, "至少 4 份详情样本");
  for (const entry of entries) {
    const meta = JSON.parse(await readFile(join(SAMPLES_DIR, entry), "utf8")) as {
      sanitized: boolean;
      http_status: number;
      collector_version: string;
      request_key: string;
      body_file: string;
      body_sha256: string;
    };
    assert.equal(meta.sanitized, true, entry + " 应已脱敏");
    assert.equal(meta.http_status, 200, entry + " 应为 HTTP 200");
    assert.equal(meta.collector_version, CSCEC_COLLECTOR_VERSION);
    assert.ok(meta.request_key.startsWith("GET https://www.cscec.com/"));
    assert.equal(meta.body_file.startsWith(SOURCE + "/samples/"), true, entry + " body_file 应为源目录下相对路径");
    assert.equal(meta.body_file.includes(".."), false);
    const bodyFile = entry.replace(/\.meta\.json$/, "");
    const body = await readFile(join(SAMPLES_DIR, bodyFile));
    assert.equal(createHash("sha256").update(body).digest("hex"), meta.body_sha256);
    assert.equal(containsPersonalData(body.toString("utf8")), false, entry + " 正文不得含个人联系方式");
  }
});

test("样本详情回放合并出的职位逐条通过 RawCollectedJobV1 校验", async () => {
  const announcement = parseCscecAnnouncement(
    await readSample("detail-3949661.html"),
    DETAIL_URL_3949661,
  );
  assert.equal(announcement.positions.length, 23);
  const jobs = toCscecRawJobs(announcement, "2026-11-21T12:00:00.000Z");
  for (const job of jobs) {
    const result = validateRawCollectedJob(job);
    assert.equal(result.ok, true, JSON.stringify(result.ok ? {} : result.errors));
    assert.equal(job.source_key, SOURCE);
    assert.equal(job.hints?.employment_type, "experienced");
    assert.equal(job.hints?.role_family, "unknown");
  }
  assert.equal(new Set(jobs.map((job) => job.source_job_id)).size, 23);
});
