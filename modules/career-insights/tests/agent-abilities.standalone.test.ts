// career-insights 的 MCP 能力（backend/agent.ts）：四个工具的名字、说明、参数与调用，
// 以及 /api/v1/agent/career/* 的 Markdown 回答。用假 repository 驱动，不连数据库。
import assert from "node:assert/strict";
import { test } from "node:test";
import { mcpToolName } from "@aihot/contracts/mcp";
import type { ServerModule } from "@aihot/backend/modules";
import { careerAbilities, careerAgent } from "../backend/agent.ts";
import type { JobFiltersV1 } from "../contracts/api.ts";
import type { PolicyFiltersV1 } from "../backend/policy-read.ts";
import { JOB_ID, brief, jobDetail, jobList, policyList, readOnlyRepository } from "./support.ts";

const TOOL_NAMES = ["search_jobs", "get_job", "list_policies", "get_insights"] as const;

type Abilities = NonNullable<NonNullable<ServerModule["agent"]>["abilities"]>;

function abilitiesOf(repository = readOnlyRepository()): Abilities {
  const abilities = careerAbilities(repository);
  assert.ok(abilities);
  return abilities;
}

function ability(repository: ReturnType<typeof readOnlyRepository>, tool: string) {
  const found = abilitiesOf(repository).find((entry) => entry.mcp.tool === tool);
  assert.ok(found, `missing ability ${tool}`);
  return found;
}

test("四个 MCP 工具名字唯一、域名对齐 site 前缀，说明与参数齐备", () => {
  const abilities = abilitiesOf();
  assert.deepEqual(abilities.map((entry) => entry.mcp.tool), [...TOOL_NAMES]);

  const paths = new Set<string>();
  const etags = new Set<string>();
  for (const entry of abilities) {
    assert.ok(entry.path.startsWith("/"), entry.mcp.tool);
    assert.ok(!paths.has(entry.path), `duplicate path ${entry.path}`);
    paths.add(entry.path);
    assert.ok(entry.title.length > 0 && entry.ask.length > 0, entry.mcp.tool);
    assert.ok(!etags.has(entry.etagPrefix), `duplicate etag prefix ${entry.etagPrefix}`);
    etags.add(entry.etagPrefix);
    assert.match(entry.cacheControl, /^public, max-age=/);
    assert.ok(entry.mcp.description.length > 40, `${entry.mcp.tool} description too short`);
    assert.ok(/^(for|only) /.test(entry.mcp.use), `${entry.mcp.tool} use must read after the tool name`);
    assert.equal(mcpToolName(entry.mcp.tool), `thewind_${entry.mcp.tool}`);
  }
});

test("search_jobs：关键词与分页调用 repository，返回同一份公开字段", async () => {
  let seen: JobFiltersV1 | undefined;
  const repository = readOnlyRepository({
    listJobs: async (filters) => ((seen = filters), jobList({ filters, page: 2, page_size: 5 })),
  });
  const search = ability(repository, "search_jobs");

  const result = await search.mcp.run({ q: "数据", page: 2, page_size: 5 });
  assert.deepEqual(seen, { q: "数据", page: 2, page_size: 5 });
  assert.match(result.text, /# 岗位列表/);
  assert.match(result.text, /数据分析工程师/);
  assert.equal(result.structured.contract_version, "0.1");
  assert.equal(result.structured.total, 1);
  assert.deepEqual((result.structured.items as Array<{ id: string }>)[0]!.id, JOB_ID);
});

test("search_jobs 参数 schema 拒绝越界与未知字段", () => {
  const input = ability(readOnlyRepository(), "search_jobs").mcp.input;
  assert.equal(input.safeParse({ q: "数据" }).success, true);
  assert.equal(input.safeParse({ page: 1, page_size: 100 }).success, true);
  assert.equal(input.safeParse({ page_size: 101 }).success, false);
  assert.equal(input.safeParse({ page: 0 }).success, false);
  assert.equal(input.safeParse({ surprise: true }).success, false);
  assert.equal(input.safeParse({ q: "a" }).success, false, "q needs at least two characters");
});

test("get_job：按公开 id 取详情；没有该岗位时明确返回未找到", async () => {
  let seen: string | undefined;
  const repository = readOnlyRepository({ jobDetail: async (id) => ((seen = id), jobDetail()) });
  const get = ability(repository, "get_job");

  const found = await get.mcp.run({ id: JOB_ID });
  assert.equal(seen, JOB_ID);
  assert.match(found.text, /数据分析工程师/);
  assert.match(found.text, /https:\/\/careers\.example\/jobs\/1/);
  assert.deepEqual((found.structured.job as { id: string }).id, JOB_ID);
  assert.ok(!found.text.includes("raw_text"));

  const missing = ability(readOnlyRepository({ jobDetail: async () => null }), "get_job");
  const absent = await missing.mcp.run({ id: JOB_ID });
  assert.equal(absent.structured.found, false);
  assert.match(absent.text, /没有这个岗位/);
});

test("get_job 参数 schema 只接受 UUID", () => {
  const input = ability(readOnlyRepository(), "get_job").mcp.input;
  assert.equal(input.safeParse({ id: JOB_ID }).success, true);
  assert.equal(input.safeParse({ id: "not-a-uuid" }).success, false);
  assert.equal(input.safeParse({}).success, false);
});

test("list_policies：分页读取政策，Markdown 带标题、机关与主题", async () => {
  let seen: PolicyFiltersV1 | undefined;
  const repository = readOnlyRepository({
    listPolicies: async (filters) => ((seen = filters), policyList({ filters })),
  });
  const list = ability(repository, "list_policies");
  const result = await list.mcp.run({});
  assert.deepEqual(seen, { page: 1, page_size: 20 });
  assert.match(result.text, /# 就业与产业发展政策/);
  assert.match(result.text, /关于促进高校毕业生就业的通知/);
  assert.match(result.text, /就业促进/);
  assert.equal(result.structured.total, 1);
});

test("get_insights：有研判返回结论与置信度，无缓存明确说明", async () => {
  const cached = ability(readOnlyRepository({ careerBrief: async () => brief() }), "get_insights");
  const result = await cached.mcp.run({});
  assert.match(result.text, /# 就业趋势研判/);
  assert.match(result.text, /当前样本量为 12 个岗位/);
  assert.equal(result.structured.confidence, "medium");

  const empty = ability(readOnlyRepository({ careerBrief: async () => null }), "get_insights");
  const absent = await empty.mcp.run({});
  assert.equal(absent.structured.found, false);
  assert.match(absent.text, /研判缓存尚未生成/);
});

test("Agent 地址（answer）也返回同一份公开内容的 Markdown", async () => {
  const repository = readOnlyRepository();
  const search = ability(repository, "search_jobs");
  const jobsAnswer = await search.answer();
  assert.match(jobsAnswer, /^# 岗位列表/);
  assert.match(jobsAnswer, /数据分析工程师/);

  const jobAnswer = await ability(
    readOnlyRepository({ jobDetail: async () => jobDetail() }),
    "get_job",
  ).answer();
  assert.match(jobAnswer, /数据分析工程师/);

  const policiesAnswer = await ability(repository, "list_policies").answer();
  assert.match(policiesAnswer, /关于促进高校毕业生就业的通知/);

  const insightsAnswer = await ability(readOnlyRepository({ careerBrief: async () => brief() }), "get_insights").answer();
  assert.match(insightsAnswer, /# 就业趋势研判/);

  const emptyInsights = await ability(readOnlyRepository({ careerBrief: async () => null }), "get_insights").answer();
  assert.match(emptyInsights, /尚未生成/);
});

test("careerAgent 返回 ServerModule.agent 可直接接线的形状", () => {
  const capability = careerAgent(readOnlyRepository());
  assert.equal(capability.abilities?.length, TOOL_NAMES.length);
  assert.deepEqual(capability.abilities?.map((entry) => entry.mcp.tool), [...TOOL_NAMES]);
});
