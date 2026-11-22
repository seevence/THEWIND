// 热度榜外链的注册表守护：新增企业/信源只需在 CAREER_SOURCE_DEFINITIONS 登记，
// 榜单企业名就会自动带官方招聘页链接（前端与 loadCareerHot 都只读注册表）。
// 只读注册表，不连数据库、不启动服务。
import assert from "node:assert/strict";
import { test } from "node:test";
import { createCareerAdapters } from "../collector/index.ts";
import type { FetchTransport } from "../collector/fetch/transport.ts";
import { CAREER_SOURCE_DEFINITIONS } from "../collector/sources.ts";

test("every enabled company careers source carries an http(s) entry_url", () => {
  const careers = CAREER_SOURCE_DEFINITIONS.filter(
    (source) => source.kind === "company_careers" && source.enabled,
  );
  assert.ok(careers.length > 0, "the registry must expose at least one enabled company careers source");

  const broken = careers.filter(
    (source) => source.entry_url.trim() === "" || !/^https?:\/\//.test(source.entry_url),
  );
  assert.deepEqual(
    broken.map((source) => source.source_key),
    [],
    "an enabled company careers source without a public http(s) entry_url would silently lose its hot-board link",
  );
});

// 采集侧与注册表的一致性不依赖数据库：适配器构造不发网络，用空传输即可拿到全部适配器。
// 这条守护替代了此前「采库快照」式断言——那个断言在空库（CI 只跑 migrate 不灌数据）时恒为空、恒通过。
const noNetworkTransport = {} as FetchTransport;

test("every adapter carries the registry entry itself, link fields included", () => {
  const registered = new Map(CAREER_SOURCE_DEFINITIONS.map((source) => [source.source_key, source]));
  const { jobs, policies } = createCareerAdapters(noNetworkTransport);
  const adapters = [...jobs, ...policies];
  assert.ok(adapters.length > 0, "the registry must construct at least one enabled adapter");

  for (const adapter of adapters) {
    const entry = registered.get(adapter.definition.source_key);
    assert.ok(
      entry !== undefined,
      `an adapter emits a source_key that CAREER_SOURCE_DEFINITIONS does not know: ${adapter.definition.source_key}`,
    );
    // 同一引用：采集用的是注册表这一条，而不是自带一份可能漂移的副本。
    assert.equal(
      adapter.definition,
      entry,
      `${adapter.definition.source_key}: adapter.definition must be the registry entry itself`,
    );
    assert.equal(adapter.definition.entry_url, entry.entry_url, adapter.definition.source_key);
    assert.equal(adapter.definition.kind, entry.kind, adapter.definition.source_key);
    assert.equal(adapter.definition.enabled, entry.enabled, adapter.definition.source_key);
    assert.equal(adapter.definition.label, entry.label, adapter.definition.source_key);
  }
});

test("every enabled company careers source gets an adapter", () => {
  const expected = CAREER_SOURCE_DEFINITIONS.filter(
    (source) => source.enabled && source.kind === "company_careers",
  ).map((source) => source.source_key);
  const { jobs } = createCareerAdapters(noNetworkTransport);
  const actual = jobs.map((adapter) => adapter.definition.source_key);

  assert.deepEqual(
    [...actual].sort(),
    [...expected].sort(),
    "an enabled company careers source without an adapter would never be collected, so its jobs never reach the hot board",
  );
});

test("source keys are unique across the registry", () => {
  const seen = new Set<string>();
  const duplicates: string[] = [];
  for (const source of CAREER_SOURCE_DEFINITIONS) {
    if (seen.has(source.source_key)) duplicates.push(source.source_key);
    seen.add(source.source_key);
  }
  assert.deepEqual(duplicates, [], "duplicate source_key makes the registry lookup ambiguous");
});