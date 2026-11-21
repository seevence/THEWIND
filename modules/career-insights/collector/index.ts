import type { RawCollectedJobV1 } from "../contracts/index.ts";

export interface CareerSourceDefinition {
  source_key: string;
  label: string;
  kind: "company_careers" | "government_policy";
  entry_url: string;
  access: "http" | "playwright" | "aihot_source";
  enabled: boolean;
  notes: string;
}

/** 单次采集调用的覆盖项；缺省时沿用适配器构造时的配置。 */
export interface CareerCollectOptions {
  readonly pageLimit?: number;
}

export interface CareerSourceAdapter {
  readonly definition: CareerSourceDefinition;
  collect(signal?: AbortSignal, options?: CareerCollectOptions): Promise<RawCollectedJobV1[]>;
}

export { CAREER_SOURCE_DEFINITIONS } from "./sources.ts";
export { createCareerAdapters } from "./registry.ts";
export type { CareerAdapterSet } from "./registry.ts";

export { validateRawCollectedJob } from "./validate.ts";
export type { ValidationIssueV1, ValidationResultV1 } from "./validate.ts";

export {
  AccessBlockedError,
  BudgetExhaustedError,
  CollectorError,
  ConfigError,
  EmptyResultError,
  ParseFailedError,
  ReplayNetworkViolationError,
  ReplaySampleMissingError,
  RequestTimeoutError,
  SampleRejectedError,
  SchemaChangedError,
  prioritizeFailure,
} from "./fetch/errors.ts";
export type { CollectorFailureType } from "./fetch/errors.ts";

export { FakeClock, SystemClock } from "./fetch/clock.ts";
export type { ClockPort } from "./fetch/clock.ts";
export { createPageRequest, networkCallCounter } from "./fetch/transport.ts";
export type { FetchTransport, PageRequest, TransportResponse } from "./fetch/transport.ts";
export { createTransport, transportFactoryStats } from "./fetch/create-transport.ts";
export type { TransportMode } from "./fetch/create-transport.ts";
export { HttpTransport } from "./fetch/http-transport.ts";
export { ReplayTransport, computeRequestKey } from "./fetch/replay-transport.ts";
export type { ReplaySample } from "./fetch/replay-transport.ts";
export { HostRateLimiter } from "./fetch/rate-limiter.ts";
export { SourceBudget } from "./fetch/budget.ts";
export { runWithRetry } from "./fetch/retry.ts";
export { detectBlock } from "./fetch/block-detector.ts";
export { installNetworkGuard } from "./fetch/network-guard.ts";

export {
  SampleStore,
  assertInsideRoot,
  createSample,
  sampleIdFromBody,
  sha256Hex,
} from "./evidence/sample-store.ts";
export type { SampleMeta, SampleRecord } from "./evidence/sample-store.ts";
export { containsPersonalData, sanitizeSample, stripSensitiveHeaders } from "./evidence/sanitizer.ts";
export { evaluateQuota, requiredSamples } from "./evidence/quota.ts";
export type { QuotaItem, QuotaReport, SourceKind } from "./evidence/quota.ts";

export {
  EXIT_CODES,
  decideBatchStatus,
  decideSourceStatus,
  exitCodeFor,
} from "./orchestration/status.ts";
export type { BatchStatus, SourceStatus } from "./orchestration/status.ts";
export {
  runEnabledPolicySources,
  runEnabledSources,
  runPolicySource,
  runSource,
  validateCollectedJobs,
} from "./orchestration/runner.ts";
export type {
  FailureStage,
  PolicySourceRunResult,
  RunContext,
  SourceRunResult,
} from "./orchestration/runner.ts";
export { buildRunSummary } from "./orchestration/summary.ts";
export type { RunSummary } from "./orchestration/summary.ts";

export { createAlibabaOfficialCareersAdapter } from "./adapters/alibaba-official-careers.ts";
export {
  TENCENT_COLLECTOR_VERSION,
  TENCENT_DETAIL_URL,
  TENCENT_LIST_URL,
  createTencentOfficialCareersAdapter,
  parseTencentDetail,
  parseTencentList,
  parseTencentPublishedAt,
  toTencentRawJob,
} from "./adapters/tencent-official-careers.ts";
export type {
  TencentAdapterOptions,
  TencentPostDetail,
  TencentPostSummary,
} from "./adapters/tencent-official-careers.ts";
export { loadHtmlDocument } from "./html/parse.ts";
export type { HtmlDocument, HtmlEntry } from "./html/parse.ts";

export {
  parseGovPolicyDetail,
  parseGovPolicyList,
  parseMoePolicyDetail,
  parseMoePolicyList,
  parseNdrcPolicyDetail,
  parseNdrcPolicyList,
} from "./adapters/policy-parse.ts";
export type { PolicyDetailDraft, PolicyListItem } from "./adapters/policy-parse.ts";
export {
  GOV_POLICY_LIST_URL,
  MOE_POLICY_LIST_URL,
  NDRC_POLICY_LIST_URL,
  createGovPolicySourceAdapter,
  createMoePolicySourceAdapter,
  createNdrcPolicySourceAdapter,
} from "./adapters/policy-sources.ts";
export type { PolicyAdapterOptions, PolicySourceAdapter } from "./adapters/policy-sources.ts";