# FanBox 二开说明（fork: linchenglong/fanbox）

> 上游：[alchaincyf/fanbox](https://github.com/alchaincyf/fanbox)（MIT）。基线 `base-ff054e5`（上游 v2.12.1，2026-07-31 fork）。
> 二开方向：从「文件管理器 + 终端」改造为 **Codex 式 session 驾驶舱**——左侧项目/会话导航，右侧全宽终端。
> 本文是二开功能的唯一叙事文档；上游 README/CHANGELOG 不动（避免 merge 冲突）。

## 与上游共存的约定

- 所有二开代码块用 `==== 二开` 注释围起（`grep -an "==== 二开" server.js public/app.js public/style.css electron/main.js electron/preload.js electron/wechat/env.js` 六个文件全量认领；**必须 `-a`**——`public/app.js` 有 7 个上游遗留的 NUL 字节，不带会被当二进制跳过）
- 上游冲突面实测（2026-10-12，干跑合并上游 2.17.0，落后 42 个提交）：只有 `public/app.js`、`public/style.css`、`package-lock.json` 冲突，`server.js`/`electron/main.js`/`electron/preload.js` 自动合并。干跑命令：`git merge-tree --write-tree --name-only master upstream/master`
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
- **滚轮速度可调**（b1c2952 + 2be8a44 两轮重做）：设置面板「滚速」滑杆 1–15 倍，`fb_term_scroll`。xterm 对像素级滚动有内部 0.3 折扣+平滑，`scrollSensitivity` 调不动（实测各档全是 2 行/格）；`attachCustomWheelEventHandler` 只覆盖 TUI 鼠标上报路径、普通滚动不经过（API 文档失实）。最终在宿主元素 capture 阶段统一积分（deltaY÷单元格高×灵敏度=行数），按场景分发：①普通 shell → `scrollLines` 直接滚（实测 1/3/10 档滚 10/30/100 行全线性）②claude code 等 TUI 开鼠标上报 → 按行数合成 SGR(1006) 滚轮上报序列发给程序（claude 每收一个上报滚固定行数，数量即速度；单事件 60 封顶防触控板甩尾洪泛；实测 cat -v 收到成串 `^[[<64;x;yM`）③less 等 alt-screen 无上报 → 放行 xterm 原生「滚轮转方向键」
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

### 9. v1.3 修复（f82a684, 2be8a44）

- **tab 标题被误摘回目录名**：`claudex` 包装脚本末行不带 `exec`，PTY 前台进程组长是 zsh——node-pty 的 `proc` 对跑着 claude 的 tab 返回 `'zsh'` → `isPlainShell` 误判裸 shell → 20s 轮询摘标签、标题闪回目录名。改用 `/api/session-host` 注册表探活判 claude 存亡（权威）；`isPlainShell` 对挂标签 tab 直接返回 false（否则 `launchAgent` 会把启动命令打进正在跑的 claude 里）
- **tab 拖拽排序**：HTML5 drag 重排 `sessions` 数组（PTY/xterm 实例不动），落点竖线指示 + 半透明拖影；与「拖文件进终端」的高亮按 dataTransfer 类型隔离

### 10. v1.3.1 交互打磨（5ea7611, 31436e3）

- **tab 文字颜色**：选中白（`--text`）、未选中一律灰（`--text-dim`）——上游 unread 提亮整行文字的规则被压掉，未读感交给圆点；hover 仍提亮
- **claude 输入框 ↑/↓ 边界移动**：首/末行但光标不在行首/行尾时，↑/↓ 先发 `\x01`/`\x05`（readline 行首/行尾）；已在边界才放行原生键翻历史。屏读判定：`❯` 行 + 续行两空格缩进 + 底边框。两个坑：**claude TUI 本身跑在 alternate screen**（不能按 `buf.type` 排除 vim/less，靠屏读特征区分）；**`❯` 后缀与续行缩进是 NBSP（\xa0）非普通空格**（`rowText` 统一归一化）。认不出的形态一律放行原生键，最差回退原生行为
- **反向认领 `adoptByHost`**：手动敲 claudex / 重启还原的 tab 没有 `claudeSessionId` 标记，`adoptLiveSessions` 只认 `claudeProj` 轮不到它——发消息后侧栏名字换了 tab 标题不动。挂 15s 轮询：对「开着但没 tab 认领」的会话查 `/api/session-host`（FANBOX_TERM_ID 反查 tab id）自动补标记 + 刷标题。与第 8 节点击侧栏时的手动配对同一数据源，差别是不用等用户点击

### 11. v1.3.2 侧栏项目修正（7b27d12, 8a8fe6b）

- **只收 Claude 项目**：删掉 `agentProjects` 的 Codex 扫描。Codex 项目本来就不进侧栏（`agentSessions` 找不到 claude 目录就跳过），却先占 12 个名额——实测 12 个里 5 个纯 Codex 被丢，侧栏只剩 7 个
- **项目身份 = 会话文件头的 cwd，不是目录名**：claude 的目录名把每个非字母数字字符（含每个汉字）压成 `-`，`BAA定位` 与 `BAA记忆` 同落 `...-Program-BAA--`。旧逻辑每目录只取最新会话的 cwd，后者整个项目消失、会话还混进前者名下。新增 `sessionFileCwd`（逐文件读头部 cwd，读到即按文件缓存，cwd 终身不变）；`agentProjects` 逐文件归属，`agentSessions` 只收 cwd 属于本项目的会话（cwd 读不到的保持旧行为）。175 个近 30 天会话文件冷读 75ms
- **上限**：项目 12→20，每项目会话 40→50
- 验证用「空转装置」加载 `server.js` 跑真实数据，没起第二个实例（见「验证方式」）

### 12. v1.3.2 TERM_PROGRAM 归属改写（64e1328, 39b511e）

- **症状**：Terminal.app 随机弹出空终端窗口。**根因**：FanBox 从 Terminal.app 启动（`npm start`）时 `process.env` 带 `TERM_PROGRAM=Apple_Terminal`，子进程里的 claude 因此走「Apple Terminal 响铃通知」分支——每次发通知前跑 `osascript -e 'tell application "Terminal" to name of current settings of front window'`（claude 二进制内嵌的 JS 里可见），Terminal 没在运行时这条 Apple Event 会把它拉起
- **改法**：两个子进程出口都把 `TERM_PROGRAM` 改写成 `fanbox`、删 `TERM_PROGRAM_VERSION`：`electron/main.js` 的 `pty:spawn`（终端 tab；定时任务也经此）、`electron/wechat/env.js` 的 `build()`（微信桥拉起的无头 claude/codex）。claude 识别不了宿主就不发响铃通知，与从 Dock 启动（`TERM_PROGRAM` 本就未设）一致
- **验证**：真实 PTY 对照（模拟 Apple_Terminal 启动）——改前子进程 `TERM_PROGRAM=Apple_Terminal`/版本 `455`，改后 `fanbox`/空，login shell 的启动文件不会改回；`env.js` 的 `fullEnv()` 直接实测。**只对重启后新开的终端生效**，运行中的 tab 环境已定
- **未实证**：「空终端不再弹」本身是随机现象，需长期观察

### 13. Antigravity (`agy`) 双引擎驾驶舱接入

- **同树混排与项目归属**：`agentProjects` / `agentSessions` 同时聚合 Claude Code（`~/.claude/projects/**/*.jsonl`）与 Google Antigravity CLI（`~/.gemini/antigravity-cli/conversation_summaries.db` SQLite WAL 权威索引，排除 `nesting_depth>0` 子会话及单会话 `.db` 已删的孤儿摘要），同一 `cwd` 下的两家会话按 `lastT` 降序混排。同时剔除 `/tmp`、`/private/var/folders` 等系统临时目录（防评测/网关无头会话挤占 20 个项目名额）
- **WAL 感知缓存**：`sqliteDbSig` 同时校验 `.db` 与 `.db-wal` 的 `size + mtimeMs`，未写入时 0ms 命中内存缓存；冷读 `sqlite3 -json` 约 14ms
- **探活与宿主定位**：活着的 `agy` 进程持有 `~/.gemini/antigravity-cli/presence/<uuid>.lock` 打开句柄。`liveAgySessions` 先 `pgrep -x agy` 再 `lsof -nP -a -p <pids> -F pn` 定向反查 `<uuid> → pid`（无 `agy` 进程时免调 `lsof`）；`sessionHost` 共用 `ps eww` 读取 `FANBOX_TERM_ID` 配对本地 tab / 拦截外部宿主双开
- **四态对齐**：活会话结合 `summary.status`（`CASCADE_RUN_STATUS_*`）与单会话库 `steps` 末步状态（protobuf `CortexStepStatus`：`9=WAITING` → 橙色等待确认，`1/2/8/11` 或 `RUNNING/BUSY` → 蓝色呼吸进行中，`not_fully_idle` → 紫色后台运行，其余 → 绿色完成）
- **视觉区分与分流调度**：状态圆点专职表达运行四态，紧邻其右放置 13px 官方引擎图标（Claude 琥珀星芒 `claude.svg` / Antigravity 谷歌四色飞翼 `agy.svg`，闭合态降透明度退居二线，打开态全彩高亮；顶栏挂会话的 tab 同步替换为对应引擎图标）。点击未打开会话按 `agent` 自动分流执行 `sessionResumeCmd`（默认 `claudex -r {id}`）或 `agyResumeCmd`（默认 `agy --conversation {id}`）；项目行右侧 `＋` 升级为新建 Claude / Antigravity 二选一菜单；`AGENT_REGISTRY` 同步内置 `agy`
- **配套 `~/bin/agy` 最高权限包装**：对交互会话与单次任务默认注入 `--dangerously-skip-permissions`（管理类子命令 `update`/`mcp`/`models` 等及已显式传参时自动豁免）

### 14. 终端内点击文件 → 按 Tab 隔离的右侧文件展开区

- **架构归属（Tab = 左终端 + 右专属文件区）**：`applyCockpit(true)` 动态挂载 `#term-body` 包裹 `#xterm-host`，并将上游现成的 `#preview-resizer` + `#preview` 迁入 `#term-body` 右侧（位于 `.term-head` Tab 栏正下方；`public/index.html` 零改动，`fbCockpit(false)` 随时原样迁回 `#filemgmt`），100% 零拷贝复用上游 Markdown 富文本/排版、HTML 实时预览、Monaco 代码编辑、CSV 表格、图片灯箱、PDF 与选中文字甩回终端等全套能力
- **按 Tab 状态隔离（`cockpitPreview`）**：每个终端 Tab 独立持有 `s.cockpitFile`。在 Tab 3 点击路径在右侧展开文件 A → 切换到未开文件的 Tab 2 时自动保存改动并瞬切收起右侧、终端自适应铺满全宽 → 切回 Tab 3 自动恢复文件 A；点右上角 `✕` 或按 `Esc` 仅解绑当前 Tab 的文件，不影响其它 Tab
- **链接识别与打开增强**：在 xterm `registerLinkProvider` 基础上补充 `file://` URI 识别；`openTermPath` 支持 `file://` 解码、`:line(:col)` / `#Lline` 行号提取（Monaco 自动居中跳行），基准目录优先取点击所属 Tab 自身的实时工作目录，驾驶舱下直出单文件预览（`/api/locate` 附带 `entry` 元信息）不篡改全局面包屑目录；打开/恢复预览时不抢夺左侧终端键盘焦点；分栏拖拽分隔条为跨骑分界线的 9px 热区，宽度记忆在 `localStorage` `fb_cockpit_pvw`（默认占 46% 宽）

### 15. Office 三件套原地预览（`xlsx/xls` · `docx/doc` · `pptx/ppt`）

- **零 npm 依赖后端解析（`/api/office`）**：基于 Node 内置 `zlib.inflateRawSync` 实现 OOXML 内存 ZIP 读取器（60MB 内存护栏）
  - **Excel**：`.xlsx` 直解 `sharedStrings`、`styles`（Excel 日期序列号自动还原为 `YYYY-MM-DD`）、`workbook` 多 Sheet 映射，大表借 `<dimension>` 秒取总行数并截取前 500 行 × 80 列（29MB 9-Sheet 表实测数十毫秒）；老版 `.xls` 走 `python3 -I` `xlrd` 兜底。前端渲染多 Sheet 胶囊切换栏 + 吸顶冻结表头网格表
  - **Word**：`.docx` 栈式扫描 `<w:body>` 还原标题层级、粗斜下划线、超链接、嵌套表格及 `word/media/*` 内嵌图片（单图≤4MB、总图≤16MB Base64 嵌入，支持点击灯箱滚轮放大）；`.doc` 走 macOS `/usr/bin/textutil -convert html` 并剥除死黑字色适配暗色主题
  - **PPT**：优先调用本机 LibreOffice `soffice --headless`（独立临时 `UserInstallation` 防桌面实例锁冲突）转原版排版 PDF 缓存至 `~/.fanbox/thumbs/office-<sha1>.pdf`（首开 ~4s，二次缓存 1ms）；未装 LibreOffice 时降级为纯 Node 解析 `ppt/slides/*` 16:9 图文卡片流

### 16. 会话原模型记忆续接 + 重启自动原位恢复 Tab

- **双引擎最后使用模型解析（`server.js`）**：
  - **Claude Code**：`parseClaudeSession` 仅采信客户端侧 `attachment.identity.modelId` 与 `/model` 本地回执 `Set model to \`...\``（完整保留渠道前缀与 `[1m]` 1M 上下文后缀；**禁用**网关回包 `assistant.message.model` 兜底——代理网关回包会剥掉 `[1m]` 并改写为后端底层名如 `deepseek-v4-flash`）
  - **Antigravity (`agy`)**：`agyConvMeta` 读取单会话库 `gen_metadata` 末步 protobuf field 21（`0xaa 0x01`）模型显示名（如 `Claude Opus 4.6 (Thinking)`）
  - **默认模型走原旧方式裸续接**：`readDefaultAgentModels` 实时读取 `~/.claude/settings.json`（`env.ANTHROPIC_MODEL || model`）与 `~/.gemini/antigravity-cli/settings.json`（`model`）；若会话模型与当前默认模型一致（含 `deepseek-v4-flash` 网关别名），`resumeModel` 置空，前端直接走原旧方式裸跑 `claudex -r {id}` / `agy --conversation {id}`（自动继承默认 `[1m]` 配置），**仅切过非默认模型的会话才追加 `--model '<resumeModel>'`**
- **两条续接路径统一出口（`buildSessionResumeCmd`）**：侧栏点击关闭会话（`openSession`）与重启自动恢复（`term.restore`）共用同一命令构建器，单引号安全包裹 `--model` 参数（防 zsh 将 `[1m]` 或空格括号解析为通配符/语法错误）
- **快照升级（`persistTabs` / `restore`）**：`localStorage` `fb_term_tabs` 持久化每个活 Tab 的 `{ cwd, sid, agent, model, title, file }`（上限 16 个标签，还原期间挂 `_restoring` 锁）；重启后第 0 帧恢复标题、引擎图标与右侧关联文件，排除外部终端已开会话后原位自动续接，并给足 25s 启动宽限期
- **顺手加固 PTY 污染变量清理**：跟进 Claude Code v2.1.303，在 `pty:spawn` 与 `~/bin/fanbox` 补充剥离 `CLAUDE_CODE_CHILD_SESSION`、`CLAUDE_CODE_SESSION_ATTENDED`、`CLAUDE_CODE_MESSAGING_*`、`CLAUDE_PID`，根绝 `Transcript saving is off`

### 17. 定向摘入上游三项核心修复（来自 v2.14.0 / v2.15.0 / v2.17.1）

未整包合并上游 UI 改版，仅按上游原文逐字移植三项纯收益修复（保持与上游代码一致，方便后续 merge 自动消解）：
- **快照硬门与空间清理（`62115f0`）**：修复 `commit` 超时被当成「无变化」导致孤立对象堆积与未备份误回滚；启动自动清理 0 快照失效影子仓库（`snapReapAll`）；缩略图生成后 5s 合批裁剪（`pruneThumbsSoon`，按磁盘块计）；存档面板增加总占用/当前项目占用显示与一键清理（驾驶舱在右上角 `⚙` 设置面板补充「回合存档与空间清理」入口）
- **豆包等中文输入法标点修复（`2ec28c6` #66）**：单字符标点在 `keydown` 挂起改由 `keypress`/`input` 发出（`keyup` 兜底补发），解决不走组合态的中文输入法输出 `，。` 被键位英文 `, .` 顶掉的问题
- **Markdown 本地图片渲染内存降 11 倍（`eb35a9a`）**：新增 `thumbUrl`/`canThumb`/`displayImgWidth` 与 `#preview-body` 二段式 `thumb → /fs/` 兜底，以及 `/api/thumb` ETag 304 协商缓存（排版导出仍走原图，图注无损保留已在 v2.8.0 基线内）

## 已知限制

- xterm canvas 渲染与 CoreText 存在先天字形差异，字重 500 追回约九成观感
- `npm run dist` 需先改掉 package.json 里原作者的签名配置（`identity`/`notarize`/`appId`）
- Codex/kimi/opencode 的会话不进侧栏（只做 Claude Code + Antigravity）
- `projectMemory`（项目记忆页，上游代码）仍按目录名读会话，汉字撞车的目录里会混入别的项目的会话——二开只修了侧栏

## 验证方式（历次实测手段）

```bash
# 服务端数据
curl -s http://127.0.0.1:4567/api/agent-sessions | jq '.projects[].sessions[] | {id, open, status}'
# UI 实测：带 CDP 启动，Playwright connect_over_cdp 驱动真实 App
fanbox   # ~/bin/fanbox 启动器，已带 --remote-debugging-port=9223；停止 fanbox stop，日志 fanbox log
```

**服务端函数改了、又不想动正在用的实例**：不要另起第二个 FanBox（会再起一套定时任务调度器，重复触发并改写共用的 cron 文件）。改用「空转装置」——加载 `server.js` 但让 `listen`/写盘/`setInterval` 空转，只导出目标函数跑真实数据（2026-10-12 实测可用，v1.3.2 侧栏修正即靠它验证）：

```bash
node -e '
const Module=require("module"),fs=require("fs"),path=require("path"),http=require("http");
const SRC=process.argv[1];
fs.writeFileSync=()=>{}; fs.mkdirSync=()=>{};
http.createServer=()=>({on(){},listen(){},close(){}});
global.setInterval=()=>({unref(){},ref(){}});
const m=new Module(SRC,null); m.filename=SRC; m.paths=Module._nodeModulePaths(path.dirname(SRC));
m._compile(fs.readFileSync(SRC,"utf8")+"\nmodule.exports={agentProjects,agentSessions};",SRC);
m.exports.agentSessions().then(d=>{console.log("侧栏项目数:",d.projects.length);process.exit(0)});
' "$PWD/server.js"
```
