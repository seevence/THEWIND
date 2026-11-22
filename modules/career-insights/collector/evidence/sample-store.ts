import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { SampleRejectedError } from "../fetch/errors.ts";

export interface SampleMeta {
  readonly sample_id: string;
  readonly request_key: string;
  readonly request_url: string;
  readonly final_url: string;
  readonly http_status: number;
  readonly content_type: string | null;
  readonly body_sha256: string;
  readonly captured_at: string;
  readonly collector_version: string;
  readonly extraction_ref: string;
  readonly sanitized: boolean;
  /** 打码计数（`redacted:email=1`）或误报原因（`false_positive:org_phone`）。 */
  readonly sanitize_note?: string;
  readonly body_file: string;
}

export interface SampleRecord {
  readonly meta: SampleMeta;
  readonly body: Buffer;
}

export const SAMPLE_META_FIELDS: readonly (keyof SampleMeta)[] = [
  "sample_id",
  "request_key",
  "request_url",
  "final_url",
  "http_status",
  "content_type",
  "body_sha256",
  "captured_at",
  "collector_version",
  "extraction_ref",
  "sanitized",
  "body_file",
];

export function sha256Hex(body: Buffer): string {
  return createHash("sha256").update(body).digest("hex");
}

export function sampleIdFromBody(body: Buffer): string {
  return sha256Hex(body).slice(0, 16);
}

export interface CreateSampleInput {
  readonly request_key: string;
  readonly request_url: string;
  readonly final_url: string;
  readonly http_status: number;
  readonly content_type: string | null;
  readonly captured_at: string;
  readonly collector_version: string;
  readonly extraction_ref: string;
  readonly sanitized: boolean;
  readonly sanitize_note?: string;
  readonly body: Buffer;
  readonly body_file: string;
}

export function createSample(input: CreateSampleInput): SampleRecord {
  const bodySha = sha256Hex(input.body);
  const meta: SampleMeta = {
    sample_id: bodySha.slice(0, 16),
    request_key: input.request_key,
    request_url: input.request_url,
    final_url: input.final_url,
    http_status: input.http_status,
    content_type: input.content_type,
    body_sha256: bodySha,
    captured_at: input.captured_at,
    collector_version: input.collector_version,
    extraction_ref: input.extraction_ref,
    sanitized: input.sanitized,
    ...(input.sanitize_note === undefined ? {} : { sanitize_note: input.sanitize_note }),
    body_file: input.body_file,
  };

  for (const field of SAMPLE_META_FIELDS) {
    const value = meta[field];
    if (value === undefined || value === null || value === "") {
      throw new SampleRejectedError(`样本元信息缺少 ${field}`);
    }
  }

  return { meta, body: input.body };
}

export function assertInsideRoot(rootDir: string, targetPath: string): void {
  const root = resolve(rootDir);
  const target = resolve(root, targetPath);
  const relativePath = relative(root, target);
  if (relativePath.startsWith("..") || isAbsolute(relativePath) || relativePath.split(sep).includes("..")) {
    throw new SampleRejectedError(`样本路径越界：${targetPath}`);
  }
}

export class SampleStore {
  private readonly rootDir: string;

  constructor(rootDir: string) {
    this.rootDir = resolve(rootDir);
  }

  async save(sample: SampleRecord, relativeBodyPath: string): Promise<string> {
    const bodyPath = resolve(this.rootDir, relativeBodyPath);
    assertInsideRoot(this.rootDir, bodyPath);
    await mkdir(dirname(bodyPath), { recursive: true });
    await writeFile(bodyPath, sample.body);
    await writeFile(`${bodyPath}.meta.json`, JSON.stringify(sample.meta, null, 2), "utf8");
    return bodyPath;
  }

  async load(bodyPath: string): Promise<SampleRecord> {
    const absolute = resolve(this.rootDir, bodyPath);
    assertInsideRoot(this.rootDir, absolute);
    const body = await readFile(absolute);
    const meta = JSON.parse(await readFile(`${absolute}.meta.json`, "utf8")) as SampleMeta;
    return { meta, body };
  }
}