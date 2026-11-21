import { writeFileSync } from "node:fs";
import { policyContentHash } from "../adapters/policy-fingerprint.ts";
import { HttpTransport } from "../fetch/http-transport.ts";
import { createCareerAdapters } from "../registry.ts";
import { runEnabledPolicySources, runEnabledSources, type RunContext } from "../orchestration/runner.ts";
import { DEFAULT_PAGE_LIMIT, parsePageLimit } from "./args.ts";
import { normalizeRawJobs } from "../../data/index.ts";
import { ingestWithRun } from "../../backend/run-ingest.ts";
import {
  POLICY_SOURCE_TIERS,
  writePolicyBatch,
  type PolicySourceTier,
} from "../../backend/policy-repository.ts";
import { sql } from "../../../../packages/backend/src/db.ts";

interface JobRoundRecord {
  readonly source: string;
  readonly phase: "jobs";
  readonly status: string;
  readonly run_id: string;
  readonly collected: number;
  readonly normalized: number;
  readonly rejected: number;
  readonly accepted: number;
  readonly updated: number;
  readonly duplicates: number;
  readonly elapsed_ms: number;
}

interface PolicyRoundRecord {
  readonly source: string;
  readonly phase: "policies";
  readonly status: string;
  readonly collected: number;
  readonly accepted: number;
  readonly updated: number;
  readonly duplicates: number;
  readonly rejected: number;
  readonly elapsed_ms: number;
}

/** ingest 与 collect 共用同一套 `--pages` 解析：缺省 1，非法取值直接抛错，不静默回退。 */
export function resolveIngestPageLimit(argv: readonly string[]): number {
  return parsePageLimit(argv);
}

/** ingest 的实际采集上下文；pageLimit 经 runner 透传给 adapter.collect。 */
export function ingestRunContext(pageLimit: number): RunContext {
  return { collectEnabled: true, pageLimit };
}

export async function ingestJobSources(pageLimit: number): Promise<JobRoundRecord[]> {
  const { jobs: adapters } = createCareerAdapters(new HttpTransport());
  const records: JobRoundRecord[] = [];
  for (const adapter of adapters) {
    const started = Date.now();
    const [result] = await runEnabledSources([adapter], ingestRunContext(pageLimit));
    if (result === undefined) {
      continue;
    }
    const normalized = normalizeRawJobs(result.jobs);
    if (normalized.normalized.length === 0) {
      records.push({
        source: result.source_key,
        phase: "jobs",
        status: "failed",
        run_id: "",
        collected: result.counts.collected,
        normalized: 0,
        rejected: normalized.rejected.length,
        accepted: 0,
        updated: 0,
        duplicates: 0,
        elapsed_ms: Date.now() - started,
      });
      continue;
    }
    const first = result.jobs[0];
    const ingested = await ingestWithRun(
      sql,
      {
        schema_version: "1.0",
        source_key: result.source_key,
        fetched_at: first?.fetched_at ?? result.attempted_at,
        collector_version: first?.collector_version ?? "collector/0.1.0",
        jobs: normalized.normalized,
      },
      "live",
    );
    records.push({
      source: result.source_key,
      phase: "jobs",
      status: ingested.status,
      run_id: ingested.run_id,
      collected: result.counts.collected,
      normalized: normalized.normalized.length,
      rejected: normalized.rejected.length + ingested.rejected,
      accepted: ingested.accepted,
      updated: ingested.updated,
      duplicates: ingested.duplicates,
      elapsed_ms: Date.now() - started,
    });
  }
  return records;
}

function toPolicySourceTier(value: string, sourceKey: string): PolicySourceTier {
  const tier = POLICY_SOURCE_TIERS.find((candidate) => candidate === value);
  if (tier === undefined) {
    throw new Error(`来源 ${sourceKey} 的 source_tier 不被 backend 支持：${value}`);
  }
  return tier;
}

export async function ingestPolicySources(): Promise<PolicyRoundRecord[]> {
  const { policies: adapters } = createCareerAdapters(new HttpTransport());
  const results = await runEnabledPolicySources(adapters, { collectEnabled: true });
  const records: PolicyRoundRecord[] = [];
  for (const result of results) {
    const started = Date.now();
    if (result.policies.length === 0) {
      records.push({
        source: result.source_key,
        phase: "policies",
        status: result.status,
        collected: 0,
        accepted: 0,
        updated: 0,
        duplicates: 0,
        rejected: 0,
        elapsed_ms: Date.now() - started,
      });
      continue;
    }
    const fetchedAt = result.attempted_at;
    const written = await writePolicyBatch(sql, {
      source_key: result.source_key,
      fetched_at: fetchedAt,
      collector_version: "collector/0.1.0",
      data_origin: "live",
      policies: result.policies.map((policy) => ({
        policy_item_id: policy.policy_item_id,
        source_key: result.source_key,
        source_tier: toPolicySourceTier(policy.source_tier, result.source_key),
        title: policy.title,
        issuer: policy.issuer,
        published_at: policy.published_at,
        official_url: policy.official_url,
        theme_ids: [...policy.theme_ids],
        evidence_excerpt: policy.evidence_excerpt,
        content_hash: policyContentHash({
          source_key: result.source_key,
          policy_item_id: policy.policy_item_id,
          title: policy.title,
          published_at: policy.published_at,
          excerpt: policy.evidence_excerpt,
        }),
        collector_version: "collector/0.1.0",
        fetched_at: fetchedAt,
      })),
    });
    records.push({
      source: result.source_key,
      phase: "policies",
      status: result.status,
      collected: result.policies.length,
      accepted: written.accepted,
      updated: written.updated,
      duplicates: written.duplicates,
      rejected: written.rejected,
      elapsed_ms: Date.now() - started,
    });
  }
  return records;
}

async function snapshotCounts(): Promise<Record<string, number>> {
  const rows = await sql<{ jobs: number; observations: number; policies: number; runs: number }[]>`
    select
      (select count(*)::int from career_jobs) as jobs,
      (select count(*)::int from career_job_observations) as observations,
      (select count(*)::int from career_policies) as policies,
      (select count(*)::int from career_ingest_runs) as runs
  `;
  return { ...(rows[0] ?? { jobs: 0, observations: 0, policies: 0, runs: 0 }) };
}

export interface IngestReportInput {
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly pageLimit: number;
  readonly jobs: readonly JobRoundRecord[];
  readonly policies: readonly PolicyRoundRecord[];
  readonly counts: Record<string, number>;
}

export function buildIngestReport(input: IngestReportInput) {
  return {
    schema_version: "1.0",
    kind: "career-ingest",
    started_at: input.startedAt,
    page_limit: input.pageLimit,
    finished_at: input.finishedAt,
    data_origin: "live",
    jobs: input.jobs,
    policies: input.policies,
    counts: input.counts,
  };
}

export interface CareerIngestRunResult {
  readonly report: ReturnType<typeof buildIngestReport>;
  readonly rejected: number;
  readonly failedSources: string[];
}

/** 采集记录里算作没失败的状态；其余（failed / rejected / config_error）计入 failedSources。 */
const HEALTHY_STATUSES = new Set(["ok", "success", "partial", "skipped"]);

function failedSourcesOf(records: readonly { source: string; status: string }[]): string[] {
  return records.filter((record) => !HEALTHY_STATUSES.has(record.status)).map((record) => record.source);
}

/** 定时任务与 CLI 共用的入库入口：不读 process.argv、不写 --out 文件，也不结束共享连接池。 */
export async function runCareerIngest(options: { pageLimit?: number } = {}): Promise<CareerIngestRunResult> {
  const pageLimit = options.pageLimit ?? DEFAULT_PAGE_LIMIT;
  const startedAt = new Date().toISOString();
  const jobs = await ingestJobSources(pageLimit);
  const policies = await ingestPolicySources();
  const counts = await snapshotCounts();
  const report = buildIngestReport({
    startedAt,
    finishedAt: new Date().toISOString(),
    pageLimit,
    jobs,
    policies,
    counts,
  });
  const rejected = [...jobs, ...policies].reduce((sum, item) => sum + item.rejected, 0);
  return { report, rejected, failedSources: failedSourcesOf([...jobs, ...policies]) };
}

async function main(): Promise<void> {
  if (!process.argv.includes("--live")) {
    console.error("默认不入库。确认要采集公开招聘/政策页面并写入 live 数据时，显式加 --live。");
    process.exit(2);
  }
  let pageLimit: number;
  try {
    pageLimit = resolveIngestPageLimit(process.argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
  try {
    const { report, rejected } = await runCareerIngest({ pageLimit });
    const body = `${JSON.stringify(report, null, 2)}\n`;
    const outIndex = process.argv.indexOf("--out");
    const target = outIndex === -1 ? undefined : process.argv[outIndex + 1];
    if (target === undefined) {
      process.stdout.write(body);
    } else {
      writeFileSync(target, body, "utf8");
      process.stdout.write(`evidence written to ${target}\n`);
    }
    process.exitCode = rejected === 0 ? 0 : 3;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

if (import.meta.main) {
  void main();
}