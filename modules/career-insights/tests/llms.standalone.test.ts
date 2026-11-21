// /llms.txt 的 career 条目（backend/llms.ts）：公开 API、页面与轮询节奏，以及和引擎 llmsTxt 的拼接结果。
// 纯文本断言：不连数据库，不依赖站点实际运行。
import assert from "node:assert/strict";
import { test } from "node:test";
import type { LlmsLines } from "@aihot/backend/modules";
import { llmsTxt } from "@aihot/backend/publication/llms";
import { careerLlms, llms } from "../backend/llms.ts";
import { mcpToolName } from "@aihot/contracts/mcp";

function required(lines: LlmsLines): Required<LlmsLines> {
  return {
    api: lines.api ?? [],
    pace: lines.pace ?? [],
    pages: lines.pages ?? [],
    topics: lines.topics ?? [],
    access: lines.access ?? [],
    usage: lines.usage ?? [],
    guideClients: lines.guideClients ?? [],
    ways: lines.ways ?? [],
  };
}

test("llms 条目列出岗位/政策/研判的公开 API", () => {
  const lines = careerLlms();
  const api = lines.api ?? [];
  for (const path of [
    "/api/v1/career/jobs",
    "/api/v1/career/jobs/{id}",
    "/api/v1/career/policies",
    "/api/v1/career/insights",
  ]) {
    assert.ok(api.some((line) => line.includes(path)), `missing api entry ${path}`);
  }
  for (const line of api) {
    assert.match(line, /^- \[[^\]]+\]\([^)]+\): .+/, "every api line is a Markdown bullet with a description");
    assert.ok(line.includes("/api/v1/career/"), line);
  }
});

test("llms 条目列出三个 career 页面与轮询节奏、使用说明", () => {
  const lines = careerLlms();
  const pages = lines.pages ?? [];
  for (const path of ["/career-insights", "/career-insights/jobs", "/career-insights/policies"]) {
    assert.ok(pages.some((line) => line.includes(path)), `missing page entry ${path}`);
  }
  assert.equal((lines.pace ?? []).length, 1);
  assert.match(lines.pace![0]!, /每 60 秒/);
  assert.ok(lines.pace![0]!.endsWith("；"), "a pace clause follows the engine's and joins with ；");
  assert.equal((lines.usage ?? []).length, 1);
  assert.match(lines.usage![0]!, /^- /);
  assert.match(lines.usage![0]!, /最多 100 条/);
});

test("llms 插口形状：函数返回同一份条目", () => {
  assert.deepEqual(llms(), careerLlms());
});

test("拼进引擎 llmsTxt：career 的 API、页面、MCP 工具与轮询都出现在正文", () => {
  const lines = careerLlms();
  const tools = ["search_jobs", "get_job", "list_policies", "get_insights"].map((tool) => mcpToolName(tool));
  const text = llmsTxt({
    hasDailies: false,
    hasWeekly: false,
    hasMonthly: false,
    topics: [],
    tools,
    modules: required(lines),
  });

  for (const expected of [
    "/api/v1/career/jobs",
    "/api/v1/career/policies",
    "/api/v1/career/insights",
    "/career-insights/jobs",
    "/career-insights/policies",
    "岗位与政策接口最快每 60 秒一次",
    "公开字段：不含原文全文",
    ...tools,
  ]) {
    assert.ok(text.includes(expected), `llms.txt missing ${expected}`);
  }
  assert.ok(text.startsWith("# "), "the engine still writes the document head");
  assert.ok(text.includes("## 给 Agent 的接入方式"));
});
