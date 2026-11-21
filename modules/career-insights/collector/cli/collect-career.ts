import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import {
  HttpTransport,
  createCareerAdapters,
  runEnabledPolicySources,
  runEnabledSources,
} from "../index.ts";
import { parsePageLimit } from "./args.ts";

interface LiveRecord {
  readonly phase: "jobs" | "policies";
  readonly source_key: string;
  readonly entry_url: string;
  readonly status: string;
  readonly failure_type: string | null;
  readonly failure_stage: string | null;
  readonly original_error_name: string | null;
  readonly original_error_message: string | null;
  readonly collected: number;
  readonly elapsed_ms: number;
  readonly first_item: string | null;
  readonly items: readonly Record<string, string | null>[];
}

if (!process.argv.includes("--live")) {
  console.error("默认不采集。确认要访问公开招聘/政策页面时，显式加 --live 授权一次采集。");
  process.exit(2);
}

let pageLimit: number;
try {
  pageLimit = parsePageLimit(process.argv);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}

const transport = new HttpTransport();
const adapters = createCareerAdapters(transport);
const records: LiveRecord[] = [];

const startedAt = new Date().toISOString();

for (const adapter of adapters.jobs) {
  const started = Date.now();
  const [result] = await runEnabledSources([adapter], { collectEnabled: true, pageLimit });
  if (result === undefined) {
    continue;
  }
  records.push({
    phase: "jobs",
    source_key: result.source_key,
    entry_url: result.entry_url,
    status: result.status,
    failure_type: result.failure_type,
    failure_stage: result.failure_stage,
    original_error_name: result.original_error_name,
    original_error_message: result.original_error_message,
    collected: result.counts.collected,
    elapsed_ms: Date.now() - started,
    first_item: result.jobs[0]?.title ?? null,
    items: result.jobs.map((job) => ({
      source_job_id: job.source_job_id,
      official_url: job.official_url,
      title: job.title,
      raw_text_sha256: createHash("sha256").update(job.raw_text).digest("hex"),
    })),
  });
  for (const invalid of result.invalid) {
    process.stderr.write(`invalid job ${invalid.index}: ${invalid.messages.join(", ")}\n`);
  }
}

for (const adapter of adapters.policies) {
  const started = Date.now();
  const [result] = await runEnabledPolicySources([adapter], { collectEnabled: true });
  if (result === undefined) {
    continue;
  }
  records.push({
    phase: "policies",
    source_key: result.source_key,
    entry_url: result.entry_url,
    status: result.status,
    failure_type: result.failure_type,
    failure_stage: result.failure_stage,
    original_error_name: result.original_error_name,
    original_error_message: result.original_error_message,
    collected: result.counts.collected,
    elapsed_ms: Date.now() - started,
    first_item: result.policies[0]?.title ?? null,
    items: result.policies.map((policy) => ({
      policy_item_id: policy.policy_item_id,
      official_url: policy.official_url,
      title: policy.title,
      published_at: policy.published_at,
    })),
  });
}

const report = {
  schema_version: "1.0",
  started_at: startedAt,
  page_limit: pageLimit,
  finished_at: new Date().toISOString(),
  network_calls_note: "仅公开页面；同域间隔 >=1s；未绕登录/验证码/403",
  records,
};

const json = JSON.stringify(report, null, 2);
process.stdout.write(`${json}\n`);
const outIndex = process.argv.indexOf("--out");
if (outIndex !== -1) {
  const target = process.argv[outIndex + 1];
  if (target !== undefined) {
    writeFileSync(target, `${json}\n`, "utf8");
  }
}

const failed = records.filter((record) => record.status !== "success");
process.exitCode = failed.length === 0 ? 0 : 3;