// 先载入注册表：adapters 与 sources 互相导入，脚本直接以适配器为入口会触发 TDZ。
import "../sources.ts";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  HUNAN_RSJ_LIST_URL,
  HUNAN_RSJ_SOURCE_KEY,
  parseHunanRsjList,
} from "../adapters/hunan-rsj-policy.ts";
import {
  ZHIYE_COLLECTOR_VERSION,
  ZHIYE_LIST_PATH,
  ZHIYE_SOURCE_SPECS,
  buildZhiyeListBody,
  zhiyeSiteUrl,
} from "../adapters/zhiye-official-careers.ts";
import type { ZhiyeSourceSpec } from "../adapters/zhiye-official-careers.ts";
import { ConfigError } from "../fetch/errors.ts";
import { HttpTransport } from "../fetch/http-transport.ts";
import { computeRequestKey } from "../fetch/replay-transport.ts";
import { createPageRequest } from "../fetch/transport.ts";
import type { FetchTransport, PageMethod } from "../fetch/transport.ts";
import { buildSampleManifest } from "./manifest.ts";
import type { ManifestSampleRef, ManifestSource, SampleManifest } from "./manifest.ts";
import { SampleStore, createSample, sha256Hex } from "./sample-store.ts";
import type { SampleMeta } from "./sample-store.ts";
import { sanitizeSample } from "./sanitizer.ts";

const SAMPLES_DIR = join(dirname(fileURLToPath(import.meta.url)), "samples");
const REQUEST_INTERVAL_MS = 1000;
const PAGE_TIMEOUT_MS = 20_000;
const ZHIYE_PAGE_SIZE = 20;
const ZHIYE_PAGE_COUNT = 5;
const HUNAN_RSJ_DETAIL_COUNT = 2;
// hunan-rsj 适配器未导出采集器版本常量，证据元信息沿用政策源基线。
const HUNAN_RSJ_COLLECTOR_VERSION = "collector/0.1.0";

// `(sourceKey, tenant, companyName)` 三元组唯一取自 ZHIYE_SOURCE_SPECS（C-REGISTRY@1）。

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function toManifestRef(meta: SampleMeta): ManifestSampleRef {
  return {
    sample_id: meta.sample_id,
    request_key: meta.request_key,
    request_url: meta.request_url,
    captured_at: meta.captured_at,
    extraction_ref: meta.extraction_ref,
    body_file: meta.body_file,
    body_sha256: meta.body_sha256,
  };
}

interface CaptureInput {
  readonly url: string;
  readonly method: PageMethod;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly sourceKey: string;
  readonly extractionRef: string;
  readonly bodyFile: string;
  readonly collectorVersion: string;
}

interface CaptureResult {
  readonly ref: ManifestSampleRef;
  readonly body: Buffer;
}

/** 打码记录与 false_positive 只写 stderr；只有样本缺口/请求失败才影响退出码。 */
interface CaptureLog {
  readonly warnings: string[];
  readonly gaps: string[];
}

function sameJsonShape(left: unknown, right: unknown): boolean {
  if (left === null || right === null) {
    return left === right;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      return false;
    }
    return left.every((item, index) => sameJsonShape(item, right[index]));
  }
  if (typeof left !== "object" || typeof right !== "object") {
    return typeof left === typeof right;
  }
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  if (leftKeys.length !== rightKeys.length || !leftKeys.every((key, index) => rightKeys[index] === key)) {
    return false;
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  return leftKeys.every((key) => sameJsonShape(leftRecord[key], rightRecord[key]));
}

/** 打码实现若产出非法样本必须拒绝落盘，而不是把坏证据写进 samples（review N1）。 */
function assertRedactionKeepsJsonIntact(bodyFile: string, original: string, redacted: string): void {
  if (!bodyFile.endsWith(".json")) {
    return;
  }
  let before: unknown;
  try {
    before = JSON.parse(original);
  } catch {
    return;
  }
  let after: unknown;
  try {
    after = JSON.parse(redacted);
  } catch {
    throw new Error(`${bodyFile}: 打码后正文不是合法 JSON，拒绝落盘`);
  }
  if (!sameJsonShape(before, after)) {
    throw new Error(`${bodyFile}: 打码改变了 JSON 结构与条目数，拒绝落盘`);
  }
}

/** 同源内按正文 sha256 去重（重复请求只落 1 份），`seen` 由各源采集器持有。 */
async function capture(
  store: SampleStore,
  transport: FetchTransport,
  input: CaptureInput,
  log: CaptureLog,
  seen: Map<string, string>,
): Promise<CaptureResult | null> {
  const request = createPageRequest({
    url: input.url,
    method: input.method,
    headers: input.headers,
    pageTimeoutMs: PAGE_TIMEOUT_MS,
    sourceKey: input.sourceKey,
    ...(input.body === undefined ? {} : { body: input.body }),
  });
  const response = await transport.fetchPage(request);
  const rawBody = response.body.toString("utf8");
  const sanitize = sanitizeSample({ headers: response.headers, bodyText: rawBody });
  // 真实个人数据已确定性打码并落盘；毫秒时间戳、机构总机、ICP 备案号属误报，保持原文。
  if (sanitize.body_rewritten) {
    assertRedactionKeepsJsonIntact(input.bodyFile, rawBody, sanitize.bodyText);
    log.warnings.push(`${input.bodyFile}: sanitized=true（${sanitize.sanitize_note}）`);
  } else if (sanitize.sanitize_note !== null) {
    log.warnings.push(`${input.bodyFile}: sanitized=false（${sanitize.sanitize_note}）`);
  }
  const sanitizedBody = Buffer.from(sanitize.bodyText, "utf8");
  const bodySha = sha256Hex(sanitizedBody);
  const duplicateOf = seen.get(bodySha);
  if (duplicateOf !== undefined) {
    // 重复正文（典型为稀疏源尾部的同一份空页）只保留首次落盘的一份，不伪造差异化样本。
    log.warnings.push(`${input.bodyFile}: 与 ${duplicateOf} 正文相同（sha256 重复），已跳过落盘`);
    return null;
  }
  seen.set(bodySha, input.bodyFile);

  const sample = createSample({
    request_key: computeRequestKey(input.url, input.method, input.body),
    request_url: input.url,
    final_url: response.finalUrl,
    http_status: response.status,
    content_type: response.contentType,
    captured_at: response.fetchedAt,
    collector_version: input.collectorVersion,
    extraction_ref: input.extractionRef,
    sanitized: sanitize.sanitized,
    ...(sanitize.sanitize_note === null ? {} : { sanitize_note: sanitize.sanitize_note }),
    body: sanitizedBody,
    body_file: input.bodyFile,
  });
  await store.save(sample, input.bodyFile);
  return { ref: toManifestRef(sample.meta), body: sanitizedBody };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/**
 * 每源份数 = min(5, Count+1)：官方 Count 不足 PageSize×5 时尾部页仍是同一份空 `Data`。
 * 按 Count 收缩页大小只能减少空页（Count≥5 时才能让 5 页都落在真实数据上），
 * Count<5 时仍有空页且空页正文彼此相同，由 `capture` 按 body sha256 去重，只保留一份。
 */
function planZhiyePageSize(count: number | null): number {
  if (count === null || count <= 0) {
    return ZHIYE_PAGE_SIZE;
  }
  const fitting = Math.floor((count - 1) / ZHIYE_PAGE_COUNT);
  return Math.min(ZHIYE_PAGE_SIZE, Math.max(1, fitting));
}

async function probeZhiyeCount(
  transport: FetchTransport,
  url: string,
  sourceKey: string,
  log: CaptureLog,
): Promise<number | null> {
  try {
    const request = createPageRequest({
      url,
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      pageTimeoutMs: PAGE_TIMEOUT_MS,
      sourceKey,
      body: JSON.stringify(buildZhiyeListBody(0, ZHIYE_PAGE_SIZE)),
    });
    const response = await transport.fetchPage(request);
    const parsed = JSON.parse(response.body.toString("utf8")) as { Count?: unknown };
    return typeof parsed.Count === "number" ? parsed.Count : null;
  } catch (error) {
    // 探测失败会退回默认页大小，Count<100 的源可能因此出现空页重复样本，必须留痕并计入缺口。
    log.gaps.push(`${sourceKey} Count 探测失败（${url}）：${messageOf(error)}`);
    return null;
  }
}

async function captureZhiyeSource(
  store: SampleStore,
  transport: FetchTransport,
  spec: ZhiyeSourceSpec,
  log: CaptureLog,
): Promise<ManifestSource | null> {
  const url = `${zhiyeSiteUrl(spec.tenant)}${ZHIYE_LIST_PATH}`;
  const samples: ManifestSampleRef[] = [];
  const seenBodies = new Map<string, string>();
  await sleep(REQUEST_INTERVAL_MS);
  const plannedPageSize = planZhiyePageSize(
    await probeZhiyeCount(transport, url, spec.sourceKey, log),
  );
  for (let pageIndex = 0; pageIndex < ZHIYE_PAGE_COUNT; pageIndex += 1) {
    await sleep(REQUEST_INTERVAL_MS);
    try {
      const result = await capture(store, transport, {
        url,
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(buildZhiyeListBody(pageIndex, plannedPageSize)),
        sourceKey: spec.sourceKey,
        extractionRef: `list-${pageIndex + 1}`,
        bodyFile: `${spec.sourceKey}/samples/list-${pageIndex + 1}.json`,
        collectorVersion: ZHIYE_COLLECTOR_VERSION,
      }, log, seenBodies);
      if (result !== null) {
        samples.push(result.ref);
      }
    } catch (error) {
      log.gaps.push(
        `${spec.sourceKey} PageIndex=${pageIndex} PageSize=${plannedPageSize}: ${messageOf(error)}`,
      );
    }
  }
  if (samples.length === 0) {
    log.gaps.push(`${spec.sourceKey}: 未取得任何列表样本，证据缺口`);
    return null;
  }
  if (samples.length < ZHIYE_PAGE_COUNT) {
    log.gaps.push(`${spec.sourceKey}: 仅取得 ${samples.length}/${ZHIYE_PAGE_COUNT} 份列表样本，证据缺口`);
  }
  return { source_key: spec.sourceKey, kind: "job", sample_count: samples.length, samples };
}

async function captureHunanRsjPolicy(
  store: SampleStore,
  transport: FetchTransport,
  log: CaptureLog,
): Promise<ManifestSource | null> {
  await sleep(REQUEST_INTERVAL_MS);
  const seenBodies = new Map<string, string>();
  let list: CaptureResult | null;
  try {
    list = await capture(store, transport, {
      url: HUNAN_RSJ_LIST_URL,
      method: "GET",
      headers: { accept: "text/html" },
      sourceKey: HUNAN_RSJ_SOURCE_KEY,
      extractionRef: "list-1",
      bodyFile: `${HUNAN_RSJ_SOURCE_KEY}/samples/list-1.html`,
      collectorVersion: HUNAN_RSJ_COLLECTOR_VERSION,
    }, log, seenBodies);
  } catch (error) {
    log.gaps.push(`${HUNAN_RSJ_SOURCE_KEY} ${HUNAN_RSJ_LIST_URL}: ${messageOf(error)}`);
    return null;
  }
  if (list === null) {
    log.gaps.push(`${HUNAN_RSJ_SOURCE_KEY}: 列表页正文与同源既有样本重复，证据缺口`);
    return null;
  }
  const samples: ManifestSampleRef[] = [list.ref];

  const items = parseHunanRsjList(list.body.toString("utf8"), HUNAN_RSJ_LIST_URL).slice(
    0,
    HUNAN_RSJ_DETAIL_COUNT,
  );
  if (items.length < HUNAN_RSJ_DETAIL_COUNT) {
    log.gaps.push(
      `${HUNAN_RSJ_SOURCE_KEY}: 列表仅解析出 ${items.length}/${HUNAN_RSJ_DETAIL_COUNT} 条，证据缺口`,
    );
  }

  for (const [index, item] of items.entries()) {
    await sleep(REQUEST_INTERVAL_MS);
    try {
      const detail = await capture(store, transport, {
        url: item.url,
        method: "GET",
        headers: { accept: "text/html" },
        sourceKey: HUNAN_RSJ_SOURCE_KEY,
        extractionRef: `detail-${index + 1}`,
        bodyFile: `${HUNAN_RSJ_SOURCE_KEY}/samples/detail-${index + 1}.html`,
        collectorVersion: HUNAN_RSJ_COLLECTOR_VERSION,
      }, log, seenBodies);
      if (detail !== null) {
        samples.push(detail.ref);
      }
    } catch (error) {
      log.gaps.push(`${HUNAN_RSJ_SOURCE_KEY} ${item.url}: ${messageOf(error)}`);
    }
  }

  return { source_key: HUNAN_RSJ_SOURCE_KEY, kind: "policy", sample_count: samples.length, samples };
}

function parseOnlyFilter(argv: readonly string[]): ReadonlySet<string> | null {
  const index = argv.indexOf("--only");
  if (index === -1) {
    return null;
  }
  const value = argv[index + 1];
  if (value === undefined || value.length === 0) {
    throw new ConfigError("--only 需要逗号分隔的 source_key 列表");
  }
  return new Set(value.split(",").map((key) => key.trim()).filter((key) => key.length > 0));
}

/** 同 source_key 原位替换，未重抓的源与新增源顺序保持不变。 */
function mergeManifestSources(
  previous: readonly ManifestSource[],
  captured: readonly ManifestSource[],
): ManifestSource[] {
  const pending = new Map(captured.map((source) => [source.source_key, source]));
  const merged: ManifestSource[] = [];
  for (const source of previous) {
    const replacement = pending.get(source.source_key);
    if (replacement === undefined) {
      merged.push(source);
      continue;
    }
    merged.push(replacement);
    pending.delete(source.source_key);
  }
  merged.push(...pending.values());
  return merged;
}

async function main(): Promise<void> {
  const only = parseOnlyFilter(process.argv.slice(2));
  const store = new SampleStore(SAMPLES_DIR);
  const transport = new HttpTransport();
  const log: CaptureLog = { warnings: [], gaps: [] };
  const captured: ManifestSource[] = [];

  for (const spec of ZHIYE_SOURCE_SPECS) {
    if (only !== null && !only.has(spec.sourceKey)) {
      continue;
    }
    const source = await captureZhiyeSource(store, transport, spec, log);
    if (source !== null) {
      captured.push(source);
    }
  }

  if (only === null || only.has(HUNAN_RSJ_SOURCE_KEY)) {
    const hunanRsj = await captureHunanRsjPolicy(store, transport, log);
    if (hunanRsj !== null) {
      captured.push(hunanRsj);
    }
  }

  const previous = JSON.parse(
    await readFile(join(SAMPLES_DIR, "manifest.json"), "utf8"),
  ) as SampleManifest;
  const manifest = buildSampleManifest({
    generatedAt: new Date().toISOString(),
    sources: mergeManifestSources(previous.sources, captured),
  });
  await writeFile(
    join(SAMPLES_DIR, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );

  for (const source of captured) {
    process.stdout.write(`${source.source_key}:${source.kind}:${source.sample_count}\n`);
  }
  for (const warning of log.warnings) {
    process.stderr.write(`note: ${warning}\n`);
  }
  for (const gap of log.gaps) {
    process.stderr.write(`gap: ${gap}\n`);
  }
  if (log.gaps.length > 0) {
    process.exitCode = 1;
  }
}

await main();