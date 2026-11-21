import assert from "node:assert/strict";
import { test } from "node:test";
import { loadHtmlDocument } from "../collector/html/parse.ts";

const PAGE = `<!doctype html>
<html><head><title>某市关于促进就业的通知</title></head>
<body>
  <h1 class="title">关于促进高校毕业生就业的通知</h1>
  <span class="author">某市人力资源和社会保障局</span>
  <span class="date">2026-11-10</span>
  <div class="content">
    <p>第一条&nbsp;本通知适用于&nbsp;2026&nbsp;届毕业生。</p>
    <p>第二条 具体补贴标准见附件。</p>
  </div>
  <a class="attachment" href="/files/notice.pdf">附件：补贴标准</a>
  <a class="attachment" href="javascript:void(0)">无效链接</a>
</body></html>`;

const doc = loadHtmlDocument(PAGE, "https://www.gov.cn/zhengce/2026-11/10/content_1.htm");

test("标题与正文按原文提取，保留内部空白", () => {
  assert.equal(doc.normalizedText("h1.title"), "关于促进高校毕业生就业的通知");
  const body = doc.text("div.content");
  assert.ok(body !== null);
  assert.match(body, /第一条/);
  assert.match(body, /2026\s+届毕业生/);
});

test("短字段可折叠空白，缺失返回 null", () => {
  assert.equal(doc.normalizedText("span.author"), "某市人力资源和社会保障局");
  assert.equal(doc.text(".missing"), null);
  assert.equal(doc.normalizedText(".missing"), null);
  assert.equal(doc.attr(".missing", "href"), null);
});

test("链接按基准地址绝对化，非法链接被丢弃", () => {
  assert.deepEqual(doc.hrefs("a.attachment"), [
    "https://www.gov.cn/files/notice.pdf",
  ]);
  assert.deepEqual(doc.hrefs(".missing"), []);
});

test("多值文本保持文档顺序，HTML 片段不被改写", () => {
  assert.deepEqual(doc.texts("div.content p"), [
    "第一条\u00a0本通知适用于\u00a02026\u00a0届毕业生。",
    "第二条 具体补贴标准见附件。",
  ]);
  const html = doc.html("div.content");
  assert.ok(html !== null);
  assert.match(html, /<p>/);
});

test("属性读取只返回首个命中", () => {
  assert.equal(doc.attr("a.attachment", "href"), "/files/notice.pdf");
});