#!/usr/bin/env node
/**
 * FanBox — 本地文件指挥中心后端
 *
 * 纯 Node 内置模块，零依赖。只绑定 127.0.0.1，浏览器界面是唯一入口。
 * 这是一个本地个人工具：你的机器、你的文件，服务只在本机回环地址监听。
 */
'use strict';

const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { exec, spawn, execFile } = require('child_process');
const { URL } = require('url');

const HOME = os.homedir();
const PORT = Number(process.env.FANBOX_PORT) || 4567;
const CONFIG_DIR = path.join(HOME, '.fanbox');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const THUMB_DIR = path.join(CONFIG_DIR, 'thumbs');
const PUBLIC = path.join(__dirname, 'public');
const PLATFORM = process.platform;

// 搜索 / 遍历时跳过的重目录，避免 vibe coding 项目里 node_modules 拖垮速度
const IGNORE_DIRS = new Set([
  'node_modules', '.git', '.next', 'dist', 'build', '.cache', '.venv', 'venv',
  '__pycache__', '.DS_Store', 'Pods', '.gradle', 'target', '.idea', '.vscode-test',
  'DerivedData', '.expo', '.turbo', 'vendor', '.svn', '.hg',
]);

const TEXT_EXT = new Set([
  'txt', 'md', 'markdown', 'js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'json', 'json5',
  'html', 'htm', 'css', 'scss', 'less', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'swift',
  'c', 'h', 'cpp', 'hpp', 'cc', 'm', 'mm', 'sh', 'bash', 'zsh', 'fish', 'sql', 'yml',
  'yaml', 'toml', 'ini', 'env', 'conf', 'xml', 'svg', 'vue', 'astro', 'php', 'lua',
  'r', 'dart', 'gradle', 'properties', 'gitignore', 'dockerfile', 'makefile', 'log',
  'csv', 'tsv', 'gql', 'graphql', 'prisma', 'plist', 'tex', 'rtf', 'srt', 'vtt', 'ass',
]);
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif', 'heic', 'heif', 'tiff', 'tif']);
const VIDEO_EXT = new Set(['mp4', 'webm', 'mov', 'm4v', 'ogv']);
const AUDIO_EXT = new Set(['mp3', 'wav', 'ogg', 'm4a', 'flac', 'aac']);
const PDF_EXT = new Set(['pdf']);
const ARCHIVE_EXT = new Set(['zip', 'jar', 'tar', 'tgz', 'gz', 'bz2', 'xz', '7z', 'rar']);
// ==== 二开: office ==== Office 三件套原地预览分类
const OFFICE_EXT = new Set(['xlsx', 'xls', 'docx', 'doc', 'pptx', 'ppt']);

const MIME = {
  html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8',
  js: 'application/javascript; charset=utf-8', css: 'text/css; charset=utf-8',
  json: 'application/json; charset=utf-8', svg: 'image/svg+xml',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', bmp: 'image/bmp', ico: 'image/x-icon', avif: 'image/avif',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', m4v: 'video/mp4',
  ogv: 'video/ogg', mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg',
  m4a: 'audio/mp4', flac: 'audio/flac', aac: 'audio/aac', pdf: 'application/pdf',
  ttf: 'font/ttf', woff: 'font/woff', woff2: 'font/woff2',
};

// ---------- 工具函数 ----------

function ext(name) {
  const i = name.lastIndexOf('.');
  if (i <= 0) return '';
  return name.slice(i + 1).toLowerCase();
}

// 从一组文件/目录名推断项目类型（签名文件），供当前目录徽章 + 子目录浅探共用
function projectOf(names) {
  if (names.has('package.json')) return 'node';
  if (names.has('index.html')) return 'web';
  if (names.has('requirements.txt') || names.has('pyproject.toml')) return 'python';
  if (names.has('Cargo.toml')) return 'rust';
  if (names.has('go.mod')) return 'go';
  if (names.has('.git')) return 'git';
  return null;
}

function kindOf(name, isDir) {
  if (isDir) return 'dir';
  const e = ext(name);
  if (IMAGE_EXT.has(e)) return 'image';
  if (VIDEO_EXT.has(e)) return 'video';
  if (AUDIO_EXT.has(e)) return 'audio';
  if (PDF_EXT.has(e)) return 'pdf';
  if (OFFICE_EXT.has(e)) return 'office'; // ==== 二开: office ====
  if (ARCHIVE_EXT.has(e)) return 'archive';
  if (TEXT_EXT.has(e) || /^(dockerfile|makefile|readme|license|\.[a-z]+rc)$/i.test(name)) return 'text';
  return 'other';
}

// 把任意请求路径规整成绝对真实路径；非绝对路径回退到 HOME。本机个人工具，不做越权拦截，
// 但拒绝空字节这种明显异常输入。
function resolvePath(p) {
  if (!p || typeof p !== 'string') return HOME;
  if (p.includes('\0')) throw new Error('非法路径');
  let abs = p.startsWith('~') ? path.join(HOME, p.slice(1)) : p;
  if (!path.isAbsolute(abs)) abs = path.join(HOME, abs);
  return path.normalize(abs);
}

async function readConfig() {
  try {
    const raw = await fsp.readFile(CONFIG_FILE, 'utf8');
    return JSON.parse(raw);
  } catch {
    return { favorites: [], recentOpened: [] };
  }
}

// 串行化「读-改-写」：高频 recordRecent 与收藏共享 config.json，必须排队整个 RMW 才不丢更新
let _cfgChain = Promise.resolve();
function updateConfig(mutator) {
  const run = _cfgChain.then(async () => {
    const cfg = await readConfig();
    await mutator(cfg);
    await fsp.mkdir(CONFIG_DIR, { recursive: true });
    // 原子写：temp + fsync + rename，写一半崩溃不留截断 JSON（否则 readConfig 静默清空收藏/最近）
    const tmp = `${CONFIG_FILE}.tmp-${process.pid}-${Date.now()}`;
    try {
      const fh = await fsp.open(tmp, 'w');
      try { await fh.writeFile(JSON.stringify(cfg, null, 2)); await fh.sync(); } finally { await fh.close(); }
      await fsp.rename(tmp, CONFIG_FILE);
    } catch (e) { await fsp.unlink(tmp).catch(() => {}); throw e; } // 写盘失败要冒泡给调用方，别静默成功
    return cfg;
  });
  _cfgChain = run.catch(() => {}); // 保持队列存活，但 run 本身会 reject 让调用方感知失败
  return run;
}

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

// ---------- 业务逻辑 ----------

async function listDir(dirPath) {
  const dir = resolvePath(dirPath);
  const dirents = await fsp.readdir(dir, { withFileTypes: true });
  const entries = [];
  for (const d of dirents) {
    if (d.name === '.DS_Store') continue;
    const full = path.join(dir, d.name);
    let isDir = d.isDirectory();
    let size = 0, mtime = 0;
    // 处理符号链接
    if (d.isSymbolicLink()) {
      try {
        const st = await fsp.stat(full);
        isDir = st.isDirectory();
      } catch { continue; }
    }
    let btime = 0;
    try {
      const st = await fsp.lstat(full);
      size = st.size;
      mtime = st.mtimeMs;
      btime = st.birthtimeMs || 0;
    } catch { /* ignore */ }
    entries.push({
      name: d.name,
      path: full,
      isDir,
      kind: kindOf(d.name, isDir),
      hidden: d.name.startsWith('.'),
      size,
      mtime,
      btime,
    });
  }
  // 文件夹在前，按名称排序
  entries.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name, 'zh', { numeric: true });
  });
  // 识别项目类型（含 package.json / .git / index.html 等）
  const names = new Set(entries.map((e) => e.name));
  const project = projectOf(names);

  // 给每个子目录浅探一次项目类型，文件卡片上标徽章——「一下午起的十个项目」一眼认出是 node/web/py
  // 成本受控：只探目录、且总数封顶；大目录（>80 个子目录）跳过，避免拖慢列表
  const subDirs = entries.filter((e) => e.isDir && !e.name.startsWith('.'));
  if (subDirs.length <= 80) {
    await Promise.all(subDirs.map(async (e) => {
      try {
        const inner = await fsp.readdir(e.path);
        e.project = projectOf(new Set(inner));
      } catch { /* 无权限等，跳过 */ }
    }));
  }

  const parts = dir.split(path.sep).filter(Boolean);
  const breadcrumb = [{ name: PLATFORM === 'win32' ? dir.split(path.sep)[0] : '/', path: PLATFORM === 'win32' ? parts[0] + path.sep : path.sep }];
  let acc = PLATFORM === 'win32' ? parts[0] + path.sep : path.sep;
  const start = PLATFORM === 'win32' ? 1 : 0;
  for (let i = start; i < parts.length; i++) {
    acc = path.join(acc, parts[i]);
    breadcrumb.push({ name: parts[i], path: acc });
  }
  return { path: dir, parent: path.dirname(dir), entries, breadcrumb, project };
}

async function readFile(filePath) {
  const file = resolvePath(filePath);
  const st = await fsp.stat(file);
  const kind = kindOf(path.basename(file), false);
  const info = {
    path: file, name: path.basename(file), size: st.size,
    mtime: st.mtimeMs, kind, ext: ext(file),
  };
  if (kind === 'text') {
    if (st.size > 2 * 1024 * 1024) {
      info.tooLarge = true;
      const fd = await fsp.open(file, 'r');
      const buf = Buffer.alloc(256 * 1024);
      const { bytesRead } = await fd.read(buf, 0, buf.length, 0);
      await fd.close();
      // 回退到完整 UTF-8 边界，避免把末尾多字节字符切坏成 �
      let end = bytesRead;
      while (end > 0 && (buf[end - 1] & 0xC0) === 0x80) end--;
      if (end > 0 && (buf[end - 1] & 0xC0) === 0xC0) end--;
      info.content = buf.toString('utf8', 0, end) + '\n\n… (文件较大，仅显示前 256KB)';
    } else {
      info.content = await fsp.readFile(file, 'utf8');
    }
  }
  return info;
}

// 递归遍历，带忽略表、结果上限与时间预算。返回是否因上限/超时而提前中断（截断）
// onDir（可选）让调用方也拿到目录，用于「按文件夹名搜索」——目录不计入 limit。
async function walk(root, { onFile, onDir, limit = 4000, deadline }) {
  const queue = [root];
  let count = 0;
  let truncated = false;
  while (queue.length) {
    if (Date.now() > deadline || count >= limit) { truncated = true; break; }
    const dir = queue.shift();
    let dirents;
    try {
      dirents = await fsp.readdir(dir, { withFileTypes: true });
    } catch { continue; }
    for (const d of dirents) {
      if (d.name === '.DS_Store') continue;
      const full = path.join(dir, d.name);
      const isDir = d.isDirectory();
      if (isDir) {
        if (IGNORE_DIRS.has(d.name)) continue;
        if (onDir) {
          let mtime = 0;
          try { mtime = (await fsp.lstat(full)).mtimeMs; } catch { /* */ }
          onDir({ name: d.name, path: full, dir, isDir: true, kind: 'dir', mtime, size: 0 });
        }
        queue.push(full);
      } else {
        count++;
        let mtime = 0, size = 0;
        try { const st = await fsp.lstat(full); mtime = st.mtimeMs; size = st.size; } catch { /* */ }
        onFile({ name: d.name, path: full, dir, isDir: false, kind: kindOf(d.name, false), mtime, size });
        if (count >= limit) { truncated = true; break; }
      }
    }
  }
  return { truncated };
}

// 模糊匹配打分：子序列匹配，连续命中、词首命中、靠前命中加分
function fuzzyScore(query, target) {
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  let qi = 0, score = 0, lastIdx = -1, streak = 0;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      let pts = 10;
      if (ti === lastIdx + 1) { streak++; pts += streak * 8; } else streak = 0;
      if (ti === 0 || /[\/_\-. ]/.test(t[ti - 1])) pts += 15; // 词首
      pts += Math.max(0, 8 - ti * 0.1); // 靠前
      score += pts;
      lastIdx = ti;
      qi++;
    }
  }
  if (qi < q.length) return -1; // 未能匹配全部字符
  score -= (t.length - q.length) * 0.2; // 越短越好
  return score;
}

async function searchFiles(query, rootPath, deadlineTs) {
  const root = resolvePath(rootPath);
  const q = (query || '').trim();
  if (!q) return { results: [] };
  const matches = [];
  const scoreInto = (f, bonus) => {
    const s = fuzzyScore(q, f.name);
    if (s <= 0) return;
    const pathBonus = fuzzyScore(q, f.path) > 0 ? 3 : 0;
    // 近期修改加权，让「我刚做的东西」优先浮出
    const recencyBonus = Math.max(0, 20 - (Date.now() - f.mtime) / 86400000) * 0.6;
    matches.push({ ...f, score: s + pathBonus + recencyBonus + bonus });
  };
  const { truncated } = await walk(root, {
    limit: 60000,
    deadline: deadlineTs || Date.now() + 4000, // 多根搜索时传共享截止点，封顶总耗时
    onFile: (f) => scoreInto(f, 0),
    // 文件夹小幅加权——vibe coding「一下午起十个项目」，最常找的就是项目目录本身
    onDir: (f) => scoreInto(f, 6),
  });
  matches.sort((a, b) => b.score - a.score);
  return { results: matches.slice(0, 80), truncated };
}

async function grepFiles(query, rootPath) {
  const root = resolvePath(rootPath);
  const q = (query || '').trim();
  if (!q || q.length < 2) return { results: [] };
  const lower = q.toLowerCase();
  const files = [];
  const { truncated: walkTrunc } = await walk(root, {
    limit: 12000,
    deadline: Date.now() + 1800,
    onFile: (f) => { if (f.kind === 'text' && f.size < 512 * 1024) files.push(f); },
  });
  // 按修改时间倒序读，让「我最近写过那句话」的文件优先命中
  files.sort((a, b) => b.mtime - a.mtime);
  const results = [];
  let truncated = walkTrunc;
  const deadline = Date.now() + 3500;
  for (const f of files) {
    if (Date.now() > deadline || results.length >= 50) { truncated = true; break; }
    let content;
    try { content = await fsp.readFile(f.path, 'utf8'); } catch { continue; }
    const lines = content.split('\n');
    const hits = [];
    for (let i = 0; i < lines.length && hits.length < 4; i++) {
      if (lines[i].toLowerCase().includes(lower)) {
        hits.push({ line: i + 1, text: lines[i].trim().slice(0, 200) });
      }
    }
    if (hits.length) results.push({ ...f, hits });
  }
  return { results, truncated };
}

// ---------- Spotlight（mdfind）内容搜索：白嫖系统索引 ----------
// 覆盖全文 + PDF/docx + 截图/图片里的 OCR 文字，毫秒级返回；Spotlight 没索引到的（代码目录等）由 grep 兜底
function mdfind(args) {
  return new Promise((resolve) => {
    execFile('mdfind', args, { timeout: 6000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      resolve(err ? null : String(stdout).split('\n').filter(Boolean));
    });
  });
}
async function contentSearch(query, rootPath) {
  const root = resolvePath(rootPath);
  const q = (query || '').trim();
  if (!q || q.length < 2) return { results: [] };
  // 属性查询而非自由文本：CJK 子串匹配更稳；[cd] = 忽略大小写/音调
  const esc = q.replace(/[\\"*]/g, '');
  const paths = await mdfind(['-onlyin', root, `(kMDItemTextContent == "*${esc}*"cd) || (kMDItemDisplayName == "*${esc}*"cd)`]);
  if (paths === null || !paths.length) {
    const fb = await grepFiles(query, rootPath); // mdfind 不可用或无命中 → 原 grep 兜底
    return { ...fb, engine: 'grep' };
  }
  const results = [];
  const deadline = Date.now() + 2500;
  for (const p of paths) {
    if (results.length >= 60 || Date.now() > deadline) break;
    if (/\/(node_modules|\.git|Library\/Caches)\//.test(p)) continue;
    let st; try { st = await fsp.stat(p); } catch { continue; }
    if (st.isDirectory()) continue;
    const name = path.basename(p);
    results.push({ name, path: p, isDir: false, kind: kindOf(name, false), hidden: name.startsWith('.'), size: st.size, mtime: st.mtimeMs, btime: st.birthtimeMs || 0 });
  }
  results.sort((a, b) => b.mtime - a.mtime); // 近改优先，「我刚写的那句话」浮在最上面
  // 给文本类命中补行级预览（只读前几个小文件，别拖慢整体）
  const lower = q.toLowerCase();
  let read = 0;
  for (const r of results) {
    if (read >= 12) break;
    if (r.kind !== 'text' || r.size > 512 * 1024) continue;
    read++;
    let content; try { content = await fsp.readFile(r.path, 'utf8'); } catch { continue; }
    const lines = content.split('\n');
    const hits = [];
    for (let i = 0; i < lines.length && hits.length < 3; i++) {
      if (lines[i].toLowerCase().includes(lower)) hits.push({ line: i + 1, text: lines[i].trim().slice(0, 200) });
    }
    if (hits.length) r.hits = hits;
  }
  return { results, truncated: paths.length > results.length, engine: 'spotlight' };
}

async function recentFiles(rootPath) {
  const root = resolvePath(rootPath);
  const all = [];
  const { truncated } = await walk(root, {
    limit: 30000,
    deadline: Date.now() + 3500,
    onFile: (f) => { if (!f.name.startsWith('.')) all.push(f); },
  });
  all.sort((a, b) => b.mtime - a.mtime);
  return { results: all.slice(0, 60), truncated };
}

// ---------- 文件操作（编辑 / 废纸篓 / 重命名 / 新建）----------
// 都带护栏：编辑只认文本类、删除走系统废纸篓可恢复、名称拒绝路径分隔符与空字节。

async function writeTextFile(p, content, expectedMtime) {
  const file = resolvePath(p);
  if (!TEXT_EXT.has(ext(file))) throw new Error('只支持文本类文件编辑');
  if (typeof content !== 'string') throw new Error('内容非法');
  // 并发覆盖保护：打开编辑后文件被外部（agent）改过或删除，拒绝盲覆盖
  if (expectedMtime) {
    let cur = 0, missing = false;
    try { cur = (await fsp.stat(file)).mtimeMs; } catch { missing = true; }
    if (missing || (cur && Math.abs(cur - expectedMtime) > 1)) {
      const e = new Error(missing ? '文件已被外部删除' : '文件已被外部修改'); e.conflict = true; throw e;
    }
  }
  // 原子写：临时文件 + fsync + rename，写到一半崩溃也不会损坏原文件
  const tmp = `${file}.fanbox-tmp-${process.pid}-${Date.now()}`;
  try {
    const fh = await fsp.open(tmp, 'w');
    try { await fh.writeFile(content, 'utf8'); await fh.sync(); } finally { await fh.close(); }
    await fsp.rename(tmp, file);
  } catch (e) {
    await fsp.unlink(tmp).catch(() => {}); // 失败清理临时文件，不留残骸
    throw e;
  }
  const st = await fsp.stat(file);
  return { ok: true, size: st.size, mtime: st.mtimeMs };
}

// 移到系统废纸篓（可恢复），而非永久删除——呼应「不删除只归档」
function trashPath(p) {
  return new Promise((resolve) => {
    let target;
    try { target = resolvePath(p); } catch { return resolve({ ok: false, error: '非法路径' }); }
    let isDir = false;
    try { isDir = fs.lstatSync(target).isDirectory(); } catch { return resolve({ ok: false, error: '文件不存在' }); }
    let cmd;
    if (PLATFORM === 'darwin') {
      // 路径走 argv，不拼进单引号 AppleScript 字面量——避免含 ' 的文件名删除失败/注入
      // POSIX file 必须 as alias 强转，否则 Finder 解析不了报 -1728
      cmd = `osascript -e 'on run argv' -e 'tell application "Finder" to delete (POSIX file (item 1 of argv) as alias)' -e 'end run' ${shellQuote(target)}`;
    } else if (PLATFORM === 'win32') {
      const method = isDir ? 'DeleteDirectory' : 'DeleteFile';
      const ps = target.replace(/'/g, "''");
      cmd = `powershell -NoProfile -Command "Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::${method}('${ps}','OnlyErrorDialogs','SendToRecycleBin')"`;
    } else {
      cmd = `gio trash ${shellQuote(target)} || trash-put ${shellQuote(target)} || trash ${shellQuote(target)}`;
    }
    exec(cmd, (err) => {
      if (!err) return resolve({ ok: true });
      let msg = err.message;
      // Finder 自动化未授权（-1743/-600）给人话
      if (PLATFORM === 'darwin' && /-1743|-600|not allowed|authoriz/i.test(msg)) {
        msg = '需在「系统设置 → 隐私与安全性 → 自动化」里允许 FanBox 控制 Finder（首次删除会弹授权）';
      }
      resolve({ ok: false, error: msg });
    });
  });
}

function validName(name) {
  if (!name || typeof name !== 'string') return false;
  const n = name.trim();
  return n.length > 0 && n.length <= 255 && !/[\/\\\0]/.test(n) && n !== '.' && n !== '..';
}

async function renamePath(p, newName) {
  const src = resolvePath(p);
  newName = (newName || '').trim();
  if (!validName(newName)) throw new Error('名称不合法');
  const dst = path.join(path.dirname(src), newName);
  if (fs.existsSync(dst)) throw new Error('已存在同名项');
  await fsp.rename(src, dst);
  return { ok: true, path: dst };
}

// ---------- AI 整理：备料 + 在内嵌终端拉起交互式 agent（v2，对话式；v1 headless 提案已废弃）----------
// 翻箱不再后台跑 claude -p：把整理偏好、过往整理历史、工作约定写成 brief 文件，
// 前端在内嵌终端启动 claude/codex，方案摊给用户对话确认后由 agent 动手。
// 约定：agent 每批移动追加写 ORGANIZE_LOG_DIR 回滚日志（撤销在对话里完成）、收尾把新学到的偏好沉淀进 prefs 文件。
const ORGANIZE_LOG_DIR = path.join(CONFIG_DIR, 'organize-log');
const ORGANIZE_PREFS_FILE = path.join(CONFIG_DIR, 'organize-prefs.md');
const ORGANIZE_BRIEF_FILE = path.join(CONFIG_DIR, 'organize-brief.md');
const DEFAULT_ORGANIZE_STRATEGY = `- 默认归档：过时/低频的文件移入 _archive/ 下的语义子目录（如 _archive/截图/2026-06/）
- 同一主题的散文件归进语义明确的项目文件夹（项目制：一个项目一个文件夹，按需建议新文件夹）
- 归档之外，单独提一份「建议删除」清单（什么算该删由你判断：明显垃圾、可再生成的产物、过期大文件……），逐条给理由
- 删除须用户逐条点头；确认后移入废纸篓 ~/.Trash/（不直接 rm），并照常记进回滚日志
- 最近 7 天内有动静的文件视为正在进行的工作，不要动
- 文件夹一律不动，只整理松散文件
- 拿不准的单独列出来问，宁可少动不要乱动`;

// codex 各版本旗标常变（0.139 移除了 --full-auto）：按 --help 实测有什么用什么，
// 全不认识就裸跑——退化成多几次审批确认，但不会因 unexpected argument 拉不起来
async function codexOrganizeFlags(bin) {
  const help = await new Promise((resolve) => {
    execFile(bin, ['--help'], { timeout: 8000 }, (err, stdout) => resolve(err ? '' : String(stdout)));
  });
  if (help.includes('--full-auto')) return ' --full-auto';
  let flags = '';
  if (help.includes('--sandbox')) flags += ' --sandbox workspace-write';
  if (help.includes('--ask-for-approval')) flags += ' -a on-request';
  if (help.includes('--add-dir')) flags += ` --add-dir "${CONFIG_DIR}"`;
  return flags;
}

async function findAgentBin(name) {
  // GUI 启动的 app 没有用户 shell 的 PATH，走登录 shell 找一次绝对路径
  return new Promise((resolve) => {
    execFile('/bin/zsh', ['-lc', `command -v ${name}`], { timeout: 8000 }, (err, stdout) => {
      const out = String(stdout || '').trim().split('\n').pop();
      resolve(!err && out && out.startsWith('/') ? out : null);
    });
  });
}

// 最近几次整理日志的一句话摘要，给 agent 当历史参照（日志由 agent 按 brief 约定写入）
async function organizeHistory() {
  let files = [];
  try { files = (await fsp.readdir(ORGANIZE_LOG_DIR)).filter((f) => f.endsWith('.json')); } catch { return ''; }
  files.sort().reverse();
  const lines = [];
  for (const f of files.slice(0, 3)) {
    try {
      const log = JSON.parse(await fsp.readFile(path.join(ORGANIZE_LOG_DIR, f), 'utf8'));
      const m0 = (log.moves || [])[0];
      const sample = m0 ? `（如 ${path.basename(m0.from)} → ${path.relative(log.dir, m0.to)}）` : '';
      lines.push(`- ${new Date(log.at).toLocaleString('zh-CN')} 整理过 ${log.dir}，移动 ${(log.moves || []).length} 项${sample}`);
    } catch { /* 坏日志跳过 */ }
  }
  return lines.join('\n');
}

// 备料并返回终端启动命令：brief 写盘（偏好 + 历史 + 工作约定），前端用 term.runInDir 拉起交互式 agent
async function organizeLaunch(b) {
  const dir = resolvePath(b.path);
  const cfg = await readConfig();
  let engine = cfg.organizeEngine === 'codex' ? 'codex' : 'claude';
  let bin = await findAgentBin(engine);
  if (!bin) {
    const alt = engine === 'claude' ? 'codex' : 'claude';
    bin = await findAgentBin(alt);
    if (bin) engine = alt;
    else return { ok: false, error: '没找到 claude / codex 命令——AI 整理需要装其中一个 CLI' };
  }
  const prefs = await fsp.readFile(ORGANIZE_PREFS_FILE, 'utf8').catch(() => '');
  const history = await organizeHistory();
  const brief = `# AI 整理任务（翻箱 FanBox 生成，每次启动覆盖本文件）

你在翻箱的内嵌终端里，帮用户对话式整理这个文件夹：${dir}

## 工作流程
1. 先看现状：列出当前文件夹的松散文件（名字/类型/大小/修改时间）。文件夹和隐藏文件一律不动
2. 结合下面的整理偏好与历史，提出分组整理方案摊给用户——用户明确同意前，一个文件都不要动
3. 用户可能口头调整方案（「截图不动」「这几个归到XX」），以对话为准
4. 动手用 mv 移动，目标目录不存在先 mkdir -p
5. 每完成一批移动，按下面的格式写一份回滚日志，并告诉用户「想撤销随时说」
6. 收尾：把这次对话里新学到的用户偏好（规则/例外/纠正）一条一行追加进偏好文件，别重复已有条目

## 回滚日志（撤销能力全靠它，格式不能错）
每批移动写一个新文件 ${ORGANIZE_LOG_DIR}/<毫秒时间戳>.json，内容：
{"dir":"${dir}","at":<毫秒时间戳>,"moves":[{"from":"<移动前绝对路径>","to":"<移动后绝对路径>"}]}
用户要撤销时：读对应日志，逐条把 to 移回 from（from 位置已被占用的跳过并说明）

## 整理偏好（用户的长期规则，优先级最高）
${DEFAULT_ORGANIZE_STRATEGY}
${prefs.trim() ? `\n### 历次整理沉淀的偏好\n${prefs.trim()}\n` : ''}
## 偏好文件
${ORGANIZE_PREFS_FILE}（markdown 列表，新偏好追加在末尾）

## 最近整理历史
${history || '（还没有历史记录）'}
`;
  await fsp.mkdir(ORGANIZE_LOG_DIR, { recursive: true });
  await fsp.writeFile(ORGANIZE_BRIEF_FILE, brief, 'utf8');
  const kickoff = `先完整读 ${ORGANIZE_BRIEF_FILE}，然后按里面的约定，和我对话式整理当前文件夹`;
  // claude 跳权限确认（动手前方案已过人）；codex 旗标按当前版本实测拼出
  const cmd = engine === 'codex'
    ? `codex${await codexOrganizeFlags(bin)} "${kickoff}"`
    : `claude --dangerously-skip-permissions "${kickoff}"`;
  return { ok: true, engine, cmd };
}

// ---------- 发版向导：检查项目状态 → 改版本号/CHANGELOG → 命令序列交给内嵌终端跑（每步可见可拦）----------
async function releaseInspect(p) {
  const dir = resolvePath(p);
  const sh = (cmd, args) => new Promise((resolve) => execFile(cmd, args, { cwd: dir, timeout: 8000 }, (err, stdout) => resolve(err ? null : String(stdout).trim())));
  let pkg;
  try { pkg = JSON.parse(await fsp.readFile(path.join(dir, 'package.json'), 'utf8')); }
  catch { return { ok: false, error: '这里没有 package.json——发版向导目前只认 node 项目' }; }
  const out = { ok: true, dir, name: pkg.name || path.basename(dir), version: pkg.version || '0.0.0' };
  out.hasDist = !!(pkg.scripts && pkg.scripts.dist);
  out.remote = await sh('git', ['remote', 'get-url', 'origin']);
  out.branch = await sh('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
  const status = await sh('git', ['status', '--porcelain']);
  out.isRepo = status !== null;
  out.dirty = !!(status && status.length);
  out.gh = !!(await sh('/bin/sh', ['-lc', 'command -v gh']));
  out.unreleased = ''; out.hasChangelog = false;
  try {
    const cl = await fsp.readFile(path.join(dir, 'CHANGELOG.md'), 'utf8');
    out.hasChangelog = true;
    const m = cl.match(/## \[Unreleased\]\s*([\s\S]*?)(?=\n## \[|$)/);
    if (m) out.unreleased = m[1].trim();
  } catch { /* 没有 CHANGELOG 不挡发版 */ }
  return out;
}

async function releasePrepare(b) {
  const dir = resolvePath(b.path);
  const version = String(b.version || '').trim();
  if (!/^\d+\.\d+\.\d+/.test(version)) return { ok: false, error: '版本号格式不对（要 x.y.z）' };
  const notes = String(b.notes || '').trim();
  // 1) package.json 版本号
  const pkgFile = path.join(dir, 'package.json');
  let pkgRaw;
  try { pkgRaw = await fsp.readFile(pkgFile, 'utf8'); } catch { return { ok: false, error: '读不到 package.json' }; }
  if (!/"version"\s*:\s*"[^"]*"/.test(pkgRaw)) return { ok: false, error: 'package.json 里没有 version 字段' };
  await fsp.writeFile(pkgFile, pkgRaw.replace(/"version"\s*:\s*"[^"]*"/, `"version": "${version}"`), 'utf8');
  // 2) CHANGELOG：Unreleased 段落升格为新版本，开新的空 Unreleased
  const clFile = path.join(dir, 'CHANGELOG.md');
  try {
    const cl = await fsp.readFile(clFile, 'utf8');
    if (cl.includes('## [Unreleased]')) {
      const date = new Date().toISOString().slice(0, 10);
      const next = cl.replace(/## \[Unreleased\][\s\S]*?(?=\n## \[|$)/, `## [Unreleased]\n\n## [${version}] - ${date}\n\n${notes}\n\n`);
      await fsp.writeFile(clFile, next, 'utf8');
    }
  } catch { /* 没有 CHANGELOG 跳过 */ }
  // 3) 发布说明落临时文件给 gh 用；命令序列拼好交还前端注入终端
  const notesFile = path.join(os.tmpdir(), `fanbox-release-notes-${Date.now()}.md`);
  await fsp.writeFile(notesFile, notes || `v${version}`, 'utf8');
  // 标题优先取第一个要点的内容，「### Added」这类小节头当不了标题
  const lines = notes.split('\n').map((l) => l.trim()).filter(Boolean);
  const firstBullet = lines.find((l) => /^[-*]\s/.test(l));
  const firstPlain = lines.find((l) => !/^#/.test(l));
  const title = (firstBullet || firstPlain || '').replace(/^[#\-*\s]+/, '').slice(0, 60);
  const steps = [];
  if (b.doDist) steps.push('npm run dist');
  steps.push('git add -A', `git commit -m ${shellQuote(`v${version}: ${title || '发版'}`)}`);
  if (b.doPush) steps.push('git push');
  if (b.doRelease) steps.push(`gh release create v${version} --title ${shellQuote(`v${version}${title ? ' · ' + title : ''}`)} --notes-file ${shellQuote(notesFile)}${b.doDist ? ` dist/*${version}*.dmg` : ''}`);
  return { ok: true, cmd: steps.join(' && ') };
}

// ---------- 项目记忆：这个文件夹里 AI 干过什么 ----------
// 数据源：~/.claude/projects/<munge(cwd)>/*.jsonl + ~/.codex/sessions/**/rollout-*.jsonl（头部 cwd 匹配）
//        + ~/.kimi-code/session_index.jsonl（全局索引→state.json）+ ~/.local/share/opencode/storage/session/**/ses_*.json（directory 字段匹配）。
// 单会话解析结果按 (size, mtime) 缓存，再次打开只重解析有变化的文件。统一会话对象 {id, agent, title, firstT, lastT, userMsgs, files, skills}。
// userMsgs 允许为 null 表示「未统计」（kimi/opencode 只读元数据不解析消息正文），前端遇到 null 不渲染条数；0 保留给「确实数过是零条」。
const projMemCache = new Map(); // file -> { size, mtimeMs, sess }
const mungeClaudeDir = (cwd) => cwd.replace(/[^A-Za-z0-9]/g, '-');

async function parseClaudeSession(fp, st) {
  const hit = projMemCache.get(fp);
  if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.sess;
  const sess = { id: path.basename(fp, '.jsonl'), agent: 'claude', title: '', model: '', firstT: 0, lastT: st.mtimeMs, userMsgs: 0, files: [], skills: [], lastSignal: '', bg: [] };
  const filesSet = new Set(), skillsSet = new Set(), bgNotified = new Set();
  // 流式逐行，廉价字符串预判后才 JSON.parse——大会话文件也不整读进内存
  const stream = fs.createReadStream(fp, { encoding: 'utf8' });
  let rest = '';
  const lineT = (line) => { const m = line.match(/"timestamp":"([^"]+)"/); return m ? (Date.parse(m[1]) || 0) : 0; };
  const handleLine = (line) => {
    if (!sess.firstT) {
      const m = line.match(/"timestamp":"([^"]+)"/);
      if (m) sess.firstT = Date.parse(m[1]) || 0;
    }
    // ==== 二开: cockpit —— 四态判定的三个标量（lastSignal / bg 句柄栈 / 通知回收）====
    // sidechain（subagent 内部消息）不参与：它的收尾不代表主对话的收尾
    if (!line.includes('"isSidechain":true')) {
      // 提取该会话客户端侧真实设定的模型 ID（只信 attachment.identity.modelId 与 /model 回执，保留渠道前缀与 [1m]；
      // 绝不用网关回包的 assistant.message.model 覆盖——网关回包会剥掉 [1m] 并改写成后端底层名如 deepseek-v4-flash）
      if (line.includes('"type":"attachment"') && line.includes('"modelId":"')) {
        try {
          const d = JSON.parse(line);
          const mid = d.attachment && d.attachment.type === 'model' && d.attachment.identity && d.attachment.identity.modelId;
          if (mid && typeof mid === 'string') sess.model = mid.trim();
        } catch { /* */ }
      } else if (line.includes('<local-command-stdout>') && line.includes('Set model to')) {
        try {
          const d = JSON.parse(line);
          const c = typeof (d.message && d.message.content) === 'string' ? d.message.content : '';
          if (c.includes('<local-command-stdout>')) {
            const m = c.replace(/\x1b\[[0-9;]*m/g, '').match(/Set model to `([A-Za-z0-9._:\-\[\]\/]+)`/);
            if (m) sess.model = m[1];
          }
        } catch { /* */ }
      }
      if (line.includes('"type":"assistant"')) {
        if (line.includes('"type":"tool_use"')) {
          try {
            const d = JSON.parse(line);
            const content = d.message && Array.isArray(d.message.content) ? d.message.content : [];
            const tools = content.filter((x) => x.type === 'tool_use');
            if (tools.length) {
              sess.lastSignal = tools.some((x) => x.name === 'AskUserQuestion') ? 'ask' : 'tool';
              const t = lineT(line) || st.mtimeMs;
              for (const x of tools) {
                // 后台句柄：Monitor 按自身 timeout 回收；bg Bash / bg Agent 靠通知或 3h 窗口兜底
                if (x.name === 'Monitor') sess.bg.push({ t, timeoutMs: Number(x.input && x.input.timeout_ms) || 0 });
                else if ((x.name === 'Bash' || x.name === 'Agent') && x.input && x.input.run_in_background === true) sess.bg.push({ t, timeoutMs: 0 });
              }
            } else if (content.some((x) => x.type === 'text')) sess.lastSignal = 'other';
          } catch { sess.lastSignal = 'tool'; /* 解析失败按最常见形态算 */ }
        } else if (line.includes('"type":"text"')) sess.lastSignal = 'other'; // 回合以纯文字收尾
      } else if (line.includes('"type":"user"') && !line.includes('"isMeta":true')) {
        // 工具结果回来 = agent 还在干；真人输入 = 回答了 ask / 新一轮开始
        sess.lastSignal = line.includes('"tool_use_id"') ? 'tool' : 'other';
      }
      if (line.includes('task-notification')) {
        // 同一条通知会出现在 enqueue / 消费 等多行——按 task-id 去重，一条通知只回收一个句柄
        const m = line.match(/<task-id>([^<]+)<\/task-id>/);
        const key = m ? m[1] : 'line-' + lineT(line);
        if (!bgNotified.has(key)) { bgNotified.add(key); sess.bg.shift(); }
      }
    }
    if (line.includes('"type":"user"') && !line.includes('"isMeta":true') && !line.includes('"tool_use_id"')) {
      sess.userMsgs++;
      if (!sess.title) {
        try {
          const d = JSON.parse(line);
          const c = d.message && d.message.content;
          let text = typeof c === 'string' ? c : (Array.isArray(c) ? (c.find((x) => x.type === 'text') || {}).text || '' : '');
          text = text.trim();
          if (text && !text.startsWith('<') && !text.startsWith('Caveat:')) sess.title = text.slice(0, 160);
        } catch { /* */ }
      }
    }
    if (line.includes('"file_path"') && /"name":"(Write|Edit|MultiEdit|NotebookEdit)"/.test(line)) {
      try {
        const d = JSON.parse(line);
        const content = d.message && Array.isArray(d.message.content) ? d.message.content : [];
        for (const it of content) {
          if (it.type === 'tool_use' && it.input && it.input.file_path) filesSet.add(it.input.file_path);
        }
      } catch { /* */ }
    }
    if (line.includes('"name":"Skill"')) {
      try {
        const d = JSON.parse(line);
        const content = d.message && Array.isArray(d.message.content) ? d.message.content : [];
        for (const it of content) {
          if (it.type === 'tool_use' && it.name === 'Skill' && it.input && it.input.skill) skillsSet.add(String(it.input.skill).replace(/^.*:/, ''));
        }
      } catch { /* */ }
    } else if (line.includes('<command-name>')) {
      const m = line.match(/<command-name>\s*\/?([\w.:-]+)\s*<\/command-name>/);
      if (m) skillsSet.add(m[1].replace(/^.*:/, ''));
    }
  };
  for await (const chunk of stream) {
    rest += chunk;
    let idx;
    while ((idx = rest.indexOf('\n')) !== -1) { handleLine(rest.slice(0, idx)); rest = rest.slice(idx + 1); }
  }
  if (rest.trim()) handleLine(rest);
  sess.files = [...filesSet].slice(0, 80);
  sess.skills = [...skillsSet].slice(0, 20);
  sess.bg = sess.bg.slice(-20); // 未回收句柄封顶：3h 窗口外的在判定时自然失效，缓存里不用留几百个
  projMemCache.set(fp, { size: st.size, mtimeMs: st.mtimeMs, sess });
  return sess;
}

// ==== 二开: cockpit —— 「被打开的会话」探活 ====
// 数据源：~/.claude/sessions/<PID>.json 注册表（每个交互式 claude 进程自己写，含当前 sessionId），
// 再用一次 ps 批量核对 pid 是否还活着——死进程留下的 stale 注册表不算数。
// 这天然覆盖所有宿主：FanBox 内嵌终端、iTerm、Warp、系统终端里跑的 claude 全都有注册表。
const CLAUDE_SESS_REG = path.join(HOME, '.claude', 'sessions');
let liveSessCache = { at: 0, ids: new Set() };
async function liveClaudeSessionIds() {
  if (Date.now() - liveSessCache.at < 5000) return liveSessCache.ids; // 5s 缓存：侧栏轮询不至于每次都 ps
  const entries = [];
  try {
    for (const n of await fsp.readdir(CLAUDE_SESS_REG)) {
      if (!n.endsWith('.json')) continue;
      try {
        const j = JSON.parse(await fsp.readFile(path.join(CLAUDE_SESS_REG, n), 'utf8'));
        if (j && j.pid && j.sessionId) entries.push({ pid: Number(j.pid), sid: String(j.sessionId) });
      } catch { /* 单个坏文件不拦 */ }
    }
  } catch { /* 目录不存在 = 没有活会话 */ }
  const ids = new Set();
  if (entries.length) {
    const alive = await new Promise((resolve) => {
      execFile('ps', ['-p', entries.map((e) => e.pid).join(','), '-o', 'pid='], { timeout: 3000 }, (err, out) => {
        resolve(new Set(String(out || '').split('\n').map((s) => Number(s.trim())).filter(Boolean)));
      });
    });
    for (const e of entries) if (alive.has(e.pid)) ids.add(e.sid);
  }
  liveSessCache = { at: Date.now(), ids };
  return ids;
}

// ==== 二开: cockpit —— 某个活会话跑在哪：FanBox 终端 id 或外部宿主（覆盖 Claude + Antigravity + Devin）====
// 点击已打开的 session 时前端要「切换到对应 tab」而不是再开一个。前端只认自己标记过的 tab，
// 手动在 FanBox 终端里敲 claudex / agy / devin 起的会话没有标记——靠 ps eww 读进程环境里的
// FANBOX_TERM_ID（pty:spawn 注入的）来配对；读不到 = 会话在 iTerm/Warp/Terminal 等外部宿主跑。
async function sessionHost(sessId, agent = '') {
  if (!sessId) return { ok: true, open: false, termId: null };
  let pid = 0;
  if (!agent || agent === 'claude') {
    try {
      for (const n of await fsp.readdir(CLAUDE_SESS_REG)) {
        if (!n.endsWith('.json')) continue;
        try {
          const j = JSON.parse(await fsp.readFile(path.join(CLAUDE_SESS_REG, n), 'utf8'));
          if (j && j.sessionId === sessId && j.pid) { pid = Number(j.pid); break; }
        } catch { /* */ }
      }
    } catch { /* */ }
  }
  if (!pid && (!agent || agent === 'agy')) {
    pid = (await liveAgySessions(true)).get(sessId) || 0;
  }
  if (!pid && (!agent || agent === 'devin')) {
    pid = (await liveDevinSessions(true)).get(sessId) || 0;
  }
  if (!pid) return { ok: true, open: false, termId: null };
  const readEnv = (p) => new Promise((resolve) => {
    execFile('ps', ['eww', '-o', 'ppid=,command=', '-p', String(p)], { timeout: 3000 }, (err, out) => resolve(err ? '' : String(out || '')));
  });
  const envLine = await readEnv(pid);
  if (!envLine) return { ok: true, open: false, termId: null }; // 进程已死（stale 注册表）
  let m = envLine.match(/FANBOX_TERM_ID=(\w+)/);
  // devin 持锁的是子进程 `devin acp`，若子进程环境未检出则回溯父进程 REPL 兜底
  if (!m) {
    const ppid = Number((envLine.trim().split(/\s+/)[0]) || 0);
    if (ppid > 1) {
      const pLine = await readEnv(ppid);
      if (pLine) m = pLine.match(/FANBOX_TERM_ID=(\w+)/);
    }
  }
  return { ok: true, open: true, termId: m ? m[1] : null }; // termId=null → 外部宿主（iTerm/Warp 等）
}

// ==== 二开: cockpit —— 四态判定（纯函数，不改缓存）====
// running    进行中：最后一轮是工具调用/工具结果，且 jsonl 在活跃窗口内仍有写入（防被中断的僵尸蓝点）
// waiting    等待确认：最后一轮停在 AskUserQuestion（其后无任何回答/新对话）
// background 后台运行：有未回收的后台句柄（Monitor 按 timeout+30s 提前失效，其余 3h 窗口兜底）
// done       执行完成：以上都不是
const SESS_BG_WINDOW = 3 * 3600 * 1000;
function decideSessionStatus(sess, activeWindowMs, now = Date.now()) {
  if (sess.lastSignal === 'tool' && now - sess.lastT < activeWindowMs) return 'running';
  if (sess.lastSignal === 'ask') return 'waiting';
  if ((sess.bg || []).some((h) => now - h.t < SESS_BG_WINDOW && (!h.timeoutMs || now < h.t + h.timeoutMs + 30000))) return 'background';
  return 'done';
}

// ==== 二开: cockpit —— Google Antigravity (agy) 会话索引、探活与四态判定 ====
// 数据源：~/.gemini/antigravity-cli/conversation_summaries.db（SQLite WAL 权威索引）
// 探活：活着的 agy 进程会持有 presence/<uuid>.lock 的打开 fd（pgrep 筛进程 + lsof 按 pid 定向读）
// 四态：summary.status (CASCADE_RUN_STATUS_*) + 单会话库 steps 末步状态（9=WAITING 等待审批）
const AGY_HOME = path.join(HOME, '.gemini', 'antigravity-cli');
const AGY_SUM_DB = path.join(AGY_HOME, 'conversation_summaries.db');
const AGY_CONV_DIR = path.join(AGY_HOME, 'conversations');
const { fileURLToPath: agyFileUrlToPath } = require('url');
let agySumCache = { sig: '', rows: [] };
let liveAgyCache = { at: 0, map: new Map() };
const agyStepCache = new Map(); // convId -> { sig, stepStatus }

async function sqliteDbSig(dbPath) {
  let st;
  try { st = await fsp.stat(dbPath); } catch { return ''; }
  let wal = null;
  try { wal = await fsp.stat(dbPath + '-wal'); } catch { /* 非 WAL 或已 checkpoint */ }
  return `${st.size}:${st.mtimeMs}:${wal ? wal.size + ':' + wal.mtimeMs : 0}`;
}

function querySqliteJson(dbPath, sql) {
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/sqlite3', ['-json', dbPath, sql], { timeout: 3000, maxBuffer: 8 * 1024 * 1024 }, (err, out) => {
      if (err) return reject(err);
      const s = String(out || '').trim();
      if (!s) return resolve([]);
      try { resolve(JSON.parse(s)); } catch (e) { reject(e); }
    });
  });
}

async function listAgySummaries() {
  const sig = await sqliteDbSig(AGY_SUM_DB);
  if (!sig) return [];
  if (sig === agySumCache.sig) return agySumCache.rows;
  const sql = `SELECT conversation_id, title, preview, step_count, last_modified_time, workspace_uris, status, not_fully_idle
    FROM conversation_summaries WHERE nesting_depth = 0 AND parent_conversation_id = ''
    ORDER BY last_modified_time DESC LIMIT 500;`;
  let raw, convSet;
  try {
    const [rowsOut, dirNames] = await Promise.all([
      querySqliteJson(AGY_SUM_DB, sql),
      fsp.readdir(AGY_CONV_DIR).catch(() => []),
    ]);
    raw = rowsOut;
    convSet = new Set(dirNames);
  } catch { return agySumCache.rows; }
  const rows = [];
  for (const r of raw) {
    const id = String(r.conversation_id || '').trim();
    if (!id || (convSet.size && !convSet.has(id + '.db'))) continue; // 排除单会话库已不存在的孤儿摘要
    let cwd = '';
    try {
      const uris = JSON.parse(r.workspace_uris || '[]');
      const u = Array.isArray(uris) ? uris.find((x) => typeof x === 'string' && x.startsWith('file://')) : '';
      if (u) cwd = agyFileUrlToPath(u).replace(/\/+$/, '') || '/';
    } catch { /* */ }
    if (!cwd) continue;
    const title = String(r.title || r.preview || '').replace(/\s+/g, ' ').trim().slice(0, 160);
    const stepCount = Number(r.step_count) || 0;
    if (!title && stepCount <= 0) continue;
    const lastT = Date.parse(String(r.last_modified_time || '').replace(' ', 'T')) || 0;
    rows.push({
      id, cwd, title, stepCount, lastT,
      rawStatus: String(r.status || ''),
      notFullyIdle: Number(r.not_fully_idle) === 1,
    });
  }
  agySumCache = { sig, rows };
  return rows;
}

async function liveAgySessions(force = false) {
  if (!force && Date.now() - liveAgyCache.at < 5000) return liveAgyCache.map;
  const pids = await new Promise((resolve) => {
    execFile('pgrep', ['-x', 'agy'], { timeout: 2000 }, (err, out) => {
      resolve(String(out || '').split('\n').map((s) => Number(s.trim())).filter(Boolean));
    });
  });
  const map = new Map();
  if (pids.length) {
    const out = await new Promise((resolve) => {
      execFile('/usr/sbin/lsof', ['-nP', '-a', '-p', pids.join(','), '-F', 'pn'], { timeout: 3000 }, (err, stdout) => {
        resolve(String(stdout || ''));
      });
    });
    let curPid = 0;
    for (const line of out.split('\n')) {
      if (line.startsWith('p')) curPid = Number(line.slice(1)) || 0;
      else if (curPid && line.startsWith('n')) {
        const m = line.match(/\/antigravity-cli\/presence\/([0-9a-f-]{8,})\.lock$/i);
        if (m) map.set(m[1], curPid);
      }
    }
  }
  liveAgyCache = { at: Date.now(), map };
  return map;
}

function decodeAgyTailModel(hexStr) {
  if (!hexStr) return '';
  const b = Buffer.from(hexStr, 'hex');
  // gen_metadata 末尾 protobuf field 21 (0xaa 0x01 <len> <utf8>) 记录该步实际生效的模型显示名
  for (let i = b.length - 3; i >= 0; i--) {
    if (b[i] === 0xaa && b[i + 1] === 0x01) {
      const len = b[i + 2];
      if (len >= 3 && len <= 80 && i + 3 + len <= b.length) {
        const s = b.slice(i + 3, i + 3 + len).toString('utf8');
        if (/^[\x20-\x7e]+$/.test(s)) return s.trim();
      }
    }
  }
  return '';
}

async function agyConvMeta(convId) {
  const fp = path.join(AGY_CONV_DIR, convId + '.db');
  const sig = await sqliteDbSig(fp);
  if (!sig) return { stepStatus: 0, model: '' };
  const hit = agyStepCache.get(convId);
  if (hit && hit.sig === sig) return hit;
  let stepStatus = 0, model = '';
  try {
    const sql = 'SELECT (SELECT status FROM steps ORDER BY idx DESC LIMIT 1) AS step_status, (SELECT hex(substr(data, -180)) FROM gen_metadata ORDER BY idx DESC LIMIT 1) AS tail_hex;';
    const rows = await querySqliteJson(fp, sql);
    if (rows.length) {
      stepStatus = Number(rows[0].step_status) || 0;
      model = decodeAgyTailModel(rows[0].tail_hex);
    }
  } catch { return hit || { stepStatus: 0, model: '' }; }
  if (agyStepCache.size > 500) agyStepCache.clear();
  const entry = { sig, stepStatus, model };
  agyStepCache.set(convId, entry);
  return entry;
}

// CortexStepStatus (protobuf): 1=PENDING, 2=RUNNING, 3=DONE, 8=GENERATING, 9=WAITING(审批确认), 11=QUEUED
async function decideAgySessionStatus(row, stepSt, activeWindowMs, now = Date.now()) {
  if (stepSt === 9) return 'waiting';
  if (row.rawStatus === 'CASCADE_RUN_STATUS_RUNNING' || row.rawStatus === 'CASCADE_RUN_STATUS_BUSY' || row.rawStatus === 'CASCADE_RUN_STATUS_CANCELING') return 'running';
  if ((stepSt === 1 || stepSt === 2 || stepSt === 8 || stepSt === 11) && now - row.lastT < activeWindowMs) return 'running';
  if (row.notFullyIdle) return 'background';
  return 'done';
}

// ==== 二开: cockpit —— Devin CLI 会话索引、探活与四态判定 ====
// 数据源：~/.local/share/devin/cli/sessions.db（SQLite WAL 权威索引，created_at/last_activity_at 为秒级时间戳）
// 探活：活着的 `devin acp` 子进程持有 ~/.local/share/devin/cli/session_locks/<slug>.lock 打开 fd
// 四态：末条非 system 消息角色/工具调用 + tool_call_state 未完成工具数（ask_user_question → waiting）
const DEVIN_CLI_DIR = path.join(HOME, '.local', 'share', 'devin', 'cli');
const DEVIN_SESS_DB = path.join(DEVIN_CLI_DIR, 'sessions.db');
const DEVIN_CFG_FILE = path.join(HOME, '.config', 'devin', 'config.json');
let devinSessCache = { sig: '', rows: [] };
let liveDevinCache = { at: 0, map: new Map() };

async function listDevinSessions() {
  const sig = await sqliteDbSig(DEVIN_SESS_DB);
  if (!sig) return [];
  if (sig === devinSessCache.sig) return devinSessCache.rows;
  const sql = `WITH base AS (
      SELECT s.id, s.working_directory, s.model, s.created_at, s.last_activity_at, s.title, s.main_chain_id,
        (SELECT mn.row_id FROM message_nodes mn
          WHERE mn.session_id = s.id AND json_extract(mn.chat_message, '$.role') != 'system'
          ORDER BY mn.row_id DESC LIMIT 1) AS tail_rid
      FROM sessions s WHERE s.hidden = 0 ORDER BY s.last_activity_at DESC LIMIT 500
    )
    SELECT b.id, b.working_directory, b.model, b.created_at, b.last_activity_at, b.main_chain_id,
      COALESCE(NULLIF(TRIM(b.title), ''),
        (SELECT substr(ph.content, 1, 160) FROM prompt_history ph WHERE ph.session_id = b.id AND ph.is_shell = 0 ORDER BY ph.id ASC LIMIT 1),
        (SELECT substr(json_extract(mn0.chat_message, '$.content'), 1, 160) FROM message_nodes mn0
          WHERE mn0.session_id = b.id AND json_extract(mn0.chat_message, '$.role') = 'user'
            AND json_extract(mn0.chat_message, '$.metadata.is_user_input') = 1 ORDER BY mn0.row_id ASC LIMIT 1)
      ) AS eff_title,
      (SELECT COUNT(*) FROM prompt_history ph WHERE ph.session_id = b.id AND ph.is_shell = 0) AS prompt_cnt,
      (SELECT COUNT(*) FROM tool_call_state tcs WHERE tcs.session_id = b.id AND tcs.tool_call_update_json IS NULL) AS pending_tools,
      json_extract(tm.chat_message, '$.role') AS last_role,
      COALESCE(json_array_length(json_extract(tm.chat_message, '$.tool_calls')), 0) AS last_tool_cnt,
      json_extract(tm.chat_message, '$.tool_calls[0].name') AS first_tool_name
    FROM base b
    LEFT JOIN message_nodes tm ON tm.row_id = b.tail_rid;`;
  let raw;
  try { raw = await querySqliteJson(DEVIN_SESS_DB, sql); } catch { return devinSessCache.rows; }
  const rows = [];
  for (const r of raw) {
    const id = String(r.id || '').trim();
    const cwd = String(r.working_directory || '').replace(/\/+$/, '') || '';
    if (!id || !cwd) continue;
    const title = String(r.eff_title || '').replace(/\s+/g, ' ').trim().slice(0, 160);
    const promptCnt = Number(r.prompt_cnt) || 0;
    const hasChain = r.main_chain_id !== null && r.main_chain_id !== undefined;
    const userMsgs = promptCnt > 0 ? promptCnt : (hasChain && title ? 1 : 0);
    if (!title && userMsgs <= 0) continue;
    const sec = Number(r.last_activity_at) || Number(r.created_at) || 0;
    const lastT = sec > 1e12 ? sec : sec * 1000;
    rows.push({
      id, cwd, title, userMsgs, lastT,
      model: String(r.model || '').trim(),
      pendingTools: Number(r.pending_tools) || 0,
      lastRole: String(r.last_role || ''),
      lastToolCnt: Number(r.last_tool_cnt) || 0,
      firstToolName: String(r.first_tool_name || ''),
    });
  }
  devinSessCache = { sig, rows };
  return rows;
}

async function liveDevinSessions(force = false) {
  if (!force && Date.now() - liveDevinCache.at < 5000) return liveDevinCache.map;
  const pids = await new Promise((resolve) => {
    execFile('pgrep', ['-x', 'devin'], { timeout: 2000 }, (err, out) => {
      resolve(String(out || '').split('\n').map((s) => Number(s.trim())).filter(Boolean));
    });
  });
  const map = new Map();
  if (pids.length) {
    const out = await new Promise((resolve) => {
      execFile('/usr/sbin/lsof', ['-nP', '-a', '-p', pids.join(','), '-F', 'pn'], { timeout: 3000 }, (err, stdout) => {
        resolve(String(stdout || ''));
      });
    });
    let curPid = 0;
    for (const line of out.split('\n')) {
      if (line.startsWith('p')) curPid = Number(line.slice(1)) || 0;
      else if (curPid && line.startsWith('n')) {
        const m = line.match(/\/devin\/cli\/session_locks\/([A-Za-z0-9_-]+)\.lock$/);
        if (m) map.set(m[1], curPid);
      }
    }
  }
  liveDevinCache = { at: Date.now(), map };
  return map;
}

function decideDevinSessionStatus(row, activeWindowMs, now = Date.now()) {
  if (row.firstToolName === 'ask_user_question' && (row.pendingTools > 0 || row.lastRole === 'assistant')) return 'waiting';
  if (row.pendingTools > 0 && now - row.lastT < Math.max(activeWindowMs, 600000)) return 'running';
  if ((row.lastRole === 'user' || row.lastRole === 'tool' || row.lastToolCnt > 0) && now - row.lastT < activeWindowMs) return 'running';
  return 'done';
}

async function parseCodexSession(fp, st) {
  const hit = projMemCache.get(fp);
  if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.sess;
  const sess = { id: '', agent: 'codex', title: '', firstT: st.birthtimeMs || 0, lastT: st.mtimeMs, userMsgs: 0, files: [], skills: [] };
  try {
    const txt = await fsp.readFile(fp, 'utf8');
    for (const line of txt.split('\n')) {
      if (!sess.id && line.includes('session_meta')) {
        const m = line.match(/"id":"([0-9a-f-]{8,})"/);
        if (m) sess.id = m[1];
      }
      if (line.includes('"role":"user"') && line.includes('input_text')) {
        try {
          const d = JSON.parse(line);
          const payload = d.payload || d;
          const item = payload.type === 'message' ? payload : null;
          if (item) {
            const text = (item.content || []).filter((x) => x.type === 'input_text').map((x) => x.text).join(' ').trim();
            // 环境上下文/IDE 注入的供述跳过，只要人打的字
            if (text && !text.startsWith('<')) { sess.userMsgs++; if (!sess.title) sess.title = text.slice(0, 160); }
          }
        } catch { /* */ }
      }
    }
  } catch { /* */ }
  if (!sess.id) sess.id = path.basename(fp, '.jsonl').replace(/^rollout-[\d-]*T[\d-]*-/, '');
  projMemCache.set(fp, { size: st.size, mtimeMs: st.mtimeMs, sess });
  return sess;
}

// Kimi Code 适配器：~/.kimi-code/session_index.jsonl 是现成的全局索引（sessionId → sessionDir + workDir），
// 按 workDir 过滤后逐个读 state.json 拿标题/时间戳，完全不用碰 wire.jsonl 协议日志。
// 消息数/改过的文件埋在 wire.jsonl 里（协议带版本号 1.4，会漂移），列表页不值得挖——给默认值。
const KIMI_HOME = path.join(HOME, '.kimi-code');
async function listKimiSessions(cwd) {
  const out = [];
  let idx;
  try { idx = await fsp.readFile(path.join(KIMI_HOME, 'session_index.jsonl'), 'utf8'); } catch { return out; } // 没装/没用过 Kimi Code
  for (const line of idx.split('\n')) {
    if (!line.includes('"workDir"')) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    if (rec.workDir !== cwd || !rec.sessionId || !rec.sessionDir) continue;
    const fp = path.join(String(rec.sessionDir), 'state.json');
    try {
      const st = await fsp.stat(fp);
      const hit = projMemCache.get(fp);
      if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) { out.push(hit.sess); continue; }
      const d = JSON.parse(await fsp.readFile(fp, 'utf8'));
      const title = String(d.title || d.lastPrompt || '').trim().slice(0, 160);
      const sess = { id: rec.sessionId, agent: 'kimi', title, firstT: Date.parse(d.createdAt) || 0, lastT: Date.parse(d.updatedAt) || st.mtimeMs, userMsgs: null, files: [], skills: [] };
      projMemCache.set(fp, { size: st.size, mtimeMs: st.mtimeMs, sess });
      out.push(sess);
    } catch { /* 单条会话坏了不拖垮整个列表 */ }
  }
  return out;
}

// opencode 适配器：~/.local/share/opencode/storage/session/<projectID>/ses_*.json 单文件即全部元数据，
// 按 JSON 里的 directory 字段过滤（目录名是 projectID hash，没法从 cwd 正向算，只能全扫——文件小，先 stat 排序封顶控 IO）。
// summary.files 只有改动数量没有路径列表，前端要的是可点击的路径，所以 files 给空数组。
const OPENCODE_SESS = path.join(HOME, '.local', 'share', 'opencode', 'storage', 'session');
async function listOpencodeSessions(cwd) {
  const out = [];
  let projDirs;
  try { projDirs = await fsp.readdir(OPENCODE_SESS, { withFileTypes: true }); } catch { return out; } // 没装/没用过 opencode
  const files = [];
  for (const pd of projDirs) {
    if (!pd.isDirectory()) continue;
    let names;
    try { names = await fsp.readdir(path.join(OPENCODE_SESS, pd.name)); } catch { continue; }
    for (const n of names) {
      if (!n.startsWith('ses_') || !n.endsWith('.json')) continue;
      const fp = path.join(OPENCODE_SESS, pd.name, n);
      try { files.push({ fp, st: await fsp.stat(fp) }); } catch { /* */ }
    }
  }
  files.sort((a, b) => b.st.mtimeMs - a.st.mtimeMs);
  for (const { fp, st } of files.slice(0, 200)) {
    try {
      const hit = projMemCache.get(fp);
      if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) { if (hit.dir === cwd) out.push(hit.sess); continue; }
      const d = JSON.parse(await fsp.readFile(fp, 'utf8'));
      const dir = String(d.directory || '');
      const t = d.time || {};
      const sess = { id: String(d.id || path.basename(fp, '.json')), agent: 'opencode', title: String(d.title || '').trim().slice(0, 160), firstT: Number(t.created) || 0, lastT: Number(t.updated) || st.mtimeMs, userMsgs: null, files: [], skills: [] };
      projMemCache.set(fp, { size: st.size, mtimeMs: st.mtimeMs, sess, dir });
      if (dir === cwd) out.push(sess);
    } catch { /* 单条会话坏了不拖垮整个列表 */ }
  }
  return out;
}

async function projectMemory(p) {
  const cwd = resolvePath(p);
  const sessions = [];
  // Claude Code：项目目录名就是 munge 过的 cwd，正向算一遍直达
  try {
    const base = path.join(CLAUDE_PROJ, mungeClaudeDir(cwd));
    const names = (await fsp.readdir(base)).filter((n) => n.endsWith('.jsonl'));
    const stats = (await Promise.all(names.map(async (n) => {
      const fp = path.join(base, n);
      try { return { fp, st: await fsp.stat(fp) }; } catch { return null; }
    }))).filter(Boolean).sort((a, b) => b.st.mtimeMs - a.st.mtimeMs).slice(0, 40);
    for (const { fp, st } of stats) sessions.push(await parseClaudeSession(fp, st));
  } catch { /* 这个目录没有 Claude Code 会话 */ }
  // Codex：近期 rollout 文件按头部 cwd 匹配（数量封顶控 IO）
  try {
    const files = [];
    const walk = async (dir, depth) => {
      let names;
      try { names = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const n of names) {
        const fp = path.join(dir, n.name);
        if (n.isDirectory() && depth < 3) await walk(fp, depth + 1);
        else if (n.isFile() && n.name.endsWith('.jsonl')) {
          try { files.push({ fp, st: await fsp.stat(fp) }); } catch { /* */ }
        }
      }
    };
    await walk(CODEX_SESS, 0);
    files.sort((a, b) => b.st.mtimeMs - a.st.mtimeMs);
    for (const { fp, st } of files.slice(0, 60)) {
      try { if ((await readCwdFromHead(fp, 16384)) === cwd) sessions.push(await parseCodexSession(fp, st)); } catch { /* */ }
    }
  } catch { /* 没用过 Codex */ }
  // Kimi Code / opencode：适配器内部已各自兜底，这里再包一层——任何一家格式漂移都不拖垮整个面板
  try { sessions.push(...await listKimiSessions(cwd)); } catch { /* */ }
  try { sessions.push(...await listOpencodeSessions(cwd)); } catch { /* */ }
  // 没有正经标题的会话（纯 warmup / 空会话）沉底，按最近活跃排
  sessions.sort((a, b) => (b.title ? 1 : 0) - (a.title ? 1 : 0) || b.lastT - a.lastT);
  sessions.sort((a, b) => b.lastT - a.lastT);
  return { ok: true, cwd, sessions: sessions.filter((s) => s.title || s.files.length).slice(0, 40) };
}

// ---------- 磁盘占用透视：算清当前目录每个子项的真实占用 ----------
// 文件直接 stat（快）；目录一次 du -sk 批量算。du 碰到无权限子目录会报错但仍输出能算的部分，所以忽略 err 只用 stdout
async function diskUsage(p) {
  const dir = resolvePath(p);
  let names;
  try { names = await fsp.readdir(dir, { withFileTypes: true }); } catch (e) { return { ok: false, error: '读取失败：' + e.message }; }
  const dirs = [], items = [];
  await Promise.all(names.map(async (d) => {
    const full = path.join(dir, d.name);
    if (d.isDirectory() && !d.isSymbolicLink()) { dirs.push(full); return; }
    try { const st = await fsp.lstat(full); if (st.isFile()) items.push({ name: d.name, size: st.size, isDir: false }); } catch { /* */ }
  }));
  if (dirs.length) {
    const out = await new Promise((resolve) => {
      execFile('du', ['-sk', ...dirs], { timeout: 120000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => resolve(stdout || ''));
    });
    for (const line of out.split('\n')) {
      const m = line.match(/^(\d+)\s+(.+)$/);
      if (m) items.push({ name: path.basename(m[2]), size: Number(m[1]) * 1024, isDir: true });
    }
  }
  items.sort((a, b) => b.size - a.size);
  const total = items.reduce((a, b) => a + b.size, 0);
  return { ok: true, dir, total, items: items.slice(0, 60), more: Math.max(0, items.length - 60) };
}

// 压缩包内容清单：全用系统自带工具（unzip / bsdtar / gzip），保持零依赖
// 直接读 zip 中央目录拿文件名：按「通用位标记 bit 11 = UTF-8」决定编码，没设就按 GBK 解（中文名才不乱码）。
// 系统 unzip/bsdtar 会先把字节转码、丢失原始编码，没法事后挽救，所以自己解。zip64/异常结构返回 null 交回退。
async function zipNames(file, MAX) {
  let fd;
  try {
    fd = await fsp.open(file, 'r');
    const { size } = await fd.stat();
    const tailLen = Math.min(size, 65557); // EOCD 22 字节 + 最多 65535 注释
    const tail = Buffer.alloc(tailLen);
    await fd.read(tail, 0, tailLen, size - tailLen);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) { if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; } }
    if (eocd < 0) return null;
    const cdCount = tail.readUInt16LE(eocd + 10);
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOffset = tail.readUInt32LE(eocd + 16);
    if (cdOffset === 0xffffffff || cdSize === 0xffffffff) return null; // zip64，超出本简单解析
    const cd = Buffer.alloc(cdSize);
    await fd.read(cd, 0, cdSize, cdOffset);
    const gbk = new TextDecoder('gbk');
    const out = [];
    let p = 0;
    for (let i = 0; i < cdCount && p + 46 <= cd.length; i++) {
      if (cd.readUInt32LE(p) !== 0x02014b50) break; // central file header 签名
      const flag = cd.readUInt16LE(p + 8);
      const usize = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      const nameBuf = cd.subarray(p + 46, p + 46 + nameLen);
      let nm;
      if (flag & 0x800) nm = nameBuf.toString('utf8');
      else { try { nm = gbk.decode(nameBuf); } catch { nm = nameBuf.toString('utf8'); } }
      out.push({ name: nm, size: usize });
      p += 46 + nameLen + extraLen + commentLen;
      if (out.length > MAX) break;
    }
    return out;
  } catch { return null; } // 解析失败一律交给 unzip 兜底
  finally { if (fd) await fd.close().catch(() => {}); }
}

async function archiveList(p) {
  const file = resolvePath(p);
  try { await fsp.stat(file); } catch { return { ok: false, error: '文件不存在' }; }
  const name = path.basename(file).toLowerCase();
  // 压缩包里的中文名常是 GBK/CP936 且没设 UTF-8 标志位，按 UTF-8 读会乱码：
  // 拿原始字节，先严格按 UTF-8 解，失败（多半是 GBK 中文名）再回退 GBK。
  const decodeMaybeGbk = (buf) => {
    try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); }
    catch { try { return new TextDecoder('gbk').decode(buf); } catch { return buf.toString('latin1'); } }
  };
  const run = (cmd, args) => new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 15000, maxBuffer: 8 * 1024 * 1024, encoding: 'buffer' }, (err, stdout) => (err ? reject(err) : resolve(decodeMaybeGbk(stdout))));
  });
  const MAX = 800;
  const entries = [];
  try {
    if (/\.(zip|jar)$/.test(name)) {
      const parsed = await zipNames(file, MAX); // 自读中央目录，中文名按 GBK/UTF-8 正确解（unzip 会乱码）
      if (parsed) {
        entries.push(...parsed);
      } else { // zip64 / 异常结构本解析器够不着：回退 unzip（名字可能乱码，但至少列得出）
        const out = await run('unzip', ['-l', '--', file]);
        for (const line of out.split('\n')) {
          const m = line.match(/^\s*(\d+)\s+\S+\s+\S+\s+(.+)$/);
          if (m) entries.push({ name: m[2], size: Number(m[1]) });
          if (entries.length > MAX) break;
        }
      }
    } else if (/\.(tar|tgz|tbz2?|txz)$/.test(name) || /\.tar\.(gz|bz2|xz|zst)$/.test(name)) {
      const out = await run('tar', ['-tf', file]); // bsdtar 自动识别压缩格式
      for (const line of out.split('\n')) {
        if (line.trim()) entries.push({ name: line });
        if (entries.length > MAX) break;
      }
    } else if (/\.gz$/.test(name)) {
      const out = await run('gzip', ['-l', file]);
      const m = out.split('\n')[1] && out.split('\n')[1].match(/^\s*\d+\s+(\d+)/);
      entries.push({ name: path.basename(file, '.gz'), size: m ? Number(m[1]) : undefined });
    } else {
      return { ok: false, error: '7z / rar 没有系统自带的解析工具，可在系统解压软件中打开' };
    }
  } catch (e) {
    return { ok: false, error: '读取失败：' + (e.message || '').split('\n')[0] };
  }
  const truncated = entries.length > MAX;
  return { ok: true, entries: entries.slice(0, MAX), truncated };
}

// ==== 二开: office —— Office 三件套（xlsx/xls · docx/doc · pptx/ppt）零 npm 依赖原地预览 ====
const zlib = require('zlib');
const officePdfInflight = new Map(); // cacheKey -> Promise<string|null>

function xmlUnesc(s) {
  return String(s || '')
    .replace(/_x000D_\n?/gi, '\n')
    .replace(/_x([0-9a-fA-F]{4})_/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

function htmlEsc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function readOoxmlZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65558); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('无效的 OOXML 文件结构');
  const cdCount = buf.readUInt16LE(eocd + 10);
  let pos = buf.readUInt32LE(eocd + 16);
  const map = new Map();
  for (let i = 0; i < cdCount && pos + 46 <= buf.length; i++) {
    if (buf.readUInt32LE(pos) !== 0x02014b50) break;
    const method = buf.readUInt16LE(pos + 10);
    const compSize = buf.readUInt32LE(pos + 20);
    const fnLen = buf.readUInt16LE(pos + 28);
    const exLen = buf.readUInt16LE(pos + 30);
    const cmLen = buf.readUInt16LE(pos + 32);
    const localOffset = buf.readUInt32LE(pos + 42);
    const name = buf.slice(pos + 46, pos + 46 + fnLen).toString('utf8');
    map.set(name, { method, compSize, localOffset });
    pos += 46 + fnLen + exLen + cmLen;
  }
  const getBuf = (name) => {
    const e = map.get(name);
    if (!e || e.localOffset + 30 > buf.length) return null;
    if (buf.readUInt32LE(e.localOffset) !== 0x04034b50) return null;
    const fnLen = buf.readUInt16LE(e.localOffset + 26);
    const exLen = buf.readUInt16LE(e.localOffset + 28);
    const start = e.localOffset + 30 + fnLen + exLen;
    const raw = buf.slice(start, start + e.compSize);
    if (e.method === 0) return raw;
    if (e.method === 8) return zlib.inflateRawSync(raw);
    return null;
  };
  const getText = (name) => { const b = getBuf(name); return b ? b.toString('utf8') : ''; };
  return { names: [...map.keys()], getBuf, getText };
}

function parseXlsxBuffer(buf) {
  const zip = readOoxmlZip(buf);
  const shared = [];
  const sstXml = zip.getText('xl/sharedStrings.xml');
  if (sstXml) {
    const siRe = /<(?:\w+:)?si[\s>][\s\S]*?<\/(?:\w+:)?si>/g;
    let m;
    while ((m = siRe.exec(sstXml)) !== null) {
      const clean = m[0].replace(/<(?:\w+:)?rPh[\s>][\s\S]*?<\/(?:\w+:)?rPh>/g, '');
      let text = '';
      const tRe = /<(?:\w+:)?t(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?t>/g;
      let tm;
      while ((tm = tRe.exec(clean)) !== null) text += xmlUnesc(tm[1]);
      shared.push(text);
    }
  }
  // 识别日期样式，把 Excel 序列号转回可读日期
  const dateFmtIds = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 57, 58]);
  const dateStyleIdx = new Set();
  const stylesXml = zip.getText('xl/styles.xml');
  if (stylesXml) {
    const nfRe = /<(?:\w+:)?numFmt\b([^>]*)\/?>/g;
    let m;
    while ((m = nfRe.exec(stylesXml)) !== null) {
      const idM = m[1].match(/\bnumFmtId="(\d+)"/);
      const codeM = m[1].match(/\bformatCode="([^"]*)"/);
      if (idM && codeM) {
        const code = xmlUnesc(codeM[1]).replace(/\[[^\]]*\]/g, '').replace(/"[^"]*"/g, '');
        if (/[ydh]/i.test(code) && !/[#0]\.[#0]/.test(code)) dateFmtIds.add(Number(idM[1]));
      }
    }
    const xfsM = stylesXml.match(/<(?:\w+:)?cellXfs\b[^>]*>([\s\S]*?)<\/(?:\w+:)?cellXfs>/);
    if (xfsM) {
      const xfRe = /<(?:\w+:)?xf\b([^>]*)(?:\/>|>[\s\S]*?<\/(?:\w+:)?xf>)/g;
      let idx = 0, xm;
      while ((xm = xfRe.exec(xfsM[1])) !== null) {
        const nf = xm[1].match(/\bnumFmtId="(\d+)"/);
        if (nf && dateFmtIds.has(Number(nf[1]))) dateStyleIdx.add(idx);
        idx++;
      }
    }
  }
  const fmtExcelDate = (num) => {
    if (!Number.isFinite(num) || num < 1 || num > 2958465) return String(num);
    const ms = Math.round((num - 25569) * 86400000);
    const d = new Date(ms);
    if (Number.isNaN(d.getTime())) return String(num);
    const pad = (n) => String(n).padStart(2, '0');
    const dayStr = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
    const secInDay = Math.round(((num % 1) + 1) % 1 * 86400);
    if (secInDay >= 60) return `${dayStr} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
    return dayStr;
  };
  const relMap = new Map();
  const relXml = zip.getText('xl/_rels/workbook.xml.rels');
  if (relXml) {
    const rRe = /<Relationship\b([^>]*)\/?>/g;
    let m;
    while ((m = rRe.exec(relXml)) !== null) {
      const idM = m[1].match(/\bId="([^"]+)"/), tgM = m[1].match(/\bTarget="([^"]+)"/);
      if (idM && tgM) {
        let tg = tgM[1].replace(/^\/+/, '');
        if (!tg.startsWith('xl/')) tg = 'xl/' + tg.replace(/^\.\//, '');
        relMap.set(idM[1], tg);
      }
    }
  }
  const sheetDefs = [];
  const wbXml = zip.getText('xl/workbook.xml');
  if (wbXml) {
    const shRe = /<(?:\w+:)?sheet\b([^>]*)\/?>/g;
    let m;
    while ((m = shRe.exec(wbXml)) !== null) {
      const nm = m[1].match(/\bname="([^"]*)"/);
      const rid = m[1].match(/\b(?:\w+:)?id="([^"]*)"/);
      const entry = (rid && relMap.get(rid[1])) || `xl/worksheets/sheet${sheetDefs.length + 1}.xml`;
      sheetDefs.push({ name: nm ? xmlUnesc(nm[1]) : `Sheet${sheetDefs.length + 1}`, entry });
    }
  }
  if (!sheetDefs.length) {
    zip.names.filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(n)).sort().forEach((n, i) => sheetDefs.push({ name: `Sheet${i + 1}`, entry: n }));
  }
  const colIdxOf = (ref) => {
    const m = String(ref || '').match(/^[A-Za-z]+/);
    if (!m) return -1;
    let n = 0;
    for (const ch of m[0].toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
    return n - 1;
  };
  const MAX_ROWS = 500, MAX_COLS = 80;
  const sheets = [];
  for (const sd of sheetDefs) {
    const xml = zip.getText(sd.entry);
    if (!xml) continue;
    const rows = [];
    let totalRows = 0, maxCol = 0;
    const dimM = xml.match(/<(?:\w+:)?dimension\b[^>]*\bref="[A-Za-z]+\d+:([A-Za-z]+)(\d+)"/);
    const dimTotal = dimM ? Number(dimM[2]) || 0 : 0;
    const rowRe = /<(?:\w+:)?row\b[^>]*>([\s\S]*?)<\/(?:\w+:)?row>/g;
    let rm;
    while ((rm = rowRe.exec(xml)) !== null) {
      totalRows++;
      if (rows.length >= MAX_ROWS) {
        if (dimTotal >= totalRows) { totalRows = dimTotal; break; } // 超大表直接取 dimension 总行数，免扫十几万尾行
        continue;
      }
      const rowArr = [];
      let nextCol = 0;
      const cellRe = /<(?:\w+:)?c\b([^>]*)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?c>)/g;
      let cm;
      while ((cm = cellRe.exec(rm[1])) !== null) {
        const attrs = cm[1] || '', inner = cm[2] || '';
        const rM = attrs.match(/\br="([A-Za-z]+\d+)"/);
        const cIdx = rM ? colIdxOf(rM[1]) : nextCol;
        nextCol = cIdx + 1;
        if (cIdx < 0 || cIdx >= MAX_COLS) continue;
        const tM = attrs.match(/\bt="([^"]*)"/);
        const sM = attrs.match(/\bs="(\d+)"/);
        const tp = tM ? tM[1] : '';
        let val = '';
        if (tp === 'inlineStr') {
          const tRe = /<(?:\w+:)?t(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?t>/g;
          let tm; while ((tm = tRe.exec(inner)) !== null) val += xmlUnesc(tm[1]);
        } else {
          const vM = inner.match(/<(?:\w+:)?v(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?v>/);
          const rawV = vM ? xmlUnesc(vM[1]) : '';
          if (tp === 's') val = shared[Number(rawV)] ?? rawV;
          else if (tp === 'b') val = rawV === '1' ? 'TRUE' : 'FALSE';
          else if (!tp && rawV !== '' && sM && dateStyleIdx.has(Number(sM[1]))) val = fmtExcelDate(Number(rawV));
          else if ((!tp || tp === 'n') && rawV !== '' && /^[-+]?\d+\.\d{7,}$/.test(rawV)) val = String(Number(Number(rawV).toPrecision(12)));
          else val = rawV;
        }
        while (rowArr.length <= cIdx) rowArr.push('');
        rowArr[cIdx] = val;
        if (val !== '' && cIdx + 1 > maxCol) maxCol = cIdx + 1;
      }
      rows.push(rowArr);
    }
    const cols = Math.min(MAX_COLS, Math.max(maxCol, 1));
    const normRows = rows.filter((r) => r.some((c) => c !== '')).map((r) => {
      const out = r.slice(0, cols);
      while (out.length < cols) out.push('');
      return out;
    });
    sheets.push({ name: sd.name, rows: normRows, totalRows, truncated: totalRows > MAX_ROWS });
  }
  return sheets;
}

function scanTopXmlBlocks(xml, tags) {
  const out = [];
  const tagAlt = tags.map((t) => t.replace(':', '\\:')).join('|');
  const tokRe = new RegExp(`<(/?)(?:${tagAlt})(?=[\\s>/])([^>]*)>`, 'g');
  let depth = 0, curTag = '', startIdx = 0, m;
  while ((m = tokRe.exec(xml)) !== null) {
    const closing = m[1] === '/';
    const selfClose = !closing && m[2].endsWith('/');
    const matchedTag = m[0].slice(closing ? 2 : 1).split(/[\s>/]/)[0];
    if (!closing && !selfClose) {
      if (depth === 0) { curTag = matchedTag; startIdx = m.index; }
      if (matchedTag === curTag) depth++;
    } else if (closing && depth > 0 && matchedTag === curTag) {
      depth--;
      if (depth === 0) out.push({ tag: curTag, raw: xml.slice(startIdx, tokRe.lastIndex) });
    }
  }
  return out;
}

function mediaMimeOf(name) {
  const e = ext(name);
  return { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp' }[e] || '';
}

function parseDocxBuffer(buf) {
  const zip = readOoxmlZip(buf);
  const docXml = zip.getText('word/document.xml');
  if (!docXml) return '';
  const rels = new Map();
  const relXml = zip.getText('word/_rels/document.xml.rels');
  let imgBudget = 16 * 1024 * 1024;
  if (relXml) {
    const rRe = /<Relationship\b([^>]*)\/?>/g;
    let m;
    while ((m = rRe.exec(relXml)) !== null) {
      const idM = m[1].match(/\bId="([^"]+)"/), tgM = m[1].match(/\bTarget="([^"]+)"/), mdM = m[1].match(/\bTargetMode="([^"]+)"/);
      if (!idM || !tgM) continue;
      if (mdM && mdM[1] === 'External') { rels.set(idM[1], { external: true, url: xmlUnesc(tgM[1]) }); continue; }
      let tg = tgM[1].replace(/^\/+/, '');
      if (!tg.startsWith('word/')) tg = 'word/' + tg.replace(/^\.\//, '');
      const mime = mediaMimeOf(tg);
      if (mime && imgBudget > 0) {
        const b = zip.getBuf(tg);
        if (b && b.length <= 4 * 1024 * 1024 && b.length <= imgBudget) {
          imgBudget -= b.length;
          rels.set(idM[1], { dataUri: `data:${mime};base64,${b.toString('base64')}` });
        }
      }
    }
  }
  const renderRuns = (pXml) => {
    let html = '';
    const tokenRe = /<w:hyperlink\b([^>]*)>([\s\S]*?)<\/w:hyperlink>|<w:r\b[^>]*>([\s\S]*?)<\/w:r>/g;
    const renderOneRun = (rInner) => {
      let chunk = '';
      const blip = rInner.match(/<a:blip\b[^>]*\br:embed="([^"]+)"/);
      if (blip && rels.get(blip[1]) && rels.get(blip[1]).dataUri) {
        chunk += `<img src="${rels.get(blip[1]).dataUri}" alt="">`;
      }
      const partRe = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:br\b[^>]*\/?>|<w:tab\b[^>]*\/?>/g;
      let pm;
      while ((pm = partRe.exec(rInner)) !== null) {
        if (pm[0].startsWith('<w:br')) chunk += '<br>';
        else if (pm[0].startsWith('<w:tab')) chunk += '&emsp;';
        else chunk += htmlEsc(xmlUnesc(pm[1])).replace(/\n/g, '<br>');
      }
      if (!chunk) return '';
      const rPr = (rInner.match(/<w:rPr\b[^>]*>([\s\S]*?)<\/w:rPr>/) || [])[1] || '';
      if (/<w:b(?:\s|\/|>)/.test(rPr) && !/<w:b\s+w:val="(?:0|false)"/.test(rPr)) chunk = `<strong>${chunk}</strong>`;
      if (/<w:i(?:\s|\/|>)/.test(rPr) && !/<w:i\s+w:val="(?:0|false)"/.test(rPr)) chunk = `<em>${chunk}</em>`;
      if (/<w:u(?:\s|\/|>)/.test(rPr) && !/<w:u\s+w:val="none"/.test(rPr)) chunk = `<u>${chunk}</u>`;
      return chunk;
    };
    let m;
    while ((m = tokenRe.exec(pXml)) !== null) {
      if (m[2] !== undefined) {
        const ridM = (m[1] || '').match(/\br:id="([^"]+)"/);
        const rel = ridM && rels.get(ridM[1]);
        let innerHtml = '';
        const rr = /<w:r\b[^>]*>([\s\S]*?)<\/w:r>/g;
        let rm; while ((rm = rr.exec(m[2])) !== null) innerHtml += renderOneRun(rm[1]);
        if (rel && rel.external && /^https?:\/\//i.test(rel.url)) html += `<a href="${htmlEsc(rel.url)}" target="_blank" rel="noreferrer">${innerHtml || htmlEsc(rel.url)}</a>`;
        else html += innerHtml;
      } else {
        html += renderOneRun(m[3] || '');
      }
    }
    return html;
  };
  const renderParagraph = (pRaw) => {
    const pPr = (pRaw.match(/<w:pPr\b[^>]*>([\s\S]*?)<\/w:pPr>/) || [])[1] || '';
    const stM = pPr.match(/<w:pStyle\b[^>]*\bw:val="([^"]+)"/);
    const stVal = stM ? stM[1] : '';
    const isList = /<w:numPr\b/.test(pPr);
    const inner = renderRuns(pRaw);
    if (!inner.trim()) return '';
    if (/^(?:Title|标题)$/i.test(stVal)) return `<h1>${inner}</h1>`;
    const hm = stVal.match(/^(?:Heading|标题\s*)([1-6])$/i) || (/^[1-6]$/.test(stVal) ? [null, stVal] : null);
    if (hm) return `<h${hm[1]}>${inner}</h${hm[1]}>`;
    if (isList) return `<p class="office-li">• ${inner}</p>`;
    return `<p>${inner}</p>`;
  };
  const renderTable = (tblRaw) => {
    const innerXml = tblRaw.replace(/^<w:tbl\b[^>]*>|<\/w:tbl>$/g, '');
    const trBlocks = scanTopXmlBlocks(innerXml, ['w:tr']);
    if (!trBlocks.length) return '';
    let h = '<div class="csv-wrap"><table class="csv-table">';
    trBlocks.forEach((tr, rIdx) => {
      const tcBlocks = scanTopXmlBlocks(tr.raw.replace(/^<w:tr\b[^>]*>|<\/w:tr>$/g, ''), ['w:tc']);
      h += '<tr>';
      const cellTag = rIdx === 0 ? 'th' : 'td';
      tcBlocks.forEach((tc) => {
        const spanM = tc.raw.match(/<w:gridSpan\b[^>]*\bw:val="(\d+)"/);
        const spanAttr = spanM && Number(spanM[1]) > 1 ? ` colspan="${Number(spanM[1])}"` : '';
        const pBlocks = scanTopXmlBlocks(tc.raw.replace(/^<w:tc\b[^>]*>|<\/w:tc>$/g, ''), ['w:p', 'w:tbl']);
        const cellHtml = pBlocks.map((b) => (b.tag === 'w:tbl' ? renderTable(b.raw) : renderRuns(b.raw))).filter(Boolean).join('<br>');
        h += `<${cellTag}${spanAttr}>${cellHtml}</${cellTag}>`;
      });
      h += '</tr>';
    });
    return h + '</table></div>';
  };
  const bodyXml = (docXml.match(/<w:body\b[^>]*>([\s\S]*?)<\/w:body>/) || [])[1] || docXml;
  const blocks = scanTopXmlBlocks(bodyXml, ['w:p', 'w:tbl']);
  return blocks.map((b) => (b.tag === 'w:tbl' ? renderTable(b.raw) : renderParagraph(b.raw))).filter(Boolean).join('\n');
}

function parsePptxSlidesBuffer(buf) {
  const zip = readOoxmlZip(buf);
  const slideEntries = zip.names.filter((n) => /^ppt\/slides\/slide\d+\.xml$/i.test(n))
    .sort((a, b) => Number(a.match(/(\d+)\.xml$/)[1]) - Number(b.match(/(\d+)\.xml$/)[1]));
  let imgBudget = 16 * 1024 * 1024;
  return slideEntries.map((entry, idx) => {
    const xml = zip.getText(entry);
    const sName = path.basename(entry);
    const relXml = zip.getText(`ppt/slides/_rels/${sName}.rels`);
    const imgMap = new Map();
    if (relXml) {
      const rRe = /<Relationship\b([^>]*)\/?>/g;
      let m;
      while ((m = rRe.exec(relXml)) !== null) {
        const idM = m[1].match(/\bId="([^"]+)"/), tgM = m[1].match(/\bTarget="([^"]+)"/);
        if (!idM || !tgM) continue;
        const resolved = path.posix.normalize(path.posix.join('ppt/slides', tgM[1]));
        const mime = mediaMimeOf(resolved);
        if (mime && imgBudget > 0) {
          const b = zip.getBuf(resolved);
          if (b && b.length <= 4 * 1024 * 1024 && b.length <= imgBudget) {
            imgBudget -= b.length;
            imgMap.set(idM[1], `data:${mime};base64,${b.toString('base64')}`);
          }
        }
      }
    }
    const paras = [];
    const pRe = /<a:p\b[^>]*>([\s\S]*?)<\/a:p>/g;
    let pm;
    while ((pm = pRe.exec(xml)) !== null) {
      let line = '';
      const tRe = /<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g;
      let tm; while ((tm = tRe.exec(pm[1])) !== null) line += xmlUnesc(tm[1]);
      if (line.trim()) paras.push(line.trim());
    }
    const images = [];
    const bRe = /<a:blip\b[^>]*\br:embed="([^"]+)"/g;
    let bm;
    while ((bm = bRe.exec(xml)) !== null) {
      const uri = imgMap.get(bm[1]);
      if (uri && !images.includes(uri)) images.push(uri);
    }
    return { index: idx + 1, paras, images };
  });
}

async function findSofficeBin() {
  for (const cand of ['/opt/homebrew/bin/soffice', '/usr/local/bin/soffice', '/Applications/LibreOffice.app/Contents/MacOS/soffice']) {
    try { await fsp.access(cand, fs.constants.X_OK); return cand; } catch { /* */ }
  }
  return '';
}

async function convertPptToPdfCached(file, st) {
  const soffice = await findSofficeBin();
  if (!soffice) return null;
  await fsp.mkdir(THUMB_DIR, { recursive: true });
  const key = crypto.createHash('sha1').update(`${file}:${st.size}:${st.mtimeMs}`).digest('hex').slice(0, 20);
  const dstPdf = path.join(THUMB_DIR, `office-${key}.pdf`);
  try { if ((await fsp.stat(dstPdf)).size > 0) return dstPdf; } catch { /* 未缓存 */ }
  if (officePdfInflight.has(key)) return officePdfInflight.get(key);
  const job = (async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'fanbox-lo-'));
    const profDir = path.join(tmpDir, 'profile');
    try {
      await new Promise((resolve, reject) => {
        execFile(soffice, [`-env:UserInstallation=file://${profDir}`, '--headless', '--convert-to', 'pdf', '--outdir', tmpDir, file],
          { timeout: 30000 }, (err) => (err ? reject(err) : resolve()));
      });
      const outFiles = (await fsp.readdir(tmpDir)).filter((n) => n.toLowerCase().endsWith('.pdf'));
      if (!outFiles.length) return null;
      await fsp.copyFile(path.join(tmpDir, outFiles[0]), dstPdf);
      return dstPdf;
    } catch { return null; }
    finally { fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {}); officePdfInflight.delete(key); }
  })();
  officePdfInflight.set(key, job);
  return job;
}

async function officePreview(p) {
  const file = resolvePath(p);
  let st;
  try { st = await fsp.stat(file); } catch { return { ok: false, error: '文件不存在' }; }
  const e = ext(file);
  if (st.size > 60 * 1024 * 1024) return { ok: false, error: '文件超过 60MB，请点击右上角「打开」使用桌面软件查看' };
  try {
    if (e === 'xlsx') {
      const sheets = parseXlsxBuffer(await fsp.readFile(file));
      return { ok: true, sub: 'sheet', ext: e, size: st.size, mtime: st.mtimeMs, sheets };
    }
    if (e === 'xls') {
      const py = `import sys,json,xlrd\nwb=xlrd.open_workbook(sys.argv[1])\nout=[]\nfor s in wb.sheets():\n  rows=[[str(s.cell_value(r,c)) for c in range(min(s.ncols,80))] for r in range(min(s.nrows,500))]\n  out.append({"name":s.name,"rows":rows,"totalRows":s.nrows,"truncated":s.nrows>500})\nprint(json.dumps(out))`;
      const sheets = await new Promise((resolve, reject) => {
        execFile('/usr/bin/python3', ['-I', '-c', py, file], { timeout: 10000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
          if (err) return reject(new Error('老版 .xls 需要 python3 xlrd 或用桌面 Excel 打开'));
          try { resolve(JSON.parse(stdout)); } catch (ex) { reject(ex); }
        });
      });
      return { ok: true, sub: 'sheet', ext: e, size: st.size, mtime: st.mtimeMs, sheets };
    }
    if (e === 'docx' || e === 'doc') {
      let html = '';
      if (e === 'docx') {
        try { html = parseDocxBuffer(await fsp.readFile(file)); } catch { html = ''; }
      }
      if (!html && PLATFORM === 'darwin') {
        const rawHtml = await new Promise((resolve, reject) => {
          execFile('/usr/bin/textutil', ['-convert', 'html', '-stdout', file], { timeout: 10000, maxBuffer: 16 * 1024 * 1024 }, (err, out) => (err ? reject(err) : resolve(String(out || ''))));
        });
        const bodyM = rawHtml.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
        html = (bodyM ? bodyM[1] : rawHtml).replace(/\bcolor:\s*#000(?:000)?\b;?/gi, '').replace(/\bbackground(?:-color)?:\s*#fff(?:fff)?\b;?/gi, '');
      }
      if (!html) return { ok: false, error: '无法解析该 Word 文档' };
      return { ok: true, sub: 'doc', ext: e, size: st.size, mtime: st.mtimeMs, html };
    }
    if (e === 'pptx' || e === 'ppt') {
      const pdfPath = await convertPptToPdfCached(file, st);
      if (pdfPath) {
        return { ok: true, sub: 'pdf', ext: e, size: st.size, mtime: st.mtimeMs, pdfUrl: `/api/raw?path=${encodeURIComponent(pdfPath)}&v=${st.mtimeMs}` };
      }
      if (e === 'pptx') {
        const slides = parsePptxSlidesBuffer(await fsp.readFile(file));
        return { ok: true, sub: 'slides', ext: e, size: st.size, mtime: st.mtimeMs, slides };
      }
      return { ok: false, error: '老版 .ppt 预览需安装 LibreOffice，或点击右上角「打开」查看' };
    }
    return { ok: false, error: '不支持的 Office 格式' };
  } catch (err) {
    return { ok: false, error: '解析失败：' + (err.message || String(err)) };
  }
}

// 移动文件到目标目录（截图直通车「收进素材」等用）：同卷 rename，跨卷回退拷贝；同名自动加序号防覆盖
async function movePath(src, dstDir) {
  const s = resolvePath(src), d = resolvePath(dstDir);
  if (!fs.existsSync(s)) return { ok: false, error: '源文件不存在' };
  await fsp.mkdir(d, { recursive: true });
  let dst = path.join(d, path.basename(s));
  if (fs.existsSync(dst)) {
    const ex = path.extname(dst), base = path.basename(dst, ex);
    let i = 2;
    while (fs.existsSync(dst)) dst = path.join(d, `${base}-${i++}${ex}`);
  }
  try { await fsp.rename(s, dst); }
  catch (e) {
    if (e.code === 'EXDEV') { await fsp.copyFile(s, dst); await fsp.unlink(s); }
    else return { ok: false, error: e.message };
  }
  return { ok: true, path: dst };
}

async function createEntry(parentPath, name, type) {
  const parent = resolvePath(parentPath);
  name = (name || '').trim();
  if (!validName(name)) throw new Error('名称不合法');
  const target = path.join(parent, name);
  if (fs.existsSync(target)) throw new Error('已存在同名项');
  if (type === 'dir') await fsp.mkdir(target);
  else await fsp.writeFile(target, '', { flag: 'wx' });
  return { ok: true, path: target, isDir: type === 'dir' };
}

// 终端里点文件名 → 定位真实文件：直接 stat → 用 tail 做「空格扩展」逐候选 stat
// → scrollback 回扫候选（alt）逐个 stat → 多根 basename 搜索。
// 空格扩展：前端对带空格的文件名（macOS 截屏等）只能保守匹配到第一个空格，真实边界
// 由文件系统验证——把行尾余文按空格边界逐段拼回路径，哪个候选 stat 命中就是哪个
// 直接 stat + 行尾余文空格扩展（macOS 截屏名「截屏2026-06-10 15.37.43.png」靠这步补全）。
// locatePath 的前半段；也单独服务终端划线前的显示时验证
async function statWithTail(p, tail) {
  const tryStat = async (cand) => {
    try { const real = resolvePath(cand); const st = await fsp.stat(real); return { found: true, path: real, isDir: st.isDirectory() }; }
    catch { return null; }
  };
  if (!p) return null;
  const direct = await tryStat(p);
  if (direct) return direct;
  if (tail) {
    const t = String(tail).slice(0, 160).split(/['"`]/)[0];
    const cands = [];
    const re = /\s+/g; let m;
    while ((m = re.exec(t)) !== null && cands.length < 6) { if (m.index > 0) cands.push(p + t.slice(0, m.index)); }
    if (t.trim() && cands.length < 6) cands.push(p + t.replace(/\s+$/, ''));
    cands.sort((a, b) => b.length - a.length); // 长优先：偏向完整文件名
    for (const c of cands) {
      const hit = await tryStat(c.replace(/[)\]'"`,.:;。，]+$/, ''));
      if (hit) return hit;
    }
  }
  return null;
}

// 终端划线前的批量验证：候选路径 stat 得到才配下划线，中文散文里的「分发/产品演示」不再误标
async function termVerify(b) {
  const cwd = b.cwd ? resolvePath(b.cwd) : HOME;
  const items = Array.isArray(b.items) ? b.items.slice(0, 24) : [];
  const results = await Promise.all(items.map(async (it) => {
    if (!it || typeof it.cand !== 'string') return false;
    let p = it.cand;
    if (!p.startsWith('/') && !p.startsWith('~')) p = cwd.replace(/\/$/, '') + '/' + p.replace(/^\.\//, '');
    return !!(await statWithTail(p, it.tail || ''));
  }));
  return { ok: true, results };
}

async function locatePath(p, name, root, tail, alt, roots) {
  const tryStat = async (cand) => {
    try { const real = resolvePath(cand); const st = await fsp.stat(real); return { found: true, path: real, isDir: st.isDirectory() }; }
    catch { return null; }
  };
  const direct = await statWithTail(p, tail);
  if (direct) return direct;
  // scrollback 回扫候选（最近出现在前）：stat 验证，命中即信——它来自 agent 自己打印的全路径
  for (const a of String(alt || '').split('\n').filter(Boolean).slice(0, 3)) {
    const hit = await tryStat(a);
    if (hit) return { ...hit, viaScrollback: true };
  }
  if (name) {
    // 多根 basename 搜索：终端 cwd + 活跃项目根（前端传来）；同名多个取 mtime 最新（偏向「我刚生成的」）。
    // 所有根共享一个总截止点，避免点了不存在的名时多根 walk 串成十几秒
    const budget = Date.now() + 6000;
    const seen = []; let fuzzy = null;
    for (const r of [root, ...(roots || [])].filter(Boolean)) {
      let rr; try { rr = resolvePath(r); } catch { continue; }
      if (seen.some((d) => rr === d || rr.startsWith(d + path.sep))) continue; // 嵌套根去重
      seen.push(rr);
      try {
        const data = await searchFiles(name, rr, budget);
        const exact = (data.results || []).filter((x) => x.name === name).sort((a, b) => b.mtime - a.mtime)[0];
        if (exact) return { found: true, path: exact.path, isDir: exact.isDir, viaSearch: true };
        if (!fuzzy) fuzzy = (data.results || [])[0];
      } catch { /* */ }
    }
    if (fuzzy) return { found: true, path: fuzzy.path, isDir: fuzzy.isDir, viaSearch: true };
    // Spotlight 兜底（macOS）：截断路径常指向所有项目根之外（桌面、下载、临时目录），
    // 目录遍历够不着；按文件名全盘查，精确同名里取 mtime 最新的（偏向「刚生成的那个」）
    if (process.platform === 'darwin') {
      const paths = await mdfind(['-name', name]);
      let best = null;
      for (const f of (paths || []).slice(0, 200)) {
        if (path.basename(f) !== name) continue;
        try {
          const st = await fsp.stat(f);
          if (!best || st.mtimeMs > best.m) best = { path: f, isDir: st.isDirectory(), m: st.mtimeMs };
        } catch { /* */ }
      }
      if (best) return { found: true, path: best.path, isDir: best.isDir, viaSearch: true };
    }
  }
  return { found: false };
}

// ---------- Git（只读）：让「看 agent 改了什么」从瞬时高亮升级为可回看的 diff ----------
function execGit(args, cwd) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, timeout: 6000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: stdout || '', stderr: stderr || '' });
    });
  });
}
// 找到 dir 所在 git 仓库根；不是仓库返回 null
async function gitRoot(dir) {
  const r = await execGit(['-C', dir, 'rev-parse', '--show-toplevel'], dir);
  return r.ok ? r.stdout.trim() : null;
}
// 仓库工作区状态：返回相对仓库根的变更文件列表（含状态码）
async function gitStatus(dirPath) {
  const dir = resolvePath(dirPath);
  const root = await gitRoot(dir);
  if (!root) return { isRepo: false };
  const st = await execGit(['-C', root, 'status', '--porcelain'], root);
  const files = (st.stdout || '').split('\n').filter(Boolean).map((line) => {
    const code = line.slice(0, 2);
    let rest = line.slice(3);
    if (rest.includes(' -> ')) rest = rest.split(' -> ')[1]; // 重命名取新名
    rest = rest.replace(/^"|"$/g, '');
    return { code, status: code.trim(), path: path.join(root, rest), name: path.basename(rest) };
  });
  return { isRepo: true, root, files };
}
// 单文件 HEAD 版本 vs 工作区当前内容，供 Monaco DiffEditor 并排渲染
async function gitFileDiff(p) {
  const file = resolvePath(p);
  if (!TEXT_EXT.has(ext(file))) return { isRepo: true, diffable: false };
  const root = await gitRoot(path.dirname(file));
  if (!root) return { isRepo: false };
  const rel = path.relative(root, file).split(path.sep).join('/');
  let modified = '';
  try { modified = await fsp.readFile(file, 'utf8'); } catch { modified = ''; }
  const head = await execGit(['-C', root, 'show', `HEAD:${rel}`], root);
  return { isRepo: true, diffable: true, root, rel, original: head.ok ? head.stdout : '', modified, isNew: !head.ok };
}

// ---------- 回合安全带：影子 git 快照 + 一键回滚 ----------
// agent 每次开工前静默存档。GIT_DIR 放 ~/.fanbox/snapshots/<hash>/，项目文件夹里不落任何东西，
// 对用户自己的 git 仓库零干扰；非 git 项目从此也有 diff 基准和「回到上一轮之前」。
// 每个快照 = commit + tag（tag 保引用，回滚 reset 后历史不丢），tag 滚动裁剪控制磁盘。
const SNAP_ROOT = path.join(CONFIG_DIR, 'snapshots');
const SNAP_INDEX = path.join(SNAP_ROOT, 'index.json');
const SNAP_KEEP = 40; // 每项目保留的快照数
const SNAP_EXCLUDE = [
  'node_modules/', '.git/', 'dist/', 'build/', 'out/', '.next/', '.nuxt/', '.cache/',
  '.venv/', 'venv/', '__pycache__/', 'target/', 'Pods/', 'DerivedData/', '.gradle/',
  '.DS_Store', '*.dmg', '*.iso', '*.mp4', '*.mov', '*.avi', '*.mkv',
].join('\n') + '\n';
const snapThrottle = new Map(); // project → 上次尝试 ms（15s 内不重复扫）
const snapDead = new Set();     // 本次运行内放弃的目录（太大/超时），别每轮都撞一次
let snapUsageCache = null;      // { at, data }：du 一遍二十几 GB 要好几秒，60 秒内复用
// 符号链接归一化：/tmp → /private/tmp 这类别名会让 cwd 和 HOME 字符串对不上、绕过资格守卫
const snapReal = (p) => { try { return fs.realpathSync(p); } catch { return p; } };

function snapGitDir(project) {
  return path.join(SNAP_ROOT, crypto.createHash('sha1').update(project).digest('hex').slice(0, 16));
}
// project 传 null = 只碰裸仓库不挂工作区（项目目录可能已经不在了，cwd 落到快照根目录）
function execSnap(gitDir, project, args, timeout = 10000) {
  return new Promise((resolve) => {
    execFile('git', ['--git-dir', gitDir, ...(project ? ['--work-tree', project] : []), ...args],
      { cwd: project || SNAP_ROOT, timeout, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
        resolve({ ok: !err, killed: !!(err && err.killed), code: err ? err.code : 0, stdout: stdout || '', stderr: stderr || '' });
      });
  });
}
// 快照资格：拒掉家目录本身、~/Documents 这类一层大目录、Library/废纸篓/.fanbox 自己
// 传入的 project 必须已经 snapReal 归一化（snapshot() 入口统一做）
function snapEligible(project) {
  if (!project || !path.isAbsolute(project)) return false;
  const p = path.normalize(project).replace(/\/+$/, '');
  const realHome = snapReal(HOME);
  if (!p || p === '/' || p === HOME || p === realHome) return false;
  if (p.startsWith(CONFIG_DIR) || p.startsWith(snapReal(CONFIG_DIR))) return false;
  const base = [realHome, HOME].find((h) => p.startsWith(h + path.sep));
  if (base) {
    const segs = path.relative(base, p).split(path.sep);
    // ~/Documents 这类系统大目录整层不给存（自定义的 ~/myproj 一层目录放行）
    const SYS = new Set(['Documents', 'Desktop', 'Downloads', 'Pictures', 'Movies', 'Music', 'Public', 'Applications', 'Library', '.Trash']);
    if (segs.length === 1 && SYS.has(segs[0])) return false;
    if (segs[0] === 'Library' || segs[0] === '.Trash') return false;
  } else if (p.split(path.sep).filter(Boolean).length < 2) return false; // / 下一层（/tmp 等）不收
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}
// 零 tag 且零 commit 的影子仓库里没有任何可恢复内容，只剩失败的 commit 留下的孤立 blob
// （2026-08-29 实测 10 个这种仓库堆了 8.3GB）。整目录删掉——这是翻箱自己的缓存，不是用户文件。
// 判死活看 tag 不看 rev-list：快照全挂在 refs/tags/s* 下，健康仓库的 rev-list --all 也可能是 0
async function snapReapIfEmpty(gitDir) {
  if (!fs.existsSync(path.join(gitDir, 'HEAD'))) return false;
  const tags = await execSnap(gitDir, null, ['tag', '-l', 's*']);
  if (!tags.ok || tags.stdout.trim()) return false;
  const head = await execSnap(gitDir, null, ['rev-parse', '--verify', '-q', 'HEAD']);
  if (head.ok) return false;
  await fsp.rm(gitDir, { recursive: true, force: true });
  snapUsageCache = null;
  console.log('  🧹  清掉没有任何快照的影子仓库：' + path.basename(gitDir));
  return true;
}
async function snapReapAll() {
  let names = [];
  try { names = await fsp.readdir(SNAP_ROOT); } catch { return; }
  for (const n of names) if (/^[0-9a-f]{16}$/.test(n)) await snapReapIfEmpty(path.join(SNAP_ROOT, n));
}
async function snapEnsureRepo(project) {
  const gitDir = snapGitDir(project);
  await snapReapIfEmpty(gitDir); // 上次 commit 失败留下的空壳先清掉，重新 init 一个干净的
  if (!fs.existsSync(path.join(gitDir, 'HEAD'))) {
    await fsp.mkdir(gitDir, { recursive: true }).catch(() => {}); // git init 不建父目录
    const r = await execSnap(gitDir, project, ['init', '-q']);
    if (!r.ok) return null;
    await fsp.writeFile(path.join(gitDir, 'info', 'exclude'), SNAP_EXCLUDE).catch(() => {});
    // 登记 hash→项目路径，供「文件在哪个影子仓库」反查
    try {
      const idx = JSON.parse(await fsp.readFile(SNAP_INDEX, 'utf8').catch(() => '{}'));
      idx[path.basename(gitDir)] = project;
      await fsp.writeFile(SNAP_INDEX, JSON.stringify(idx, null, 2));
    } catch { /* 索引坏了不挡快照 */ }
  }
  return gitDir;
}
// 打一个快照：无变化不建 commit（天然去重），add 超时视为项目太大、本次运行内放弃
async function snapshot(project, label) {
  project = snapReal(path.normalize(resolvePath(project)).replace(/\/+$/, ''));
  if (!snapEligible(project)) return { ok: false, skipped: 'ineligible' };
  if (snapDead.has(project)) return { ok: false, skipped: 'dead' };
  const last = snapThrottle.get(project) || 0;
  if (Date.now() - last < 15000) return { ok: true, skipped: 'throttled' };
  snapThrottle.set(project, Date.now());
  const gitDir = await snapEnsureRepo(project);
  if (!gitDir) return { ok: false, skipped: 'init-failed' };
  const add = await execSnap(gitDir, project, ['add', '-A'], 25000);
  if (!add.ok) {
    if (add.killed) snapDead.add(project); // 超时 = 太大，别再试
    return { ok: false, skipped: add.killed ? 'too-big' : 'add-failed' };
  }
  // 「无变化」看索引与 HEAD 的差异（退出码 0 = 无变化，1 = 有变化，其余 = 出错；HEAD 未诞生时也成立），
  // 不再拿 commit 失败当依据：从前 commit 超时被当成「无变化」返回 ok，已 add 的 blob 永久留在仓库里
  // 每轮开工再堆一批，回滚还把这个假 ok 当「已备份」直接 reset --hard——那一轮丢的是真工作区
  const diff = await execSnap(gitDir, project, ['diff', '--cached', '--quiet'], 25000);
  if (diff.ok) return { ok: true, skipped: 'no-change' };
  if (diff.code !== 1) {
    if (diff.killed) snapDead.add(project);
    return { ok: false, skipped: 'diff-failed' };
  }
  const msg = String(label || '回合存档').slice(0, 120);
  const ci = await execSnap(gitDir, project, [
    '-c', 'user.name=FanBox', '-c', 'user.email=snapshot@fanbox.local', '-c', 'commit.gpgsign=false',
    'commit', '-q', '--no-verify', '-m', msg,
  ], 20000);
  if (!ci.ok) {
    // 真失败：索引退回上个快照，再把这轮刚写进 objects/ 的孤立对象清掉（reset 只动索引，对象还在）
    await execSnap(gitDir, project, ['reset', '-q'], 25000);
    await execSnap(gitDir, project, ['prune', '--expire=now'], 60000);
    if (ci.killed) snapDead.add(project);
    return { ok: false, skipped: 'commit-failed' };
  }
  const tag = `s${Date.now()}`;
  const tg = await execSnap(gitDir, project, ['tag', tag]);
  if (!tg.ok) return { ok: false, skipped: 'tag-failed' }; // 列表只认 tag，没打上等于没存
  // tag 滚动裁剪：超出 SNAP_KEEP 删最旧，gc 交给 git 自己看着办
  const tags = (await execSnap(gitDir, project, ['tag', '-l', 's*'])).stdout.split('\n').filter(Boolean).sort();
  if (tags.length > SNAP_KEEP) {
    await execSnap(gitDir, project, ['tag', '-d', ...tags.slice(0, tags.length - SNAP_KEEP)]);
    execSnap(gitDir, project, ['gc', '--auto', '-q'], 60000); // 不 await，后台随缘
  }
  snapUsageCache = null;
  return { ok: true, created: true, tag };
}
// 占用透视：每个影子仓库多大、几个快照、是否已失效（零 tag = 没有任何可恢复内容）
async function snapUsage() {
  if (snapUsageCache && Date.now() - snapUsageCache.at < 60000) return snapUsageCache.data;
  let idx = {};
  try { idx = JSON.parse(await fsp.readFile(SNAP_INDEX, 'utf8')); } catch { /* 没索引也能算大小 */ }
  let names = [];
  try { names = (await fsp.readdir(SNAP_ROOT)).filter((n) => /^[0-9a-f]{16}$/.test(n)); } catch { /* 还没存过档 */ }
  const sizes = {};
  if (names.length) {
    const out = await new Promise((resolve) => {
      execFile('du', ['-sk', ...names.map((n) => path.join(SNAP_ROOT, n))], { timeout: 120000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => resolve(stdout || ''));
    });
    for (const line of out.split('\n')) {
      const m = line.match(/^(\d+)\s+(.+)$/);
      if (m) sizes[path.basename(m[2])] = Number(m[1]) * 1024;
    }
  }
  const repos = [];
  for (const dir of names) {
    const tags = (await execSnap(path.join(SNAP_ROOT, dir), null, ['tag', '-l', 's*'])).stdout.split('\n').filter(Boolean);
    const lastAt = tags.reduce((a, t) => Math.max(a, Number(t.slice(1)) || 0), 0) || null; // tag 名就是打快照的毫秒时间戳
    repos.push({ project: idx[dir] || null, dir, bytes: sizes[dir] || 0, tags: tags.length, dead: tags.length === 0, lastAt });
  }
  repos.sort((a, b) => b.bytes - a.bytes);
  const data = { ok: true, total: repos.reduce((a, r) => a + r.bytes, 0), repos };
  snapUsageCache = { at: Date.now(), data };
  return data;
}
// 清理：删某个项目的整个影子仓库，或删全部失效仓库。返回释放的字节数
async function snapClean({ project, dead }) {
  snapUsageCache = null; // 释放多少要按此刻的真实大小算
  const usage = await snapUsage();
  let targets;
  if (dead) targets = usage.repos.filter((r) => r.dead);
  else if (project) {
    const norm = snapReal(path.normalize(resolvePath(project)).replace(/\/+$/, ''));
    targets = usage.repos.filter((r) => r.project === norm);
    if (!targets.length) return { ok: false, error: '这个目录还没有存档' };
  } else return { ok: false, error: '缺少参数' };
  let freed = 0;
  let idx = {};
  try { idx = JSON.parse(await fsp.readFile(SNAP_INDEX, 'utf8')); } catch { /* */ }
  for (const r of targets) {
    await fsp.rm(path.join(SNAP_ROOT, r.dir), { recursive: true, force: true });
    freed += r.bytes;
    delete idx[r.dir];
    if (r.project) { snapDead.delete(r.project); snapThrottle.delete(r.project); }
  }
  if (targets.length) await fsp.writeFile(SNAP_INDEX, JSON.stringify(idx, null, 2)).catch(() => {});
  snapUsageCache = null;
  return { ok: true, removed: targets.length, freed };
}
// 列出某目录的快照：精确命中或该目录在某个已存档项目内（取最长前缀）
async function snapResolveProject(p) {
  const norm = snapReal(path.normalize(resolvePath(p)).replace(/\/+$/, ''));
  let idx = {};
  try { idx = JSON.parse(await fsp.readFile(SNAP_INDEX, 'utf8')); } catch { return null; }
  let best = null;
  for (const proj of Object.values(idx)) {
    if ((norm === proj || norm.startsWith(proj + path.sep)) && (!best || proj.length > best.length)) {
      if (fs.existsSync(path.join(snapGitDir(proj), 'HEAD'))) best = proj;
    }
  }
  return best;
}
async function snapList(p) {
  const project = await snapResolveProject(p);
  if (!project) return { ok: true, project: null, snaps: [] };
  const gitDir = snapGitDir(project);
  const r = await execSnap(gitDir, project, [
    'for-each-ref', 'refs/tags/s*', '--sort=-creatordate',
    '--format=%(objectname)%09%(creatordate:unix)%09%(subject)',
  ]);
  const snaps = r.stdout.split('\n').filter(Boolean).map((line) => {
    const [hash, ts, ...rest] = line.split('\t');
    return { hash, ts: Number(ts) * 1000, label: rest.join('\t') };
  });
  return { ok: true, project, snaps };
}
// 回滚：先把当前状态自动存一份（回滚本身永远可撤销），再 reset --hard 到目标快照
async function snapRestore(p, hash) {
  const project = await snapResolveProject(p);
  if (!project) return { ok: false, error: '这个目录还没有存档' };
  if (!/^[0-9a-f]{7,40}$/i.test(String(hash || ''))) return { ok: false, error: '无效的快照标识' };
  const gitDir = snapGitDir(project);
  const has = await execSnap(gitDir, project, ['cat-file', '-e', `${hash}^{commit}`]);
  if (!has.ok) return { ok: false, error: '找不到这个快照' };
  snapThrottle.delete(project); // 安全存档绝不能被节流吞掉：没备份就 reset 等于毁数据
  const backup = await snapshot(project, '回滚前自动存档');
  // 硬门：只有「这次真的存下了」或「工作区与最新快照完全一致」才允许 reset --hard。
  // 别信 ok 字段——从前 commit 超时也返回 ok，回滚拿它当「已备份」，抹掉的是用户没存过的活
  if (!backup.created) {
    const st = await execSnap(gitDir, project, ['status', '--porcelain'], 25000);
    if (!st.ok || st.stdout.trim()) return { ok: false, error: '存档失败，未回滚' };
  }
  const r = await execSnap(gitDir, project, ['reset', '--hard', hash, '-q'], 60000);
  snapThrottle.delete(project); // 回滚后下一轮 agent 开工要能立刻存档
  if (!r.ok) return { ok: false, error: '恢复失败：' + (r.stderr || '').slice(0, 200) };
  return { ok: true, project };
}
// 影子 diff：文件不在 git 仓库时，以「上一回合快照」为基准出 original
async function snapFileDiff(file) {
  file = snapReal(file); // 项目路径是 realpath 存的，文件也归一化才能算出正确的相对路径
  const project = await snapResolveProject(path.dirname(file));
  if (!project) return null;
  const gitDir = snapGitDir(project);
  const head = await execSnap(gitDir, project, ['log', '-1', '--format=%ct']);
  if (!head.ok) return null;
  const rel = path.relative(project, file).split(path.sep).join('/');
  const show = await execSnap(gitDir, project, ['show', `HEAD:${rel}`]);
  let modified = '';
  try { modified = await fsp.readFile(file, 'utf8'); } catch { modified = ''; }
  return {
    isRepo: false, shadow: true, diffable: true, root: project, rel,
    baseTs: Number(head.stdout.trim()) * 1000,
    original: show.ok ? show.stdout : '', modified, isNew: !show.ok,
  };
}

// 图片编辑保存：前端 canvas 导出 dataURL（已含格式/尺寸/质量/标注），这里原子写回
async function saveImage({ path: target, dataUrl, newName }) {
  const m = /^data:image\/\w+;base64,(.+)$/s.exec(dataUrl || '');
  if (!m) throw new Error('无效图片数据');
  const buf = Buffer.from(m[1], 'base64');
  let dest = resolvePath(target);
  if (newName) {
    if (!validName(newName)) throw new Error('文件名不合法');
    dest = path.join(path.dirname(dest), newName);
    if (fs.existsSync(dest)) throw new Error('已存在同名文件');
  }
  const tmp = `${dest}.fanbox-tmp-${process.pid}-${Date.now()}`;
  try {
    const fh = await fsp.open(tmp, 'w');
    try { await fh.writeFile(buf); await fh.sync(); } finally { await fh.close(); }
    await fsp.rename(tmp, dest);
  } catch (e) { await fsp.unlink(tmp).catch(() => {}); throw e; }
  const st = await fsp.stat(dest);
  return { ok: true, path: dest, size: st.size };
}

function openInOS(target, withApp) {
  return new Promise((resolve) => {
    let cmd, args;
    if (withApp === 'terminal') {
      // 在该目录（文件则取其所在目录）打开系统终端，找回项目后一键去跑
      const dir = (() => { try { return fs.statSync(target).isDirectory() ? target : path.dirname(target); } catch { return path.dirname(target); } })();
      if (PLATFORM === 'darwin') cmd = `open -a Terminal ${shellQuote(dir)}`;
      else if (PLATFORM === 'win32') cmd = `start "" cmd /K cd /d "${dir}"`;
      else cmd = `x-terminal-emulator --working-directory=${shellQuote(dir)} || gnome-terminal --working-directory=${shellQuote(dir)} || xterm`;
      exec(cmd, (err) => resolve(err ? { ok: false, error: err.message } : { ok: true, with: 'terminal' }));
      return;
    }
    if (withApp === 'editor') {
      // 用 VS Code 打开（文件或文件夹）
      cmd = 'code';
      args = [target];
      const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
      child.on('error', () => {
        // 没装 code CLI，回退到系统默认
        openDefault(target, withApp).then(resolve);
      });
      child.on('spawn', () => { child.unref(); resolve({ ok: true, with: 'editor' }); });
      return;
    }
    openDefault(target, withApp).then(resolve);
  });
}

function openDefault(target, withApp) {
  return new Promise((resolve) => {
    let cmd;
    if (PLATFORM === 'darwin') {
      if (withApp === 'reveal') cmd = `open -R ${shellQuote(target)}`;
      else cmd = `open ${shellQuote(target)}`;
    } else if (PLATFORM === 'win32') {
      if (withApp === 'reveal') cmd = `explorer /select,"${target}"`;
      else cmd = `start "" "${target}"`;
    } else {
      if (withApp === 'reveal') cmd = `xdg-open ${shellQuote(path.dirname(target))}`;
      else cmd = `xdg-open ${shellQuote(target)}`;
    }
    exec(cmd, (err) => {
      if (err) resolve({ ok: false, error: err.message });
      else resolve({ ok: true, with: withApp || 'default' });
    });
  });
}

function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

function defaultRoots() {
  const candidates = [
    ['主目录', HOME],
    ['桌面', path.join(HOME, 'Desktop')],
    ['文档', path.join(HOME, 'Documents')],
    ['下载', path.join(HOME, 'Downloads')],
    ['代码 / Code', path.join(HOME, 'Code')],
    ['项目 / Projects', path.join(HOME, 'Projects')],
    ['Developer', path.join(HOME, 'Developer')],
  ];
  return candidates
    .filter(([, p]) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } })
    .map(([name, p]) => ({ name, path: p }));
}

// ---------- 静态资源 ----------

async function serveStatic(req, res, urlPath) {
  let rel = urlPath === '/' ? '/index.html' : urlPath;
  rel = decodeURIComponent(rel.split('?')[0]);
  const filePath = path.normalize(path.join(PUBLIC, rel));
  // 边界要带分隔符，否则 /path/to/public-evil 也会 startsWith('/path/to/public') 通过
  if (filePath !== PUBLIC && !filePath.startsWith(PUBLIC + path.sep)) { res.writeHead(403); res.end('forbidden'); return; }
  try {
    const data = await fsp.readFile(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext(filePath)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404); res.end('not found');
  }
}

// ---------- 缩略图（性能关键：不再把原图/原视频整文件当缩略图）----------
const THUMB_IMG_EXT = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'tiff', 'tif', 'heic', 'heif', 'avif']);
const ALPHA_IMG_EXT = new Set(['png', 'gif', 'webp', 'avif']); // 可能带透明通道：缩略图必须出 png，jpeg 会把透明拍成白底
const thumbInflight = new Map(); // cacheFile -> Promise，去重并发生成
function run(cmd, args) {
  return new Promise((resolve, reject) => execFile(cmd, args, { timeout: 15000 }, (e) => (e ? reject(e) : resolve())));
}
// 图片走 sips 缩放（快）；视频/PDF/其它走 qlmanage QuickLook 抽帧
async function generateThumb(src, e, size, cacheFile, isImg) {
  await fsp.mkdir(THUMB_DIR, { recursive: true });
  if (isImg) {
    const fmt = cacheFile.endsWith('.png') ? 'png' : 'jpeg';
    await run('sips', ['-s', 'format', fmt, '-Z', String(size), src, '--out', cacheFile]);
    return;
  }
  const tmpDir = path.join(THUMB_DIR, '_ql_' + process.pid + '_' + crypto.randomBytes(4).toString('hex'));
  await fsp.mkdir(tmpDir, { recursive: true });
  try {
    await run('qlmanage', ['-t', '-s', String(size), '-o', tmpDir, src]);
    const png = (await fsp.readdir(tmpDir)).find((f) => f.endsWith('.png'));
    if (!png) throw new Error('no thumb');
    await fsp.rename(path.join(tmpDir, png), cacheFile);
  } finally { fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {}); }
}
// 缩略图缓存按总体积上限做 LRU 裁剪（同一文件改一次就多一个缓存键，不清会无限涨）
async function pruneThumbs(maxBytes = 400 * 1024 * 1024) {
  try {
    const files = await fsp.readdir(THUMB_DIR);
    const stats = (await Promise.all(files.map(async (f) => {
      if (f.startsWith('_ql_')) return null;
      const fp = path.join(THUMB_DIR, f);
      // 按实际占用的块算而不是文件长度：几千个小 png 每个都有半块的零头，du 看到的比 size 之和多十几 MB
      try { const s = await fsp.stat(fp); return s.isFile() ? { fp, size: s.blocks ? s.blocks * 512 : s.size, t: s.mtimeMs } : null; } catch { return null; }
    }))).filter(Boolean);
    let total = stats.reduce((a, b) => a + b.size, 0);
    if (total <= maxBytes) return;
    stats.sort((a, b) => a.t - b.t); // 最旧的先删
    for (const f of stats) { if (total <= maxBytes) break; await fsp.unlink(f.fp).catch(() => {}); total -= f.size; }
  } catch { /* 目录不存在等，忽略 */ }
}
// 生成过新缩略图就排一次裁剪：从前只在启动时裁，一个会话里翻几千张图缓存就越过上限几十 MB
// （实测 461MB > 400MB）。合批成 5 秒一次，别让上百个并发 miss 各自 readdir 一遍几千个文件
let pruneTimer = null;
function pruneThumbsSoon() {
  if (pruneTimer) return;
  pruneTimer = setTimeout(() => { pruneTimer = null; pruneThumbs().catch(() => {}); }, 5000);
}

// 排版档把图片转 base64 时用：渲染进程受同源策略限制，抓不到图床里的外链图，
// 由本机服务代抓一次（带上源站 referer，绕开常见的防盗链）。只放行 http(s)，只回图片。
// 代抓目标限定公网：本机服务权限大，不给页面借道探测回环/内网/云元数据地址的机会；响应体设上限防撑爆内存。
// 三个易被绕过的点都要堵：①IPv6 URL 的 hostname 自带方括号（[::1]），丢给 DNS 查会被泛解析域名放行，
// 所以 IP 字面量剥括号后直接按网段判、绝不走 DNS；②长写法（0:0:0:0:0:0:0:1）正则会漏，按网段用 BlockList 算，
// 正则只兜底映射写法；③重定向逐跳校验——follow 模式下中间跳的内网请求已经真实发出去了。
const PRIVATE_HOST_RE = /^(127\.|10\.|0\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[789]\d|1[01]\d|12[0-7])\.)|^(::1$|::ffff:|f[cd]|fe80:)/i;
const PRIVATE_NETS = (() => {
  const bl = new (require('net').BlockList)();
  [['127.0.0.0', 8], ['10.0.0.0', 8], ['0.0.0.0', 8], ['192.168.0.0', 16], ['169.254.0.0', 16], ['172.16.0.0', 12], ['100.64.0.0', 10]]
    .forEach(([a, p]) => bl.addSubnet(a, p, 'ipv4'));
  // 注意别加 ::ffff:0:0/96：BlockList 会把普通 IPv4 也算进这条 v6 规则，公网图会被全拦。映射地址在下面单独拆。
  [['::1', 128], ['fc00::', 7], ['fe80::', 10]]
    .forEach(([a, p]) => bl.addSubnet(a, p, 'ipv6'));
  return bl;
})();
// ::ffff:127.0.0.1 和 ::ffff:7f00:1 是同一个回环的两种写法，取出内嵌的 v4 再判
function unmapV4(ip) {
  const m = /^::ffff:(.+)$/i.exec(ip);
  if (!m) return null;
  if (require('net').isIPv4(m[1])) return m[1];
  const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(m[1]);
  if (!hex) return null;
  const n = (parseInt(hex[1], 16) << 16) | parseInt(hex[2], 16);
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}
function isPrivateIp(ip) {
  const fam = require('net').isIP(ip);
  if (!fam) return false;
  if (fam === 6) {
    const v4 = unmapV4(ip);
    if (v4) return isPrivateIp(v4);
    return PRIVATE_NETS.check(ip, 'ipv6') || PRIVATE_HOST_RE.test(ip);
  }
  return PRIVATE_NETS.check(ip, 'ipv4') || PRIVATE_HOST_RE.test(ip);
}
async function assertPublicHost(hostname) {
  const bare = String(hostname || '').replace(/^\[|\]$/g, ''); // IPv6 hostname 形如 [::1]
  if (require('net').isIP(bare)) {
    if (isPrivateIp(bare)) throw new Error('只代抓公网图片地址');
    return;
  }
  const addrs = await require('dns').promises.lookup(bare, { all: true, verbatim: true });
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) throw new Error('只代抓公网图片地址');
}
const PROXY_IMG_MAX_BYTES = 20 * 1024 * 1024;
const PROXY_IMG_MAX_HOPS = 5;
async function proxyImage(res, url) {
  try {
    if (!/^https?:\/\//i.test(url || '')) return sendJSON(res, 400, { error: '只支持 http(s) 图片' });
    let target = url; let r = null;
    for (let hop = 0; hop <= PROXY_IMG_MAX_HOPS; hop++) {
      await assertPublicHost(new URL(target).hostname); // 每一跳发请求前都校验，重定向进内网直接断
      r = await fetch(target, {
        redirect: 'manual',
        headers: { 'user-agent': 'Mozilla/5.0', referer: new URL(target).origin + '/' },
        signal: AbortSignal.timeout(20000),
      });
      if (![301, 302, 303, 307, 308].includes(r.status)) break;
      const loc = r.headers.get('location');
      if (!loc) break;
      try { await r.body?.cancel(); } catch { /* 重定向响应体直接丢弃 */ }
      target = new URL(loc, target).href;
      if (!/^https?:$/i.test(new URL(target).protocol)) return sendJSON(res, 502, { error: '重定向到了非 http(s) 地址' });
      r = null; // 循环耗尽仍是重定向时以此为凭
    }
    if (!r) return sendJSON(res, 502, { error: '重定向次数过多' });
    const type = r.headers.get('content-type') || '';
    if (!r.ok || !/^image\//i.test(type)) return sendJSON(res, 502, { error: '抓不到这张图（HTTP ' + r.status + '）' });
    if (Number(r.headers.get('content-length') || 0) > PROXY_IMG_MAX_BYTES) return sendJSON(res, 502, { error: '图片超过 20MB，不代抓' });
    const chunks = []; let total = 0;
    for await (const chunk of r.body) {
      total += chunk.length;
      if (total > PROXY_IMG_MAX_BYTES) return sendJSON(res, 502, { error: '图片超过 20MB，不代抓' });
      chunks.push(chunk);
    }
    const buf = Buffer.concat(chunks);
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': buf.length, 'Cache-Control': 'no-store' });
    res.end(buf);
  } catch (e) {
    sendJSON(res, 502, { error: String((e && e.message) || e) });
  }
}

// ver：调用方带的内容版本号（文件 mtime）。带了 = 这个 URL 的内容永不再变，发长缓存；
// 没带 = 发协商缓存，靠 ETag 走 304，改过的图立刻能看见新的（md 里引用的图拿不到 mtime，走这条）
async function serveThumb(req, res, p, size, ver) {
  let src;
  try { src = resolvePath(p); } catch { res.writeHead(400); res.end('bad path'); return; }
  let st;
  try { st = await fsp.stat(src); if (!st.isFile()) throw 0; } catch { res.writeHead(404); res.end('not found'); return; }
  const s = Math.min(1600, Math.max(48, size || 240));
  const e = ext(src);
  const isImg = THUMB_IMG_EXT.has(e);
  const key = crypto.createHash('md5').update(src + ':' + st.mtimeMs + ':' + s).digest('hex');
  const jpegOut = isImg && !ALPHA_IMG_EXT.has(e);
  const cacheFile = path.join(THUMB_DIR, key + (jpegOut ? '.jpg' : '.png'));
  const type = jpegOut ? 'image/jpeg' : 'image/png';
  // key 已经把「源文件路径 + mtime + 目标宽度」全揉进去了，拿它当 ETag 天然精确
  const etag = '"' + key + '"';
  const cacheCtl = ver ? 'max-age=604800' : 'no-cache';
  if (req.headers['if-none-match'] === etag) { // 内容没变，不回体（本机 304 约 1ms）
    res.writeHead(304, { ETag: etag, 'Cache-Control': cacheCtl });
    res.end();
    return;
  }
  const sendCache = () => {
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': cacheCtl, ETag: etag });
    const rs = fs.createReadStream(cacheFile);
    rs.on('error', () => { try { res.destroy(); } catch { /* */ } }); // 读缓存中途出错别让未捕获 error 打挂进程
    rs.pipe(res);
  };
  if (fs.existsSync(cacheFile)) return sendCache();
  let pr = thumbInflight.get(cacheFile);
  if (!pr) { pr = generateThumb(src, e, s, cacheFile, isImg).finally(() => thumbInflight.delete(cacheFile)); thumbInflight.set(cacheFile, pr); }
  try { await pr; sendCache(); pruneThumbsSoon(); }
  catch { res.writeHead(415); res.end('no thumb'); } // 前端 onerror 回退矢量图标
}

// HEIC/HEIF 浏览器与 Chromium 原生不支持：用 sips 全尺寸转码成 jpeg 缓存后再吐，
// /api/raw 和 /fs/ 都透明走这条，markdown 里的 ![](x.heic) 预览即可显示。复用缩略图那套 run/缓存/LRU。
const HEIC_EXT = new Set(['heic', 'heif']);
async function serveHeicAsJpeg(req, res, file, st) {
  const key = crypto.createHash('md5').update(file + ':' + st.mtimeMs).digest('hex');
  const cacheFile = path.join(THUMB_DIR, key + '.heic.jpg');
  const send = () => {
    res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'max-age=604800' });
    const rs = fs.createReadStream(cacheFile);
    rs.on('error', () => { try { res.destroy(); } catch { /* */ } });
    rs.pipe(res);
  };
  if (fs.existsSync(cacheFile)) return send();
  let pr = thumbInflight.get(cacheFile);
  if (!pr) {
    pr = (async () => { await fsp.mkdir(THUMB_DIR, { recursive: true }); await run('sips', ['-s', 'format', 'jpeg', file, '--out', cacheFile]); })()
      .finally(() => thumbInflight.delete(cacheFile));
    thumbInflight.set(cacheFile, pr);
  }
  try { await pr; pruneThumbsSoon(); send(); }
  catch { res.writeHead(415); res.end('heic transcode failed'); } // 前端 onerror 回退矢量图标
}

// 流式返回原始文件（图片 / 视频 / pdf / 音频预览），支持 Range
function serveRaw(req, res, filePath) {
  let file;
  try { file = resolvePath(filePath); } catch { res.writeHead(400); res.end('bad path'); return; }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); res.end('not found'); return; }
    if (HEIC_EXT.has(ext(file))) return serveHeicAsJpeg(req, res, file, st); // HEIC → 转码 jpeg，绕过下面的原始字节路径
    const type = MIME[ext(file)] || 'application/octet-stream';
    const onStreamErr = (rs) => rs.on('error', () => { try { res.destroy(); } catch { /* */ } });
    const range = req.headers.range;
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      // 钳制到文件实际范围：畸形 Range（如 bytes=99999999-）否则会让 createReadStream 抛未捕获 error 崩进程
      let startB = m && m[1] ? parseInt(m[1], 10) : 0;
      let endB = m && m[2] ? parseInt(m[2], 10) : st.size - 1;
      if (!Number.isFinite(startB) || startB < 0) startB = 0;
      if (!Number.isFinite(endB) || endB > st.size - 1) endB = st.size - 1;
      if (startB > endB) {
        res.writeHead(416, { 'Content-Range': `bytes */${st.size}` });
        res.end();
        return;
      }
      res.writeHead(206, {
        'Content-Type': type,
        'Content-Range': `bytes ${startB}-${endB}/${st.size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': endB - startB + 1,
      });
      const rs = fs.createReadStream(file, { start: startB, end: endB });
      onStreamErr(rs); rs.pipe(res);
    } else {
      res.writeHead(200, { 'Content-Type': type, 'Content-Length': st.size, 'Accept-Ranges': 'bytes' });
      const rs = fs.createReadStream(file);
      onStreamErr(rs); rs.pipe(res);
    }
  });
}

// 为 /fs/ 下 HTML 预览注入辅助标签：
// 1. 测宽脚本——桌面 Chromium 的 iframe 会忽略 viewport meta，定宽桌面页照样按自身宽度铺开，
//    窄预览框只能露出左上角；脚本把页面自然宽度 postMessage 给前端，由前端整页等比缩放适配。
// 2. 兜底样式——html/body 可滚动、图片视频不超宽（canvas/svg 不动，挤压它们会让动效 demo 变形）。
// 3. viewport meta——桌面 iframe 用不上，但保留它，手机经局域网访问预览时有用。
async function serveHtmlPreview(req, res, filePath) {
  let file;
  try { file = resolvePath(filePath); } catch { res.writeHead(400); res.end('bad path'); return; }
  try {
    const st = await fsp.stat(file);
    if (!st.isFile()) { res.writeHead(404); res.end('not found'); return; }
  } catch { res.writeHead(404); res.end('not found'); return; }
  try {
    let html = await fsp.readFile(file, 'utf8');
    const viewportRe = /<meta[^>]*name=["']viewport["'][^>]*>/i;
    const styleBlock = `<style data-fanbox-preview>
  html, body { overflow: auto; }
  img, video { max-width: 100%; height: auto; }
</style>`;
    const measureScript = '<script data-fanbox-measure>(function(){var l=0;function r(){var w=Math.max(document.documentElement.scrollWidth,document.body?document.body.scrollWidth:0);if(w&&w!==l){l=w;try{parent.postMessage({fanboxPreviewWidth:w},"*")}catch(e){}}}addEventListener("load",function(){r();setTimeout(r,300)});addEventListener("resize",r)})()</script>';
    // 本地图片引用兜底：不同 agent 写 html 引图方式各异，http 预览（沙箱 iframe）里有两类必裂——
    //   ① file:// 绝对 URL（http 页面禁加载 file://）；② /Users 这种裸绝对路径（解析到源站根）。
    // 策略分两层，确保「修问题不引入新问题」：
    //   · 主动改写：只碰 file://（http 预览里永远加载不了，改成 /fs 镜像只会帮忙、不会误伤任何能用的引用）；
    //   · 失败兜底：其余绝对路径只在「已加载失败」时才重写到 /fs 再试一次（对本来能加载的引用零影响 → 结构性零回归）。
    //   · 相对路径走 /fs/<目录>/ 本就正常，失败多半是文件真没了，不强行兜底。
    // 未覆盖（注释在此说清，别让后人误以为全兜住）：<style> 块/外部 css 里的 file:// 背景图、srcset、加载后 JS 动态插入的元素。
    const localImgScript = '<script data-fanbox-localimg>(function(){var FS="/fs";function f2fs(u){return (u&&u.slice(0,7)==="file://")?FS+u.slice(7):null;}function fix(el){if(!el.getAttribute)return;["src","href","poster"].forEach(function(a){var v=el.getAttribute(a),n=f2fs(v);if(n)el.setAttribute(a,n);});var st=el.getAttribute("style");if(st&&st.indexOf("file://")>-1)el.setAttribute("style",st.split("file://").join(FS));}function sweep(){document.querySelectorAll("[src],[href],[poster],[style]").forEach(fix);}sweep();document.addEventListener("DOMContentLoaded",sweep);document.addEventListener("error",function(e){var el=e.target;if(!el||!el.getAttribute||el.getAttribute("data-fs-tried"))return;var attr=el.tagName==="LINK"?"href":"src",v=el.getAttribute(attr);if(!v||v.charAt(0)!=="/"||v.slice(0,4)==="/fs/")return;if(/^(https?:|data:|blob:)/.test(v))return;el.setAttribute("data-fs-tried","1");el.setAttribute(attr,FS+v);},true);})()</script>';
    function injectHead(tag) {
      const headClose = html.match(/<\/head>/i);
      const headOpen = html.match(/<head[^>]*>/i);
      if (headClose) {
        html = html.slice(0, headClose.index) + '  ' + tag + '\n' + html.slice(headClose.index);
      } else if (headOpen) {
        html = html.slice(0, headOpen.index + headOpen[0].length) + '\n  ' + tag + '\n' + html.slice(headOpen.index + headOpen[0].length);
      } else {
        // 没有 <head> 时，把标签插到 <!DOCTYPE ...> 之后，或文档最开头
        const doctype = html.match(/<!DOCTYPE[^>]*>/i);
        if (doctype) {
          html = html.slice(0, doctype.index + doctype[0].length) + '\n' + tag + html.slice(doctype.index + doctype[0].length);
        } else {
          html = tag + '\n' + html;
        }
      }
    }
    if (!viewportRe.test(html)) {
      injectHead('<meta name="viewport" content="width=device-width, initial-scale=1">');
    }
    if (!html.includes('data-fanbox-preview')) {
      injectHead(styleBlock);
    }
    if (!html.includes('data-fanbox-measure')) {
      injectHead(measureScript);
    }
    if (!html.includes('data-fanbox-localimg')) {
      injectHead(localImgScript);
    }
    const buf = Buffer.from(html, 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': buf.length });
    res.end(buf);
  } catch (err) {
    // 读取/编码异常时回退到原始流，保证至少能打开
    console.error('serveHtmlPreview fallback', err);
    return serveRaw(req, res, filePath);
  }
}

const MAX_BODY = 64 * 1024 * 1024; // 64MB 上限，防止恶意请求无限累加把内存撑爆
function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    let size = 0;
    let aborted = false;
    req.on('data', (c) => {
      if (aborted) return;
      size += c.length;
      if (size > MAX_BODY) { aborted = true; try { req.destroy(); } catch { /* */ } resolve({}); return; }
      data += c;
    });
    req.on('end', () => { if (!aborted) { try { resolve(JSON.parse(data || '{}')); } catch { resolve({}); } } });
    req.on('error', () => { if (!aborted) { aborted = true; resolve({}); } });
  });
}

// ---------- Agent 用量（Claude Code / Codex）----------
// 不依赖两个 CLI 在跑：直接读它们落在本机的会话日志。
// Claude Code：~/.claude/projects/**/*.jsonl 里每条 assistant 消息带 usage（token 明细）→ 增量解析聚合
// Codex：~/.codex/sessions/**/rollout-*.jsonl 的 token_count 事件带 rate_limits（5h 窗口/周配额百分比，官方数）→ tail 取最新快照
const CLAUDE_PROJ = path.join(HOME, '.claude', 'projects');
const CODEX_SESS = path.join(HOME, '.codex', 'sessions');
const claudeFileCache = new Map(); // file -> { offset, lastMsgId, events: [{t, in, out, cc, cr}] }
let usageResultCache = { at: 0, data: null };

async function parseClaudeFile(file, stat) {
  let c = claudeFileCache.get(file);
  if (!c) { c = { offset: 0, lastMsgId: '', events: [] }; claudeFileCache.set(file, c); }
  if (stat.size < c.offset) { c.offset = 0; c.lastMsgId = ''; c.events = []; } // 文件被截断重写：重来
  if (stat.size === c.offset) return c.events;
  const fh = await fsp.open(file, 'r');
  let chunk;
  try {
    const len = stat.size - c.offset;
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, c.offset);
    chunk = buf.toString('utf8');
  } finally { await fh.close(); }
  // 末尾可能是写到一半的行：留给下一轮，offset 只推进到最后一个完整换行
  const lastNL = chunk.lastIndexOf('\n');
  if (lastNL === -1) return c.events;
  c.offset += Buffer.byteLength(chunk.slice(0, lastNL + 1), 'utf8');
  for (const line of chunk.slice(0, lastNL).split('\n')) {
    if (!line.includes('"usage"') || !line.includes('"assistant"')) continue;
    let d; try { d = JSON.parse(line); } catch { continue; }
    const m = d && d.message;
    const u = m && m.usage;
    if (!u || d.type !== 'assistant') continue;
    if (m.model === '<synthetic>') continue;
    if (m.id && m.id === c.lastMsgId) continue; // 同一条消息分多行落盘，usage 重复：只记第一次
    if (m.id) c.lastMsgId = m.id;
    const t = Date.parse(d.timestamp || '') || stat.mtimeMs;
    c.events.push({ t, in: u.input_tokens || 0, out: u.output_tokens || 0, cc: u.cache_creation_input_tokens || 0, cr: u.cache_read_input_tokens || 0 });
  }
  return c.events;
}

async function claudeUsage() {
  const cutoff = Date.now() - 8 * 86400000;
  const files = [];
  let dirs;
  try { dirs = await fsp.readdir(CLAUDE_PROJ); } catch { return null; } // 没装/没用过 Claude Code
  await Promise.all(dirs.map(async (d) => {
    let names;
    try { names = await fsp.readdir(path.join(CLAUDE_PROJ, d)); } catch { return; }
    await Promise.all(names.filter((n) => n.endsWith('.jsonl')).map(async (n) => {
      const fp = path.join(CLAUDE_PROJ, d, n);
      try { const st = await fsp.stat(fp); if (st.mtimeMs >= cutoff) files.push({ fp, st }); } catch { /* */ }
    }));
  }));
  const live = new Set(files.map((f) => f.fp));
  for (const k of claudeFileCache.keys()) { if (!live.has(k)) claudeFileCache.delete(k); } // 过期文件出缓存
  const all = [];
  for (const { fp, st } of files) { try { all.push(...await parseClaudeFile(fp, st)); } catch { /* 单文件坏不挡整体 */ } }
  const now = Date.now();
  const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
  const mk = () => ({ total: 0, input: 0, output: 0, cacheRead: 0, cacheCreate: 0, msgs: 0 });
  const last5h = mk(), today = mk(), week = mk();
  for (const e of all) {
    const tot = e.in + e.out + e.cc + e.cr;
    for (const [b, from] of [[last5h, now - 5 * 3600000], [today, dayStart.getTime()], [week, now - 7 * 86400000]]) {
      if (e.t >= from) { b.total += tot; b.input += e.in; b.output += e.out; b.cacheRead += e.cr; b.cacheCreate += e.cc; b.msgs++; }
    }
  }
  return { last5h, today, week };
}

// 从最近改动的 rollout 文件尾部抓最后一条带 rate_limits 的 token_count（官方配额快照）
async function codexUsage() {
  const files = [];
  const walk = async (dir, depth) => {
    let names;
    try { names = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const n of names) {
      const fp = path.join(dir, n.name);
      if (n.isDirectory() && depth < 3) await walk(fp, depth + 1);
      else if (n.isFile() && n.name.endsWith('.jsonl')) {
        try { const st = await fsp.stat(fp); files.push({ fp, mtimeMs: st.mtimeMs, size: st.size }); } catch { /* */ }
      }
    }
  };
  await walk(CODEX_SESS, 0);
  if (!files.length) return null;
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const f of files.slice(0, 10)) { // 最新几个会话里找；都没有就放弃
    try {
      const fh = await fsp.open(f.fp, 'r');
      let txt;
      try {
        const len = Math.min(f.size, 262144);
        const buf = Buffer.alloc(len);
        await fh.read(buf, 0, len, f.size - len);
        txt = buf.toString('utf8');
      } finally { await fh.close(); }
      const lines = txt.split('\n').reverse();
      for (const line of lines) {
        if (!line.includes('"rate_limits"')) continue;
        let d; try { d = JSON.parse(line); } catch { continue; }
        const pl = d && d.payload;
        const rl = pl && pl.rate_limits;
        if (!rl || (!rl.primary && !rl.secondary)) continue;
        const capturedAt = Date.parse(d.timestamp || '') || f.mtimeMs;
        // 快照是「当时」的数：窗口在快照之后重置过的话，旧百分比就完全失真（比如 21 小时前
        // 的 5h 窗口 57%），归零并标 stale——没有新会话日志就说明重置后根本没用过
        const win = (w) => {
          if (!w) return null;
          let resetsAt = w.resets_at || 0;
          if (typeof resetsAt === 'string') resetsAt = Math.floor(Date.parse(resetsAt) / 1000) || 0;
          let end = resetsAt * 1000;
          if (!end && w.resets_in_seconds != null) end = capturedAt + w.resets_in_seconds * 1000;
          if (!end && w.window_minutes) end = capturedAt + w.window_minutes * 60000;
          const stale = !!end && end < Date.now();
          return { usedPercent: stale ? 0 : w.used_percent, windowMinutes: w.window_minutes, resetsAt: stale ? 0 : resetsAt, stale };
        };
        return { planType: rl.plan_type || '', capturedAt, primary: win(rl.primary), secondary: win(rl.secondary) };
      }
    } catch { /* 下一个文件 */ }
  }
  return null;
}

// Claude Code 官方限额窗口（和它 /usage 面板同源）：5h 滚动窗口 + 周配额的百分比和重置时间。
// 本地 jsonl 只有 token 流水、推不出官方百分比，必须拿 Claude Code 自己的 OAuth token
// （macOS 在 Keychain，其他平台落在 ~/.claude/.credentials.json）查官方 usage 接口。
// 这是本服务唯一的出网请求，只发往 api.anthropic.com——Claude Code 平时也在发同一个请求。
async function claudeOAuthToken() {
  const pick = (raw) => {
    const o = JSON.parse(raw).claudeAiOauth;
    return o && o.accessToken && (!o.expiresAt || o.expiresAt > Date.now()) ? o.accessToken : null;
  };
  if (PLATFORM === 'darwin') {
    try {
      const out = await new Promise((resolve, reject) => {
        execFile('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
          { timeout: 3000 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
      });
      const t = pick(out);
      if (t) return t;
    } catch { /* 落到凭证文件 */ }
  }
  try { return pick(await fsp.readFile(path.join(HOME, '.claude', '.credentials.json'), 'utf8')); }
  catch { return null; }
}

// 终端启动时 curl 自己会认 http_proxy 等环境变量；但打包 App 从 Finder/Dock 启动没有这些变量，
// curl 直连 api.anthropic.com 会被 403 地域拦截。此时读 macOS 系统代理（Clash 等都会写进去）兜底。
async function curlSysProxyLine() {
  if (['https_proxy', 'HTTPS_PROXY', 'http_proxy', 'HTTP_PROXY', 'all_proxy', 'ALL_PROXY'].some((k) => process.env[k])) return '';
  if (PLATFORM !== 'darwin') return '';
  try {
    const out = await new Promise((resolve, reject) => {
      execFile('scutil', ['--proxy'], { timeout: 3000 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
    });
    const grab = (k) => (out.match(new RegExp(`\\b${k} : (\\S+)`)) || [])[1];
    if (grab('HTTPSEnable') === '1') return `proxy = "http://${grab('HTTPSProxy')}:${grab('HTTPSPort')}"\n`;
    if (grab('HTTPEnable') === '1') return `proxy = "http://${grab('HTTPProxy')}:${grab('HTTPPort')}"\n`;
    if (grab('SOCKSEnable') === '1') return `proxy = "socks5h://${grab('SOCKSProxy')}:${grab('SOCKSPort')}"\n`;
  } catch { /* 读不到就直连 */ }
  return '';
}

async function claudeOfficialLimits() {
  const token = await claudeOAuthToken();
  if (!token) return null;
  // 不用 Node https：该接口的防护按 TLS 指纹拦——同样的请求头 curl 能 200、Node 直接 403。
  // 走系统 curl（macOS/Win10+ 自带），顺带继承用户的代理环境变量；
  // token 经 stdin 的 curl 配置传入，不暴露在进程列表里
  const proxyLine = await curlSysProxyLine();
  const body = await new Promise((resolve, reject) => {
    const cp = execFile('curl', ['-sS', '--max-time', '8', '-K', '-', 'https://api.anthropic.com/api/oauth/usage'],
      { timeout: 10000 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
    cp.stdin.end(`${proxyLine}header = "Authorization: Bearer ${token}"\nheader = "anthropic-beta: oauth-2025-04-20"\n`);
  });
  const d = JSON.parse(body);
  const win = (w) => (w && w.utilization != null)
    ? { usedPercent: w.utilization, resetsAt: w.resets_at ? Math.floor(Date.parse(w.resets_at) / 1000) : 0 }
    : null;
  const fiveHour = win(d.five_hour), sevenDay = win(d.seven_day);
  return (fiveHour || sevenDay) ? { fiveHour, sevenDay } : null;
}

// ---------- Agent 项目（最近被 coding agent 处理过的项目文件夹）----------
// Claude Code：~/.claude/projects/<munge过的路径>/*.jsonl，目录名不可逆，但行里带 "cwd":"真实路径"
// （二开：Codex 项目不收，侧栏只服务 Claude 会话）
let agentProjCache = { at: 0, data: null };

async function readCwdFromHead(file, bytes) {
  const fh = await fsp.open(file, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await fh.read(buf, 0, bytes, 0);
    const m = buf.toString('utf8', 0, bytesRead).match(/"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    return m ? JSON.parse('"' + m[1] + '"') : null;
  } finally { await fh.close(); }
}

// ==== 二开: cockpit —— 目录名反解 cwd 兜底 ====
// claude 的 munge 是 cwd.replace(/[^A-Za-z0-9]/g, '-')，目录名里 '/' 和 '-' 都被压成 '-'，
// 反解不唯一（~/work/Claude/work 与 ~/work/Claude-work 同名）。靠 stat 验证存在性筛掉错候选。
// 策略：从根开始逐段贪心——每个路径段从最短试到最长（段名本身可能含 '-'），找到存在的就认，继续拼下一段。
// 取不到下一段就回溯换更长的当前段。这条路径最可能是 claude 写入时的真实 cwd。
async function cwdFromDirName(dirName) {
  if (!dirName || dirName === '-') return null;
  const toks = dirName.split('-'); // 含空串（首尾的 - 产生），下面用索引游走
  // 回溯搜索：pos=已消费到第几个 token，path=已拼出的真实路径
  const trySolve = async (pos, path) => {
    if (pos >= toks.length) return path; // 全消费完
    // 跳过空 token（首尾的 -）
    if (toks[pos] === '') return trySolve(pos + 1, path);
    // 从最长候选段开始试（贪心长段优先：路径段越完整越可能是真的）
    for (let end = toks.length; end > pos; end--) {
      const seg = toks.slice(pos, end).join('-');
      if (!seg) continue;
      const cand = path + '/' + seg;
      try { if (!(await fsp.stat(cand)).isDirectory()) continue; } catch { continue; }
      const r = await trySolve(end, cand);
      if (r) return r;
    }
    return null;
  };
  return trySolve(0, '');
}

// ==== 二开: cockpit —— 会话文件 → 真实 cwd ====
// claude 的目录名把每个非字母数字字符（含每个汉字）压成 '-'：BAA定位 与 BAA记忆 落在同一目录。
// 目录名不是项目的身份证，文件头里的 cwd 才是；一个文件的 cwd 终身不变，读到就缓存（读不到不缓存）。
const sessionCwdCache = new Map(); // fp -> cwd
async function sessionFileCwd(fp) {
  let cwd = sessionCwdCache.get(fp);
  if (cwd) return cwd;
  try { cwd = await readCwdFromHead(fp, 65536); } catch { cwd = null; }
  if (cwd) sessionCwdCache.set(fp, cwd);
  return cwd;
}

// ==== 二开: cockpit —— 项目目录有效性护栏 ====
// 家目录裸跑与系统临时目录（自动化评测/无头网关落点）不算真实项目，避免白占 20 个名额
function isValidProjectCwd(cwd) {
  if (!cwd || cwd === HOME) return false;
  if (/^\/(private\/)?(tmp|var\/folders)(\/|$)/.test(cwd)) return false;
  return true;
}

async function agentProjects(force = false) {
  if (!force && agentProjCache.data && Date.now() - agentProjCache.at < 60000) return agentProjCache.data;
  const cutoff = Date.now() - 30 * 86400000;
  const map = new Map(); // cwd -> { lastActive, agents: Set }
  const add = (cwd, t, agent) => {
    if (!isValidProjectCwd(cwd)) return;
    const cur = map.get(cwd) || { lastActive: 0, agents: new Set() };
    cur.lastActive = Math.max(cur.lastActive, t);
    cur.agents.add(agent);
    map.set(cwd, cur);
  };
  // ==== 二开: cockpit ==== 收驾驶舱三引擎项目（Claude Code + Antigravity + Devin），Codex 项目不进侧栏；
  // Claude 会话逐文件按头部 cwd 归属（防汉字名目录撞车），Antigravity / Devin 从各自索引库归属
  await Promise.all([
    (async () => {
      try {
        const dirs = await fsp.readdir(CLAUDE_PROJ);
        await Promise.all(dirs.map(async (d) => {
          const base = path.join(CLAUDE_PROJ, d);
          let names; try { names = await fsp.readdir(base); } catch { return; }
          // 文件头读不到 cwd（前 64KB 没 cwd 行）时从目录名反解兜底，每目录最多算一次，
          // 避免 work 这种「头部全是 thinking/tool_use」的项目整条丢失
          let guess;
          await Promise.all(names.filter((n) => n.endsWith('.jsonl')).map(async (n) => {
            try {
              const fp = path.join(base, n);
              const { mtimeMs } = await fsp.stat(fp);
              if (mtimeMs < cutoff) return;
              add((await sessionFileCwd(fp)) || (await (guess = guess || cwdFromDirName(d))), mtimeMs, 'claude');
            } catch { /* */ }
          }));
        }));
      } catch { /* 没用过 Claude Code */ }
    })(),
    (async () => {
      const agyRows = await listAgySummaries();
      for (const r of agyRows) {
        if (r.lastT >= cutoff) add(r.cwd, r.lastT, 'agy');
      }
    })(),
    (async () => {
      const devinRows = await listDevinSessions();
      for (const r of devinRows) {
        if (r.lastT >= cutoff) add(r.cwd, r.lastT, 'devin');
      }
    })(),
  ]);
  // 按最近活跃排序，已被删除的项目目录剔掉
  const sorted = [...map.entries()].sort((a, b) => b[1].lastActive - a[1].lastActive);
  const projects = [];
  for (const [cwd, info] of sorted) {
    if (projects.length >= 20) break;
    try { if (!(await fsp.stat(cwd)).isDirectory()) continue; } catch { continue; }
    projects.push({ path: cwd, name: path.basename(cwd), agents: [...info.agents], lastActive: info.lastActive });
  }
  const data = { ok: true, projects };
  agentProjCache = { at: Date.now(), data };
  return data;
}

// ==== 二开: cockpit —— 项目 → Claude + Antigravity + Devin 混合 session 列表（侧栏驾驶舱数据源）====
// 同一目录树下合并三家会话，按最后活跃降序混排，靠 agent 字段标识引擎。自定义名与命令模板存 config.json。
const SESS_RESUME_DEFAULT = 'claudex -r {id}';
const SESS_NEW_DEFAULT = 'claudex';
const SESS_AGY_RESUME_DEFAULT = 'agy --conversation {id}';
const SESS_AGY_NEW_DEFAULT = 'agy';
const SESS_DEVIN_RESUME_DEFAULT = 'devin -r {id}';
const SESS_DEVIN_NEW_DEFAULT = 'devin';

async function readDefaultAgentModels() {
  let claudeDef = '', agyDef = '', devinDef = '';
  await Promise.all([
    fsp.readFile(path.join(HOME, '.claude', 'settings.json'), 'utf8').then((txt) => {
      const j = JSON.parse(txt);
      claudeDef = String((j && j.env && j.env.ANTHROPIC_MODEL) || (j && j.model) || '').trim();
    }).catch(() => {}),
    fsp.readFile(path.join(AGY_HOME, 'settings.json'), 'utf8').then((txt) => {
      const j = JSON.parse(txt);
      agyDef = String((j && j.model) || '').trim();
    }).catch(() => {}),
    fsp.readFile(DEVIN_CFG_FILE, 'utf8').then((txt) => {
      const j = JSON.parse(txt);
      devinDef = String((j && j.agent && j.agent.model) || (j && j.model) || '').trim();
    }).catch(() => {}),
  ]);
  return { claudeDef, agyDef, devinDef };
}

async function agentSessions() {
  const [projData, cfg, liveIds, agyLiveMap, agyRows, devinLiveMap, devinRows, defModels] = await Promise.all([
    agentProjects(), readConfig(), liveClaudeSessionIds(), liveAgySessions(), listAgySummaries(), liveDevinSessions(), listDevinSessions(), readDefaultAgentModels(),
  ]);
  // 若会话所用模型与本机当前默认模型一致（含代理网关对 deepseek-v4 默认模型的无后缀别名），resumeModel 置空 → 走原旧方式裸跑续接命令
  const normBase = (x) => String(x || '').replace(/\[[^\]]*\]$/, '');
  const isSameModel = (a, b) => {
    if (!a || !b) return false;
    const na = normBase(a), nb = normBase(b);
    if (a === b || na === nb) return true;
    if (na === 'deepseek-v4-flash' && nb.startsWith('deepseek-v4')) return true;
    return false;
  };
  const names = cfg.sessionNames || {};
  const activeWindowMs = Number(cfg.sessionActiveWindowMs) || 60000;
  const now = Date.now();
  const agyByCwd = new Map();
  for (const r of agyRows) {
    let arr = agyByCwd.get(r.cwd);
    if (!arr) { arr = []; agyByCwd.set(r.cwd, arr); }
    arr.push(r);
  }
  const devinByCwd = new Map();
  for (const r of devinRows) {
    let arr = devinByCwd.get(r.cwd);
    if (!arr) { arr = []; devinByCwd.set(r.cwd, arr); }
    arr.push(r);
  }
  const projects = [];
  await Promise.all((projData.projects || []).map(async (pj) => {
    const sessions = [];
    // ① Claude Code 会话
    const dir = path.join(CLAUDE_PROJ, mungeClaudeDir(pj.path));
    let entries = [];
    try { entries = await fsp.readdir(dir); } catch { entries = []; } // 纯 Antigravity / Devin 项目无 Claude 目录，继续合并
    if (entries.length) {
      const files = [];
      await Promise.all(entries.filter((n) => n.endsWith('.jsonl')).map(async (n) => {
        try {
          const fp = path.join(dir, n);
          // 同目录混着别的项目的会话（汉字名撞车）：cwd 明确不是本项目就不收；读不到 cwd 的保持旧行为
          const cwd = await sessionFileCwd(fp);
          if (cwd && cwd !== pj.path) return;
          files.push({ fp, st: await fsp.stat(fp) });
        } catch { /* */ }
      }));
      files.sort((a, b) => b.st.mtimeMs - a.st.mtimeMs);
      for (const f of files.slice(0, 50)) {
        try {
          const s = await parseClaudeSession(f.fp, f.st);
          // 空会话（无人打过字、也没标题）多半是探测/崩溃残留，列出来只添乱
          if (!s.title && !s.userMsgs) continue;
          // 状态只属于「被某个软件打开着」的会话（注册表 + 进程探活）；闭合会话无状态
          const open = liveIds.has(s.id);
          const resumeModel = s.model && !isSameModel(s.model, defModels.claudeDef) ? s.model : '';
          sessions.push({ id: s.id, agent: 'claude', title: s.title, name: names[s.id] || '', model: s.model || '', resumeModel, lastT: s.lastT, userMsgs: s.userMsgs, open, status: open ? decideSessionStatus(s, activeWindowMs, now) : null });
        } catch { /* 单文件解析失败不拖累整个项目 */ }
      }
    }
    // ② Antigravity 会话
    const agyList = (agyByCwd.get(pj.path) || []).slice(0, 50);
    await Promise.all(agyList.map(async (r) => {
      try {
        const open = agyLiveMap.has(r.id);
        const meta = await agyConvMeta(r.id);
        const status = open ? await decideAgySessionStatus(r, meta.stepStatus, activeWindowMs, now) : null;
        const resumeModel = meta.model && !isSameModel(meta.model, defModels.agyDef) ? meta.model : '';
        sessions.push({
          id: r.id, agent: 'agy', title: r.title, name: names[r.id] || '', model: meta.model || '', resumeModel,
          lastT: r.lastT, userMsgs: Math.max(1, Math.floor(r.stepCount / 2)),
          open, status,
        });
      } catch { /* */ }
    }));
    // ③ Devin CLI 会话
    const devinList = (devinByCwd.get(pj.path) || []).slice(0, 50);
    for (const r of devinList) {
      const open = devinLiveMap.has(r.id);
      const status = open ? decideDevinSessionStatus(r, activeWindowMs, now) : null;
      const resumeModel = r.model && !isSameModel(r.model, defModels.devinDef) ? r.model : '';
      sessions.push({
        id: r.id, agent: 'devin', title: r.title, name: names[r.id] || '', model: r.model || '', resumeModel,
        lastT: r.lastT, userMsgs: r.userMsgs,
        open, status,
      });
    }
    if (!sessions.length) return;
    sessions.sort((a, b) => b.lastT - a.lastT);
    const trimmed = sessions.slice(0, 50);
    projects.push({ path: pj.path, name: pj.name, lastActive: Math.max(pj.lastActive, trimmed[0].lastT || 0), sessions: trimmed });
  }));
  projects.sort((a, b) => b.lastActive - a.lastActive);
  return {
    ok: true,
    resumeCmd: cfg.sessionResumeCmd || SESS_RESUME_DEFAULT,
    newCmd: cfg.sessionNewCmd || SESS_NEW_DEFAULT,
    agyResumeCmd: cfg.agyResumeCmd || SESS_AGY_RESUME_DEFAULT,
    agyNewCmd: cfg.agyNewCmd || SESS_AGY_NEW_DEFAULT,
    devinResumeCmd: cfg.devinResumeCmd || SESS_DEVIN_RESUME_DEFAULT,
    devinNewCmd: cfg.devinNewCmd || SESS_DEVIN_NEW_DEFAULT,
    activeWindowMs,
    projects,
  };
}

// ---------- Skills 透视（本机 agent skills 的扫描 / 触发统计 / 健康检查 / 启停）----------
// 扫描五类来源：~/.claude/skills、最近 agent 项目的 .claude/skills、Claude 插件、
// ~/.codex/skills、~/.agents/skills。触发统计读两家的会话日志。
// 启停不走 skillOverrides（官方 #50631：用户级配置当前不生效）——用「移入 _disabled/ 子目录」
// 实现：两家 CLI 都只扫一层目录，移进去立即对模型不可见，移回来即恢复，可靠且可逆。
const CLAUDE_SKILLS = path.join(HOME, '.claude', 'skills');
const CODEX_SKILLS = path.join(HOME, '.codex', 'skills');
const AGENTS_SKILLS = path.join(HOME, '.agents', 'skills');
const SKILL_DESC_CUT = 1536; // Claude Code 单条 description 的截断线（官方文档）
const SKILL_BUDGET_CHARS = 15000; // 描述总预算的社区实测估算值（窗口的 1%），仅作预警参考
let skillsCache = { at: 0, data: null };

function skillFrontmatter(txt) {
  const m = txt.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return null;
  const fm = m[1];
  // 不用 m 标志：$ 必须是整段 frontmatter 的末尾，否则块标量（description: >- 换行缩进正文）会被截成空
  const dm = fm.match(/(?:^|\r?\n)description\s*:\s*([\s\S]*?)(?=\r?\n[\w-]+\s*:|\s*$)/);
  let desc = dm ? dm[1].trim() : '';
  desc = desc.replace(/^[|>][+-]?\s*/, '').replace(/^(['"])([\s\S]*)\1$/, '$2').trim();
  return { desc };
}

async function scanSkillRoot(root, source, label, out, disabled = false) {
  let names;
  try { names = await fsp.readdir(root, { withFileTypes: true }); } catch { return; }
  for (const n of names) {
    if (n.name.startsWith('.') || n.name === '_archive' || n.name === '_backups') continue;
    const fp = path.join(root, n.name);
    if (n.name === '_disabled') {
      if (n.isDirectory() && !disabled) await scanSkillRoot(fp, source, label, out, true);
      continue;
    }
    let isDir = n.isDirectory();
    if (!isDir && n.isSymbolicLink()) { // skills.sh 等安装器常用软链，跟随解析
      try { isDir = (await fsp.stat(fp)).isDirectory(); } catch { continue; }
    }
    if (!isDir) {
      if (/\.md$/i.test(n.name)) continue; // 根目录的说明文档不算残留
      out.push({ name: n.name, dir: fp, source, label, disabled, residue: true, desc: '', descLen: 0, mtime: 0,
        issues: ['残留文件——不是有效 skill，只占目录'] });
      continue;
    }
    const item = { name: n.name, dir: fp, source, label, disabled, residue: false, desc: '', descLen: 0, mtime: 0, issues: [] };
    try {
      const sm = path.join(fp, 'SKILL.md');
      const st = await fsp.stat(sm);
      item.mtime = st.mtimeMs;
      const fh = await fsp.open(sm, 'r');
      let head;
      try {
        const buf = Buffer.alloc(Math.min(st.size, 32768));
        const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
        head = buf.toString('utf8', 0, bytesRead);
      } finally { await fh.close(); }
      const fm = skillFrontmatter(head);
      if (!fm || !fm.desc) {
        item.issues.push('SKILL.md 缺 frontmatter description——模型的技能清单里看不到它，只能手动调用');
      } else {
        item.desc = fm.desc.slice(0, 240);
        item.descLen = fm.desc.length;
        if (fm.desc.length > SKILL_DESC_CUT) {
          item.issues.push(`description ${fm.desc.length.toLocaleString()} 字符，超过 ${SKILL_DESC_CUT} 截断线——第 ${SKILL_DESC_CUT} 字符之后的触发词模型看不见`);
        }
      }
    } catch {
      item.residue = true;
      item.issues.push('缺 SKILL.md——不是有效 skill');
    }
    out.push(item);
  }
}

// Claude Code 触发统计：jsonl 里的 Skill tool_use（模型自动触发）+ <command-name>（用户手动 /调用）
const claudeSkillStatCache = new Map(); // file -> { offset, events: [{t, skill}] }
async function claudeSkillEvents(cutoff) {
  const files = [];
  let dirs;
  try { dirs = await fsp.readdir(CLAUDE_PROJ); } catch { return []; }
  await Promise.all(dirs.map(async (d) => {
    let names;
    try { names = await fsp.readdir(path.join(CLAUDE_PROJ, d)); } catch { return; }
    await Promise.all(names.filter((n) => n.endsWith('.jsonl')).map(async (n) => {
      const fp = path.join(CLAUDE_PROJ, d, n);
      try { const st = await fsp.stat(fp); if (st.mtimeMs >= cutoff) files.push({ fp, st }); } catch { /* */ }
    }));
  }));
  const live = new Set(files.map((f) => f.fp));
  for (const k of claudeSkillStatCache.keys()) { if (!live.has(k)) claudeSkillStatCache.delete(k); }
  const all = [];
  for (const { fp, st } of files) {
    let c = claudeSkillStatCache.get(fp);
    if (!c) { c = { offset: 0, events: [] }; claudeSkillStatCache.set(fp, c); }
    if (st.size < c.offset) { c.offset = 0; c.events = []; }
    if (st.size > c.offset) {
      try {
        const fh = await fsp.open(fp, 'r');
        let chunk;
        try {
          const buf = Buffer.alloc(st.size - c.offset);
          await fh.read(buf, 0, buf.length, c.offset);
          chunk = buf.toString('utf8');
        } finally { await fh.close(); }
        const lastNL = chunk.lastIndexOf('\n');
        if (lastNL !== -1) {
          c.offset += Buffer.byteLength(chunk.slice(0, lastNL + 1), 'utf8');
          for (const line of chunk.slice(0, lastNL).split('\n')) {
            const isTool = line.includes('"name":"Skill"');
            const isCmd = line.includes('<command-name>');
            if (!isTool && !isCmd) continue;
            const t = Date.parse((line.match(/"timestamp":"([^"]+)"/) || [])[1] || '') || st.mtimeMs;
            if (isTool) {
              let d; try { d = JSON.parse(line); } catch { continue; }
              const content = d && d.message && Array.isArray(d.message.content) ? d.message.content : [];
              for (const it of content) {
                if (it.type === 'tool_use' && it.name === 'Skill' && it.input && it.input.skill) {
                  c.events.push({ t, skill: String(it.input.skill).replace(/^.*:/, '') });
                }
              }
            } else {
              const m = line.match(/<command-name>\s*\/?([\w.:-]+)\s*<\/command-name>/);
              if (m) c.events.push({ t, skill: m[1].replace(/^.*:/, '') });
            }
          }
        }
      } catch { /* 单文件坏不挡整体 */ }
    }
    all.push(...c.events);
  }
  return all.filter((e) => e.t >= cutoff);
}

// Codex 触发统计：rollout 里被激活的 skill 以 "<skill>\n<name>X</name>" 注入——按「会话×skill」去重计数
const codexSkillStatCache = new Map(); // file -> { size, skills: [{t, skill}] }
async function codexSkillEvents(cutoff) {
  const files = [];
  const walk = async (dir, depth) => {
    let names;
    try { names = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const n of names) {
      const fp = path.join(dir, n.name);
      if (n.isDirectory() && depth < 3) await walk(fp, depth + 1);
      else if (n.isFile() && n.name.endsWith('.jsonl')) {
        try { const st = await fsp.stat(fp); if (st.mtimeMs >= cutoff) files.push({ fp, st }); } catch { /* */ }
      }
    }
  };
  await walk(CODEX_SESS, 0);
  const live = new Set(files.map((f) => f.fp));
  for (const k of codexSkillStatCache.keys()) { if (!live.has(k)) codexSkillStatCache.delete(k); }
  const all = [];
  for (const { fp, st } of files) {
    let c = codexSkillStatCache.get(fp);
    if (!c || c.size !== st.size) {
      c = { size: st.size, skills: [] };
      try {
        const txt = await fsp.readFile(fp, 'utf8');
        const seen = new Set();
        const re = /<skill>\\n<name>([\w.:-]+)<\/name>/g;
        let m;
        while ((m = re.exec(txt))) {
          if (seen.has(m[1])) continue;
          seen.add(m[1]);
          c.skills.push({ t: st.mtimeMs, skill: m[1] });
        }
      } catch { /* */ }
      codexSkillStatCache.set(fp, c);
    }
    all.push(...c.skills);
  }
  return all;
}

async function skillsData(opts = {}) {
  const { force = false, extraCwds = [] } = opts;
  if (!force && skillsCache.data && Date.now() - skillsCache.at < 30000) return skillsCache.data;
  const cutoff = Date.now() - 45 * 86400000;
  const items = [];
  await scanSkillRoot(CLAUDE_SKILLS, 'claude', '~/.claude', items);
  await scanSkillRoot(CODEX_SKILLS, 'codex', '~/.codex', items);
  await scanSkillRoot(AGENTS_SKILLS, 'agents', '~/.agents', items);
  // Claude 插件自带的 skills
  try {
    const inst = JSON.parse(await fsp.readFile(path.join(HOME, '.claude', 'plugins', 'installed_plugins.json'), 'utf8'));
    for (const [key, arr] of Object.entries(inst.plugins || {})) {
      for (const p of arr || []) {
        if (p.installPath) await scanSkillRoot(path.join(p.installPath, 'skills'), 'plugin', key.split('@')[0], items);
      }
    }
  } catch { /* 没装插件 */ }
  // 最近 agent 项目的项目级 skills
  const seenCwds = new Set();
  try {
    const pj = await agentProjects(force);
    for (const p of pj.projects || []) {
      seenCwds.add(p.path);
      await scanSkillRoot(path.join(p.path, '.claude', 'skills'), 'project', p.name, items);
    }
  } catch { /* */ }
  // 额外追加扫描当前浏览目录（不在最近20个项目里也能看到）
  for (const cwd of extraCwds) {
    if (!cwd || seenCwds.has(cwd)) continue;
    try {
      if ((await fsp.stat(cwd)).isDirectory()) {
        await scanSkillRoot(path.join(cwd, '.claude', 'skills'), 'project', path.basename(cwd), items);
      }
    } catch { /* */ }
  }

  // 触发统计合并（按 skill 名聚合两端事件）
  const [ce, xe] = await Promise.all([
    claudeSkillEvents(cutoff).catch(() => []),
    codexSkillEvents(cutoff).catch(() => []),
  ]);
  const stats = new Map();
  for (const e of [...ce, ...xe]) {
    const s = stats.get(e.skill) || { hits: 0, last: 0 };
    s.hits++; s.last = Math.max(s.last, e.t);
    stats.set(e.skill, s);
  }
  // 跨来源副本：同名 skill 出现在几处
  const copies = new Map();
  for (const it of items) {
    if (it.residue) continue;
    const arr = copies.get(it.name) || [];
    arr.push(it.label + '/skills' + (it.disabled ? '/_disabled' : ''));
    copies.set(it.name, arr);
  }
  for (const it of items) {
    const st = stats.get(it.name);
    it.hits = st ? st.hits : 0;
    it.last = st ? st.last : 0;
    const cp = copies.get(it.name) || [];
    it.copies = cp.length > 1 ? cp : null;
  }
  // 预算：每个 Claude 会话都常驻的部分（全局 + 插件）；项目级只在对应项目生效，不计入
  let budgetChars = 0;
  for (const it of items) {
    if (!it.disabled && !it.residue && (it.source === 'claude' || it.source === 'plugin')) budgetChars += it.descLen;
  }
  const enabled = items.filter((it) => !it.disabled && !it.residue);
  const data = {
    ok: true, at: Date.now(),
    items,
    roots: { claude: CLAUDE_SKILLS, codex: CODEX_SKILLS, agents: AGENTS_SKILLS },
    overview: {
      total: items.filter((it) => !it.residue).length,
      unique: new Set(items.filter((it) => !it.residue).map((it) => it.name)).size,
      active: enabled.filter((it) => it.hits > 0).length,
      totalHits: enabled.reduce((a, b) => a + b.hits, 0),
      dust: enabled.filter((it) => it.hits === 0).length,
      issues: items.filter((it) => it.issues.length).length,
      budgetChars, budgetLimit: SKILL_BUDGET_CHARS, descCut: SKILL_DESC_CUT,
    },
  };
  skillsCache = { at: Date.now(), data };
  return data;
}

// 启停/卸载的路径校验：只允许动「最近一次扫描出来的 skill 目录」，杜绝任意路径移动/删除
async function validateSkillDir(dir) {
  if (!skillsCache.data) await skillsData();
  const target = path.resolve(String(dir || ''));
  const it = (skillsCache.data.items || []).find((x) => x.dir === target);
  if (!it) return { ok: false, error: '不在已扫描的 skills 清单里' };
  return { ok: true, item: it };
}

async function skillToggle(dir, enable) {
  const v = await validateSkillDir(dir);
  if (!v.ok) return v;
  const it = v.item;
  if (it.residue) return { ok: false, error: '残留文件不能启停，请直接清理' };
  if (!!enable === !it.disabled) return { ok: true, dir: it.dir }; // 已是目标状态
  const root = it.disabled ? path.dirname(path.dirname(it.dir)) : path.dirname(it.dir);
  const dest = enable ? path.join(root, it.name) : path.join(root, '_disabled', it.name);
  try {
    if (!enable) await fsp.mkdir(path.join(root, '_disabled'), { recursive: true });
    await fsp.access(dest).then(() => { throw new Error('目标位置已有同名目录'); }, () => {});
    // skills.sh 等安装器装的是相对路径 symlink（../../.agents/...）——直接 rename 会因层级变化断链，
    // 改为解析出绝对目标后删旧链建新链；真实目录才走 rename
    const lst = await fsp.lstat(it.dir);
    if (lst.isSymbolicLink()) {
      const target = await fsp.realpath(it.dir);
      await fsp.unlink(it.dir);
      await fsp.symlink(target, dest);
    } else {
      await fsp.rename(it.dir, dest);
    }
  } catch (e) { return { ok: false, error: e.message }; }
  skillsCache = { at: 0, data: null };
  return { ok: true, dir: dest };
}

async function skillTrash(dir) {
  const v = await validateSkillDir(dir);
  if (!v.ok) return v;
  const r = await trashPath(v.item.dir);
  if (r.ok) skillsCache = { at: 0, data: null };
  return r;
}

// ---------- 内置 skill 一键安装（设置面板）----------
// 随 app 分发的 skill（skills/<id>/）拷进 ~/.claude/skills/<id>/，终端里的 claude 就学会翻箱的配套玩法。
// asar 包里 fs 照常可读（Electron 补丁过的 fs），开发目录直接跑也一样。
const BUILTIN_SKILLS = ['fanbox-agent'];
function builtinSkillPaths(id) {
  if (!BUILTIN_SKILLS.includes(id)) return null;
  return { src: path.join(__dirname, 'skills', id), dst: path.join(HOME, '.claude', 'skills', id) };
}
async function builtinSkillStatus() {
  const items = [];
  for (const id of BUILTIN_SKILLS) {
    const { src, dst } = builtinSkillPaths(id);
    try {
      const bundled = await fsp.readFile(path.join(src, 'SKILL.md'), 'utf8');
      let installed = false, upToDate = false;
      try { installed = true; upToDate = (await fsp.readFile(path.join(dst, 'SKILL.md'), 'utf8')) === bundled; }
      catch { installed = false; }
      items.push({ id, installed, upToDate });
    } catch { /* 包里没带这个 skill（精简构建）：不展示 */ }
  }
  return { ok: true, skills: items };
}
async function builtinSkillInstall(id) {
  const p = builtinSkillPaths(id);
  if (!p) return { ok: false, error: 'unknown skill' };
  try {
    await fsp.mkdir(p.dst, { recursive: true });
    for (const name of await fsp.readdir(p.src)) { // 单层拷贝够用：skill 目录当前只有 SKILL.md
      const st = await fsp.stat(path.join(p.src, name));
      if (st.isFile()) await fsp.writeFile(path.join(p.dst, name), await fsp.readFile(path.join(p.src, name)));
    }
    skillsCache = { at: 0, data: null }; // skills 面板下次打开能立刻看到
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
}

async function agentUsage() {
  if (usageResultCache.data && Date.now() - usageResultCache.at < 30000) return usageResultCache.data;
  const [claude, codex, claudeLimits] = await Promise.all([
    claudeUsage().catch(() => null),
    codexUsage().catch(() => null),
    claudeOfficialLimits().catch(() => null),
  ]);
  const claudeOut = (claude || claudeLimits) ? { ...(claude || {}), official: claudeLimits } : null;
  const data = { ok: true, at: Date.now(), claude: claudeOut, codex };
  usageResultCache = { at: Date.now(), data };
  return data;
}

// ---------- 路由 ----------

// 只接受指向本机回环地址的 Host。挡住 DNS rebinding：恶意网页把自己的域名重绑定到
// 127.0.0.1 后，浏览器流量打到本机服务、origin 仍是攻击者域名却被当成同源，CORS 失效，
// 进而可调用文件读写 API 读全盘。校验 Host 头是最便宜也最有效的拦截。
const ALLOWED_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
function hostAllowed(req) {
  const host = (req.headers.host || '').replace(/:\d+$/, '');
  return ALLOWED_HOSTS.has(host);
}
// 挡跨站请求伪造（CSRF）：写操作全走 POST，而 text/plain 的 POST 是「简单请求」不触发预检，
// 仅靠 Host 校验拦不住——任意网页都能 fetch 本机 POST 偷偷改文件（响应跨域读不到，但副作用已落地）。
// 浏览器强制带的 Origin 头 JS 改不了：非回环 origin 一律拒。无 Origin（同源 GET / curl /
// Electron 主进程 net.fetch）放行；字面 'null'（sandbox iframe / file://）解析失败即拒。
function originAllowed(req) {
  const o = req.headers.origin;
  if (!o) return true;
  try { return ALLOWED_HOSTS.has(new URL(o).hostname); } catch { return false; }
}

// ---------- 定时任务：cron.json 持久化 + 到点开终端窗口跑 agent/命令 ----------
// 设计：调度器只在 FanBox 跑着时活着（本地工具，不装 launchd 常驻）；app 没开时错过的
// 记一条「错过」绝不补跑——定时任务突然袭击比漏跑一次更吓人。执行复用 Agent 控制接口的
// 开窗能力（global.__fanboxAgent.create），用户在界面上能看到窗口在干活。
const CRON_FILE = path.join(CONFIG_DIR, 'cron.json');
function cronLoad() {
  try { const d = JSON.parse(fs.readFileSync(CRON_FILE, 'utf8')); return Array.isArray(d.tasks) ? d.tasks : []; }
  catch { return []; }
}
function cronPersist() {
  try { fs.mkdirSync(CONFIG_DIR, { recursive: true }); fs.writeFileSync(CRON_FILE, JSON.stringify({ tasks: cronTasks }, null, 2)); }
  catch { /* 写失败不致命 */ }
}
let cronTasks = cronLoad();

// 5 字段 cron（分 时 日 月 周，本地时区）。支持 * , - */n；周日 0 或 7 都认
function cronField(spec, min, max) {
  if (spec === '*') return null; // null = 不限
  const set = new Set();
  for (const part of spec.split(',')) {
    const m = part.match(/^(\*|\d+)(?:-(\d+))?(?:\/(\d+))?$/);
    if (!m) return undefined; // 解析失败
    const step = m[3] ? parseInt(m[3], 10) : 1;
    if (!step) return undefined;
    let lo, hi;
    if (m[1] === '*') { lo = min; hi = max; }
    else { lo = parseInt(m[1], 10); hi = m[2] ? parseInt(m[2], 10) : (m[3] ? max : lo); }
    if (lo < min || hi > max + (max === 6 ? 1 : 0) || lo > hi) return undefined; // 周允许 7
    for (let v = lo; v <= hi; v += step) set.add(max === 6 && v === 7 ? 0 : v);
  }
  return set;
}
// 下一次命中时刻（ms）；表达式非法返回 undefined，一年内无命中返回 null
function cronNext(expr, fromMs) {
  const parts = String(expr || '').trim().split(/\s+/);
  if (parts.length !== 5) return undefined;
  const [fMin, fHour, fDom, fMon, fDow] = [
    cronField(parts[0], 0, 59), cronField(parts[1], 0, 23), cronField(parts[2], 1, 31),
    cronField(parts[3], 1, 12), cronField(parts[4], 0, 6),
  ];
  if ([fMin, fHour, fDom, fMon, fDow].some((f) => f === undefined)) return undefined;
  // 经典 cron 语义：日、周都有限定时，任一命中即可
  const dayOk = (d) => {
    const dom = !fDom || fDom.has(d.getDate());
    const dow = !fDow || fDow.has(d.getDay());
    return fDom && fDow ? (dom || dow) : (dom && dow);
  };
  const d = new Date(fromMs);
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  for (let i = 0; i < 366 * 24 * 60; i++) {
    if (!fMon || fMon.has(d.getMonth() + 1)) {
      if (dayOk(d)) {
        if ((!fHour || fHour.has(d.getHours())) && (!fMin || fMin.has(d.getMinutes()))) return d.getTime();
      } else { d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + 1); i += 1439; continue; } // 整天不匹配就跳天
    } else { d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + 1); i += 1439; continue; }
    d.setMinutes(d.getMinutes() + 1);
  }
  return null;
}
// 任务的下一次执行时刻；null = 不再执行
function cronNextRun(t, fromMs = Date.now()) {
  const s = t.schedule || {};
  if (s.type === 'at') { const ts = new Date(s.time).getTime(); return !isFinite(ts) || ts <= fromMs ? null : ts; }
  if (s.type === 'every') {
    const step = Math.max(1, Number(s.minutes) || 0) * 60000;
    const base = t.lastFire || t.createdAt || fromMs;
    const n = base + step;
    return n > fromMs ? n : fromMs + step; // 错过的不补，从现在起重新按周期排
  }
  if (s.type === 'cron') { const n = cronNext(s.expr, fromMs); return n === undefined ? null : n; }
  return null;
}
function cronScheduleValid(s) {
  if (!s || typeof s !== 'object') return '缺少时间规则';
  if (s.type === 'at') { const ts = new Date(s.time).getTime(); if (!isFinite(ts)) return '时间点无法解析'; if (ts <= Date.now()) return '时间点已经过去了'; return null; }
  if (s.type === 'every') { const m = Number(s.minutes); if (!isFinite(m) || m < 1) return '周期至少 1 分钟'; return null; }
  if (s.type === 'cron') { return cronNext(s.expr, Date.now()) === undefined ? 'cron 表达式无法解析（需要 5 段：分 时 日 月 周）' : null; }
  return '不认识的时间规则类型';
}
function cronShq(s) { return `'${String(s).replace(/'/g, `'\\''`)}'`; }
// 到点敲进新终端的命令。agent 任务默认 acceptEdits（编辑自动同意，跑命令仍确认）；
// full = 用户明确要全自动（无人值守跳过一切确认）
function cronCommand(t) {
  if (t.agent === 'shell') return String(t.prompt || '');
  const p = cronShq(t.prompt || '');
  if (t.agent === 'codex') return t.full ? `codex --full-auto ${p}` : `codex ${p}`;
  return t.full ? `claude --dangerously-skip-permissions ${p}` : `claude --permission-mode acceptEdits ${p}`;
}
async function cronFire(t, manual) {
  t.nextRun = (t.schedule || {}).type === 'at' ? null : cronNextRun(t); // 先排下一次，防调度重入
  const rec = { t: Date.now(), manual: !!manual };
  const A = global.__fanboxAgent;
  if (!A) { rec.ok = false; rec.error = '需要桌面版（浏览器版没有内嵌终端）'; }
  else {
    const r = await A.create({ cwd: t.cwd || HOME, autorun: cronCommand(t) }).catch((e) => ({ ok: false, error: String((e && e.message) || e) }));
    rec.ok = !!(r && r.ok); if (r && r.error) rec.error = r.error; if (r && r.id) rec.term = r.id;
  }
  t.lastFire = rec.t;
  t.history = [rec, ...(t.history || [])].slice(0, 10);
  if ((t.schedule || {}).type === 'at') t.enabled = false; // 一次性任务执行完自动归档
  cronPersist();
  return rec;
}
// 启动结算：错过的记一笔、不补跑；一次性过期的直接停
for (const t of cronTasks) {
  if (t.enabled && t.nextRun && t.nextRun < Date.now() - 60000) {
    t.history = [{ t: t.nextRun, missed: true }, ...(t.history || [])].slice(0, 10);
  }
  t.nextRun = t.enabled ? cronNextRun(t) : null;
  if (t.enabled && (t.schedule || {}).type === 'at' && !t.nextRun) t.enabled = false;
}
cronPersist();
setInterval(() => {
  const now = Date.now();
  for (const t of cronTasks) {
    if (t.enabled && t.nextRun && t.nextRun <= now) cronFire(t, false);
  }
}, 20000);

function cronList() { return { ok: true, desktop: !!global.__fanboxAgent, now: Date.now(), tasks: cronTasks }; }
async function cronAction(action, b = {}) {
  if (action === 'preview') { // 给定时间规则，预告接下来最多 3 次执行
    const err = cronScheduleValid(b.schedule);
    if (err) return { ok: false, error: err };
    const times = [];
    let from = Date.now();
    const fake = { schedule: b.schedule, createdAt: Date.now() };
    for (let i = 0; i < 3; i++) {
      const n = cronNextRun(fake, from);
      if (!n) break;
      times.push(n); from = n; fake.lastFire = n;
    }
    return { ok: true, times };
  }
  if (action === 'save') {
    const err = cronScheduleValid(b.schedule);
    if (err) return { ok: false, error: err };
    if (!String(b.prompt || '').trim()) return { ok: false, error: '任务内容不能为空' };
    const agent = ['claude', 'codex', 'shell'].includes(b.agent) ? b.agent : 'claude';
    const old = b.id && cronTasks.find((x) => x.id === b.id);
    const t = old || { id: 'cr' + crypto.randomBytes(4).toString('hex'), createdAt: Date.now(), history: [] };
    Object.assign(t, {
      name: String(b.name || '').trim() || String(b.prompt).trim().slice(0, 24),
      cwd: String(b.cwd || '').trim() || HOME,
      agent, prompt: String(b.prompt).trim(), full: !!b.full,
      schedule: b.schedule, enabled: b.enabled !== false,
      createdBy: b.createdBy === 'agent' ? 'agent' : (old ? old.createdBy : 'ui'),
    });
    t.nextRun = t.enabled ? cronNextRun(t) : null;
    if (!old) cronTasks.push(t);
    cronPersist();
    return { ok: true, task: t };
  }
  const t = cronTasks.find((x) => x.id === b.id);
  if (!t) return { ok: false, error: 'no such task' };
  if (action === 'delete') { cronTasks = cronTasks.filter((x) => x.id !== b.id); cronPersist(); return { ok: true }; }
  if (action === 'toggle') {
    t.enabled = !!b.enabled;
    t.nextRun = t.enabled ? cronNextRun(t) : null;
    if (t.enabled && (t.schedule || {}).type === 'at' && !t.nextRun) { t.enabled = false; cronPersist(); return { ok: false, error: '时间点已过去，改个时间再启用' }; }
    cronPersist();
    return { ok: true, task: t };
  }
  if (action === 'run') { const rec = await cronFire(t, true); return { ok: !!rec.ok, error: rec.error, term: rec.term, task: t }; }
  return { ok: false, error: 'unknown cron action' };
}

// ---------- 版本历史：解析随包分发的 CHANGELOG.md（Keep a Changelog 格式），侧栏版本号入口用 ----------
let clogCache = null; // { mtime, data }
function changelogData() {
  try {
    const file = path.join(__dirname, 'CHANGELOG.md');
    const mtime = fs.statSync(file).mtimeMs;
    if (clogCache && clogCache.mtime === mtime) return clogCache.data;
    const raw = fs.readFileSync(file, 'utf8');
    const entries = [];
    const re = /^## \[([^\]]+)\](?:\s*-\s*(\S+))?\s*$/gm;
    let m, prev = null;
    while ((m = re.exec(raw))) {
      if (prev) prev.body = raw.slice(prev.end, m.index).trim();
      prev = { version: m[1], date: m[2] || '', end: re.lastIndex };
      entries.push(prev);
    }
    if (prev) prev.body = raw.slice(prev.end).trim();
    entries.forEach((e) => delete e.end);
    const data = { ok: true, version: require('./package.json').version, entries };
    clogCache = { mtime, data };
    return data;
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
}

const server = http.createServer(async (req, res) => {
  if (!hostAllowed(req)) { res.writeHead(403); res.end('forbidden host'); return; }
  if (req.method === 'POST' && !originAllowed(req)) { res.writeHead(403); res.end('forbidden origin'); return; }
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;
  const qp = url.searchParams;

  try {
    if (p === '/api/roots') {
      return sendJSON(res, 200, { home: HOME, platform: PLATFORM, sep: path.sep, roots: defaultRoots() });
    }
    if (p === '/api/changelog') {
      return sendJSON(res, 200, changelogData());
    }
    // 定时任务（界面用；agent 用带 token 的 /api/agent/cron*，同一套实现）
    if (p === '/api/cron') {
      return sendJSON(res, 200, cronList());
    }
    if (p.startsWith('/api/cron/') && req.method === 'POST') {
      return sendJSON(res, 200, await cronAction(p.slice('/api/cron/'.length), await readBody(req)));
    }
    if (p === '/api/list') {
      return sendJSON(res, 200, await listDir(qp.get('path') || HOME));
    }
    if (p === '/api/read') {
      return sendJSON(res, 200, await readFile(qp.get('path')));
    }
    if (p === '/api/raw') {
      return serveRaw(req, res, qp.get('path'));
    }
    // 路径镜像端点：/fs/<绝对路径> 按真实磁盘路径出文件。
    // HTML 预览的 iframe 指到这里后，页面里的相对引用（./img.png、子目录、嵌套 iframe）
    // 都能按所在目录正确解析——srcdoc 方案没有 base URL，这些全是裂的。
    // 暴露面与 /api/raw 等价（都接受任意绝对路径），且同样只对本机回环开放。
    // HTML 文件额外注入 viewport，让预览框内宽度自适应、滚动稳定。
    if (p.startsWith('/fs/')) {
      const fsPath = decodeURIComponent(p.slice(3));
      const fsExt = (ext(fsPath) || '').toLowerCase();
      if (fsExt === 'html' || fsExt === 'htm') {
        return serveHtmlPreview(req, res, fsPath);
      }
      return serveRaw(req, res, fsPath);
    }
    if (p === '/api/thumb') {
      return serveThumb(req, res, qp.get('path'), parseInt(qp.get('w') || '240', 10), qp.get('v'));
    }
    if (p === '/api/img-proxy') {
      return proxyImage(res, qp.get('url'));
    }
    if (p === '/api/search') {
      return sendJSON(res, 200, await searchFiles(qp.get('q'), qp.get('root') || HOME));
    }
    if (p === '/api/grep') {
      return sendJSON(res, 200, await grepFiles(qp.get('q'), qp.get('root') || HOME));
    }
    if (p === '/api/content') {
      return sendJSON(res, 200, await contentSearch(qp.get('q'), qp.get('root') || HOME));
    }
    if (p === '/api/recent') {
      return sendJSON(res, 200, await recentFiles(qp.get('root') || HOME));
    }
    if (p === '/api/term-verify' && req.method === 'POST') {
      return sendJSON(res, 200, await termVerify(await readBody(req)));
    }
    if (p === '/api/locate') {
      const extraRoots = String(qp.get('roots') || '').split('\n').filter(Boolean).slice(0, 3);
      const loc = await locatePath(qp.get('path'), qp.get('name'), qp.get('root'), qp.get('tail'), qp.get('alt'), extraRoots);
      // ==== 二开: cockpit ==== 附带单文件 entry 元信息，驾驶舱内按 tab 打开右侧预览无需再拉整目录 /api/list
      if (loc && loc.found && !loc.isDir && loc.path) {
        try {
          const st = await fsp.stat(loc.path);
          const nm = path.basename(loc.path);
          loc.entry = { name: nm, path: loc.path, isDir: false, kind: kindOf(nm, false), size: st.size, mtime: st.mtimeMs, btime: st.birthtimeMs || 0 };
        } catch { /* */ }
      }
      return sendJSON(res, 200, loc);
    }
    if (p === '/api/git') {
      return sendJSON(res, 200, await gitStatus(qp.get('path') || HOME));
    }
    if (p === '/api/git-file') {
      const d = await gitFileDiff(qp.get('path'));
      // 不在 git 仓库 → 退回影子快照当基准，「看清改了哪几行」覆盖所有文件夹
      if (!d.isRepo && !d.shadow) {
        const s = await snapFileDiff(resolvePath(qp.get('path'))).catch(() => null);
        if (s) return sendJSON(res, 200, s);
      }
      return sendJSON(res, 200, d);
    }
    if (p === '/api/snapshot' && req.method === 'POST') {
      const b = await readBody(req);
      return sendJSON(res, 200, await snapshot(b.path, b.label));
    }
    if (p === '/api/snapshots') {
      return sendJSON(res, 200, await snapList(qp.get('path')));
    }
    if (p === '/api/snapshots/usage') {
      return sendJSON(res, 200, await snapUsage());
    }
    if (p === '/api/snapshots/clean' && req.method === 'POST') {
      return sendJSON(res, 200, await snapClean(await readBody(req)));
    }
    if (p === '/api/snapshot-restore' && req.method === 'POST') {
      const b = await readBody(req);
      return sendJSON(res, 200, await snapRestore(b.path, b.hash));
    }
    if (p === '/api/open' && req.method === 'POST') {
      const body = await readBody(req);
      const result = await openInOS(resolvePath(body.path), body.with);
      // 记录最近打开（串行 RMW，不丢更新）
      if (result.ok) {
        await updateConfig((cfg) => { cfg.recentOpened = [body.path, ...(cfg.recentOpened || []).filter((x) => x !== body.path)].slice(0, 30); });
      }
      return sendJSON(res, 200, result);
    }
    if (p === '/api/recent-open' && req.method === 'POST') {
      // 内部预览/编辑也记入「最近打开」，去重 + 最近优先（串行 RMW）
      const body = await readBody(req);
      if (body.path) {
        const cfg = await updateConfig((c) => { c.recentOpened = [body.path, ...(c.recentOpened || []).filter((x) => x !== body.path)].slice(0, 30); });
        return sendJSON(res, 200, { ok: true, recentOpened: cfg.recentOpened });
      }
      return sendJSON(res, 200, { ok: false });
    }
    if (p === '/api/write' && req.method === 'POST') {
      const b = await readBody(req);
      try { return sendJSON(res, 200, await writeTextFile(b.path, b.content, b.expectedMtime)); }
      catch (e) { return sendJSON(res, 200, { ok: false, conflict: !!e.conflict, error: e.message }); }
    }
    if (p === '/api/archive') {
      return sendJSON(res, 200, await archiveList(url.searchParams.get('path')));
    }
    // ==== 二开: office —— Office 三件套原地预览 ====
    if (p === '/api/office') {
      return sendJSON(res, 200, await officePreview(url.searchParams.get('path')));
    }
    if (p === '/api/du') {
      return sendJSON(res, 200, await diskUsage(url.searchParams.get('path')));
    }
    if (p === '/api/project-memory') {
      return sendJSON(res, 200, await projectMemory(url.searchParams.get('path')));
    }
    if (p === '/api/lang' && req.method === 'POST') {
      const b = await readBody(req);
      const lang = b.lang === 'en' ? 'en' : 'zh';
      await updateConfig((c) => { c.lang = lang; });
      return sendJSON(res, 200, { ok: true, lang });
    }
    if (p === '/api/organize/launch' && req.method === 'POST') {
      return sendJSON(res, 200, await organizeLaunch(await readBody(req)));
    }
    if (p === '/api/release/inspect') {
      return sendJSON(res, 200, await releaseInspect(url.searchParams.get('path')));
    }
    if (p === '/api/release/prepare' && req.method === 'POST') {
      return sendJSON(res, 200, await releasePrepare(await readBody(req)));
    }
    if (p === '/api/trash' && req.method === 'POST') {
      const b = await readBody(req);
      return sendJSON(res, 200, await trashPath(b.path));
    }
    if (p === '/api/move' && req.method === 'POST') {
      const b = await readBody(req);
      return sendJSON(res, 200, await movePath(b.src, b.dstDir));
    }
    if (p === '/api/rename' && req.method === 'POST') {
      const b = await readBody(req);
      return sendJSON(res, 200, await renamePath(b.path, b.newName));
    }
    if (p === '/api/image-save' && req.method === 'POST') {
      const body = await readBody(req);
      try { return sendJSON(res, 200, await saveImage(body)); }
      catch (e) { return sendJSON(res, 200, { error: e.message }); }
    }
    if (p === '/api/create' && req.method === 'POST') {
      const b = await readBody(req);
      return sendJSON(res, 200, await createEntry(b.path, b.name, b.type));
    }
    if (p === '/api/agents') {
      // coding agent 启动按钮（#38）：GET 回配置，POST 存设置面板勾选的 enabledAgents
      // enabled = 面板勾选的内置 agent id；custom = config.json 手写的 agents 数组（同 id 覆盖内置命令，新 id 追加）
      if (req.method === 'POST') {
        const b = await readBody(req);
        const enabled = (Array.isArray(b.enabled) ? b.enabled : [])
          .filter((x) => typeof x === 'string' && /^[\w-]{1,32}$/.test(x)).slice(0, 32);
        await updateConfig((c) => { c.enabledAgents = enabled; });
        return sendJSON(res, 200, { ok: true, enabled });
      }
      const cfg = await readConfig();
      const custom = (Array.isArray(cfg.agents) ? cfg.agents : [])
        .filter((a) => a && typeof a.id === 'string' && a.id && typeof a.cmd === 'string' && a.cmd);
      return sendJSON(res, 200, { enabled: Array.isArray(cfg.enabledAgents) ? cfg.enabledAgents : null, custom });
    }
    if (p === '/api/agents/which') {
      // 装没装探测：bins 走登录 shell command -v；apps 是桌面应用，走 open -Ra
      const out = {};
      const bins = String(url.searchParams.get('bins') || '').split(',')
        .map((s) => s.trim()).filter((s) => /^[A-Za-z0-9._-]{1,64}$/.test(s)).slice(0, 32);
      const apps = String(url.searchParams.get('apps') || '').split(',')
        .map((s) => s.trim()).filter((s) => /^[\w .-]{1,64}$/.test(s)).slice(0, 32);
      await Promise.all([
        ...bins.map(async (b) => { out[b] = !!(await findAgentBin(b)); }),
        ...apps.map((a) => new Promise((resolve) => {
          execFile('/usr/bin/open', ['-Ra', a], { timeout: 8000 }, (err) => { out[a] = !err; resolve(); });
        })),
      ]);
      return sendJSON(res, 200, out);
    }
    if (p === '/api/agent-projects') {
      return sendJSON(res, 200, await agentProjects());
    }
    // ==== 二开: cockpit ====
    if (p === '/api/agent-sessions') {
      return sendJSON(res, 200, await agentSessions());
    }
    if (p === '/api/session-host') {
      return sendJSON(res, 200, await sessionHost(qp.get('id') || '', qp.get('agent') || ''));
    }
    if (p === '/api/session-name' && req.method === 'POST') {
      const b = await readBody(req);
      if (!b || !b.id) return sendJSON(res, 200, { ok: false, error: 'missing id' });
      await updateConfig((c) => {
        const m = c.sessionNames || {};
        const name = String(b.name || '').trim().slice(0, 80);
        if (name) m[b.id] = name; else delete m[b.id];
        // 按插入序裁掉最老的，防止 map 无限膨胀
        const keys = Object.keys(m);
        if (keys.length > 300) for (const k of keys.slice(0, keys.length - 300)) delete m[k];
        c.sessionNames = m;
      });
      return sendJSON(res, 200, { ok: true });
    }
    if (p === '/api/skills') {
      return sendJSON(res, 200, await skillsData());
    }
    if (p === '/api/skills/builtin') {
      return sendJSON(res, 200, await builtinSkillStatus());
    }
    if (p === '/api/skills/install-builtin' && req.method === 'POST') {
      const b = await readBody(req);
      return sendJSON(res, 200, await builtinSkillInstall(b.id));
    }
    if (p === '/api/skills/refresh' && req.method === 'POST') {
      const b = await readBody(req);
      const extraCwds = b && b.cwd ? [b.cwd] : [];
      return sendJSON(res, 200, await skillsData({ force: true, extraCwds }));
    }
    if (p === '/api/skills/toggle' && req.method === 'POST') {
      const b = await readBody(req);
      return sendJSON(res, 200, await skillToggle(b.dir, !!b.enable));
    }
    if (p === '/api/skills/trash' && req.method === 'POST') {
      const b = await readBody(req);
      return sendJSON(res, 200, await skillTrash(b.dir));
    }
    if (p === '/api/agent-usage') {
      return sendJSON(res, 200, await agentUsage());
    }
    if (p === '/api/favorites') {
      if (req.method === 'POST') {
        const body = await readBody(req);
        const cfg = await updateConfig((c) => {
          const has = (c.favorites || []).some((f) => f.path === body.path);
          c.favorites = has
            ? c.favorites.filter((f) => f.path !== body.path)
            : [{ path: body.path, name: body.name, isDir: body.isDir }, ...(c.favorites || [])].slice(0, 50);
        });
        return sendJSON(res, 200, { favorites: cfg.favorites || [], recentOpened: cfg.recentOpened || [] });
      }
      const cfg = await readConfig();
      return sendJSON(res, 200, { favorites: cfg.favorites || [], recentOpened: cfg.recentOpened || [] });
    }

    // ---------- Agent 控制接口：桌面 app 专属（能力由 electron/main.js 注入 global.__fanboxAgent）----------
    // token 只注入翻箱自开终端的环境变量、不落盘：只有跑在翻箱终端里的 agent 拿得到门票。见 docs/12。
    if (p.startsWith('/api/agent/')) {
      const A = global.__fanboxAgent;
      if (!A) return sendJSON(res, 501, { ok: false, error: 'desktop app only' });
      const tok = req.headers['x-fanbox-token'] || qp.get('token') || '';
      if (tok !== A.token) return sendJSON(res, 403, { ok: false, error: 'bad token' });
      // 定时任务：agent 用自然语言理解用户意图后换算成 schedule 调这里（见 skills/fanbox-agent）
      if (p === '/api/agent/cron') return sendJSON(res, 200, cronList());
      if (p.startsWith('/api/agent/cron/') && req.method === 'POST') {
        const b = await readBody(req);
        if (p === '/api/agent/cron/save') b.createdBy = 'agent';
        return sendJSON(res, 200, await cronAction(p.slice('/api/agent/cron/'.length), b));
      }
      if (p === '/api/agent/terminals') return sendJSON(res, 200, await A.list());
      if (p === '/api/agent/read') return sendJSON(res, 200, A.read(qp.get('id'), parseInt(qp.get('lines') || '0', 10)));
      if (p === '/api/agent/send' && req.method === 'POST') { const b = await readBody(req); return sendJSON(res, 200, A.send(b.id, b.text, b)); }
      if (p === '/api/agent/create' && req.method === 'POST') { return sendJSON(res, 200, await A.create(await readBody(req))); }
      if (p === '/api/agent/wait' && req.method === 'POST') { const b = await readBody(req); return sendJSON(res, 200, await A.wait(b.id, b)); }
      if (p === '/api/agent/kill' && req.method === 'POST') { const b = await readBody(req); return sendJSON(res, 200, A.kill(b.id)); }
      return sendJSON(res, 404, { ok: false, error: 'unknown agent endpoint' });
    }

    // 静态资源
    return await serveStatic(req, res, p);
  } catch (err) {
    return sendJSON(res, 500, { error: err.message });
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  ⚠️  端口 ${PORT} 已被占用——FanBox 很可能已经在运行了。`);
    console.error(`      直接打开浏览器访问  http://localhost:${PORT}  就行；`);
    console.error(`      想另开一个，换端口：FANBOX_PORT=8080 node server.js\n`);
  } else {
    console.error('\n  启动失败：', err.message, '\n');
  }
  process.exit(1);
});

// 预览专用服务器：只出 /fs/ 静态文件，绝不暴露 /api（删文件/开应用等危险接口）。
// HTML 预览 iframe 指到这个独立端口 + 开 allow-same-origin：页面拿到「自己的」完整源
// （localStorage/fetch 都能跑），却与 App 跨源——碰不到 App 的 DOM、localStorage 和 /api，
// 也无法摘掉 sandbox 反向接管（那要求同源）。可读范围再收紧到主目录、挡掉点目录（.ssh/.aws/.config…），
// 防止恶意预览页 same-origin 下读敏感文件外泄。
const PREVIEW_PORT = PORT + 1;
function previewPathAllowed(file) {
  const real = path.resolve(file);
  const home = path.resolve(HOME);
  if (real !== home && !real.startsWith(home + path.sep)) return false; // 只放行主目录以下
  return !real.slice(home.length).split(path.sep).some((s) => s.startsWith('.')); // 任一段是点目录/点文件 → 拒
}
const previewServer = http.createServer(async (req, res) => {
  if (!hostAllowed(req)) { res.writeHead(403); res.end('forbidden host'); return; }
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end('method not allowed'); return; }
  const p = new URL(req.url, `http://localhost:${PREVIEW_PORT}`).pathname;
  if (!p.startsWith('/fs/')) { res.writeHead(403); res.end('preview server serves /fs/ only'); return; }
  const raw = decodeURIComponent(p.slice(3));
  let resolved;
  try { resolved = resolvePath(raw); } catch { res.writeHead(400); res.end('bad path'); return; }
  if (!previewPathAllowed(resolved)) { res.writeHead(403); res.end('outside preview scope'); return; }
  try {
    const fsExt = (ext(raw) || '').toLowerCase();
    if (fsExt === 'html' || fsExt === 'htm') return serveHtmlPreview(req, res, raw);
    return serveRaw(req, res, raw);
  } catch (err) { res.writeHead(500); res.end(String((err && err.message) || err)); }
});
previewServer.on('error', (err) => { console.error('  ⚠️  预览服务器启动失败：', err.message); });
previewServer.listen(PREVIEW_PORT, '127.0.0.1', () => { console.log(`  🖼  预览源（隔离）：http://localhost:${PREVIEW_PORT}`); });

server.listen(PORT, '127.0.0.1', () => {
  const link = `http://localhost:${PORT}`;
  console.log('\n  📦  FanBox 已启动');
  console.log(`  🔗  ${link}`);
  console.log('  🏠  根目录:', HOME);
  console.log('\n  按 Ctrl+C 退出\n');
  pruneThumbs().catch(() => {}); // 启动时裁剪缩略图缓存，防止无限增长
  snapReapAll().catch(() => {}); // 清掉一个快照都没有的影子仓库（只剩失败 commit 堆下的孤立对象）
  if (!process.env.FANBOX_NO_OPEN) {
    const opener = PLATFORM === 'darwin' ? 'open' : PLATFORM === 'win32' ? 'start' : 'xdg-open';
    exec(`${opener} ${link}`, () => {});
  }
});
