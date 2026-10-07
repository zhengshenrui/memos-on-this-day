/**
 * 离线单元测试：不联网、不需要浏览器。
 * 运行：node --test test/
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const SCRIPT_PATH = path.join(__dirname, "..", "memos-on-this-day.js");
const SOURCE = fs.readFileSync(SCRIPT_PATH, "utf8");

/**
 * 用最小 DOM 桩把插件加载进 Node，只为拿到内部纯函数。
 * document.readyState = "loading" 且不触发 DOMContentLoaded，所以 boot() 不会执行。
 */
function loadPlugin() {
  const store = {};
  global.localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => {
      store[k] = String(v);
    },
    removeItem: (k) => {
      delete store[k];
    },
  };
  global.window = {};
  global.document = {
    readyState: "loading",
    addEventListener() {},
    getElementById: () => null,
    createElement: () => ({
      style: {},
      dataset: {},
      classList: { contains: () => false, toggle() {} },
      setAttribute() {},
      appendChild() {},
      addEventListener() {},
      querySelector: () => null,
      querySelectorAll: () => [],
    }),
    head: { appendChild() {} },
    body: null,
  };
  global.setTimeout = () => 0;
  global.setInterval = () => 0;
  global.getComputedStyle = () => ({ backgroundColor: "rgb(255,255,255)" });

  new Function(SOURCE)();
  return global.window.__memosOnThisDay;
}

const api = loadPlugin();

const memo = (iso, content) => ({ name: "memos/" + iso, content: content || "x", createTime: iso });

/* ================================================================ *
 * Markdown 渲染
 * ================================================================ */

test("Markdown: 块级语法", () => {
  const html = api.renderMarkdown(
    ["# 标题", "", "> 引用", "", "- 甲", "- [x] 已完成", "- [ ] 未完成", "", "```js", "const a = 1 < 2;", "```"].join("\n"),
  );
  assert.match(html, /<h3 class="motd-h">标题<\/h3>/);
  assert.match(html, /<blockquote class="motd-quote">引用<\/blockquote>/);
  assert.match(html, /<ul class="motd-list">/);
  assert.match(html, /☑ 已完成/);
  assert.match(html, /☐ 未完成/);
  assert.match(html, /<pre class="motd-code"><code>/);
});

test("Markdown: 行内语法", () => {
  const html = api.renderMarkdown(
    "**粗体** 和 `code`，还有 [链接](https://example.com) 与 ![图](/file/x.png)",
  );
  assert.match(html, /<strong>粗体<\/strong>/);
  assert.match(html, /<code class="motd-icode">code<\/code>/);
  assert.match(html, /<a href="https:\/\/example\.com" target="_blank"/);
  assert.match(html, /<img class="motd-img" src="\/file\/x\.png"/);
});

test("Markdown: 中文与含斜杠的标签高亮", () => {
  const html = api.renderMarkdown("#读书 #生活/日记");
  assert.match(html, /<span class="motd-tag">#读书<\/span>/);
  assert.match(html, /<span class="motd-tag">#生活\/日记<\/span>/);
});

test("Markdown: 代码块内容被转义，不会被当作 HTML 执行", () => {
  const html = api.renderMarkdown("```\n<script>alert(1)</script>\n```");
  assert.ok(!html.includes("<script>"), "代码块里的 script 标签必须被转义");
  assert.match(html, /&lt;script&gt;/);
});

test("Markdown: 正文里的原始 HTML 被转义", () => {
  const html = api.renderMarkdown('<img src=x onerror="alert(1)">');
  assert.ok(!html.includes("<img src=x"), "原始 HTML 不能原样输出");
  assert.match(html, /&lt;img/);
});

test("Markdown: 空值不报错", () => {
  assert.equal(api.renderMarkdown(""), "");
  assert.equal(api.renderMarkdown(null), "");
  assert.equal(api.renderMarkdown(undefined), "");
});

/* ================================================================ *
 * 往年今日匹配
 * ================================================================ */

// 用「本地时间中午」构造，保证在任何时区下本地日历日都是想要的那一天，
// 测试结果因此与时区无关。
const atLocal = (y, m, d, hh = 12, mm = 0) => new Date(y, m - 1, d, hh, mm, 0).toISOString();

const MEMOS = [
  memo(atLocal(2023, 10, 6)),
  memo(atLocal(2024, 10, 5)), // -1 天
  memo(atLocal(2024, 10, 6)), // 当天
  memo(atLocal(2024, 10, 7)), // +1 天
  memo(atLocal(2025, 10, 6)),
  memo(atLocal(2026, 10, 6)), // 今年，必须被排除
  memo(atLocal(2022, 9, 30)), // -6 天
  memo(atLocal(2021, 3, 1)), // 相差太远，永不命中
];

test("匹配: 只看往年同一天，今年被排除", () => {
  const r = api.collectMatches(MEMOS, new Date(2026, 9, 6), 0);
  assert.ok(!r.years.includes(2026), "今年的笔记不能出现");
  assert.equal(r.total, 3, "2023 / 2024 / 2025 各一条");
  assert.deepEqual(r.years, [2025, 2024, 2023]);
});

test("匹配: 按本地日历日计算，跨时区不会错一天", () => {
  // 本地时间的当天 00:30 和 23:30 都必须算作「当天」
  const early = memo(atLocal(2025, 10, 6, 0, 30));
  const late = memo(atLocal(2025, 10, 6, 23, 30));
  const r = api.collectMatches([early, late], new Date(2026, 9, 6), 0);
  assert.equal(r.total, 2, "一天的起点和终点都应命中");
  assert.deepEqual(
    r.groups[2025].map((x) => x.diff),
    [0, 0],
  );
});

test("匹配: ±N 天窗口生效，且带正负偏移标记", () => {
  const target = new Date(2026, 9, 6);
  const r0 = api.collectMatches(MEMOS, target, 0);
  const r1 = api.collectMatches(MEMOS, target, 1);
  const r7 = api.collectMatches(MEMOS, target, 7);

  assert.equal(r0.total, 3);
  assert.equal(r1.total, 5, "多了 2024 的 -1 天和 +1 天");
  assert.equal(r7.total, 6, "再多一条 2022-09-30（-6 天）");

  const diffs = r1.groups[2024].map((x) => x.diff);
  assert.deepEqual(diffs, [-1, 0, 1]);
});

test("匹配: 组内按时间升序", () => {
  const r = api.collectMatches(MEMOS, new Date(2026, 9, 6), 7);
  for (const year of r.years) {
    const times = r.groups[year].map((x) => x.date.getTime());
    assert.deepEqual(times, [...times].sort((a, b) => a - b), year + " 组内顺序不正确");
  }
});

test("匹配: 非法时间不会导致崩溃", () => {
  const r = api.collectMatches([memo(""), memo("not-a-date"), memo(atLocal(2024, 10, 6))], new Date(2026, 9, 6), 0);
  assert.equal(r.total, 1);
});

/* ================================================================ *
 * 安全声明（README 里承诺的事，用测试守住）
 * ================================================================ */

test("安全: 所有网络请求都是同源相对路径", () => {
  const calls = [...SOURCE.matchAll(/fetch\(\s*"([^"]*)"/g)].map((m) => m[1]);
  assert.ok(calls.length > 0, "应该能扫到 fetch 调用");
  for (const url of calls) {
    assert.ok(url.startsWith("/"), "发现非相对路径的请求：" + url);
  }
});

test("安全: 不读取浏览器 Cookie", () => {
  assert.ok(!SOURCE.includes("document.cookie"), "不应访问 document.cookie");
});

test("安全: 不使用 eval / new Function / 动态 import", () => {
  assert.ok(!/\beval\s*\(/.test(SOURCE), "不应使用 eval");
  assert.ok(!/\bnew Function\s*\(/.test(SOURCE), "不应使用 new Function");
  assert.ok(!/\bimport\s*\(/.test(SOURCE), "不应使用动态 import");
});

test("安全: 没有外部域名硬编码", () => {
  // 去掉注释后再扫，正常情况下一处都不该有
  const codeOnly = SOURCE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const urls = [...codeOnly.matchAll(/https?:\/\/[^\s"'`)]+/g)].map((m) => m[0]);
  assert.deepEqual(urls, [], "代码里不应硬编码外部地址：" + JSON.stringify(urls));
});

/* ================================================================ *
 * 发布卫生
 * ================================================================ */

test("版本号: 脚本内版本与 package.json 一致", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
  assert.equal(
    api.version,
    pkg.version,
    "发版时忘了同步版本号：脚本是 " + api.version + "，package.json 是 " + pkg.version,
  );
});
