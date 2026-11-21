// career-insights 的每日清理份额：底座的 dailyRetention（packages/backend/src/operations/retention.ts）
// 汇总各模块的 retention 结果，这里删掉过期的岗位观测与采集流水。
//
// 保留期按「首页/洞察页还需要多久的数据」定：观测 180 天够算近半年的新增与变化；采集流水 90 天够
// 后台按天回看最近一个季度的失败与耗时。删除走参数化 SQL，返回删除行数；任何一条失败都只记进结果、
// 不抛穿，否则一条语句出错会让底座当天的其它清理全部停摆（错误随 job_runs.detail 交给运维）。
import { sql, type Db } from "@aihot/backend/db";

/** 岗位观测保留 180 天（按 observed_at 北京时间的时刻比较，即整 180 个 24 小时）。 */
export const CAREER_OBSERVATION_RETENTION_DAYS = 180;
/** 采集流水保留 90 天（按 fetched_at 比较）。 */
export const CAREER_INGEST_RUN_RETENTION_DAYS = 90;

const DAY_MS = 86_400_000;

/** 与底座 dailyRetention 的其它键合并（Object.assign），键名带模块前缀避免撞车。 */
export interface CareerRetentionResult {
  deletedCareerObservations: number;
  deletedCareerIngestRuns: number;
  /** 删除失败的语句与错误；正常情况下为空数组。 */
  careerRetentionErrors: string[];
}

function cutoffBefore(now: Date, days: number): Date {
  return new Date(now.getTime() - days * DAY_MS);
}

async function deleteBefore(
  db: Db,
  table: string,
  run: (before: Date) => PromiseLike<{ count: number }>,
  before: Date,
  errors: string[],
): Promise<number> {
  try {
    return (await run(before)).count;
  } catch (error) {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    errors.push(`${table}: ${message}`);
    return 0;
  }
}

/**
 * 删除超过保留期的岗位观测与采集流水，返回删除行数。
 * `db` 可注入（测试传假实现或测试库）；单条删除失败不抛穿，错误记进 careerRetentionErrors。
 */
export async function clearCareerRetention(db: Db, now: Date = new Date()): Promise<CareerRetentionResult> {
  const errors: string[] = [];
  // 顺序执行：删除量很小，顺序让结果与错误顺序稳定，测试与 job_runs.detail 都好读。
  const deletedCareerObservations = await deleteBefore(
    db,
    "career_job_observations",
    (before) => db`DELETE FROM career_job_observations WHERE observed_at < ${before}`,
    cutoffBefore(now, CAREER_OBSERVATION_RETENTION_DAYS),
    errors,
  );
  const deletedCareerIngestRuns = await deleteBefore(
    db,
    "career_ingest_runs",
    (before) => db`DELETE FROM career_ingest_runs WHERE fetched_at < ${before}`,
    cutoffBefore(now, CAREER_INGEST_RUN_RETENTION_DAYS),
    errors,
  );
  return { deletedCareerObservations, deletedCareerIngestRuns, careerRetentionErrors: errors };
}

/**
 * ServerModule.retention 的能力对象。server.ts 接线写 `retention: (now) => careerRetention.clear(now)`，
 * 与后端 http 路由一样由 lead 统一注册；不在这里 import server.ts。
 */
export const careerRetention = {
  clear: (now: Date = new Date()): Promise<CareerRetentionResult> => clearCareerRetention(sql, now),
};
