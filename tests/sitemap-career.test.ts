// What discovery lists after the career SEO pass, checked against the real sitemap the api serves:
// - the career pages and every existing job are advertised, each job dated by its latest observation;
// - a job id that does not exist is never advertised;
// - /all and /topics are noindex placeholders now: they stay out of the sitemap though their routes remain;
// - a latest-issue page (/weekly, /monthly) appears only when that kind has an issue, not before.
// The career module is installed as the api installs the site's modules (apps/api/src/main.ts).
import "./setup.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { sql, closeDb } from "@aihot/backend/db";
import { installModules } from "@aihot/backend/modules";
import { loadSitemap } from "@aihot/backend/publication/sitemap";
import careerServer from "../modules/career-insights/server.ts";

const jobId = randomUUID();
const missingJobId = randomUUID();
const firstSeen = new Date("2026-11-19T12:00:00.000Z");
const lastSeen = new Date("2026-11-20T01:02:03.000Z");

before(async () => {
  await sql`INSERT INTO career_jobs (id, source_key, job_key, company_name, title, official_url, role_family, degree,
      employment_type, student_friendly, collector_version, content_hash, raw_text, locations, skills, skill_evidence,
      fetched_at, first_seen_at, last_seen_at, created_at, updated_at)
    VALUES (${jobId}, 'sitemap-test-source', ${jobId}, '示例公司', 'AI 应用开发工程师（sitemap 测试）',
      'https://example.org/jobs/sitemap-test', 'ai_application_development', 'bachelor', 'campus', 'yes', 'test-1',
      md5(${jobId}), '负责模型应用开发。', ${sql.json(["北京"])}, ${sql.json(["python"])}, ${sql.json([])},
      ${lastSeen}, ${firstSeen}, ${lastSeen}, ${lastSeen}, ${lastSeen})`;
  // One weekly issue, so the latest-issue page is advertised; no monthly one.
  await sql`INSERT INTO reports (kind, key, window_start, window_end, content, generated_at, updated_at)
    VALUES ('weekly', '2026-W47', ${firstSeen}, ${lastSeen}, '{}', ${lastSeen}, ${lastSeen})`;
  installModules([careerServer]);
});

after(async () => {
  installModules([]);
  await closeDb();
});

/** Every address in a urlset/index file, as a path. */
const urls = (xml: string) => [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => new URL(match[1]!).pathname);

test("the career pages and existing jobs are in the sitemap, each job dated by its latest observation", async () => {
  const { files } = await loadSitemap();
  assert.ok(urls(files["sitemap.xml"]!).includes("/sitemaps/career-insights.xml"), "the career section is its own file");

  const career = urls(files["career-insights.xml"]!);
  for (const loc of ["/career-insights", "/career-insights/jobs", "/career-insights/policies", `/career-insights/jobs/${jobId}`]) {
    assert.ok(career.includes(loc), `${loc} is advertised`);
  }
  assert.ok(!career.includes(`/career-insights/jobs/${missingJobId}`), "a job that does not exist is not advertised");

  const lastmod = new RegExp(`<loc>[^<]*/career-insights/jobs/${jobId}</loc>\\n<lastmod>([^<]+)</lastmod>`).exec(files["career-insights.xml"]!)?.[1];
  assert.equal(lastmod, lastSeen.toISOString(), "lastmod is the latest observation");
});

test("noindex placeholder pages and issue-less latest pages stay out of the sitemap", async () => {
  const { files } = await loadSitemap();
  const pages = urls(files["pages.xml"]!);
  assert.ok(pages.includes("/"), "the home page is still advertised");
  const everything = Object.entries(files)
    .filter(([name]) => name !== "sitemap.xml")
    .flatMap(([, xml]) => urls(xml));
  assert.ok(!everything.includes("/all"), "/all is a noindex placeholder now");
  assert.ok(!everything.includes("/topics"), "/topics is a noindex placeholder now");

  // The latest-issue page has content only after that kind's first issue; the test inserted a weekly one only.
  const reports = urls(files["reports.xml"]!);
  const kinds = new Set((await sql<{ kind: string }[]>`SELECT DISTINCT kind FROM reports`).map((row) => row.kind));
  for (const kind of ["weekly", "monthly"] as const) {
    assert.equal(reports.includes(`/${kind}`), kinds.has(kind), `${kind} is advertised exactly when it has an issue`);
  }
  assert.ok(reports.includes("/weekly"), "the inserted weekly issue advertises its latest page");
  assert.ok(!reports.includes("/monthly"), "no monthly issue yet");
});
