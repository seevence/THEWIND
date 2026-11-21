// 品牌一致性：站名/结构化数据/公开技术前缀必须来自同一份 site 配置，
// 且读者可见配置里不得再出现旧站名或上游品牌外链。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { MCP_TOOL_NAMES } from "@aihot/contracts/mcp";
import { PUBLIC_INTERFACE_VERSION } from "@aihot/contracts/http-policy";
import { SITE } from "@aihot/site";

const ROOT = path.resolve(import.meta.dirname, "..");

function read(relative: string): string {
  return readFileSync(path.join(ROOT, relative), "utf8");
}

test("站点品牌：站名、标题与结构化数据统一为 THEWIND", () => {
  assert.equal(SITE.name, "THEWIND");
  assert.equal(SITE.organization.name, "THEWIND");
  assert.match(SITE.homeTitle, /^THEWIND — /);
  assert.equal(SITE.crawlerName, "TheWindBot/1.0");
  // 不再显示上游品牌归属：关于页 footerNote 与侧栏 poweredBy 都应为空。
  assert.equal(SITE.footerNote, null);
  assert.equal(SITE.poweredBy, null);
});

test("公开技术标识与站名一致：MCP 工具前缀、接口版本", () => {
  assert.equal(SITE.mcpPrefix, "thewind");
  for (const [tool, name] of Object.entries(MCP_TOOL_NAMES)) {
    assert.ok(name.startsWith(`${SITE.mcpPrefix}_`), `MCP 工具 ${tool} 应带站名前缀，实际为 ${name}`);
  }
  assert.equal(PUBLIC_INTERFACE_VERSION, SITE.interfaceVersion);
  assert.match(SITE.interfaceVersion, /^5\./);
});

test("读者可见的站点配置与更新日志不再提旧站名或上游外链", () => {
  for (const relative of ["site/site.ts", "site/changelog.json"]) {
    const text = read(relative);
    assert.doesNotMatch(text, /MyHOT/, `${relative} 不应再出现旧站名 MyHOT`);
    assert.doesNotMatch(text, /aihot\.news/, `${relative} 不应再出现上游外链`);
    assert.doesNotMatch(text, /"AIHOT"/, `${relative} 不应把 AIHOT 当品牌名`);
  }
  assert.match(read("site/changelog.json"), /THEWIND/);
});
