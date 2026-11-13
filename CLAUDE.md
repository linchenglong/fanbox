# FanBox 二开仓（fork 自 alchaincyf/fanbox）

个人二开版：Codex 式 session 驾驶舱。上游是活跃项目，**一切改动以「能持续吃上游更新」为第一约束**。

## 仓库与分支纪律

- `origin` = linchenglong/fanbox（自己的 fork，可推）；`upstream` = alchaincyf/fanbox（**push 已物理禁用**，只读）
- 主干是 `master`（沿上游命名）。开发一律走分支（`feat/xxx`、`fix/xxx`）→ 合回 master → 推 origin
- tag 规范：自己的交付 tag 带前缀 `<功能>-<期次>-v<SemVer>`（如 `cockpit-p1-v1.0.0`）；`base-<sha>` 是 fork 基线标记。裸 `vX.Y.Z` 全是上游的，不要动
- 吃上游更新：`git fetch upstream && git merge upstream/master`，冲突集中在 app.js/style.css（package-lock.json 冲突直接重新生成）

## 二开代码标记（merge 时的救命索）

所有二开代码块用注释围起，认领用（**必须 `-a`**：`app.js` 含 7 个上游遗留的 NUL 字节，不带会被当二进制文件跳过，漏掉二开最多的那个文件）：

```
grep -an "==== 二开" server.js public/app.js public/style.css electron/main.js electron/preload.js electron/wechat/env.js
```

改二开功能时保持这个标记习惯；改上游代码时**不加标记、最小 diff**。

## 二开功能地图（详细机制见 docs/FORK.md）

| 功能 | 服务端 | 前端 |
|---|---|---|
| cockpit 布局（隐藏文件区） | — | app.js `applyCockpit`/`fbCockpit`，style.css `#app.cockpit` |
| 按 tab 隔离的终端右侧文件预览 | `/api/locate`（附带单文件 `entry`） | `cockpitPreview`（`s.cockpitFile` 随 `term.activate` 切换）、`#term-body` 右侧挂载 `#preview`、`openTermPath`（含 `file://` 与 `:line` 跳行） |
| Office 三件套原地预览 | `/api/office`（OOXML `zlib` 直解 + LibreOffice PDF 缓存 + `textutil`/`xlrd` 兜底） | `renderOfficePreview`（Excel 多 Sheet 表 / Word 富文本含图 / PPT 原版 PDF·卡片流） |
| 原模型记忆续接 / 重启自动恢复 tab | `parseClaudeSession` & `agyConvMeta` + `readDefaultAgentModels`（默认模型置空 `resumeModel`） | `buildSessionResumeCmd`（仅非默认模型拼 `--model '...'`，默认模型走裸续接）、`persistTabs`/`restore` |
| 侧栏双引擎 session 列表 | `/api/agent-sessions`（Claude jsonl + Agy SQLite）、`/api/session-name` | app.js `loadAgentProjects`/`sessLi`/`openSession`、引擎图标 `.sess-agent-ic` |
| 四态状态圆点（侧栏+tab 同源） | `decideSessionStatus`（Claude）/ `decideAgySessionStatus`（Agy） | `SESS_STATUS`、`.sess-dot.st-*`、`.tab-dot.st-*` |
| open 探活 / 防双开 | `liveClaudeSessionIds`、`liveAgySessions`（presence 锁）、`/api/session-host` | `refreshSessionOpenState`、`openSession` 三级判定 |
| tab 会话名标题 / 引擎标 / 置顶 | — | `syncSessTabTitles`、`.tab-agent-ic`、`adoptByHost`（反向认领）、`togglePinSession`（⋯ 菜单） |
| 输入框 ↑/↓ 边界移动 | — | app.js `arrowBoundary`（屏读判定，注意 NBSP 与 alt-screen 坑） |
| 蓝莓皮肤 Adeberry | — | `[data-theme="adeberry"]`（色值源自 Warp 官方） |
| 终端字体/垫图/滚速 / agy 专版优化 | — | `term.setFont`/`term.setBg`、滚轮接管、`term.applyAgentStyle` + `.is-agy`（仅 `agy` 行高 1.42 + 垫图柔暗） |
| tab 拖拽排序 | — | renderTabs 内 HTML5 drag（x-fanbox-tab 类型隔离文件投喂） |
| 选图对话框桥 | electron `ui:pick-image` | `window.fanboxUi.pickImage` |

## 配置键速查

- `~/.fanbox/config.json`：`sessionResumeCmd`（默认 `claudex -r {id}`）、`sessionNewCmd`（默认 `claudex`）、`agyResumeCmd`（默认 `agy --conversation {id}`）、`agyNewCmd`（默认 `agy`）、`sessionNames`（改名 map）、`sessionActiveWindowMs`（running 活跃窗，默认 60000）
- localStorage：`fb_cockpit`、`fb_cockpit_pvw`（终端右侧预览宽）、`fb_term_tabs`（含会话 ID/引擎/非默认模型/右侧文件的恢复快照）、`fb_term_font`（默认 PT Mono）、`fb_term_fontsize`（默认 18）、`fb_term_fontweight`（默认 500）、`fb_term_scroll`（滚速 1-15，默认 3）、`fb_term_bgimg`/`fb_term_bgmask`（垫图）、`fb_sess_pinned`（置顶）
- 仓库外配套脚本（`~/bin/`）：`fanbox`（启停器，含 CDP 9223 + 清污染环境 + 修 spawn-helper）、`claudex`、`agy`（封装代理并默认对非管理子命令注入 `--dangerously-skip-permissions`）

## 踩坑警示（违反必翻车）

- `npm install` 后 node-pty 的 spawn-helper 会丢执行位 → 终端报 `posix_spawnp failed`。修复：`chmod +x node_modules/node-pty/prebuilds/darwin-*/spawn-helper`
- `npm run dist` 走不通：package.json 写死原作者签名证书（`identity`/`notarize`），本地打包前必须改掉
- 上游 README/CHANGELOG 不要改（月更多次必冲突），二开叙事一律写 docs/FORK.md
- 启停一律用 `fanbox` / `fanbox stop` / `fanbox log`（`~/bin/fanbox`，在仓库外；已含 CDP 9223、清污染变量、修 spawn-helper 执行位）。已在跑时 `fanbox` 只提示不重启，换新代码须 `fanbox stop && fanbox`。别 kill npx 包装进程——杀不掉 Electron 本体（`fanbox stop` 按 4567 端口杀）
- **PTY spawn 必须清 CLAUDECODE 等污染环境变量**（electron/main.js `pty:spawn` 与 `~/bin/fanbox` 已做，含 `CLAUDECODE`、`CLAUDE_CODE_SESSION_ID`、`CLAUDE_CODE_ENTRYPOINT`、`CLAUDE_CODE_EXECPATH`、`CLAUDE_CODE_CHILD_SESSION`、`CLAUDE_CODE_SESSION_ATTENDED`、`CLAUDE_CODE_MESSAGING_*`、`CLAUDE_PID`）。漏清会导致终端里起的 claude 自认子会话，报 `Transcript saving is off` 不往 jsonl 写对话 → 内容丢失、`claudex -r <id>` 找不到会话
- **提取 Claude 会话模型严禁读 `assistant.message.model`**：自适应代理网关回包会剥掉 `[1m]` 后缀并改写底层模型名（如把默认 `deepseek-v4.1-flash[1m]` 回成 `deepseek-v4-flash`），只信客户端侧 `attachment.identity.modelId` 与 `/model` 回执；且与默认模型一致时不传 `--model`以免覆盖默认 `[1m]` 配置
- **node-pty 的 `proc` 判不了「claude 在不在跑」**：claudex 包装脚本末行不带 `exec`，前台进程组长是 zsh，claude 活着 proc 也返回 `'zsh'`。判 claude 存亡用 `/api/session-host`（注册表+ps 探活）；`isPlainShell` 对挂会话标签的 tab 必须直接 false
- **子进程的 `TERM_PROGRAM` 必须改写成 `fanbox`**（`pty:spawn` 与 `electron/wechat/env.js` 两个出口已做，新增子进程出口要照做）：从 Terminal.app 启动时它是 `Apple_Terminal`，claude 据此发通知前跑 `osascript tell application "Terminal"`，Terminal 没运行就被拉起 → 空终端随机弹出
- **项目身份读会话文件头的 `cwd`，别信 `~/.claude/projects/` 的目录名**：目录名把每个汉字/符号压成 `-`（`BAA定位`/`BAA记忆` 同目录），按目录取 cwd 会吞项目、串会话。用 `sessionFileCwd(fp)`（`agentProjects`/`agentSessions` 已用；`projectMemory` 还没，见 FORK.md 已知限制）

## 验证习惯

改完用 Playwright CDP 连 9223 实测（参考 git log 里各 commit 的验证方式），别只过语法。四态判定的试金石：本会话（FanBox 项目）在持续 tool_use 时应为 running/蓝点。用户正在用的实例**不要重启**——CSS/纯函数可经 CDP `Runtime.evaluate` 注入热补实测（v1.3.1 的 ↑/↓ 修复即靠热补发现 NBSP 坑）。**也不要另起第二个实例**（会再起一套定时任务调度器，重复触发并改写共用的 cron 文件）：服务端函数用「空转 listen/写盘/定时器地加载 server.js」的装置跑真实数据，见 FORK.md「验证方式」。
