// Cron-style schedules (Asia/Shanghai), the engine's and then the site's modules'. Each run is recorded in
// job_runs; missed slots run once.
//
// Retired on 2026-11-21 (P1-4): content.sweep, content.translate, hot.rank, hot.snapshot, stories.links,
// reports.compose and reports.source-health ran over a site with no articles, so they only produced noise
// (reports.compose had failed 164 times). They are not registered any more; the engine functions stay for
// the admin pages and for tests, and registerSchedules below deletes their old cron.* queues on start. The
// pages they fed (/weekly, /monthly, /hot, ...) are unchanged.
import type { PgBoss } from "pg-boss";
import { ensureQueue, recordRun } from "@aihot/backend/jobs/queue";
import { serverModules, type Scheduled } from "@aihot/backend/modules";
import { adaptIntervals, scheduleDueSources } from "@aihot/backend/sources/collect";
import { scheduleMpReconcile } from "@aihot/backend/sources/mp";
import { followXRenames } from "@aihot/backend/sources/x-renames";
import { dajialaConfigured } from "@aihot/backend/providers/dajiala";
import { refreshSourceIcons } from "@aihot/backend/sources/icons";
import { dailyRetention } from "@aihot/backend/operations/retention";
import { submitIndexNow } from "@aihot/backend/operations/indexnow";
import { submitBaiduPush } from "@aihot/backend/operations/baidu-push";
import { checkAlerts, sendDigest } from "@aihot/backend/operations/alerts";
import { recoverStaleWork } from "@aihot/backend/operations/recover";
import { forwardPendingFeedback } from "@aihot/backend/operations/feedback";
import { backupConfigured, runBackup } from "@aihot/backend/operations/backup";

const collecting = process.env.COLLECT_ENABLED === "true";

/** The engine's schedules; exported so the worker's schedule tests can see exactly what it registers. */
export const ENGINE_SCHEDULES: Scheduled[] = [
  // The deletions the privacy notice promises, once their retention periods are over.
  { name: "ops.retention", cron: "30 3 * * *", missed: "once", run: () => dailyRetention() },
  // IndexNow for added, changed and removed discovery URLs, hourly so a new story or report reaches Bing,
  // and the AI answers that search it, within the hour (off unless INDEXNOW_SUBMIT_ENABLED).
  { name: "seo.indexnow", cron: "50 * * * *", missed: "once", run: () => submitIndexNow() },
  // Baidu's push for URLs new since the last run, within its daily quota (off unless BAIDU_PUSH_ENABLED).
  { name: "seo.baidu-push", cron: "55 * * * *", missed: "once", run: () => submitBaiduPush() },
  // Work a stopped process left half way becomes visible, and unknown paid requests get their one
  // automatic release; ops.alerts runs in parallel and sees the result by its next run at the latest.
  { name: "ops.recover", cron: "*/10 * * * *", run: () => recoverStaleWork() },
  { name: "ops.alerts", cron: "*/10 * * * *", run: () => checkAlerts() },
  // One message with other follow-ups and their actual impact (nothing when there are none).
  { name: "ops.digest", cron: "0 9 * * *", missed: "once", run: () => sendDigest() },
  // Feedback that did not reach the internal Feishu chat when it was sent (off with FEISHU_INTERNAL_ENABLED).
  { name: "feedback.forward", cron: "*/10 * * * *", run: () => forwardPendingFeedback() },
  ...(backupConfigured() ? [{ name: "ops.backup", cron: "10 4 * * *", missed: "once" as const, run: () => runBackup() }] : []),
  ...(collecting
    ? [
        { name: "sources.schedule", cron: "* * * * *", run: () => scheduleDueSources() },
        { name: "sources.adapt-intervals", cron: "20 4 * * *", missed: "once" as const, run: adaptIntervals },
        // X accounts quiet for a day: a renamed one is followed to its new handle (SocialData, paid per lookup).
        { name: "sources.x-renames", cron: "50 4 * * *", missed: "once" as const, run: () => followXRenames() },
        // Icons are read from the sources' own sites, so they stop with collection.
        { name: "sources.icons", cron: "40 4 * * *", missed: "once" as const, run: () => refreshSourceIcons() },
      ]
    : []),
  // WeChat official accounts through Dajiala (paid), each once per its interval; only with its key.
  ...(collecting && dajialaConfigured() ? [{ name: "sources.mp-reconcile", cron: "*/15 * * * *", run: () => scheduleMpReconcile() }] : []),
];

export async function registerSchedules(boss: PgBoss) {
  const schedules = [...ENGINE_SCHEDULES, ...serverModules().flatMap((m) => m.schedules ?? [])].filter((s) => s.when?.() ?? true);
  for (const s of schedules) {
    const queue = `cron.${s.name}`;
    await ensureQueue(queue, { policy: "singleton", retryLimit: 1, expireInSeconds: 3600 });
    await boss.schedule(queue, s.cron, {}, { tz: "Asia/Shanghai", missed: s.missed ?? "skip" });
    // Schedules fire at minute boundaries; a 15 s pickup keeps them on time with a third of the polling.
    await boss.work(queue, { pollingIntervalSeconds: 15 }, async () => recordRun(s.name, s.run));
  }
  // Retired or disabled timers must leave no queued work behind, including queues an earlier release
  // already unscheduled. pg-boss deletes the queue's jobs and schedules; job_runs retains its audit.
  const current = new Set(schedules.map((s) => `cron.${s.name}`));
  for (const old of await boss.getQueues()) {
    if (old.name.startsWith("cron.") && !current.has(old.name)) await boss.deleteQueue(old.name);
  }
}
