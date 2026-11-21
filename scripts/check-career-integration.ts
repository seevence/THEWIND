// Checks the career-insights module against a live site: the page, health, summary, jobs, the first job
// detail and the invalid-id route. The pre-data phase accepts a rendered 503 page and 503
// data_unavailable for summary and jobs; `--require-data` rejects them, requires non-empty real
// (non-fixture) samples and proves one job detail carries observation evidence.
//   node scripts/check-career-integration.ts [--base http://localhost:3000] [--require-data]
import { parseArgs } from "node:util";
import { CAREER_CONTRACT_VERSION } from "@aihot/career-insights/contracts";

interface ResponseSnapshot {
  status: number;
  contentType: string;
  body: string;
}

interface CheckResult {
  path: string;
  reason: string | null;
}

type Check = (res: ResponseSnapshot) => string | null;

const PAGE_MARKER = "职业洞察";
const PRE_DATA_MARKER = "数据尚未就绪";
const SYNTHETIC_ORIGIN = "synthetic_fixture";
const REQUIRED_JOB_FIELDS = ["id", "company_name", "title", "official_url", "first_seen_at", "last_seen_at"] as const;
const REQUIRED_OBSERVATION_FIELDS = ["observed_at", "content_hash", "collector_version", "source_url"] as const;
const TIMEOUT_MS = 30_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): boolean {
  return typeof value === "string" && value.trim() !== "";
}

function describe(value: unknown): string {
  return JSON.stringify(value) ?? String(value);
}

function positiveNumberError(value: Record<string, unknown>, field: string): string | null {
  const candidate = value[field];
  return typeof candidate === "number" && Number.isFinite(candidate) && candidate > 0
    ? null
    : `${field} is ${describe(candidate)}, expected a number > 0`;
}

function realOriginError(value: Record<string, unknown>): string | null {
  const origin = value.data_origin;
  if (typeof origin !== "string") return `data_origin is ${describe(origin)}, expected a string`;
  return origin === SYNTHETIC_ORIGIN ? `data_origin is "${SYNTHETIC_ORIGIN}", expected real data` : null;
}

function contractVersionError(value: Record<string, unknown>): string | null {
  return value.contract_version === CAREER_CONTRACT_VERSION
    ? null
    : `contract_version ${describe(value.contract_version)}, expected "${CAREER_CONTRACT_VERSION}"`;
}

function readJson(body: string): { value?: Record<string, unknown>; reason?: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { reason: "response is not valid JSON" };
  }
  return isRecord(parsed) ? { value: parsed } : { reason: "response JSON is not an object" };
}

const healthCheck: Check = (res) => {
  if (res.status !== 200) return `HTTP ${res.status}, expected 200`;
  const json = readJson(res.body);
  if (json.reason) return json.reason;
  if (json.value!.ok !== true) return `ok is ${JSON.stringify(json.value!.ok)}, expected true`;
  if (json.value!.db !== "ok") return `db is ${JSON.stringify(json.value!.db)}, expected "ok"`;
  return null;
};

function pageCheck(requireData: boolean): Check {
  return (res) => {
    if (res.status !== 200 && res.status !== 503) return `HTTP ${res.status}, expected 200${requireData ? "" : " or a rendered 503"}`;
    if (res.status === 503 && requireData) return "HTTP 503, but --require-data expects real data";
    if (!res.contentType.includes("text/html")) return `content-type ${res.contentType || "(none)"}, expected HTML`;
    if (!res.body.includes(PAGE_MARKER)) return `the page does not contain ${PAGE_MARKER}`;
    if (res.status === 503 && !res.body.includes(PRE_DATA_MARKER)) return `HTTP 503 page does not contain ${PRE_DATA_MARKER}`;
    return null;
  };
}

function preDataCheck(listField: "metrics" | "items"): Check {
  return (res) => {
    if (res.status === 503) {
      const json = readJson(res.body);
      if (json.reason) return `${json.reason} (HTTP 503)`;
      const error = json.value!.error;
      const code = isRecord(error) ? error.code : undefined;
      return code === "data_unavailable" ? null : `error.code ${JSON.stringify(code)}, expected "data_unavailable"`;
    }
    if (res.status !== 200) return `HTTP ${res.status}, expected 200 or 503`;
    const json = readJson(res.body);
    if (json.reason) return json.reason;
    const value = json.value!;
    if (value.contract_version !== CAREER_CONTRACT_VERSION) {
      return `contract_version ${JSON.stringify(value.contract_version)}, expected "${CAREER_CONTRACT_VERSION}"`;
    }

    if (!Array.isArray(value[listField])) return `${listField} is not an array`;
    return null;
  };
}

const requireDataSummaryCheck: Check = (res) => {
  if (res.status !== 200) return `HTTP ${res.status}, expected 200 (--require-data)`;
  const json = readJson(res.body);
  if (json.reason) return json.reason;
  const value = json.value!;
  const versionError = contractVersionError(value);
  if (versionError) return versionError;
  const sampleError = positiveNumberError(value, "sample_size");
  if (sampleError) return sampleError;
  const companyError = positiveNumberError(value, "company_count");
  if (companyError) return companyError;
  const metrics = value.metrics;
  if (!Array.isArray(metrics) || metrics.length === 0) {
    return `metrics is ${describe(metrics)}, expected a non-empty array`;
  }
  const originError = realOriginError(value);
  if (originError) return originError;
  const warnings = value.warnings;
  if (Array.isArray(warnings) && warnings.some((warning) => isRecord(warning) && warning.code === SYNTHETIC_ORIGIN)) {
    return `warnings contains code "${SYNTHETIC_ORIGIN}", expected real data`;
  }
  return null;
};

function requireDataJobsCheck(onFirstJob: (id: string) => void): Check {
  return (res) => {
    if (res.status !== 200) return `HTTP ${res.status}, expected 200 (--require-data)`;
    const json = readJson(res.body);
    if (json.reason) return json.reason;
    const value = json.value!;
    const versionError = contractVersionError(value);
    if (versionError) return versionError;
    const items = value.items;
    if (!Array.isArray(items) || items.length === 0) return `items is ${describe(items)}, expected a non-empty array`;
    const totalError = positiveNumberError(value, "total");
    if (totalError) return totalError;
    const originError = realOriginError(value);
    if (originError) return originError;
    const first = items[0];
    if (!isRecord(first)) return `items[0] is ${describe(first)}, expected an object`;
    for (const field of REQUIRED_JOB_FIELDS) {
      const candidate = first[field];
      if (!isNonEmptyString(candidate)) return `items[0].${field} is ${describe(candidate)}, expected a non-empty string`;
    }
    onFirstJob(first.id as string);
    return null;
  };
}

function requireDataDetailCheck(jobId: string): Check {
  return (res) => {
    if (res.status !== 200) return `HTTP ${res.status}, expected 200 (--require-data)`;
    const json = readJson(res.body);
    if (json.reason) return json.reason;
    const value = json.value!;
    const versionError = contractVersionError(value);
    if (versionError) return versionError;
    const originError = realOriginError(value);
    if (originError) return originError;
    const job = value.job;
    if (!isRecord(job)) return `job is ${describe(job)}, expected an object`;
    if (job.id !== jobId) return `job.id is ${describe(job.id)}, expected "${jobId}"`;
    const observations = value.observations;
    if (!Array.isArray(observations) || observations.length === 0) {
      return `observations is ${describe(observations)}, expected a non-empty array`;
    }
    for (const [index, observation] of observations.entries()) {
      if (!isRecord(observation)) return `observations[${index}] is ${describe(observation)}, expected an object`;
      for (const field of REQUIRED_OBSERVATION_FIELDS) {
        const candidate = observation[field];
        if (!isNonEmptyString(candidate)) {
          return `observations[${index}].${field} is ${describe(candidate)}, expected a non-empty string`;
        }
      }
    }
    return null;
  };
}

const invalidIdCheck: Check = (res) => {
  if (res.status !== 400) return `HTTP ${res.status}, expected 400`;
  const json = readJson(res.body);
  if (json.reason) return json.reason;
  const error = json.value!.error;
  const code = isRecord(error) ? error.code : undefined;
  return code === "invalid_parameter" ? null : `error.code ${JSON.stringify(code)}, expected "invalid_parameter"`;
};

export async function checkCareerSite(base: string, options: { requireData?: boolean } = {}): Promise<CheckResult[]> {
  const origin = base.replace(/\/+$/, "");
  const requireData = options.requireData ?? false;
  const results: CheckResult[] = [];
  let firstJobId: string | null = null;

  const run = async (path: string, verify: Check, requestPath = path): Promise<void> => {
    let reason: string | null;
    try {
      const res = await fetch(origin + requestPath, { redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
      const contentType = res.headers.get("content-type") ?? "";
      const body = await res.text();
      reason = verify({ status: res.status, contentType, body });
    } catch (error) {
      reason = error instanceof Error ? error.message : String(error);
    }
    results.push({ path, reason });
  };

  await run("/api/health", healthCheck);
  await run("/career-insights", pageCheck(requireData));
  await run(
    "/api/site/career-insights/summary",
    requireData ? requireDataSummaryCheck : preDataCheck("metrics"),
  );
  await run(
    "/api/site/career-insights/jobs",
    requireData
      ? requireDataJobsCheck((id) => {
          firstJobId = id;
        })
      : preDataCheck("items"),
  );
  if (requireData) {
    const jobId: string | null = firstJobId;
    if (jobId === null) {
      results.push({ path: "/api/site/career-insights/jobs/<id>", reason: "skipped: jobs list has no usable item" });
    } else {
      await run(
        `/api/site/career-insights/jobs/${jobId}`,
        requireDataDetailCheck(jobId),
        `/api/site/career-insights/jobs/${encodeURIComponent(jobId)}`,
      );
    }
  }
  await run("/api/site/career-insights/jobs/not-a-uuid", invalidIdCheck);
  return results;
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { base: { type: "string" }, "require-data": { type: "boolean", default: false } } });
  const base = values.base ?? process.env.SITE_URL ?? "http://localhost:3000";
  const results = await checkCareerSite(base, { requireData: values["require-data"] });
  for (const { path, reason } of results) console.log(reason === null ? `✓ ${path}` : `✗ ${path}  ${reason}`);
  const failed = results.filter((result) => result.reason !== null).length;
  console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
  process.exitCode = failed ? 1 : 0;
}