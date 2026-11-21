// The dashboard's policy entry, standalone: the link renders to the policy list without a database. The
// dashboard itself is JSX that Node cannot run directly, so the entry lives in PolicyEntry.ts and is
// asserted here through the same component the dashboard renders; the overview's own link builders are
// asserted to stay unchanged.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as cheerio from "cheerio";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { buildDirectionHref, buildJobsHref } from "../web/filters.ts";
import { POLICY_ENTRY_LABEL, PolicyEntry, buildPolicyEntryHref } from "../web/components/PolicyEntry.ts";

const POLICIES = "/career-insights/policies";

function render(): cheerio.CheerioAPI {
  const html = renderToStaticMarkup(
    createElement(MemoryRouter, { initialEntries: ["/career-insights"] }, createElement(PolicyEntry)),
  );
  return cheerio.load(html);
}

test("the dashboard links to the policy list with a readable label", () => {
  const html = render();
  const link = html("a").filter((_, element) => html(element).text() === POLICY_ENTRY_LABEL).first();
  assert.ok(link.length > 0, `no link labelled ${POLICY_ENTRY_LABEL}`);
  assert.equal(link.attr("href"), POLICIES);
  assert.equal(link.attr("aria-label"), "查看政策文件");

  const section = html("section[aria-labelledby='career-policies']");
  assert.equal(section.length, 1);
  assert.equal(section.find("h2#career-policies").text(), POLICY_ENTRY_LABEL);
  assert.equal(buildPolicyEntryHref(), POLICIES);
});

test("the overview's existing job and direction links are unchanged", () => {
  assert.equal(buildDirectionHref("ai_algorithm"), "/career-insights?view=direction&role_family=ai_algorithm&page=1&page_size=20");
  assert.equal(buildJobsHref({ page: 2, page_size: 50 }), "/career-insights?page=2&page_size=50");
});