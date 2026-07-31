# FanBox 二开仓（fork 自 alchaincyf/fanbox）

个人二开版：Codex 式 session 驾驶舱。上游是活跃项目（app.js 月改 19 次），**一切改动以「能持续吃上游更新」为第一约束**。

## 仓库与分支纪律

- `origin` = linchenglong/fanbox（自己的 fork，可推）；`upstream` = alchaincyf/fanbox（**push 已物理禁用**，只读）
- 主干是 `master`（沿上游命名）。开发一律 `feat/xxx` 分支 → 合回 master → 推 origin
- tag 规范：自己的交付 tag 带前缀 `<功能>-<期次>-v<SemVer>`（如 `cockpit-p1-v1.0.0`）；`base-<sha>` 是 fork 基线标记。裸 `vX.Y.Z` 全是上游的，不要动
- 吃上游更新：`git fetch upstream && git merge upstream/master`，冲突集中在 app.js/style.css/server.js

## 二开代码标记（merge 时的救命索）

所有二开代码块用注释围起，认领用：

```
grep -n "==== 二开" server.js public/app.js public/style.css electron/main.js electron/preload.js
```

改二开功能时保持这个标记习惯；改上游代码时**不加标记、最小 diff**。

## 二开功能地图（详细机制见 docs/FORK.md）

| 功能 | 服务端 | 前端 |
|---|---|---|
| cockpit 布局（隐藏文件区） | — | app.js `applyCockpit`/`fbCockpit`，style.css `#app.cockpit` |
| 侧栏 session 列表 | `/api/agent-sessions`、`/api/session-name` | app.js `loadAgentProjects`/`sessLi`/`openSession` |
| 四态状态圆点 | `decideSessionStatus`（jsonl 判定） | `SESS_STATUS`、`.sess-dot.st-*` |
| open 探活 | `liveClaudeSessionIds`（~/.claude/sessions 注册表 + ps） | `refreshSessionOpenState` |
| 蓝莓皮肤 Adeberry | — | `[data-theme="adeberry"]`（色值源自 Warp 官方） |
| 终端字体/垫图/滚轮 | — | `term.setFont`/`term.setBg`、⚙ 设置面板 |
| 选图对话框桥 | electron `ui:pick-image` | `window.fanboxUi.pickImage` |

## 配置键速查

- `~/.fanbox/config.json`：`sessionResumeCmd`（默认 `claudex -r {id}`）、`sessionNewCmd`（默认 `claudex`）、`sessionNames`（改名 map）、`sessionActiveWindowMs`（running 活跃窗，默认 60000）
- localStorage：`fb_cockpit`、`fb_term_font`（默认 PT Mono）、`fb_term_fontsize`（默认 18）、`fb_term_fontweight`（默认 500）、`fb_term_scroll`（默认 3）、`fb_term_bgimg`/`fb_term_bgmask`（垫图）

## 踩坑警示（违反必翻车）

- `npm install` 后 node-pty 的 spawn-helper 会丢执行位 → 终端报 `posix_spawnp failed`。修复：`chmod +x node_modules/node-pty/prebuilds/darwin-*/spawn-helper`
- `npm run dist` 走不通：package.json 写死原作者签名证书（`identity`/`notarize`），本地打包前必须改掉
- 上游 README/CHANGELOG 不要改（月更多次必冲突），二开叙事一律写 docs/FORK.md
- 开发实例带 CDP 调试：`npx electron . --remote-debugging-port=9223`；kill npx 包装进程杀不掉 Electron 本体，要 `lsof -nP -iTCP:4567 -sTCP:LISTEN -t | xargs kill`
- **PTY spawn 必须清 CLAUDECODE 等污染环境变量**（electron/main.js `pty:spawn` 已做）。FanBox 若跑在 claude 会话里（Agent 驱动开发），process.env 带 `CLAUDECODE`/`CLAUDE_CODE_SESSION_ID`/`CLAUDE_CODE_ENTRYPOINT`/`CLAUDE_CODE_EXECPATH`，终端 PTY 继承后里面起的 claude 会以为自己是父会话的子 agent，**不往自己 session 的 jsonl 写对话**（只写 mode 元信息）→ 对话内容丢失、`claudex -r <id>` 找不到会话。经验源自 warp自定义/CLAUDE.md「☠️ 启动 GUI 必须清环境变量」节

## 验证习惯

改完用 Playwright CDP 连 9223 实测（参考 git log 里各 commit 的验证方式），别只过语法。四态判定的试金石：本会话（FanBox 项目）在持续 tool_use 时应为 running/蓝点。
