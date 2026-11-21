// 职位采集每天 06:10 跑一次（server.ts 的 career.ingest），整体抛错与部分来源失败都会留下
// job_runs 行：前者 status='failed'，后者把 failedSources 写进 detail。这里只读最近一次运行，
// 由 ops.alerts 的既有节奏负责发送与节流（同一 key 一天最多提醒一次，成功后发恢复）。
//
// 两种不含失败来源、却同样意味着「这次没采集到」的情况也要有人知道：
//   - skipped 中由 jobs/runs.ts 的 closeInterruptedRuns 补记的一行（进程被杀，error 是固定原因文案）；
//     recordRun 为付费预算暂停记下的 skipped 是主动跳过，不算问题。
//   - 最近一次成功运行早于 26 小时前，或根本没有成功运行：调度器/worker 停摆时最近一行仍是旧成功，
//     上面的读取看不到。它用自己的 key，恢复消息才能说清是哪件事恢复了。
import { beijingStamp } from "@aihot/contracts/time";
import { sql } from "@aihot/backend/db";
import type { Finding } from "@aihot/backend/notify/feishu";

export const CAREER_INGEST_JOB = "career.ingest";
export const CAREER_INGEST_STALE_KEY = `${CAREER_INGEST_JOB}.stale`;

/** 采集每天一次；留出两小时余量，超过 26 小时没有成功运行就算停摆。 */
const STALE_AFTER_MS = 26 * 3600_000;
/** closeInterruptedRuns 为进程中断的运行写下的 error 开头（见 packages/backend/src/jobs/runs.ts）。 */
const INTERRUPTED_MARK = "执行进程已退出";
/** 算作采集成功的运行状态（与 collector/cli/ingest-career.ts 的 HEALTHY_STATUSES 同口径；job_runs 的成功行只有 ok）。 */
const SUCCESS_STATUSES = ["ok", "partial"];

interface IngestRunRow {
  status: string;
  error: string | null;
  started_at: Date;
  detail: { failedSources?: string[] } | null;
}

/** 最近一次 career.ingest 的失败、被中断的运行，或长时间没有成功运行；健康时为空。 */
export async function careerIngestAlerts(now: number): Promise<Finding[]> {
  const [run] = await sql<IngestRunRow[]>`
    SELECT status, error, started_at, detail FROM job_runs
    WHERE job = ${CAREER_INGEST_JOB} AND started_at <= ${new Date(now)}
    ORDER BY started_at DESC LIMIT 1`;
  if (run !== undefined) {
    const failed = Array.isArray(run.detail?.failedSources) ? run.detail.failedSources : [];
    const crashed = run.status === "failed";
    const interrupted = run.status === "skipped" && (run.error ?? "").includes(INTERRUPTED_MARK);
    if (crashed || interrupted || failed.length > 0) return [runFinding(run, failed, crashed)];
  }
  return staleFindings(now);
}

function runFinding(run: IngestRunRow, failed: string[], crashed: boolean): Finding {
  const at = beijingStamp(run.started_at);
  const cause = run.error ? run.error.slice(0, 200) : "";
  const what = crashed
    ? `${CAREER_INGEST_JOB} 在 ${at} 运行失败${cause ? `：${cause}` : ""}`
    : run.status === "skipped"
      ? `上一次采集被中断：${CAREER_INGEST_JOB} 在 ${at} 的运行没有跑完${cause ? `（${cause}）` : ""}`
      : `${CAREER_INGEST_JOB} 在 ${at} 运行，${failed.length} 个来源没有成功：${failed.join("、")}`;
  return {
    key: CAREER_INGEST_JOB,
    level: "today",
    title: "职位数据采集没有完整跑完",
    impact: `${what}，职位与政策数据可能没有更新`,
    heals: "下一次采集成功才会恢复；来源本身的问题不会自己好",
    action: "可在 /admin/runs 查看",
    detail: `job ${CAREER_INGEST_JOB} 状态 ${run.status}${failed.length ? `；失败来源（source_key）：${failed.join("、")}` : ""}${run.error ? `；错误：${run.error.slice(0, 500)}` : ""}`,
    since: run.started_at,
  };
}

async function staleFindings(now: number): Promise<Finding[]> {
  const [last] = await sql<{ at: Date | null }[]>`
    SELECT max(started_at) AS at FROM job_runs
    WHERE job = ${CAREER_INGEST_JOB} AND status IN ${sql(SUCCESS_STATUSES)} AND started_at <= ${new Date(now)}`;
  const at = last?.at ?? null;
  if (at !== null && now - at.getTime() <= STALE_AFTER_MS) return [];
  const stamp = at === null ? null : beijingStamp(at);
  return [{
    key: CAREER_INGEST_STALE_KEY,
    level: "today",
    title: "职位数据采集已经停摆",
    impact: stamp === null
      ? "还没有成功的采集记录，职位与政策数据可能一直没有更新"
      : `最近一次成功采集：${stamp}，已超过 26 小时没有新的成功运行，职位与政策数据可能没有更新`,
    heals: "调度恢复后下一次采集成功才会恢复；停摆期间的数据不会补回来",
    action: "可在 /admin/runs 查看",
    detail: stamp === null
      ? `job ${CAREER_INGEST_JOB} 没有任何成功（ok/partial）运行记录；查调度器与 worker 是否在运行`
      : `job ${CAREER_INGEST_JOB} 最近一次成功运行开始于 ${stamp}，超过 ${STALE_AFTER_MS / 3600_000} 小时；查调度器与 worker 是否还在运行`,
    since: at ?? new Date(now),
  }];
}