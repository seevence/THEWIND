// P1-4 清退空转 cron：worker 只注册有数据/仍需要的定时任务。这里守引擎侧最终注册的清单
// （apps/worker/src/schedules.ts 的 ENGINE_SCHEDULES），以及 P1-8 就业日报推送能力对象的形状。
// 用 *.standalone.test.ts：只读常量，不连库、不发请求。
import assert from "node:assert/strict";
import { test } from "node:test";
import { ENGINE_SCHEDULES } from "../apps/worker/src/schedules.ts";
import {
  CAREER_PUSH_CRON,
  CAREER_PUSH_SCHEDULE,
  careerPushDailySchedule,
} from "../modules/career-insights/backend/notify.ts";

/** 2026-11-21 在 0 文章数据上空转、已从 schedules 移除的引擎任务（页面路由保留）。 */
const RETIRED = [
  "content.sweep",
  "content.translate",
  "hot.rank",
  "hot.snapshot",
  "stories.links",
  "reports.compose",
  "reports.source-health",
];
/** 清退后仍要跑的每日/清理/运维任务（不含随采集开关增减的 sources.*）。 */
const KEPT = [
  "ops.retention",
  "seo.indexnow",
  "seo.baidu-push",
  "ops.recover",
  "ops.alerts",
  "ops.digest",
  "feedback.forward",
];

test("空转 cron 已从 worker 注册表移除，日志/清理/推送类仍在", () => {
  const names = ENGINE_SCHEDULES.map((schedule) => schedule.name);
  for (const name of RETIRED) assert.ok(!names.includes(name), `${name} 不应再注册`);
  for (const name of KEPT) assert.ok(names.includes(name), `${name} 仍需要注册`);
  assert.equal(new Set(names).size, names.length, "schedule 名不能重复");
});

test("每条引擎 schedule 的 cron 都是 5 段，run 是函数", () => {
  for (const schedule of ENGINE_SCHEDULES) {
    assert.equal(schedule.cron.trim().split(/\s+/).length, 5, `${schedule.name} 的 cron 应为 5 段`);
    assert.equal(typeof schedule.run, "function", `${schedule.name} 需要 run`);
    assert.match(schedule.name, /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/, "schedule 名用小写点分");
  }
});

test("采集开着时才注册抓取类任务（sources.*），关着时一个都没有", () => {
  const names = ENGINE_SCHEDULES.map((schedule) => schedule.name);
  const sourceSchedules = names.filter((name) => name.startsWith("sources."));
  if (process.env.COLLECT_ENABLED === "true") {
    for (const name of ["sources.schedule", "sources.adapt-intervals", "sources.x-renames", "sources.icons"]) {
      assert.ok(sourceSchedules.includes(name), `采集开着时应注册 ${name}`);
    }
  } else {
    assert.deepEqual(sourceSchedules, [], "采集关着时不注册 sources.*");
  }
});

test("career.push-daily 能力对象：06:30 Asia/Shanghai、漏跑只补一次、run 在内部再判开关", () => {
  const schedule = careerPushDailySchedule();
  assert.equal(schedule.name, CAREER_PUSH_SCHEDULE);
  assert.equal(schedule.name, "career.push-daily");
  assert.equal(schedule.cron, CAREER_PUSH_CRON);
  assert.equal(schedule.cron, "30 6 * * *");
  assert.equal(schedule.missed, "once");
  assert.equal(typeof schedule.run, "function");
  assert.ok(!ENGINE_SCHEDULES.some((entry) => entry.name === schedule.name), "career 任务由模块 schedules 注册，不进引擎清单");
});
