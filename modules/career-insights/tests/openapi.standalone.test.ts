// modules/career-insights/contracts/openapi.json 的公开 API v1 契约：新路径、缓存头、304 响应与所有 $ref 可解析。
// 只读 JSON 文件做校验，不连数据库、不启动服务。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { FIXTURE_HOT_V1 } from "../fixtures/api.ts";

const CACHE = "public, max-age=60, stale-while-revalidate=300";

interface OpenApi {
  openapi: string;
  paths: Record<string, Record<string, {
    operationId?: string;
    parameters?: Array<{ name: string; in: string; required?: boolean; schema?: unknown }>;
    responses: Record<string, { headers?: Record<string, { schema?: { const?: string } }>; content?: unknown }>;
  }>>;
  components: {
    schemas: Record<string, unknown>;
    responses: Record<string, { headers?: Record<string, { schema?: { const?: string } }> }>;
  };
}

const contract = JSON.parse(
  readFileSync(new URL("../contracts/openapi.json", import.meta.url), "utf8"),
) as OpenApi;

function refs(node: unknown, found: Array<{ section: string; name: string }> = []): Array<{ section: string; name: string }> {
  if (Array.isArray(node)) {
    for (const item of node) refs(item, found);
    return found;
  }
  if (node === null || typeof node !== "object") return found;
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === "$ref" && typeof value === "string") {
      const match = /^#\/components\/(schemas|responses)\/([A-Za-z0-9_]+)$/.exec(value);
      assert.ok(match, `unexpected $ref ${value}`);
      found.push({ section: match[1]!, name: match[2]! });
    } else {
      refs(value, found);
    }
  }
  return found;
}

test("公开 API v1 的四条路径与操作都注册在 /api/v1/career 下", () => {
  const expected: Record<string, string> = {
    "/api/v1/career/jobs": "listPublicCareerJobs",
    "/api/v1/career/jobs/{id}": "getPublicCareerJob",
    "/api/v1/career/policies": "listPublicCareerPolicies",
    "/api/v1/career/insights": "getPublicCareerInsights",
  };
  for (const [path, operationId] of Object.entries(expected)) {
    const operation = contract.paths[path]?.get;
    assert.ok(operation, `missing path ${path}`);
    assert.equal(operation.operationId, operationId, path);
  }
});

test("公开 API v1 的成功响应声明 public 缓存与 ETag，304 指向 NotModified", () => {
  for (const path of ["/api/v1/career/jobs", "/api/v1/career/jobs/{id}"]) {
    const response = contract.paths[path]!.get!.responses["200"]!;
    assert.equal(response.headers?.["Cache-Control"]?.schema?.const, CACHE, path);
    assert.deepEqual(response.headers?.ETag?.schema, { type: "string" }, path);
    assert.equal((contract.paths[path]!.get!.responses["304"] as { $ref?: string }).$ref, "#/components/responses/NotModified", path);
  }
  for (const path of ["/api/v1/career/policies", "/api/v1/career/insights"]) {
    const response = contract.paths[path]!.get!.responses["200"]!;
    assert.equal(response.headers?.["Cache-Control"]?.schema?.const, CACHE, path);
    assert.equal((contract.paths[path]!.get!.responses["304"] as { $ref?: string }).$ref, "#/components/responses/NotModified", path);
  }
  assert.equal(contract.components.responses.NotModified?.headers?.["Cache-Control"]?.schema?.const, CACHE);
});

test("站点只读接口的成功缓存头与 http.ts 分级一致，收藏探测仍 no-store", () => {
  for (const path of [
    "/api/site/career-insights/summary",
    "/api/site/career-insights/jobs",
    "/api/site/career-insights/jobs/{id}",
    "/api/site/career-insights/policies",
    "/api/site/career-insights/hot",
    "/api/site/career-insights/daily",
    "/api/site/career-insights/daily-comment",
    "/api/site/career-insights/signals",
  ]) {
    const response = contract.paths[path]!.get!.responses["200"]!;
    assert.equal(response.headers?.["Cache-Control"]?.schema?.const, CACHE, path);
    assert.deepEqual(response.headers?.ETag?.schema, { type: "string" }, path);
  }
  const availability = contract.paths["/api/site/career-insights/jobs/availability"]!.get!.responses["200"]!;
  assert.equal(availability.headers?.["Cache-Control"]?.schema?.const, "no-store");
  assert.equal(availability.headers?.ETag, undefined);
});

test("契约里每个 $ref 都能落实到 components 的 schema 或 response", () => {
  const found = refs(contract);
  assert.ok(found.length > 40, "the document is expected to reference its components");
  const missing = found.filter(({ section, name }) => {
    const table = section === "schemas" ? contract.components.schemas : contract.components.responses;
    return table[name] === undefined;
  });
  assert.deepEqual(missing, []);
});

test("公开 v1 的 schema 已加入契约，且只含公开字段", () => {
  for (const name of [
    "CareerJobPublicV1",
    "CareerJobDetailPublicV1",
    "CareerObservationPublicV1",
    "CareerJobListResponsePublicV1",
    "CareerJobDetailResponsePublicV1",
    "CareerPolicyListResponsePublicV1",
  ]) {
    assert.ok(contract.components.schemas[name], `missing schema ${name}`);
  }
  const detail = JSON.stringify(contract.components.schemas.CareerJobDetailPublicV1);
  for (const internal of ["raw_text", "raw_payload", "job_key", "source_key"]) {
    assert.ok(!detail.includes(internal), `detail schema leaked ${internal}`);
  }
  const observation = JSON.stringify(contract.components.schemas.CareerObservationPublicV1);
  for (const internal of ["content_hash", "collector_version", "id"]) {
    assert.ok(!observation.includes(`"${internal}"`), `observation schema leaked ${internal}`);
  }
});

test("岗位列表与详情的 required 字段和公开类型一致", () => {
  const list = contract.paths["/api/v1/career/jobs"]!.get!.responses["200"]!.content as {
    "application/json": { schema: { $ref: string } };
  };
  assert.equal(list["application/json"].schema.$ref, "#/components/schemas/CareerJobListResponsePublicV1");
  const detail = contract.paths["/api/v1/career/jobs/{id}"]!.get!.responses["200"]!.content as {
    "application/json": { schema: { $ref: string } };
  };
  assert.equal(detail["application/json"].schema.$ref, "#/components/schemas/CareerJobDetailResponsePublicV1");
  const params = contract.paths["/api/v1/career/jobs"]!.get!.parameters ?? [];
  assert.deepEqual(
    params.map((parameter) => parameter.name),
    ["q", "role_family", "city", "student_friendly", "skill", "page", "page_size"],
  );
});
test("热点榜条目把 career_url 列为 required 且允许 null，与 TS 字段集一致", () => {
  const entries = (
    contract.components.schemas.CareerHotResponseV1 as {
      properties: { entries: { type?: string; items: { $ref?: string } } };
    }
  ).properties.entries;
  assert.equal(entries.type, "array");
  assert.equal(entries.items.$ref, "#/components/schemas/CareerHotEntryV1");

  const entry = contract.components.schemas.CareerHotEntryV1 as {
    type: string;
    required: string[];
    properties: Record<string, { type?: unknown }>;
  };
  assert.equal(entry.type, "object");
  assert.ok(entry.required.includes("career_url"), "career_url must be required");
  assert.deepEqual(entry.properties.career_url?.type, ["string", "null"]);

  // FIXTURE_HOT_V1 被标注为 CareerHotResponseV1，其条目键集就是 TS 字段集。
  const tsFields = Object.keys(FIXTURE_HOT_V1.entries[0]!).sort();
  assert.deepEqual([...entry.required].sort(), tsFields);
  assert.deepEqual(Object.keys(entry.properties).sort(), tsFields);
});
