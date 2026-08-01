# FanBox 二开说明（fork: linchenglong/fanbox）

> 上游：[alchaincyf/fanbox](https://github.com/alchaincyf/fanbox)（MIT）。基线 `base-ff054e5`（上游 v2.12.1，2026-07-31 fork）。
> 二开方向：从「文件管理器 + 终端」改造为 **Codex 式 session 驾驶舱**——左侧项目/会话导航，右侧全宽终端。
> 本文是二开功能的唯一叙事文档；上游 README/CHANGELOG 不动（避免 merge 冲突）。

## 与上游共存的约定

- 所有二开代码块用 `==== 二开` 注释围起（`grep -n "==== 二开"` 五个文件全量认领）
- 文件区/预览等上游功能**隐藏不删**（`display:none`），代码照常运行——换取 merge 上游时的最小冲突面
- 控制台 `fbCockpit(false)` 随时切回上游原版三栏布局

## 功能清单（按 commit 顺序）

### 1. Cockpit 布局（200ac96）

- 默认布局变为：左侧栏 + 右侧全宽终端；中间文件区/预览隐藏（CSS `#app.cockpit`）
- 快速入口选中路径 = 「＋ 终端」新 tab 的落点（复用上游 `state.cwd → newTab` 链路，零新代码）
- 开关：localStorage `fb_cockpit`（默认开）；`window.fbCockpit(on)` 即时切换

### 2. 侧栏 session 列表（200ac96, be451d9, 88251b0）

- 「AGENT 项目」区块改为两级：项目行（右侧 session 数 + hover ＋ 开新会话）→ Claude session 列表（最后活跃降序，默认露 5 条可展开）
- 数据：`GET /api/agent-sessions`——复用上游 `agentProjects()`（项目发现）+ `parseClaudeSession()`（单文件解析，size+mtime 缓存），只聚合 Claude 会话
- 点击 session：已开 tab → 切换；未开 → 项目目录新开 tab 自动跑续接命令
- 命令模板可配（`~/.fanbox/config.json`）：`sessionResumeCmd` 默认 `claudex -r {id}`，`sessionNewCmd` 默认 `claudex`
- ✎ 改名：`POST /api/session-name`，存 config `sessionNames`（超 300 条按插入序裁剪）
- resume fork 收养：`claude --resume` 可能把续写落到新 session id 的 jsonl；`adoptLiveSessions()` 把 FanBox tab 的标签迁到新 id（防高亮丢失）

### 3. 四态状态圆点（be451d9）

会话状态由服务端读 `~/.claude/projects/**/*.jsonl` 判定（`decideSessionStatus`），与终端宿主无关：

| 状态 | 判定 | 圆点 |
|---|---|---|
| running 进行中 | 最后一轮是 tool_use/tool_result **且** jsonl 在活跃窗口内有写入（默认 60s，config `sessionActiveWindowMs`） | 蓝 #4c8dff 呼吸 |
| waiting 等待确认 | 最后一轮停在 AskUserQuestion（其后无回答/新对话——顺序标量，非时间比较） | 橙 #ff9f43 |
| background 后台运行 | 有未回收后台句柄（Monitor/bg Bash/bg Agent），3h 窗口内；Monitor 按自身 timeout+30s 提前失效；task-notification 按 task-id FIFO 回收 | 紫 #a78bfa |
| done 执行完成 | 以上都不是 | 绿 #3fb950 |

防御细节：sidechain（`isSidechain:true`）不参与判定；解析标量挂在 `parseClaudeSession` 的缓存对象上，增量成本≈0。

### 4. open 探活——状态只属于被打开的会话（add96f6, d060b8b）

- 数据源：`~/.claude/sessions/<PID>.json` 注册表（每个交互式 claude 进程自己写，含当前 sessionId）+ `ps` 批量核对存活（5s 缓存）
- 覆盖所有宿主：FanBox 内嵌终端 / iTerm / Warp / 系统终端里跑的 claude 一视同仁
- UI 规则：**打开 = 文字高亮 + 状态圆点；未打开 = 文字置灰 + 中性灰点（无状态）**
- FanBox 自己的活 tab 并入 open 集合（新开瞬间注册表未落盘的窗口期不闪灰）

### 5. 蓝莓皮肤 Adeberry（1959848）

第四套皮肤，色板逐值移植自 Warp 官方（`warpdotdev/warp` `default_themes.rs` 的 `adeberry()`）：背景 `#1D2022`、前景 `#E4EEF5`、accent `#6C96B4`、ANSI 16 色同源。覆盖：CSS 变量、xterm ANSI、Monaco `fb-adeberry`、hljs github-dark、crepe 暗色表面、弹窗阴影。

### 6. 终端体验（9893e7f, fecf420, d060b8b, 2f0b54c）

- **字体可配置**：⚙ 设置面板「字体」行，家族 + 字号（9–32），全 tab 即时生效。默认 PT Mono 18px；用户字体打头、皮肤 Nerd Font 链殿后兜 powerline 字形
- **字重默认 500**：DPR=1 外接屏上 xterm canvas 灰度抗锯齿偏细发虚（对比 CoreText 渲染的 Warp 明显），合成加粗半档补回观感
- **滚轮速度可调**（b1c2952 重做）：设置面板「滚速」滑杆 1–15 倍，`fb_term_scroll`。xterm 对像素级滚动有内部 0.3 折扣+平滑，`scrollSensitivity` 调不动（实测各档全是 2 行/格）；`attachCustomWheelEventHandler` 只覆盖 TUI 鼠标上报路径、普通滚动不经过（API 文档失实）。最终在宿主元素 capture 阶段拦截：deltaY÷单元格高×灵敏度=行数直接 `scrollLines`，受控实测 1/3/10 档滚 10/30/100 行全线性。TUI 鼠标上报与 alt-screen（less 等）放行原生
- **皮肤垫图**：设置面板「皮肤」行——系统对话框选图（electron `ui:pick-image` 桥）+ 半透明黑蒙版滑杆（0–95%，默认 60%）+ 清除。有图时 xterm 画布走透明（`allowTransparency`），图/蒙版由 `#xterm-host` CSS 承担
- **侧栏文字提亮**：条目一律主文字色，仅未打开会话置灰（8bab389, 2f0b54c）

### 7. Patch 修复（ef71aea, c610306）

- **图片粘贴观感**：`pasteInto` 图片分支回显 `[image] <path>`（贴近 Warp 的 `[image N]` 标记，但 claude TUI 不认 Warp 私有协议，改用 claude 能读的路径引用——交互式 TUI 看到路径会调 Read 读图）。`@路径` 在 `-p` 模式不解析、stream-json 仅 `-p` 可用，无法直接复刻 Warp
- **⌘+Enter / Shift+Enter 换行**：`attachCustomKeyEventHandler` 拦截后发 `ESC+CR`（=Option+Enter 等价序列），claude TUI 换行不提交；裸 Enter 仍提交
- **work 项目丢失修复**：上游 `agentProjects` 老 bug——最新 jsonl 头 64KB 抓不到 `cwd` 字段就整个项目丢弃。新增 `cwdFromDirName`：从 munge 后的目录名拆 `-` 贪心匹配 + stat 验证还原真实路径（路径段含 `-` 时有歧义，stat 筛选错候选）
- **PTY 清污染环境变量**（重要）：FanBox 若跑在 claude 会话里（Agent 驱动开发），`process.env` 带 `CLAUDECODE`/`CLAUDE_CODE_SESSION_ID` 等，终端 PTY 继承后里面起的 claude 以为自己是父会话子 agent，**不往自己 session 的 jsonl 写对话** → 内容丢失、`claudex -r <id>` 找不到。`pty:spawn` 前 `delete` 四个变量。经验源自 warp自定义/CLAUDE.md

### 8. Session 交互强化（e338b66, 53f830c, c888578）

- **防双开**：点击已打开的 session 三级判定——①前端标记的 tab 直接切换 ②未标记但会话开着：`GET /api/session-host?id=` 用 `ps eww` 读 claude 进程环境里的 `FANBOX_TERM_ID`（`pty:spawn` 注入）配对本地 tab，配上就切过去并补标记（手动敲 claudex 起的会话也能切回）；配不到 = 跑在 iTerm/Warp 等外部宿主，提示不双开（`claude -r` 双开写坏 jsonl，warp自定义/BLOCKED.md 教训）③真没开才新开 tab 续接
- **tab 标题 = 会话名**：挂 claude 会话的 tab 显示会话名（自定义名>首条摘要，14 字截断），`syncSessTabTitles` 在打开/收养/改名/host 配对四节点同步；claude 退出回落目录名；上游 `refreshCwd` 的目录名覆盖对挂会话 tab 豁免
- **tab 圆点四态同色**：挂 claude 会话的 tab 圆点用侧栏同款四态色（数据同源 `sessUI`），普通 shell tab 保持上游 busy/idle/dead 三态
- **置顶**：侧栏 ✎ 改为 ⋯ 菜单（重命名/置顶），置顶存 localStorage `fb_sess_pinned`，项目内置顶组排最前带 📌
- **⌘+Enter 只发一次**：`attachCustomKeyEventHandler` 对同一按键收 keydown/keyup 两个事件，只在 keydown 发 ESC+CR（此前换两行）

## 已知限制

- TUI（claude/codex）接管鼠标上报时，滚轮步长由程序自己决定，灵敏度设置不生效（终端协议使然，Warp 同）
- xterm canvas 渲染与 CoreText 存在先天字形差异，字重 500 追回约九成观感
- `npm run dist` 需先改掉 package.json 里原作者的签名配置（`identity`/`notarize`/`appId`）
- Codex/kimi/opencode 的会话不进侧栏（只做 Claude）

## 验证方式（历次实测手段）

```bash
# 服务端数据
curl -s http://127.0.0.1:4567/api/agent-sessions | jq '.projects[].sessions[] | {id, open, status}'
# UI 实测：带 CDP 启动，Playwright connect_over_cdp 驱动真实 App
npx electron . --remote-debugging-port=9223
```
