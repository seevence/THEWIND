import assert from "node:assert/strict";
import { test } from "node:test";
import {
  REDACTED_CONTACT,
  REDACTED_EMAIL,
  REDACTED_PHONE,
  detectFalsePositivePersonalData,
  redactPersonalData,
  sanitizeSample,
} from "../collector/evidence/sanitizer.ts";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

test("含邮箱的 Duty/Require 字段打码后仍是合法 JSON 且条目数不变", () => {
  const raw = JSON.stringify({
    Code: 0,
    Count: 2,
    Total: 2,
    Data: [
      {
        JobAdId: 600001,
        Duty: "负责平台建设，简历投递：talent@example.com。",
        Require: "本科；联系电话：13800138000",
      },
      { JobAdId: 600002, Duty: "负责测试", Require: "熟悉 Java" },
    ],
  });

  const result = redactPersonalData(raw);
  assert.deepEqual(result.counts, { email: 1, phone: 1, contact: 2 });

  const parsed = JSON.parse(result.text) as {
    Data: { JobAdId: number; Duty: string; Require: string }[];
  };
  assert.equal(parsed.Data.length, 2);
  assert.equal(parsed.Data[0].JobAdId, 600001);
  assert.equal(parsed.Data[1].Duty, "负责测试");
  assert.equal(parsed.Data[1].Require, "熟悉 Java");
  assert.equal(parsed.Data[0].Duty, `负责平台建设，${REDACTED_CONTACT}`);
  assert.equal(parsed.Data[0].Require, `本科；${REDACTED_CONTACT}`);
  assert.doesNotMatch(result.text, /@/);
});

test("联系人段落不跨越 JSON 字符串边界，不吞掉相邻字段", () => {
  const raw =
    '{"Duty":"简历投递：hr@example.com","Require":"熟悉 Java","Note":"联系人：13800138000"}';

  const result = redactPersonalData(raw);
  const parsed = JSON.parse(result.text) as Record<string, string>;
  assert.deepEqual(Object.keys(parsed), ["Duty", "Require", "Note"]);
  assert.equal(parsed.Duty, REDACTED_CONTACT);
  assert.equal(parsed.Require, "熟悉 Java");
  assert.equal(parsed.Note, REDACTED_CONTACT);
  assert.doesNotMatch(result.text, new RegExp(`${escapeRegExp(REDACTED_CONTACT)}":"`));
});

test("段落匹配不跨越换行", () => {
  const raw = '{"Duty":"简历投递：hr@example.com\\n招聘人数：3","Require":"本科"}';

  const result = redactPersonalData(raw);
  const parsed = JSON.parse(result.text) as Record<string, string>;
  assert.equal(parsed.Require, "本科");
  assert.match(parsed.Duty, /招聘人数：3$/);
  assert.ok(parsed.Duty.startsWith(REDACTED_CONTACT));
});

test("毫秒时间戳、机构总机与 ICP 备案号保持原文并记为误报", () => {
  const raw = '{"PostDateInt":1795153028000,"Org":"总机 0731-88888888","License":"湘ICP备12345678号"}';

  const result = redactPersonalData(raw);
  assert.equal(result.text, raw);
  assert.deepEqual(result.counts, { email: 0, phone: 0, contact: 0 });
  assert.deepEqual(detectFalsePositivePersonalData(raw), [
    "post_date_int_timestamp",
    "org_phone",
    "icp_license",
  ]);

  const sanitized = sanitizeSample({
    headers: { "set-cookie": "session=1", accept: "application/json" },
    bodyText: raw,
  });
  assert.equal(sanitized.body_rewritten, false);
  assert.equal(sanitized.bodyText, raw);
  assert.equal(sanitized.sanitized, false);
  assert.equal(sanitized.sanitize_note, "false_positive:post_date_int_timestamp,org_phone,icp_license");
  assert.deepEqual(sanitized.headers, { accept: "application/json" });
});

test("UUID 中的 11 位数字段不打码，非 UUID 语境的 11 位手机号仍打码", () => {
  const raw = JSON.stringify({
    Data: [
      { Id: "a2fc6e75-2426-4799-b9c9-13708838236c", JobAdId: 430044777 },
      { Id: "2cee0338-a5cf-486f-87d6-b18129472457", JobAdId: 270636135 },
    ],
  });

  const result = redactPersonalData(raw);
  assert.deepEqual(result.counts, { email: 0, phone: 0, contact: 0 });
  assert.equal(result.text, raw);
  assert.ok(result.text.includes("a2fc6e75-2426-4799-b9c9-13708838236c"));
  assert.ok(result.text.includes("2cee0338-a5cf-486f-87d6-b18129472457"));

  const real = '{"Contact":"联系电话：13708838236"}';
  const redacted = redactPersonalData(real);
  assert.deepEqual(redacted.counts, { email: 0, phone: 1, contact: 1 });
  assert.ok(redacted.text.includes(REDACTED_CONTACT));
  assert.doesNotMatch(redacted.text, /13708838236/);

  // 非联系人段语境下的 11 位手机号同样必须打码为占位符。
  const bare = redactPersonalData('{"Phone":"13708838236"}');
  assert.equal(bare.text, `{"Phone":"${REDACTED_PHONE}"}`);
});

test("含邮箱/手机号的真实段落仍打码，UUID 字段保真且 JSON 可解析", () => {
  const raw = JSON.stringify({
    Code: 200,
    Count: 2,
    Data: [
      {
        Id: "a2fc6e75-2426-4799-b9c9-13708838236c",
        JobAdId: 1,
        Duty: "简历投递：hr@example.com 或致电13800138000",
        Require: "本科",
      },
      {
        Id: "b1cb402f-98aa-4a24-bf03-37054e4d8b41",
        JobAdId: 2,
        Duty: "负责测试",
        Require: "熟悉 Java",
      },
    ],
  });

  const result = redactPersonalData(raw);
  assert.deepEqual(result.counts, { email: 1, phone: 1, contact: 1 });

  const parsed = JSON.parse(result.text) as {
    Data: { Id: string; JobAdId: number; Duty: string; Require: string }[];
  };
  assert.equal(parsed.Data.length, 2);
  assert.equal(parsed.Data[0].Id, "a2fc6e75-2426-4799-b9c9-13708838236c");
  assert.equal(parsed.Data[1].Id, "b1cb402f-98aa-4a24-bf03-37054e4d8b41");
  assert.equal(parsed.Data[0].Duty, REDACTED_CONTACT);
  assert.equal(parsed.Data[1].Duty, "负责测试");
  assert.doesNotMatch(result.text, /@/);
  assert.doesNotMatch(result.text, /13800138000/);
});

test("HTML 样本打码后标签仍闭合", () => {
  const raw =
    '<div><p>联系电话：<a href="mailto:hr@example.com">邮件</a></p><p>联系人：13800138000</p></div>';

  const result = redactPersonalData(raw);
  assert.equal(
    result.text,
    `<div><p>联系电话：<a href="mailto:${REDACTED_EMAIL}">邮件</a></p><p>${REDACTED_CONTACT}</p></div>`,
  );
  assert.deepEqual(result.counts, { email: 1, phone: 1, contact: 1 });

  const countTag = (tag: string): number => result.text.split(tag).length - 1;
  assert.equal(countTag("<p>"), countTag("</p>"));
  assert.equal(countTag("<a "), countTag("</a>"));
  assert.equal(countTag("<div>"), countTag("</div>"));
  assert.doesNotMatch(result.text, /@/);
  assert.ok(result.text.includes(REDACTED_EMAIL));
});