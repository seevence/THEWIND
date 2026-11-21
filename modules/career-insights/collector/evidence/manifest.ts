import type { QuotaItem, SourceKind } from "./quota.ts";
import { evaluateQuota } from "./quota.ts";
import type { QuotaReport } from "./quota.ts";

export interface ManifestSampleRef {
  readonly sample_id: string;
  readonly request_key: string;
  readonly request_url: string;
  readonly captured_at: string;
  readonly extraction_ref: string;
  readonly body_file: string;
  readonly body_sha256: string;
}

export interface ManifestSource {
  readonly source_key: string;
  readonly kind: SourceKind;
  readonly sample_count: number;
  readonly samples: readonly ManifestSampleRef[];
}

export interface SampleManifest {
  readonly version: "1.0";
  readonly generated_at: string;
  readonly sources: readonly ManifestSource[];
}

export interface ManifestValidation {
  readonly ok: boolean;
  readonly errors: readonly string[];
}

export function buildSampleManifest(input: {
  readonly generatedAt: string;
  readonly sources: readonly {
    readonly source_key: string;
    readonly kind: SourceKind;
    readonly samples: readonly ManifestSampleRef[];
  }[];
}): SampleManifest {
  return {
    version: "1.0",
    generated_at: input.generatedAt,
    sources: input.sources.map((source) => ({
      source_key: source.source_key,
      kind: source.kind,
      sample_count: source.samples.length,
      samples: [...source.samples],
    })),
  };
}

export function validateSampleManifest(value: unknown): ManifestValidation {
  const errors: string[] = [];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, errors: ["manifest 必须是对象"] };
  }
  const manifest = value as Record<string, unknown>;
  if (manifest["version"] !== "1.0") {
    errors.push("version 必须为 1.0");
  }
  if (typeof manifest["generated_at"] !== "string" || manifest["generated_at"].length === 0) {
    errors.push("generated_at 必填");
  }
  if (!Array.isArray(manifest["sources"]) || manifest["sources"].length === 0) {
    return { ok: false, errors: [...errors, "sources 必须是非空数组"] };
  }

  for (const [index, raw] of manifest["sources"].entries()) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      errors.push(`sources[${index}] 必须是对象`);
      continue;
    }
    const source = raw as Record<string, unknown>;
    const sourceKey = source["source_key"];
    if (typeof sourceKey !== "string" || sourceKey.length === 0) {
      errors.push(`sources[${index}].source_key 必填`);
    }
    if (source["kind"] !== "job" && source["kind"] !== "policy") {
      errors.push(`sources[${index}].kind 必须是 job 或 policy`);
    }
    const samples = source["samples"];
    if (!Array.isArray(samples) || samples.length === 0) {
      errors.push(`sources[${index}].samples 必须是非空数组`);
      continue;
    }
    if (source["sample_count"] !== samples.length) {
      errors.push(`sources[${index}].sample_count 必须等于 samples.length`);
    }
    const seen = new Set<string>();
    for (const [sampleIndex, sample] of samples.entries()) {
      if (typeof sample !== "object" || sample === null || Array.isArray(sample)) {
        errors.push(`sources[${index}].samples[${sampleIndex}] 必须是对象`);
        continue;
      }
      const record = sample as Record<string, unknown>;
      for (const field of [
        "sample_id",
        "request_key",
        "request_url",
        "captured_at",
        "extraction_ref",
        "body_file",
        "body_sha256",
      ] as const) {
        if (typeof record[field] !== "string" || (record[field] as string).length === 0) {
          errors.push(`sources[${index}].samples[${sampleIndex}].${field} 必填`);
        }
      }
      if (typeof record["body_sha256"] === "string" && !/^[a-f0-9]{64}$/.test(record["body_sha256"])) {
        errors.push(`sources[${index}].samples[${sampleIndex}].body_sha256 必须是 64 位小写十六进制`);
      }
      if (typeof record["body_file"] === "string" && record["body_file"].includes("..")) {
        errors.push(`sources[${index}].samples[${sampleIndex}].body_file 不得包含 ..`);
      }
      if (typeof record["sample_id"] === "string") {
        if (seen.has(record["sample_id"])) {
          errors.push(`sources[${index}] 中 sample_id 重复：${record["sample_id"]}`);
        }
        seen.add(record["sample_id"]);
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

export function quotaItemsFromManifest(manifest: SampleManifest): QuotaItem[] {
  return manifest.sources.map((source) => ({
    source_key: source.source_key,
    kind: source.kind,
    sample_count: source.sample_count,
  }));
}

export function evaluateManifestQuota(manifest: SampleManifest): QuotaReport {
  return evaluateQuota(quotaItemsFromManifest(manifest));
}