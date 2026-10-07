# Changelog

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)，格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## [0.1.0] - 2026-10-07

首个公开版本。

### 新增

- 悬浮按钮「往年今日」，可拖动，位置记忆在本地
- 弹窗按年份倒序列出往年同一天的笔记，标题形如「3 年前的今天」
- 日期选择器（默认今天）和范围切换（当天 / ±1 天 / ±3 天 / ±7 天）
- 正文 Markdown 渲染：标题、列表、待办、引用、代码块、链接、图片、标签高亮
- 深色/浅色主题自动跟随 Memos
- 全量笔记内存缓存 5 分钟，支持手动刷新
- 复用浏览器现有登录态，不要求新建 Personal Access Token
- 纯函数单元测试，含 4 条安全声明断言

[0.1.0]: https://github.com/zhengshenrui/memos-on-this-day/releases/tag/v0.1.0
