// 就业日报推送（P1-8，默认关闭）：payload 走引擎的飞书自定义机器人 webhook（notify/feishu.sendWebhook），
// 开关关着时不发请求、没配 webhook 时只 log 不报错，发送失败要抛错让 job_runs 看见。
// 全部用 fake fetch 与注入的摘要，不连库、不访问外部服务。
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
  CAREER_PUSH_PATHS,
  careerPushDailySchedule,
  careerPushEnabled,
  careerPushWebhook,
  formatCareerPushText,
  runCareerPushDaily,
  type CareerPushSummary,
} from "../modules/career-insights/backend/notify.ts";

const WEBHOOK = "https://open.feishu.cn/open-apis/bot/v2/hook/test-career-push";
const SITE = "https://example.test/";

function summary(overrides: Partial<CareerPushSummary> = {}): CareerPushSummary {
  return {
    date: "2026-11-21",
    new_jobs: 34,
    new_policies: 2,
    sample_size: 188,
    headlines: [{ title: "关于促进人工智能就业的通知", from: "国家发展和改革委员会" }],
    directions: [{ label: "AI 算法", count: 12 }],
    titles: [{ title: "大模型算法工程师", count: 4 }],
    ...overrides,
  };
}

interface SentRequest { url: string; message: Record<string, unknown> }

/** 假 fetch：记录每次请求，按 respond 决定回答；返回 Response 的最小形状。 */
function fakeFetch(respond: (hit: number) => { status?: number; body?: string } = () => ({ status: 200, body: '{"code":0}' })) {
  const sent: SentRequest[] = [];
  const original = globalThis.fetch;
  let hits = 0;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    hits += 1;
    sent.push({ url: String(input), message: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
    const answer = respond(hits);
    return {
      ok: (answer.status ?? 200) >= 200 && (answer.status ?? 200) < 300,
      status: answer.status ?? 200,
      text: async () => answer.body ?? "",
    } as unknown as Response;
  }) as typeof fetch;
  return { sent, restore: () => (globalThis.fetch = original) };
}

const env = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({ ...extra });
const logs: string[] = [];
const log = (line: string) => logs.push(line);

afterEach(() => {
  logs.length = 0;
});

test("开启且配了 webhook：发一条飞书文本消息，payload 含日期/新增岗位/政策/要闻与站内链接", async () => {
  const fake = fakeFetch();
  try {
    const result = await runCareerPushDaily({
      env: env({ CAREER_PUSH_ENABLED: "true", CAREER_PUSH_WEBHOOK_URL: WEBHOOK }),
      now: new Date("2026-11-21T06:30:00+08:00"),
      siteUrl: SITE,
      load: async () => summary(),
      log,
    });

    assert.equal(fake.sent.length, 1, "只发一条消息");
    const request = fake.sent[0]!;
    assert.equal(request.url, WEBHOOK);
    assert.equal(request.message.msg_type, "text");
    const text = String((request.message.content as { text?: unknown }).text ?? "");
    for (const expected of [
      "2026-11-21",
      "北京",
      "新增岗位 34 个",
      "新增政策 2 条",
      "当日样本 188 个岗位",
      "关于促进人工智能就业的通知",
      "国家发展和改革委员会",
      "AI 算法 12 个岗位",
      "大模型算法工程师 4 个岗位",
      `${SITE.replace(/\/+$/, "")}${CAREER_PUSH_PATHS.daily}`,
      `${SITE.replace(/\/+$/, "")}${CAREER_PUSH_PATHS.insights}`,
      `${SITE.replace(/\/+$/, "")}${CAREER_PUSH_PATHS.jobs}`,
      `${SITE.replace(/\/+$/, "")}${CAREER_PUSH_PATHS.policies}`,
    ]) {
      assert.ok(text.includes(expected), `消息里应包含：${expected}`);
    }
    assert.deepEqual(result, {
      ok: true,
      skipped: false,
      date: "2026-11-21",
      new_jobs: 34,
      new_policies: 2,
      webhook_status: "sent",
      bytes: Buffer.byteLength(text),
    });
  } finally {
    fake.restore();
  }
});

test("默认关闭：CAREER_PUSH_ENABLED 不是 true 时不发请求，只记一条日志，不报错", async () => {
  const fake = fakeFetch();
  try {
    for (const value of [undefined, "", "false", "1", "TRUE"]) {
      const result = await runCareerPushDaily({
        env: env(value === undefined ? {} : { CAREER_PUSH_ENABLED: value, CAREER_PUSH_WEBHOOK_URL: WEBHOOK }),
        load: async () => {
          throw new Error("关闭时不应读库");
        },
        log,
      });
      assert.equal(result.ok, true);
      assert.equal(result.skipped, true);
      assert.equal(result.reason, "disabled");
    }
    assert.equal(fake.sent.length, 0, "关闭时一个请求都不发");
    assert.equal(logs.length, 5, "每次只记一条日志");
    assert.match(logs[0]!, /CAREER_PUSH_ENABLED is off/);
  } finally {
    fake.restore();
  }
});

test("开着但没配 webhook：只 log 不报错，不发请求", async () => {
  const fake = fakeFetch();
  try {
    const result = await runCareerPushDaily({
      env: env({ CAREER_PUSH_ENABLED: "true" }),
      load: async () => {
        throw new Error("没配 webhook 时不应读库");
      },
      log,
    });
    assert.equal(result.ok, true);
    assert.equal(result.skipped, true);
    assert.equal(result.reason, "no_webhook");
    assert.equal(fake.sent.length, 0);
    assert.match(logs[0]!, /CAREER_PUSH_WEBHOOK_URL is empty/);
  } finally {
    fake.restore();
  }
});

test("发送失败（HTTP 非 2xx / 机器人未确认）抛错，让 job_runs 记下失败", async () => {
  for (const respond of [
    () => ({ status: 500, body: "upstream exploded" }),
    () => ({ status: 200, body: '{"code":19001,"msg":"invalid webhook"}' }),
    () => ({ status: 200, body: "<html>proxy error</html>" }),
  ]) {
    const fake = fakeFetch(respond);
    try {
      await assert.rejects(
        runCareerPushDaily({
          env: env({ CAREER_PUSH_ENABLED: "true", CAREER_PUSH_WEBHOOK_URL: WEBHOOK }),
          siteUrl: SITE,
          load: async () => summary(),
          log,
        }),
        /就业日报推送失败/,
      );
    } finally {
      fake.restore();
    }
  }
});

test("摘要为空时也发一条诚实的「今日暂无新增」，链接照常", async () => {
  const fake = fakeFetch();
  try {
    await runCareerPushDaily({
      env: env({ CAREER_PUSH_ENABLED: "true", CAREER_PUSH_WEBHOOK_URL: WEBHOOK }),
      siteUrl: SITE,
      load: async () => summary({ new_jobs: 0, new_policies: 0, sample_size: 0, headlines: [], directions: [], titles: [] }),
      log,
    });
    const text = String((fake.sent[0]!.message.content as { text: string }).text);
    assert.match(text, /今日新增岗位 0 个 · 新增政策 0 条/);
    assert.match(text, /今日暂无新增岗位与政策/);
    assert.ok(text.includes("https://example.test/daily"), "站内链接用 SITE_URL + 路径");
    assert.ok(!text.includes("example.test//daily"), "根地址末尾的斜杠不能带到链接里");
  } finally {
    fake.restore();
  }
});

test("开关与环境变量解析只认 true；站内链接去掉根地址末尾斜杠", () => {
  assert.equal(careerPushEnabled({ CAREER_PUSH_ENABLED: "true" }), true);
  for (const value of [undefined, "", "false", "1", "yes"]) assert.equal(careerPushEnabled({ CAREER_PUSH_ENABLED: value as string }), false);
  assert.equal(careerPushWebhook({}) , null);
  assert.equal(careerPushWebhook({ CAREER_PUSH_WEBHOOK_URL: "  " }), null);
  assert.equal(careerPushWebhook({ CAREER_PUSH_WEBHOOK_URL: WEBHOOK }), WEBHOOK);
  const text = formatCareerPushText(summary(), "https://example.test///");
  assert.ok(text.includes("https://example.test/daily"));
  assert.ok(!text.includes("example.test//daily"));
});

test("能力对象：career.push-daily 到点执行注入的 deps（开关在 run 内部判断）", async () => {
  const fake = fakeFetch();
  try {
    const schedule = careerPushDailySchedule({
      env: env({ CAREER_PUSH_ENABLED: "true", CAREER_PUSH_WEBHOOK_URL: WEBHOOK }),
      now: new Date("2026-11-21T06:30:00+08:00"),
      siteUrl: SITE,
      load: async () => summary(),
      log,
    });
    assert.equal(schedule.name, "career.push-daily");
    assert.equal(schedule.cron, "30 6 * * *");
    assert.equal(schedule.missed, "once");
    const result = await schedule.run();
    assert.deepEqual(result, {
      ok: true,
      skipped: false,
      date: "2026-11-21",
      new_jobs: 34,
      new_policies: 2,
      webhook_status: "sent",
      bytes: Buffer.byteLength(String((fake.sent[0]!.message.content as { text: string }).text)),
    });
  } finally {
    fake.restore();
  }
});