/*!
 * Memos 往年今日 (On This Day) v0.1.0
 *
 * 作用：在 Memos 网页版右下角加一个「往年今日」悬浮按钮，
 *       点开后按年份倒序列出往年同一天（可扩到 ±N 天）自己写过的笔记。
 *
 * 安装：Memos → 设置 → 系统 → 自定义脚本，粘贴本文件全部内容 → 保存 → 刷新页面。
 * 卸载：清空「自定义脚本」输入框并保存即可，不留任何服务端痕迹。
 *
 * 依赖：只用 Memos 自带的 /api/v1 接口和当前浏览器登录态，不需要额外申请 Token。
 */
(function () {
  "use strict";

  /* ================================================================== *
   * 0. 防重复加载
   *    Memos 每次切到「系统」设置页都会重新注入一次脚本，
   *    所以这里必须做幂等保护，并且整体包在 IIFE 里避免变量重复声明。
   * ================================================================== */
  if (window.__memosOnThisDayLoaded) return;
  window.__memosOnThisDayLoaded = true;

  var VERSION = "0.1.0";

  var CFG = {
    pageSize: 1000, // 每页条数，Memos 单页上限 1000
    maxPages: 40, // 最多翻多少页，防止极端情况失控
    cacheTTL: 5 * 60 * 1000, // 全量笔记内存缓存时长
    tokenKey: "memos_access_token",
    tokenExpKey: "memos_token_expires_at",
    tokenChannel: "memos_token_sync",
    posKey: "memos-on-this-day:pos",
    rangeKey: "memos-on-this-day:range",
  };

  var RANGES = [
    { v: 0, label: "当天" },
    { v: 1, label: "±1 天" },
    { v: 3, label: "±3 天" },
    { v: 7, label: "±7 天" },
  ];

  var WEEKDAYS = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];

  /* ================================================================== *
   * 1. 小工具
   * ================================================================== */

  function pad2(n) {
    return n < 10 ? "0" + n : "" + n;
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function fmtDate(d) {
    return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
  }

  function fmtTime(d) {
    return pad2(d.getHours()) + ":" + pad2(d.getMinutes());
  }

  function weekdayOf(d) {
    return WEEKDAYS[d.getDay()] || "";
  }

  function todayDate() {
    var n = new Date();
    return new Date(n.getFullYear(), n.getMonth(), n.getDate());
  }

  function parseDateInput(v) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v || "");
    if (!m) return todayDate();
    return new Date(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10));
  }

  function storageGet(key, fallback) {
    try {
      var v = localStorage.getItem(key);
      return v === null ? fallback : v;
    } catch (e) {
      return fallback;
    }
  }

  function storageSet(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch (e) {
      /* 隐私模式下可能写不进去，忽略 */
    }
  }

  /** 判断当前 Memos 是深色还是浅色主题，用于让弹窗配色跟随。 */
  function detectDark() {
    try {
      var html = document.documentElement;
      var body = document.body;
      if (html.classList.contains("dark") || (body && body.classList.contains("dark"))) return true;
    } catch (e) {
      /* ignore */
    }
    var probes = [document.body, document.documentElement];
    for (var i = 0; i < probes.length; i++) {
      var el = probes[i];
      if (!el) continue;
      try {
        var bg = getComputedStyle(el).backgroundColor || "";
        var m = /rgba?\(([^)]+)\)/.exec(bg);
        if (!m) continue;
        var parts = m[1].split(",").map(function (x) {
          return parseFloat(x);
        });
        var alpha = parts.length > 3 ? parts[3] : 1;
        if (!(alpha > 0.2)) continue;
        var lum = (0.2126 * parts[0] + 0.7152 * parts[1] + 0.0722 * parts[2]) / 255;
        if (!isNaN(lum)) return lum < 0.5;
      } catch (e) {
        /* ignore */
      }
    }
    try {
      return window.matchMedia("(prefers-color-scheme: dark)").matches;
    } catch (e) {
      return false;
    }
  }

  /* ================================================================== *
   * 2. 轻量 Markdown 渲染
   *    先把内容整体转义，再做替换，避免笔记里的 HTML 被执行。
   * ================================================================== */

  function renderMarkdown(src) {
    var codeBlocks = [];
    var text = String(src == null ? "" : src).replace(/\r\n?/g, "\n");

    // 2.1 先抽出围栏代码块
    text = text.replace(/```([^\n`]*)\n?([\s\S]*?)```/g, function (_m, _lang, code) {
      codeBlocks.push(code.replace(/\n$/, ""));
      return "\u0000B" + (codeBlocks.length - 1) + "\u0000";
    });

    // 2.2 整体转义
    text = escapeHtml(text);

    // 2.3 行内代码（此时已是转义后的文本，取出后原样放回即可）
    var inlineCodes = [];
    text = text.replace(/`([^`\n]+)`/g, function (_m, code) {
      inlineCodes.push(code);
      return "\u0000I" + (inlineCodes.length - 1) + "\u0000";
    });

    // 2.4 行内语法
    text = text
      .replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g, function (_m, alt, url) {
        return '<img class="motd-img" src="' + url + '" alt="' + alt + '" loading="lazy">';
      })
      .replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g, function (_m, label, url) {
        return '<a href="' + url + '" target="_blank" rel="noopener noreferrer">' + label + "</a>";
      })
      .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, function (_m, pre, url) {
        return pre + '<a href="' + url + '" target="_blank" rel="noopener noreferrer">' + url + "</a>";
      })
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/~~([^~]+)~~/g, "<del>$1</del>")
      .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
      .replace(/(^|[\s(])#([\p{L}\p{N}_\/\-.]+)/gmu, '$1<span class="motd-tag">#$2</span>');

    // 2.5 逐行处理块级语法
    var lines = text.split("\n");
    var out = [];
    var i = 0;

    function isListLine(line) {
      return /^\s*([-*+]|\d+\.)\s+/.test(line);
    }
    function isBlockStart(line) {
      return (
        /^(#{1,6})\s+/.test(line) ||
        /^(&gt;|>)\s?/.test(line) ||
        isListLine(line) ||
        /^\u0000B\d+\u0000$/.test(line.trim())
      );
    }

    while (i < lines.length) {
      var line = lines[i];

      if (line.trim() === "") {
        i++;
        continue;
      }

      var cb = /^\u0000B(\d+)\u0000$/.exec(line.trim());
      if (cb) {
        out.push('<pre class="motd-code"><code>' + escapeHtml(codeBlocks[parseInt(cb[1], 10)]) + "</code></pre>");
        i++;
        continue;
      }

      var heading = /^(#{1,6})\s+(.*)$/.exec(line);
      if (heading) {
        var level = Math.min(heading[1].length + 2, 6);
        out.push("<h" + level + ' class="motd-h">' + heading[2] + "</h" + level + ">");
        i++;
        continue;
      }

      if (/^(&gt;|>)\s?/.test(line)) {
        var quote = [];
        while (i < lines.length && /^(&gt;|>)\s?/.test(lines[i])) {
          quote.push(lines[i].replace(/^(&gt;|>)\s?/, ""));
          i++;
        }
        out.push('<blockquote class="motd-quote">' + quote.join("<br>") + "</blockquote>");
        continue;
      }

      if (isListLine(line)) {
        var ordered = /^\s*\d+\.\s+/.test(line);
        var items = [];
        while (i < lines.length && isListLine(lines[i])) {
          var item = lines[i].replace(/^\s*([-*+]|\d+\.)\s+/, "");
          var task = /^\[([ xX])\]\s+(.*)$/.exec(item);
          if (task) {
            item = (task[1].toLowerCase() === "x" ? "☑ " : "☐ ") + task[2];
          }
          items.push("<li>" + item + "</li>");
          i++;
        }
        out.push(
          (ordered ? '<ol class="motd-list">' : '<ul class="motd-list">') +
            items.join("") +
            (ordered ? "</ol>" : "</ul>"),
        );
        continue;
      }

      var buf = [];
      while (i < lines.length && lines[i].trim() !== "" && !isBlockStart(lines[i])) {
        buf.push(lines[i]);
        i++;
      }
      out.push('<p class="motd-p">' + buf.join("<br>") + "</p>");
    }

    return out.join("").replace(/\u0000I(\d+)\u0000/g, function (_m, n) {
      return '<code class="motd-icode">' + inlineCodes[parseInt(n, 10)] + "</code>";
    });
  }

  /* ================================================================== *
   * 3. 登录态：复用当前浏览器会话，不额外要 Token
   * ================================================================== */

  function readStoredToken() {
    var token = "";
    var exp = 0;
    try {
      token = localStorage.getItem(CFG.tokenKey) || "";
      var raw = localStorage.getItem(CFG.tokenExpKey);
      if (raw) exp = new Date(raw).getTime() || 0;
    } catch (e) {
      /* ignore */
    }
    return { token: token, exp: exp };
  }

  /** 用浏览器里的 refresh Cookie 换一个新的 access token，并同步回 localStorage。 */
  function refreshToken() {
    return fetch("/api/v1/auth/refresh", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    })
      .then(function (res) {
        if (!res.ok) throw new Error("登录状态已失效，请刷新页面重新登录");
        return res.json();
      })
      .then(function (data) {
        var token = data.accessToken || data.access_token || "";
        if (!token) throw new Error("登录状态已失效，请刷新页面重新登录");
        var iso = data.expiresAt || data.expires_at || "";
        try {
          localStorage.setItem(CFG.tokenKey, token);
          if (iso) localStorage.setItem(CFG.tokenExpKey, new Date(iso).toISOString());
          if (window.BroadcastChannel) {
            var ch = new BroadcastChannel(CFG.tokenChannel);
            ch.postMessage({
              token: token,
              expiresAt: iso ? new Date(iso).toISOString() : new Date(Date.now() + 30 * 60 * 1000).toISOString(),
            });
            ch.close();
          }
        } catch (e) {
          /* ignore */
        }
        return token;
      })
      .catch(function (e) {
        if (e && e.message) throw e;
        throw new Error("网络异常，无法刷新登录态");
      });
  }

  function getToken() {
    var s = readStoredToken();
    if (s.token && (!s.exp || s.exp - 30000 > Date.now())) return Promise.resolve(s.token);
    return refreshToken();
  }

  /* ================================================================== *
   * 4. 数据
   * ================================================================== */

  var cache = { memos: null, at: 0 };

  function fetchAllMemos(token, onProgress) {
    var out = [];
    var pageToken = "";
    var page = 0;

    function next() {
      if (page >= CFG.maxPages) return Promise.resolve(out);
      page++;
      var qs = new URLSearchParams();
      qs.set("pageSize", String(CFG.pageSize));
      if (pageToken) qs.set("pageToken", pageToken);

      return fetch("/api/v1/memos?" + qs.toString(), {
        method: "GET",
        credentials: "same-origin",
        headers: { Authorization: "Bearer " + token, Accept: "application/json" },
      }).then(function (res) {
        if (res.status === 401) {
          var err = new Error("登录状态已失效");
          err.status = 401;
          throw err;
        }
        if (!res.ok) {
          var e2 = new Error("读取笔记失败（HTTP " + res.status + "）");
          e2.status = res.status;
          throw e2;
        }
        return res.json();
      }).then(function (data) {
        var list = Array.isArray(data.memos) ? data.memos : [];
        out = out.concat(list);
        if (onProgress) onProgress("已读取 " + out.length + " 条笔记…");
        pageToken = data.nextPageToken || data.next_page_token || "";
        if (!pageToken || list.length === 0) return out;
        return next();
      });
    }

    return next();
  }

  /** 拉取全量笔记（带内存缓存）。评论类笔记（带 parent）会被剔除。 */
  function loadAll(force, onProgress) {
    if (!force && cache.memos && Date.now() - cache.at < CFG.cacheTTL) {
      return Promise.resolve(cache.memos);
    }

    function run(token) {
      return fetchAllMemos(token, onProgress).then(function (all) {
        var kept = all.filter(function (m) {
          return m && typeof m.content === "string" && !m.parent;
        });
        cache = { memos: kept, at: Date.now() };
        return kept;
      });
    }

    return getToken().then(function (token) {
      return run(token).catch(function (e) {
        if (e && e.status === 401) {
          return refreshToken().then(function (fresh) {
            return run(fresh);
          });
        }
        throw e;
      });
    });
  }

  /* ================================================================== *
   * 5. 匹配「往年今日」
   * ================================================================== */

  /**
   * @param {Array} memos      全量笔记
   * @param {Date}  targetDate 目标日期（只看这一天所在年份之前的年份）
   * @param {number} windowDays 前后放宽天数
   */
  function collectMatches(memos, targetDate, windowDays) {
    var ty = targetDate.getFullYear();
    var tm = targetDate.getMonth() + 1;
    var td = targetDate.getDate();
    var groups = {};
    var total = 0;

    for (var i = 0; i < memos.length; i++) {
      var memo = memos[i];
      var d = new Date(memo.createTime || memo.create_time || "");
      if (isNaN(d.getTime())) continue;

      var y = d.getFullYear();
      if (y >= ty) continue; // 只看过往年份

      // 按「本地日历日」比较，避免用小时差算天数（跨时区会错一天）
      var day = new Date(d.getFullYear(), d.getMonth(), d.getDate());
      var anchor = new Date(y, tm - 1, td);
      var diff = Math.round((day.getTime() - anchor.getTime()) / 86400000);
      if (Math.abs(diff) > windowDays) continue;

      if (!groups[y]) groups[y] = [];
      groups[y].push({ memo: memo, date: d, diff: diff });
      total++;
    }

    var years = Object.keys(groups)
      .map(function (k) {
        return parseInt(k, 10);
      })
      .sort(function (a, b) {
        return b - a;
      });

    years.forEach(function (y) {
      groups[y].sort(function (a, b) {
        return a.date - b.date;
      });
    });

    return { years: years, groups: groups, total: total };
  }

  function memoUid(memo) {
    var name = memo.name || "";
    return name.indexOf("memos/") === 0 ? name.slice(6) : name;
  }

  function memoTags(memo) {
    var tags = Array.isArray(memo.tags) ? memo.tags : [];
    return tags
      .map(function (t) {
        var s = String(t || "").trim();
        if (!s) return "";
        return s.charAt(0) === "#" ? s : "#" + s;
      })
      .filter(function (t, idx, arr) {
        return t && arr.indexOf(t) === idx;
      });
  }

  /* ================================================================== *
   * 6. 样式
   * ================================================================== */

  var STYLE_ID = "motd-style";

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;

    var css = [
      "#motd-root{",
      "--motd-bg:var(--card,#ffffff);",
      "--motd-fg:var(--card-foreground,var(--foreground,#18181b));",
      "--motd-border:var(--border,rgba(0,0,0,.10));",
      "--motd-muted:var(--muted-foreground,#71717a);",
      "--motd-soft:var(--muted,#f4f4f5);",
      "--motd-accent:var(--primary,#2563eb);",
      "--motd-shadow:0 10px 30px rgba(0,0,0,.16);",
      "}",
      '#motd-root[data-theme="dark"]{',
      "--motd-bg:var(--card,#1b1b1f);",
      "--motd-fg:var(--card-foreground,var(--foreground,#e4e4e7));",
      "--motd-border:var(--border,rgba(255,255,255,.14));",
      "--motd-muted:var(--muted-foreground,#a1a1aa);",
      "--motd-soft:var(--muted,#26262b);",
      "--motd-accent:var(--primary,#7aa2f7);",
      "--motd-shadow:0 10px 30px rgba(0,0,0,.55);",
      "}",

      "#motd-fab{position:fixed;z-index:2147483000;right:20px;bottom:20px;",
      "display:inline-flex;align-items:center;gap:8px;height:44px;padding:0 16px;",
      "border-radius:999px;border:1px solid var(--motd-border);background:var(--motd-bg);",
      "color:var(--motd-fg);font-size:14px;font-weight:500;line-height:1;cursor:pointer;",
      "box-shadow:var(--motd-shadow);-webkit-user-select:none;user-select:none;",
      "touch-action:none;font-family:inherit;transition:transform .15s ease;}",
      "#motd-fab:hover{transform:translateY(-1px);}",
      "#motd-fab:active{transform:scale(.96);}",
      "#motd-fab svg{width:18px;height:18px;flex:none;color:var(--motd-accent);}",
      "#motd-fab[hidden]{display:none!important;}",
      "#motd-root.motd-open #motd-fab{display:none!important;}",

      "#motd-overlay{position:fixed;inset:0;z-index:2147483001;display:flex;",
      "align-items:center;justify-content:center;padding:16px;background:rgba(0,0,0,.45);",
      "-webkit-backdrop-filter:blur(2px);backdrop-filter:blur(2px);}",
      "#motd-panel{width:min(760px,100%);max-height:min(86vh,900px);display:flex;",
      "flex-direction:column;background:var(--motd-bg);color:var(--motd-fg);",
      "border:1px solid var(--motd-border);border-radius:16px;overflow:hidden;",
      "box-shadow:0 24px 60px rgba(0,0,0,.35);font-family:inherit;}",

      "#motd-head{display:flex;align-items:center;gap:10px;padding:14px 16px;",
      "border-bottom:1px solid var(--motd-border);}",
      "#motd-title{font-size:16px;font-weight:600;}",
      "#motd-sub{font-size:12px;color:var(--motd-muted);}",
      "#motd-close{margin-left:auto;width:32px;height:32px;border-radius:8px;",
      "border:1px solid transparent;background:transparent;color:var(--motd-muted);",
      "font-size:18px;line-height:1;cursor:pointer;font-family:inherit;}",
      "#motd-close:hover{background:var(--motd-soft);color:var(--motd-fg);}",

      "#motd-tools{display:flex;flex-wrap:wrap;align-items:center;gap:8px;",
      "padding:10px 16px;border-bottom:1px solid var(--motd-border);}",
      ".motd-input{height:32px;padding:0 10px;border-radius:8px;",
      "border:1px solid var(--motd-border);background:var(--motd-bg);color:var(--motd-fg);",
      "font-size:13px;font-family:inherit;}",
      '#motd-root[data-theme="dark"] .motd-input{color-scheme:dark;}',
      ".motd-seg{display:inline-flex;border:1px solid var(--motd-border);",
      "border-radius:8px;overflow:hidden;}",
      ".motd-seg button{height:32px;padding:0 12px;border:0;background:transparent;",
      "color:var(--motd-muted);font-size:13px;cursor:pointer;font-family:inherit;}",
      ".motd-seg button+button{border-left:1px solid var(--motd-border);}",
      ".motd-seg button.is-on{background:var(--motd-accent);color:#fff;}",
      ".motd-btn{height:32px;padding:0 14px;border-radius:8px;",
      "border:1px solid var(--motd-border);background:var(--motd-bg);color:var(--motd-fg);",
      "font-size:13px;cursor:pointer;font-family:inherit;}",
      ".motd-btn:hover{background:var(--motd-soft);}",
      ".motd-link-btn{height:32px;padding:0 6px;border:0;background:transparent;",
      "color:var(--motd-accent);font-size:13px;cursor:pointer;font-family:inherit;}",
      ".motd-spacer{flex:1 1 auto;}",

      "#motd-body{flex:1 1 auto;overflow-y:auto;padding:4px 16px 16px;",
      "-webkit-overflow-scrolling:touch;}",
      "#motd-foot{padding:10px 16px;border-top:1px solid var(--motd-border);",
      "font-size:12px;color:var(--motd-muted);display:flex;align-items:center;gap:8px;}",

      ".motd-year{display:flex;align-items:baseline;gap:8px;margin:16px 0 8px;}",
      ".motd-year b{font-size:15px;font-weight:600;}",
      ".motd-year span{font-size:12px;color:var(--motd-muted);}",
      ".motd-card{border:1px solid var(--motd-border);border-radius:12px;",
      "padding:10px 12px;margin-bottom:10px;background:var(--motd-soft);}",
      ".motd-meta{display:flex;align-items:center;gap:8px;margin-bottom:6px;",
      "font-size:12px;color:var(--motd-muted);}",
      ".motd-meta a{margin-left:auto;color:var(--motd-accent);text-decoration:none;}",
      ".motd-meta a:hover{text-decoration:underline;}",
      ".motd-delta{font-size:11px;padding:1px 6px;border-radius:999px;",
      "border:1px solid var(--motd-border);}",
      ".motd-content{font-size:14px;line-height:1.7;word-break:break-word;}",
      ".motd-content .motd-p{margin:.3em 0;}",
      ".motd-content .motd-h{margin:.6em 0 .3em;font-size:1.05em;font-weight:600;}",
      ".motd-content .motd-list{margin:.35em 0;padding-left:1.35em;}",
      ".motd-content .motd-quote{margin:.4em 0;padding:.2em .8em;",
      "border-left:3px solid var(--motd-border);color:var(--motd-muted);}",
      ".motd-content .motd-icode{background:var(--motd-bg);padding:.12em .35em;",
      "border-radius:4px;font-size:.9em;",
      "font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;}",
      ".motd-content .motd-code{background:var(--motd-bg);padding:10px 12px;",
      "border-radius:8px;overflow-x:auto;margin:.5em 0;}",
      ".motd-content .motd-code code{font-size:.85em;",
      "font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;}",
      ".motd-content .motd-img{max-width:100%;border-radius:8px;margin:.3em 0;display:block;}",
      ".motd-content a{color:var(--motd-accent);text-decoration:none;}",
      ".motd-content a:hover{text-decoration:underline;}",
      ".motd-content .motd-tag{color:var(--motd-accent);}",
      ".motd-tags{margin-top:8px;display:flex;flex-wrap:wrap;gap:6px;}",
      ".motd-tags span{font-size:12px;color:var(--motd-accent);}",

      ".motd-state{padding:36px 12px;text-align:center;color:var(--motd-muted);font-size:14px;}",
      ".motd-state b{display:block;color:var(--motd-fg);font-weight:600;margin-bottom:6px;}",
      ".motd-spin{width:16px;height:16px;border-radius:50%;display:inline-block;",
      "vertical-align:-2px;margin-right:8px;border:2px solid var(--motd-border);",
      "border-top-color:var(--motd-accent);animation:motd-rot .8s linear infinite;}",
      "@keyframes motd-rot{to{transform:rotate(360deg)}}",

      "@media (max-width:560px){",
      "#motd-fab{right:12px;bottom:calc(12px + env(safe-area-inset-bottom,0px));height:40px;padding:0 14px;font-size:13px;}",
      "#motd-overlay{padding:0;align-items:stretch;}",
      "#motd-panel{width:100%;max-height:100%;border-radius:0;border:0;}",
      "#motd-body{padding-left:12px;padding-right:12px;}",
      "}",
      "@media (max-width:400px){",
      "#motd-fab .motd-fab-text{display:none;}",
      "#motd-fab{padding:0 12px;}",
      "}",
    ].join("");

    var style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = css;
    document.head.appendChild(style);
  }

  /* ================================================================== *
   * 7. 界面
   * ================================================================== */

  var root = null;
  var fab = null;
  var overlay = null;
  var bodyEl = null;

  var state = {
    open: false,
    loading: false,
    error: "",
    progress: "",
    date: todayDate(),
    range: parseInt(storageGet(CFG.rangeKey, "0"), 10) || 0,
  };
  if (!RANGES.some(function (r) { return r.v === state.range; })) state.range = 0;

  var FAB_ICON =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
    'stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/>' +
    '<path d="M3 3v5h5"/><path d="M12 7v5l3 2"/></svg>';

  function updateTheme() {
    if (root) root.setAttribute("data-theme", detectDark() ? "dark" : "light");
  }

  function mountFab() {
    root = document.createElement("div");
    root.id = "motd-root";
    updateTheme();

    fab = document.createElement("button");
    fab.id = "motd-fab";
    fab.type = "button";
    fab.title = "往年今日";
    fab.setAttribute("aria-label", "往年今日");
    fab.innerHTML = FAB_ICON + '<span class="motd-fab-text">往年今日</span>';
    root.appendChild(fab);

    document.body.appendChild(root);
    restoreFabPosition();
    wireFab();
  }

  /* ---- 悬浮按钮位置（可拖动，位置记忆在本地） ---- */

  function applyFabPosition(pos) {
    if (!fab) return;
    if (!pos || typeof pos.right !== "number" || typeof pos.bottom !== "number") return;
    fab.style.right = "auto";
    fab.style.bottom = "auto";
    fab.style.left = "auto";
    fab.style.top = "auto";
    fab.style.right = Math.max(0, pos.right) + "px";
    fab.style.bottom = Math.max(0, pos.bottom) + "px";
  }

  function restoreFabPosition() {
    var raw = storageGet(CFG.posKey, "");
    if (!raw) return;
    try {
      applyFabPosition(JSON.parse(raw));
    } catch (e) {
      /* ignore */
    }
  }

  function wireFab() {
    var drag = null;
    var moved = false;

    fab.addEventListener("pointerdown", function (ev) {
      if (ev.button !== undefined && ev.button !== 0) return;
      var rect = fab.getBoundingClientRect();
      drag = {
        x: ev.clientX,
        y: ev.clientY,
        right: window.innerWidth - rect.right,
        bottom: window.innerHeight - rect.bottom,
      };
      moved = false;
      try {
        fab.setPointerCapture(ev.pointerId);
      } catch (e) {
        /* ignore */
      }
    });

    fab.addEventListener("pointermove", function (ev) {
      if (!drag) return;
      var dx = ev.clientX - drag.x;
      var dy = ev.clientY - drag.y;
      if (!moved && Math.abs(dx) + Math.abs(dy) < 6) return;
      moved = true;
      var pos = {
        right: Math.min(Math.max(drag.right - dx, 4), window.innerWidth - 56),
        bottom: Math.min(Math.max(drag.bottom - dy, 4), window.innerHeight - 56),
      };
      applyFabPosition(pos);
    });

    function endDrag(ev) {
      if (!drag) return;
      var wasMoved = moved;
      drag = null;
      moved = false;
      try {
        fab.releasePointerCapture(ev.pointerId);
      } catch (e) {
        /* ignore */
      }
      if (!wasMoved) return;
      fab.dataset.motdDragged = "1";
      var rect = fab.getBoundingClientRect();
      storageSet(
        CFG.posKey,
        JSON.stringify({
          right: Math.round(window.innerWidth - rect.right),
          bottom: Math.round(window.innerHeight - rect.bottom),
        }),
      );
    }

    fab.addEventListener("pointerup", endDrag);
    fab.addEventListener("pointercancel", endDrag);

    fab.addEventListener("click", function (ev) {
      // 拖动结束后的 click 不当作点击
      if (fab.dataset.motdDragged === "1") {
        fab.dataset.motdDragged = "";
        ev.preventDefault();
        return;
      }
      openPanel();
    });
  }

  /** 登录页等场景隐藏按钮 */
  function syncFabVisibility() {
    if (!fab) return;
    var hidden = /^\/auth(\/|$)/.test(location.pathname);
    if (hidden !== fab.hidden) fab.hidden = hidden;
  }

  /* ---- 弹窗 ---- */

  function buildPanel() {
    overlay = document.createElement("div");
    overlay.id = "motd-overlay";
    overlay.innerHTML = [
      '<div id="motd-panel" role="dialog" aria-modal="true" aria-label="往年今日">',
      '  <div id="motd-head">',
      '    <div><div id="motd-title">往年今日</div><div id="motd-sub"></div></div>',
      '    <button id="motd-close" type="button" aria-label="关闭">✕</button>',
      "  </div>",
      '  <div id="motd-tools">',
      '    <input class="motd-input" id="motd-date" type="date">',
      '    <button class="motd-link-btn" id="motd-today" type="button">回到今天</button>',
      '    <div class="motd-seg" id="motd-seg"></div>',
      '    <div class="motd-spacer"></div>',
      '    <button class="motd-btn" id="motd-refresh" type="button">刷新</button>',
      "  </div>",
      '  <div id="motd-body"></div>',
      '  <div id="motd-foot"></div>',
      "</div>",
    ].join("");

    root.appendChild(overlay);
    bodyEl = overlay.querySelector("#motd-body");

    // 范围切换
    var seg = overlay.querySelector("#motd-seg");
    RANGES.forEach(function (r) {
      var b = document.createElement("button");
      b.type = "button";
      b.dataset.window = String(r.v);
      b.textContent = r.label;
      b.addEventListener("click", function () {
        state.range = r.v;
        storageSet(CFG.rangeKey, String(r.v));
        syncTools();
        renderBody();
      });
      seg.appendChild(b);
    });

    // 日期
    overlay.querySelector("#motd-date").addEventListener("change", function (ev) {
      state.date = parseDateInput(ev.target.value);
      syncTools();
      renderBody();
    });

    overlay.querySelector("#motd-today").addEventListener("click", function () {
      state.date = todayDate();
      syncTools();
      renderBody();
    });

    overlay.querySelector("#motd-refresh").addEventListener("click", function () {
      load(true);
    });

    overlay.querySelector("#motd-close").addEventListener("click", closePanel);

    overlay.addEventListener("mousedown", function (ev) {
      if (ev.target === overlay) closePanel();
    });
  }

  function syncTools() {
    if (!overlay) return;
    overlay.querySelector("#motd-date").value = fmtDate(state.date);

    var isToday = fmtDate(state.date) === fmtDate(todayDate());
    overlay.querySelector("#motd-today").style.visibility = isToday ? "hidden" : "visible";

    var btns = overlay.querySelectorAll("#motd-seg button");
    for (var i = 0; i < btns.length; i++) {
      var on = parseInt(btns[i].dataset.window, 10) === state.range;
      btns[i].classList.toggle("is-on", on);
    }

    var sub = overlay.querySelector("#motd-sub");
    sub.textContent =
      fmtDate(state.date) + " " + weekdayOf(state.date) + (state.range > 0 ? " · 前后 " + state.range + " 天" : "");
  }

  function openPanel() {
    if (state.open) return;
    updateTheme();
    if (!overlay) buildPanel();
    overlay.style.display = "flex";
    root.classList.add("motd-open");
    state.open = true;
    syncTools();
    renderBody();
    document.addEventListener("keydown", onKeydown, true);
    load();
  }

  function closePanel() {
    if (!state.open) return;
    state.open = false;
    if (root) root.classList.remove("motd-open");
    if (overlay) overlay.style.display = "none";
    document.removeEventListener("keydown", onKeydown, true);
  }

  function onKeydown(ev) {
    if (ev.key === "Escape") {
      closePanel();
      ev.stopPropagation();
    }
  }

  /* ---- 数据加载 ---- */

  function load(force) {
    if (state.loading) return;
    state.loading = true;
    state.error = "";
    state.progress = "正在读取笔记…";
    renderBody();

    loadAll(!!force || !cache.memos, function (msg) {
      state.progress = msg;
      renderBody();
    })
      .then(function () {
        state.loading = false;
        state.progress = "";
        renderBody();
      })
      .catch(function (err) {
        state.loading = false;
        state.progress = "";
        state.error = (err && err.message) || "加载失败，请稍后重试";
        renderBody();
      });
  }

  /* ---- 渲染结果 ---- */

  function renderBody() {
    if (!overlay || !bodyEl) return;

    if (state.loading) {
      bodyEl.innerHTML =
        '<div class="motd-state"><span class="motd-spin"></span>' + escapeHtml(state.progress || "加载中…") + "</div>";
      renderFoot();
      return;
    }

    if (state.error) {
      bodyEl.innerHTML =
        '<div class="motd-state"><b>没能读到笔记</b>' + escapeHtml(state.error) + "</div>";
      renderFoot();
      return;
    }

    if (!cache.memos) {
      bodyEl.innerHTML = '<div class="motd-state">准备中…</div>';
      renderFoot();
      return;
    }

    var result = collectMatches(cache.memos, state.date, state.range);

    if (result.total === 0) {
      var tip = state.range === 0 ? "可以试试把范围扩大到 ±7 天。" : "换一天看看？";
      bodyEl.innerHTML =
        '<div class="motd-state"><b>往年这一天还没有笔记</b>' + escapeHtml(tip) + "</div>";
      renderFoot(result);
      return;
    }

    var html = [];
    result.years.forEach(function (year) {
      var items = result.groups[year];
      var yearsAgo = state.date.getFullYear() - year;
      html.push(
        '<div class="motd-year"><b>' +
          yearsAgo +
          " 年前的今天</b><span>" +
          year +
          " 年 · " +
          items.length +
          " 条</span></div>",
      );

      items.forEach(function (item) {
        var memo = item.memo;
        var d = item.date;
        var uid = memoUid(memo);
        var contentHtml = renderMarkdown(memo.content);
        html.push('<div class="motd-card">');
        html.push('<div class="motd-meta">');
        html.push("<span>" + fmtDate(d) + " " + weekdayOf(d) + " " + fmtTime(d) + "</span>");
        if (item.diff !== 0) {
          html.push('<span class="motd-delta">' + (item.diff > 0 ? "+" : "") + item.diff + " 天</span>");
        }
        if (uid) {
          html.push(
            '<a href="/memos/' + encodeURIComponent(uid) + '" target="_blank" rel="noopener noreferrer">打开</a>',
          );
        }
        html.push("</div>");
        html.push('<div class="motd-content">' + contentHtml + "</div>");

        var tags = memoTags(memo);
        // 正文里已经高亮过标签就不再重复列一遍
        if (tags.length && contentHtml.indexOf("motd-tag") === -1) {
          html.push(
            '<div class="motd-tags">' +
              tags
                .map(function (t) {
                  return "<span>" + escapeHtml(t) + "</span>";
                })
                .join("") +
              "</div>",
          );
        }
        html.push("</div>");
      });
    });

    bodyEl.innerHTML = html.join("");
    renderFoot(result);
  }

  function renderFoot(result) {
    var foot = overlay && overlay.querySelector("#motd-foot");
    if (!foot) return;

    if (state.loading || state.error || !cache.memos) {
      foot.textContent = "";
      return;
    }

    var matched = result ? result.total : 0;
    var cachedAt = new Date(cache.at);
    foot.innerHTML =
      "<span>共扫描 " +
      cache.memos.length +
      " 条笔记 · 匹配 " +
      matched +
      " 条</span><span class=\"motd-spacer\"></span><span>数据缓存于 " +
      fmtTime(cachedAt) +
      " · v" +
      VERSION +
      "</span>";
  }

  /* ================================================================== *
   * 8. 启动
   * ================================================================== */

  // 方便在浏览器控制台排查：__memosOnThisDay.renderMarkdown("...")
  window.__memosOnThisDay = {
    version: VERSION,
    renderMarkdown: renderMarkdown,
    collectMatches: collectMatches,
    open: function () {
      openPanel();
    },
  };

  function boot() {
    if (!document.body) {
      setTimeout(boot, 200);
      return;
    }
    injectStyles();
    mountFab();
    syncFabVisibility();
    setInterval(syncFabVisibility, 1500);

    // 系统深浅色切换时同步弹窗配色
    try {
      var mq = window.matchMedia("(prefers-color-scheme: dark)");
      if (mq && mq.addEventListener) mq.addEventListener("change", updateTheme);
    } catch (e) {
      /* ignore */
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
})();
