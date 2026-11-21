import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { CliArgumentError, DEFAULT_PAGE_LIMIT, parsePageLimit } from "../collector/cli/args.ts";
import {
  buildIngestReport,
  ingestRunContext,
  resolveIngestPageLimit,
  runCareerIngest,
} from "../collector/cli/ingest-career.ts";
import { runEnabledSources } from "../collector/orchestration/runner.ts";
import type { CareerSourceAdapter } from "../collector/index.ts";

function isCliArgumentErrorMatching(pattern: RegExp) {
  return (error: unknown) => error instanceof CliArgumentError && pattern.test(error.message);
}

function stubAdapter(received: (number | undefined)[]): CareerSourceAdapter {
  return {
    definition: {
      source_key: "stub-official-careers",
      label: "stub",
      kind: "company_careers",
      entry_url: "https://example.com/careers",
      access: "http",
      enabled: true,
      notes: "",
    },
    collect: async (_signal, options) => {
      received.push(options?.pageLimit);
      return [];
    },
  };
}

function reportFor(pageLimit: number) {
  return buildIngestReport({
    startedAt: "2026-11-19T00:00:00.000Z",
    finishedAt: "2026-11-19T00:00:01.000Z",
    pageLimit,
    jobs: [],
    policies: [],
    counts: {},
  });
}

test("缺省没有 --pages 时保持首屏口径", () => {
  assert.equal(parsePageLimit(["node", "collect-career.ts", "--live"]), DEFAULT_PAGE_LIMIT);
});

test("--pages 接受 1..10 的整数", () => {
  assert.equal(parsePageLimit(["node", "collect-career.ts", "--live", "--pages", "2"]), 2);
  assert.equal(parsePageLimit(["--pages", "10"]), 10);
  assert.equal(parsePageLimit(["--pages", "1"]), 1);
});

test("--pages=N 等号写法与空格写法等价", () => {
  assert.equal(parsePageLimit(["--live", "--pages=2"]), 2);
  assert.equal(parsePageLimit(["node", "collect-career.ts", "--live", "--pages=1"]), 1);
  assert.equal(parsePageLimit(["--pages=10"]), 10);
});

test("--pages 缺失值或非整数显式报错", () => {
  assert.throws(() => parsePageLimit(["--live", "--pages"]), CliArgumentError);
  assert.throws(() => parsePageLimit(["--pages", "--live"]), CliArgumentError);
  assert.throws(() => parsePageLimit(["--pages", "abc"]), CliArgumentError);
  assert.throws(() => parsePageLimit(["--pages", "2.5"]), CliArgumentError);
  assert.throws(() => parsePageLimit(["--pages", ""]), CliArgumentError);
});

test("--pages 超出 1..10 显式报错，不回退默认值", () => {
  assert.throws(() => parsePageLimit(["--pages", "0"]), CliArgumentError);
  assert.throws(() => parsePageLimit(["--pages", "11"]), CliArgumentError);
});

test("--pages= 等号空值显式报错且给出具体原因", () => {
  assert.throws(
    () => parsePageLimit(["--live", "--pages="]),
    isCliArgumentErrorMatching(/未提供取值/),
  );
  assert.throws(
    () => parsePageLimit(["--pages="]),
    (error: unknown) => error instanceof CliArgumentError && !/unknown option/i.test(error.message),
  );
});

test("--pages= 等号非整数显式报错且给出具体原因", () => {
  assert.throws(() => parsePageLimit(["--live", "--pages=abc"]), isCliArgumentErrorMatching(/只接受整数/));
  assert.throws(() => parsePageLimit(["--pages=2.5"]), isCliArgumentErrorMatching(/只接受整数/));
  assert.throws(() => parsePageLimit(["--pages=-1"]), isCliArgumentErrorMatching(/只接受整数/));
});

test("--pages= 等号越界显式报错，不回退默认值", () => {
  assert.throws(() => parsePageLimit(["--live", "--pages=0"]), isCliArgumentErrorMatching(/超出范围/));
  assert.throws(() => parsePageLimit(["--pages=11"]), isCliArgumentErrorMatching(/超出范围/));
  assert.throws(
    () => parsePageLimit(["--pages=11"]),
    (error: unknown) => error instanceof CliArgumentError && !/unknown option/i.test(error.message),
  );
});

test("空格与等号写法混用时取首个 --pages 原文", () => {
  assert.equal(parsePageLimit(["--pages=3", "--pages", "5"]), 3);
  assert.equal(parsePageLimit(["--pages", "4", "--pages=9"]), 4);
  assert.equal(parsePageLimit(["--live", "--pages", "2", "--pages=abc"]), 2);
});
test("ingest 缺省 --pages 时 page_limit=1，adapter 收到 1", async () => {
  const pageLimit = resolveIngestPageLimit(["node", "ingest-career.ts", "--live"]);
  const received: (number | undefined)[] = [];
  await runEnabledSources([stubAdapter(received)], ingestRunContext(pageLimit));

  assert.equal(pageLimit, DEFAULT_PAGE_LIMIT);
  assert.equal(reportFor(pageLimit).page_limit, 1);
  assert.deepEqual(received, [1]);
});

test("ingest 显式 --pages 2 时 page_limit=2，adapter 收到 2", async () => {
  const pageLimit = resolveIngestPageLimit(["node", "ingest-career.ts", "--live", "--pages", "2"]);
  const received: (number | undefined)[] = [];
  await runEnabledSources([stubAdapter(received)], ingestRunContext(pageLimit));

  assert.equal(reportFor(pageLimit).page_limit, 2);
  assert.deepEqual(received, [2]);
});

test("ingest 的 --pages 非法取值抛错，不回退默认值", () => {
  assert.throws(() => resolveIngestPageLimit(["--live", "--pages", "0"]), CliArgumentError);
  assert.throws(() => resolveIngestPageLimit(["--live", "--pages=abc"]), isCliArgumentErrorMatching(/只接受整数/));
  assert.throws(() => resolveIngestPageLimit(["--live", "--pages="]), isCliArgumentErrorMatching(/未提供取值/));
});
// 真调用会联网采集并写库，standalone 测试不跑它；这里守入口形状与它不做的事（任务允许的降级断言）。
test("runCareerIngest 供定时任务直接调用，不读 argv、不写文件、不结束连接池", () => {
  assert.equal(typeof runCareerIngest, "function");
  assert.equal(runCareerIngest.length, 0, "options 有默认值，可直接无参调用");

  const source = readFileSync(new URL("../collector/cli/ingest-career.ts", import.meta.url), "utf8");
  const start = source.indexOf("export async function runCareerIngest");
  const end = source.indexOf("async function main()", start);
  assert.ok(start >= 0 && end > start, "runCareerIngest 的函数体存在");

  const body = source.slice(start, end);
  for (const forbidden of ["process.argv", "writeFileSync", "sql.end"]) {
    assert.equal(body.includes(forbidden), false, `runCareerIngest 不包含 ${forbidden}`);
  }
  for (const step of ["ingestJobSources", "ingestPolicySources", "buildIngestReport"]) {
    assert.ok(body.includes(step), `runCareerIngest 走 ${step}`);
  }
});