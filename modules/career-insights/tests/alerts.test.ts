// career.ingest 的告警进入 ops.alerts：整体失败与部分来源失败都要有人知道，重复提醒沿用
// ops.alerts 的既有节流（同一 key 一天一次），恢复由它自己发。这里用关闭的内部通道当 fake notifier：
// sendAlert 只记录、不发外网。
// 另外两类「最近一行看起来健康」的情况同样要告警：进程中断被补记为 skipped 的运行，以及超过 26 小时
// 没有成功运行（含完全没有成功记录），后者用 career.ingest.stale 自己的 key。
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { beijingAt } from "@aihot/contracts/time";
import { closeDb, sql } from "@aihot/backend/db";
import { getBoss, stopBoss } from "@aihot/backend/jobs/queue";
import { installModules } from "@aihot/backend/modules";
import { formatAlert } from "@aihot/backend/notify/feishu";
import { checkAlerts } from "@aihot/backend/operations/alerts";
import { CAREER_INGEST_JOB, CAREER_INGEST_STALE_KEY, careerIngestAlerts } from "../backend/alerts.ts";
import server from "../server.ts";

const NOW = beijingAt("2026-11-19", "06:10").getTime();
const career = (keys: string[]) => keys.filter((key) => key.startsWith(CAREER_INGEST_JOB));

function run(status: "ok" | "failed" | "skipped", detail: unknown, startedAt = new Date(NOW), error: string | null = null) {
  return sql`INSERT INTO job_runs (job, started_at, finished_at, status, detail, error)
    VALUES (${CAREER_INGEST_JOB}, ${startedAt}, ${startedAt}, ${status}, ${sql.json(detail as never)}, ${error})`;
}

before(async () => {
  Object.assign(process.env, { COLLECT_ENABLED: "false", MODEL_CALLS_ENABLED: "false", FEISHU_INTERNAL_ENABLED: "false" });
  installModules([server]);
  await getBoss();
});
beforeEach(async () => {
  await sql`DELETE FROM job_runs WHERE job = ${CAREER_INGEST_JOB}`;
  await sql`DELETE FROM settings WHERE key IN ('alerts.state', 'alerts.returns')`;
});
after(async () => {
  await stopBoss();
  await closeDb();
});

test("failedSources 非空：发出告警，正文含 job、来源、北京时间与 /admin/runs", async () => {
  await run("ok", { rejected: 0, failedSources: ["career-dji", "career-baidu"] });

  const [finding] = await careerIngestAlerts(NOW);
  assert.ok(finding, "最近一次运行有失败来源");
  assert.equal(finding.key, CAREER_INGEST_JOB);
  const text = [finding.title, finding.impact, finding.action, finding.detail].join("\n");
  assert.match(text, /career\.ingest/);
  assert.match(text, /career-dji/);
  assert.match(text, /career-baidu/);
  assert.match(text, /11月19日 06:10/, "时间按北京时间显示");
  assert.match(text, /可在 \/admin\/runs 查看/);

  const msg = formatAlert(finding, finding.since!, NOW);
  assert.match(msg.title, /职位数据采集/);
  assert.match(msg.lines.join("\n"), /career-dji、career-baidu/);

  assert.deepEqual(career((await checkAlerts(NOW)).sent), [CAREER_INGEST_JOB]);
  assert.deepEqual(career((await checkAlerts(NOW + 60 * 60_000)).sent), [], "同一失败一小时内不重复");
});

test("failedSources 为空：不告警", async () => {
  await run("ok", { rejected: 0, failedSources: [] });
  assert.deepEqual(await careerIngestAlerts(NOW), []);
  assert.deepEqual(career((await checkAlerts(NOW)).sent), []);
});

test("整体抛错（status=failed）：同样告警并带上错误", async () => {
  await run("failed", { owner: "worker" }, new Date(NOW), "fetch failed: ECONNRESET");
  const [finding] = await careerIngestAlerts(NOW);
  assert.ok(finding);
  assert.match(finding.impact!, /ECONNRESET/);
  assert.deepEqual(career((await checkAlerts(NOW)).sent), [CAREER_INGEST_JOB]);
});

test("skipped 带进程中断标记：告警说明上一次采集被中断", async () => {
  await run("skipped", { owner: { host: "test", platform: "linux", pid: 1, birth: "x" } }, new Date(NOW),
    "执行进程已退出，未记录完成；仅结束运行记录，不重跑业务");

  const [finding] = await careerIngestAlerts(NOW);
  assert.ok(finding, "被补记为 skipped 的中断运行也要告警");
  assert.equal(finding.key, CAREER_INGEST_JOB);
  assert.equal(finding.level, "today");
  assert.match(finding.impact!, /上一次采集被中断/);
  assert.match(finding.impact!, /11月19日 06:10/, "时间按北京时间显示");
  assert.match(finding.detail!, /执行进程已退出/);
  assert.deepEqual(career((await checkAlerts(NOW)).sent), [CAREER_INGEST_JOB]);
});

test("skipped 只是预算暂停：不告警", async () => {
  await run("ok", { rejected: 0, failedSources: [] }, new Date(NOW - 24 * 3600_000));
  await run("skipped", { owner: { host: "test", platform: "linux", pid: 1, birth: "x" } }, new Date(NOW),
    "Budget for llm exhausted (per day)");

  assert.deepEqual(await careerIngestAlerts(NOW), []);
  assert.deepEqual(career((await checkAlerts(NOW)).sent), []);
});

test("最近一次成功 27 小时前：告警，新的成功运行发出恢复", async () => {
  await run("ok", { rejected: 0, failedSources: [] }, new Date(NOW - 27 * 3600_000));

  const [finding] = await careerIngestAlerts(NOW);
  assert.ok(finding, "超过 26 小时没有成功运行就算停摆");
  assert.equal(finding.key, CAREER_INGEST_STALE_KEY);
  assert.equal(finding.key, "career.ingest.stale");
  assert.equal(finding.level, "today");
  assert.match(finding.impact!, /最近一次成功采集：11月18日 03:10，已超过 26 小时/);
  assert.deepEqual(career((await checkAlerts(NOW)).sent), [CAREER_INGEST_STALE_KEY]);

  await run("ok", { failedSources: [] }, new Date(NOW + 60_000));
  assert.deepEqual(career((await checkAlerts(NOW + 120_000)).sent), [`${CAREER_INGEST_STALE_KEY}:recovered`]);
});

test("最近一次成功 25 小时前：不告警", async () => {
  await run("ok", { failedSources: [] }, new Date(NOW - 25 * 3600_000));
  assert.deepEqual(await careerIngestAlerts(NOW), []);
  assert.deepEqual(career((await checkAlerts(NOW)).sent), []);
});

test("没有成功记录：告警", async () => {
  const [finding] = await careerIngestAlerts(NOW);
  assert.ok(finding, "一次都没成功过也要有人知道");
  assert.equal(finding.key, CAREER_INGEST_STALE_KEY);
  assert.match(finding.impact!, /还没有成功的采集记录/);
  assert.deepEqual(career((await checkAlerts(NOW)).sent), [CAREER_INGEST_STALE_KEY]);
});

test("下一次成功运行结束告警", async () => {
  await run("ok", { failedSources: ["career-dji"] });
  assert.deepEqual(career((await checkAlerts(NOW)).sent), [CAREER_INGEST_JOB]);

  await run("ok", { failedSources: [] }, new Date(NOW + 24 * 3600_000));
  assert.deepEqual(career((await checkAlerts(NOW + 24 * 3600_000 + 60_000)).sent), [`${CAREER_INGEST_JOB}:recovered`]);
});