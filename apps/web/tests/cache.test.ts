// Run after `npm run build -w @aihot/web`. Real production server/router, synthetic HTTP API only.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { ADMIN } from "@aihot/site";
import { SIGN_IN_HOME } from "@aihot/contracts/admin";
import { isPrivatePage } from "@aihot/contracts/http-policy";
import { CATEGORY_KEYS } from "@aihot/contracts/taxonomy";
import { UNSAFE_decodeViaTurboStream } from "react-router";
import { careerApi, careerBriefFixture, fakeApi, startWebServer, type WebServer } from "./web-server.ts";

let web: WebServer;
let origin: string;
let deadline: number;
/** Root metadata answers only after the selected deadline has passed: a slow sibling loader. */
let metaAfterDeadline = false;
const apiCookies: Array<string | undefined> = [];
const api = fakeApi(async (url, res, req) => {
  apiCookies.push(req.headers.cookie);
  if (url.pathname === "/api/site/meta") {
    // Past the deadline on the wall clock the server reads: timers run on another clock, and a CI VM
    // stepping its wall clock back mid-wait would otherwise answer before the deadline.
    while (metaAfterDeadline && Date.now() < deadline * 1000 + 50) await new Promise((resolve) => setTimeout(resolve, deadline * 1000 + 50 - Date.now()));
    return { changelogVersion: "2026-09-28T12:00" };
  }
  if (url.pathname === "/api/site/timeline") {
    const filters = { channel: "all", category: url.searchParams.get("category"), tag: null };
    res.setHeader("X-Accel-Expires", `@${deadline}`);
    res.setHeader("Cache-Control", "public, max-age=30, s-maxage=30");
    return { filters, cards: [], nextCursor: null, dayCounts: [], hot: null };
  }
  if (url.pathname === "/api/site/hot") return { entries: [] };
  if (url.pathname.startsWith("/api/site/career-insights/")) {
    // The workbench reads these in parallel: they must share the deadline the test selected, or the
    // home HTML would outlive the navigation data it was rendered from.
    res.setHeader("X-Accel-Expires", `@${deadline}`);
    return careerApi(url, res);
  }
  if (url.pathname === "/api/site/echo-client") return { forwarded: req.headers["x-forwarded-for"], real: req.headers["x-real-ip"] };
  if (url.pathname === "/api/site/download") {
    res.setHeader("Content-Type", "text/markdown; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="article.md"');
    return res.end("# Article");
  }
  if (url.pathname === "/api/site/items/long-lived") return { id: "long-lived", title: "t" };
  if (url.pathname === "/api/site/contact") return { wechatQr: "/qr.png", feishuQr: "/qr.png" };
  if (url.pathname === "/api/site/stories/merged") {
    res.statusCode = 308;
    return { mergedInto: "surviving-story" };
  }
  if (url.pathname.startsWith("/api/admin/")) {
    res.statusCode = 401;
    return { code: "not_found" };
  }
});

before(async () => {
  deadline = Math.floor(Date.now() / 1000) + 20;
  web = await startWebServer(api);
  origin = web.origin;
});
after(() => web.stop());

test("public route subsets produce the same complete navigation data; the home has no filters", async () => {
  const answers = await Promise.all(["", "?_routes=root", "?_routes=routes%2Fhome", "?_routes=unknown"].map(async (query) => {
    const res = await fetch(`${origin}/_.data${query}`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("Cache-Control")!, /^public,/);
    // The workbench home keeps its own minute for its career reads; it no longer inherits the
    // selected timeline deadline, so the bound is the minute rather than @deadline.
    const expires = res.headers.get("X-Accel-Expires")!;
    assert.match(expires, /^@\d+$/);
    assert.ok(Number(expires.slice(1)) >= Math.floor(Date.now() / 1000) + 50, "the home keeps at least its minute");
    assert.doesNotMatch(res.headers.get("Cache-Control")!, /stale/);
    const body = await res.text();
    assert.ok(body.includes("root") && body.includes("routes/home"));
    return body;
  }));
  // The four requests can straddle a second boundary, so their expiry timestamps may differ by a second;
  // the navigation data itself must be identical (freshness is asserted from the headers above).
  const normalized = (body: string) => body.replace(/"expiresAt",\d+/g, '"expiresAt",0');
  assert.ok(answers.every((body) => normalized(body) === normalized(answers[0]!)));
  const category = CATEGORY_KEYS.at(-1)!;
  // The workbench home has no category filter: a stray filter changes neither the data nor the cache entry.
  const filtered = await fetch(`${origin}/_.data?category=${category}&_routes=root`);
  const body = await filtered.text();
  assert.equal(normalized(body), normalized(answers[0]!));
});

test("navigation streams are plain text for download managers, including errors", async () => {
  for (const [pathname, status] of [["/_.data?_routes=root", 200], ["/items/missing.data", 404]] as const) {
    const res = await fetch(origin + pathname);
    assert.equal(res.status, status, pathname);
    assert.equal(res.headers.get("Content-Type"), "text/plain; charset=utf-8", pathname);
    assert.equal(res.headers.get("Content-Disposition"), null, pathname);
    assert.ok((await res.text()).length > 0, pathname);
  }
  const download = await fetch(origin + "/api/site/download");
  assert.equal(download.headers.get("Content-Type"), "text/markdown; charset=utf-8");
  assert.equal(download.headers.get("Content-Disposition"), 'attachment; filename="article.md"');
  assert.equal(await download.text(), "# Article");
});

test("HTML and navigation share freshness; cookies do not personalize public results", async () => {
  const html = await fetch(`${origin}/`);
  assert.equal(html.status, 200);
  assert.match(html.headers.get("X-Accel-Expires")!, /^@\d+$/, "the home keeps its own minute");
  const home = await html.text();
  assert.match(home, /就业数据工作台/);
  // Five blocks only: the signal cards, the Top 6 job list, the skills advice and the latest-job list
  // now live on the insights and jobs pages, so the home must neither render nor fetch them.
  for (const id of ["home-overview", "home-brief", "home-indicators", "home-daily", "home-top-directions"]) {
    assert.match(home, new RegExp(`id="${id}"`), id);
  }
  for (const removed of ["值得注意的信号", "热门岗位 Top 6", "热门技能与准备建议", "最新岗位"]) {
    assert.doesNotMatch(home, new RegExp(removed), removed);
  }
  // The api's deadline also fixes the result's own expiry, so reads seconds apart compare byte for byte.
  const plain = await fetch(`${origin}/_.data`);
  const signedIn = await fetch(`${origin}/_.data?_routes=root`, { headers: { cookie: "admin_session=private; reader=returning" } });
  assert.match(plain.headers.get("Cache-Control")!, /^public,/);
  const plainExpires = plain.headers.get("X-Accel-Expires")!;
  assert.match(plainExpires, /^@\d+$/);
  assert.ok(
    Math.abs(Number(plainExpires.slice(1)) - Number(signedIn.headers.get("X-Accel-Expires")!.slice(1))) <= 2,
    "the two reads share the same minute; a second boundary may separate them",
  );
  assert.equal(signedIn.headers.get("Set-Cookie"), null);
  assert.equal(await signedIn.text(), await plain.text());
  assert.ok(apiCookies.every((cookie) => !cookie));
});

test("the home renders three brief conclusions only, keeps the daily entry and reads no removed block", async () => {
  const hits: string[] = [];
  const briefApi = fakeApi((url, res) => {
    if (!url.pathname.startsWith("/api/site/career-insights/")) return undefined;
    hits.push(url.pathname + url.search);
    if (url.pathname === "/api/site/career-insights/brief") {
      return careerBriefFixture({
        inferences: [
          "INFERENCE-1 数据显示 data_analysis 与 large_language_models 技能",
          "INFERENCE-2",
          "INFERENCE-3",
          "INFERENCE-4",
          "INFERENCE-5",
        ],
      });
    }
    // The daily read fails on purpose: its entry is navigation, so it stays while the block degrades.
    if (url.pathname === "/api/site/career-insights/daily") {
      res.statusCode = 503;
      res.end(JSON.stringify({ error: { code: "internal_error", message: "fixture" } }));
      return undefined;
    }
    return careerApi(url, res);
  });
  const briefHome = await startWebServer(briefApi);
  try {
    const html = await (await fetch(`${briefHome.origin}/`)).text();
    // The home shows at most three inferences and three actions; what is not shown is not shipped either,
    // so the marker text must not even appear in the inline navigation payload.
    for (const shown of ["INFERENCE-1", "INFERENCE-2", "INFERENCE-3", "ACTION-1", "ACTION-2", "ACTION-3"]) {
      assert.match(html, new RegExp(shown), shown);
    }
    for (const hidden of ["INFERENCE-4", "INFERENCE-5", "ACTION-4", "ACTION-5", "FACT-ONLY", "LIMITATION-ONLY", "EVIDENCE-ONLY"]) {
      assert.doesNotMatch(html, new RegExp(hidden), hidden);
    }
    assert.match(html, /中置信/, "the conclusion badge names the brief's confidence");
    // 首页也复用全站领域词中文化：内部 id 不得出现在用户可见文本里。
    assert.match(html, /数据分析/);
    assert.match(html, /大语言模型/);
    assert.doesNotMatch(html, /data_analysis/, "home brief text is localized, not raw ids");
    assert.doesNotMatch(html, /large_language_models/, "home brief text is localized, not raw ids");
  assert.doesNotMatch(html, /置信度中/, "the home uses the site-wide confidence wording, not its old local one");
    // Adjacent JSX text nodes are split by comment markers in SSR; the rendered sentence still reads whole.
    const rendered = html.replace(/<!--[\s\S]*?-->/g, "");
    assert.match(rendered, /最新就业日报：本区块暂时不可用/, "only the daily block degrades");
    assert.match(rendered, /unknown 不等于不友好/, "the student-friendly indicator carries its definition");
    assert.match(rendered, /查看今日日报/, "the daily entry is navigation and stays on a failed read");
    // Four career reads only: signals and the latest-jobs list are no longer part of the home.
    assert.deepEqual(
      hits.filter((path) => path.startsWith("/api/site/career-insights")).sort(),
      [
        "/api/site/career-insights/brief",
        "/api/site/career-insights/catalog?limit=3",
        "/api/site/career-insights/daily",
        "/api/site/career-insights/summary",
      ],
    );
  } finally {
    await briefHome.stop();
  }
});

test("missing routes cannot be hidden by a root-only request; errors and redirects stay uncached", async () => {
  for (const pathname of ["/items/missing.data?_routes=root", "/does-not-exist.data?_routes=root", "/items/missing"]) {
    const res = await fetch(origin + pathname);
    assert.equal(res.status, 404, pathname);
    assert.equal(res.headers.get("Cache-Control"), "private, no-store");
    assert.equal(res.headers.get("X-Accel-Expires"), "0");
    await res.text();
  }
  for (const [pathname, target] of [["/story/merged.data?_routes=root", "/story/surviving-story"], ["/_.data?q=search&_routes=root", "/all?q=search"]]) {
    const res = await fetch(origin + pathname);
    assert.equal(res.status, 202);
    assert.equal(res.headers.get("Cache-Control"), "private, no-store");
    assert.match(await res.text(), new RegExp(target.replace("?", "\\?")));
  }
});

test("admin data and actions never become public cache entries", async () => {
  if (ADMIN) {
    const admin = await fetch(`${origin}/admin/sources.data?_routes=admin-layout`);
    assert.equal(admin.status, 202);
    assert.equal(admin.headers.get("Cache-Control"), "private, no-store");
    assert.equal(admin.headers.get("X-Accel-Expires"), "0");
    assert.match(await admin.text(), /api\/auth\/login/);
  } else {
    const none = await fetch(`${origin}/admin/sources`);
    assert.equal(none.status, 404, "a site without admin pages has none");
    await none.text();
  }
  const action = await fetch(`${origin}/hot.data`, { method: "POST" });
  assert.equal(action.status, 405);
  assert.equal(action.headers.get("Cache-Control"), "private, no-store");
  assert.equal(action.headers.get("X-Accel-Expires"), "0");
  await action.text();
});

test("gray pages are private like the admin's, whatever their route asks for", async () => {
  for (const pathname of ["/preview", "/preview/", "/preview/models", "/Preview/models", "/admin", "/admin/runs"]) assert.equal(isPrivatePage(pathname), true, pathname);
  for (const pathname of ["/", "/previews", "/all", "/items/preview", "/administer"]) assert.equal(isPrivatePage(pathname), false, pathname);
  for (const pathname of ["/preview/missing", "/preview/missing.data", "/preview/missing.data?_routes=root"]) {
    const res = await fetch(origin + pathname);
    assert.equal(res.headers.get("Cache-Control"), "private, no-store", pathname);
    assert.equal(res.headers.get("X-Accel-Expires"), "0", pathname);
    await res.text();
  }
});

test("browser freshness shares the home's minute across HTML and navigation", async () => {
  const savedDeadline = deadline;
  try {
    deadline = Math.floor(Date.now() / 1000) + 20;
    for (const pathname of ["/", "/_.data?_routes=routes%2Fhome"]) {
      const res = await fetch(origin + pathname);
      const cc = res.headers.get("Cache-Control")!;
      const browser = Number(cc.match(/(?:^|,)\s*max-age=(\d+)/)![1]);
      const shared = Number(cc.match(/(?:^|,)\s*s-maxage=(\d+)/)![1]);
      assert.ok(browser > 0 && browser === shared);
      const expires = Number(res.headers.get("X-Accel-Expires")!.slice(1));
      assert.ok(Date.parse(res.headers.get("Date")!) / 1000 + browser <= expires + 2);
      assert.match(cc, /must-revalidate/);
      assert.doesNotMatch(cc, /stale/);
      await res.text();
    }
    // The selected loader initially grants a positive TTL (at least a whole second), but root metadata
    // finishes after it. The home keeps its own minute for the workbench reads; only the navigation
    // data, which includes the root metadata, turns uncached.
    deadline = Math.floor(Date.now() / 1000) + 2;
    metaAfterDeadline = true;
    const home = await fetch(`${origin}/`);
    assert.equal(home.status, 200);
    assert.match(home.headers.get("Cache-Control")!, /max-age=\d+/);
    assert.match(home.headers.get("Cache-Control")!, /must-revalidate/);
    await home.text();
    const navigation = await fetch(`${origin}/_.data?_routes=routes%2Fhome`);
    assert.equal(navigation.status, 200);
    assert.match(navigation.headers.get("Cache-Control")!, /max-age=\d+/);
    assert.match(navigation.headers.get("Cache-Control")!, /must-revalidate/);
    assert.match(navigation.headers.get("X-Accel-Expires")!, /^@\d+$/);
    await navigation.text();
  } finally {
    deadline = savedDeadline;
    metaAfterDeadline = false;
  }
});

test("a shared cache may keep an item page longer than browsers", async () => {
  const res = await fetch(`${origin}/items/long-lived.data`);
  assert.equal(res.status, 200);
  const cc = res.headers.get("Cache-Control")!;
  assert.equal(Number(cc.match(/(?:^|,)\s*max-age=(\d+)/)![1]), 300);
  assert.ok(Number(cc.match(/(?:^|,)\s*s-maxage=(\d+)/)![1]) > 300);
  await res.text();
});

// A tab opened before a page lost its loader still asks for that page's result, and its router rejects
// a missing one before React's release recovery can run.
test("a page without a loader still answers navigation with an empty result", async () => {
  const res = await fetch(`${origin}/terms.data?_routes=routes%2Fterms`);
  assert.equal(res.status, 200);
  const { value } = await UNSAFE_decodeViaTurboStream(res.body!, globalThis);
  const result = value as Record<string, { data: unknown }>;
  assert.ok("routes/terms" in result, "an already open router must be able to unwrap its requested route");
  assert.equal(result["routes/terms"]!.data, null);
});

test("browser caching preserves noindex and private sign-in responses", async () => {
  const feedback = await fetch(origin + "/feedback");
  assert.equal(feedback.status, 200);
  assert.match(await feedback.text(), /name="robots" content="noindex/);
  assert.equal(feedback.headers.get("Cache-Control"), "public, max-age=300, s-maxage=300, must-revalidate");
  const login = await fetch(origin + "/admin/login");
  assert.equal(login.status, ADMIN ? 200 : 404, "a site without admin pages has no admin sign-in either");
  assert.equal(login.headers.get("Cache-Control"), "private, no-store");
  if (ADMIN) assert.equal(login.headers.get("X-Robots-Tag"), "noindex, nofollow");
  await login.text();
});

test("a signed-in admin is sent past the sign-in page", { skip: !ADMIN && "this site has no admin pages" }, async () => {
  const api = fakeApi((url, res, req) => {
    if (url.pathname === "/api/admin/me") {
      if (req.headers.cookie?.includes("aihot_admin=fixture")) return { name: "Fixture admin", csrf: "fixture", dev: false };
      res.statusCode = 401;
      return { code: "unauthorized" };
    }
    if (url.pathname === "/api/auth/options") return { password: true };
  });
  const signedIn = await startWebServer(api);
  try {
    const res = await fetch(`${signedIn.origin}/admin/login?return=%2Fadmin%2Fcontent`, { headers: { cookie: "aihot_admin=fixture" }, redirect: "manual" });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get("location"), "/admin/content");
    await res.text();
    for (const [target, location] of [["javascript:alert(1)", SIGN_IN_HOME], ["//evil.example/admin", SIGN_IN_HOME], ["/x/..//evil.example", SIGN_IN_HOME], ["https://evil.example/admin", "/admin"], ["/free-preview", "/free-preview"]]) {
      const away = await fetch(`${signedIn.origin}/admin/login?return=${encodeURIComponent(target!)}`, { headers: { cookie: "aihot_admin=fixture" }, redirect: "manual" });
      assert.equal(away.headers.get("location"), location, target);
      await away.text();
    }
    const anonymous = await fetch(`${signedIn.origin}/admin/login?return=%2Fadmin`, { redirect: "manual" });
    assert.equal(anonymous.status, 200, "without a session the page still offers the ways in");
    await anonymous.text();
  } finally {
    await signedIn.stop();
  }
});

test("a visitor cannot name its own address to the api without a trusted proxy in front", async () => {
  const res = await fetch(`${origin}/api/site/echo-client`, { headers: { "X-Forwarded-For": "6.6.6.6", "X-Real-IP": "6.6.6.6" } });
  assert.deepEqual(await res.json(), { forwarded: "127.0.0.1", real: "127.0.0.1" });
});

// The real listener must own its ephemeral port; reserving and releasing one before spawn races
// another CI process. Canonical URLs still have to identify the listener's actual address.
test("a web server assigned port zero serves its own canonical address", async () => {
  const ephemeral = await startWebServer(fakeApi(), { WEB_PORT: "0", SITE_URL: "http://127.0.0.1:0" });
  try {
    const response = await fetch(`${ephemeral.origin}/about`);
    assert.equal(response.status, 200);
    assert.ok((await response.text()).includes(`rel="canonical" href="${ephemeral.origin}/about"`));
  } finally { await ephemeral.stop(); }
});
