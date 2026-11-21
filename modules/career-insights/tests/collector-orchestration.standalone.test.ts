import assert from "node:assert/strict";
import { test } from "node:test";
import type { RawCollectedJobV1 } from "../contracts/index.ts";
import type { CareerSourceAdapter, CareerSourceDefinition } from "../collector/index.ts";
import {
  decideBatchStatus,
  decideSourceStatus,
  exitCodeFor,
} from "../collector/orchestration/status.ts";
import { buildRunSummary } from "../collector/orchestration/summary.ts";
import { runEnabledSources, runSource } from "../collector/orchestration/runner.ts";
import { AccessBlockedError, ParseFailedError, RequestTimeoutError } from "../collector/fetch/errors.ts";

function definition(sourceKey: string): CareerSourceDefinition {
  return {
    source_key: sourceKey,
    label: sourceKey,
    kind: "company_careers",
    entry_url: "https://example.test/",
    access: "http",
    enabled: true,
    notes: "测试用来源定义",
  };
}

function job(overrides: Partial<RawCollectedJobV1> = {}): RawCollectedJobV1 {
  return {
    schema_version: "1.0",
    source_key: "alibaba-official-careers",
    source_job_id: "JOB-001",
    company_name: "阿里巴巴",
    title: "AI 应用后端开发工程师",
    official_url: "https://talent.alibaba.com/job/JOB-001",
    raw_text: "负责 AI 应用后端开发。",
    published_at: null,
    fetched_at: "2026-11-17T08:00:00.000Z",
    collector_version: "0.1.0",
    hints: { role_family: "unknown", locations: [], skill_terms: [] },
    ...overrides,
  };
}

const adapter = (sourceKey: string, collect: () => Promise<RawCollectedJobV1[]>): CareerSourceAdapter => ({
  definition: definition(sourceKey),
  collect,
});

test("单来源失败不影响其他来源，并记录 source_key", async () => {
  const outcomes = await runEnabledSources(
    [
      adapter("alibaba-official-careers", async () => {
        throw new AccessBlockedError("captcha", "出现验证码");
      }),
      adapter("tencent-official-careers", async () => [job({ source_key: "tencent-official-careers" })]),
    ],
    { collectEnabled: true },
  );

  assert.equal(outcomes[0]?.status, "failed");
  assert.equal(outcomes[0]?.failure_type, "access_blocked");
  assert.match(outcomes[0]?.error?.message ?? "", /alibaba-official-careers/);
  assert.equal(outcomes[1]?.status, "success");
  assert.equal(outcomes[1]?.counts.collected, 1);
});

test("安全阀关闭时零调用并标记 rejected", async () => {
  let called = 0;
  const result = await runSource(
    adapter("alibaba-official-careers", async () => {
      called += 1;
      return [job()];
    }),
    { collectEnabled: false },
  );
  assert.equal(called, 0);
  assert.equal(result.status, "rejected");
  assert.equal(result.failure_type, null);
});

test("空结果记为失败而不是成功", async () => {
  const result = await runSource(adapter("ndrc-policy", async () => []), { collectEnabled: true });
  assert.equal(result.status, "failed");
  assert.equal(result.failure_type, "empty_result");
});

test("非法记录被隔离为 invalid，不影响同批合法记录", async () => {
  const result = await runSource(
    adapter("alibaba-official-careers", async () => [job(), job({ title: "" })]),
    { collectEnabled: true },
  );
  assert.equal(result.counts.collected, 1);
  assert.equal(result.counts.invalid, 1);
  assert.equal(result.status, "partial");
  assert.equal(result.invalid[0]?.index, 1);
});

test("来源状态与批次状态及退出码保持一致", () => {
  assert.deepEqual(
    decideSourceStatus({ enabled: true, safetyValveClosed: false, collected: 3, invalid: 0, failure: null }),
    { status: "success", failure_type: null },
  );
  assert.equal(
    decideBatchStatus({
      enabledSources: 3,
      statuses: ["success", "failed", "skipped"],
      anyConfigError: false,
    }),
    "partial",
  );
  assert.equal(exitCodeFor("success"), 0);
  assert.equal(exitCodeFor("partial"), 2);
  assert.equal(exitCodeFor("failed"), 3);
  assert.equal(exitCodeFor("rejected"), 4);
  assert.equal(exitCodeFor("config_error"), 5);
  assert.equal(exitCodeFor("success", true), 6);
});

test("汇总排除 rejected/skipped 作为成功率分母，并如实给目标缺口", () => {
  const summary = buildRunSummary({
    enabledSources: 5,
    statuses: ["success", "partial", "failed", "rejected", "skipped"],
    collected: 12,
    invalid: 2,
    jobTarget: 100,
  });
  assert.equal(summary.success_rate, 1 / 3);
  assert.equal(summary.partial_sources, 1);
  assert.equal(summary.failed_sources, 1);
  assert.equal(summary.job_target_gap, 88);
});
test("失败日志字段覆盖 source_key、entry_url、尝试时间与失败阶段", async () => {
  const fixedNow = "2026-11-18T09:30:00.000Z";
  const blocked = await runSource(
    adapter("alibaba-official-careers", async () => {
      throw new AccessBlockedError("captcha", "出现验证码");
    }),
    { collectEnabled: true, now: () => fixedNow },
  );

  assert.equal(blocked.source_key, "alibaba-official-careers");
  assert.equal(blocked.entry_url, definition("alibaba-official-careers").entry_url);
  assert.equal(blocked.attempted_at, fixedNow);
  assert.equal(blocked.failure_type, "access_blocked");
  assert.equal(blocked.failure_stage, "access");
  assert.equal(blocked.limitation_type, "captcha");
  assert.equal(blocked.original_error_name, "AccessBlockedError");
  assert.match(blocked.original_error_message ?? "", /验证码/);
});

test("超时归 fetch 阶段，解析失败归 parse 阶段", async () => {
  const timeout = await runSource(
    adapter("tencent-official-careers", async () => {
      throw new RequestTimeoutError("单页超时");
    }),
    { collectEnabled: true },
  );
  assert.equal(timeout.failure_stage, "fetch");
  assert.equal(timeout.failure_type, "timeout");
  assert.equal(timeout.limitation_type, null);

  const parse = await runSource(
    adapter("bytedance-official-careers", async () => {
      throw new ParseFailedError("字段缺失");
    }),
    { collectEnabled: true },
  );
  assert.equal(parse.failure_stage, "parse");
  assert.equal(parse.failure_type, "parse_failed");
});

test("成功与拒绝路径同样携带 entry_url 与 UTC 尝试时间", async () => {
  const result = await runSource(
    adapter("alibaba-official-careers", async () => [job()]),
    { collectEnabled: true, now: () => "2026-11-18T00:00:00.000Z" },
  );
  assert.equal(result.entry_url, definition("alibaba-official-careers").entry_url);
  assert.equal(result.attempted_at, "2026-11-18T00:00:00.000Z");
  assert.equal(result.failure_stage, null);

  const rejected = await runSource(
    adapter("alibaba-official-careers", async () => [job()]),
    { collectEnabled: false, now: () => "2026-11-18T00:00:00.000Z" },
  );
  assert.equal(rejected.status, "rejected");
  assert.equal(rejected.entry_url, definition("alibaba-official-careers").entry_url);
});
test("pageLimit 经 RunContext 传给 adapter；缺省时不传覆盖项", async () => {
  const received: (number | undefined)[] = [];
  const target: CareerSourceAdapter = {
    definition: definition("tencent-official-careers"),
    collect: async (_signal, options) => {
      received.push(options?.pageLimit);
      return [job({ source_key: "tencent-official-careers" })];
    },
  };

  await runSource(target, { collectEnabled: true, pageLimit: 3 });
  await runSource(target, { collectEnabled: true });

  assert.deepEqual(received, [3, undefined]);
});
