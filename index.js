// st-chat-sync — 酒馆多端同步插件（角色级整包：角色卡 + 绑定世界书 + 聊天记录）
// 手动 + 自动双触发，复用 ST 官方 importCharacterChat/displayPastChats 让聊天进楼层。
// 云端：Gitee Contents API（浏览器直连，CORS 已实测放行）

import { extension_settings, getContext } from '../../../extensions.js';
import { eventSource, event_types, saveSettingsDebounced, saveSettings, saveCharacterDebounced, importCharacterChat, displayPastChats, openCharacterChat, getRequestHeaders, getCharacters, select_selected_character, setCharacterId, reloadCurrentChat, doNewChat, deleteCharacter, chat_metadata, saveMetadata, redisplayChat, scrollChatToBottom, deleteCharacterChatByName, settings as stSettings } from '../../../../script.js';
import { Popup } from '../../../../scripts/popup.js';
import { importGroupChat } from '../../../group-chats.js';
import { loadWorldInfo, importWorldInfo, world_names, deleteWorldInfo } from '../../../world-info.js';
import { power_user } from '../../../power-user.js'; // 主题删除走官方按钮时需要(官方 deleteTheme 删的是 power_user.theme)

// 加载探针：供 headless 验证/调试确认插件确实执行
window.__stChatSyncLoaded = true;
// 自动检测自身文件夹名(从脚本URL提取, 如 third-party/st-chat-sync)
// 用于自更新: 不硬编码名字, 无论装在什么文件夹名下都能正确调官方接口
try {
    const __selfUrl = new URL(import.meta.url);
    const __parts = __selfUrl.pathname.split('/').filter(Boolean);
    __parts.pop(); // 去掉 index.js
    window.__csSelfFolder = __parts[__parts.length - 1]; // 文件夹名(如 st-chat-sync)
} catch { window.__csSelfFolder = 'st-chat-sync'; }

const extensionName = 'st_chat_sync';
const PLUGIN_VERSION = '0.11.2'; // ⚠️ 与 manifest.json version 同步升(扩展更新机制靠它), 面板顶部显示供用户自查版本
const DEFAULT_SETTINGS = {
    owner: '',
    repo: '',
    token: '',
    server: '',
    autoSync: false,          // 自动同步（备份上传）总开关（默认关）
    autoSyncOnOpen: false,    // 【一次性】打开角色时自动拉取一次（独立，不归自动总开关；默认关）
    autoSyncOnSwitch: false,  // 【自动】切换角色/聊天时自动上传备份（受自动总开关管；默认关）
    autoSyncLive: false,      // 双端实时：定时轮询（默认关）
    autoSyncInterval: 600,    // 轮询秒数（默认 600s = 10 分钟）
    syncScope: 'chat',        // 自动上传范围：'chat'=仅当前聊天 / 'char'=仅当前角色 / 'all'=全部聊天（默认仅当前聊天）
    lastCloudSha: {},         // {云端路径: sha} 记忆
    lastLocalMTime: {},       // {云端路径: 上次同步时本地聊天文件mtime} 增量粗筛
    syncMap: {},              // {角色名: {云路径: 本地导入后的真实文件名}} 稳定身份映射，让跨端同步收敛不复制
    uploadBundle: undefined,  // (已停用) 备份本体功能已移除(0.9.0): 打包依赖从仓库再拉代码, 作者删库后无法生成, 与防删库目的不符; 云端旧安全包仍可被导入端读取兜底
    connSlots: [],           // 连接槽位[{platform,repo,token,lastConnectAt}]: 保存配置自动去重入库, 下拉一秒切换, 可删
    autoUpdate: true,         // 自动更新插件至最新(默认勾选; 每次启动检查, 有新版自动升级+刷新)
};

// 统一从 settings 读；未初始化就建
const settings = (extension_settings[extensionName] = extension_settings[extensionName] || { ...DEFAULT_SETTINGS });
// 兼容：补齐缺失的默认键（老配置升级）
for (const k of Object.keys(DEFAULT_SETTINGS)) {
    if (settings[k] === undefined) settings[k] = DEFAULT_SETTINGS[k];
}
// v2 迁移：旧版本自动同步默认是开的（autoSyncOnOpen/autoSyncOnClose 默认 true），
// 且"关闭页面推送"已废弃。升级到 v2 时按新默认全关重置一次，避免旧值残留。
// (v3: 已移除"自动同步总开关"，定时由 autoSyncLive 自控；autoSync 字段仅作历史兼容保留)
if (!settings.uiV2) {
    settings.autoSync = false;
    settings.autoSyncOnOpen = false;   // 即时触发：默认关
    settings.autoSyncOnSwitch = false; // 切换上传：默认关
    delete settings.autoSyncOnClose;   // 已废弃
    settings.autoSyncLive = false;
    settings.autoSyncInterval = 600;
    settings.syncScope = 'chat';       // 默认仅当前聊天
    settings.uiV2 = true;
}

// ===================== Gitee Contents API 客户端 =====================
const b64Encode = (s) => btoa(unescape(encodeURIComponent(s))); // 中文安全
// 解码 Gitee 的 base64 content：先去除非-base64 字符（换行/空白），再一次性解 UTF-8
const b64Decode = (s) => {
    if (!s) return '';
    const clean = String(s).replace(/\s/g, '');
    try { return decodeURIComponent(escape(atob(clean))); }
    catch { try { return atob(clean); } catch { return ''; } }
};

const Gitee = {
    get base() { return (settings.server || 'https://gitee.com/api/v5').replace(/\/$/, ''); },
    // 双平台: Gitee v5 与 GitHub Contents API 同构(路径/PUT/DELETE/响应 sha 均一致)。
    // 差异仅: GitHub 需 Authorization 头(GET 查询参数不认) + vnd Accept; Gitee 两种认证都认 → 统一发头。
    isGithub() { return String(settings.server || '').includes('github'); },
    isGitlab() { return String(settings.server || '').includes('gitlab.com'); },
    // GitLab Contents API: /api/v4/projects/<url编码的owner/仓库>/repository/contents/<path> (与 GitHub 路由不同)
    glPath(raw) {
        const base = (settings.server || '').replace(/\/$/, '');
        const proj = encodeURIComponent(`${settings.owner}/${settings.repo}`);
        return `${base}/projects/${proj}/repository/contents/${String(raw).split('/').map(encodeURIComponent).join('/')}`;
    },
    auth(extra = {}) {
        if (this.isGitlab()) return { 'Content-Type': 'application/json', 'PRIVATE-TOKEN': settings.token, ...extra };
        return { 'Content-Type': 'application/json',
            ...(settings.token ? { 'Authorization': (this.isGithub() ? 'Bearer ' : 'token ') + settings.token } : {}),
            ...(this.isGithub() ? { 'Accept': 'application/vnd.github+json' } : {}),
            ...extra };
    },
    // 路径编码：Gitee contents API 的 path 含中文/空格需各段编码，但 '/' 分隔符必须保留（不能 encodeURIComponent 整串，会把 '/' 也编成 %2F，Gitee 不识别目录结构→写失败）
    encPath(p) { return String(p).split('/').map(encodeURIComponent).join('/'); },
    url(path) {
        const base = this.base;
        if (this.isGitlab()) return `${base}/projects/${encodeURIComponent(`${settings.owner}/${settings.repo}`)}/repository/contents/${this.encPath(path)}`;
        return `${base}/repos/${settings.owner}/${settings.repo}/contents/${this.encPath(path)}`;
    },

    // 统一请求: 20s 超时 + GET 失败自动慢重试1次 + 429限流/断网/超时的中文提示
    // （Gitee 对连续请求会限流 429，快速连点多个"云端"按钮时偶发失败——重试+明确提示是"获取不下来"的解药）
    errOf(r, path) {
        const n = r && r.status;
        if (n === 401) return new Error('云端令牌没通过(HTTP 401)——令牌可能没填、被重置、过期或复制漏了。到上方「设置」里重新粘贴/换一个新令牌再试');
        if (n === 403) return new Error('云端拒绝访问(HTTP 403)——令牌权限不够(创建时可能没勾仓库读写)。重新生成一个带读写权限的令牌, 并确认仓库是你自己的');
        if (n === 429) return new Error('云端接口限流(HTTP 429)——刚才请求太密，稍等 5 秒再点一次就行');
        if (n === 503 || n === 502 || n === 504) return new Error('云端服务器繁忙(HTTP ' + n + ')，稍候几秒再试');
        return new Error(path + ': HTTP ' + n);
    },
    async req(path, opts = {}) {
        const method = opts.method || 'GET';
        const timeout = opts.timeout || 45000;
        const url = `${this.url(path)}${this.isGithub() || this.isGitlab() ? '' : '?access_token=' + encodeURIComponent(settings.token)}${this.isGithub() || this.isGitlab() ? '' : '&_=' + Date.now()}`;
        const doFetch = () => {
            const ctl = new AbortController();
            const timer = setTimeout(() => ctl.abort(), timeout);
            return fetch(url, { method, headers: this.auth(), body: opts.body, cache: 'no-store', signal: ctl.signal })
                .finally(() => clearTimeout(timer));
        };
        // GET 最多试 3 次(弱网/限流抖动自愈, 间隔 1.2s); 写请求只试 1 次(防重复提交); 超时不重试(已等满 45s)
        const maxTry = (method === 'GET' && !opts.noRetry) ? 3 : 1;
        let r = null, lastErr = null;
        for (let attempt = 0; attempt < maxTry; attempt++) {
            try { r = await doFetch(); break; }
            catch (e) {
                lastErr = e;
                if (e && e.name === 'AbortError') break;
                if (attempt < maxTry - 1) await new Promise((rs) => setTimeout(rs, 1200));
            }
        }
        if (!r) {
            if (lastErr && lastErr.name === 'AbortError')
                throw new Error('云端请求超时(' + Math.round(timeout / 1000) + 's)——网络慢/仓库文件多，稍后再点；反复超时请点「连接测试」自查');
            throw new Error('网络请求失败：' + ((lastErr && lastErr.message) || lastErr));
        }
        // 404 容忍范围: GET(读不存在→上层返回null/[])与 DELETE(已删=幂等成功); PUT/POST 404(sha冲突/文件被移走)必须抛——
        // 否则 putText 拿不到 content.sha 静默返回 undefined, 上层以为上传成功, 实际云端没写进去(数据丢失风险)
        if (!r.ok && r.status === 404 && method !== 'GET' && method !== 'DELETE') throw this.errOf(r, path);
        if (!r.ok && r.status !== 404) throw this.errOf(r, path);
        return r;
    },
    // 读文件 → {content(base64解码后的utf8文本), sha} 或 null
    // ⚠️ Gitee 对"不存在/空路径"返回 status=200 + body=[]（空数组），不是 404！必须把"无 content 的响应"也当 null，
    //    否则上传时会把"云端无该聊天"误判成"云端有0层内容的文件"→ local_superset → 弹窗卡死（清空重建后首传全弹窗）。
    async getText(path) {
        // GitLab: contents 读写接口实测不可用, 单文件读走 repository/files..raw(full 文本, 无 1MB 截断); sha 置空(删除/更新走 commits 不依赖)
        if (this.isGitlab()) {
            const base = (settings.server || '').replace(/\/$/, '');
            const branch = await this.glEnsureBranch();
            const r = await fetch(`${base}/projects/${encodeURIComponent(`${settings.owner}/${settings.repo}`)}/repository/files/${encodeURIComponent(path)}/raw?ref=${encodeURIComponent(branch)}`, { headers: { 'PRIVATE-TOKEN': settings.token }, cache: 'no-store' });
            if (r.status === 404) return null;
            if (!r.ok) throw new Error('HTTP ' + r.status);
            return { content: await r.text(), sha: '1' };
        }
        // GitHub: contents GET 对 >~1MB 文件 content 为空(实测), 用 Git Blob API 取全量
        if (this.isGithub()) {
            const j = await this._ghContentsGet(path);
            if (!j) return null;
            if (!j.content && j.sha) {
                const b = await fetch(`${this.base}/repos/${settings.owner}/${settings.repo}/git/blobs/${j.sha}`, { headers: this.auth() });
                if (b.ok) { const bj = await b.json(); if (bj.content && bj.encoding === 'base64') return { content: b64Decode(bj.content), sha: j.sha }; }
                return null;
            }
            if (j.content === undefined) return null;
            return { content: b64Decode(j.content), sha: j.sha };
        }
        const r = await this.req(path);
        if (r.status === 404) return null;
        const j = await r.json();
        if (!j || typeof j !== 'object' || Array.isArray(j) || j.content === undefined) return null;
        return { content: b64Decode(j.content), sha: j.sha };
    },
    // 读取二进制(base64原始串)文件（角色卡PNG用）
    async getBase64(path) {
        if (this.isGitlab()) {
            const base = (settings.server || '').replace(/\/$/, '');
            const branch = await this.glEnsureBranch();
            const r = await fetch(`${base}/projects/${encodeURIComponent(`${settings.owner}/${settings.repo}`)}/repository/files/${encodeURIComponent(path)}/raw?ref=${encodeURIComponent(branch)}`, { headers: { 'PRIVATE-TOKEN': settings.token }, cache: 'no-store' });
            if (r.status === 404) return null;
            if (!r.ok) throw new Error('HTTP ' + r.status);
            const buf = new Uint8Array(await r.arrayBuffer());
            let b64 = '';
            for (let i = 0; i < buf.length; i += 0x6000) b64 += btoa(String.fromCharCode.apply(null, buf.subarray(i, i + 0x6000))); // 0x6000 为3的倍数, 分块拼接不产生中段'='补齐符
            return { b64, sha: '1' };
        }
        if (this.isGithub()) {
            const j = await this._ghContentsGet(path);
            if (!j) return null;
            if (!j.content && j.sha) {
                const b = await fetch(`${this.base}/repos/${settings.owner}/${settings.repo}/git/blobs/${j.sha}`, { headers: this.auth() });
                if (b.ok) { const bj = await b.json(); if (bj.content && bj.encoding === 'base64') return { b64: bj.content, sha: j.sha }; }
                return null;
            }
            if (j.content === undefined) return null;
            return { b64: j.content, sha: j.sha };
        }
        const r = await this.req(path);
        if (r.status === 404) return null;
        const j = await r.json();
        if (!j || typeof j !== 'object' || Array.isArray(j) || j.content === undefined) return null;
        return { b64: j.content, sha: j.sha };
    },
    // GitHub contents GET(统一入参处理, 返回解析对象或 null)
    async _ghContentsGet(path) {
        const r = await this.req(path);
        if (r.status === 404) return null;
        const j = await r.json();
        if (!j || typeof j !== 'object' || Array.isArray(j)) return null;
        return j;
    },
    // GitLab 专用: 默认分支探测(连接测试成功时也可写入) + 一次 commit(action 数组)
    async glEnsureBranch() {
        if (settings.gitlabBranch) return settings.gitlabBranch;
        try {
            const base = (settings.server || '').replace(/\/$/, '');
            const p = await (await fetch(`${base}/projects/${encodeURIComponent(`${settings.owner}/${settings.repo}`)}`, { headers: this.auth() })).json();
            settings.gitlabBranch = p.default_branch || 'main';
            saveSettingsDebounced();
        } catch { settings.gitlabBranch = 'main'; }
        return settings.gitlabBranch;
    },
    async glCommit(actions, message) {
        const base = (settings.server || '').replace(/\/$/, '');
        const branch = await this.glEnsureBranch();
        const r = await fetch(`${base}/projects/${encodeURIComponent(`${settings.owner}/${settings.repo}`)}/repository/commits`, {
            method: 'POST', headers: this.auth(), body: JSON.stringify({ branch, commit_message: message || 'sync', actions }),
        });
        if (!r.ok) throw new Error('GitLab写入失败 HTTP ' + r.status + ' ' + (await r.text()).slice(0, 90));
        return r.json();
    },
    // 写文本文件；sha 提供→PUT更新，否则POST创建
    async putText(path, content, sha, message) {
        // GitLab: contents PUT 实测一律 404(平台行为), 写操作必须走 commits API(create/update 自动建父目录)
        if (this.isGitlab()) {
            await this.glCommit([{ action: sha ? 'update' : 'create', file_path: path, content }], message || `sync ${path}`);
            const g = await this.getText(path).catch(() => null);
            return g && g.sha ? g.sha : undefined;
        }
        const body = { content: b64Encode(content), message: message || `sync ${path}` };
        if (sha) body.sha = sha;
        // ⚠️ GitHub/GitLab 的 contents 端点【没有 POST 创建路由】(新建/更新都是 PUT); Gitee 才是 POST=创建、PUT=更新
        const method = (this.isGithub() || sha) ? 'PUT' : 'POST';
        const r = await this.req(path, { method, body: JSON.stringify(body), noRetry: true });
        const j = await r.json();
        return j && j.content ? j.content.sha : undefined;
    },
    // 写二进制(角色卡PNG)
    async putBase64(path, b64, sha, message) {
        if (this.isGitlab()) {
            await this.glCommit([{ action: sha ? 'update' : 'create', file_path: path, content: b64, encoding: 'base64' }], message || `sync ${path}`);
            const g = await this.getBase64(path).catch(() => null);
            return g && g.sha ? g.sha : undefined;
        }
        const body = { content: b64, message: message || `sync ${path}`, encoding: 'base64' };
        if (sha) body.sha = sha;
        // ⚠️ GitHub 的 contents 端点【没有 POST 创建路由】(新建/更新都是 PUT); Gitee 才是 POST=创建、PUT=更新
        const method = (this.isGithub() || sha) ? 'PUT' : 'POST';
        const r = await this.req(path, { method, body: JSON.stringify(body), noRetry: true });
        const j = await r.json();
        return j && j.content ? j.content.sha : undefined;
    },
    // 列目录：读某目录(如 sync) → 返回其子项 name 数组(仅 dir 类型的 name，即角色名)
    async listDir(path) {
        const arr = await this.listEntries(path);
        return arr.filter((x) => x.type === 'dir').map((x) => x.name);
    },
    // 列目录原始条目（含 file 和 dir，含 sha），用于删除/递归; GitLab 没有 contents 目录列举 → repository/tree(分页)
    async listEntries(path) {
        if (this.isGitlab()) {
            const base = (settings.server || '').replace(/\/$/, '');
            const proj = encodeURIComponent(`${settings.owner}/${settings.repo}`);
            const enc = String(path).length ? '&path=' + String(path).split('/').map(encodeURIComponent).join('/') : '';
            const all = [];
            try {
                for (let page = 1; page <= 100; page++) {
                    const r = await fetch(`${base}/projects/${proj}/repository/tree?per_page=100&page=${page}${enc}`, { headers: this.auth(), cache: 'no-store' });
                    if (r.status === 404) return [];
                    if (!r.ok) throw new Error('HTTP ' + r.status);
                    const j = await r.json();
                    if (!Array.isArray(j)) return [];
                    const seg = j.map((x) => ({ name: x.name, path: x.path, type: x.type === 'tree' ? 'dir' : 'file', sha: x.id || '' }));
                    all.push(...seg);
                    if (j.length < 100) break;
                }
            } catch (e) { throw e; }
            return all;
        }
        const r = await this.req(path);
        if (r.status === 404) return [];
        const j = await r.json();
        return Array.isArray(j) ? j : [];
    },
    // 递归列出某目录下所有【文件】的 {path, sha}
    async listAllFiles(path, acc = []) {
        const entries = await this.listEntries(path);
        for (const e of entries) {
            if (e.type === 'file') acc.push({ path: e.path, sha: e.sha });
            else if (e.type === 'dir') await this.listAllFiles(e.path, acc);
        }
        return acc;
    },
    // 删除单个文件（Gitee v5: DELETE contents/{path}, body {sha, message}; GitLab: commits delete 需父目录存在）
    async deleteFile(path, sha, message = 'delete') {
        if (this.isGitlab()) {
            await this.glCommit([{ action: 'delete', file_path: path }], message);
            return;
        }
        const r = await this.req(path, { method: 'DELETE', body: JSON.stringify({ sha, message, access_token: settings.token }), noRetry: true });
    },
    // 版本历史（防丢恢复）；GitLab 接口不同 → 返回空
    async history(path) {
        if (this.isGitlab()) return [];
        const r = await fetch(`${this.base}/repos/${settings.owner}/${settings.repo}/commits/${encodeURIComponent(path)}?access_token=${encodeURIComponent(settings.token)}`, { headers: this.auth() });
        if (!r.ok) return [];
        return (await r.json()).history || [];
    },
    // 连接测试
    async test() {
        const r = await fetch(`${this.base}${this.isGitlab() ? '/user?private_token=' : '/user?access_token='}${encodeURIComponent(settings.token)}`, { headers: this.auth() });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const u = await r.json();
        return u.login || u.username || 'OK';
    },
};

// ===================== 数据采集 =====================

function ctx() { return getContext(); }

// 当前角色名（无则 null）
function currentCharName() {
    const c = ctx();
    if (c.groupId) return null; // 群聊暂不支持角色级整包
    if (c.characterId === undefined || c.characterId < 0) return null;
    return c.characters[c.characterId]?.name;
}

// 当前角色绑定的外部世界书名（无则 null/空）
function currentWorldName() {
    const c = ctx();
    if (c.characterId === undefined || c.characterId < 0) return null;
    return c.characters[c.characterId]?.data?.extensions?.world || '';
}

// 取世界书内容（结构化数据→json 文本）；用 ST 官方 loadWorldInfo 按名加载
async function getWorldContent(name) {
    if (!name) return null;
    try {
        const w = await loadWorldInfo(name);
        if (w == null) return null;
        return JSON.stringify(w);
    } catch {
        return null;
    }
}

// 取完整角色卡 PNG base64（走 ST 官方 export 接口）
// ── 角色卡大文件分块存储 ──
// 小卡(≤~700KB 原始)→单文件 character.png(与旧格式兼容); 大卡→ base64 切片存 <名>.parts/part-N + manifest
// 目的: 绕过 GitHub contents API 单文件 1MB 限制(Gitee 同样适用, 减少大请求)
const CARD_CHUNK_CHARS = 640 * 1024; // base64 字符数/块(API body 限额内)

async function __cardPutSmart(dir, b64) {
    const singlePath = `${dir}/character.png`;
    if (b64.length <= CARD_CHUNK_CHARS) {
        const prev = await Gitee.getBase64(singlePath).catch(() => null);
        const sha = await Gitee.putBase64(singlePath, b64, prev && prev.sha ? prev.sha : undefined, 'sync card');
        return { mode: 'single', sha };
    }
    // 大卡 → 分块: 清理旧 manifest 后逐块 PUT + 写新 manifest
    const partsDir = `${dir}/character.png.parts`;
    let oldParts = [];
    try {
        (await __cachedListEntries(partsDir)).filter(e => e.type === 'file').forEach(e => oldParts.push({ path: e.path, sha: e.sha }));
    } catch { }
    const total = Math.ceil(b64.length / CARD_CHUNK_CHARS);
    for (let i = 0; i < total; i++) {
        const slicePath = `${partsDir}/part-${String(i).padStart(4, '0')}`;
        const reuse = oldParts.find(x => x.path === slicePath);
        await Gitee.putText(slicePath, b64.slice(i * CARD_CHUNK_CHARS, (i + 1) * CARD_CHUNK_CHARS), reuse ? reuse.sha : undefined, `card chunk ${i}/${total}`);
    }
    // 多余的旧块删除
    for (const x of oldParts) {
        const idx = parseInt(String(x.path).split('part-')[1], 10);
        if (!isNaN(idx) && idx >= total) { try { await Gitee.deleteFile(x.path, x.sha, 'chunk cleanup'); } catch { } }
    }
    const man = JSON.stringify({ chunks: total, chars: b64.length });
    const manC = await Gitee.getText(`${dir}/character.png.manifest.json`).catch(() => null);
    await Gitee.putText(`${dir}/character.png.manifest.json`, man, manC ? manC.sha : undefined, 'card chunked manifest');
    return { mode: 'chunked', chunks: total };
}

async function __cardGetSmart(dir) {
    // 分块优先(manifest 存在即分块), 否则单文件
    const manC = await Gitee.getText(`${dir}/character.png.manifest.json`).catch(() => null);
    if (manC && manC.content) {
        const man = JSON.parse(manC.content);
        let b64 = '';
        for (let i = 0; i < man.chunks; i++) {
            const pc = await Gitee.getText(`${dir}/character.png.parts/part-${String(i).padStart(4, '0')}`);
            if (!pc) throw new Error(`角色卡分块缺失 part-${i}(上传不完整?)`);
            b64 += pc.content;
        }
        return { b64 };
    }
    const single = await Gitee.getBase64(`${dir}/character.png`);
    return single; // null 或 {b64, sha}
}

async function getCharacterCardB64(charName) {
    const avatar = getAvatarFor(charName);
    if (!avatar) throw new Error('无法解析角色头像，找不到角色「' + charName + '」');
    const format = 'png';
    const r = await fetch('/api/characters/export', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ format, avatar_url: avatar }),
    });
    if (!r.ok) throw new Error('导出角色卡失败 HTTP ' + r.status);
    const blob = await r.blob();
    return await blobToBase64(blob);
}

function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(',')[1]); // 去掉 data: 前缀
        reader.onerror = reject;
        reader.readAsDataURL(blob);
    });
}

// 当前聊天文件名
function currentChatFileName() {
    const id = ctx().chatId || 'chat';
    return String(id).replace(/\.jsonl$/, '') + '.jsonl';
}

// ===================== 聊天云端分段存储（2026-08-23 用户拍板：规避单文件100MB上限 + 变更段增量上传） =====================
// 格式：长聊天(≥SEG_MIN_MSGS 楼)拆成多个 part 文件 + 一个 manifest 清单：
//   sync/<角色>/chats/<名>.manifest.json = {v:1, header:首行header对象, parts:[{file, count, sha}], total, mtime}
//   sync/<角色>/chats/<名>.p001.jsonl    = 纯消息行(无 header)
// 短聊天仍存整文件(legacy)；读取时 manifest 存在则拼装、否则按整文件读 → 新旧格式共存可读。
// 上传：按段 sha 比对只传变化的段；同时清理失效旧段与 legacy 整文件。
const SEG_MIN_MSGS = 200;   // 低于此楼数不分段（避免小聊天文件爆炸）
const SEG_PART_SIZE = 100;  // (保留兼容)固定每段楼数 —— 仅老数据/单测用, 生产已改按大小自适应
const SEG_TARGET_BYTES = 1024 * 1024; // 每段目标大小 ~1MB(自适应切段): 重楼层自动少几楼一段/轻楼层自动多几楼一段; 续写只重传 ≤1MB 的末段, 整条取回请求数=大小MB数
// ── 纯函数（单测覆盖）──
function manifestPathOf(chatPath) { return String(chatPath).replace(/\.jsonl$/i, '.manifest.json'); }
function partFileName(stem, i) { return `${stem}.p${String(i + 1).padStart(3, '0')}.jsonl`; }
function splitChatSegments(messages, partSize) {
    const out = [];
    for (let i = 0; i < (messages || []).length; i += partSize) out.push(messages.slice(i, i + partSize));
    return out;
}
// 按目标大小自适应切段(确定性: 同样内容永远同样切法): 攒楼层直到再加一段就超过 target 就切;
// 单行超 target 也自成一段(保证至少1行)。字节长度用 UTF-8 TextEncoder —— 与云端存取的文本字节一致。
function splitChatSegmentsBySize(lines, targetBytes) {
    const enc = new TextEncoder();
    const out = [];
    let cur = [], curLen = 0;
    for (const line of (lines || [])) {
        const len = enc.encode(String(line)).length + 1; // +1 换行符
        if (cur.length && curLen + len > targetBytes) { out.push(cur); cur = []; curLen = 0; }
        cur.push(String(line)); curLen += len;
    }
    if (cur.length) out.push(cur);
    return out;
}
function assembleChatText(headerObj, partTexts) {
    const headerLine = (headerObj !== undefined && headerObj !== null) ? JSON.stringify(headerObj) : '';
    return (headerLine ? headerLine + '\n' : '') + partTexts.map((t) => String(t).replace(/\s+$/, '')).filter(Boolean).join('\n') + '\n';
}
function diffChatManifestParts(newParts, cloudManifest) {
    // {uploadIdx:需重传的段下标(按sha比对), removeFiles:云端已失效的段文件(不在新清单里)}
    const cloudByFile = new Map((((cloudManifest && cloudManifest.parts) || []).map((x) => [x.file, x.sha])));
    const uploadIdx = [];
    newParts.forEach((np, i) => { if (cloudByFile.get(np.file) !== np.sha) uploadIdx.push(i); });
    const newFiles = new Set(newParts.map((x) => x.file));
    const removeFiles = [...cloudByFile.keys()].filter((f) => !newFiles.has(f));
    return { uploadIdx, removeFiles };
}
// ── 异步存取（推/拉路径统一走这里，对上层透明：仍是"整条聊天的 jsonl 文本"） ──
async function sha1Text(text) {
    const bytes = new TextEncoder().encode(String(text));
    const digest = await crypto.subtle.digest('SHA-1', bytes);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
// 读云端一条聊天 → {content:整条jsonl文本, sha:manifest sha(分段)/文件sha(legacy)} 或 null
async function getCloudChat(chatPath) {
    const mf = await Gitee.getText(manifestPathOf(chatPath)).catch(() => null);
    if (mf && mf.content) {
        let m = null; try { m = JSON.parse(mf.content); } catch { }
        if (m && Array.isArray(m.parts) && m.parts.length) {
            const texts = await Promise.all(m.parts.map((pt) => Gitee.getText(pt.file).then((c) => (c && c.content) || '').catch(() => '')));
            // v2: header 在独立 meta 文件; v1: 内嵌(兼容旧数据)
            let headerObj = m.header !== undefined ? m.header : null;
            if (m.v >= 2 && m.metaFile) {
                const meta = await Gitee.getText(chatPath.slice(0, chatPath.lastIndexOf('/') + 1) + m.metaFile).catch(() => null);
                if (meta && meta.content) { try { headerObj = JSON.parse(meta.content); } catch { } }
            }
            return { content: assembleChatText(headerObj, texts), sha: mf.sha };
        }
    }
    return (await Gitee.getText(chatPath).catch(() => null)) || null;
}
// 写云端一条聊天（jsonlText=整条文本, message=提交说明）。返回 manifest/文件 sha。
async function putCloudChat(chatPath, jsonlText, message) {
    const lines = String(jsonlText).split('\n').filter((l) => l.trim());
    let headerObj = null; const msgLines = [];
    lines.forEach((l, idx) => {
        if (idx === 0) {
            try { const o = JSON.parse(l); if (o && typeof o === 'object' && !('mes' in o)) { headerObj = o; return; } } catch { }
        }
        msgLines.push(l);
    });
    const legacy = await Gitee.getText(chatPath).catch(() => null);
    if (msgLines.length < SEG_MIN_MSGS) {
        // 短聊天：整文件存储 + 清掉可能存在的旧分段副产物
        const sha = await Gitee.putText(chatPath, jsonlText, legacy?.sha, message);
        await __cleanupSegmentFiles(chatPath, null);
        return sha;
    }
    const stem = String(chatPath).replace(/\.jsonl$/i, '').split('/').pop();
    const dir = chatPath.slice(0, chatPath.lastIndexOf('/') + 1);
    const segs = splitChatSegmentsBySize(msgLines, SEG_TARGET_BYTES); // 按大小自适应切段
    const parts = [];
    let startFloor = 0;
    for (let i = 0; i < segs.length; i++) {
        parts.push({ file: dir + partFileName(stem, i), start: startFloor, count: segs[i].length, sha: await sha1Text(segs[i].join('\n')) });
        startFloor += segs[i].length;
    }
    const cloudMf = await Gitee.getText(manifestPathOf(chatPath)).catch(() => null);
    let cloudManifest = null; try { cloudManifest = cloudMf ? JSON.parse(cloudMf.content) : null; } catch { }
    const diff = diffChatManifestParts(parts, cloudManifest);
    for (const i of diff.uploadIdx) { // 写仓恒串行
        const text = segs[i].join('\n');
        await Gitee.putText(parts[i].file, text, (await Gitee.getText(parts[i].file).catch(() => null))?.sha, message + ` part ${i + 1}`);
    }
    // 清失效旧段；全部段写成功后再动 manifest 和 legacy
    await __cleanupSegmentFiles(chatPath, parts);
    if (legacy) await Gitee.deleteFile(chatPath, legacy.sha, 'remove legacy whole file (segmented)');
    // v2 清单瘦身: header(含 chat_metadata, 可达数百KB)挪到独立 meta 文件, 只在自身指纹变化时才重传 ——
    // 之前 v1 把 header 内嵌清单, 每次推送都要重传整个大清单
    const metaPath = dir + stem + '.meta.json';
    const metaText = JSON.stringify(headerObj);
    const metaSha = await sha1Text(metaText);
    if (!(cloudManifest && cloudManifest.v >= 2 && cloudManifest.metaSha === metaSha)) {
        await Gitee.putText(metaPath, metaText, (await Gitee.getText(metaPath).catch(() => null))?.sha, message + ' (meta)');
    }
    const manifest = { v: 3, parts, total: msgLines.length, metaFile: stem + '.meta.json', metaSha, mtime: new Date().toISOString() }; // v3: 每段带 start 起始楼层号
    return Gitee.putText(manifestPathOf(chatPath), JSON.stringify(manifest, null, 2), cloudMf?.sha, message + ' (manifest)');
}
// 部分下载规划(纯比对, 单测覆盖): 本地楼层按同规则切段算指纹 vs 云端清单逐段比
// → {reuseIdx:可用本地内容的段(0下载), downloadIdx:需下载的段}
async function planPartialDownload(localMsgLines, cloudManifest, partSize) {
    // v3: 按清单记录的 start/count 坐标切本地内容比对 —— 不依赖任何"重新切段规则",
    // 上传端怎么切(固定楼数/按大小自适应/边界变化)都不影响识别; 老清单无 start → 全下载(安全)
    const lines = localMsgLines || [];
    const reuseIdx = [], downloadIdx = [];
    const localSegs = [];
    for (let i = 0; i < cloudManifest.parts.length; i++) {
        const pt = cloudManifest.parts[i];
        if (pt.start === undefined || pt.start + pt.count > lines.length) { downloadIdx.push(i); localSegs.push(null); continue; }
        const seg = lines.slice(pt.start, pt.start + pt.count);
        const localSha = await sha1Text(seg.join('\n'));
        if (localSha === pt.sha) { reuseIdx.push(i); localSegs.push(seg); }
        else { downloadIdx.push(i); localSegs.push(null); }
    }
    return { reuseIdx, downloadIdx, localSegs };
}
// 智能取回一条聊天: 传入本地楼层 → 只下载指纹不同的段; 每段下载后重算指纹核对清单,
// 任一段校验失败(重试一次仍坏) → 该聊天整体回退全量下载(宁可慢不可错)。
// 返回 {content, sha, partial:{reused, downloaded, fallback}}
async function getCloudChatSmart(chatPath, localMsgLines) {
    const fallbackAll = async (why) => {
        const full = await getCloudChat(chatPath);
        if (!full) return null;
        return { ...full, partial: { reused: 0, downloaded: 0, fallback: true, why } };
    };
    const mf = await Gitee.getText(manifestPathOf(chatPath)).catch(() => null);
    if (!mf || !mf.content) return fallbackAll('no manifest'); // legacy 整文件 → 全量(本来就只有一个文件)
    let m = null; try { m = JSON.parse(mf.content); } catch { }
    if (!m || !Array.isArray(m.parts) || !m.parts.length) return fallbackAll('bad manifest');
    // 归一化: 本地可能是消息对象数组(readLocalChatMsgs) → 转回与云端段一致的 jsonl 文本行
    // (若序列化与云端原始行有字节差, 指纹对不上只会多下载, 不会错——校验层兜底)
    const normLines = (localMsgLines || []).map((x) => (typeof x === 'string' ? x : JSON.stringify(x)));
    const plan = await planPartialDownload(normLines, m, SEG_PART_SIZE);
    const partTexts = new Array(m.parts.length).fill('');
    for (const i of plan.reuseIdx) partTexts[i] = plan.localSegs[i].join('\n');
    for (const i of plan.downloadIdx) {
        let ok = false;
        for (let attempt = 0; attempt < 2 && !ok; attempt++) { // 坏段重试一次
            const c = await Gitee.getText(m.parts[i].file).catch(() => null);
            if (c && c.content && (await sha1Text(c.content)) === m.parts[i].sha) {
                partTexts[i] = c.content; ok = true;
            }
        }
        if (!ok) return fallbackAll('part sha mismatch @' + i); // 指纹对不上 → 整体回退全量
    }
    // 合并路径只需要消息行; header 传 null(parseJsonlMessages 会跳过无 mes 的首行, pullMerge 侧也一样)
    return { content: assembleChatText(null, partTexts), sha: mf.sha, partial: { reused: plan.reuseIdx.length, downloaded: plan.downloadIdx.length } };
}

// 清理分段副产物。keepParts=保留的有效段(null=全删, 短聊天降级时)；manifest 由调用方重写或这里删除
async function __cleanupSegmentFiles(chatPath, keepParts) {
    try {
        const dir = chatPath.slice(0, chatPath.lastIndexOf('/') + 1);
        const stem = String(chatPath).replace(/\.jsonl$/i, '').split('/').pop();
        const entries = await Gitee.listEntries(dir);
        const keep = new Set((keepParts || []).map((x) => x.file.split('/').pop()));
        for (const e of entries) {
            if (e.type !== 'file') continue;
            const isPart = e.name.startsWith(stem + '.p') && e.name.endsWith('.jsonl');
            const isMf = e.name === stem + '.manifest.json';
            if (!isPart && !isMf) continue;
            if (keepParts && isPart && keep.has(e.name)) continue;
            if (keepParts && isMf) continue; // manifest 由 putCloudChat 重写
            if (keepParts && e.name === stem + '.meta.json') continue; // 头部元数据文件由 putCloudChat 按指纹决定是否重传
            await Gitee.deleteFile(e.path, e.sha, 'clean segment file ' + e.name);
        }
    } catch (e) { console.warn('[chat-sync] 清理分段文件失败', e); }
}

// ===================== 同步身份映射（收敛核心） =====================
// 导入(importCharacterChat)总会把聊天重命名成 `角色名 - <时间戳> imported.jsonl`（ST/TT 官方端点都这样），
// 导致「同一个逻辑聊天」每次同步都换个文件名 → 双向同步每轮都新建文件、无限复制、永不收敛。
// 修法：维护 syncMap[charName] = { 云路径: 本地导入后的真实文件名 }，推/拉都按这个映射回同一个云路径。
function syncMapFor(charName) {
    if (!settings.syncMap) settings.syncMap = {};
    if (!settings.syncMap[charName]) settings.syncMap[charName] = {};
    return settings.syncMap[charName];
}
// 云路径 → 本地文件名（拉取时记录）
function localNameOf(charName, cloudPath) {
    return syncMapFor(charName)[cloudPath];
}
function setLocalName(charName, cloudPath, localName) {
    if (!localName) return;
    syncMapFor(charName)[cloudPath] = localName;
    saveSettingsDebounced();
}
// 本地文件名 → 云路径（推送时反查；无映射返回 null）
function cloudPathOfLocal(charName, localName) {
    const map = syncMapFor(charName);
    for (const [p, ln] of Object.entries(map)) {
        if (String(ln || '').toLowerCase() === String(localName || '').toLowerCase()) return p;
    }
    return null;
}
// 给定本地聊天文件名集合，返回「需推送的 (本地名, 云路径)」列表：
//   - 已映射的 → 回写到原云路径（不新建）
//   - 未映射/新本地聊天 → 用本地名生成新云路径
function planPushTargets(charName, localFileNames) {
    const map = syncMapFor(charName);
    const plans = [];
    const seenPaths = new Set();
    for (const ln of localFileNames) {
        const existing = cloudPathOfLocal(charName, ln);
        const p = existing || `sync/${charName}/chats/${ln.replace(/[\\/\\\\]/g, '_')}`;
        if (existing) {
            // 已映射 → 回写原路径（覆盖），同步记忆
            if (!seenPaths.has(p)) { plans.push({ localName: ln, path: p, mapped: true }); seenPaths.add(p); }
        } else {
            // 新聊天 → 建立映射
            plans.push({ localName: ln, path: p, mapped: false });
            seenPaths.add(p);
        }
    }
    return plans;
}

// ===================== 角色级同步 =====================

// 世界书上传决策（纯函数, 便于单测; 返回 {action:'upload'|'skip'|'skipCloudEdited', cloudSha?}）
//  - 云端无 → upload (创建)
//  - 本地内容 === 云端内容 → skip (已同步, 不重写)
//  - 云端在上次同步后被另一端改过(rememberSha !== cloud.sha) → skipCloudEdited (不覆盖更新的云端)
//  - 否则(本地新改) → upload (覆盖)
// cloudObj: {content, sha} 即 Gitee.getText 的返回值
function decideWorldUpload(localContent, cloudObj, rememberSha) {
    if (cloudObj == null) return { action: 'upload' };
    const cloudContent = cloudObj.content;
    const cloudSha = cloudObj.sha;
    if (String(localContent) === String(cloudContent)) return { action: 'skip' };
    if (rememberSha && rememberSha !== cloudSha) return { action: 'skipCloudEdited' };
    return { action: 'upload' };
}

// 把一个角色整包推到云端（角色卡 + 绑定世界书）
// 计算 git blob sha1（与 Gitee contents API 返回的 sha 同算法）：sha1("blob <字节数>\0" + 内容)
// 用途：本地算指纹和云端 sha 比对 → 角色卡没变就不重新上传几 MB 的 PNG
async function gitBlobSha(bytes) {
    const header = new TextEncoder().encode(`blob ${bytes.length}\0`);
    const merged = new Uint8Array(header.length + bytes.length);
    merged.set(header, 0); merged.set(bytes, header.length);
    const digest = await crypto.subtle.digest('SHA-1', merged);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
async function exportCharacter(charName, worldName) {
    const base = `sync/${charName}`;
    const cardPath = `${base}/character.png`;
    // 卡增量（2026-08-22）：本地算 blob sha vs 云端目录列表 sha（仅元数据，不下载 PNG）
    // —— 一致则跳过上传；不同才传；上传用 putBase64 返回的新 sha 记忆，不再多下载一次
    const cardB64 = await getCharacterCardB64(charName);
    const bin = atob(String(cardB64).replace(/\s/g, ''));
    const cardBytes = new Uint8Array(bin.length);
    for (let j = 0; j < bin.length; j++) cardBytes[j] = bin.charCodeAt(j);
    const localCardSha = await gitBlobSha(cardBytes);
    let cloudCardSha = null;
    try { for (const e of await Gitee.listEntries(base)) if (e.type === 'file' && e.name === 'character.png') cloudCardSha = e.sha; } catch { }
    if (!cloudCardSha || cloudCardSha !== localCardSha) {
        // 智能写卡: 小卡单文件 / 大卡分块(绕 GitHub 1MB)
        await __cardPutSmart(base, cardB64.replace(/\s/g, ''));
        settings.lastCloudSha[cardPath] = localCardSha;
    } else {
        settings.lastCloudSha[cardPath] = cloudCardSha; // 卡没变 → 不上传（之前每次推送都重传几MB PNG）
    }

    if (worldName) {
        const wc = await getWorldContent(worldName);
        if (wc) {
            const wp = `${base}/world.json`;
            const wCloud = await Gitee.getText(wp);
            const rememberSha = settings.lastCloudSha ? settings.lastCloudSha[wp] : undefined;
            const dec = decideWorldUpload(wc, wCloud, rememberSha);
            if (dec.action === 'upload') {
                await Gitee.putText(wp, wc, wCloud?.sha, `sync world ${worldName}`);
                settings.lastCloudSha[wp] = (await Gitee.getText(wp)).sha;
                console.log(`[chat-sync] 世界书「${worldName}」已上传云端`);
            } else if (dec.action === 'skip') {
                console.log(`[chat-sync] 世界书「${worldName}」已与云端一致, 跳过`);
                settings.lastCloudSha[wp] = wCloud.sha;
            } else { // skipCloudEdited
                console.warn(`[chat-sync] 世界书「${worldName}」云端在上次同步后已被修改, 跳过覆盖(保留云端更新版)`);
            }
        }
    }
    saveSettingsDebounced();
    return true;
}

// 取角色全部聊天列表（ST 官方接口；last_mes = 磁盘修改毫秒时间戳，用作增量粗筛）
async function getCharChatFileNames(charName) {
    const avatar = getAvatarFor(charName);
    if (!avatar) return [];
    const r = await fetch('/api/characters/chats', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ avatar_url: avatar }),
    });
    if (!r.ok) throw new Error('获取聊天列表失败 HTTP ' + r.status);
    const chats = Object.values(await r.json());
    return (Array.isArray(chats) ? chats : [])
        .filter((x) => x && typeof x.file_name === 'string')
        .map((x) => ({ file_name: x.file_name, mtime: x.last_mes }));
}

// 按角色名解析 avatar（批量操作任意角色时不依赖「当前打开的 characterId」）
function getAvatarFor(charName) {
    const c = ctx();
    if (c.characters && Array.isArray(c.characters)) {
        // 优先按姓名精确匹配
        const hit = c.characters.find((x) => x && x.name === charName && x.avatar);
        if (hit) return String(hit.avatar).replace(/\.png$/i, '') + '.png';
        // 若传入的正好是当前角色，退回 characterId
        const cur = c.characters?.[c.characterId];
        if (cur && cur.name === charName && cur.avatar) return String(cur.avatar).replace(/\.png$/i, '') + '.png';
    }
    return '';
}

// 读单个聊天内容并转成标准 ST jsonl（保留完整字段，避免字段丢失）
// 注意：不要只挑少数字段重序列化——ST/TT 的 jsonl 首行 header 带 chat_metadata/user_name/character_name，
// 消息行带 name/is_user/send_date/mes/swipes/swipe_id/extra/chat_metadata 等。这里把后端返回的消息对象
// 按原字段 json 化，尽量保真（不再丢 chat_metadata / swipe_info / disable_date / bookmark 等）。
async function getChatContent(fileName, charName) {
    const avatar = getAvatarFor(charName || '');
    const name = charName || (ctx().characters?.[ctx().characterId]?.name) || '';
    const r = await fetch('/api/chats/get', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({
            ch_name: name,
            file_name: fileName.replace(/\.jsonl$/, ''),
            avatar_url: avatar,
        }),
    });
    if (!r.ok) throw new Error(`读聊天 ${fileName} 失败 HTTP ${r.status}`);
    const data = await r.json();
    if (!Array.isArray(data)) return '';
    // ST /api/chats/get 返回数组：首个是 header（含 chat_metadata/user_name/character_name），其余是消息。
    const headerObj = data[0] && typeof data[0] === 'object' ? data[0] : {};
    const messages = data.slice(1).filter((m) => m && typeof m === 'object' && Object.keys(m).length > 0
        && (m.mes !== undefined));
    const header = {
        user_name: 'unused',
        character_name: 'unused',
        create_date: headerObj.create_date || new Date().toISOString(),
        last_mes: headerObj.last_mes || new Date().toISOString(),
        chat_metadata: headerObj.chat_metadata || {},
    };
    // 保序列化所有消息字段，少丢数据（ST 自己导出也带这些）
    const lines = messages.map((m) => JSON.stringify({
        name: m.name, is_user: m.is_user, is_name: m.is_name,
        create_date: m.create_date, send_date: m.send_date, mes: m.mes,
        extra: m.extra, swipes: m.swipes, swipe_id: m.swipe_id,
        disable_date: m.disable_date, bookmark: m.bookmark,
        force_avatar: m.force_avatar, original_avatar: m.original_avatar,
        chat_metadata: m.chat_metadata,
    }));
    return JSON.stringify(header) + '\n' + lines.join('\n');
}

// 上传一个角色的全部聊天（收敛：按 syncMap 回写同一云路径，不新建重复文件）
// 增量：mtime 粗筛 + sha 精确；身份：云路径↔本地名通过 syncMap 绑定。
// preDecisions: 锁外预扫(Map<本地名, decision>)；传了则不现场弹窗(弹窗已在 preResolveUploadConflicts 完成)
// 批量并发：同角色内各聊天写盘路径独立(不同云文件+各自sha乐观锁)，可分批并行；但 Gitee 单仓写入本身串行——
// 实测并发>1 时同一仓并行 POST/PUT 会大量返回 400 "文件新建失败"(conc6≈50%失败,conc2≈75%成功,conc1=100%成功)。
// 因此强制串行(1=最可靠)，杜绝"该上传却失败"。
/** 并发写 Gitee 保证：读/比对阶段并行(快)，实际写仓阶段严格串行(防 Gitee 单仓并发写 400 "文件新建失败"竞态)。 */
const UPLOAD_CONCURRENCY = 1; // 保留：写仓串行的窗口大小(恒1)。实测并发写必踩400 → 阶段B按 plan 顺序一个接一个 putText。
// 单聊天「读+冲突决策+算好要写文本」→ 返回 job 或 null(跳过)。被 exportChats 阶段A 并行(或 __benchSerial 时串行)调用。
// 只读不写; 跳过/新增只记 skipped 或返回 job 由阶段B串行写。
async function readJobForPlan(plan, chatItems, charName, preDecisions, batchGuard, skipped) {
    const item = chatItems.find((x) => x.file_name === plan.localName);
    if (!item) return null;
    const p = plan.path;
    const chatText = await getChatContent(item.file_name, charName);
    if (!chatText) return null;
    const cloud = await getCloudChat(p); // 分段感知: manifest 存在则拼装
    if (cloud) {
        const localMsgs = parseJsonlMessages(chatText);
        const cloudMsgs = parseJsonlMessages(cloud.content || '');
        // 优先用锁外预扫的决策; 未预扫则用 batchGuard(批内不弹窗, 一律照 'overwrite' 覆盖) —— 并行阶段绝不现场弹多个窗
        const decision = preDecisions ? (preDecisions.get(plan.localName) ?? 'skip') : await resolveUploadConflict(localMsgs, cloudMsgs, plan.localName, batchGuard);
        if (decision === 'skip' || decision === 'cancel') {
            if (decision === 'skip' && !plan.mapped) setLocalName(charName, p, plan.localName);
            skipped.push(plan.localName);
            return null;
        }
        const headerObj = parseHeader(cloud.content);
        return { plan, p, text: buildCloudUploadText(localMsgs, cloudMsgs, headerObj, decision), cloudSha: cloud.sha, cloud, decision };
    }
    return { plan, p, text: chatText, cloudSha: undefined, cloud: null, decision: 'new' };
}
async function exportChats(charName, chatItems, preDecisions = null) {
    const uploaded = [];
    const skipped = [];
    // 并发写盘时绝不现场弹窗（避免多窗叠加）：无 preDecisions 的差异一律按「覆盖」处理。
    // 若需要用户选择，应由 lock 外 preResolveUploadConflicts 的「全部覆盖/全部合并」统一决定存进 preDecisions。
    const batchGuard = { applyAll: true, decision: 'overwrite' };
    // 1) 规划推送目标：已映射的本地聊天回写原云路径；新本地聊天建新云路径并绑映射
    const plans = planPushTargets(charName, chatItems.map((x) => x.file_name));
    let doneCount = 0;
    // ── 阶段A：并行「读+比对+算好要写的内容」(网络读全部并行, 快) ──
    //    只做只读操作(getChatContent/Gitee.getText)与决策, 绝不在并行阶段写 Gitee, 避免并发写400竞态。
    //    产出 jobs[]（保持 plan 顺序）供阶段B串行写。
    //    ⚠️ settings.__benchSerial=true 时降级为【纯串行】(读+写逐条顺序完成)——仅供并发基准对比用, 默认关。
    const benchSerial = Boolean(settings.__benchSerial);
    const jobs = benchSerial
        ? await (async () => {
            const out = [];
            for (const plan of plans) out.push(await readJobForPlan(plan, chatItems, charName, preDecisions, batchGuard, skipped));
            return out;
        })()
        : await Promise.all(plans.map(async (plan) => readJobForPlan(plan, chatItems, charName, preDecisions, batchGuard, skipped)));
    // ── 阶段B：串行写 Gitee（严格保序 + 单写不 400），每个聊天先处理「另行保存」再覆盖主 ──
    for (const job of jobs) {
        if (!job) continue;
        const { plan, p, text, cloudSha, cloud, decision } = job;
        if (plans.length > 1) { setStatus(`正在同步角色「${charName}」聊天：${++doneCount}/${plans.length}…`); showBusy(doneCount, plans.length, `上传 ${charName}`); }
        // save_elsewhere → 先【另行保存】：把云端当前内容另存到新云端路径(两边都留)，再覆盖为主
        if (decision === 'save_elsewhere' && cloud) {
            const backupPath = p.replace(/\\.jsonl$/i, `-另行保存-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.jsonl`);
            try {
                const bakCloud = await Gitee.getText(backupPath);
                await Gitee.putText(backupPath, cloud.content, bakCloud?.sha, `另行保存(上传冲突) ${plan.localName}`);
                settings.lastCloudSha[backupPath] = (await Gitee.getText(backupPath)).sha;
                setLocalName(charName, backupPath, String(backupPath).split('/').pop());
            } catch (e) { console.warn('[chat-sync] 另行保存云端旧版失败', e); }
        }
        settings.lastCloudSha[p] = (await putCloudChat(p, text, `${decision === 'save_elsewhere' ? '另行保存后覆盖' : 'sync chat'} ${plan.localName}`)) || settings.lastCloudSha[p];
        if (!plan.mapped) setLocalName(charName, p, plan.localName); // 新聊天：绑定映射
        uploaded.push(plan.localName);
    }
    // 2) 写清单（云端文件全集 = 所有映射过的云路径 + 本次新增；供拉取枚举）
    const allCloudPaths = Object.keys(syncMapFor(charName));
    const listNames = [...new Set(allCloudPaths.map((p) => p.split('/').pop()).filter(Boolean))];
    const listPath = `sync/${charName}/chat-list.json`;
    const listCloud = await Gitee.getText(listPath);
    await Gitee.putText(listPath, JSON.stringify({ files: listNames }, null, 2), listCloud?.sha, 'chat list');
    settings.lastCloudSha[listPath] = (await Gitee.getText(listPath)).sha;
    saveSettingsDebounced();
    return { uploaded, skipped };
}

// 自动同步范围分流：'chat'→只同步当前聊天；'all'→同步角色全部聊天
function syncScopeIsChat() { return settings.syncScope === 'chat'; }
async function pullAuto() {
    // 正在生成正文（用户已开始 roll）→ 放弃自动拉取，避免拉取写盘与生成写盘撞车覆盖新内容
    if (csReallyGenerating()) return;
    const charName = currentCharName();
    if (!charName) return;
    if (syncScopeIsChat()) await pullCurrentChat();
    else await pullCurrentCharacter();
}
let __csGenerating = false; // 是否正在生成正文（生成中暂缓自动上传，避免备份到半成品楼层）
// ⚠️ 2026-08-24 QA 实证: 打开带静默提示词的角色会触发 generation_started 但永不 ended(上游怪癖, ST/TT 都中)
//   → 光看标志会误锁最长15分钟(watchdog)。真生成判定 = 标志 true 且 停止按钮可见(script.js emit ENDED 的条件);
//   假开始(无停止按钮)不算在生成 → 不再误拦补楼/自动同步。
function csReallyGenerating() {
    if (!__csGenerating) return false;
    try {
        const btn = document.getElementById('mes_stop');
        return !!(btn && getComputedStyle(btn).display !== 'none');
    } catch { return __csGenerating; }
}
async function pushAuto() {
    const charName = currentCharName();
    if (!charName) return;
    // 生成正文中暂缓自动上传（用户正在让 AI 写，聊天文件是半写入状态）
    if (csReallyGenerating()) return;
    if (syncScopeIsChat()) await pushCurrentChat();
    else await pushCurrentCharacter();
}

// 同步当前角色：卡 + (世界书) + 全部聊天（增量）
// 上传角色（按角色名，不依赖「当前打开的聊天/角色」，避免批量切换污染当前会话）
// 成功返回 true；角色不存在/导出失败 → throw（上层据此计 fail，不再「假成功」）
async function pushCurrentCharacter(charName, opts = {}) {
    const name = charName || currentCharName();
    if (!name) { toastr.warning('当前没有打开的单人角色聊天，或未指定要上传的角色'); throw new Error('未指定角色'); }
    if (!getAvatarFor(name)) { const e = new Error('找不到本地角色「' + name + '」'); toastr.error(e.message); throw e; }
    // 锁外预扫上传冲突（弹窗在拿锁前完成，避免弹窗持锁卡死其他同步）：传入空 Map 供收集
    const preDecisions = new Map();
    const chatItems0 = await getCharChatFileNames(name);
    await preResolveUploadConflicts(name, chatItems0, preDecisions, (opts && opts.presetDecision) || null);
    if (!__csTryBusy()) { toastr.warning('已有同步在进行中，本次跳过，稍后再试'); return false; }
    try {
        const worldName = (name === (currentCharName() || '')) ? currentWorldName() : ((getContext().characters.find((x) => x.name === name) || {}).data?.extensions?.world || '');
        showBusy(0, 0, `上传 ${name}`);
        await exportCharacter(name, worldName);
        const chatItems = chatItems0 || await getCharChatFileNames(name);
        const { uploaded, skipped } = await exportChats(name, chatItems, preDecisions);
        const msg = `已同步角色「${name}」：卡 + ${worldName ? '世界书 + ' : ''}${uploaded.length} 个聊天已同步${skipped.length ? `，${skipped.length} 个已是最新` : ''} ✅`;
        toastr.success(msg);
        return true;
    } catch (e) {
        console.warn('[chat-sync] 上传角色失败', e);
        throw e;
    } finally { __csReleaseBusy(); }
}

// 批量上传：遍历本地所有角色，逐个按名字同步（卡+世界书+全部聊天）。不切换当前聊天/角色。
async function pushAllCharacters(skipConfirm = false, presetDecision = null) {
    // 防连点: 整批期间持锁, 进行中再点直接忽略(否则两轮循环并发推同一批角色)
    if (!__csTryBusy()) { toastr.warning('已有同步在进行中，本次忽略'); return; }
    try {
    const chars = (getContext().characters || []).filter((x) => x && x.name && !String(x.name).startsWith('Group'));
    const total = chars.length;
    if (!total) { toastr.warning('本地没有可上传的角色'); return; }
    // 防误点：全部级操作先确认一次（增量机制会跳过已最新的，不会重复刷）
    if (!await csConfirm('⚠ 上传全部角色', `将把本地 <b>${total}</b> 个角色同步到云端（内容一致的会自动跳过，不会重复上传）。<br>确定开始吗？`)) return;
    // ⚠️ 不在外层拿锁：pushCurrentCharacter 内部自己拿锁（外层再拿会全部误报"已有同步在进行中"）
    setStatus(`正在同步全部角色：0/${total}…`);
    let ok = 0, fail = 0;
    const failedNames = [];
    for (let i = 0; i < total; i++) {
        const name = chars[i].name;
        setStatus(`正在同步全部角色：${i + 1}/${total}（${name}）…`);
        showBusy(i + 1, total, `上传全部角色`);
        try {
            await pushCurrentCharacter(name, { presetDecision });
            ok++;
        } catch (e) { fail++; failedNames.push(name); console.warn('[chat-sync] 角色同步失败', name, e); setStatus(`角色「${name}」同步失败`); }
    }
    setStatus('');
    toastr.success(`全部角色同步完成：成功 ${ok}，失败 ${fail} / 共 ${total}${failedNames.length ? `（失败：${csShortList(failedNames)}）` : ''}`);
    } finally { __csReleaseBusy(); }
}

// 批量导入：遍历云端 sync/ 下所有角色，逐个整包导入（卡+世界书+全部聊天）。用于换设备迁移。
async function importAllCharacters() {
    if (!__csTryBusy()) { toastr.warning('已有同步在进行中，本次跳过，稍后再试'); return; }
    try {
    let names = [];
    try { names = await Gitee.listDir('sync'); } catch (e) { toastr.error('读取云端角色失败：' + e.message); return; }
    if (!names || !names.length) { toastr.info('云端暂无角色可导入'); return; }
    // 防误点：全部级操作先确认一次（本地已最新的会自动跳过）
    if (!await csConfirm('⚠ 导入全部云端角色', `将从云端导入 <b>${names.length}</b> 个角色（本地已有且内容一致的会自动跳过，不会重复刷）。<br>确定开始吗？`)) return;
    const total = names.length;
    setStatus(`正在导入云端角色：0/${total}…`);
    showBusy(0, total, `导入全部云端角色`);
    let ok = 0, fail = 0;
    const failedNames = [];
    for (let i = 0; i < total; i++) {
        const name = names[i];
        setStatus(`正在导入云端角色：${i + 1}/${total}（${name}）…`);
        showBusy(i + 1, total, `导入全部云端角色`);
        try { await importCharFromCloud(name, { noJump: true }); ok++; }
        catch (e) { fail++; failedNames.push(name); console.warn('[chat-sync] 导入失败', name, e); setStatus(`角色「${name}」导入失败`); }
    }
    setStatus('');
    hideBusy();
    toastr.success(`云端导入完成：成功 ${ok}，失败 ${fail} / 共 ${total}${failedNames.length ? `（失败：${failedNames.join('、')}）` : ''}`);
    } finally { __csReleaseBusy(); }
}

// 部分角色上传：只上传用户勾选的角色（逐个按名字同步，不切换当前聊天/角色）
// 支持 云端视图 场景：勾的是云端角色名 → 上传本地同名角色；本地没同名 → 记"跳过(本地无同名)"
async function pushSelectedCharacters(charNames) {
    const names = (charNames || []).filter(Boolean);
    const total = names.length;
    if (!total) { toastr.warning('未选择要上传的角色'); return; }
    setStatus(`正在上传选中角色：0/${total}…`);
    showBusy(0, total, `上传选中角色`);
    let ok = 0, fail = 0, skipLocal = 0;
    const skipReasons = []; // {name, reason}
    const failReasons = [];
    for (let i = 0; i < total; i++) {
        const name = names[i];
        setStatus(`正在上传选中角色：${i + 1}/${total}（${name}）…`);
        showBusy(i + 1, total, `上传选中角色`);
        // 本地没有这张卡（云端视图勾了云端名但本地无同名）→ 跳过并说明
        if (!getAvatarFor(name)) { skipLocal++; skipReasons.push({ name, reason: '本地无同名角色' }); continue; }
        try {
            await pushCurrentCharacter(name);
            ok++;
        } catch (e) { fail++; failReasons.push({ name, reason: (e && e.message) || String(e) }); console.warn('[chat-sync] 角色上传失败', name, e); }
    }
    setStatus('');
    hideBusy();
    const skipTxt = skipReasons.length ? `，跳过 ${skipLocal}（${csShortList(skipReasons.map(x=>`${x.name}:${x.reason}`))}）` : '';
    const failTxt = failReasons.length ? `，失败 ${fail}（${csShortList(failReasons.map(x=>`${x.name}:${x.reason}`))}）` : '';
    toastr.info(`选中角色上传：成功 ${ok} / 共 ${total}${skipTxt}${failTxt}`);
    return { ok, fail, skipLocal, skipReasons, failReasons };
}

// 部分角色导入：只导入用户勾选的云端角色（静默不跳转）
async function importSelectedCharacters(charNames) {
    if (!__csTryBusy()) { toastr.warning('已有同步在进行中，本次跳过，稍后再试'); return; }
    try {
    const names = (charNames || []).filter(Boolean);
    const total = names.length;
    if (!total) { toastr.warning('未选择要导入的云端角色'); return; }
    // 记住导入前的当前角色，批量结束后恢复（TT 批量内会用 loadImportedChat 每个角色切一次来落盘 .chat）
    let prevCharIdx = undefined;
    try { const cc = getContext(); if (cc.characterId !== undefined) prevCharIdx = cc.characterId; } catch {}
    setStatus(`正在导入选中角色：0/${total}…`);
    showBusy(0, total, `导入选中角色`);
    let ok = 0, fail = 0, skipCloud = 0;
    const failedNames = []; const failedReasons = []; const skipCloudNames = [];
    for (let i = 0; i < total; i++) {
        const name = names[i];
        setStatus(`正在导入选中角色：${i + 1}/${total}（${name}）…`);
        showBusy(i + 1, total, `导入选中角色`);
        try {
            const r = await importCharFromCloud(name, { noJump: true });
            if (r && r.skippedNoCloud) { skipCloud++; skipCloudNames.push(name); }
            else ok++;
        }
        catch (e) { fail++; failedNames.push(name); failedReasons.push({ name, reason: (e && e.message) || String(e) }); console.warn('[chat-sync] 导入失败', name, e); }
    }
    // 批量结束：恢复导入前的当前角色（避免 TT 批量落盘 .chat 时切到最后一个导入角色）
    try {
        if (prevCharIdx !== undefined && Array.isArray(getContext().characters) && prevCharIdx < getContext().characters.length) {
            setCharacterId(prevCharIdx);
            select_selected_character(prevCharIdx, { switchMenu: false });
        }
    } catch (e) { console.warn('[chat-sync] 恢复原角色失败', e); }
    setStatus('');
    hideBusy();
    const skipTxt = skipCloudNames.length ? `，跳过(云端无该角色) ${skipCloud}（${skipCloudNames.join('、')}）` : '';
    const failTxt = failedReasons.length ? `，失败 ${fail}（${failedReasons.map(x=>`${x.name}:${x.reason}`).join('、')}）` : '';
    toastr.info(`选中角色导入：成功 ${ok} / 共 ${total}${skipTxt}${failTxt}`);
    return { ok, fail, skipCloud, skipCloudNames, failReasons: failedReasons };
    } finally { __csReleaseBusy(); }
}

// 把云端补回的新楼并入「当前打开聊天」的内存 chat 数组，返回 {startIndex, appended}（供 redisplayChat 局部重绘）
//  - 跳过首行 header 对象（{user_name,character_name,create_date,...}），只处理消息体
//  - 已在数组里的楼不重复追加（按 messageSignature 去重）
//  - startIndex = 旧消息数-1（redisplayChat 从该 mesid 起重绘，老楼 DOM 不动，只渲染新增尾楼）
// 纯函数便于单测。
function mergeOpenChatTail(chatArray, newOnes, fullRebuild = false) {
    if (fullRebuild) {
        // 中间楼缺失场景: 按云端全量重建内存数组(保留 header 行), DOM 从第一条消息起重绘
        const header = chatArray.length && !chatArray[0].name ? chatArray[0] : null;
        chatArray.length = 0;
        if (header) chatArray.push(header);
        for (const m of newOnes) chatArray.push(m);
        return { startIndex: header ? 1 : 0, appended: newOnes.length };
    }
    const oldLen = chatArray.length;
    // 首行可能是 header 对象（{user_name,character_name,create_date,...} 无 name/mes 字段）。
    // 它不参与消息比对, 但必须保留在 chatArray 里 —— 追加只往数组尾部 push, 绝不动 header。
    // (header 判断仅用于语义说明; 追加逻辑一律 chatArray 原地 push)
    let appended = 0;
    for (const m of newOnes) {
        if (!chatArray.some((x) => messageSignature(x) === messageSignature(m))) { chatArray.push(m); appended++; }
    }
    if (appended === 0) return null;
    return { startIndex: Math.max(oldLen - 1, 0), appended };
}

// 拉取时的「本地已有该聊天」处理：读本地 vs 云端内容，若「云端比本地多」（cloud_superset，即本地误删/少楼）
// 则把云端新楼层补进本地已有文件（聪明版恢复），返回 {added}；否则返回 null/false（已最新或无需补）。
// 这是核心功能：本地删了楼/少了内容，拉取能把云端缺的补回来。
async function pullMergeCloudSuperset(avatar, knownLocal, cloud, cloudPath) {
    try {
        const localMsgs = await readLocalChatMsgs(avatar, knownLocal);
        const cloudMsgs = parseJsonlMessages(cloud.content || '');
        const rel = classifyChatDiff(localMsgs, cloudMsgs);
        // 只有「云端比本地多」(本地是云端子集) 才安全补回；identical/local_superset/diverged 都不动本地
        if (!rel || rel.relation !== 'cloud_superset') return null;
        const sigs = new Set(localMsgs.map(messageSignature));
        const newOnes = (rel.cloudTail || []).filter((m) => !sigs.has(messageSignature(m)));
        let merged;
        // 本地只是末尾少楼(常规) → 只追加云端新楼；本地删了【中间】楼(本地顺序不连续) → 按云端全量重建(云端权威超集,顺序对)
        if (rel.middleGap || !rel.localContig) {
            merged = cloudMsgs; // 云端⊇本地且含本地缺失的中间楼 → 整体按云端重建
            console.log(`[chat-sync] 本地删了中间楼，按云端全量重建「${knownLocal}」`);
        } else {
            if (!newOnes.length) return null;
            merged = localMsgs.concat(newOnes);
        }
        const headerObj = parseHeader(cloud.content);
        const saveAv = String(avatar || '').includes('.png') ? String(avatar) : String(avatar || '') + '.png';
        // 并发兜底：写盘前一瞬若用户已开始生成(roll)，放弃本次补楼写回——避免云端新楼覆盖正在写入的生成内容
        if (csReallyGenerating()) { console.warn('[chat-sync] 用户正在生成，放弃补楼写回', knownLocal); return { blocked: true }; }
        const res = await fetch('/api/chats/save', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                avatar_url: saveAv,
                file_name: String(knownLocal).replace(/\.jsonl$/i, ''),
                chat: [{ user_name: 'unused', character_name: 'unused', create_date: headerObj.create_date || new Date().toISOString(), last_mes: headerObj.last_mes || new Date().toISOString(), chat_metadata: headerObj.chat_metadata || {} }].concat(merged),
                force: true,
            }),
        });
        if (res.ok) {
            settings.lastCloudSha[cloudPath] = cloud.sha;
            // 🔁 DOM 刷新 + 正则美化即时生效（不整体 reload）：若补的正是「当前正打开的聊天」且非群，
            //   云端新楼并入内存 chat 数组后——
            //   ① 酒馆助手 refreshOneMessage 逐楼重渲染(其渲染管线【含 Regex 美化】, 参考余温工具箱同款通道)
            //   ② 兜底 redisplayChat 局部重绘 + 对每条新楼 emit MESSAGE_EDITED 强制正则扩展重放
            //   TT 端同样执行(不再跳过): TT 为 ST 同构 fork, 这些 API 都在; 手机有酒馆助手则走①
            try {
                const curFile = currentChatFileName();
                const c = ctx();
                if (!c.groupId && curFile && curFile === knownLocal && Array.isArray(c.chat)) {
                    // fullRebuild: 中间楼缺失按云端全量重建内存(否则只追加尾部会与磁盘不一致)
                    const isFullRebuild = (merged === cloudMsgs);
                    const merged_info = mergeOpenChatTail(c.chat, newOnes, isFullRebuild);
                    if (merged_info && merged_info.appended > 0) {
                        const TH = window.TavernHelper;
                        const thOk = !!(TH && typeof TH.refreshOneMessage === 'function');
                        if (thOk) {
                            // 有酒馆助手: 数据/落盘已完成, 只需逐楼 refreshOneMessage 重渲染(其管线【含 Regex 美化】)
                            for (let mi = merged_info.startIndex; mi < c.chat.length; mi++) {
                                try { await TH.refreshOneMessage(mi); } catch (e2) { console.warn('[chat-sync] refreshOneMessage 失败', mi, e2); }
                            }
                        } else {
                            // 无酒馆助手: 局部重绘 + 逐新楼 MESSAGE_EDITED 强制正则扩展重放
                            await redisplayChat({ startIndex: merged_info.startIndex, fade: false });
                            for (let mi = merged_info.startIndex; mi < c.chat.length; mi++) {
                                try { eventSource.emit(event_types.MESSAGE_EDITED, mi - 1); } catch { }
                            }
                        }
                        scrollChatToBottom({ waitForFrame: true });
                        console.log(`[chat-sync] 补入 ${merged_info.appended} 楼(美化:${thOk ? '酒馆助手' : 'redisplay+EDITED'}${isFullRebuild ? ',全量重建' : ''})`);
                    }
                }
            } catch (e) { console.warn('[chat-sync] 补楼刷新失败(忽略)', e); }
            return { added: newOnes.length };
        }
        console.warn('[chat-sync] 拉取补楼写回失败', knownLocal, res.status);
        return null;
    } catch (e) { console.warn('[chat-sync] 拉取补楼异常', e); return null; }
}

// 从云端拉取某个角色的聊天 → 增量：只拉新增/有更新的；并把最新那份直接加载进当前聊天窗口楼层
// 增量判断：settings.lastCloudSha[云端路径] 记录上次拉取/上传时该文件云端 sha。
//   云端 sha === 记忆 → 本机已是最新 → 跳过；否则导入并更新记忆。
//   若某路径无记忆（以前没拉过）→ 视为新增 → 拉取。
async function pullCharacterChats(charName) {
    const base = `sync/${charName}/chats`;
    const avatar = ctx().characters?.[ctx().characterId]?.avatar || '';
    // 优先读清单（云端记录了全部聊天文件名）
    let fileNameList = [];
    try {
        const listCloud = await Gitee.getText(`sync/${charName}/chat-list.json`);
        if (listCloud) {
            const parsed = JSON.parse(listCloud.content);
            if (Array.isArray(parsed.files)) fileNameList = parsed.files;
        }
    } catch { /* 清单损坏则忽略 */ }

    if (fileNameList.length === 0) {
        // 没有清单 → 回退：只处理当前打开的聊天文件
        const cur = currentChatFileName();
        if (cur) fileNameList = [cur];
    }
    if (fileNameList.length === 0) { toastr.info(`云端没有 ${charName} 的聊天`); return; }

    let importedCount = 0, skipped = 0;
    let lastImportedFileName = null; // 最新成功导入的文件名（用于直接加载进当前楼层）
    let i = 0;
    const localNames = new Set((ctx().characters?.[ctx().characterId] ? await getCharChatFileNames(charName) : []).map((x) => x.file_name));
    // 拉取提速：1 个请求拿全部云端 sha → 与上次同步一致的文件直接跳过（不再逐个全量下载比对）
    const shaMap = await cloudShaMap(base);
    for (const fileName of fileNameList) {
        i++;
        if (fileNameList.length > 1) { setStatus(`正在拉取角色「${charName}」聊天：${i}/${fileNameList.length}…`); showBusy(i, fileNameList.length, `拉取 ${charName}`); }
        const p = `${base}/${fileName}`;
        const cloudSha = shaMap.get(manifestPathOf(p)) || shaMap.get(p); // 分段聊天以 manifest sha 为指纹
        // 云端没变 且 (本地无绑定 或 本地文件还在) → 无新东西可拉。
        // ⚠️ 本地绑定存在但文件没了 = 用户可能误删整条聊天 → 不跳过，走比对恢复
        const known0 = localNameOf(charName, p);
        if (cloudSha && settings.lastCloudSha[p] === cloudSha && (!known0 || localNames.has(known0))) { skipped++; continue; }
        // 本地已有 → 智能取回(只下载指纹不同的段); 没有 → 全量
        const knownLocal0 = localNameOf(charName, p);
        let cloud;
        if (knownLocal0 && localNames.has(knownLocal0)) {
            const localMsgs = await readLocalChatMsgs(avatar, knownLocal0).catch(() => null);
            cloud = (Array.isArray(localMsgs) && localMsgs.length) ? await getCloudChatSmart(p, localMsgs) : await getCloudChat(p);
            if (cloud && cloud.partial) console.log('[chat-sync] 智能取回:', JSON.stringify(cloud.partial));
        } else cloud = await getCloudChat(p);
        if (!cloud) continue;
        // 本地已有该聊天：先做内容级判断——“云端比本地多”则补回本地(恢复误删/少楼)，否则已最新跳过
        const knownLocal = localNameOf(charName, p);
        if (knownLocal && localNames.has(knownLocal)) {
            // 读本地 vs 云端，云端 ⊇ 本地(cloud_superset) → 把云端新楼层补进本地；otherwise 跳过
            const merged = await pullMergeCloudSuperset(avatar, knownLocal, cloud, p);
            settings.lastCloudSha[p] = cloud.sha || cloudSha; // 本次已完整比对过 → 记 sha，下次免下载
            if (merged) {
                importedCount++;
                lastImportedFileName = knownLocal; // 补过楼的文件可当作最新
            } else {
                skipped++;
            }
            continue;
        }
        // 增量：云端 sha 与记忆一致 → 本机已最新，跳过（仅用于“本地还没有该文件”的新聊天加速）
        const remembered = settings.lastCloudSha[p];
        if (remembered && remembered === cloud.sha) { skipped++; continue; }
        // 补 ST 标准 jsonl header（首行须含 user_name/name/chat_metadata 否则导入报 Unsupported JSONL）
        const jsonlContent = ensureChatJsonlHeader(cloud.content, ctx().name1, ctx().name2);
        const blob = new Blob([jsonlContent], { type: 'application/octet-stream' });
        const file = new File([blob], `import-${i}.jsonl`, { type: 'application/octet-stream' });
        i++;
        const formData = new FormData();
        formData.set('file_type', 'jsonl');
        formData.set('avatar', file);
        formData.set('avatar_url', ctx().characters[ctx().characterId]?.avatar || '');
        formData.set('user_name', ctx().name1);
        formData.set('character_name', ctx().name2);
        const importFn = ctx().groupId ? importGroupChat : importCharacterChat;
        const result = await importFn(formData, { refresh: false });
        if (result.length) {
            importedCount++;
            settings.lastCloudSha[p] = cloud.sha; // 记下这次拉取的云端 sha，下次相同则跳过
            lastImportedFileName = result[result.length - 1]; // 取导入后实际文件名
            setLocalName(charName, p, lastImportedFileName); // 绑定 云路径↔本地导入名（收敛关键）
        }
    }
    saveSettingsDebounced();
    toastr.success(`已拉取 ${charName} 的聊天：新增/更新 ${importedCount} 个${skipped ? `，已最新跳过 ${skipped} 个` : ''} ✅`);

    // 把最新成功导入的聊天直接加载进当前聊天窗口楼层（替换当前显示）
    // 注意：仅普通酒馆(ST)走 reloadCurrentChat——TT 上 chat 文件是旧 shim 可能没真正落盘到 Rust 认的目录，
    // reload 会触发 get_chat_payload_path 找不到文件报 "Failed to get chat payload path … Chat not found"。
    // TT 走 openCharacterChat（= 用户手动「点选」那条记录）：设 .chat 指向真实导入文件 + getChat 载入 + 落盘，不会碰幻影名。
    if (lastImportedFileName && !ctx().groupId) {
        const isTtPull = Boolean(window.__TAURITAVERN__ || window.__TAURITAVERN_MAIN_READY__);
        try {
            if (!isTtPull) {
                const filenameNoExt = String(lastImportedFileName).replace(/\.jsonl$/i, '');
                const cIdx = ctx().characterId;
                if (cIdx !== undefined && ctx().characters?.[cIdx]) {
                    ctx().characters[cIdx].chat = filenameNoExt;
                    await reloadCurrentChat();
                    toastr.success('已将最新聊天加载到当前楼层');
                }
            } else {
                await loadImportedChat(lastImportedFileName, ctx().characterId);
            }
        } catch (e) { console.warn('[chat-sync] 加载最新聊天到楼层失败', e); }
    }
}

// 拉取当前角色：先确保本地有卡，再拉聊天
async function pullCurrentCharacter() {
    if (!__csTryBusy()) { toastr.warning('已有同步在进行中，本次跳过，稍后再试'); return; }
    try {
        const charName = currentCharName();
        if (!charName) { toastr.warning('当前没有打开的单人角色'); return; }
        await pullCharacterChats(charName);
    } finally { __csReleaseBusy(); }
}

// ============ 单「当前聊天」粒度的上传/下载（需求2+3：与「全部聊天」区分） ============
// 只处理当前打开的这一个聊天文件，不动角色其它聊天。
async function pushCurrentChat() {
    const charName = currentCharName();
    if (!charName) { toastr.warning('当前没有打开的单人角色'); return; }
    const localName = currentChatFileName();
    if (!localName) { toastr.warning('无法确定当前聊天'); return; }
    const p = cloudPathOfLocal(charName, localName) || `sync/${charName}/chats/${localName.replace(/[\\\\/\\\\]/g, '_')}`;
    // 锁外预扫冲突抉择（弹窗在拿锁前完成，避免弹窗持锁卡死其他同步）
    const chatText = await getChatContent(localName, charName);
    if (!chatText) { toastr.warning('读取当前聊天失败'); return; }
    const cloud = await getCloudChat(p);
    const localMsgs = parseJsonlMessages(chatText);
    const cloudMsgs = cloud ? parseJsonlMessages(cloud.content || '') : [];
    let decision = 'new';
    if (cloud) {
        decision = await resolveUploadConflict(localMsgs, cloudMsgs, localName, null);
        if (decision === 'skip') { toastr.info(`当前聊天「${localName}」已是最新（或云端更新，无需上传）`); return; }
        if (decision === 'cancel') { toastr.info('已取消上传'); return; }
    }
    if (!__csTryBusy()) { toastr.warning('已有同步在进行中，本次跳过，稍后再试'); return; }
    try {
        setStatus(`正在同步当前聊天…`);
        showBusy(0, 0, `上传 ${localName}`);
        let newSha;
        if (decision === 'new') {
            newSha = await putCloudChat(p, chatText, `sync chat ${localName}`);
        } else {
            const headerObj = cloud ? parseHeader(cloud.content || chatText) : {};
            const text = buildCloudUploadText(localMsgs, cloudMsgs, headerObj, decision);
            newSha = await putCloudChat(p, text, `${decision === 'append' ? 'append' : 'sync chat'} ${localName}`);
        }
        settings.lastCloudSha[p] = newSha || settings.lastCloudSha[p]; // 分段时=manifest sha
        setLocalName(charName, p, localName);
        saveSettingsDebounced();
    setStatus('');
    toastr.success(`已同步当前聊天「${localName}」✅`);
    } finally { __csReleaseBusy(); }
}

async function pullCurrentChat() {
    if (!__csTryBusy()) { toastr.warning('已有同步在进行中，本次跳过，稍后再试'); return; }
    try {
    const charName = currentCharName();
    if (!charName) { toastr.warning('当前没有打开的单人角色'); return; }
    const localName = currentChatFileName();
    if (!localName) { toastr.warning('无法确定当前聊天'); return; }
    const p = cloudPathOfLocal(charName, localName) || `sync/${charName}/chats/${localName.replace(/[\\\\/\\\\]/g, '_')}`;
    setStatus(`正在拉取当前聊天…`);
    showBusy(0, 0, `拉取 ${localName}`);
    // 本地是否已有该文件
    const c = ctx();
    const avatar = c.characters?.[c.characterId]?.avatar || '';
    const localHas = ((c.characters?.[c.characterId] ? await getCharChatFileNames(charName) : []) || []).some((x) => x.file_name === localName);
    // 本地已有 → 智能取回(只下载指纹不同的段, 段校验失败自动回退全量); 没有 → 全量
    let cloud;
    if (localHas) {
        const localMsgs = await readLocalChatMsgs(avatar, localName).catch(() => null);
        cloud = (Array.isArray(localMsgs) && localMsgs.length) ? await getCloudChatSmart(p, localMsgs) : await getCloudChat(p);
        if (cloud && cloud.partial) console.log('[chat-sync] 智能取回:', JSON.stringify(cloud.partial));
    } else {
        cloud = await getCloudChat(p);
    }
    if (!cloud) { setStatus(''); toastr.info('云端没有该聊天（可能没同步过）；请先同步或从云端导入'); return; }
    if (localHas) {
        // 本地已有 → 内容级判断云端比本地多则补回，否则已最新
        const merged = await pullMergeCloudSuperset(avatar, localName, cloud, p);
        setStatus('');
        if (merged && merged.blocked) { toastr.warning('检测到可能正在生成，已暂停自动补楼（等生成结束再导入一次即可）'); return; }
        if (merged) { toastr.success(`已从云端补回当前聊天 ${merged.added} 楼 ✅`); return; }
        toastr.info('当前聊天已是最新');
        return;
    }
    // 本地没有该文件 → 导入为本地新聊天
    const jsonlContent = ensureChatJsonlHeader(cloud.content, c.name1, c.name2);
    const blob = new Blob([jsonlContent], { type: 'application/octet-stream' });
    const file = new File([blob], `import-chat.jsonl`, { type: 'application/octet-stream' });
    const formData = new FormData();
    formData.set('file_type', 'jsonl');
    formData.set('avatar', file);
    formData.set('avatar_url', avatar);
    formData.set('user_name', c.name1);
    formData.set('character_name', c.name2 || charName);
    const importFn = c.groupId ? importGroupChat : importCharacterChat;
    const result = await importFn(formData, { refresh: false });
    if (result.length) {
        setLocalName(charName, p, result[0]);
        settings.lastCloudSha[p] = cloud.sha;
        saveSettingsDebounced();
        setStatus('');
        toastr.success('已从云端拉取当前聊天 ✅');
    } else {
        setStatus('');
        toastr.error('当前聊天导入失败');
    }
    } finally { __csReleaseBusy(); }
}

// ===================== 工具 =====================
// 横幅点名列表折叠：超过 max 个 → 只列前 max 个 + "等N项"（完整清单照旧进 console，横幅不再刷屏）
function csShortList(items, max = 5) {
    const arr = (items || []).map(String);
    if (arr.length <= max) return arr.join('、');
    return arr.slice(0, max).join('、') + ` 等${arr.length}项`;
}
// 一次目录列表拿全部云端 sha（仅 1 个请求）：与上次同步记忆一致的文件，拉取时直接跳过、不再逐个全量下载（拉取提速核心）
async function cloudShaMap(dirPath) {
    const m = new Map();
    try { for (const e of await Gitee.listEntries(dirPath)) if (e.type === 'file') m.set(e.path, e.sha); } catch { }
    return m;
}
// saveSettingsDebounced 从 script.js import（ST 真版，真正写盘 settings.json）

function escapeHtml(s) {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// 更新面板状态文本(若面板已挂载)；用于上传/下载等过程的实时进度反馈。
function setStatus(text) {
    const st = window.document && document.getElementById('cs_status');
    if (st) st.textContent = text;
}

// ============ 同步繁忙可视化 + 全局互斥 ============
let __csBusyEl = null;      // 顶部醒目进度条
let __csSyncBusy = false;   // 全局互斥：任一同步操作进行中
// 请求进入同步动作；返回 false 表示已有其他同步在跑（本次调用应跳过，避免并发撞车）
function __csTryBusy() {
    if (__csSyncBusy) return false;
    __csSyncBusy = true;
    return true;
}
function __csReleaseBusy() {
    __csSyncBusy = false;
    hideBusy();
}
// 顶部醒目进度条（页面级，无论用户看哪都能注意到）
function showBusy(page, total, msg) {
    if (!__csBusyEl) {
        __csBusyEl = document.createElement('div');
        __csBusyEl.id = 'cs_busy_bar';
        // 半透明悬浮小卡(右上角, toastr 风格, 不占长条不遮输入框)
        __csBusyEl.style.cssText = 'position:fixed;top:14px;right:14px;z-index:99999;max-width:320px;' +
            'background:rgba(20,20,24,.82);color:#eee;padding:8px 14px;font-weight:600;font-size:13px;' +
            'text-align:left;border-radius:10px;border:1px solid rgba(255,255,255,.15);' +
            'box-shadow:0 4px 16px rgba(0,0,0,.5);backdrop-filter:blur(6px);pointer-events:none;';
        document.body.appendChild(__csBusyEl);
    }
    const label = msg || '同步';
    __csBusyEl.textContent = (total && total > 0)
        ? `🔄 ${label}中：${page}/${total}，请稍后…`
        : `🔄 ${label}中，请稍后…`;
    // 同步镜像到"列表下方状态行"(用户要求细化: 上传/导入的当前项与几/几直接显示在那里)
    try {
        const s2 = document.getElementById('cs_cfg2_status');
        if (s2) { s2.textContent = __csBusyEl.textContent; s2.style.color = ''; }
    } catch { }
}
function hideBusy() {
    if (__csBusyEl) { __csBusyEl.remove(); __csBusyEl = null; }
    try {
        const s2 = document.getElementById('cs_cfg2_status');
        if (s2 && s2.textContent.startsWith('🔄 ')) { s2.textContent = ''; s2.style.color = ''; }
    } catch { }
}

// ============ 弹窗确认（兼容 ST/TT） ============
// ST 有 Popup.confirm(message), TT 无；统一用 Popup.show.confirm。
// 实测 TT 无视 okButton/cancelButton:false，customButtons 会与 confirm 默认按钮(是/否)叠加 → 不用 customButtons，
// 直接用默认按钮；返回 POPUP_RESULT.AFFIRMATIVE(1) 即确认（popup.js:25 依据）。
async function csConfirm(title, html) {
    const P = window.Popup || Popup;
    try {
        if (P && typeof P.show?.confirm === 'function') {
            const v = await P.show.confirm(title, html, { defaultResult: 1 /* AFFIRMATIVE */ });
            // AFFIRMATIVE=1(确定/是)；CANCELLED=null(关闭/取消)；NEGATIVE=0(否)
            return v === 1;
        }
        if (P && typeof P.confirm === 'function') {
            return !!(await P.confirm(title, html));
        }
        // 兜底：展示端的原生 confirm
        return window.confirm(html);
    } catch (e) {
        console.warn('[chat-sync] 弹窗确认异常，按取消处理', e);
        return false;
    }
}

// 导入期间自动确认官方弹窗（"内置世界书/内置正则/嵌入式脚本/是否导入"等阻塞确认框）。
// 【安全版】不接管 Popup、不开 long-lived interval、不加全局监听 —— 实测任何长期运行的全局弹窗机制(override 或 setInterval)都会让 TauriTT WebView 主线程在导入完成后冻结。
// 用「有限次数的 setTimeout 一次性扫描」：每次调用启动一次扫描链(最多 SELF_STOP 次、每次间隔 200ms 自动停下)，每次只点一个确认，点完即不再残留。
let __csAutoConfirmChain = 0;       // 链长度计数，防并行叠加
function __csScanOnce() {
    try {
        const btns = [...document.querySelectorAll('.popup-button-ok, .menu_button.result-confirm, button[class*=popup], .popup .menu_button')];
        for (const b of btns) {
            if (b.offsetParent === null) continue;
            const txt = (b.textContent || '').trim();
            if (!txt) continue;
            if (/^(是|确定|确认|导入|启用|允许|Yes|OK|Confirm|Import|Enable|APPROVE)$/i.test(txt)) {
                try { b.click(); } catch {}
                break; // 点一个就停，避免连点连锁
            }
        }
    } catch (e) {}
}
function suppressImportModals() {
    // 只做有限次扫描(约 1.2s 窗口)，覆盖异步弹出的确认框；用完自动停，不残留。
    const N = 6;
    for (let i = 0; i < N; i++) setTimeout(__csScanOnce, 150 + i * 180);
    // 返回一个空 release（保持 API 兼容，无全局锁可释放）
    return () => {};
}
function releaseImportModalsAfter(delayMs = 2000) { /* 安全版无需延迟 release(本例已自停)；保留签名兼容 */ }
function releaseAllImportModals() { /* 安全版无全局引用计数，无需操作 */ }

// 服务端持久化某角色本地卡的 .chat 指针（写盘、不渲染、不触发 getChat/selectCharacter）。
// ST：/api/characters/edit 接受 JSON body（endpoints/characters.js:1099 读 body.chat）。
// TT：/api/characters/edit 只接受 multipart FormData（_tt2 character-routes.js:135，buildCharacterCardFromForm 读表单 json_data + chat 重建整卡）。
// 故统一用 FormData：json_data = 用 /api/characters/get 拿到的完整卡对象(JSON)，chat = 目标，另带 name/avatar 等必需字段 → 两端都能落盘且不清空卡。
// 不打开聊天窗口→不会冻结。返回是否成功；失败只告警不抛（导入本体不受影响）。
async function persistChatPointerStt(charName, cardAvatar, chatStem) {
    const stem = String(chatStem || '').replace(/\.jsonl$/i, '');
    try {
        const c = getContext();
        const av = String(cardAvatar || '').includes('.png') ? String(cardAvatar) : String(cardAvatar || '') + '.png';
        // 1) 拿完整卡对象（含 data.extensions 等全字段）
        let card = null;
        try {
            const cg = await fetch('/api/characters/get', { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify({ avatar_url: av }) });
            if (cg.ok) card = await cg.json();
        } catch {}
        // 2) 构筑 json_data：优先用后端返回的完整卡；TT/ST 用其 json_data/顶层字段即可
        const jsonData = card && card.json_data ? card.json_data
            : (card ? JSON.stringify(card) : (_ => { try { const i=(getContext().characters||[]).findIndex(x=>String(x.avatar||'').replace(/\.png$/,'')===String(cardAvatar||'').replace(/\.png$/,'')); return JSON.stringify(getContext().characters[i] || {}); } catch { return '{}'; } })());
        const name = card && card.name ? card.name : charName;
        const isTt = Boolean(window.__TAURITAVERN__ || window.__TAURITAVERN_MAIN_READY__);
        let resp;
        if (isTt) {
            // TT：/edit 要 multipart
            const fd = new FormData();
            fd.append('avatar_url', av);
            fd.append('ch_name', name);
            fd.append('name', name);
            fd.append('chat', stem);
            fd.append('json_data', jsonData);
            fd.append('create_date', card && card.create_date || new Date().toISOString());
            for (const k of ['description','personality','scenario','first_mes','mes_example','creator_notes','creatorcomment','talkativeness','fav','tags']) {
                const v = card && card[k] != null ? card[k] : '';
                fd.append(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
            }
            resp = await fetch('/api/characters/edit', { method: 'POST', headers: getRequestHeaders({ omitContentType: true }), body: fd });
        } else {
            // ST：/edit 收 JSON body（endpoints/characters.js:1099 读 body.chat/body.json_data）
            const body = {
                avatar_url: av, ch_name: name, name, chat: stem, json_data: jsonData,
                create_date: (card && card.create_date) || new Date().toISOString(),
            };
            for (const k of ['description','personality','scenario','first_mes','mes_example','creator_notes','creatorcomment','talkativeness','fav','tags']) {
                const v = card && card[k] != null ? card[k] : '';
                body[k] = typeof v === 'object' ? JSON.stringify(v) : String(v);
            }
            resp = await fetch('/api/characters/edit', { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify(body) });
        }
        // 内存同步
        const idx = (getContext().characters || []).findIndex(x => (x.name || '') === charName || String(x.avatar || '').replace(/\\.png$/,'') === String(cardAvatar || '').replace(/\\.png$/,''));
        if (idx >= 0) getContext().characters[idx].chat = stem;
        if (resp.ok) { console.log(`[chat-sync] 已服务端持久化「${charName}」.chat → ${stem}`); return true; }
        console.warn('[chat-sync] /api/characters/edit 持久化 .chat 失败', resp.status);
        return false;
    } catch (e) { console.warn('[chat-sync] 持久化 .chat 异常(忽略)', e); return false; }
}

// ============ 独立「全局世界书」选择同步（2026-08-21） ============
// 用户要：类似「选择部分角色」列表，只列【全局(非绑定卡)世界书】跳过绑定卡的，可本地/云端双向获取。
// 云端命名空间：worldbooks/<书名>.json （与绑卡世界书 sync/<角色>/world.json 分开）
// 绑定卡的世界书 = 任一角色卡 data.extensions.world 引用过的 → 跳过，由角色包管理。

// 一个世界书是否被任一角色卡绑定（绑定→归角色包管，不作独立全局书）
function isWorldbookBound(name) {
    try {
        const chars = getContext().characters || [];
        return chars.some((c) => c && c.data && c.data.extensions && String(c.data.extensions.world || '') === String(name));
    } catch { return false; }
}
// 本地「全局(非绑定)」世界书名列表
function listGlobalWorldbookNames() {
    if (!Array.isArray(world_names)) return [];
    return world_names.filter((n) => n && !isWorldbookBound(n));
}
// 云端「全局世界书」文件名列表（worldbooks/ 下的 *.json）
async function listCloudWorldbooks() {
    try {
        const entries = await Gitee.listEntries('worldbooks');
        return entries.filter((e) => e.type === 'file' && e.name.endsWith('.json')).map((e) => e.name.replace(/\.json$/, ''));
    } catch { return []; }
}
// 上传选中本地全局世界书（增量：本地===云端则跳过）
async function pushSelectedWorldbooks(names) {
    if (!Array.isArray(names) || !names.length) { toastr.warning('未选择要上传的世界书'); return null; }
    if (!__csTryBusy()) { toastr.warning('已有同步在进行中，本次跳过，稍后再试'); return null; }
    try {
        const ok = [], skipped = [], skippedManual = [], fail = []; const failReasons = [];
        showBusy(0, names.length, '上传全局世界书');
        for (let i = 0; i < names.length; i++) {
            const name = names[i];
            showBusy(i + 1, names.length, `上传全局世界书 ${name}`);
            try {
                const wc = await getWorldContent(name);
                if (!wc) { skipLocalWorldbook(fail, failReasons, name, '本地无该世界书'); continue; }
                const p = `worldbooks/${name}.json`;
                const cloud = await Gitee.getText(p);
                // 增量: 内容一致→跳过; 云端在上次同步后被改(rememberSha≠cloud.sha)→覆盖前先另存? 简单: 一致跳过, 否则上传覆盖
                const rememberSha = settings.lastCloudSha ? settings.lastCloudSha[p] : undefined;
                if (cloud && String(wc) === String(cloud.content)) {
                    settings.lastCloudSha[p] = cloud.sha;
                    skipped.push(name); continue;
                }
                await Gitee.putText(p, wc, cloud?.sha, `sync worldbook ${name}`);
                settings.lastCloudSha[p] = (await Gitee.getText(p)).sha;
                ok.push(name);
            } catch (e) { fail.push(name); failReasons.push({ name, reason: (e && e.message) || String(e) }); }
        }
        saveSettingsDebounced();
        hideBusy();
        const sum = `上传选中世界书：成功 ${ok.length} / 共 ${names.length}${skipped.length ? `，已最新跳过 ${skipped.length}` : ''}${fail.length ? `，失败 ${fail.length}` : ''}${failReasons.length ? `（${csShortList(failReasons.map(x => `${x.name}:${x.reason}`))}）` : ''}`;
        toastr.info(sum);
        return { ok: ok.length, fail: fail.length, skipped: skipped.length, failReasons };
    } finally { __csReleaseBusy(); }
}
function skipLocalWorldbook(fail, failReasons, name, reason) { fail.push(name); failReasons.push({ name, reason }); }

// 导入选中云端全局世界书（增量：本地===云端则跳过）
async function importSelectedWorldbooks(names) {
    if (!Array.isArray(names) || !names.length) { toastr.warning('未选择要导入的世界书'); return null; }
    if (!__csTryBusy()) { toastr.warning('已有同步在进行中，本次跳过，稍后再试'); return null; }
    try {
        const ok = [], skipped = [], skippedManual = [], fail = []; const failReasons = [];
        const batchMode = { applyAll: false, decision: null };
        showBusy(0, names.length, '导入全局世界书');
        suppressImportModals(); // 复用: 自动确认同名覆盖弹窗(一次性, 不残留)
        for (let i = 0; i < names.length; i++) {
            const name = names[i];
            showBusy(i + 1, names.length, `导入全局世界书 ${name}`);
            try {
                const p = `worldbooks/${name}.json`;
                const cloud = await Gitee.getText(p);
                if (!cloud) { fail.push(name); failReasons.push({ name, reason: '云端无该世界书' }); continue; }
                // 本地已有且内容一致 → 跳过；不同 → 冲突弹窗（替换/统统替换/另存副本/统统另存副本），与分项导入同一套
                const localW = await getWorldContent(name);
                let importName = name;
                if (localW && String(localW) === String(cloud.content)) { skipped.push(name); settings.lastCloudSha[p] = cloud.sha; continue; }
                if (localW) {
                    const decision = await resolveCfgImportConflict('全局世界书', name, batchMode);
                    if (decision === 'cancel') { skippedManual.push(name); continue; }
                    if (decision === 'copy') {
                        // 用官方 world_names(活数组)做同步查重, 避免异步 exists 卡死 uniqueCfgName
                        importName = uniqueCfgName(name, (n) => Array.isArray(world_names) && world_names.includes(n));
                    }
                }
                const f = textToFile(cloud.content, importName + '.json');
                await importWorldInfo(f);
                settings.lastCloudSha[p] = cloud.sha;
                ok.push(importName === name ? name : `${name}→另存「${importName}」`);
            } catch (e) { fail.push(name); failReasons.push({ name, reason: (e && e.message) || String(e) }); }
        }
        saveSettingsDebounced();
        hideBusy();
        const sum = `导入选中世界书：成功 ${ok.length} / 共 ${names.length}${skipped.length ? `，已最新跳过 ${skipped.length}` : ''}${skippedManual.length ? `，手动跳过 ${skippedManual.length}（${csShortList(skippedManual)}）` : ''}${fail.length ? `，失败 ${fail.length}` : ''}${failReasons.length ? `（${csShortList(failReasons.map(x => `${x.name}:${x.reason}`))}）` : ''}`;
        toastr.info(sum);
        return { ok: ok.length, fail: fail.length, skipped: skipped.length, failReasons };
    } finally { __csReleaseBusy(); }
}

// 删除选中世界书（本地/云端分开，mode='local'删本地 deleteWorldInfo，'cloud'删云端 Gitee）
// 逻辑与「删除选中角色」一致：确认在拿锁前，批量遍历，结束汇总点名失败。
async function deleteSelectedWorldbooks(names, mode) {
    mode = mode || 'local';
    if (!Array.isArray(names) || !names.length) return null;
    const ok = [], fail = []; const failReasons = [];
    try {
        for (let i = 0; i < names.length; i++) {
            const name = names[i];
            try {
                if (mode === 'cloud') {
                    const p = `worldbooks/${name}.json`;
                    const cloud = await Gitee.getText(p);
                    if (!cloud) { fail.push(name); failReasons.push({ name, reason: '云端无该世界书' }); continue; }
                    await Gitee.deleteFile(p, cloud.sha, `delete worldbook ${name}`);
                    if (settings.lastCloudSha && settings.lastCloudSha[p] !== undefined) delete settings.lastCloudSha[p];
                } else {
                    // 本地删除：ST/TT 官方 deleteWorldInfo（删同名文件 + 更新 world_names）。世界书已在 world_names 里才能删。
                    const existed = Array.isArray(world_names) && world_names.includes(name);
                    await deleteWorldInfo(name);
                    if (!existed) { fail.push(name); failReasons.push({ name, reason: '本地无该世界书' }); continue; }
                }
                ok.push(name);
            } catch (e) { fail.push(name); failReasons.push({ name, reason: (e && e.message) || String(e) }); }
        }
        saveSettingsDebounced();
        return { ok: ok.length, fail: fail.length, failReasons };
    } finally { /* busy 由调用方管理 */ }
}

// ============ 聊天记录清理器（2026-08-23 用户需求：选角色→列历史(预览/时间)→勾选→本地+云端同名同删） ============
// 列出某角色 本地+云端 全部聊天（本地走官方 /api/characters/chats 一次拿全: 楼数/大小/最后一楼预览/mtime；
// 云端走目录列表拿 name/size/sha；按文件名对齐，同名=双端都有）
async function listCleanerRows(charName) {
    const avatar = getAvatarFor(charName);
    let localRows = [];
    if (avatar) {
        try {
            const r = await fetch('/api/characters/chats', { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify({ avatar_url: avatar }) });
            if (r.ok) { const arr = await r.json(); if (Array.isArray(arr)) localRows = arr.filter((x) => x && x.file_name); }
        } catch { }
    }
    const cloudEntries = await Gitee.listEntries(`sync/${charName}/chats`).catch(() => []);
    const byName = new Map();
    for (const c of cloudEntries) if (c.type === 'file' && !/\.p\d{3}\.jsonl$/i.test(c.name) && !/\.manifest\.json$/i.test(c.name)) byName.set(c.name, { cloudSize: c.size, where: 'cloud' });
    for (const l of localRows) {
        const e = byName.get(l.file_name);
        if (e) { e.local = l; e.where = 'both'; }
        else byName.set(l.file_name, { local: l, where: 'local' });
    }
    return [...byName.entries()].map(([fileName, e]) => ({
        fileName,
        where: e.where, // local=仅本地 cloud=仅云端 both=双端
        mesCount: e.local ? e.local.chat_items : null,
        preview: e.local ? String(e.local.mes || '').replace(/\s+/g, ' ').slice(0, 60) : '（仅云端，未下载）',
        lastTime: e.local ? new Date(Number(e.local.last_mes) || Date.parse(e.local.last_mes) || 0).toLocaleString() : '',
        size: e.local ? (() => { const b = parseSizeStr(e.local.file_size); return b != null ? humanBytes(b) : String(e.local.file_size || ''); })() : (e.cloudSize != null ? humanBytes(e.cloudSize) : ''),
    })).sort((a, b) => String(b.lastTime).localeCompare(String(a.lastTime)));
}
// 取某条聊天的"最新一楼(非user)"预览全文：本地走官方 /api/chats/get；仅云端走 Gitee 下载。
// 预览规则(用户要求)：只显示 <content> 之后的内容（预设类聊天把正文装在 <content> 标签里，之前才是状态栏等）
// 大小统一显示 MB（用户要求: KB 全部并成 MB, 不再出现 KB 单位）
function humanBytes(n) {
    const v = Number(n);
    if (!isFinite(v) || v < 0) return '?';
    const mb = v / 1024 / 1024;
    return (mb < 10 ? mb.toFixed(2) : mb.toFixed(1)) + 'MB';
}
// 官方 file_size 是格式化字符串("661.83KB"/"11.6MB"/"540B") → 解析回字节数再统一 MB
function parseSizeStr(str) {
    const m = String(str || '').trim().match(/^([\d.]+)\s*(B|KB|MB|GB)$/i);
    if (!m) return null;
    const v = parseFloat(m[1]);
    const unit = m[2].toUpperCase();
    const mult = unit === 'B' ? 1 : unit === 'KB' ? 1024 : unit === 'MB' ? 1024 * 1024 : 1024 * 1024 * 1024;
    return v * mult;
}
// 预览正文格式化: 与聊天页同款着色 —— *斜体*→主题斜体色, “引用”/"引用"→引用色, __下划线__→下划线色
function __fmtPrevText(t) {
    let h = escapeHtml(String(t || ''));
    h = h.replace(/__([^_\n]{1,300}?)__/g, '<u class="cs-prev-u">$1</u>');
    h = h.replace(/\*([^*\n]{1,300}?)\*/g, '<em class="cs-prev-em">$1</em>');
    h = h.replace(/“([^”\n]{1,300}?)”/g, '<span class="cs-prev-q">“$1”</span>');
    h = h.replace(/&quot;([^\n]{1,300}?)&quot;/g, '<span class="cs-prev-q">&quot;$1&quot;</span>');
    return h;
}
function previewAfterContent(mes) {
    let t = String(mes || '');
    const i = t.indexOf('<content>');
    if (i >= 0) t = t.slice(i + '<content>'.length);
    const j = t.lastIndexOf('</content>');
    if (j >= 0) t = t.slice(0, j);
    return t.trim();
}
async function getCleanerPreviewFull(charName, fileName) {
    const avatar = getAvatarFor(charName);
    let msgs = null;
    const stem = String(fileName).replace(/\.jsonl$/i, '');
    if (avatar) {
        try {
            const r = await fetch('/api/chats/get', { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify({ avatar_url: avatar, file_name: stem }) });
            // ⚠️ 两端返回形态不同: ST={chat:[...]}, TT=数组([header,...msgs]) —— 都要兼容
            if (r.ok) {
                const j = await r.json();
                if (Array.isArray(j)) msgs = j.filter((m) => m && m.mes !== undefined);
                else if (j && Array.isArray(j.chat)) msgs = j.chat;
            }
        } catch { }
    }
    if (!msgs) { // 仅云端 → 下载
        const c = await Gitee.getText(`sync/${charName}/chats/${fileName}`).catch(() => null);
        if (c) msgs = parseJsonlMessages(c.content);
    }
    if (!msgs) return null;
    // 返回全部楼层(截断单楼超长文本防内存爆) —— 弹窗里 上一楼/下一楼/跳转 用；默认楼层=最新一层非 user
    const floors = msgs.map((m) => ({ is_user: !!(m && m.is_user), name: String((m && m.name) || ''), mes: String((m && m.mes) || '').slice(0, 20000) }));
    let defIdx = floors.length - 1;
    for (let i = floors.length - 1; i >= 0; i--) { if (!floors[i].is_user) { defIdx = i; break; } }
    return { charName, fileName, mesCount: floors.length, floors, defIdx };
}
// 删除选中聊天：本地 /api/chats/delete + 云端 deleteFile + 更新 chat-list.json + 清 syncMap/lastCloudSha 记忆
async function deleteChatsBothSides(charName, fileNames) {
    if (!Array.isArray(fileNames) || !fileNames.length) return null;
    const avatar = getAvatarFor(charName);
    const base = `sync/${charName}/chats/`;
    const ok = [], fail = []; const failReasons = [];
    // 读云端清单(有则最后重传)
    const listPath = `sync/${charName}/chat-list.json`;
    let listObj = null;
    const lc = await Gitee.getText(listPath).catch(() => null);
    if (lc) { try { listObj = JSON.parse(lc.content || '{}'); } catch { listObj = null; } }
    for (const fn of fileNames) {
        try {
            // 正在打开的聊天跳过(实测: API 删掉后酒馆自动保存又把内存版写回磁盘 → 恢复旧保护, 提示先切走)
            if (charName === (currentCharName() || '') && currentChatFileName() === fn) { fail.push(fn); failReasons.push({ name: fn, reason: '正在打开，先切换到别的聊天再删' }); continue; }
            // 其余本地删: 优先官方前端入口 deleteCharacterChatByName(与酒馆自带聊天管理同款); 找不到角色索引才回退裸接口
            const cIdxQa = getContext().characters.findIndex((x) => x && x.name === charName);
            if (cIdxQa >= 0 && typeof deleteCharacterChatByName === 'function') {
                await deleteCharacterChatByName(cIdxQa, String(fn).replace(/\.jsonl$/i, '')).catch(() => { });
                const stillLocal = await (async () => {
                    try {
                        const rr = await fetch('/api/chats/get', { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify({ avatar_url: avatar || charName + '.png', file_name: String(fn).replace(/\.jsonl$/i, '') }) });
                        const jj = await rr.json();
                        return Array.isArray(jj) && jj.length > 0;
                    } catch { return false; }
                })();
                if (stillLocal) { fail.push(fn); failReasons.push({ name: fn, reason: '本地删除未生效' }); continue; }
            } else {
                const r = await fetch('/api/chats/delete', { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify({ avatar_url: avatar, chatfile: fn }) });
                if (!r.ok && r.status !== 400) { fail.push(fn); failReasons.push({ name: fn, reason: '本地删除 HTTP ' + r.status }); continue; }
            }
            ok.push(fn);
        } catch (e) { fail.push(fn); failReasons.push({ name: fn, reason: (e && e.message) || String(e) }); }
    }
    // 清单重传（保持云端 chat-list.json 与实际一致）
    if (listObj && ok.length) {
        try { const sha = (await Gitee.getText(listPath))?.sha; await Gitee.putText(listPath, JSON.stringify(listObj, null, 2), sha, 'update chat list after clean'); } catch (e) { console.warn('[chat-sync] 清单重传失败', e); }
    }
    saveSettingsDebounced();
    return { ok: ok.length, fail: fail.length, okNames: ok, failReasons };
}
// ============ 酒馆配置 分项同步（2026-08-21,按用户纯前端+多选选择单） ============
// 分项分类：连接参数预设(含余温) / Themes / 全局正则 / User(资料+头像) + 整包settings(保留)
// 云端命名空间：config-sync/<类>/<项>.json ；导入=默认替换同名(ST 各 save 接口都是整体写→替换)
// 通用辅助：拉一次 /api/settings/get 解析成 JSON（分项各类都要读它）
let __lastSettingsData = null;
async function fetchSettingsJson(force = false) {
    if (__lastSettingsData && !force) return __lastSettingsData;
    const r = await fetch('/api/settings/get', { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify({}) });
    if (!r.ok) throw new Error('读取酒馆配置失败 HTTP ' + r.status);
    __lastSettingsData = await r.json();
    return __lastSettingsData;
}
// ============ 分项① 连接参数预设（Connection Profiles / 余温等） ============
// 读本地连接预设列表。data = /api/settings/get 的返回体
// 各 api 的预设数组：openai_settings / novelai_settings / koboldai_settings / textgenerationwebui_presets
// 2026-08-22 用户拍板: 连接预设只列 OpenAI(余温等用户预设都在 OpenAI Settings)；
// novel/kobold/textgen 全是 ST 内置英文预设(Asper-Kayra 等, "v0.41-gmn 之后的全不是我导入的") → 整组剔除
const CONN_PRESET_GROUPS = [
    { key: 'openai_settings', apiId: 'openai', label: '预设', cloudDir: 'config-sync/connections/openai' } // 2026-08-24 改名: 已剥离连接配置, 不再叫连接预设,
];
// 列表可见性过滤(纯函数, 单测覆盖): 剔除 ST 内置 Default / 备份工具生成的 .bak- 副本 / __ 前缀测试遗留
function _connPresetVisible(name) {
    return typeof name === 'string' && name !== '' && name !== 'Default' && !name.includes('.bak-') && !name.startsWith('__');
}
// 列出本地连接预设名（只列 OpenAI, 已过滤 Default/.bak-/__ 前缀）
// ⚠️ 实测 ST 返回: openai_settings = 字符串数组(每个是预设 JSON 文本), openai_setting_names = 同名索引数组, 两者一一对应!
async function _connPresetNamesOf(g) {
    const d = await fetchSettingsJson();
    const contents = d[g.key];
    const names = d[CONN_NAME_KEY[g.key]];
    // names(数组, 一一对应) 优先; 否则从 contents(字符串) parse name
    if (Array.isArray(names)) return names.filter(Boolean).filter(_connPresetVisible);
    if (Array.isArray(contents)) {
        const out = [];
        contents.forEach(s => { try { const o = JSON.parse(s); if (o && o.name) out.push(o.name); } catch {} });
        return out.filter(_connPresetVisible);
    }
    return [];
}
const CONN_NAME_KEY = {
    openai_settings: 'openai_setting_names',
    novelai_settings: 'novelai_setting_names',
    koboldai_settings: 'koboldai_setting_names',
    textgenerationwebui_presets: 'textgenerationwebui_preset_names',
};
async function _connPresetLocalNames() {
    const out = [];
    for (const g of CONN_PRESET_GROUPS) out.push(...(await _connPresetNamesOf(g)));
    return out;
}
// ⚠️ 连接预设的"敏感/连接"字段(2026-08-24 用户真机反馈): ST 官方手动导入预设时默认弹窗"Remove them"移除的就是这些
// (openai.js:280 sensitiveFields)。同步默认同样剥离 —— 预设只带走提示词/参数, 不带走 URL/反代/请求头等连接设置。
// 官方"完整导出预设"时剔除的字段 = openai.js settingsToUpdate 中 is_connection=true 的全部 55 个
// (2026-08-24 与用户官方导出文件逐字段比对 100% 吻合: 本地有而导出没有的恰好这55个、一个不多不少;
//  原11个敏感字段已包含在内)。⚠️ extensions.regex_scripts(预设自带正则)不在清单 → 完整随预设同步。
const CONN_SENSITIVE_FIELDS = ['ai21_model','aimlapi_model','azure_api_version','azure_base_url','azure_deployment_name','azure_openai_model','bypass_status_check','chat_completion_source','chutes_model','claude_model','cohere_model','cometapi_model','custom_exclude_body','custom_include_body','custom_include_headers','custom_model','custom_prompt_post_processing','custom_url','deepseek_model','electronhub_model','fireworks_model','google_model','groq_model','group_models','minimax_endpoint','minimax_model','mistralai_model','moonshot_model','nanogpt_model','nanogpt_payg_override','nanogpt_provider','openai_model','openrouter_allow_fallbacks','openrouter_middleout','openrouter_model','openrouter_providers','openrouter_quantizations','openrouter_use_fallback','perplexity_model','pollinations_model','proxy_password','reverse_proxy','show_external_models','siliconflow_endpoint','siliconflow_model','sort_models','vertexai_auth_mode','vertexai_express_project_id','vertexai_model','vertexai_region','workers_ai_account_id','workers_ai_model','xai_model','zai_endpoint','zai_model'];
// 返回剥离敏感字段后的浅拷贝(不改原对象); 第二返回值=是否剥掉了字段(用于云端旧数据清洗)
function stripPresetSensitiveFields(preset) {
    const o = { ...(preset || {}) };
    let stripped = false;
    for (const f of CONN_SENSITIVE_FIELDS) { if (f in o) { delete o[f]; stripped = true; } }
    return [o, stripped];
}
// 读某个本地连接预设的完整内容（按 api 分组 + 名字）→ 返回对象
async function _getLocalConnPreset(apiId, name) {
    // ⚠️ 2026-08-25 修(用户手机端实测): 数据源优先用前端活列表 getPresetManager —— 官方删除/新增都会同步内存,
    // 而 settings.json 的名单是持久快照, 删除预设后快照仍列着旧名 → 插件误判"本地已有"→误弹冲突窗
    const g = CONN_PRESET_GROUPS.find(x => x.apiId === apiId);
    if (!g) return null;
    try {
        const pm = getContext().getPresetManager && getContext().getPresetManager(apiId);
        if (pm) {
            const { presets, preset_names } = pm.getPresetList(apiId);
            const has = Array.isArray(preset_names) ? preset_names.includes(name) : (name in preset_names);
            const idx = Array.isArray(preset_names) ? preset_names.indexOf(name) : preset_names[name];
            if (has && presets[idx]) return presets[idx];
            if (!has) return null; // 活列表确认没有 → 真没有
        }
    } catch { }
    // 回退: settings 快照(ST 直驱场景)
    const d = await fetchSettingsJson();
    const contents = d[g.key];
    const names = d[CONN_NAME_KEY[g.key]];
    if (Array.isArray(contents)) {
        if (Array.isArray(names)) {
            const i = names.indexOf(name);
            if (i >= 0 && contents[i]) { try { return JSON.parse(contents[i]); } catch { return null; } }
        } else {
            for (const s of contents) { try { const o = JSON.parse(s); if (o && o.name === name) return o; } catch {} }
        }
    }
    return null;
}
// 上传选中连接预设到云端（增量: 云端===本地跳过; 云端被另一端改过→跳过覆盖保留云端版，与世界书 decideWorldUpload 同守卫）
async function pushSelectedConnPresets(items) { // items: [{apiId, name}]
    if (!Array.isArray(items) || !items.length) { toastr.warning('未选择要上传的预设'); return null; }
    __lastSettingsData = null; // 本地状态判定必须基于实时数据(缓存会漏掉刚删除/新增的预设)
    if (!__csTryBusy()) { toastr.warning('已有同步在进行中'); return null; }
    try {
        const ok = [], skipped = [], skippedManual = [], fail = []; const failReasons = [];
        showBusy(0, items.length, '上传预设');
        for (let i = 0; i < items.length; i++) {
        showBusy(i + 1, items.length, `上传预设 ${items[i] && items[i].name || '未命名'}…`);
            const { apiId, name } = items[i];
            showBusy(i + 1, items.length, `上传预设 ${name}`);
            try {
                const raw = await _getLocalConnPreset(apiId, name);
                if (!raw) { fail.push(name); failReasons.push({ name, reason: '本地无该预设' }); continue; }
                const [preset] = stripPresetSensitiveFields(raw); // 默认剥离连接/敏感字段(同 ST 官方导入默认)
                const g = CONN_PRESET_GROUPS.find(x => x.apiId === apiId);
                const p = `${g.cloudDir}/${name}.json`;
                const cloud = await Gitee.getText(p);
                const text = JSON.stringify(preset);
                if (cloud && String(cloud.content) === String(text)) { skipped.push(name); settings.lastCloudSha[p] = cloud.sha; continue; }
                // 【清洗优先于守卫】云端旧数据带敏感字段但剥离后与本地一致 → 不是内容冲突, 直接重传清洗版
                if (cloud) {
                    try {
                        const [cloudPreset, cloudDirty] = stripPresetSensitiveFields(JSON.parse(cloud.content));
                        if (cloudDirty && jsonStableString(cloudPreset) === jsonStableString(preset)) {
                            settings.lastCloudSha[p] = (await Gitee.putText(p, text, cloud.sha, `sync conn preset ${name} (clean sensitive)`)) || settings.lastCloudSha[p];
                            ok.push(name); continue;
                        }
                    } catch { }
                }
                // 云端在上次同步后被另一端改过 → 不静默覆盖（保留云端版，想用云端就先"导入"它）
                const rememberSha = settings.lastCloudSha ? settings.lastCloudSha[p] : undefined;
                if (cloud && rememberSha && rememberSha !== cloud.sha) { fail.push(name); failReasons.push({ name, reason: '云端已被另一端修改，已跳过覆盖（可先导入选中）' }); continue; }
                settings.lastCloudSha[p] = (await Gitee.putText(p, text, cloud?.sha, `sync conn preset ${name}`)) || settings.lastCloudSha[p];
                ok.push(name);
            } catch (e) { fail.push(name); failReasons.push({ name, reason: (e && e.message) || String(e) }); }
        }
        hideBusy();
        saveSettingsDebounced(); // 落盘 lastCloudSha 记忆
        toastr.info(`上传预设：成功 ${ok.length} / 共 ${items.length}${skipped.length ? `，已最新跳过 ${skipped.length}` : ''}${fail.length ? `，失败 ${fail.length}` : ''}${failReasons.length ? `（${csShortList(failReasons.map(x => `${x.name}:${x.reason}`))}）` : ''}`);
        return { ok: ok.length, fail: fail.length, skipped: skipped.length, failReasons };
    } finally { __csReleaseBusy(); }
}
// 导入选中连接预设从云端（内容一致自动跳过；不同 → 替换/统统替换/另存副本/统统另存副本）
// ============ 分项导入冲突抉择（2026-08-22 用户要求：指纹比对，内容不同才问，可批量统一） ============
const CFG_IMPORT_OVERWRITE = 3201, CFG_IMPORT_COPY = 3202, CFG_IMPORT_CANCEL = 3203, CFG_IMPORT_ALL_OVERWRITE = 3301, CFG_IMPORT_ALL_COPY = 3302;
async function resolveCfgImportConflict(categoryLabel, name, batchMode) {
    if (batchMode && batchMode.applyAll) return batchMode.decision;
    const choice = await Popup.show.confirm(
        `⚠️ 本地和云端的${categoryLabel}「${escapeHtml(name)}」内容不一样`,
        `同一个名字，但内容有差异（已做内容指纹比对，不会无脑覆盖）。<br><br><b>「另存副本」</b>＝把云端这份用新名字存进来（如「${escapeHtml(name)} (云端)」），两份都保留，谁都不丢。<br>处理多个冲突时选「统统」，本次就不会再逐个问了。`,
        {
            defaultResult: CFG_IMPORT_COPY,
            okButton: false,
            cancelButton: false,
            customButtons: [
                { text: '✅ 统统替换（本次全部用云端覆盖本地）', result: CFG_IMPORT_ALL_OVERWRITE, classes: ['popup-button-ok'] },
                { text: '✅ 统统另存副本（本次全部两份都留）', result: CFG_IMPORT_ALL_COPY, classes: ['popup-button-ok'] },
                { text: '替换（仅这个，用云端覆盖本地）', result: CFG_IMPORT_OVERWRITE, classes: ['popup-button-cancel'] },
                { text: '另存副本（仅这个，两份都留）', result: CFG_IMPORT_COPY, classes: ['popup-button-cancel'] },
                { text: '✕ 跳过（不处理这个，两边都不动）', result: CFG_IMPORT_CANCEL, classes: ['popup-button-cancel'] },
            ],
        },
    );
    if (choice === CFG_IMPORT_ALL_OVERWRITE) { batchMode.applyAll = true; batchMode.decision = 'overwrite'; return 'overwrite'; }
    if (choice === CFG_IMPORT_ALL_COPY) { batchMode.applyAll = true; batchMode.decision = 'copy'; return 'copy'; }
    if (choice === CFG_IMPORT_OVERWRITE) return 'overwrite';
    if (choice === CFG_IMPORT_COPY) return 'copy';
    return 'cancel';
}
// 唯一命名(ST 惯例 (N))：base 被占 → 「base (云端)」→「base (云端) (2)」…；exists(name)=是否已占用
function uniqueCfgName(base, exists) {
    if (!exists(base)) return base;
    let n = `${base} (云端)`;
    if (!exists(n)) return n;
    let i = 2;
    while (exists(`${n} (${i})`)) i++;
    return `${n} (${i})`;
}
async function importSelectedConnPresets(items) { // items: [{apiId, name}]
    if (!Array.isArray(items) || !items.length) { toastr.warning('未选择要导入的预设'); return null; }
    __lastSettingsData = null; // 同上
    if (!__csTryBusy()) { toastr.warning('已有同步在进行中'); return null; }
    try {
        const ok = [], skipped = [], skippedManual = [], fail = []; const failReasons = [];
        const batchMode = { applyAll: false, decision: null };
        showBusy(0, items.length, '导入预设');
        for (let i = 0; i < items.length; i++) {
        showBusy(i + 1, items.length, `导入预设 ${items[i] && items[i].name || '未命名'}…`);
            const { apiId, name } = items[i];
            showBusy(i + 1, items.length, `导入预设 ${name}`);
            try {
                const g = CONN_PRESET_GROUPS.find(x => x.apiId === apiId);
                if (!g) { fail.push(name); failReasons.push({ name, reason: '仅支持 OpenAI 预设' }); continue; }
                const p = `${g.cloudDir}/${name}.json`;
                const cloud = await Gitee.getText(p);
                if (!cloud) { fail.push(name); failReasons.push({ name, reason: '云端无该预设' }); continue; }
                const [preset] = stripPresetSensitiveFields(JSON.parse(cloud.content)); // 导入同样剥离(防夹带连接设置)
                // 不添加 name 字段 —— 保持与官方完整导出逐字段一致(官方导出也不带 name, 文件名即预设名)
                // 指纹比对(两边都按剥离后比)：本地已有且内容一致 → 跳过；内容不同 → 替换/统统替换/另存副本/统统另存副本
                let saveName = name;
                const rawLocal = await _getLocalConnPreset(apiId, name);
                const [localPreset] = stripPresetSensitiveFields(rawLocal);
                if (rawLocal && jsonStableString(localPreset) === jsonStableString(preset)) { skipped.push(name); continue; }
                if (rawLocal) {
                    // ⚠️ 判定必须用 rawLocal(本地是否真有): strip 对 null 返回 {}(truthy), 用 localPreset 判会把"本地没有"误判成"有"(2026-08-25 用户实测抓到)
                    const decision = await resolveCfgImportConflict('预设', name, batchMode);
                    if (decision === 'cancel') { skippedManual.push(name); continue; }
                    if (decision === 'copy') {
                        // ⚠️ copy 语义=必须新名字, 绝不返回原名 —— uniqueCfgName 的"原名可用返回原名"在
                        // 设置快照漏报新预设名时会误判(2026-08-24 QA 实证: 快照不含新造文件 → 覆盖回原名)
                        const names = await _connPresetNamesOf(g);
                        let n = `${name} (云端)`, k = 2;
                        while (names.includes(n)) { n = `${name} (云端) (${k})`; k++; }
                        saveName = n;
                    }
                }
                const resp = await fetch('/api/presets/save', { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify({ apiId, name: saveName, preset }) }); // name=最终落盘名(另存副本时=「xx (云端)」, 其余=原名); preset体内不带name保持官方导出形态
                if (!resp.ok) { fail.push(name); failReasons.push({ name, reason: '写回失败 HTTP ' + resp.status }); continue; }
                // 官方 onPresetImportFileChange 同款: 同步前端内存数组+下拉框 —— 导入后无需刷新页面
                try {
                    const pm = getContext().getPresetManager && getContext().getPresetManager(apiId);
                    if (pm) {
                        const { presets, preset_names } = pm.getPresetList(apiId);
                        // ⚠️ 前端 openai 的 preset_names 是对象({名:序号}); 其它 api 可能是数组 —— 兼容两种形态
                        const has = Array.isArray(preset_names) ? preset_names.includes(saveName) : (saveName in preset_names);
                        if (!has) {
                            presets.push(preset);
                            preset_names[saveName] = presets.length - 1;
                            const sel2 = document.querySelector('#settings_preset_openai');
                            if (sel2) sel2.append(new Option(saveName, String(presets.length - 1)));
                        }
                    }
                } catch (e) { console.warn('[chat-sync] 同步前端预设列表失败(不影响落盘)', e); }
                ok.push(saveName === name ? name : `${name}→另存「${saveName}」`); __lastSettingsData = null; // 失效缓存, 下次重读
            } catch (e) { fail.push(name); failReasons.push({ name, reason: (e && e.message) || String(e) }); }
        }
        saveSettingsDebounced();
        hideBusy();
        toastr.info(`导入预设：成功 ${ok.length} / 共 ${items.length}${skipped.length ? `，已最新跳过 ${skipped.length}` : ''}${skippedManual.length ? `，手动跳过 ${skippedManual.length}（${csShortList(skippedManual)}）` : ''}${fail.length ? `，失败 ${fail.length}` : ''}${failReasons.length ? `（${csShortList(failReasons.map(x => `${x.name}:${x.reason}`))}）` : ''}`);
        return { ok: ok.length, fail: fail.length, skipped: skipped.length, failReasons };
    } finally { __csReleaseBusy(); }
}
// 删除选中连接预设（本地→/api/presets/delete；云端→Gitee.deleteFile）
async function deleteSelectedConnPresets(items, mode) {
    mode = mode || 'local';
    if (!Array.isArray(items) || !items.length) return null;
    const ok = [], fail = []; const failReasons = [];
    for (let i = 0; i < items.length; i++) {
        const { apiId, name } = items[i];
        try {
            if (mode === 'cloud') {
                const g = CONN_PRESET_GROUPS.find(x => x.apiId === apiId);
                if (!g) { fail.push(name); failReasons.push({ name, reason: '仅支持 OpenAI 预设' }); continue; }
                const p = `${g.cloudDir}/${name}.json`;
                const c = await Gitee.getText(p);
                if (!c) { fail.push(name); failReasons.push({ name, reason: '云端无该预设' }); continue; }
                await Gitee.deleteFile(p, c.sha, `delete conn preset ${name}`);
            } else {
                // 优先走官方前端入口 presetManager.deletePreset —— 同一个服务器接口之外还会:
                // 移除下拉框选项 + 同步前端内存数组 + 删当前选中时自动切换(裸调接口会留下界面/内存残留, 刷新前"看起来还在")
                let okDel = false;
                try {
                    const pm = getContext().getPresetManager && getContext().getPresetManager(apiId);
                    if (pm && typeof pm.deletePreset === 'function') okDel = await pm.deletePreset(name);
                } catch (e) { console.warn('[chat-sync] 官方入口删除失败, 回退裸接口', name, e); }
                if (!okDel) {
                    const resp = await fetch('/api/presets/delete', { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify({ apiId, name }) });
                    if (!resp.ok) { fail.push(name); failReasons.push({ name, reason: '删除失败 HTTP ' + resp.status }); continue; }
                }
                // ⚠️ TT 的 /api/presets/delete 恒返回成功(内核可能没删掉, 如名字含特殊字符/中文) → 回读实时目录验证,
                //    删没删掉如实报告, 避免"假成功"导致后续导入误弹冲突窗(2026-08-25 用户手机端实测踩坑)
                const after = await fetchSettingsJson(true);
                const g2 = CONN_PRESET_GROUPS.find(x => x.apiId === apiId);
                if (Array.isArray(after[CONN_NAME_KEY[g2.key]]) && after[CONN_NAME_KEY[g2.key]].includes(name)) {
                    fail.push(name); failReasons.push({ name, reason: '删除未生效（接口说成功但文件仍在——请用酒馆自带预设管理删除这个）' }); continue;
                }
            }
            ok.push(name);
        } catch (e) { fail.push(name); failReasons.push({ name, reason: (e && e.message) || String(e) }); }
    }
    if (mode === 'local') { saveSettingsDebounced(); __lastSettingsData = null; }
    return { ok: ok.length, fail: fail.length, failReasons };
}

// ============ 分项② Themes（主题） ============
const THEME_CLOUD_DIR = 'config-sync/themes';
// 本地主题列表：/api/settings/get 的 themes 数组（{name,...} 或 {name,custom_css}）
async function _themeLocalList() {
    const d = await fetchSettingsJson();
    const arr = d.themes;
    if (!Array.isArray(arr)) return [];
    return arr.map(t => ({ name: (t && t.name) || '', data: t }));
}
async function pushSelectedThemes(names) {
    if (!Array.isArray(names) || !names.length) { toastr.warning('未选择要上传的主题'); return null; }
    if (!__csTryBusy()) { toastr.warning('已有同步在进行中'); return null; }
    try {
        const ok = [], skipped = [], skippedManual = [], fail = []; const failReasons = [];
        const local = await _themeLocalList();
        showBusy(0, names.length, '上传主题');
        for (let i = 0; i < names.length; i++) {
        showBusy(i + 1, names.length, `上传主题 ${names[i]}…`);
            const name = names[i];
            showBusy(i + 1, names.length, `上传主题 ${name}`);
            try {
                const item = local.find(t => t.name === name);
                if (!item) { fail.push(name); failReasons.push({ name, reason: '本地无该主题' }); continue; }
                const p = `${THEME_CLOUD_DIR}/${name}.json`;
                const cloud = await Gitee.getText(p);
                const text = JSON.stringify(item.data);
                if (cloud && String(cloud.content) === String(text)) { skipped.push(name); settings.lastCloudSha[p] = cloud.sha; continue; }
                // 云端被另一端改过 → 不静默覆盖（同连接预设守卫）
                const rememberSha = settings.lastCloudSha ? settings.lastCloudSha[p] : undefined;
                if (cloud && rememberSha && rememberSha !== cloud.sha) { fail.push(name); failReasons.push({ name, reason: '云端已被另一端修改，已跳过覆盖（可先导入选中）' }); continue; }
                settings.lastCloudSha[p] = (await Gitee.putText(p, text, cloud?.sha, `sync theme ${name}`)) || settings.lastCloudSha[p];
                ok.push(name);
            } catch (e) { fail.push(name); failReasons.push({ name, reason: (e && e.message) || String(e) }); }
        }
        hideBusy();
        saveSettingsDebounced(); // 落盘 lastCloudSha 记忆
        toastr.info(`上传主题：成功 ${ok.length} / 共 ${names.length}${skipped.length ? `，已最新跳过 ${skipped.length}` : ''}${fail.length ? `，失败 ${fail.length}` : ''}${failReasons.length ? `（${csShortList(failReasons.map(x => `${x.name}:${x.reason}`))}）` : ''}`);
        return { ok: ok.length, fail: fail.length, skipped: skipped.length, failReasons };
    } finally { __csReleaseBusy(); }
}
// ── 官方「删除主题」按钮触发法: 选中目标 → 点 #ui-preset-delete-button(deleteTheme) → 自动确认 ──
// deleteTheme(power-user.js:2389) 删 power_user.theme(当前选中) 并完整同步: 内存数组/下拉选项/应用下一主题/保存
// 返回 true=文件已消失(回读验证)
async function __officialDeleteThemeFlow(name) {
    const $themesEl = window.jQuery ? jQuery('#themes') : null;
    if (!$themesEl) return false;
    if (!$themesEl.find(`option[value="${name}"]`).length) {
        $themesEl.append(new Option(name, name)); // 官方「保存主题」不更新界面下拉, 缺就补
    }
    $themesEl.val(name).trigger('change');
    power_user.theme = name; // ⚠️ deleteTheme 删的是 power_user.theme, 仅 trigger('change') 不一定同步(QA实证请求0次)
    await new Promise(r => setTimeout(r, 400));
    const delBtn = document.querySelector('#ui-preset-delete-button');
    if (!delBtn) return false;
    delBtn.click();
    let confirmed = false;
    for (let t = 0; t < 10 && !confirmed; t++) {
        await new Promise(r => setTimeout(r, 300));
        // ⚠️ 用 .popup-button-ok 精确匹配: 模板里另有 data-result=1 的非按钮控件, 泛选会点错(QA实证)
        const pd = [...document.querySelectorAll('dialog')].find(x => x.open);
        const okBtn = pd ? pd.querySelector('.popup-button-ok.result-control') : null;
        if (okBtn) { okBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); confirmed = true; }
    }
    if (!confirmed) return false;
    for (let t = 0; t < 5; t++) {
        await new Promise(r => setTimeout(r, 600));
        try { const d2 = await fetchSettingsJson(true); if (!Array.isArray(d2.themes) || !d2.themes.some(t2 => t2 && t2.name === name)) return true; } catch { }
    }
    return false;
}
// ── 官方「导入主题」文件框触发法: #ui_preset_import_file(change) → importTheme(power-user.js:2443) ──
// importTheme 完整同步: 内存数组 push + saveTheme 写文件 + 下拉 append + 保存; 重名/@import 会抛错
// 返回 true=主题已出现在实时列表(回读验证)
async function __officialImportThemeFlow(jsonText, themeName) {
    const input = document.querySelector('#ui_preset_import_file');
    if (!input) return false;
    const file = new File([jsonText], themeName + '.json', { type: 'application/json' });
    const dt = new DataTransfer(); dt.items.add(file);
    input.files = dt.files;
    // 官方 @import 警告弹窗(如有)自动确认
    const autoOk = setInterval(() => {
        const pd = [...document.querySelectorAll('dialog')].find(x => x.open);
        const okBtn = pd ? pd.querySelector('.popup-button-ok.result-control') : null;
        if (okBtn) okBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    }, 300);
    try {
        input.dispatchEvent(new Event('change', { bubbles: true }));
        for (let t = 0; t < 20; t++) {
            await new Promise(r => setTimeout(r, 500));
            try { const d2 = await fetchSettingsJson(true); if (Array.isArray(d2.themes) && d2.themes.some(t2 => t2 && t2.name === themeName)) return true; } catch { }
        }
        return false;
    } finally { clearInterval(autoOk); }
}
async function deleteSelectedThemes(names, mode) {
    mode = mode || 'local';
    if (!Array.isArray(names) || !names.length) return null;
    let prevTheme = null; // 批量删完恢复用户原主题选中
    try { const tEl = document.querySelector('#themes'); if (tEl && tEl.value) prevTheme = tEl.value; } catch { }
    const ok = [], fail = []; const failReasons = [];
    for (let i = 0; i < names.length; i++) {
        const name = names[i];
        try {
            if (mode === 'cloud') {
                const p = `${THEME_CLOUD_DIR}/${name}.json`;
                const c = await Gitee.getText(p);
                if (!c) { fail.push(name); failReasons.push({ name, reason: '云端无该主题' }); continue; }
                await Gitee.deleteFile(p, c.sha, `delete theme ${name}`);
            } else {
                const gone = await __officialDeleteThemeFlow(name);
                if (!gone) { fail.push(name); failReasons.push({ name, reason: '删除未生效（官方按钮流程后文件仍在）' }); continue; }
            }
            ok.push(name);
        } catch (e) { fail.push(name); failReasons.push({ name, reason: (e && e.message) || String(e) }); }
    }
    if (mode === 'local') { saveSettingsDebounced(); __lastSettingsData = null; }
    return { ok: ok.length, fail: fail.length, failReasons };
}
async function importSelectedThemes(names) {
    if (!Array.isArray(names) || !names.length) { toastr.warning('未选择要导入的主题'); return null; }
    if (!__csTryBusy()) { toastr.warning('已有同步在进行中'); return null; }
    try {
        const ok = [], skipped = [], skippedManual = [], fail = []; const failReasons = [];
        const batchMode = { applyAll: false, decision: null };
        showBusy(0, names.length, '导入主题');
        for (let i = 0; i < names.length; i++) {
        showBusy(i + 1, names.length, `导入主题 ${names[i]}…`);
            const name = names[i];
            showBusy(i + 1, names.length, `导入主题 ${name}`);
            try {
                const p = `${THEME_CLOUD_DIR}/${name}.json`;
                const cloud = await Gitee.getText(p);
                if (!cloud) { fail.push(name); failReasons.push({ name, reason: '云端无该主题' }); continue; }
                const theme = JSON.parse(cloud.content);
                if (!theme.name) theme.name = name;
                // 指纹比对：一致跳过；不同 → 冲突抉择(替换/统统替换/另存副本/统统另存副本/跳过)
                const local = await _themeLocalList();
                const localTheme = local.find(t => t.name === name);
                if (localTheme && jsonStableString(localTheme.data) === jsonStableString(theme)) { skipped.push(name); continue; }
                let importName = name;
                let needDeleteFirst = false;
                if (localTheme) {
                    const decision = await resolveCfgImportConflict('主题', name, batchMode);
                    if (decision === 'cancel') { skippedManual.push(name); continue; }
                    if (decision === 'copy') {
                        importName = uniqueCfgName(name, (n) => local.some(t => t.name === n));
                    } else {
                        needDeleteFirst = true; // 替换: 官方导入重名会抛错 → 先走官方删除流再导
                    }
                }
                // 官方入口导入(file-input 触发 importTheme): 内存/下拉/文件全官方同步
                if (needDeleteFirst) {
                    const gone = await __officialDeleteThemeFlow(name);
                    if (!gone) console.warn('[chat-sync] 替换前删除旧主题未确认, 继续尝试导入');
                }
                const imported = await __officialImportThemeFlow(JSON.stringify(theme), importName);
                if (!imported) { fail.push(name); failReasons.push({ name, reason: '官方导入未完成（可能重名或弹窗超时）' }); continue; }
                ok.push(importName === name ? name : `${name}→另存「${importName}」`); __lastSettingsData = null;
            } catch (e) { fail.push(name); failReasons.push({ name, reason: (e && e.message) || String(e) }); }
        }
        hideBusy();
        toastr.info(`导入主题：成功 ${ok.length} / 共 ${names.length}${skipped.length ? `，已最新跳过 ${skipped.length}` : ''}${skippedManual.length ? `，手动跳过 ${skippedManual.length}（${csShortList(skippedManual)}）` : ''}${fail.length ? `，失败 ${fail.length}（${csShortList(failReasons.map(x => `${x.name}:${x.reason}`))}）` : ''}`);
        return { ok: ok.length, fail: fail.length, skipped: skipped.length, failReasons };
    } finally { __csReleaseBusy(); }
}

// ============ 分项③ 全局正则（settings.json 的 extension_settings.regex） ============
const REGEX_CLOUD_DIR = 'config-sync/regex';
// 从 /api/settings/get 的 d.settings(字符串) 解析出 settings 对象；插件侧 settings(extension_settings 容器) 与其同步
async function _parseSettingsObj() {
    const d = await fetchSettingsJson();
    if (d && typeof d.settings === 'string') {
        try { return JSON.parse(d.settings); } catch { return null; }
    }
    return d && typeof d.settings === 'object' && d.settings !== null ? d.settings : null;
}
async function _regexLocalList() {
    const o = await _parseSettingsObj();
    const arr = o && o.extension_settings && o.extension_settings.regex;
    if (!Array.isArray(arr)) return [];
    return arr.map(r => ({ name: (r && (r.scriptName || r.id)) || '', data: r }));
}
async function pushSelectedRegex(names) {
    if (!Array.isArray(names) || !names.length) { toastr.warning('未选择要上传的正则'); return null; }
    if (!__csTryBusy()) { toastr.warning('已有同步在进行中'); return null; }
    try {
        const ok = [], skipped = [], skippedManual = [], fail = []; const failReasons = [];
        const local = await _regexLocalList();
        showBusy(0, names.length, '上传全局正则');
        for (let i = 0; i < names.length; i++) {
        showBusy(i + 1, names.length, `上传正则 ${names[i]}…`);
            const name = names[i];
            showBusy(i + 1, names.length, `上传正则 ${name}`);
            try {
                const item = local.find(r => r.name === name);
                if (!item) { fail.push(name); failReasons.push({ name, reason: '本地无该正则' }); continue; }
                const p = `${REGEX_CLOUD_DIR}/${name}.json`;
                const cloud = await Gitee.getText(p);
                const text = JSON.stringify(item.data);
                if (cloud && String(cloud.content) === String(text)) { skipped.push(name); settings.lastCloudSha[p] = cloud.sha; continue; }
                // 云端被另一端改过 → 不静默覆盖（同连接预设守卫）
                const rememberSha = settings.lastCloudSha ? settings.lastCloudSha[p] : undefined;
                if (cloud && rememberSha && rememberSha !== cloud.sha) { fail.push(name); failReasons.push({ name, reason: '云端已被另一端修改，已跳过覆盖（可先导入选中）' }); continue; }
                settings.lastCloudSha[p] = (await Gitee.putText(p, text, cloud?.sha, `sync regex ${name}`)) || settings.lastCloudSha[p];
                ok.push(name);
            } catch (e) { fail.push(name); failReasons.push({ name, reason: (e && e.message) || String(e) }); }
        }
        hideBusy();
        saveSettingsDebounced(); // 落盘 lastCloudSha 记忆
        toastr.info(`上传全局正则：成功 ${ok.length} / 共 ${names.length}${skipped.length ? `，已最新跳过 ${skipped.length}` : ''}${fail.length ? `，失败 ${fail.length}` : ''}${failReasons.length ? `（${csShortList(failReasons.map(x => `${x.name}:${x.reason}`))}）` : ''}`);
        return { ok: ok.length, fail: fail.length, skipped: skipped.length, failReasons };
    } finally { __csReleaseBusy(); }
}
async function importSelectedRegex(names) {
    if (!Array.isArray(names) || !names.length) { toastr.warning('未选择要导入的正则'); return null; }
    if (!__csTryBusy()) { toastr.warning('已有同步在进行中'); return null; }
    try {
        const ok = [], skipped = [], skippedManual = [], fail = []; const failReasons = [];
        const batchMode = { applyAll: false, decision: null };
        showBusy(0, names.length, '导入全局正则');
        for (let i = 0; i < names.length; i++) {
        showBusy(i + 1, names.length, `导入正则 ${names[i]}…`);
            const name = names[i];
            showBusy(i + 1, names.length, `导入正则 ${name}`);
            try {
                const p = `${REGEX_CLOUD_DIR}/${name}.json`;
                const cloud = await Gitee.getText(p);
                if (!cloud) { fail.push(name); failReasons.push({ name, reason: '云端无该正则' }); continue; }
                const script = JSON.parse(cloud.content);
                // 直接改页面的全局 extension_settings.regex(活对象) → saveSettingsDebounced 让酒馆自己带版本号保存。
                // ⚠️ 不用 /api/settings/save 整包写：TT 有"Settings changed outside this page"版本守卫会拒写(2026-08-22 用户真机踩坑)，
                //    且整包写会用插件读到的旧快照盖掉页面未保存的其它设置。
                if (!Array.isArray(extension_settings.regex)) extension_settings.regex = [];
                const arr = extension_settings.regex;
                const key = script.scriptName || script.id || name;
                const existingIdx = arr.findIndex(r => (r.scriptName === key) || (r.id === key));
                let savedAs = key;
                if (existingIdx >= 0) {
                    // 指纹比对：一致跳过；不同 → 替换/统统替换/另存副本/统统另存副本
                    if (jsonStableString(arr[existingIdx]) === jsonStableString(script)) { skipped.push(name); continue; }
                    const decision = await resolveCfgImportConflict('全局正则', key, batchMode);
                    if (decision === 'cancel') { skippedManual.push(name); continue; }
                    if (decision === 'copy') {
                        savedAs = uniqueCfgName(key, (n) => arr.some(r => (r.scriptName === n) || (r.id === n)));
                        script.scriptName = savedAs; if (script.id !== undefined) script.id = savedAs;
                        arr.push(script);
                    } else arr[existingIdx] = script;
                } else arr.push(script);
                ok.push(savedAs === key ? key : `${key}→另存「${savedAs}」`); __lastSettingsData = null;
            } catch (e) { fail.push(name); failReasons.push({ name, reason: (e && e.message) || String(e) }); }
        }
        saveSettingsDebounced(); // 官方保存路径：页面活设置 + 正确版本号(ST/TT 通用)
        saveSettingsDebounced();
        hideBusy();
        toastr.info(`导入全局正则：成功 ${ok.length} / 共 ${names.length}${skipped.length ? `，已最新跳过 ${skipped.length}` : ''}${skippedManual.length ? `，手动跳过 ${skippedManual.length}（${csShortList(skippedManual)}）` : ''}${fail.length ? `，失败 ${fail.length}` : ''}${failReasons.length ? `（${csShortList(failReasons.map(x => `${x.name}:${x.reason}`))}）` : ''}`);
        return { ok: ok.length, fail: fail.length, skipped: skipped.length, failReasons };
    } finally { __csReleaseBusy(); }
}
async function deleteSelectedRegex(names, mode) {
    mode = mode || 'local';
    if (!Array.isArray(names) || !names.length) return null;
    const ok = [], fail = []; const failReasons = [];
    for (let i = 0; i < names.length; i++) {
        const name = names[i];
        try {
            if (mode === 'cloud') {
                const p = `${REGEX_CLOUD_DIR}/${name}.json`;
                const c = await Gitee.getText(p);
                if (!c) { fail.push(name); failReasons.push({ name, reason: '云端无该正则' }); continue; }
                await Gitee.deleteFile(p, c.sha, `delete regex ${name}`);
            } else {
                // ⚠️ 2026-08-25 修(与导入同款历史BUG): 旧版写进插件自身命名空间(st_chat_sync.extension_settings.regex)
                // 从不落盘 —— 正则本地删除从未生效过。改为直接改页面全局活对象 + saveSettingsDebounced 官方保存。
                if (!Array.isArray(extension_settings.regex)) extension_settings.regex = [];
                const arr = extension_settings.regex;
                const idx = arr.findIndex(r => (r.scriptName === name) || (r.id === name));
                if (idx < 0) { fail.push(name); failReasons.push({ name, reason: '本地无该正则' }); continue; }
                arr.splice(idx, 1);
                // 落盘验证(saveSettingsDebounced 是防抖保存, 循环等待落盘后回读)
                let verified = false;
                for (let t = 0; t < 5 && !verified; t++) {
                    await new Promise(r2 => setTimeout(r2, 800));
                    try {
                        const d2 = await fetchSettingsJson(true);
                        const o2 = JSON.parse(d2.settings);
                        const arr2 = (o2 && o2.extension_settings && o2.extension_settings.regex) || [];
                        verified = !arr2.some(r2b => (r2b.scriptName === name) || (r2b.id === name));
                    } catch { }
                }
                if (!verified) { fail.push(name); failReasons.push({ name, reason: '删除未生效（落盘验证失败，请重试或用酒馆正则编辑器删除）' }); continue; }
            }
            ok.push(name);
        } catch (e) { fail.push(name); failReasons.push({ name, reason: (e && e.message) || String(e) }); }
    }
    if (mode === 'local') { saveSettingsDebounced(); __lastSettingsData = null; }
    return { ok: ok.length, fail: fail.length, failReasons };
}

// ============ 分项④ User（资料 + 头像）备份/恢复 ============
const USER_CLOUD_DIR = 'config-sync/user';
async function _userPersonaList() {
    const d = await fetchSettingsJson();
    // 用户资料：settings.personas 或 user_settings；取 persona 名
    const personas = d.personas;
    const names = [];
    if (Array.isArray(personas)) personas.forEach(p => { if (p && p.name) names.push(p.name); });
    return names;
}
// 备份整个 User（资料 + 头像）→ 存云端（一个 user.json 含资料+头像名）
async function backupUserToCloud() {
    if (!settings.owner || !settings.repo || !settings.token) { toastr.error('请先配置云端仓库'); return false; }
    if (!__csTryBusy()) { toastr.warning('已有同步在进行中'); return null; }
    try {
        const o = await _parseSettingsObj();
        // ⚠️ 人物资料真实位置(2026-08-22 用户真机踩坑修正): power_user.personas(头像文件→人设名 对照表) +
        //    power_user.persona_descriptions(人设描述) —— 顶层 personas 不存在, 旧版备份成空导致恢复出 Unnamed Persona
        const userData = {
            username: (o && o.username) || (o && o.user_name) || '',
            user_avatar: (o && o.user_avatar) || '',
            power_user: {
                personas: (o && o.power_user && o.power_user.personas) || {},
                persona_descriptions: (o && o.power_user && o.power_user.persona_descriptions) || {},
            },
        };
        await Gitee.putText(`${USER_CLOUD_DIR}/user.json`, JSON.stringify(userData, null, 2), (await Gitee.getText(`${USER_CLOUD_DIR}/user.json`))?.sha, 'sync user data');
        // 头像：读 /api/avatars/get 拿列表
        let avatars = [];
        try { const av = await fetch('/api/avatars/get', { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify({}) }); avatars = av.ok ? await av.json() : []; } catch {}
        if (!Array.isArray(avatars)) avatars = [];
        await Gitee.putText(`${USER_CLOUD_DIR}/avatars-list.json`, JSON.stringify({ files: avatars }, null, 2), (await Gitee.getText(`${USER_CLOUD_DIR}/avatars-list.json`))?.sha, 'sync avatars list');
        // 头像照片本体：/User Avatars/<名> 直读原图(实测 ST/TT 均 200, 原尺寸) → 与人设管理统一存 user/personas/
        // (thumbnail 只有 96x144 压缩版不能用; user-default.png 两端自带不必备份)
        let avOk = 0; const avFailNames = [];
        for (const name of avatars) {
            if (!name || name === 'user-default.png') continue;
            try {
                showBusy(avOk + 1, avatars.length, `备份头像 ${name}`);
                const r = await fetch(`/User Avatars/${encodeURIComponent(name)}`);
                if (!r.ok) { avFailNames.push(`${name}:读取HTTP${r.status}`); continue; }
                const b64 = await blobToBase64(await r.blob());
                const p = `${USER_CLOUD_DIR}/personas/${name}`;
                await Gitee.putBase64(p, b64, (await Gitee.getBase64(p))?.sha, `sync avatar ${name}`);
                // 同步写 meta.json(人设名/描述): 人设名存在每台设备各自的映射里, 手机端只有照片没有映射 → 云端meta是唯一跨端名字来源
                const puB = (o && o.power_user) || {};
                let meta = { name: (puB.personas && puB.personas[name]) || '', description: (puB.persona_descriptions && puB.persona_descriptions[name] && puB.persona_descriptions[name].description) || '' };
                const mpB = `${USER_CLOUD_DIR}/personas/${name}.meta.json`;
                const mcB = await Gitee.getText(mpB).catch(() => null);
                // 空值保留: 本地无名字/描述时保留云端现有 meta 对应字段(防把云端好数据洗成空 → 手机端又显示未命名)
                if ((!meta.name || !meta.description) && mcB && mcB.content) {
                    try { const om = JSON.parse(mcB.content); if (!meta.name && om.name) meta.name = om.name; if (!meta.description && om.description) meta.description = om.description; } catch { }
                }
                await Gitee.putText(mpB, JSON.stringify(meta, null, 2), mcB?.sha, `sync persona meta ${name}`);
                avOk++;
            } catch (e) { avFailNames.push(`${name}:${(e && e.message) || e}`); }
        }
        hideBusy();
        toastr.success(`✅ 已备份 User 资料 + 头像照片 ${avOk} 张${avFailNames.length ? `（照片失败 ${avFailNames.length}: ${avFailNames.join('、')}）` : ''} 到云端`);
        return true;
    } catch (e) { console.warn('[chat-sync] User 备份失败', e); hideBusy(); toastr.error('User 备份失败：' + (e.message || e)); return false; }
    finally { __csReleaseBusy(); }
}
// 恢复 User：从云端 user.json 读回资料(personas/user_avatar/user_name)→写回 settings(经 /api/settings/save)；头像照片本体经官方 /api/avatars/upload(overwrite_name) 自动放回
async function restoreUserFromCloud() {
    if (!settings.owner || !settings.repo || !settings.token) { toastr.error('请先配置云端仓库'); return false; }
    if (!__csTryBusy()) { toastr.warning('已有同步在进行中'); return null; }
    try {
        const c = await Gitee.getText(`${USER_CLOUD_DIR}/user.json`);
        if (!c) { toastr.error('云端没有 User 备份'); return false; }
        const ud = JSON.parse(c.content);
        // 头像照片本体：云端 user/avatars/ → 官方 /api/avatars/upload (overwrite_name 保持原文件名,
        // 设置里 user_avatar 引用的文件名才对得上; ST/TT 两端该接口均支持 overwrite_name, 源码已核实)
        // 兼容新旧目录: 新=personas/(与人设管理统一), 旧=avatars/(历史备份)
        let avEntries = [];
        for (const dir2 of [`${USER_CLOUD_DIR}/personas`, `${USER_CLOUD_DIR}/avatars`]) {
            try {
                const es = (await Gitee.listEntries(dir2)).filter((e) => e.type === 'file' && !e.name.endsWith('.meta.json'));
                if (es.length) { avEntries = es.map((e) => ({ ...e, __dir: dir2 })); break; }
            } catch { }
        }
        let avOk = 0; const avFailNames = [];
        for (const e of avEntries) {
            try {
                showBusy(avOk + 1, avEntries.length, `恢复头像 ${e.name}`);
                const cc = await Gitee.getBase64(e.__dir ? e.__dir + '/' + e.name : e.path);
                if (!cc || !cc.b64) { avFailNames.push(`${e.name}:云端无内容`); continue; }
                const file = base64ToFile(cc.b64, e.name, 'image/png');
                // 先解码出原图宽高, crop=全图+want_resize:false → ST 实测按原尺寸原样落盘(512x768/字节同原);
                // TT 内核无视 crop 仍归一到 400x600 标准头像尺寸(比例一致不变形, 头像按小图显示视觉无损), 属 TT 侧限制
                const bmp = await createImageBitmap(file);
                const cropParam = { x: 0, y: 0, width: bmp.width, height: bmp.height, want_resize: false };
                bmp.close?.();
                const fd = new FormData();
                fd.append('avatar', file);
                fd.append('overwrite_name', e.name);
                const r = await fetch('/api/avatars/upload?crop=' + encodeURIComponent(JSON.stringify(cropParam)), { method: 'POST', headers: getRequestHeaders({ omitContentType: true }), body: fd, cache: 'no-cache' });
                if (r.ok) avOk++; else avFailNames.push(`${e.name}:HTTP${r.status}`);
            } catch (e2) { avFailNames.push(`${e.name}:${(e2 && e2.message) || e2}`); }
        }
        const o = await _parseSettingsObj() || {};
        // 人物资料: power_user.personas(头像→人设名) + persona_descriptions, 只覆盖这两个子键, 不动 power_user 其它 UI 偏好
        const pu = ud.power_user || {};
        if (pu.personas && typeof pu.personas === 'object' && Object.keys(pu.personas).length) {
            o.power_user = o.power_user || {};
            o.power_user.personas = pu.personas;
            if (pu.persona_descriptions && typeof pu.persona_descriptions === 'object') o.power_user.persona_descriptions = pu.persona_descriptions;
        }
        if (ud.user_avatar) { o.user_avatar = ud.user_avatar; if (settings.user_avatar !== undefined) settings.user_avatar = ud.user_avatar; }
        const uname = ud.username || ud.user_name;
        if (uname) { o.username = uname; if (!(o.user_name)) o.user_name = uname; }
        // 写回 settings：经 /api/settings/save(整包) 最可靠；插件侧 key 同步
        const r = await fetch('/api/settings/save', { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify(o) });
        if (!r.ok) { toastr.error(`User 写回失败 HTTP ${r.status}（若反复失败，先刷新酒馆页面再试）`); return false; }
        saveSettingsDebounced();
        __lastSettingsData = null;
        hideBusy();
        toastr.success(`✅ 已恢复 User 资料 + 头像照片 ${avOk} 张${avFailNames.length ? `（照片失败 ${avFailNames.length}: ${avFailNames.join('、')}）` : ''}（请刷新/重载酒馆生效）`);
        return true;
    } catch (e) { console.warn('[chat-sync] User 恢复失败', e); hideBusy(); toastr.error('User 恢复失败：' + (e.message || e)); return false; }
    finally { __csReleaseBusy(); }
}
// ═══ 分项④-补: 人设管理·逐个删除（2026-08-25 用户要求完全按官方入口） ═══
// 官方 deletePersona(personas.js:1151) 全套动作复刻:
//   /api/avatars/delete → 清 power_user.personas/persona_descriptions 两键 → default_persona 处理
//   → chat_metadata.persona 锁定处理+saveMetadata → saveSettingsDebounced → emit PERSONA_DELETED
// (power_user 是官方导出对象, 插件可直接操作 —— 与官方按钮 #persona_delete_button 同源)
async function listUserPersonas() {
    // 本地: 头像文件清单 + power_user 活对象(人设名/描述); 云端: config-sync/user/personas 目录 → 合并视图
    const avatars = await (await fetch('/api/avatars/get', { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify({}) })).json();
    const files = Array.isArray(avatars) ? avatars : [];
    let cloudSizes = new Map();
    try {
        for (const e of await Gitee.listEntries('config-sync/user/personas')) {
            if (e.type === 'file' && e.name.endsWith('.png')) cloudSizes.set(e.name, e.size);
        }
    } catch { }
    const byFile = new Map();
    for (const f of files) byFile.set(f, { where: 'local' });
    for (const [f, size] of cloudSizes) { byFile.has(f) ? byFile.get(f).where = 'both' : byFile.set(f, { where: 'cloud', cloudSize: size }); }
    const puL = power_user || {};
    const rows = [];
    for (const [file, e] of byFile.entries()) {
        const descObj = (puL.persona_descriptions && puL.persona_descriptions[file]) || {};
        const row = {
            file,
            where: e.where,
            name: (puL.personas && puL.personas[file]) || '',
            descLen: descObj.description ? String(descObj.description).length : 0,
            preview: descObj.description ? String(descObj.description).replace(/\s+/g, ' ').slice(0, 60) : '',
            isCurrent: false,
            size: e.cloudSize != null ? humanBytes(e.cloudSize) : '',
        };
        rows.push(row);
    }
    // 本地缺名字或描述的行 → 并行从云端 meta 补(10s短超时, 不拖列表; 手机端映射未同步时 云端meta是唯一名字来源)
    const need = rows.filter((r2) => !r2.name || !r2.descLen);
    await Promise.all(need.map(async (r2) => {
        try {
            const mc = await Gitee.getText(`config-sync/user/personas/${r2.file}.meta.json`);
            if (mc && mc.content) {
                const meta = JSON.parse(mc.content);
                if (!r2.name && meta.name) r2.name = meta.name;
                if (!r2.descLen && meta.description) {
                    r2.descLen = meta.description.length;
                    r2.preview = String(meta.description).replace(/\s+/g, ' ').slice(0, 60);
                }
            }
        } catch { }
    }));
    for (const r2 of rows) if (!r2.name) r2.name = '(未命名)';
    return rows.sort((a, b) => a.file.localeCompare(b.file));
}
// 上传选中人设到云端: 原图(/User Avatars/ 直读实测原图) + meta(人设名/描述)
async function uploadUserPersonasToCloud(files) {
    const ok = [], fail = []; const failReasons = [];
    const pu = power_user || {};
    const dir = 'config-sync/user/personas';
    for (const file of files) {
        try {
            const r = await fetch('/User Avatars/' + encodeURIComponent(file));
            if (!r.ok) { fail.push(file); failReasons.push({ name: file, reason: '读取原图 HTTP ' + r.status }); continue; }
            const b64 = await blobToBase64(await r.blob());
            await Gitee.putBase64(`${dir}/${file}`, b64, (await Gitee.getBase64(`${dir}/${file}`))?.sha, `sync persona avatar ${file}`);
            let meta = { name: (pu.personas && pu.personas[file]) || '', description: (pu.persona_descriptions && pu.persona_descriptions[file] && pu.persona_descriptions[file].description) || '' };
            const metaPath = `${dir}/${file}.meta.json`;
            // 本地缺名字/描述(手机端映射未同步)时保留云端现有 meta 对应字段, 防空值覆盖
            if (!meta.name || !meta.description) {
                const mc = await Gitee.getText(metaPath).catch(() => null);
                if (mc && mc.content) {
                    try { const om = JSON.parse(mc.content); if (!meta.name && om.name) meta.name = om.name; if (!meta.description && om.description) meta.description = om.description; } catch { }
                }
            }
            await Gitee.putText(metaPath, JSON.stringify(meta, null, 2), (await Gitee.getText(metaPath))?.sha, `sync persona meta ${file}`);
            settings.lastCloudSha[metaPath] = (await Gitee.getText(metaPath)).sha; // 记云端sha, 供差异徽章判定方向
            ok.push(file);
        } catch (e) { fail.push(file); failReasons.push({ name: file, reason: (e && e.message) || String(e) }); }
    }
    return { ok: ok.length, fail: fail.length, failReasons };
}
// 从云端下载选中人设到本地: 图片经官方 /api/avatars/upload(overwrite 保文件名), 注册人设名/描述
async function downloadUserPersonasFromCloud(files) {
    const ok = [], fail = []; const failReasons = [];
    const dir = 'config-sync/user/personas';
    for (const file of files) {
        try {
            const img = await Gitee.getBase64(`${dir}/${file}`);
            if (!img || !img.b64) { fail.push(file); failReasons.push({ name: file, reason: '云端无该人设' }); continue; }
            const metaC = await Gitee.getText(`${dir}/${file}.meta.json`).catch(() => null);
            let meta = {}; try { meta = JSON.parse(metaC && metaC.content || '{}'); } catch { }
            const f2 = base64ToFile(img.b64, file, 'image/png');
            const fd = new FormData(); fd.append('avatar', f2); fd.append('overwrite_name', file);
            const r = await fetch('/api/avatars/upload', { method: 'POST', headers: getRequestHeaders({ omitContentType: true }), body: fd });
            if (!r.ok) { fail.push(file); failReasons.push({ name: file, reason: '写入 HTTP ' + r.status }); continue; }
            if (!power_user.personas) power_user.personas = {};
            if (!power_user.persona_descriptions) power_user.persona_descriptions = {};
            if (meta.name) power_user.personas[file] = meta.name;
            if (meta.description) power_user.persona_descriptions[file] = { description: meta.description };
            ok.push(file);
        } catch (e) { fail.push(file); failReasons.push({ name: file, reason: (e && e.message) || String(e) }); }
    }
    saveSettingsDebounced();
    return { ok: ok.length, fail: fail.length, failReasons };
}
// 删除选中人设(官方 deletePersona 全套动作复刻): 返回 {ok, fail, failReasons}
async function deleteSelectedUserPersonas(files) {
    const ok = [], fail = []; const failReasons = [];
    for (const file of files) {
        try {
            const req = await fetch('/api/avatars/delete', { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify({ avatar: file }) });
            if (!req.ok) { fail.push(file); failReasons.push({ name: file, reason: '头像删除 HTTP ' + req.status }); continue; }
            delete power_user.personas[file];
            delete power_user.persona_descriptions[file];
            const locked = getContext().chat_metadata && getContext().chat_metadata.persona === file;
            if (locked) { delete getContext().chat_metadata.persona; await saveMetadata(); }
            if (power_user.default_persona === file) power_user.default_persona = null;
            saveSettingsDebounced();
            await eventSource.emit(event_types.PERSONA_DELETED, { avatarId: file, name: '' });
            const after = await (await fetch('/api/avatars/get', { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify({}) })).json();
            if (Array.isArray(after) && after.includes(file)) { fail.push(file); failReasons.push({ name: file, reason: '删除未生效（头像文件仍在）' }); continue; }
            ok.push(file);
        } catch (e) { fail.push(file); failReasons.push({ name: file, reason: (e && e.message) || String(e) }); }
    }
    return { ok: ok.length, fail: fail.length, failReasons };
}

// 纯函数: 计算删除一个人设后 power_user 两表/默认人设 的变化(单测覆盖)
function applyPersonaRemoval(pu, avatarId, lockedPersonaId) {
    const changed = { personasDeleted: false, descDeleted: false, defaultCleared: false, lockCleared: false };
    if (!pu) return changed;
    if (pu.personas && pu.personas[avatarId] !== undefined) { delete pu.personas[avatarId]; changed.personasDeleted = true; }
    if (pu.persona_descriptions && pu.persona_descriptions[avatarId] !== undefined) { delete pu.persona_descriptions[avatarId]; changed.descDeleted = true; }
    if (lockedPersonaId === avatarId) changed.lockCleared = true; // 调用方负责清 chat_metadata.persona + saveMetadata
    return changed;
}

// ============ 酒馆配置 一键保存 / 一键下载应用（阶段4） ============
// 备份：POST /api/settings/get 读当前 settings.json 完整内容 → 上传 Gitee sync-config/settings-<时间戳>.json
// 恢复：从 Gitee sync-config/ 读最新 settings-*.json → 保留下方关键字段(避免把云端连接/令牌/syncMap覆盖掉) → POST /api/settings/save 写回(整个酒馆配置恢复)
const CONFIG_KEEP_KEYS = new Set(['owner','repo','token','lastCloudSha','lastLocalMTime','syncMap']);
const CONFIG_CHUNK_MAX = 800000; // 每块字符数(安全<Gitee单文件~1MB)
// 分块上传一段文本到 sync-config/<ts>/ part-NNN.json, 返回块数
async function __cfgPutChunks(dirPath, fullJson) {
    const chunks = [];
    for (let i = 0; i < fullJson.length; i += CONFIG_CHUNK_MAX) chunks.push(fullJson.slice(i, i + CONFIG_CHUNK_MAX));
    for (let i = 0; i < chunks.length; i++) {
        const p = `${dirPath}/part-${String(i).padStart(3, '0')}.json`;
        const sha = (await Gitee.getText(p))?.sha;
        try { await Gitee.putText(p, chunks[i], sha, 'cfg chunk'); }
        catch (e) { console.warn('[chat-sync] 写配置块失败', p, e); throw e; }
    }
    return chunks.length;
}
async function backupConfigToCloud() {
    try {
        if (!settings.owner || !settings.repo || !settings.token) { toastr.error('请先配置云端仓库'); return; }
        const r = await fetch('/api/settings/get', { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify({}) });
        if (!r.ok) { toastr.error('读取酒馆配置失败 HTTP ' + r.status); return false; }
        const text = await r.text();
        // 用本地时间生成时间戳(此前用 UTC 的 toISOString, 显示比本地慢 8 小时让用户对不上钟)
        const _d = new Date();
        const _p2 = (n) => String(n).padStart(2, '0');
        const ts = [_d.getFullYear(), _p2(_d.getMonth() + 1), _p2(_d.getDate())].join("-") + "T" + [_p2(_d.getHours()), _p2(_d.getMinutes()), _p2(_d.getSeconds())].join("-");
        const dir = `sync-config/${ts}`;
        // 备份=settings文本原样; 存 manifest(块数/ts) + 各块; 再写 .latest 指向
        const n = await __cfgPutChunks(dir, text);
        const man = JSON.stringify({ ts, chunks: n, savedAt: new Date().toISOString() }, null, 2);
        // .latest 用固定名便于恢复端取最新
        const latestP = 'sync-config/.latest.json';
        await Gitee.putText(latestP, JSON.stringify({ ts, chunks: n }, null, 2), (await Gitee.getText(latestP))?.sha, 'cfg latest');
        await Gitee.putText(`${dir}/manifest.json`, man, (await Gitee.getText(`${dir}/manifest.json`))?.sha, 'cfg manifest');
        toastr.success('✅ 酒馆配置已备份到云端 (' + ts + ', ' + n + ' 块)');
        return true;
    } catch (e) { console.warn('[chat-sync] 配置备份失败', e); toastr.error('配置备份失败：' + (e.message || e)); return false; }
}
// 目录条目缓存(5min): 列表渲染与差异比对共用, 避免对同一目录反复 listEntries
const __dirEntryCache = {}; // {dir: {ts, arr}}
async function __cachedListEntries(dir) {
    const hit = __dirEntryCache[dir];
    if (hit && Date.now() - hit.ts < 300000) return hit.arr;
    const arr = await Gitee.listEntries(dir);
    __dirEntryCache[dir] = { ts: Date.now(), arr };
    return arr;
}
// 删除后精确失效目录缓存(只剔除被删文件, 重渲染走缓存秒回; 避免清空后整表重拉3-4次目录)
function __evictDirCacheItems(dir, entries, tab) {
    const hit = __dirEntryCache[dir];
    if (!hit || !Array.isArray(hit.arr)) return;
    const purged = new Set();
    for (const it of entries) {
        const pure = __stripApiId(it);
        if (tab === 'user') { purged.add(pure); purged.add(pure + '.meta.json'); }
        else purged.add(pure + '.json');
    }
    hit.arr = hit.arr.filter((e) => !purged.has(e.name));
    __dirEntryCache[dir] = { ts: hit.ts, arr: hit.arr };
}
async function listConfigBackups() {
    try {
        const arr = await Gitee.listAllFiles('sync-config');
        // 每组 = 目录(ts) 下有 manifest/part-N, 返回 [{ts, chunks, path}]
        const dirs = new Set();
        arr.forEach(f => { const m = f.path.match(/^sync-config\/([0-9T-]+)\/manifest\.json$/); if (m) dirs.add(m[1]); });
        return [...dirs].map(ts => ({ ts, path: `sync-config/${ts}/manifest.json` })).sort((a,b)=>b.ts.localeCompare(a.ts));
    } catch (e) { console.warn('[chat-sync] 列配置备份失败', e); return []; }
}
async function __cfgReadBackup(ts) {
    // 读 manifest + 各块拼接, 返回全文
    const dir = `sync-config/${ts}`;
    const manC = await Gitee.getText(`${dir}/manifest.json`);
    if (!manC) return { err: '无 manifest' };
    let man; try { man = JSON.parse(manC.content); } catch { return { err: 'manifest损坏' }; }
    const n = man.chunks;
    let full = '';
    for (let i = 0; i < n; i++) {
        const c = await Gitee.getText(`${dir}/part-${String(i).padStart(3, '0')}.json`);
        if (!c) return { err: '缺块 ' + i };
        full += c.content;
    }
    return { full };
}
async function restoreConfigFromCloud(ts) {
    try {
        if (!settings.owner || !settings.repo || !settings.token) { toastr.error('请先配置云端仓库'); return; }
        // 未指定 ts → 取最新(writeBackup 时存 .latest)
        let target = ts;
        if (!target) {
            const latestC = await Gitee.getText('sync-config/.latest.json');
            if (latestC) { try { target = JSON.parse(latestC.content).ts; } catch {} }
            if (!target) { const arr = await listConfigBackups(); if (!arr.length) { toastr.info('云端没有酒馆配置备份'); return false; } target = arr[0].ts; }
        }
        const res = await __cfgReadBackup(target);
        if (res.err) { toastr.error('读取云端配置备份失败：' + res.err); return false; }
        let cfg;
        try { cfg = JSON.parse(res.full); }
        catch (e) { toastr.error('云端配置备份解析失败(可能损坏)'); console.warn('[chat-sync] 解析失败', e); return false; }
        // ⚠️ 不能自己 POST /api/settings/save——TT/ST 的保存带修订号基线, 页面外直接 POST 用旧基线必撞
        //   'Settings changed outside this page' 守卫。正确姿势: 写进页面的全局 settings 活对象 → 官方 saveSettingsDebounced 落盘。
        if (typeof stSettings !== 'object' || !stSettings) { toastr.error('拿不到页面设置对象, 请更新酒馆后重试'); return false; }
        // ⚠️ 备份文件存的是 /api/settings/get 的【响应原文】: { version, settings: '<字符串化的设置JSON>', ... }
        //    必须对 settings 字段二次解析得到真配置对象。
        let payload = cfg;
        if (typeof payload.settings === 'string') {
            try { payload = JSON.parse(payload.settings); }
            catch (e) { toastr.error('云端配置备份的内层 settings 解析失败'); console.warn('[chat-sync] 内层解析失败', e); return false; }
        } else if (payload.settings && typeof payload.settings === 'object') {
            payload = payload.settings;
        }
        if (!payload || typeof payload !== 'object') { toastr.error('云端配置备份为空'); return false; }
        // 🔴 TT/ST 保存设置时会【从各官方模块的活对象重新拼装 payload】—— 往页面 settings 对象任意键上写内容,
        //    保存时全部被丢弃(0.2.23~0.2.29 三轮假成功的总根源)。恢复内容必须分派写回各自的活对象:
        const CONN_KEYS = ['owner', 'repo', 'token', 'server'];
        // 活对象全部取自 getContext() 的官方引用(oai_settings/textgen 未以该名导出, 不能乱 import——会炸掉整个模块)
        const __ctx = getContext() || {};
        const liveTargets = [
            ['power_user', typeof power_user === 'object' ? power_user : (__ctx.powerUser || null)],
            ['oai_settings', __ctx.chatCompletionSettings || null],
            ['textgenerationwebui_settings', __ctx.textCompletionSettings || null],
        ];
        const wiLive = __ctx.world_info_settings || null;
        for (const k of Object.keys(payload)) {
            if (k === 'extension_settings') continue; // 单独处理(保护插件连接配置)
            if (CONFIG_KEEP_KEYS.has(k)) continue;
            const pair = liveTargets.find(([kk]) => kk === k);
            if (pair && pair[1] && typeof pair[1] === 'object' && payload[k] && typeof payload[k] === 'object') {
                // 清空活对象后整体替换(保持引用不变——保存管线持有的是同一引用)
                for (const kk of Object.keys(pair[1])) delete pair[1][kk];
                Object.assign(pair[1], payload[k]);
            } else if (k === 'world_info_settings' && wiLive && payload[k] && typeof payload[k] === 'object') {
                for (const kk of Object.keys(wiLive)) delete wiLive[kk];
                Object.assign(wiLive, payload[k]);
            } else {
                stSettings[k] = payload[k]; // 其余键兜底写回全局对象
            }
        }
        // extension_settings: 活对象单独处理 —— 本插件命名空间的连接三件套永远以当前为准(防旧备份断连)
        if (payload.extension_settings && typeof payload.extension_settings === 'object') {
            const restoredEs = payload.extension_settings;
            const backNs = (typeof restoredEs[extensionName] === 'object' && restoredEs[extensionName]) || {};
            const curNs = (typeof extension_settings[extensionName] === 'object' && extension_settings[extensionName]) || {};
            for (const ck of CONN_KEYS) { if (curNs[ck] !== undefined) backNs[ck] = curNs[ck]; }
            for (const ek of Object.keys(restoredEs)) {
                if (ek === extensionName) continue;
                extension_settings[ek] = restoredEs[ek];
            }
            extension_settings[extensionName] = backNs;
        }
        saveSettingsDebounced();
        toastr.success('✅ 已从云端恢复酒馆配置(请刷新/重载酒馆生效): ' + target + '<br><small>若弹出"Settings changed outside this page"，说明其它设备刚改过设置——刷新酒馆后再点一次恢复即可成功。</small>');
        return true;
    } catch (e) { console.warn('[chat-sync] 配置恢复失败', e); toastr.error('配置恢复失败：' + (e.message || e)); return false; }
}


// ============ 上传/导入冲突抉择（面向小白：覆盖 / 另行保存 / 批量统一） ============
// 比较本地/云端消息序列，返回用户对「这聊天怎么处理」的选择：
//   'skip'          —— 两端一致或云端更新，无需处理（已同步/跳过）
//   'overwrite'     —— 覆盖：用本地这份（云端那份作废，但 Gitee 版本历史仍可找回）
//   'save_elsewhere'—— 另行保存：先把有分歧的另一方另存成一条新记录（两边都留、谁都不丢），
//                       上传时=先把云端当前内容另存到新云端路径再覆盖为主；导入时=把本地有分歧的另存新本地聊天再套云端的。
//   'cancel'        —— 本次不处理
// batchMode(可选)：批量循环共用。选「全部X」→ batchMode 记下 decision 并 applyAll=true，后续不再逐个弹。
//   不传或用 {applyAll:true} 复用已定决策，不弹窗。
const CONFLICT_OVERWRITE = 3001, CONFLICT_SAVE_ELSEWHERE = 3002, CONFLICT_CANCEL = 3003;
function resolveUploadConflict(localMsgs, cloudMsgs, fileName, batchMode = null) {
    // 先做内容级分类：完全一致 / 云端更新 → 一律跳过（与 batchMode 无关，避免 applyAll 把一致聊天也覆盖重传）
    const diff = classifyChatDiff(localMsgs || [], cloudMsgs || []);
    if (!diff) return Promise.resolve('skip');
    if (diff.relation === 'identical') return Promise.resolve('skip');
    if (diff.relation === 'cloud_superset') return Promise.resolve('skip');
    // 真正有差异（local_superset / diverged）才轮到抉择；
    // 若已通过「全部X」定好统一决策，直接沿用，不再弹窗
    if (batchMode && batchMode.applyAll) return Promise.resolve(batchMode.decision ?? 'overwrite');
    // 本地更新（local_superset / diverged）→ 让用户抉择（弹窗）
    return (async () => {
        const ALL_OVER = 3101, ALL_SAVE = 3102;   // 应用于本次全部
        const isDiverged = diff.relation === 'diverged';
        const sameLen = diff.localTail.length === diff.cloudTail.length;
        const desc = isDiverged
            ? (sameLen
                ? `本地和云端的最后 ${diff.localTail.length} 层内容不一样（很可能是同一层被修改成了不同内容）`
                : `本地和云端产生分叉（公共 ${diff.common} 层之后，本地多 ${diff.localTail.length} 层，云端多 ${diff.cloudTail.length} 层）`)
            : `本地比云端多 ${diff.localTail.length} 层新内容`;
        const baseMsg = `聊天「${escapeHtml(fileName)}」：${desc}。<br>你想怎么处理它？`;
        const choice = await Popup.show.confirm(
            '⚠️ 发现冲突（本地和云端不一样）',
            `${baseMsg}<br><br><b>「另行保存」会把有分歧的一方另存成一条新记录，两边都保留，谁都不丢，你之后自己决定用哪个。</b><br>处理多个冲突时，选「全部」就不会再逐个问了。`,
            {
                defaultResult: CONFLICT_SAVE_ELSEWHERE,
                okButton: false,
                cancelButton: false,
                customButtons: [
                    { text: '✅ 全部按「覆盖」（全部用本地，云端作废）', result: ALL_OVER, classes: ['popup-button-ok'] },
                    { text: '✅ 全部按「另行保存」（全部两边都留、谁都不丢）', result: ALL_SAVE, classes: ['popup-button-ok'] },
                    { text: '覆盖（仅这个聊天）', result: CONFLICT_OVERWRITE, classes: ['popup-button-cancel'] },
                    { text: '另行保存（仅这个聊天，两个都留）', result: CONFLICT_SAVE_ELSEWHERE, classes: ['popup-button-cancel'] },
                    { text: '✕ 跳过（本次不处理这个聊天）', result: CONFLICT_CANCEL, classes: ['popup-button-cancel'] },
                ],
            },
        );
        if (batchMode) {
            if (choice === ALL_OVER) { batchMode.applyAll = true; batchMode.decision = 'overwrite'; return batchMode.decision; }
            if (choice === ALL_SAVE) { batchMode.applyAll = true; batchMode.decision = 'save_elsewhere'; return batchMode.decision; }
            // 仅这个：保留 batchMode（未 applyAll），继续逐条弹
        }
        if (choice === CONFLICT_OVERWRITE) return 'overwrite';
        if (choice === CONFLICT_SAVE_ELSEWHERE) return 'save_elsewhere';
        return 'cancel';
    })();
}


// 按「覆盖」或「另行保存(先备份云端再覆盖)」生成要写回云端的聊天文本。
function buildCloudUploadText(localMsgs, cloudMsgs, headerObj, decision) {
    if (decision === 'overwrite' || decision === 'save_elsewhere') {
        // 覆盖（含另行保存后覆盖）：本地全文覆盖云端
        return serializeChatJsonl(headerObj || {}, localMsgs || []);
    }
    // (兼容旧 'append'，现已不用)：云端已有 + 本地新楼（指纹去重合并，云端在前）
    const sigs = new Set((cloudMsgs || []).map(messageSignature));
    const localNew = (localMsgs || []).filter((m) => m && m.mes !== undefined && !sigs.has(messageSignature(m)));
    return serializeChatJsonl(headerObj || {}, (cloudMsgs || []).concat(localNew));
}

// ============ 锁外预扫上传冲突 ============
// 把「覆盖/追加」冲突抉择弹窗放在拿锁之前完成，避免弹窗等待期间持有互斥锁卡死其他同步。
// 遍历所有聊天的云路径，对本地更新(local_superset/diverged)的逐条弹窗，把 decision 收集到 preDecisions Map。
// decision 取值: 'skip'(一致/云端更新) | 'new'(云端无,直传) | 'overwrite' | 'append' | 'cancel'
// 返回 void；调用方把 preDecisions 传给 exportChats 复用。
async function preResolveUploadConflicts(charName, chatItems, preDecisions, presetDecision = null) {
    // presetDecision: 全量上传等串联场景预先定好的冲突策略('save_elsewhere'最安全=两边都留), 非空时不逐个弹窗
    const batch = presetDecision
        ? { applyAll: true, decision: presetDecision }
        : { applyAll: false, decision: 'overwrite' }; // 批量：选「全部X」后 applyAll=true，后续沿用不再弹
    const plans = planPushTargets(charName, chatItems.map((x) => x.file_name));
    for (const plan of plans) {
        const item = chatItems.find((x) => x.file_name === plan.localName);
        if (!item) continue;
        const chatText = await getChatContent(item.file_name, charName);
        if (!chatText) { preDecisions.set(plan.localName, 'skip'); continue; }
        const cloud = await getCloudChat(plan.path); // 分段感知
        if (!cloud) { preDecisions.set(plan.localName, 'new'); continue; }
        const localMsgs = parseJsonlMessages(chatText);
        const cloudMsgs = parseJsonlMessages(cloud.content || '');
        const decision = await resolveUploadConflict(localMsgs, cloudMsgs, plan.localName, batch);
        preDecisions.set(plan.localName, decision);
    }
}

// base64 字符串 → File 对象（用于导入角色卡/世界书）
function base64ToFile(b64, fileName, mime = 'application/octet-stream') {
    const clean = String(b64).replace(/\s/g, '');
    const bin = atob(clean);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new File([bytes], fileName, { type: mime });
}

// 文本 → File 对象（用于导入世界书 json）
function textToFile(text, fileName, mime = 'application/json') {
    return new File([text], fileName, { type: mime });
}

// 从云端导入一个完整角色（卡 + 世界书 + 聊天），手机端从0搬入用
async function importCharFromCloud(charName, opts = {}) {
    // opts.noJump=true 表示「只导入不跳转」（批量导入时用：不切换当前角色、不加载聊天进窗口）
    if (!settings.owner || !settings.repo || !settings.token) { toastr.error('请先配置'); return; }
    // 导入期间用【安全版一次性扫描】自动确认官方「内置世界书/正则/嵌入式脚本」弹窗：不冻结、不残留(见 suppressImportModals)。
    suppressImportModals();
    toastr.info(`开始从云端导入角色「${charName}」…`);

    // 1) 角色卡：若本地已有同名卡则【不重复导入】直接复用(避免每次拉取都生成一张 dk方亦楷N 复制卡，
    //    且让聊天导入定位到规范目录 chats/<名>/，而不是散落到 chats/<名>N/)。否则下载 base64 → /api/characters/import。
    let cardImported = false;
    let cardReused = false; // 本地已有同名卡 → 复用（不是失败！之前误报黄色"导入失败或不存在"）
    let cardAvatar = ''; // 目标卡 avatar(stem)，本地已有则用已有卡的；新导则用响应 file_name
    const existingIdx = (getContext().characters || []).findIndex(x => (x.name || '') === charName);
    if (existingIdx >= 0) {
        const ex = getContext().characters[existingIdx];
        cardAvatar = String(ex.avatar || '').replace(/\.png$/, '');
        cardReused = true;
        console.log(`[chat-sync] 本地已有同名卡「${charName}」(${ex.avatar})，跳过卡导入，复用其 avatar=${cardAvatar}`);
    } else {
        const cardCloud = await __cardGetSmart(`sync/${charName}`);
        if (!cardCloud?.b64) {
            // 云端没有该角色的卡 → 不是有效的云端角色（本地独有或云端从未上传），跳过并明示，避免静默失败
            console.warn('[chat-sync] 云端没有该角色卡，跳过导入', charName);
            return { skippedNoCloud: true };
        }
        try {
            const file = base64ToFile(cardCloud.b64, `${charName}.png`, 'image/png');
                const formData = new FormData();
                formData.append('avatar', file);
                formData.append('file_type', 'png');
                formData.append('user_name', getContext().name1);
                const res = await fetch('/api/characters/import', {
                    method: 'POST',
                    headers: getRequestHeaders({ omitContentType: true }),
                    body: formData,
                    cache: 'no-cache',
                });
                if (res.ok) {
                    cardImported = true;
                    // 响应 file_name 就是新卡的 avatar（ST/TT /api/characters/import 都返回这个，不带 .png）
                    const j = await res.json().catch(() => null);
                    if (j && j.file_name) cardAvatar = String(j.file_name).replace(/\\.png$/, '');
                }
            } catch (e) { console.warn('[chat-sync] 角色卡导入失败', e); }
    }
    // diag: 卡导入后立刻查这张卡的内容是否完整（定位“空卡壳”在哪一步产生）
    try {
        const ci = (getContext().characters || []).findIndex(x => (x.name || '') === charName);
        const cd = ci >= 0 ? getContext().characters[ci] : null;
        diag.lastRun = { ...(diag.lastRun || {}), cardImportDone: true, cardImported, cardAvatar,
            cardDescLenAfterImport: cd ? (cd.description || '').length : -1, cardFirstMesAfterImport: cd ? (cd.first_mes || '').length : -1,
            cardIdxAfterImport: ci };
    } catch (e) { console.warn('[chat-sync] diag 卡检查失败', e); }
    // 刷新角色列表，让刚导入的卡进数组（后续聊天导入用它当 avatar_url 定位目录）
    try { await getCharacters(); } catch { /* 忽略 */ }
    // 关键：把当前打开角色切到刚导入的卡——ST 的 /api/chats/search 与聊天显示都依赖 this_chid / #form_import_chat 的 avatar。
    // 若不切换，this_chid 仍指向导入前的角色 → displayPastChats 疯狂报 "could not load chat data"、聊天也显示不到新角色下。
    if (cardAvatar) {
        try {
            const freshC = getContext();
            const idx = (freshC.characters || []).findIndex(x => String(x.avatar || '').replace(/\.png$/,'') === cardAvatar);
            if (idx >= 0) {
                if (!opts.noJump) {
                    select_selected_character(idx, { switchMenu: false });
                    await getCharacters(); // 切角色后再刷一次，确保后续 getContext() 拿到对的 characterId
                }
            }
        } catch (e) { console.warn('[chat-sync] 切换到导入角色失败', e); }
    }
    if (cardImported) toastr.success('✅ 角色卡已导入');
    else if (cardReused) console.log(`[chat-sync] 本地已有「${charName}」卡，复用（无需重复导入）`);
    else toastr.warning('⚠️ 角色卡导入失败');

    // 2) 世界书：world.json → importWorldInfo
    let worldImported = false;
    const wText = (await Gitee.getText(`sync/${charName}/world.json`))?.content;
    if (wText) {
        try {
            // 书真实名字在 world.json 的 originalData.name（如「🌸方亦楷和高中生活_2.0」），不是固定的 world。
            // importWorldInfo 按【文件名】派生书名，所以要按 originalData.name 命名文件，才能和卡 extensions.world 引用对上。
            let wName = 'world';
            try {
                const wj = JSON.parse(wText);
                const on = wj?.originalData?.name || wj?.name || wj?.data?.name;
                if (on && String(on).trim()) wName = String(on).trim();
            } catch (e) { /* 解析失败就用默认 world */ }
            const f = textToFile(wText, `${wName}.json`);
            // ⚠️ ST 弹「是否导入世界书」的根因不只是撞名，还有一个更隐蔽的：ST 的 world_names 是
            //   world-info.js 的 `export let` 活绑定，只在页面初始化 data.world_names 后才填充。插件若在它
            //   未就绪时跑 importCharFromCloud，`world_names.includes(wName)` 恒为 false → 预删被跳过 →
            //   importWorldInfo 撞同名 → 弹阻塞式确认框（checkOverwriteExistingData interactive:true）。
            //   而且 ST 的 deleteWorldInfo() 开头也 `if(!world_names.includes(name)) return false`，一样被卡。
            // 修法：绕开 world_names 活绑定时序 + 双保险：
            //  ① 直接 POST /api/worldinfo/delete({name}) 删同名文件(ST 后端 sanitize(name.json) 存在则删/不存在则 throw，TT 对不存在不报错)；
            //  ② 从前端 world_names(活绑定)里也移除该名——因为 importWorldInfo 的 checkOverwriteExistingData(interactive:true)
            //     是看 world_names 是否含该名才弹窗；若只删文件、world_names 还残留旧名，仍会弹。存在才删、不存在忽略。
            try {
                await fetch('/api/worldinfo/delete', { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify({ name: wName }) });
            } catch (e) { console.warn('[chat-sync] 预删世界书文件失败(可能本就不存在，忽略)', e); }
            try {
                if (Array.isArray(world_names)) { const wi = world_names.indexOf(wName); if (wi >= 0) world_names.splice(wi, 1); }
            } catch (e) { console.warn('[chat-sync] 更新 world_names 失败(忽略)', e); }
            await importWorldInfo(f);
            worldImported = true;
        } catch (e) { console.warn('[chat-sync] 世界书导入失败', e); }
    }
    if (worldImported) toastr.success('✅ 世界书已导入');

    // 3) 聊天：读清单 → 逐个导入
    let importedCount = 0;
    const isTt = Boolean(window.__TAURITAVERN__ || window.__TAURITAVERN_MAIN_READY__);
    if (isTt) {
        // TauriTavern：/api/chats/import 是旧兼容 shim(avatar/卡名解析不一致会失败)。改用 TT 官方推荐：灌 getContext().chat + saveChat()。
        importedCount = await importChatsTtNative(charName, cardAvatar);
    } else {
        try {
            const listCloud = await Gitee.getText(`sync/${charName}/chat-list.json`);
            let fileList = [];
            if (listCloud) {
                const parsed = JSON.parse(listCloud.content || '{}');
                if (Array.isArray(parsed.files)) fileList = parsed.files;
            }
            const c = getContext();
            const importAvatar = cardAvatar || c.characters?.[c.characterId]?.avatar || '';
            // 先 GET /api/chats/get 建出该角色聊天目录（ST 只在此时 mkdir；import 直接写文件不建目录 → 否则全失败）
            try {
                await fetch('/api/chats/get', { method: 'POST', headers: getRequestHeaders(), cache: 'no-cache', body: JSON.stringify({ avatar_url: importAvatar, file_name: '' }) });
            } catch { }
            let readFail = 0, importFail = 0, alreadyCount = 0, updatedCount = 0;
            const safeName = (orig, i) => `import-${i}.jsonl`;
            // 该角色本地已有的聊天文件名（待办A：用于判断「本地是否已同步过同一聊天」，避免重复新建文件）
            let localNames = new Set();
            try {
                const cs = await fetch('/api/characters/chats', { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify({ avatar_url: importAvatar }) });
                localNames = new Set(Object.values(await cs.json()).map((x) => x && x.file_name).filter(Boolean));
            } catch { /* 列表拉不到就当无本地，走全新导入 */ }
            // 拉取提速：1 个请求拿全部云端 sha → 与上次同步一致的直接跳过（不再逐个全量下载比对）
            const shaMap = await cloudShaMap(`sync/${charName}/chats`);
            for (let i = 0; i < fileList.length; i++) {
                const fileName = fileList[i];
                const cloudPath = `sync/${charName}/chats/${fileName}`;
                const cSha = shaMap.get(manifestPathOf(cloudPath)) || shaMap.get(cloudPath); // 分段以 manifest sha 为指纹
                // 云端没变 且 本地文件还在(或从无绑定) → 跳过；本地绑定存在但文件没了 = 可能误删 → 不跳，走比对恢复
                const knownC = localNameOf(charName, cloudPath);
                if (cSha && settings.lastCloudSha[cloudPath] === cSha && (!knownC || localNames.has(knownC))) { alreadyCount++; continue; }
                const cloud = await getCloudChat(cloudPath);
                if (!cloud) { readFail++; continue; }
                // ── 待办A：先查本地是否已有同聊天，走「与双端实时同一套」冲突判定 + 聪明版合并（不重复新建文件）──
                const resolved = await resolveCloudChatImport(charName, importAvatar, cloudPath, cloud, localNames);
                if (resolved.action === 'skip' || resolved.action === 'skip_local') { alreadyCount++; settings.lastCloudSha[cloudPath] = cloud.sha || cSha; continue; }
                if (resolved.action === 'fastforward') { importedCount++; updatedCount++; settings.lastCloudSha[cloudPath] = cloud.sha || cSha; continue; }
                if (resolved.action === 'import_cloud_as_new') { importedCount++; settings.lastCloudSha[cloudPath] = cloud.sha || cSha; continue; } // 已在弹窗分支里另存为新聊天，无需再导入
                // resolved.action === 'new'：本地没有该聊天 → 直接写盘到目标角色的聊天目录（/api/chats/save 按 avatar_url 定位）
                // ⚠️ 不用 /api/chats/import（会生成「角色名-时间戳 imported.jsonl」新文件名+依赖表单avatar可能错位→加载不到）
                //   用 /api/chats/save 保留云端原文件名、按 cardAvatar 落盘（与 TT 分支一致）。依据 src/endpoints/chats.js:470。
                const cloudMsgs = parseJsonlMessages(cloud.content);
                const saveFn = String(fileName).replace(/\.jsonl$/i, '');
                const saveAv = importAvatar || (charName + '.png');
                const saveRes = await fetch('/api/chats/save', {
                    method: 'POST',
                    headers: getRequestHeaders(),
                    body: JSON.stringify({
                        avatar_url: saveAv,
                        file_name: saveFn,
                        chat: [{ user_name: 'unused', character_name: 'unused', create_date: new Date().toISOString(), last_mes: new Date().toISOString(), chat_metadata: {} }, ...cloudMsgs].filter(Boolean),
                        force: true,
                    }),
                });
                if (saveRes.ok) {
                    importedCount++; importedFileName = saveFn + '.jsonl';
                    setLocalName(charName, cloudPath, saveFn + '.jsonl');
                } else {
                    importFail++;
                    console.warn('[chat-sync] ST 聊天落盘失败', fileName, saveRes.status);
                }
            }
            if (fileList.length) {
                const msg = `聊天导入：清单 ${fileList.length} 个，${importedCount} 个已就位${alreadyCount ? `，${alreadyCount} 个本地已有跳过` : ''}${updatedCount ? `，其中 ${updatedCount} 个云端新楼层已补进本地` : ''}${readFail ? `，云端读取失败 ${readFail}` : ''}${importFail ? `，导入失败 ${importFail}` : ''}；avatar=${importAvatar || '空'}`;
                if (readFail || importFail) { toastr.warning(msg); }
                else { toastr.success(`✅ ${msg}`); }
            }
            // ↙ 导入后选「最新」聊天加载进楼层：importedFileName 是循环最后一个(清单顺序≠时间序)。
            // ST /api/characters/chats 返回的 last_mes 是【内容最后一条消息的 send_date】(ISO字符串, e.g. 2026-08-15T15:19:26...),
            // 不是磁盘 mtime。不能用 Number()(ISO→NaN→0 排序失效)，要用 Date.parse() 转时间戳比。
            if (importedCount > 0 && importAvatar) {
                try {
                    const cs = await fetch('/api/characters/chats', { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify({ avatar_url: importAvatar }) });
                    const clist = Object.values(await cs.json())
                        .filter((x) => x && x.file_name)
                        .sort((a, b) => (Date.parse(b.last_mes) || 0) - (Date.parse(a.last_mes) || 0));
                    if (clist.length) importedFileName = clist[0].file_name;
                } catch (e) { console.warn('[chat-sync] 选最新聊天失败(用默认 last imported)', e); }
            }
        } catch (e) { console.warn('[chat-sync] 聊天导入失败', e); }
    }

    // 修幻影 .chat（ST 与 TT 都要）：把当前角色的 .chat 指向导入产生的【真实】文件，
    // 避免 ST/TT 用 characters[chid].chat 去加载一个不存在的新聊天名 → get_chat_payload_path → Chat not found。
    // 单角色(noJump=false)：用 loadImportedChat(openCharacterChat) 设.char+载入+落盘(用户手动导入同款)；
    // 批量(noJump=true)：不渲染，用 persistChatPointerStt 服务端持久化 .chat 指向「最近改动」真实聊天(与 TT 对称)。
    try {
        if (importedFileName && !opts.noJump) {
            let targetIdx = getContext().characterId;
            if (cardAvatar && getContext().characters) {
                const found = getContext().characters.findIndex(x => String(x.avatar || '').replace(/\\.png$/, '') === cardAvatar);
                if (found >= 0) targetIdx = found;
            }
            const loaded = await loadImportedChat(importedFileName, targetIdx);
            diag.lastRun = { ...(diag.lastRun || {}), importedFileName, targetIdx, loadImportedChat: loaded };
            if (loaded) toastr.success('已将导入的聊天加载到当前楼层');
        } else {
            diag.lastRun = { ...(diag.lastRun || {}), importedFileName: opts.noJump ? '(noJump)' : null, loadImportedChat: false };
            // 批量/无加载：服务端持久化 .chat 指向真实文件(不渲染不冻结, 与 TT 对称: 重启不幻影、点卡即最近聊天)
            if (cardAvatar) {
                try {
                    // 取「最近改动」真实聊天: /api/characters/chats 按 last_mes 降序取第一个
                    const cs = await fetch('/api/characters/chats', { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify({ avatar_url: cardAvatar + '.png' }) });
                    const arr = Object.values(await cs.json());
                    const sorted = (arr || []).filter(x => x && x.file_name).sort((a, b) => (Date.parse(b.last_mes) || 0) - (Date.parse(a.last_mes) || 0));
                    const target = sorted.length ? String(sorted[0].file_name).replace(/\.jsonl$/i, '') : (importedFileName ? String(importedFileName).replace(/\.jsonl$/i, '') : '');
                    if (target) {
                        const ci = (getContext().characters || []).findIndex(x => (x.name || '') === charName || String(x.avatar || '').replace(/\\.png$/,'') === cardAvatar);
                        if (ci >= 0) getContext().characters[ci].chat = target;
                        await persistChatPointerStt(charName, cardAvatar, target);
                        console.log(`[chat-sync] ST 持久化「${charName}」.chat → ${target}`);
                    }
                } catch (e) { console.warn('[chat-sync] ST 持久化 .chat 失败', e); }
            }
        }
    } catch (e) { console.warn('[chat-sync] ST .chat 处理失败', e); }

    // 刷新角色列表 + 重置角色显示
    try { await getCharacters(); } catch { /* 忽略 */ }
    updateCurrentCharDisplay();
    toastr.success(`「${charName}」导入完成：卡${cardImported ? '✓新导入' : (cardReused ? '✓本地已有' : '✗')} 世界书${worldImported ? '✓' : '-'} 聊天${importedCount}个 ✅`);
}

// 记录最近一次成功导入返回的实际文件名（importCharFromCloud 用它做 .chat 修正 / loadImportedChat）
let importedFileName = '';

// 最近一次导入的调试统计（真机 CDP 验证用）
const diag = { lastRun: null };

// 读取 runtime 某角色 .chat 的调试快照
function chatStateSnapshot(charName) {
    const c = getContext();
    const chars = c.characters || [];
    const i = chars.findIndex(x => (x.name || '') === charName);
    if (i < 0) return { found: false, total: chars.length };
    return { found: true, total: chars.length, idx: i, name: chars[i].name, avatar: chars[i].avatar, chat: chars[i].chat, chatIsReal: (chars[i].chat || '').toLowerCase().includes('imported') };
}

// 把 .chat 指向真实导入文件并把聊天加载进楼层 = 完全复刻用户在「聊天记录管理器」里点选那条导入记录的动作(openCharacterChat)。
// openCharacterChat 会依次: characters[chid].chat = 文件名(stem) → getChat() 载入楼层 → $('#selected_chat_pole').val(文件名) 同步表单字段 → createOrEditCharacter 持久化写盘。
// 这是 ST/TT 两端用户实测「手动导入+点选」成功唯一可靠的那条路。
// 之前 fixChatPointerToImported 只改内存 .chat + saveCharacterDebounced(触发 #create_button/#form_create 提交)，
// 但没把 #selected_chat_pole 一起改——提交的是旧(幻影)值 → .chat 改不落盘 → TT 重启后从浅索引又读到幻影 → 每次切角色都 Chat not found。
async function loadImportedChat(realFileName, charIdx) {
    const realNoExt = String(realFileName || '').replace(/\.jsonl$/i, '');
    if (!realNoExt) return false;
    const c = getContext();
    if (charIdx === undefined || !c.characters?.[charIdx]) return false;
    try {
        // ① this_chid 切到导入角色 + 完全加载其完整数据进编辑表单(switchMenu:true 才会进 character_edit 模式、
        //   select_selected_character 会把 characters[idx] 的 description/first_mes/personality 等全填进 #form_create)。
        //   ⚠️ 绝不能用 switchMenu:false 再调 openCharacterChat：openCharacterChat 末尾会 createOrEditCharacter('newChat')，
        //   它从 #form_create 重建整张卡；若表单没被完整填充(未进入 edit 模式)，会把卡清成只剩 name+world 的空壳(chara_card_v2, desc=first_mes=0)。
        if (typeof c.unshallowCharacter === 'function') {
            try { await c.unshallowCharacter(charIdx); } catch (e) { /* 忽略 */ }
        }
        setCharacterId(charIdx);                                    // this_chid 真正切到导入角色(select_selected_character 不改 this_chid)
        select_selected_character(charIdx, { switchMenu: true });   // 完整填充 #form_create 编辑表单（关键：进 character_edit 模式）
        await openCharacterChat(realNoExt);                         // 用户手动点选记录的同一条路：设 .chat + getChat 载入 + createOrEditCharacter 落盘
        console.log('[chat-sync] 已把 .chat 指向真实导入文件并加载:', realNoExt);
        return true;
    } catch (e) { console.warn('[chat-sync] 加载导入聊天失败', e); return false; }
}

// ============ TauriTavern 聊天导入：完全复刻 TT 手动导入(用户实测能成功的那条路) ============
// TT 手动导入(script.js:13951 #chat_import_file change)是这样做的：
//   const formData = new FormData(document.getElementById('form_import_chat'));
//   formData.set('file_type', format);
//   formData.set('avatar', file);
//   formData.set('user_name', name1);
//   然后 importCharacterChat(formData)。
// 关键：New FormData(表单) 会带上表单里已填充的 avatar_url / character_name(选中角色时被赋值，
// script.js:10120-10121)——TT 靠表单里的 avatar_url 定位聊天目录。插件之前手动用云端名 charName
// 当 character_name、用导入响应 file_name 当 avatar_url，在 TT 上会错位 → 失败。
// 修复：先 select_selected_character 选中刚导入的卡(让 #form_import_chat 表单被填成该卡的 avatar/name)，
// 再从表单 new FormData()，走 importCharacterChat——与手动导入完全一致。
async function importChatsTtNative(charName, cardAvatar) {
    // 安全版一次性扫描自动确认官方弹窗(不冻结不残留)。
    suppressImportModals();
    try {
        await (window.__TAURITAVERN__?.ready ?? window.__TAURITAVERN_MAIN_READY__).catch?.((e)=>{});
    } catch { }
    let count = 0;
    try {
        // 1) ⚠️ 不再 select_selected_character / 不切换当前角色：TT 批量导入时渲染真实卡会冻结主线程(实测)，
        //    且违背「导入=复制文件，点卡才进」的交互。导入只做纯文件级写入(/api/chats/save 按 avatar_url 定位，不依赖当前角色/表单)。
        // 2) 读云端清单
        const listCloud = await Gitee.getText(`sync/${charName}/chat-list.json`);
        let fileList = [];
        if (listCloud) {
            const parsed = JSON.parse(listCloud.content || '{}');
            if (Array.isArray(parsed.files)) fileList = parsed.files;
        }
        // 3) 逐个走 TT 手动导入同款流程（new FormData(表单) 而不是手动 set avatar/character_name）
        //    待办A：先对每条云端聊天查本地是否已有同聊天，走「与双端实时同一套」冲突判定 + 聪明版合并。
        let alreadyCount = 0, updatedCount = 0;
        let localNames = new Set();
        try {
            const cs = await fetch('/api/characters/chats', { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify({ avatar_url: cardAvatar + '.png' }) });
            localNames = new Set(Object.values(await cs.json()).map((x) => x && x.file_name).filter(Boolean));
        } catch { /* 列表拉不到就当无本地，走全新导入 */ }
        // 拉取提速：1 个请求拿全部云端 sha → 与上次同步一致的直接跳过
        const shaMap = await cloudShaMap(`sync/${charName}/chats`);
        for (let i = 0; i < fileList.length; i++) {
            const fileName = fileList[i];
            const p = `sync/${charName}/chats/${fileName}`;
            const cSha = shaMap.get(manifestPathOf(p)) || shaMap.get(p); // 分段以 manifest sha 为指纹
            // 云端没变 且 本地文件还在(或从无绑定) → 跳过；本地绑定存在但文件没了 = 可能误删 → 不跳，走比对恢复
            const knownT = localNameOf(charName, p);
            if (cSha && settings.lastCloudSha[p] === cSha && (!knownT || localNames.has(knownT))) { alreadyCount++; continue; }
            const cloud = await getCloudChat(p);
            if (!cloud) continue;
            // 待办A：冲突判定 + 聪明版合并（identical/local_superset → 跳过；cloud_superset → 云端新楼层写回本地已有文件；diverged → 弹窗）
            const resolved = await resolveCloudChatImport(charName, cardAvatar, p, cloud, localNames);
            if (resolved.action === 'skip' || resolved.action === 'skip_local') { alreadyCount++; settings.lastCloudSha[p] = cloud.sha || cSha; continue; }
            if (resolved.action === 'fastforward') { count++; updatedCount++; settings.lastCloudSha[p] = cloud.sha || cSha; continue; }
            if (resolved.action === 'import_cloud_as_new') { count++; settings.lastCloudSha[p] = cloud.sha || cSha; continue; } // 已在弹窗分支里另存新聊天
            // resolved.action === 'new'：本地没有该聊天 → 直接写盘到目标角色的聊天目录（TT/ST 后端 /api/chats/save 按 avatar_url 定位，不依赖当前角色/表单）
            // ⚠️ 不用 /api/chats/import（TT 旧shim，表单 avatar_url 在批量时不刷新→写错目录→Chat not found）
            //   也不用官方 saveChat（绑定当前 this_chid，不适合 noJump 批量）。
            // 依据：src/endpoints/chats.js:470 save 端点按 avatar_url(+file_name)+chat[] 落盘；本插件 readLocalChatMsgs/pullMergeCloudSuperset 已用它读写任意聊天。
            const cloudMsgs = parseJsonlMessages(cloud.content);
            const safe = String(fileName).replace(/\.jsonl$/i, '');
            const saveAv = String(cardAvatar || '').includes('.png') ? cardAvatar : (cardAvatar || '') + '.png';
            const headerObj = { user_name: 'unused', character_name: 'unused', create_date: new Date().toISOString(), last_mes: new Date().toISOString(), chat_metadata: {} };
            const saveRes = await fetch('/api/chats/save', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({
                    avatar_url: saveAv,
                    file_name: safe,
                    chat: [headerObj, ...cloudMsgs].filter(Boolean),
                    force: true,
                }),
            });
            if (saveRes.ok) {
                count++;
                importedFileName = safe + '.jsonl';
                setLocalName(charName, p, safe + '.jsonl');
            } else {
                console.warn('[chat-sync] TT 聊天落盘失败', fileName, saveRes.status);
            }
        }
    } catch (e) { console.warn('[chat-sync] TT 导入失败', e); }
    // ⚠️ 修复「Chat not found」根因：TT 批量导入(noJump)后，本地角色 .chat 指的可能是
    //   幻影名(旧导入残留/空 → script.js:1307 浅索引对无 .chat 角色自动生成"名-时间戳"幻影) → TT 打开即"Chat not found"。
    // 走与单角色导入同一条已验证可靠的路 loadImportedChat(=openCharacterChat: 设.char+getChat+createOrEditCharacter 落盘)，
    // 把 .chat 持久化到真实聊天文件(代码注释 1193-1196 明确：只改内存.char+saveCharacterDebounced 不落盘，且可能清空卡，须用 openCharacterChat)。
    if (cardAvatar) {
        try {
            const cIdx = (getContext().characters || []).findIndex(x => String(x.avatar || '').replace(/\.png$/,'') === cardAvatar);
            if (cIdx >= 0) {
                const cur = getContext().characters && getContext().characters[cIdx] ? getContext().characters[cIdx].chat : '';
                let curReal = false, realSorted = [];
                try {
                    const cs = await fetch('/api/characters/chats', { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify({ avatar_url: cardAvatar + '.png' }) });
                    const arr = Object.values(await cs.json());
                    // 取真实聊天列表, 并按 last_mes(内容最后消息 send_date, ISO) 降序 → 最新改动在最前
                    realSorted = (arr || []).filter(x => x && x.file_name).sort((a, b) => (Date.parse(b.last_mes) || 0) - (Date.parse(a.last_mes) || 0));
                    curReal = realSorted.some(x => x.file_name === String(cur || '').replace(/\.jsonl$/i, '') + '.jsonl');
                } catch { /* 查不到列表则保守处理 */ }
                // 仅当当前 .chat 为空或指向不存在文件时才修正（已指向真实文件则保留，避免覆盖用户当前聊天）
                if ((!cur || !curReal) && realSorted.length) {
                    // 修正目标：取"整列表里最后改动/发消息最晚"的真实聊天（用户要求点卡自动开最近改动），去.jsonl
                    let target = String(realSorted[0].file_name).replace(/\.jsonl$/i, '');
                    if (!realSorted.some(x => x.file_name === target + '.jsonl')) target = String(realSorted[0].file_name).replace(/\.jsonl$/i, '');
                    // ⚠️ 不能在这渲染/加载聊天(loadImportedChat/openCharacterChat/getChat/setCharacterId/select_selected_character)：
                    //   批量导入遇到超大聊天(几 MB)或真实卡会阻塞 TT 主线程→页面冻结(实测)。
                    //   改【服务端 /api/characters/edit 持久化 .chat】(写盘不渲染) + 内存同步：不冻结、跨重启不幻影，"点卡才进"。
                    try {
                        // 服务端持久化 .chat(不渲染不冻结) + 内存同步；失败只告警(导入本体不受影响)
                        getContext().characters[cIdx].chat = target;
                        if (cardAvatar) await persistChatPointerStt(charName, cardAvatar, target);
                        console.log(`[chat-sync] TT 持久化「${charName}」.chat → ${target}`);
                    } catch (e) { console.warn('[chat-sync] TT 设 .chat 失败', e); }
                }
            }
        } catch (e) { console.warn('[chat-sync] TT 修正 .chat 失败', e); }
    }
    diag.lastRun = { ...(diag.lastRun || {}), ttChatImportedCount: count, ttImportedFileName: importedFileName };
    return count;
}
function parseJsonlMessages(jsonlText) {
    const out = [];
    const lines = String(jsonlText || '').split('\n');
    for (const line of lines) {
        if (!line.trim()) continue;
        let o;
        try { o = JSON.parse(line); } catch { continue; }
        if (!o || typeof o !== 'object') continue;
        if (o.chat_metadata !== undefined || o.user_name !== undefined) continue; // header 行
        if (Object.keys(o).length === 0) continue; // 幽灵 {}
        if (o.is_user === undefined && o.mes === undefined) continue; // 非消息
        out.push(o);
    }
    return out;
}

// ===================== 楼层级合并（多端并发不丢消息的收敛核心） =====================
// 聊天文件视为「消息列表」。每条消息给一个稳定签名（指纹），同步 = 合并两端的并集并按签名去重，
// 得到 merged 后再写回本地同一文件 + 覆盖云。因为两端对同一云端并集结果相同，多端并发也不丢消息、不重复。
// 指纹用 is_user+send_date+mes+swipe_id：对「同一聊天继续追加楼层」这个主导场景稳定；
// 编辑已发消息会改 mes → 变新签名（视为新条，代价小、绝不丢）；
// 删除只发生在一端时，并集会把删掉的带回来（合并偏向不丢，不偏删除）。这些是有意取舍。
function jsonStableString(v) {
    if (v === null || v === undefined) return '';
    if (Array.isArray(v)) return '[' + v.map(jsonStableString).join(',') + ']';
    if (typeof v === 'object') {
        return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + jsonStableString(v[k])).join(',') + '}';
    }
    return JSON.stringify(v);
}
// 内容差异判定: 'same'=指纹一致(同步跳过) | 'local'=本地较新 | 'cloud'=云端较新(别处改过) | null=云端缺失
const __diffCache = {}; // {path: {val, ts}} 5分钟复用
function __diffOf(cloudObj, localText, path) {
    if (!cloudObj || cloudObj.content === undefined) return null; // 云端缺失 → 存在性徽章已说明
    const now = Date.now();
    const hit = __diffCache[path];
    if (hit && now - hit.ts < 300000) return hit.val;
    let r;
    if (String(cloudObj.content) === String(localText === undefined ? '' : localText)) r = 'same';
    else {
        const mem = settings.lastCloudSha && settings.lastCloudSha[path];
        r = (mem && cloudObj.sha !== mem) ? 'cloud' : 'local'; // 上次同步后云端被改过 → 云端新
    }
    __diffCache[path] = { val: r, ts: now };
    return r;
}
const DIFF_LABEL = { same: '✓', local: '本地新', cloud: '云端新', diff: '两边不同' };
const DIFF_TITLE = {
    same: '内容指纹一致，勾选同步时会自动跳过',
    local: '本地内容较新（云端未被别处改过），上传会更新云端',
    cloud: '云端内容较新（别处上传过或尚未拉取），导入会更新本地',
    diff: '两边内容不同，且无法判断哪边更新',
};
// 渲染后异步补齐差异徽章(存在性徽章先出, 内容位后补; 并发3防限流)
// 批量差异比对: 一次目录请求(拿sha=内容哈希) + 本地算 blob sha 对比, 不再逐项下载云端内容
async function __diffMapOf(dir, localTextOf, remapKey = null) {
    const arr = await __cachedListEntries(dir);
    const shaMap = new Map(arr.filter((e2) => e2.type === 'file' && e2.name.endsWith('.json')).map((e2) => [e2.name.replace(/\.json$/, ''), e2.sha]));
    const out = new Map();
    for (const [key, sha] of shaMap) {
        const localText = await localTextOf(key, remapKey);
        if (localText === null) continue; // 仅云端: 无"谁新"可比(存在性徽章已表达)
        const lb = await gitBlobSha(new TextEncoder().encode(localText));
        if (lb === sha) { out.set(key, 'same'); continue; }
        const p = `${dir}/${key}.json`;
        const mem = settings.lastCloudSha && settings.lastCloudSha[p];
        out.set(key, (mem && sha !== mem) ? 'cloud' : 'local');
    }
    return out;
}
// 仅当首段是已知 apiId(openai等)时才剥离, 预设名自身含'|'不会被误剥
function __stripApiId(v) {
    const s = String(v);
    const i = s.indexOf('|');
    if (i > 0) {
        const head = s.slice(0, i);
        if (typeof CONN_PRESET_GROUPS !== 'undefined' && CONN_PRESET_GROUPS.some((g) => g.apiId === head)) return s.slice(i + 1);
    }
    return s;
}
function __valueOf(cbValue) { return __stripApiId(cbValue); }
async function __fillDiffBadges() {
    const drv = window.__cfgDrivers && window.__cfgDrivers[window.__cfgTab];
    if (!drv || typeof drv.diffMap !== 'function') return;
    const rows = [...document.querySelectorAll('#cs_cfg_list label.cs-role-item')];
    if (!rows.length) return;
    const dm = await drv.diffMap().catch(() => null);
    if (!dm) return;
    rows.forEach((row) => {
        try {
            const cb = row.querySelector('input[type="checkbox"]');
            if (!cb) return;
            const key0 = __valueOf(cb.value);
            let r = dm.get(key0);
            if (r === undefined) { // 大小写兜底(扩展目录改名/大小写漂移时仍能对上)
                const kl = String(key0).toLowerCase();
                for (const [k2, v2] of dm) if (String(k2).toLowerCase() === kl) { r = v2; break; }
            }
            const sp = row.querySelector('.cs-where-diff');
            if (!sp) return;
            if (!r || r === 'same') { sp.textContent = ''; sp.title = ''; return; } // 一致/无云端: 不占位
            // 有差异: 徽章直接显示差异词(去掉「双端/仅本地」前缀与「·」), 更简洁
            sp.textContent = DIFF_LABEL[r];
            sp.title = DIFF_TITLE[r];
            const wb = sp.closest('.cs-cln-where');
            if (wb) { for (const n of [...wb.childNodes]) if (n.nodeType === 3) n.textContent = ''; }
        } catch { }
    });
    __applyCfgFilter(); // 差异徽章填充完重放筛选(本地新/云端新)
}
function messageSignature(m) {
    if (!m || typeof m !== 'object') return '';
    const kind = m.is_user ? 'u' : (m.is_user === false ? 'c' : 'x');
    const mes = m.mes !== undefined ? String(m.mes) : '';
    const date = m.send_date !== undefined ? String(m.send_date) : (m.create_date !== undefined ? String(m.create_date) : '');
    return kind + '|' + date + '|' + (m.swipe_id !== undefined ? String(m.swipe_id) : '') + '|' + jsonStableString(mes);
}
// 两个消息列表是否「完全一致」（逐条签名比对，顺序敏感）。用于内容级增量判断（是否已同步）。
function sameMessageSequence(a, b) {
    const A = (a || []).map(messageSignature);
    const B = (b || []).map(messageSignature);
    if (A.length !== B.length) return false;
    for (let i = 0; i < A.length; i++) if (A[i] !== B[i]) return false;
    return true;
}
// 判定两份聊天（本地/云端）的关系，按「公共前缀 + 余段」判断是否安全快进/上传或已分叉。
// 返回 { relation, common, localTail, cloudTail, localCount, cloudCount }
//   relation:
//     'identical'        —— 指纹序列完全相同 → 跳过
//     'cloud_superset'   —— 云端是本地超集(本地只有公共前缀, 云端尾部全是新增) → 安全快进到云端
//     'local_superset'   —— 本地是云端超集(云端只有公共前缀, 本地尾部全是新增) → 上传本地(不弹框)
//     'diverged'         —— 两边在某一处指纹不同 → 分叉, 弹框让用户选
function classifyChatDiff(localMsgs, cloudMsgs) {
    const sig = (m) => messageSignature(m);
    const L = localMsgs.map(sig);
    const C = cloudMsgs.map(sig);
    const localSet = new Set(L);
    const cloudSet = new Set(C);
    const localInCloud = L.every((s) => cloudSet.has(s));       // 本地每条都在云端
    const cloudInLocal = C.every((s) => localSet.has(s));       // 云端每条都在本地
    // 集合包含关系优先（处理「本地删中间楼」：云端仍含本地全部+多的 → cloud_superset，而非误判 diverged）
    let relation;
    if (localInCloud && cloudInLocal) relation = 'identical';           // 集合相同
    else if (localInCloud && !cloudInLocal) relation = 'cloud_superset'; // 云端⊋本地(云端含全部本地+多的)
    else if (cloudInLocal && !localInCloud) relation = 'local_superset'; // 本地⊋云端
    else relation = 'diverged';                                         // 两边各有对方没有的(真分叉)
    // 公共前缀(仍算, 单测/提示用)
    let common = 0;
    const min = Math.min(L.length, C.length);
    while (common < min && L[common] === C[common]) common++;
    // 是否「本地顺序不连续/删了中间楼」：本地是云端子集 且 本地不是云端的前缀子序列时, 说明删的是中间楼。
    //   localContig: 本地在云端中是否保持连续顺序(严格前缀或子序列不跳)
    //   middleGap:   本地删了中间楼(云端有本地某两条之间缺失的消息)
    let localContig = true, middleGap = false;
    if (relation === 'cloud_superset') {
        // 本地各条都应在云端按序出现; 检查是否连续(间隔允许末尾增量但不允许中间缺)
        let ci = 0;
        let gaps = 0;
        for (let li = 0; li < L.length && ci < C.length; li++) {
            const found = C.indexOf(L[li], ci);
            if (found < 0) { localContig = false; break; }
            gaps += (found - ci);
            ci = found + 1;
        }
        // 末尾增量(云端多几条尾巴)不算 gap; 但中间跳过的算
        middleGap = gaps > 0;
        // 若本地全部命中且中间无跳(仅末尾多), 则 localContig 保持 true
        if (!middleGap) localContig = true;
    }
    return { relation, common, localTail: L.slice(common).map((_, i) => localMsgs[common + i]), cloudTail: C.slice(common).map((_, i) => cloudMsgs[common + i]), localCount: L.length, cloudCount: C.length, middleGap, localContig };
}


// 把 header + 消息列表序列化成标准 ST jsonl 文本（用于上传合并后的聊天）
function serializeChatJsonl(headerObj, messages) {
    const header = {
        user_name: headerObj && headerObj.user_name || 'unused',
        character_name: headerObj && headerObj.character_name || 'unused',
        create_date: headerObj && headerObj.create_date || new Date().toISOString(),
        last_mes: headerObj && headerObj.last_mes || new Date().toISOString(),
        chat_metadata: (headerObj && headerObj.chat_metadata) || {},
    };
    const lines = (messages || []).map((m) => JSON.stringify({
        name: m.name, is_user: m.is_user, is_name: m.is_name,
        create_date: m.create_date, send_date: m.send_date, mes: m.mes,
        extra: m.extra, swipes: m.swipes, swipe_id: m.swipe_id,
        disable_date: m.disable_date, bookmark: m.bookmark,
        force_avatar: m.force_avatar, original_avatar: m.original_avatar,
        chat_metadata: m.chat_metadata,
    }));
    return JSON.stringify(header) + '\n' + lines.join('\n');
}

// 当前打开聊天做冲突检测 + 楼层级快速同步（按「公共前缀/余段」判定包含或分叉）。
// 仅对「当前打开且已绑 syncMap 的聊天」做（saveChat 只写当前打开那个文件；新楼层也只在此产生）。
// 返回 { action, addedCloudCount, diverged } 或 null。
async function syncOpenChat(charName) {
    try {
        const chatFile = String(ctx().chatId || '').replace(/\.jsonl$/i, '') + '.jsonl';
        if (!chatFile || chatFile === '.jsonl') return null;
        const p = cloudPathOfLocal(charName, chatFile);
        if (!p) return null;
        const cloud = await Gitee.getText(p);
        const localMsgs = (ctx().chat || []).filter((m) => m && typeof m === 'object' && m.mes !== undefined);
        if (!localMsgs.length && !cloud) return null;
        const cloudMsgs = cloud ? parseJsonlMessages(cloud.content) : [];
        const diff = classifyChatDiff(localMsgs, cloudMsgs);
        const c = ctx();
        const header = cloud ? parseHeader(cloud.content) : {};

        // —— identical：两端一致，跳过 ——
        if (diff.relation === 'identical') {
            return { action: 'none', addedCloudCount: 0, diverged: false };
        }
        // —— cloud_superset：云端比本地多（云端⊇本地），安全快进——把云端新楼层写进本地同一文件，并上传——
        if (diff.relation === 'cloud_superset') {
            const added = diff.cloudTail;
            // 本地正在拆楼的口径去重/追加快递：把云端多出的、本地还没有的指纹追加到 ctx.chat
            const curSigs = new Set((c.chat || []).map(messageSignature));
            const newOnes = added.filter((m) => !curSigs.has(messageSignature(m)));
            if (newOnes.length) {
                c.chat.splice(c.chat.length, 0, ...newOnes);
                diag.lastRun = { ...(diag.lastRun || {}), fastForward: { added: newOnes.length } };
                if (typeof c.saveChat === 'function') await c.saveChat(); // 写回本地同一文件
                settings.lastLocalMTime[p] = Date.now();
            }
            // 上传「本地已最新」的整份（一次 PUT）
            const upMsgs = (c.chat || []).filter((m) => m && m.mes !== undefined);
            const chatText = serializeChatJsonl(header, upMsgs);
            const cloudCur = await Gitee.getText(p);
            await Gitee.putText(p, chatText, cloudCur?.sha, `sync ff ${chatFile}`);
            settings.lastCloudSha[p] = (await Gitee.getText(p)).sha;
            return { action: 'fastforward', addedCloudCount: newOnes.length, diverged: false };
        }
        // —— local_superset：本地比云端多（本地⊇云端）→ 让用户选「覆盖/追加」，避免自动偷偷覆盖云端 ——
        if (diff.relation === 'local_superset') {
            const decision = await resolveUploadConflict(localMsgs, cloudMsgs, chatFile, null);
            if (decision === 'cancel') return { action: 'none', addedCloudCount: 0, diverged: false };
            if (decision === 'skip') return { action: 'none', addedCloudCount: 0, diverged: false };
            const text = buildCloudUploadText(localMsgs, cloudMsgs, header, decision);
            const cloudCur = await Gitee.getText(p);
            await Gitee.putText(p, text, cloudCur?.sha, `${decision === 'append' ? 'append' : 'sync push'} ${chatFile}`);
            settings.lastCloudSha[p] = (await Gitee.getText(p)).sha;
            settings.lastLocalMTime[p] = Date.now();
            return { action: 'push', addedCloudCount: 0, diverged: false };
        }
        // —— diverged：两边在公共前缀后分叉 → 弹框让用户选，并执行所选动作 ——
        if (diff.relation === 'diverged') {
            diag.lastRun = { ...(diag.lastRun || {}), divergedAt: { common: diff.common, local: diff.localTail.length, cloud: diff.cloudTail.length } };
            // CUSTOM1 = 用云端(本地另存为分支); CUSTOM2 = 用本地(覆盖云端); default CUSTOM1
            const CHOOSE_CLOUD = 1001, CHOOSE_LOCAL = 1002;
            const choice = await Popup.show.confirm(
                '⚠️ 聊天分叉冲突',
                '这个聊天在云端和本地各走了不同分支（公共 ' + diff.common + ' 层后：本地另有 ' + diff.localTail.length + ' 层，云端另有 ' + diff.cloudTail.length + ' 层）。',
                {
                    defaultResult: CHOOSE_CLOUD,
                    customButtons: [
                        { text: '以云端为准（本地另存为分支，两者都保留）', result: CHOOSE_CLOUD, classes: ['popup-button-ok'] },
                        { text: '以本地为准（用本地覆盖云端）', result: CHOOSE_LOCAL, classes: ['popup-button-cancel'] },
                    ],
                },
            );
            // 执行所选动作
            if (choice === CHOOSE_CLOUD) {
                // 把云端这份另存为本地新聊天条目（保留本地分支），云端保持不动
                await importCloudChatAsNew(charName, p, cloud, chatFile);
                return { action: 'pull_cloud_as_new', diverged: true, common: diff.common };
            }
            // CHOOSE_LOCAL：用本地覆盖云端
            const chatText = serializeChatJsonl(header, localMsgs);
            const cloudCur = await Gitee.getText(p);
            await Gitee.putText(p, chatText, cloudCur?.sha, `sync resolve-local ${chatFile}`);
            settings.lastCloudSha[p] = (await Gitee.getText(p)).sha;
            return { action: 'overwrite_local', diverged: true, common: diff.common };
        }
        return null;
    } catch (e) { console.warn('[chat-sync] 楼层同步失败', e); return null; }
}
// 把云端某聊天另存为本地一条新聊天记录（保留本地方支），供冲突「以云端为准」用。
async function importCloudChatAsNew(charName, cloudPath, cloud, originalFile) {
    try {
        const jsonlContent = ensureChatJsonlHeader(cloud.content, ctx().name1, ctx().name2);
        const file = new File([new Blob([jsonlContent], { type: 'application/octet-stream' })], `import-branch-${Date.now()}.jsonl`, { type: 'application/octet-stream' });
        let result = null;
        if (window.__TAURITAVERN__) {
            // ⚠️ TT：必须复刻「手动导入」同款方式 —— 先选中该角色卡(让 #form_import_chat 表单被填成该卡的 avatar/name)，
            //   再从表单 new FormData()，不能手动 set avatar_url（TT 只认表单里的值，手动 set 会错位导入失败）。
            let idx = (ctx().characters || []).findIndex(x => (x.name || '') === charName);
            if (idx < 0) idx = (ctx().characters || []).findIndex(x => String(x.avatar || '').replace(/\.png$/, '') === charName);
            if (idx >= 0) {
                try { select_selected_character(idx, { switchMenu: false }); } catch (e) { console.warn('[chat-sync] TT select 角色失败', e); }
            }
            const formEl = document.getElementById('form_import_chat');
            const fd = new FormData(formEl || document.createElement('form'));
            fd.set('file_type', 'jsonl');
            fd.set('avatar', file);
            fd.set('user_name', ctx().name1);
            result = await importCharacterChat(fd, { refresh: false });
        } else {
            // ST：原手动 set 方式（ST 认 avatar_url 字段）
            const formData = new FormData();
            formData.set('file_type', 'jsonl');
            formData.set('avatar', file);
            formData.set('avatar_url', ctx().characters[ctx().characterId]?.avatar || '');
            formData.set('user_name', ctx().name1);
            formData.set('character_name', ctx().name2 || ctx().characters[ctx().characterId]?.name || '');
            const importFn = ctx().groupId ? importGroupChat : importCharacterChat;
            result = await importFn(formData, { refresh: false });
        }
        if (result && result.length) {
            setLocalName(charName, `${cloudPath}#branch-${Date.now()}`, result[0]); // 分支绑定不同本地名（云路径加后缀，避免覆盖原映射）
        }
        toastr.success('已把云端分叉另存为一条新聊天记录，两边都保留了');
    } catch (e) { console.warn('[chat-sync] 分支另存失败', e); toastr.error('分支另存失败：' + (e && e.message)); }
}
// ===================== 待办A：手动整包导入的冲突判定 + 聪明版合并（与双端实时同一套判定） =====================
// 手动整包导入(importCharFromCloud / importChatsTtNative)时，对每条云端聊天：先查本地是否已有同聊天。
// 有且本地真有文件 → 读本地消息 vs 云端消息，classifyChatDiff 判定：
//   identical / local_superset → 跳过（本地已最新或本地更新，不覆盖、不新建）
//   cloud_superset（云端比本地多新楼层）→ 聪明版：把云端新楼层补进本地已有文件（写回），不弹框
//   diverged（分叉）→ 弹框让用户选「以云端为准另存分支 / 以本地为准」
// 返回动作对象供调用方执行「全新导入(建映射)」或直接采纳。
// 本地已有文件的读取/写回用 /api/chats/get + /api/chats/save（两端都是独立后端，均支持按 avatar_url 读写任意聊天文件，
// 不依赖「当前打开聊天」——这是它不同于 syncOpenChat(强依赖 ctx.chat/saveChat) 的关键，可整包复用）。

// 读指定的本地聊天文件消息数组（avatar=目标卡 stem 或带 .png；file_name 可带 .jsonl）。
// 文件不存在/空 → 返回 []（不抛错，调用方自行判断「是否真的有本地文件」用 localNames 集合）。
// ⚠️ avatar_url 对 TT /api/chats/get 必须能解析到真实角色（TT 严格校验），统一补 .png —— ST 内部会 .replace('.png','')，两端都兼容。
async function readLocalChatMsgs(avatar, fileName) {
    try {
        const av = String(avatar || '').includes('.png') ? String(avatar) : String(avatar || '') + '.png';
        const r = await fetch('/api/chats/get', {
            method: 'POST',
            headers: getRequestHeaders(),
            cache: 'no-cache',
            body: JSON.stringify({ avatar_url: av, file_name: String(fileName || '').replace(/\.jsonl$/i, '') }),
        });
        if (!r.ok) return [];
        const data = await r.json();
        if (!Array.isArray(data)) return [];
        // 消息 = 非 header、非幽灵空对象、有 mes 的对象（data[0] 是 header，会被 filter 掉）
        return data.filter((m) => m && typeof m === 'object' && m.mes !== undefined && Object.keys(m).length > 0);
    } catch (e) { console.warn('[chat-sync] 读本地聊天失败(按无本地处理)', fileName, e); return []; }
}

// 纯逻辑判定（与 test-import-merge.js 单测一致）：
// identical/local_superset → {action:'skip'}；cloud_superset → {action:'fastforward', merged, added}；diverged → {action:'diverged'}
function decideImportMerge(localMsgs, cloudMsgs) {
    const diff = classifyChatDiff(localMsgs || [], cloudMsgs || []);
    if (!diff) return { action: 'skip', diff };
    if (diff.relation === 'identical' || diff.relation === 'local_superset') return { action: 'skip', diff };
    if (diff.relation === 'cloud_superset') {
        // 聪明版合并：merged = 本地 + 云端尾差中(按签名)本地没有的新楼层
        const sigs = new Set((localMsgs || []).map(messageSignature));
        const cloudTail = diff.cloudTail && diff.cloudTail.length ? diff.cloudTail : (cloudMsgs || []).slice(diff.common || 0);
        const newOnes = cloudTail.filter((m) => !sigs.has(messageSignature(m)));
        return { action: 'fastforward', diff, merged: (localMsgs || []).concat(newOnes), added: newOnes.length };
    }
    return { action: 'diverged', diff };
}

// 完整处理一条「本地已有该聊天」的云端聊天：判定 + 采样（cloud_superset 写回 / diverged 弹框并执行），返回动作。
// cloudPath = sync/<char>/chats/<file>.jsonl（云端完整路径）；knownLocal = syncMap 里映射的本地文件名；
// localNames = 该角色本地已有聊天文件名的 Set（用于确认本地文件是否真的存在）。
// 返回：
//   { action:'new' }                       —— 无映射，调用方照旧全新导入并 setLocalName 建映射
//   { action:'skip', reason, count }       —— identical/local_superset/本地文件不存在，跳过（count=1 计为"已存在跳过"）
//   { action:'fastforward', added, count } —— cloud_superset，已完成：云端新楼层写回本地已有文件（count=1 计为"已更新"）
//   { action:'import_cloud_as_new' }       —— diverged + 用户选「以云端为准」，需调用方用导入路径把云端另存为本地新分支
//   { action:'skip_local', count }         —— diverged + 用户选「以本地为准」，不覆盖本地（count=1）
async function resolveCloudChatImport(charName, cardAvatar, cloudPath, cloud, localNames) {
    const knownLocal = localNameOf(charName, cloudPath);
    const headerObj = cloud ? parseHeader(cloud.content) : {};
    // 无映射，或映射指向的本地文件并不存在（可能被删/换端）→ 走全新导入并重绑映射
    if (!knownLocal || !localNames.has(knownLocal)) {
        return { action: 'new' };
    }
    // 读本地已有文件消息 + 云端消息，做冲突判定
    const localMsgs = await readLocalChatMsgs(cardAvatar, knownLocal);
    const cloudMsgs = cloud ? parseJsonlMessages(cloud.content) : [];
    // 本地读出来是空（文件存在但内容读不到）→ 保守当作有该文件但暂无消息；若云端有消息则云端口算快进写回
    const decision = decideImportMerge(localMsgs, cloudMsgs);

    if (decision.action === 'skip') {
        return { action: 'skip', reason: decision.diff && decision.diff.relation, count: 1 };
    }
    if (decision.action === 'fastforward') {
        // 聪明版：把云端新楼层并入本地已有文件，写回本地（不弹框、不新建文件、不改映射）
        try {
            // 把「本地 + 云端新楼层」的完整消息写回本地同一个文件（/api/chats/save 按 avatar_url+file_name 直接落盘，不依赖当前打开聊天）
            // ⚠️ TT 的 /api/chats/save 也要求 avatar_url 能解析到真实角色，统一补 .png
            const saveAv = String(cardAvatar || '').includes('.png') ? String(cardAvatar) : String(cardAvatar || '') + '.png';
            // 并发兜底：写盘前一瞬用户已开始生成(roll) → 放弃补楼写回，避免覆盖生成内容
            if (csReallyGenerating()) { console.warn('[chat-sync] 用户正在生成，放弃导入补楼写回', knownLocal); return { action: 'skip', reason: 'generating', count: 1 }; }
            const r = await fetch('/api/chats/save', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({
                    avatar_url: saveAv,
                    file_name: String(knownLocal).replace(/\.jsonl$/i, ''),
                    chat: [{ user_name: 'unused', character_name: 'unused', create_date: headerObj.create_date || new Date().toISOString(), last_mes: headerObj.last_mes || new Date().toISOString(), chat_metadata: (headerObj.chat_metadata) || {} }].concat(decision.merged),
                    force: true,
                }),
            });
            if (r.ok) {
                toastr.success(`聊天「${knownLocal}」云端有新楼层，已自动补进本地（+${decision.added} 层）`);
                return { action: 'fastforward', added: decision.added, count: 1 };
            }
            console.warn('[chat-sync] 云端合并写回本地失败，回退为跳过', knownLocal, r.status);
        } catch (e) { console.warn('[chat-sync] 云端合并写回本地异常，回退为跳过', e); }
        return { action: 'skip', reason: 'fastforward_write_failed', count: 1 };
    }
    if (decision.action === 'diverged') {
        const diff = decision.diff;
        // CUSTOM1 = 以云端为准(本地另存分支); CUSTOM2 = 以本地为准(不覆盖本地)
        const CHOOSE_CLOUD = 2001, CHOOSE_LOCAL = 2002;
        const choice = await Popup.show.confirm(
            '⚠️ 手动导入时发现聊天分叉',
            `聊天「${knownLocal}」在云端和本地各走了不同分支（公共 ${diff.common} 层后：本地另有 ${diff.localTail.length} 层，云端另有 ${diff.cloudTail.length} 层）。要保留哪边？`,
            {
                defaultResult: CHOOSE_CLOUD,
                customButtons: [
                    { text: '以云端为准（云端这份另存为本地新记录，两边都保留）', result: CHOOSE_CLOUD, classes: ['popup-button-ok'] },
                    { text: '以本地为准（保留本地，跳过云端这份）', result: CHOOSE_LOCAL, classes: ['popup-button-cancel'] },
                ],
            },
        );
        if (choice === CHOOSE_CLOUD) {
            // 复用既有 importCloudChatAsNew：把云端这份另存为本地新聊天（保留本地分支）
            await importCloudChatAsNew(charName, cloudPath, cloud, knownLocal);
            return { action: 'import_cloud_as_new', count: 1 };
        }
        return { action: 'skip_local', count: 1 };
    }
    return { action: 'skip', count: 1 };
}

// 取 jsonl 首行 header 对象
function parseHeader(jsonlText) {
    const first = String(jsonlText || '').split('\n')[0];
    try { return JSON.parse(first); } catch { return {}; }
}

// 给聊天 jsonl 补 ST 标准 header（第一行须含 user_name/name/chat_metadata，否则 /api/chats/import 报 Unsupported JSONL）
// 若已含 header 则原样返回。额外处理旧数据：首行若是空对象 {}（老版把 ST header 当消息序列化成 {} 导致的，
// 无 name 也无 header 字段），把它当幽灵行剔除，避免导入后出现一条空消息。
function ensureChatJsonlHeader(jsonlText, userName, charName2) {
    const text = String(jsonlText || '');
    // 空/空白聊天：后端 /api/chats/import 会 JSON.parse(首行) 失败报 EOF/Unsupported，不能返回空串。
    // 补一个只有合法 header 的空聊天（无消息），使导入成为"空白聊天"而非报错。
    if (!text.trim()) {
        return JSON.stringify({
            user_name: userName || 'User',
            character_name: charName2 || 'Character',
            create_date: new Date().toISOString(),
            last_mes: new Date().toISOString(),
            chat_metadata: {},
        });
    }
    let lines = text.split('\n');
    // 剔除首行空对象 {}（幽灵 header 行）
    while (lines.length) {
        try {
            const o = JSON.parse(lines[0]);
            if (o && typeof o === 'object' && Object.keys(o).length === 0) { lines.shift(); continue; }
        } catch { /* 非 JSON 首行 → 保留处理 */ }
        break;
    }
    if (!lines.length) return text;
    const firstLine = lines[0];
    try {
        const obj = JSON.parse(firstLine);
        // 真正的 ST header 才含这些字段（消息只有 name/is_user/mes，不会 user_name/character_name/chat_metadata）。
        // 注意：不能用 name 当判据——首行若是消息带 name，会被当成 header 直接放行，
        // 导致真实首条消息内容被吞、且 TT 也可能因此误判。所以只有含 header 专属字段才算已带 header。
        if (obj.chat_metadata !== undefined || obj.user_name !== undefined || obj.character_name !== undefined) {
            return lines.join('\n'); // 已是合法 header
        }
    } catch { /* 非 JSON 首行 → 直接补 header */ }
    const header = JSON.stringify({
        user_name: userName || 'User',
        character_name: charName2 || 'Character',
        create_date: new Date().toISOString(),
        last_mes: new Date().toISOString(),
        chat_metadata: {},
    });
    return header + '\n' + lines.join('\n');
}

// 删除云端某个角色的整条记录（卡+世界书+聊天+清单，递归删 sync/<角色>/ 下所有文件）
async function deleteCharFromCloud(charName) {
    if (!settings.owner || !settings.repo || !settings.token) { toastr.error('请先配置'); return; }
    if (!charName) { toastr.error('未选择要删除的角色'); return; }
    const base = `sync/${charName}`;
    const files = await Gitee.listAllFiles(base);
    if (files.length === 0) { toastr.info(`云端没有 ${charName} 的记录`); return; }
    let deleted = 0;
    for (const f of files) {
        try { await Gitee.deleteFile(f.path, f.sha, `delete ${f.path}`); deleted++; } catch (e) { console.warn('[chat-sync] 删除失败', f.path, e); }
    }
    // 清理本机记忆中的 sha/mtime
    for (const key of Object.keys(settings.lastCloudSha)) {
        if (key.startsWith(base)) delete settings.lastCloudSha[key];
    }
    for (const key of Object.keys(settings.lastLocalMTime)) {
        if (key.startsWith(base)) delete settings.lastLocalMTime[key];
    }
    saveSettingsDebounced();
    toastr.success(`已从云端删除角色「${charName}」的 ${deleted} 个文件 ✅`);
}

// 删除本地角色（含卡+全部聊天）。
// 依据：script.js:10768 官方 deleteCharacter(characterKey,{deleteChats=true}) —— 它删卡(10701)+删聊天+清理缓存/标签/触发
//      CHARACTER_DELETED/CHAT_DELETED 事件，并 removeCharacterFromUI()(10832) 刷新前端角色列表(clearChat/getCharacters/printMessages)。
//      本地裸 fetch('/api/characters/delete') 只删磁盘但前端 characters 数组/UI 不更新 → 列表残留（用户见"删除成功但一点不变"）。必须用官方函数。
// 注意 deleteCharacter 按 character.avatar（文件名）查找，avatar 用 getAvatarFor 取真实文件名。
// silent=true：批量删除时用，跳过每条成功 toast（批量已有汇总提示，避免「已删除+角色已删除」重复刷屏）。
async function deleteLocalCharacter(charName, skipConfirm = false, silent = false) {
    if (!charName) { toastr.error('未选择要删除的角色'); return; }
    if (!skipConfirm) {
        const ok = await csConfirm('⚠ 删除本地角色', `将删除本地角色 <b>「${escapeHtml(charName)}」</b> 及其全部聊天。<br>若还没上传备份，将无法找回，确定？`);
        if (!ok) return;
    }
    const avatar = getAvatarFor(charName);
    if (!avatar) { toastr.error('找不到本地角色「' + charName + '」，无法删除'); return; }
    // 临时聊天态下官方 deleteCharacter 会弹「您当前处于临时聊天中…将丢失未保存的消息」确认(script.js:10773)，
    // 该确认要"确定(1)"才会真删。skipConfirm=true 说明用户已在批量确认过；临时接管 confirm 自动返回 AFFIRMATIVE(1/确定)
    // 让本次删除继续，避免删 N 个角色弹 N 次窗阻断。仅本次调用作用域，立即恢复。
    let suppressDelete = null, restoreDelete = null; let Pdel = null;
    if (skipConfirm) {
        Pdel = (typeof window !== 'undefined' && window.Popup) || (typeof Popup !== 'undefined' ? Popup : null);
        if (Pdel && Pdel.show && typeof Pdel.show.confirm === 'function') {
            restoreDelete = Pdel.show.confirm.bind(Pdel.show);
            Pdel.show.confirm = () => Promise.resolve(1); // AFFIRMATIVE=确定(继续删除)
            suppressDelete = true;
        }
    }
    try {
        const success = await deleteCharacter(avatar, { deleteChats: true });
        if (suppressDelete && restoreDelete) Pdel.show.confirm = restoreDelete;
        if (success) {
            if (!silent) toastr.success(`已删除本地角色「${charName}」`);
            // 官方函数已 removeCharacterFromUI 刷新列表；再补一次插件自己的列表刷新
            window.__renderRoleMultiList && window.__renderRoleMultiList('local');
            return true;
        }
        toastr.error(`删除本地角色「${charName}」失败`);
        return false;
    } catch (e) {
        if (suppressDelete && restoreDelete && Pdel) Pdel.show.confirm = restoreDelete;
        toastr.error('删除失败：' + e.message); return false;
    }
}

// 解析用户输入的仓库值 → {owner, repo}
// 支持：完整URL(https://gitee.com/owner/repo) | owner/repo | 纯仓库名(repo)
function parseRepoInput(input) {
    input = (input || '').trim().replace(/\/+$/, '');
    if (!input) return { owner: '', repo: '' };
    // 去掉协议和域名后按 / 拆分
    const parts = input.replace(/^https?:\/\/[^/]+\//, '').split('/');
    if (parts.length >= 2) {
        return { owner: parts[0], repo: parts.slice(1).join('/') };
    }
    return { owner: '', repo: parts[0] };
}

// 用 token 拿当前 Gitee 用户名；失败返回 ''
async function fetchLogin(token) {
    try {
        const base = (settings.server || 'https://gitee.com/api/v5').replace(/\/$/, '');
        const isGh = base.includes('github');
        const isGl = base.includes('gitlab.com');
        const r = await fetch(`${base}/user?${isGl ? 'private_token' : 'access_token'}=${encodeURIComponent(token)}`, { headers: isGl ? { 'PRIVATE-TOKEN': token } : ({ 'Authorization': (isGh ? 'Bearer ' : 'token ') + token, ...(isGh ? { 'Accept': 'application/vnd.github+json' } : {}) }) });
        if (!r.ok) return '';
        const u = await r.json();
        return u.login || u.username || '';
    } catch { return ''; }
}

// 完整解析：给定 token + 仓库输入，返回可用的 {owner, repo}
async function resolveRepo(token, input) {
    let { owner, repo } = parseRepoInput(input);
    if (!owner) {
        // 只填了仓库名 → 用 token 自动推断用户名
        owner = await fetchLogin(token);
    }
    return { owner, repo };
}

// ===================== 设置面板 =====================
// 云端占用统计: 递归树全文件 size 求和(实测 Gitee tree 每项带 size; 配额 Gitee/GitHub 均不开放, 只报已用不报百分比)
function __fmtBytes(n) {
    if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB';
    if (n >= 1024) return (n / 1024).toFixed(0) + ' KB';
    return n + ' B';
}
async function __cloudUsage() {
    if (!settings.owner || !settings.repo || !settings.token) return null;
    const base = (settings.server || 'https://gitee.com/api/v5').replace(/\/$/, '');
    const isGh = base.includes('github');
    const isGl = base.includes('gitlab.com');
    let tree = [];
    const tryBranch = async (br) => {
        if (isGl) {
            const proj = encodeURIComponent(`${settings.owner}/${settings.repo}`);
            const all = [];
            for (let page = 1; page <= 100; page++) {
                const r = await fetch(`${base}/projects/${proj}/repository/tree?per_page=100&page=${page}&recursive=true&ref=${encodeURIComponent(br)}`, { headers: { 'PRIVATE-TOKEN': settings.token }, cache: 'no-store' });
                if (!r.ok) return [];
                const j = await r.json();
                if (!Array.isArray(j)) return [];
                all.push(...j);
                if (j.length < 100) return all;
            }
            return all;
        }
        const q = `recursive=1${isGh ? '' : '&access_token=' + encodeURIComponent(settings.token)}`;
        const r = await fetch(`${base}/repos/${settings.owner}/${settings.repo}/git/trees/${encodeURIComponent(br)}?${q}`, { headers: isGh ? { 'Authorization': 'Bearer ' + settings.token, 'Accept': 'application/vnd.github+json' } : {} });
        if (!r.ok) return [];
        return (await r.json()).tree || [];
    };
    tree = await tryBranch('master');
    if (!tree.length) tree = await tryBranch('main');
    const blobs = tree.filter((x) => x.type === 'blob');
    const total = blobs.reduce((s, x) => s + (typeof x.size === 'number' ? x.size : 0), 0);
    return { bytes: total, files: blobs.length };
}
async function __fillCloudUsage() {
    const el = document.getElementById('cs_usage');
    if (!el) return;
    try {
        const u = await __cloudUsage();
        if (!u) { el.textContent = ''; return; }
        el.textContent = `📦 云端已用 ${__fmtBytes(u.bytes)} · ${u.files} 个文件（Gitee/GitHub 未开放空间配额接口，故不显示百分比）`;
    } catch (e) {
        el.textContent = '📦 云端占用读取失败：' + ((e && e.message) || e);
    }
}
// 刷新「当前云端仓库/插件版本」行(保存配置、连接测试成功后即时更新, 不必重开面板)
function __refreshCurRepoLine() {
    const el = document.getElementById('cs_cur_repo');
    if (!el) return;
    const curRepo = settings.owner && settings.repo ? `${settings.owner}/${settings.repo}` : '（未配置）';
    const platName = String(settings.server || '').includes('github') ? 'GitHub' : (String(settings.server || '').includes('gitlab.com') ? 'GitLab' : 'Gitee');
    let lastConn = '—';
    try { if (settings.lastConnectAt) { const d = new Date(settings.lastConnectAt); lastConn = `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; } } catch { }
    el.innerHTML = `<b>🌐 仓库槽位：</b>${escapeHtml(platName)} · ${escapeHtml(curRepo)} · 最近连接 ${lastConn}<br><div style="display:flex;align-items:center;flex-wrap:wrap;gap:4px;margin-top:5px"><b style="color:var(--SmartThemeQuoteColor,#f0a35e)">🟢 插件版本 v${PLUGIN_VERSION}</b><span id="${'cs_upd_slot'}"></span><button id="cs_chk_manual" class="cs-chk-btn" type="button" title="手动检测是否有新版本">检测更新</button></div><label style="display:flex!important;align-items:center;gap:4px;font-size:1em;margin-top:5px;white-space:nowrap;width:auto;cursor:pointer" title="勾选后每次打开/启动插件时自动检查更新, 有新版自动升级并刷新页面"><input type="checkbox" id="cs_auto_upd" style="margin:0;flex:none;accent-color:var(--SmartThemeQuoteColor,#f0a35e)" ${settings.autoUpdate ? 'checked' : ''}><span>自动更新插件至最新</span></label><br><div id="cs_usage" style="opacity:.75;font-size:.82em;margin-top:2px">📦 云端占用统计中…</div><small style="opacity:.75">每台设备各自保存连接配置；「云端没有」≠「获取失败」，可先点「连接测试」看各目录数量</small>`;
    const slot2 = document.getElementById('cs_slot2');
    if (slot2) {
        const arr = Array.isArray(settings.connSlots) ? settings.connSlots : [];
        const cur = `${settings.owner}/${settings.repo}`;
        const curKey = String(settings.server || '') + '|' + cur;
        const opts = arr.map((x, i) => {
            const nm = (String(x.platform || '').includes('github') ? 'GitHub' : (String(x.platform || '').includes('gitlab.com') ? 'GitLab' : 'Gitee')) + ' · ' + x.repo;
            const key = String(x.platform || '') + '|' + x.repo;
            return `<option value="${i}" ${key === curKey ? 'selected' : ''}>${escapeHtml(nm)}</option>`;
        }).join('');
        slot2.innerHTML = `<b>📦 槽位：</b>${escapeHtml(platName)} · ${escapeHtml(curRepo)} · 最近连接 ${lastConn}` +
            (arr.length ? `<div style="display:flex;gap:4px;margin-top:4px;flex-wrap:wrap;align-items:center">
                <select id="cs_slot_sel" style="flex:1;min-width:0;font-size:.8em;padding:2px 4px">${opts}</select>
                <button type="button" id="cs_slot_del" class="cs-btn" style="padding:1px 8px;font-size:.72em">🗑 删除</button>
            </div>` : '<div style="font-size:.72em;opacity:.7;margin-top:2px">保存配置后自动存为槽位，可一秒切换</div>');
        const ss2 = document.getElementById('cs_slot_sel');
        if (ss2) ss2.addEventListener('change', () => window.__csApplySlot(Number(ss2.value)));
        const sd2 = document.getElementById('cs_slot_del');
        if (sd2) sd2.addEventListener('click', () => window.__csDeleteSlot(Number((document.getElementById('cs_slot_sel') || {}).value)));
    }
    __fillCloudUsage();
    try {
        if (typeof window.__csCheckUpdate === 'function') window.__csCheckUpdate();
        const _ck = document.getElementById('cs_chk_manual');
        if (_ck && !_ck.dataset.bound) {
            _ck.dataset.bound = '1';
            _ck.addEventListener('click', () => { try { window.__csManualCheck(_ck); } catch (e) { console.warn(e); } });
        }
    } catch { }
}
// ── 自动更新检测 + 一键自更新(走酒馆官方 /api/extensions/update) ──
const PLUGIN_REPO_RAW = 'https://gitee.com/satosaki/tavern-synchronization-plugin/raw/master/manifest.json';
function __csCompareVer(a, b) {
    const pa = String(a).split('.').map(Number);
    const pb = String(b).split('.').map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const x = pa[i] || 0, y = pb[i] || 0;
        if (x !== y) return x - y;
    }
    return 0;
}
const PLUGIN_REPO_MANIFEST_API = 'https://gitee.com/api/v5/repos/satosaki/tavern-synchronization-plugin/contents/manifest.json';
// base64(可含URL-safe/换行) → 文本(TT WebView 下 raw 直链无 CORS 头被拦, 必须走 gitee API contents)
function __b64ToText(s) {
    s = String(s).split('\r').join('').split('\n').join(' ').split(' ').join('').split('-').join('+').split('_').join('/');
    while (s.length % 4) s += '=';
    const bin = atob(s);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
}
async function __csFetchRemoteVer() {
    // 多源取最大版本: 权威 API 在前, raw/CDN 在后(可能有 CDN 缓存旧版);
    // 「第一个成功即返回」会让缓存旧版被当作最新→误判"本地更高", 故收集所有可达源版本取 max
    const M = { repo: 'SakiPr1me/st-chat-sync-release', branch: 'main' };
    const sv = String(settings.server || '');
    const sources = [
        PLUGIN_REPO_MANIFEST_API + '?t=' + Date.now(),                           // ① Gitee API(权威, 带 gitee token)
        `https://api.github.com/repos/${M.repo}/contents/manifest.json?t=${Date.now()}`, // ② GitHub API(权威镜像, 带 gh token/匿名)
        `https://raw.githubusercontent.com/${M.repo}/${M.branch}/manifest.json?t=${Date.now()}`, // ③ GitHub raw(CDN 可能缓存旧)
        `https://cdn.jsdelivr.net/gh/${M.repo}@${M.branch}/manifest.json`,        // ④ jsDelivr CDN(缓存较久, 仅兜底)
        'https://gitee.com/satosaki/tavern-synchronization-plugin/raw/master/manifest.json', // ⑤ Gitee raw
    ];
    const found = [];
    let lastErr = null;
    for (const url of sources) {
        try {
            const headers = {};
            if (url.includes('api.github.com')) { headers['Accept'] = 'application/vnd.github+json'; if (settings.token && sv.includes('github')) headers['Authorization'] = 'Bearer ' + settings.token; }
            else if (url.includes('gitee.com/api')) { headers['Authorization'] = 'token ' + (settings.token && (sv === '' || sv.includes('gitee')) ? settings.token : '2bf7029efdcafba86f4ed28968f85f25'); }
            const r = await fetch(url, { cache: 'no-store', headers, signal: AbortSignal.timeout(6000) });
            if (!r.ok) throw new Error('HTTP ' + r.status);
            const text = await r.text();
            let v = '';
            try {
                const j = JSON.parse(text);
                v = (j && typeof j.content === 'string') ? JSON.parse(__b64ToText(j.content)).version : j.version;
            } catch { throw new Error('parse'); }
            v = String(v || '').trim();
            if (v) found.push(v);
        } catch (e) { lastErr = e; }
    }
    if (!found.length) throw lastErr || new Error('所有更新源均失败');
    // 取可达源里的最大版本(拉平 CDN 旧缓存)
    return found.reduce((a, b) => (__csCompareVer(b, a) > 0 ? b : a));
}
window.__csRenderUpdateBtn = function (remoteVer) {
    const slot = document.getElementById('cs_upd_slot');
    if (!slot || slot.querySelector('.cs-upd-btn')) return;
    const btn = document.createElement('button');
    btn.className = 'cs-btn cs-upd-btn';
    btn.type = 'button';
    btn.textContent = '⬆ 可更新至 v' + remoteVer;
    btn.title = '点击自动更新插件，完成后自动刷新页面';
    btn.addEventListener('click', () => __csDoSelfUpdate(btn, remoteVer));
    slot.textContent = '';
    slot.appendChild(btn);
};
window.__csCheckUpdate = async function (opts) {
    try {
        const remoteVer = await __csFetchRemoteVer();
        if (__csCompareVer(remoteVer, PLUGIN_VERSION) > 0) {
            if (opts && opts.auto && settings.autoUpdate) {
                toastr.info('🔥 检测到新版本 v' + remoteVer + '，自动更新中…', null, { timeOut: 4000 });
                __csDoSelfUpdate(null, remoteVer);
            } else __csRenderUpdateBtn(remoteVer);
        }
    } catch { }
};
// 一键自更新(走酒馆官方 /api/extensions/update)
async function __csDoSelfUpdate(btn, remoteVer) {
    if (btn) { btn.disabled = true; btn.textContent = '⏳ 更新中…'; }
    // 用自身实际文件夹名调接口(不硬编码)
    const selfName = window.__csSelfFolder || 'st-chat-sync';
    const REPO_URL = 'https://gitee.com/satosaki/tavern-synchronization-plugin.git';
    // 阶段1: 官方 update 接口
    for (const g of [true, false]) {
        try {
            const r = await fetch('/api/extensions/update', {
                method: 'POST', headers: getRequestHeaders(),
                body: JSON.stringify({ extensionName: selfName, global: g }),
            });
            if (r.status === 404) continue;
            if (!r.ok) { lastErr_g = g; lastErr_s = 'HTTP ' + r.status; continue; }
            const j = await r.json().catch(() => ({}));
            if (j.isUpToDate) { if (btn) btn.textContent = '✓ 已是最新'; return; }
            if (btn) btn.textContent = '✅ 已更新';
            toastr.success('✅ 插件已更新到 v' + remoteVer + '，即将自动刷新', null, { timeOut: 4000 });
            (window.__kimiCoordReload || ((ms) => setTimeout(() => location.reload(), ms || 2200)))(3000); // 协调刷新：多插件并发更新由最后完成者统一刷新
            return;
        } catch (e2) { }
    }
    // 阶段2: update 全灭 → 自动删旧 + URL 重装
    toastr.info('常规更新不可用，正在通过重装方式更新…', null, { timeOut: 6000 });
    if (btn) btn.textContent = '⏳ 重装更新中…';
    for (const g of [true, false]) {
        try {
            const rd = await fetch('/api/extensions/delete', {
                method: 'POST', headers: getRequestHeaders(),
                body: JSON.stringify({ extensionName: selfName, global: g }),
            });
            if (rd.ok) break;
        } catch { }
    }
    try {
        const ri = await fetch('/api/extensions/install', {
            method: 'POST', headers: getRequestHeaders(),
            body: JSON.stringify({ url: REPO_URL, global: true }),
        });
        if (!ri.ok) throw new Error('HTTP ' + ri.status);
        toastr.success('✅ 已通过重装方式更新到 v' + remoteVer + '，即将自动刷新', null, { timeOut: 4000 });
        (window.__kimiCoordReload || ((ms) => setTimeout(() => location.reload(), ms || 3000)))(3000);
        return;
    } catch (e3) { toastr.error('重装也失败：' + ((e3 && e3.message) || e3) + '。请手动到扩展管理删除后重装。'); }
    if (btn) { btn.disabled = false; btn.textContent = '⬆ 可更新'; }
}
// 🔍 手动检测: 四态结果直接显示在按钮上(有新版/最新/本地更高/失败), 3 秒后还原待机
window.__csManualCheck = async function (btn) {
    // 检测失败后的再点: 直接走官方更新(更新不需要令牌/不需要检测成功), 点完即尝试升到最新
    if (btn.dataset.forceUpdate) {
        const ver = btn.dataset.forceUpdVer || '最新版';
        delete btn.dataset.forceUpdate;
        delete btn.dataset.forceUpdVer;
        delete btn.dataset.done;
        __csDoSelfUpdate(btn, ver);
        return;
    }
    if (btn.dataset.busy) return;
    if (btn.dataset.done) { btn.textContent = '检测更新'; delete btn.dataset.done; delete btn.dataset.result; }
    btn.dataset.busy = '1';
    const oldTitle = btn.title;
    btn.textContent = '⏳';
    btn.title = '正在检测…';
    let txt = '', title2 = '', cls = '';
    try {
        const remoteVer = await __csFetchRemoteVer();
        const cmp = __csCompareVer(remoteVer, PLUGIN_VERSION);
        if (cmp > 0) { txt = '⬆ 点击更新至 v' + remoteVer; cls = 'newer'; btn.dataset.forceUpdate = '1'; btn.dataset.forceUpdVer = remoteVer; } const oldUB = document.querySelector('#cs_upd_slot .cs-upd-btn'); if (oldUB) oldUB.remove();
        else if (cmp === 0) { txt = '✅ 已是最新'; cls = 'same'; delete btn.dataset.forceUpdate; delete btn.dataset.forceUpdVer; }
        else { txt = '✅ 已是最新（CDN 缓存延迟中）'; cls = 'same'; delete btn.dataset.forceUpdate; delete btn.dataset.forceUpdVer; }
        title2 = '本机 v' + PLUGIN_VERSION + ' / 更新源 v' + remoteVer + '\n（更新源：' + PLUGIN_REPO_MANIFEST_API + '）';
    } catch (e) {
        txt = '❌ 检测失败';
        title2 = String(e).slice(0, 80) + '\n（再点一次按钮＝直接执行官方更新，无需令牌/检测）';
        cls = 'fail';
        btn.dataset.forceUpdate = '1';
    }
    btn.textContent = txt;
    btn.title = title2;
    btn.dataset.result = cls;
    btn.dataset.done = '1';
    delete btn.dataset.busy;
};function renderSettingsPanel() {
    const container = document.getElementById('chat_sync_settings');
    if (!container) return;
    const worldName = currentWorldName();
    const charName = currentCharName();
    const id = 'cs'; // 前缀=cs，与 wirePanelEvents 里的 cs_* 事件 id 对齐；容器 id 仍用 chat_sync_settings
    const curRepo = settings.owner && settings.repo ? `${settings.owner}/${settings.repo}` : '（未配置）';
    container.innerHTML = `
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header" id="${id}_toggle">
                <b>🌐 一键云同步（角色/聊天/世界书/配置）</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content" id="${id}_content" style="display:none">

                <p id="${id}_cur_repo" class="cs-hint" style="margin:0 0 6px;padding:6px 10px;border:1px solid var(--SmartThemeBorderColor,#333);border-radius:8px;background:rgba(255,255,255,0.03)"></p>

                <div class="cs-card">
                    <details class="cs-fold" ${(!settings.token || !settings.repo) ? 'open' : ''}>
                    <summary><i class="fa-solid fa-plug cs-ico" aria-hidden="true"></i>连接配置</summary>
                    <div class="cs-body">
                        <div id="${id}_slot2" class="cs-hint" style="margin:0 0 6px;padding:6px 10px;border:1px solid var(--SmartThemeBorderColor,#333);border-radius:8px;background:rgba(255,255,255,0.03)"></div>
                        <label class="cs-label" for="${id}_platform">云平台：</label>
                        <select id="${id}_platform" class="text_pole" style="width:100%;box-sizing:border-box">
                            <option value="https://api.github.com" ${(!settings.server && !settings.owner) || String(settings.server || '').includes('github') ? 'selected' : ''}>GitHub（需能访问外网·单仓库建议&lt;1GB，上限约100GB，默认）</option>
                            <option value="" ${(!settings.server && settings.owner) || (settings.server && !String(settings.server).includes('github') && !String(settings.server).includes('gitlab.com')) ? 'selected' : ''}>Gitee（国内直连·单仓库约500MB）</option>
                            <option value="https://gitlab.com/api/v4" ${String(settings.server || '').includes('gitlab.com') ? 'selected' : ''}>GitLab（需能访问外网·单仓库10GiB）</option>
                        </select>
                        <div class="cs-sep"></div>
                        <label class="cs-label" for="${id}_repoinput">云数据仓库（私有空仓库；先建一个）</label>
                        <input id="${id}_repoinput" class="text_pole" style="width:100%;box-sizing:border-box" placeholder="如 satosaki/chat-sync 或 chat-sync" value="${escapeHtml(settings.owner && settings.repo ? settings.owner + '/' + settings.repo : '')}">
                        <div class="cs-sep"></div>
                        <label class="cs-label" for="${id}_token">私人令牌 token（Gitee→头像→设置→私人令牌，全选，永久；GitHub→Settings→Developer settings→Personal access tokens(classic)→no Expiration+勾选repo；GitLab→https://gitlab.com/-/user_settings/personal_access_tokens→Generate token→Expiration改到一年后→权限全选→Generate token→复制→Done）</label>
                        <input id="${id}_token" type="password" class="text_pole" style="width:100%;box-sizing:border-box" placeholder="粘贴你的私人令牌" value="${escapeHtml(settings.token)}">
                        <div class="cs-row" style="margin-top:8px">
                            <button id="${id}_test" type="button" class="cs-btn">连接测试</button>
                            <button id="${id}_save" type="button" class="cs-btn cs-primary">保存配置</button>
                        </div>
                        <p id="${id}_testresult" class="cs-hint"></p>
                    </div>
                    </details>
                </div>

                <div class="cs-card">
                    <details class="cs-fold">
                    <summary><i class="fa-solid fa-user cs-ico" aria-hidden="true"></i>角色卡+绑定世界书+聊天同步</summary>
                    <div class="cs-body">
                        <div id="${id}_char_display" class="cs-current">当前角色：<b>${escapeHtml(charName || '（未打开单人角色）')}</b>${worldName ? `<br>绑定世界书：<b>${escapeHtml(worldName)}</b>` : ''}</div>
                        <p class="cs-hint" style="margin:6px 0 2px">当前聊天（增量上传 / 导入）</p>
                        <div class="cs-row" style="margin-top:4px">
                            <button id="${id}_push_chat" type="button" class="cs-btn">📤 上传当前聊天</button>
                            <button id="${id}_pull_chat" type="button" class="cs-btn">📥 导入云端至当前聊天</button>
                        </div>
                        <p class="cs-hint" style="margin:6px 0 2px">该角色全部聊天（增量上传 / 导入）</p>
                        <div class="cs-row" id="${id}_char_actions" style="margin-top:4px">
                            <button id="${id}_push_char" type="button" class="cs-btn">📤 上传角色全部聊天</button>
                            <button id="${id}_pull_char" type="button" class="cs-btn">📥 导入云端该角色全部聊天</button>
                        </div>
                    </div>
                    </details>
                </div>

                <div class="cs-card">
                    <details class="cs-fold">
                    <summary><i class="fa-solid fa-cloud-arrow-up cs-ico" aria-hidden="true"></i>角色卡+绑定世界书+聊天同步</summary>
                    <div class="cs-body">
                        <p class="cs-hint" style="margin-bottom:4px">把本地角色整包/聊天上传到云端，或从云端导入/删除。</p>
                        <div class="cs-row" style="margin-top:6px">
                            <button id="${id}_push_all" type="button" class="cs-btn">📤 上传全部角色</button>
                            <button id="${id}_pull_all" type="button" class="cs-btn">📥 导入全部云端角色</button>
                        </div>
                        <div class="cs-sep"></div>
                        <p class="cs-hint" style="margin-bottom:4px">【选择部分角色】刷新列出本地/云端角色，拖动划选勾选，再操作</p>
                        <div class="cs-row" style="align-items:center;margin-top:4px;flex-wrap:wrap">
                            <button id="${id}_refresh_local" type="button" class="cs-btn cs-btn-local"><i class="fa-solid fa-rotate" aria-hidden="true"></i> 本地角色</button>
                            <button id="${id}_refresh_cloud2" type="button" class="cs-btn cs-btn-cloud"><i class="fa-solid fa-rotate" aria-hidden="true"></i> 云端角色</button>
                            <button id="${id}_roles_selall" type="button" class="cs-btn" title="全选">全选</button>
                            <button id="${id}_roles_clr" type="button" class="cs-btn" title="清空选择">清空</button>
                        </div>
                        <div id="${id}_roles_list" class="cs-roles cs-sellect" style="max-height:150px;overflow:auto;border:1px solid var(--SmartThemeBorderColor,#333);border-radius:4px;padding:4px;margin-top:4px;user-select:none"></div>
                        <div class="cs-row" style="margin-top:4px;flex-wrap:wrap">
                            <button id="${id}_push_sel" type="button" class="cs-btn">📤 上传选中角色</button>
                            <button id="${id}_pull_sel" type="button" class="cs-btn">📥 导入选中角色</button>
<span style="display:inline-flex;gap:4px;flex-wrap:wrap;margin-left:4px">
                                <button type="button" class="cs-btn cs-flt" data-target="cs_roles_list" data-flt="全部" style="padding:1px 8px;font-size:.72em">全部</button>
                                <button type="button" class="cs-btn cs-flt" data-target="cs_roles_list" data-flt="双端" style="padding:1px 8px;font-size:.72em">双端</button>
                                <button type="button" class="cs-btn cs-flt" data-target="cs_roles_list" data-flt="仅本地" style="padding:1px 8px;font-size:.72em">仅本地</button>
                                <button type="button" class="cs-btn cs-flt" data-target="cs_roles_list" data-flt="仅云端" style="padding:1px 8px;font-size:.72em">仅云端</button>
                                <button type="button" class="cs-btn cs-flt" data-target="cs_roles_list" data-flt="本地新" style="padding:1px 8px;font-size:.72em" title="本机内容比云端新(需差异徽章支持的分项)">本地新</button>
                                <button type="button" class="cs-btn cs-flt" data-target="cs_roles_list" data-flt="云端新" style="padding:1px 8px;font-size:.72em" title="云端被另一端改过(需差异徽章支持的分项)">云端新</button>
                            </span>
                            <button id="${id}_del_sel" type="button" class="cs-btn cs-danger-btn" title="删除选中的文件">🗑 删除选中文件</button>
                            <span id="${id}_delete_target" class="cs-hint" style="margin-left:6px"></span>
                        </div>
                        <p id="${id}_delete_status" class="cs-hint" style="margin-top:4px"></p>
                        <p id="${id}_cloud_status" class="cs-hint" style="margin-top:6px"></p>
                    </div>
                    </details>
                </div>

                <div class="cs-card">
                    <details class="cs-fold">
                    <summary><i class="fa-solid fa-book cs-ico" aria-hidden="true"></i>独立全局世界书同步</summary>
                    <div class="cs-body">
                        <div class="cs-row" style="align-items:center;margin-top:4px;flex-wrap:wrap">
                            <button id="${id}_wb_local" type="button" class="cs-btn cs-btn-local"><i class="fa-solid fa-rotate" aria-hidden="true"></i> 本地世界书</button>
                            <button id="${id}_wb_cloud" type="button" class="cs-btn cs-btn-cloud"><i class="fa-solid fa-rotate" aria-hidden="true"></i> 云端世界书</button>
                            <button id="${id}_wb_selall" type="button" class="cs-btn" title="全选">全选</button>
                            <button id="${id}_wb_clr" type="button" class="cs-btn" title="清空选择">清空</button>
                            <span id="${id}_wb_target" class="cs-hint" style="margin-left:6px"></span>
                        </div>
                        <div id="${id}_wb_list" class="cs-roles cs-sellect" style="max-height:140px;overflow:auto;border:1px solid var(--SmartThemeBorderColor,#333);border-radius:4px;padding:4px;margin-top:4px;user-select:none"></div>
                        <div class="cs-row" style="margin-top:4px;flex-wrap:wrap">
                            <button id="${id}_wb_push" type="button" class="cs-btn">📤 上传选中世界书</button>
                            <button id="${id}_wb_pull" type="button" class="cs-btn">📥 导入选中世界书</button>
<span style="display:inline-flex;gap:4px;flex-wrap:wrap;margin-left:4px">
                                <button type="button" class="cs-btn cs-flt" data-target="cs_wb_list" data-flt="全部" style="padding:1px 8px;font-size:.72em">全部</button>
                                <button type="button" class="cs-btn cs-flt" data-target="cs_wb_list" data-flt="双端" style="padding:1px 8px;font-size:.72em">双端</button>
                                <button type="button" class="cs-btn cs-flt" data-target="cs_wb_list" data-flt="仅本地" style="padding:1px 8px;font-size:.72em">仅本地</button>
                                <button type="button" class="cs-btn cs-flt" data-target="cs_wb_list" data-flt="仅云端" style="padding:1px 8px;font-size:.72em">仅云端</button>
                                <button type="button" class="cs-btn cs-flt" data-target="cs_wb_list" data-flt="本地新" style="padding:1px 8px;font-size:.72em" title="本机内容比云端新(需差异徽章支持的分项)">本地新</button>
                                <button type="button" class="cs-btn cs-flt" data-target="cs_wb_list" data-flt="云端新" style="padding:1px 8px;font-size:.72em" title="云端被另一端改过(需差异徽章支持的分项)">云端新</button>
                            </span>
                            <button id="${id}_wb_del" type="button" class="cs-btn cs-danger-btn" title="删除选中的全局世界书(本地视图删本地/云端视图删云端)">🗑 删除选中世界书</button>
                        </div>
                        <p id="${id}_wb_status" class="cs-hint" style="margin-top:4px"></p>
                    </div>
                    </details>
                </div>

                <div class="cs-card">
                    <details class="cs-fold">
                    <summary><i class="fa-solid fa-broom cs-ico" aria-hidden="true"></i>聊天记录清理器</summary>
                    <div class="cs-body">
                        <label class="cs-label" for="${id}_cln_char">选择角色（切换后自动列出该角色的聊天记录）：</label>
                        <select id="${id}_cln_char" class="text_pole" style="width:100%;box-sizing:border-box"></select>
                        <div class="cs-row" style="margin-top:6px;flex-wrap:wrap">
                            <button id="${id}_cln_local" type="button" class="cs-btn cs-btn-local"><i class="fa-solid fa-rotate" aria-hidden="true"></i> 本地聊天</button>
                            <button id="${id}_cln_cloud" type="button" class="cs-btn cs-btn-cloud"><i class="fa-solid fa-rotate" aria-hidden="true"></i> 云端聊天</button>
                            <button id="${id}_cln_selall" type="button" class="cs-btn" title="全选">全选</button>
                            <button id="${id}_cln_clr" type="button" class="cs-btn" title="清空选择">清空</button>
                            <button id="${id}_cln_sort" type="button" class="cs-btn" title="按最新修改时间 正序/倒序 切换">⇅ 时间倒序</button>
                        </div>
                        <div id="${id}_cln_listbox" class="cs-roles cs-sellect" style="max-height:230px;overflow:auto;border:1px solid var(--SmartThemeBorderColor,#333);border-radius:4px;padding:4px;margin-top:4px"><p class="cs-hint">（先选角色，列表自动出现）</p></div>
                        <div class="cs-row" style="margin-top:4px;flex-wrap:wrap">
                            <button id="${id}_cln_del" type="button" class="cs-btn cs-danger-btn" title="删除勾选的聊天：本地+云端同名一起删">🗑 删除选中（本地+云端同名同删）</button>
                        </div>
                        <p id="${id}_cln_status" class="cs-hint" style="margin-top:4px"></p>
                    </div>
                    </details>
                </div>

                <div class="cs-card">
                    <details class="cs-fold">
                    <summary><i class="fa-solid fa-database cs-ico" aria-hidden="true"></i>酒馆配置同步（预设/主题/正则/插件等设置）</summary>
                    <div class="cs-body">
                        <p id="${id}_cfg_status" class="cs-hint" style="margin-top:4px"></p>
                        <div class="cs-sep"></div>
                        <div class="cs-label">分项部分同步（内容一致自动跳过；不同时可选 替换/另存副本）：</div>
                        <div class="cs-row" style="align-items:center;margin-top:4px;flex-wrap:wrap">
                            <button id="${id}_cfg_tab_conn" type="button" class="cs-btn cs-tab" data-cfgtab="conn">预设</button>
                            <button id="${id}_cfg_tab_theme" type="button" class="cs-btn cs-tab" data-cfgtab="theme">主题</button>
                            <button id="${id}_cfg_tab_regex" type="button" class="cs-btn cs-tab" data-cfgtab="regex">全局正则</button>
                            <button id="${id}_cfg_tab_user" type="button" class="cs-btn cs-tab" data-cfgtab="user">User</button>
                            <button id="${id}_cfg_tab_ext" type="button" class="cs-btn cs-tab" data-cfgtab="ext">拓展</button>
                            <button id="${id}_cfg_tab_thp" type="button" class="cs-btn cs-tab" data-cfgtab="thp">酒馆助手</button>
                        </div>
                        <div class="cs-row" style="align-items:center;margin-top:4px;flex-wrap:wrap">
                            <button id="${id}_cfg_local" type="button" class="cs-btn cs-btn-local"><i class="fa-solid fa-rotate" aria-hidden="true"></i> 本地配置</button>
                            <button id="${id}_cfg_cloud" type="button" class="cs-btn cs-btn-cloud"><i class="fa-solid fa-rotate" aria-hidden="true"></i> 云端配置</button>
                            <button id="${id}_cfg_selall" type="button" class="cs-btn" title="全选">全选</button>
                            <button id="${id}_cfg_clr" type="button" class="cs-btn" title="清空选择">清空</button>
                            <span id="${id}_cfg_target" class="cs-hint" style="margin-left:6px"></span>
                        </div>
                        <div id="${id}_cfg_list" class="cs-roles cs-sellect" style="max-height:150px;overflow:auto;border:1px solid var(--SmartThemeBorderColor,#333);border-radius:4px;padding:4px;margin-top:4px;user-select:none"></div>
                        <div class="cs-row" style="margin-top:4px;flex-wrap:wrap">
                            <button id="${id}_cfg_push" type="button" class="cs-btn">📤 上传选中</button>
                            <button id="${id}_cfg_pull" type="button" class="cs-btn">📥 导入选中</button>
                            <button id="${id}_cfg_del" type="button" class="cs-btn cs-danger-btn" title="删除选中的配置项(本地视图删本地/云端视图删云端)">🗑 删除选中</button>
                            <button id="${id}_cfg_updall" type="button" class="cs-btn" style="display:none" title="按顺序更新选中的拓展(仅本地视图, 多个可连点, 最后刷新页面一次生效)">⬆ 更新选中</button>
                            <span id="${id}_cfg_filter" style="display:inline-flex;gap:4px;flex-wrap:wrap;margin-left:4px">
                                <button type="button" class="cs-btn cs-flt" data-target="cs_cfg_list" data-flt="全部" style="padding:1px 8px;font-size:.72em">全部</button>
                                <button type="button" class="cs-btn cs-flt" data-target="cs_cfg_list" data-flt="双端" style="padding:1px 8px;font-size:.72em">双端</button>
                                <button type="button" class="cs-btn cs-flt" data-target="cs_cfg_list" data-flt="仅本地" style="padding:1px 8px;font-size:.72em">仅本地</button>
                                <button type="button" class="cs-btn cs-flt" data-target="cs_cfg_list" data-flt="仅云端" style="padding:1px 8px;font-size:.72em">仅云端</button>
                                <button type="button" class="cs-btn cs-flt" data-target="cs_cfg_list" data-flt="本地新" style="padding:1px 8px;font-size:.72em" title="本机内容比云端新(需差异徽章支持的分项)">本地新</button>
                                <button type="button" class="cs-btn cs-flt" data-target="cs_cfg_list" data-flt="云端新" style="padding:1px 8px;font-size:.72em" title="云端被另一端改过(需差异徽章支持的分项)">云端新</button>
                            </span>
                        </div>
                        <div class="cs-row" style="margin-top:2px;flex-wrap:wrap">
                            <button id="${id}_cfg_user_br" type="button" class="cs-btn" style="display:none" title="一键备份：用户名+全部人设+全部头像照片">💾 一键备份全部</button>
                            <button id="${id}_cfg_user_rr" type="button" class="cs-btn" style="display:none" title="一键恢复：从云端取回全部用户资料与头像照片">📥 一键恢复全部</button>
                        </div>
                        <p id="${id}_cfg2_status" class="cs-hint" style="margin-top:4px"></p>
                    </div>
                    </details>
                </div>

                <div class="cs-card cs-last">
                    <details class="cs-fold">
                    <summary><i class="fa-solid fa-gear cs-ico" aria-hidden="true"></i>自动同步/备份</summary>
                    <div class="cs-body">
                        <div class="cs-group-title">• 即时触发（不依赖开关）</div>
                        <div style="display:flex;flex-direction:column;gap:6px">
                            <label class="checkbox_label"><input id="${id}_chk_open" type="checkbox" ${settings.autoSyncOnOpen ? 'checked' : ''}> 打开角色时自动拉取一次当前聊天</label>
                            <label class="checkbox_label"><input id="${id}_chk_switch" type="checkbox" ${settings.autoSyncOnSwitch ? 'checked' : ''}> 切换角色/聊天（含新聊天）时自动上传</label>
                        </div>
                        <div class="cs-sep"></div>
                        <div class="cs-group-title">• 定时备份上传</div>
                        <label class="checkbox_label"><input id="${id}_chk_live" type="checkbox" ${settings.autoSyncLive ? 'checked' : ''}> 定时轮询（勾选开启，取消关闭）</label>
                        <div style="margin-top:4px">
                            <label style="display:inline-flex;align-items:center">间隔 <input id="${id}_interval" type="number" min="10" step="5" value="${Number(settings.autoSyncInterval) || 600}" style="width:60px;margin-left:4px"> 秒</label>
                        </div>
                        <div style="margin-top:6px">
                            <div class="cs-hint" style="margin-bottom:3px">自动上传范围：</div>
                            <label class="checkbox_label" style="display:block"><input type="radio" name="${id}_scope" value="chat" ${settings.syncScope === 'chat' ? 'checked' : ''}> 仅当前聊天</label>
                            <label class="checkbox_label" style="display:block"><input type="radio" name="${id}_scope" value="char" ${settings.syncScope === 'char' ? 'checked' : ''}> 仅当前角色</label>
                            <label class="checkbox_label" style="display:block"><input type="radio" name="${id}_scope" value="all" ${settings.syncScope !== 'chat' && settings.syncScope !== 'char' ? 'checked' : ''}> 全部聊天</label>
                        </div>
                        <p class="cs-hint">自动只做上传备份，不做自动下载。均为增量。</p>
                        <p id="${id}_status" class="cs-hint" style="margin-top:6px"></p>
                    </div>
                    </details>
                </div>

            </div>
        </div>
    `;
    // 折叠：ST 全局委托 $(document).on('click','.inline-drawer-toggle') 自动处理展开/收起，无需自绑
    wirePanelEvents();
    // 初始按当前角色状态显示对应操作区块
    updateCurrentCharDisplay();
}

function wirePanelEvents() {
    const $ = (id) => document.getElementById(id);
    // 幂等保护：ensurePanel/renderSettingsPanel 可能被重复调用，否则 addEventListener 会重复绑定 →
    // 点一次删除会触发多次，第一次删除成功、第二次因文件已删返回 400（用户见"一边失败HTTP400一边成功"）
    // 渲染「选择部分角色」多选列表：mode='local' 列本地角色，'cloud' 列云端角色；紧凑排版（checkbox 前置、名字在右）
    window.__csListMode = 'local';
    window.__renderRoleMultiList = async function (mode) {
        mode = mode || window.__csListMode;
        window.__csListMode = mode;
        const list = $('cs_roles_list');
        const src = $('cs_delete_target');
        if (!list) return;
        let names = [];
        if (mode === 'cloud') {
            // 立即给出可见反馈(用户点名要的"获取中"), 慢网络不再像"没反应/啥也不出"
            list.innerHTML = '<p class="cs-hint">⏳ 获取云端角色中…（云端响应慢时请稍候，最多约 45 秒）</p>';
            try { names = await Gitee.listDir('sync'); }
            catch (e) {
                const why = (e && e.message) || e;
                if (src) src.textContent = '（读取云端失败）';
                list.innerHTML = `<p class="cs-hint" style="color:#e66">⚠ 读取云端失败：${escapeHtml(why)}<br>请点设置里的「连接测试」自查（网络/仓库/token），修好后再点「云端角色」</p>`;
                return;
            }
            if (src) src.textContent = '当前为云端视图，将删除云端';
        } else {
            names = (getContext().characters || []).filter((x) => x && x.name && !String(x.name).startsWith('Group')).map((x) => x.name);
            if (src) src.textContent = '当前为本地视图，将删除本地';
        }
        const delBtn = $('cs_del_sel');
        if (delBtn) delBtn.title = mode === 'cloud' ? '删除云端选中角色（整条：卡+世界书+聊天）' : '删除本地选中角色（卡+全部聊天）';
        // 【勾选记忆】渲染前保留当前已勾选的名字，渲染后按名回填勾选，刷新不丢勾选
        const prevChecked = new Set([...document.querySelectorAll('input[name="cs_role_sel"]:checked')].map((c) => c.value));
        // 存在性徽章: 拿对侧名单做交集(仅本地/仅云端/双端), 列目录一次不下载内容
        let sideSet = new Set();
        if (mode === 'local') {
            try { sideSet = new Set(await Gitee.listDir('sync')); } catch { }
        } else {
            sideSet = new Set((getContext().characters || []).filter((x) => x && x.name && !String(x.name).startsWith('Group')).map((x) => x.name));
        }
        // 行内头像: 本地有→官方缩略图; 仅云端→仓库卡PNG直链(master失败自动试main再隐藏); 加载失败显示占位符
        const avMap = new Map((getContext().characters || []).filter((x) => x && x.name && x.avatar).map((x) => [x.name, x.avatar]));
        const isGh = String(settings.server || '').includes('github');
        const avSrcFor = (n) => {
            const a = avMap.get(n);
            if (a) return '/thumbnail?type=avatar&file=' + encodeURIComponent(a);
            const enc = encodeURIComponent(n);
            return isGh
                ? `https://raw.githubusercontent.com/${settings.owner}/${settings.repo}/master/sync/${enc}/character.png`
                : `https://gitee.com/${settings.owner}/${settings.repo}/raw/master/sync/${enc}/character.png?access_token=${encodeURIComponent(settings.token || '')}`;
        };
        list.innerHTML = names.length
            ? names.map((n) => {
                const both = sideSet.has(n);
                const whereCls = mode === 'local' ? (both ? 'both' : 'local') : (both ? 'both' : 'cloud');
                return `<label class="cs-role-item"><input type="checkbox" value="${escapeHtml(n)}" name="cs_role_sel" ${prevChecked.has(n) ? 'checked' : ''}><img class="cs-role-avatar" loading="lazy" src="${escapeHtml(avSrcFor(n))}" title="${escapeHtml(n)}" onerror="if(!this.dataset.f){this.dataset.f=1;this.src=this.src.replace('/master/','/main/');}else{this.style.visibility='hidden';}"><b class="cs-cln-where cs-cln-where-${whereCls}">${both ? '双端' : (mode === 'local' ? '仅本地' : '仅云端')}<span class="cs-where-diff" data-where-diff=""></span></b><span>${escapeHtml(n)}</span></label>`;
            }).join('')
            : `<p class="cs-hint">（无${mode === 'cloud' ? '云端' : '本地'}角色）</p>`;
        // ── 角色差异徽章(卡+绑定世界书+聊天): 与上传侧同构口径(卡字节/世界书文本/聊天段sha1Text) ──
        (async () => {
            try {
                const NL = String.fromCharCode(10);
                const rowsAll = [...list.querySelectorAll('label.cs-role-item')].filter((r) => r.querySelector('input[name=cs_role_sel]'));
                if (!rowsAll.length) return;
                const files = await Gitee.listAllFiles('sync');
                const byChar = {};
                for (const f of files) {
                    const m2 = String(f.path).match(/^sync\/([^/]+)\/(.*)$/);
                    if (!m2) continue;
                    const e = (byChar[m2[1]] = byChar[m2[1]] || { cardSha: '', chunks: [], chats: [] });
                    if (m2[2] === 'character.png') e.cardSha = f.sha;
                    else if (m2[2].startsWith('character.png.parts/')) e.chunks.push({ rest: m2[2], sha: f.sha });
                    else if (m2[2].startsWith('chats/') && m2[2].endsWith('.manifest.json')) e.chats.push({ rest: m2[2], sha: f.sha });
                }
                let cursor2 = 0;
                const worker2 = async () => {
                    while (cursor2 < rowsAll.length) {
                        const row = rowsAll[cursor2++];
                        try {
                            const name = (row.querySelector('input[type=checkbox]') || {}).value;
                            const e = byChar[name];
                            if (!e) continue;
                            const det = {};
                            const ch = (getContext().characters || []).find((x) => x.name === name);
                            try {
                                const b64 = await getCharacterCardB64(name);
                                if (b64) {
                                    const clean = String(b64).replace(/\s/g, '');
                                    const bin = atob(clean);
                                    const u8 = new Uint8Array(bin.length);
                                    for (let i2 = 0; i2 < bin.length; i2++) u8[i2] = bin.charCodeAt(i2);
                                    if (e.chunks.length) {
                                        const cparts = e.chunks.slice().sort((a2, b2) => a2.rest.localeCompare(b2.rest, undefined, { numeric: true }));
                                        const localShas = [];
                                        for (let i2 = 0; i2 < clean.length; i2 += CARD_CHUNK_CHARS) localShas.push(await gitBlobSha(new TextEncoder().encode(clean.slice(i2, i2 + CARD_CHUNK_CHARS))));
                                        det.card = (localShas.length === cparts.length && localShas.every((sh, i3) => sh === cparts[i3].sha)) ? 'same' : 'local';
                                    } else if (e.cardSha) {
                                        det.card = ((await gitBlobSha(u8)) === e.cardSha) ? 'same' : 'local';
                                    }
                                }
                            } catch { }
                            try {
                                const wname = ch && ch.data && ch.data.extensions && ch.data.extensions.world;
                                if (wname) {
                                    const wf = files.find((f) => f.path === 'sync/' + name + '/world.json');
                                    if (wf) {
                                        const wc = await getWorldContent(wname);
                                        if (wc) det.wb = ((await gitBlobSha(new TextEncoder().encode(String(wc)))) === wf.sha) ? 'same' : 'local';
                                    }
                                }
                            } catch { }
                            try {
                                const av = (ch && ch.avatar) || '';
                                let chatState = '';
                                for (const cm of e.chats) {
                                    const mc = await Gitee.getText('sync/' + name + '/' + cm.rest).catch(() => null);
                                    if (!mc || !mc.content) continue;
                                    const man = JSON.parse(mc.content);
                                    const chatName = cm.rest.replace(/^chats\//, '').replace(/\.manifest\.json$/, '');
                                    let chatText = '';
                                    try { chatText = await getChatContent(chatName, name); } catch { continue; }
                                    const lines = String(chatText).split(NL).filter((l) => l.trim());
                                    const msgLines = [];
                                    lines.forEach((l, idx) => {
                                        if (idx === 0) { try { const o = JSON.parse(l); if (o && typeof o === 'object' && !('mes' in o)) return; } catch { } }
                                        msgLines.push(l);
                                    });
                                    if (msgLines.length < SEG_MIN_MSGS) continue;
                                    const segs = splitChatSegmentsBySize(msgLines, SEG_TARGET_BYTES);
                                    const localJoin = (await Promise.all(segs.map((sg) => sha1Text(sg.join(NL))))).join('|');
                                    const cloudJoin = (man.parts || []).map((pp) => pp.sha).join('|');
                                    if (localJoin !== cloudJoin) { chatState = 'local'; break; }
                                    chatState = chatState || 'same';
                                }
                                if (chatState) det.chat = chatState;
                            } catch { }
                            const parts2 = [];
                            if (det.card) parts2.push('卡:' + (det.card === 'same' ? '一致' : '本地新'));
                            if (det.wb) parts2.push('世界书:' + (det.wb === 'same' ? '一致' : '本地新'));
                            if (det.chat) parts2.push('聊天:' + (det.chat === 'same' ? '一致' : '本地新'));
                            const dir2 = (det.card === 'local' || det.wb === 'local' || det.chat === 'local') ? 'local' : '';
                            const sp2 = row.querySelector('.cs-where-diff');
                            if (sp2) {
                                sp2.textContent = dir2 ? DIFF_LABEL[dir2] : '';
                                sp2.title = parts2.join('；');
                                if (dir2) { const wb3 = sp2.closest('.cs-cln-where'); if (wb3) for (const n3 of [...wb3.childNodes]) if (n3.nodeType === 3) n3.textContent = ''; }
                            }
                        } catch { }
                    }
                };
                await Promise.all(Array.from({ length: 2 }, worker2));
                hideBusy();
                if (window.__applyCfgFilter) window.__applyCfgFilter();
            } catch { hideBusy(); }
        })();
        __applyRowFilter('cs_roles_list', window.__rowFilter_cs_roles_list || '全部');
    };
    // 部分选择按钮事件
    $('cs_refresh_local')?.addEventListener('click', () => window.__renderRoleMultiList('local'));
    $('cs_refresh_cloud2')?.addEventListener('click', () => window.__renderRoleMultiList('cloud'));
    $('cs_roles_selall')?.addEventListener('click', () => document.querySelectorAll('input[name="cs_role_sel"]').forEach((c) => { if (c.closest('label') && c.closest('label').style.display === 'none') return; c.checked = true; }));
    $('cs_roles_clr')?.addEventListener('click', () => document.querySelectorAll('input[name="cs_role_sel"]').forEach((c) => { c.checked = false; }));
    $('cs_push_sel')?.addEventListener('click', async () => {
        const sel = [...document.querySelectorAll('input[name="cs_role_sel"]:checked')].map((c) => c.value);
        try { const r = await pushSelectedCharacters(sel); if (r && typeof r.ok === 'number') toastr.info(`上传角色完成：成功 ${r.ok}${r.fail ? `，失败 ${r.fail}（${csShortList((r.failReasons || []).map(x => x.name + ':' + x.reason).slice(0, 3))}）` : ''}`); try { window.__renderRoleMultiList(window.__csListMode); } catch { } }
        catch (e) { toastr.error('上传选中角色失败：' + e.message); }
    });
    $('cs_pull_sel')?.addEventListener('click', async () => {
        const sel = [...document.querySelectorAll('input[name="cs_role_sel"]:checked')].map((c) => c.value);
        try { const r = await importSelectedCharacters(sel); if (r && typeof r.ok === 'number') toastr.info(`导入角色完成：成功 ${r.ok}${r.fail ? `，失败 ${r.fail}（${csShortList((r.failReasons || []).map(x => x.name + ':' + x.reason).slice(0, 3))}）` : ''}`); try { window.__renderRoleMultiList(window.__csListMode); } catch { } }
        catch (e) { toastr.error('导入选中角色失败：' + e.message); }
    });
    // 拖拽划选：按住左键拖动，经过的 checkbox 切换（首次经过=勾选；再次经过同一项=取消）。同一项一次拖动只toggle一次。
    // ⚠️ 绑定幂等: TT 手机端切换界面会【销毁重建】扩展面板 DOM, 重建出的按钮无事件。
    //    以 cs_cfg_restore 为哨兵——它带 csWired 标记说明本轮 DOM 已绑定; 否则(含外部重建后)完整重绑。
    const __sentinel = $('cs_cfg_tab_conn');
    if (__sentinel && __sentinel.dataset.csWired) return;
    // 关键：区分「单击」与「拖拽」——位移 <4px 视为单击，完全交给 <label> 原生勾选（一次点击一次切换，绝无双翻）；
    // 位移 ≥4px 视为拖拽，程序化翻转经过项，并在 mouseup 后阻止原生 label click 对已翻转项二次翻转。
    (function bindDragSelect() {
        const list = $('cs_roles_list');
        if (!list || list.getAttribute('data-dragbound')) return;
        list.setAttribute('data-dragbound', '1');
        let dragging = false, dragMoved = false, startX = 0, startY = 0;
        const toggled = new Set(); // 本次拖拽中已翻转的 checkbox
        list.addEventListener('mousedown', (e) => {
            if (e.button !== 0) return;
            dragging = true; dragMoved = false;
            startX = e.clientX; startY = e.clientY;
            toggled.clear();
        });
        list.addEventListener('mousemove', (e) => {
            if (!dragging) return;
            if (!dragMoved) {
                // 未超过阈值 = 仍在「单击」阶段，不翻转，避免微小晃动引起双触发
                if (Math.abs(e.clientX - startX) < 4 && Math.abs(e.clientY - startY) < 4) return;
                dragMoved = true;
            }
            const el = document.elementFromPoint(e.clientX, e.clientY);
            const label = el && el.closest('.cs-role-item');
            if (label) {
                const cb = label.querySelector('input[type="checkbox"]');
                if (cb && !toggled.has(cb)) {
                    toggled.add(cb);
                    cb.checked = !cb.checked; // 首次经过=勾选；拖动到已勾=取消
                }
            }
        });
        window.addEventListener('mouseup', () => {
            const wasDrag = dragging && dragMoved;
            dragging = false;
            if (!wasDrag) { toggled.clear(); return; } // 单击：交给原生 label click，不再干预
            // 是拖拽：mouseup 后原生 label click 会对刚翻转过的项再翻一次 → 拦截本次 click
            document.addEventListener('click', function oneShot(ev) {
                const cb2 = ev.target.closest && ev.target.closest('label') ? ev.target.closest('label').querySelector('input[type="checkbox"]') : null;
                if (cb2 && toggled.has(cb2)) {
                    ev.preventDefault();
                    ev.stopPropagation();
                    toggled.delete(cb2); // 该次已拦，移除避免误拦后续
                }
                if (!toggled.size) document.removeEventListener('click', oneShot, true);
            }, true);
        });
    })();
    // 面板初始化后填充一次角色多选列表
    if (window.__renderRoleMultiList) window.__renderRoleMultiList();
    // 平台选择(Gitee/GitHub)即时生效并保存
    $('cs_platform')?.addEventListener('change', () => {
        settings.server = String($('cs_platform').value || '').trim();
        saveSettingsDebounced();
    });
    $('cs_save')?.addEventListener('click', async () => {
        const repoInput = $('cs_repoinput').value.trim();
        const token = $('cs_token').value;
        settings.server = String($('cs_platform')?.value || '').trim();
        // 解析仓库；若只填了仓库名，用 token 自动推断用户名
        const { owner, repo } = await resolveRepo(token, repoInput);
        if (!repo) { toastr.error('请填写仓库地址或仓库名'); return; }
        settings.owner = owner;
        settings.repo = repo;
        settings.token = token;
        __refreshCurRepoLine();
        saveSettingsDebounced();
        __refreshCurRepoLine();
        __csUpsertSlot(settings.server || '', `${settings.owner}/${settings.repo}`, settings.token);
        __refreshCurRepoLine();
        toastr.success(owner ? `配置已保存（用户识别为：${owner}/${repo}）` : '配置已保存');
    });
    $('cs_test')?.addEventListener('click', async () => {
        const repoInput = $('cs_repoinput').value.trim();
        const token = $('cs_token').value;
        const out = $('cs_testresult');
        out.textContent = '测试中…';
        try {
            const { owner, repo } = await resolveRepo(token, repoInput);
            if (!owner) throw new Error('无法识别用户名（检查令牌）');
            if (!repo) throw new Error('请填写仓库地址或仓库名');
            const base = (settings.server || 'https://gitee.com/api/v5').replace(/\/$/, '');
            const isGh = base.includes('github');
            const isGl = base.includes('gitlab.com');
            const ah = isGl ? { 'PRIVATE-TOKEN': token } : ({ 'Authorization': (isGh ? 'Bearer ' : 'token ') + token, ...(isGh ? { 'Accept': 'application/vnd.github+json' } : {}) });
            const u = await fetch(`${base}/user${isGh ? '' : isGl ? '?private_token=' + encodeURIComponent(token) : '?access_token=' + encodeURIComponent(token)}`, { headers: ah });
            if (!u.ok) throw new Error('令牌没通过(HTTP ' + u.status + ')——令牌可能没填、被重置、过期或复制漏了。去 Gitee/GitLab「个人访问令牌」重新生成一个, 再粘贴到这里保存');
            const userData = await u.json();
            out.textContent = `✅ 连接成功：${userData.login || userData.username}（已识别为用户名）`;
            // 仓库可达性: Gitee/GitHub 用 contents 列举; GitLab 用 GET /projects/{proj} 探测
            const rr = isGl
                ? await fetch(`${base}/projects/${encodeURIComponent(owner + '/' + repo)}`, { headers: ah })
                : await fetch(`${base}/repos/${owner}/${repo}/contents`, { headers: ah });
            out.textContent += rr.ok ? `｜仓库 ${owner}/${repo} 可访问` : '｜⚠️ 仓库不存在或没权限，请先建私有仓库';
            if (rr.ok && isGl) { try { const pj = await rr.json(); settings.gitlabBranch = pj.default_branch || 'main'; saveSettingsDebounced(); } catch { } }
            if (rr.ok) {
                settings.owner = owner; settings.repo = repo; settings.token = token; settings.lastConnectAt = Date.now(); saveSettingsDebounced(); __refreshCurRepoLine();
                // 目录盘点: 与"云端角色/云端预设/云端正则/云端人设"按钮用同一套读取方法, 直证各列表链路
                const parts = ['角色(sync)', '预设(connections/openai)', '主题(themes)', '全局正则(regex)', '人设(personas)'];
                const dirs = ['sync', 'config-sync/connections/openai', 'config-sync/themes', 'config-sync/regex', 'config-sync/user/personas'];
                for (let i = 0; i < parts.length; i++) {
                    try {
                        const arr = await Gitee.listEntries(dirs[i]);
                        // sync 下是角色文件夹(dir), 其余目录下是配置文件(file) → 按类型计数
                        const n = Array.isArray(arr) ? arr.filter((x) => x.type === (dirs[i] === 'sync' ? 'dir' : 'file')).length : 0;
                        out.textContent += `\n${parts[i]}: ${n} 个${dirs[i] === 'sync' ? '角色' : '文件'}`;
                    } catch (e2) {
                        out.textContent += `\n${parts[i]}: ❌ ${(e2 && e2.message) || e2}`;
                    }
                }
                out.textContent += '\n（= 上面各「云端」按钮能看到的数量；某栏 ❌ 即该目录读取失败，其余正常可继续用）';
            }
        } catch (e) {
            out.textContent = '❌ 连接失败：' + e.message;
        }
    });
    $('cs_push_chat')?.addEventListener('click', async () => {
        showBusy(0, 0, '上传当前聊天…');
        const st = $('cs_status'); if (st) st.textContent = '同步当前聊天中…';
        try { await pushCurrentChat(); if (st) st.textContent = '完成'; }
        catch (e) { toastr.error('同步失败：' + e.message); if (st) st.textContent = '同步失败'; }
    });
    $('cs_pull_chat')?.addEventListener('click', async () => {
        showBusy(0, 0, '导入当前聊天…');
        const st = $('cs_status'); if (st) st.textContent = '拉取当前聊天中…';
        try { await pullCurrentChat(); if (st) st.textContent = '完成'; }
        catch (e) { toastr.error('拉取失败：' + e.message); if (st) st.textContent = '拉取失败'; }
    });
    $('cs_push_char')?.addEventListener('click', async () => {
        showBusy(0, 0, '上传角色全部聊天…');
        const st = $('cs_status'); if (st) st.textContent = '同步中…';
        try { await pushCurrentCharacter(); if (st) st.textContent = '完成'; }
        catch (e) { toastr.error('同步失败：' + e.message); if (st) st.textContent = '同步失败'; }
    });
    $('cs_pull_char')?.addEventListener('click', async () => {
        showBusy(0, 0, '导入角色全部聊天…');
        const st = $('cs_status'); if (st) st.textContent = '拉取中…';
        try { await pullCurrentCharacter(); if (st) st.textContent = '完成'; }
        catch (e) { toastr.error('拉取失败：' + e.message); if (st) st.textContent = '拉取失败'; }
    });
    $('cs_push_all')?.addEventListener('click', async () => {
        try { await pushAllCharacters(true, 'save_elsewhere'); } // 免二次确认; 分叉聊天统一「另行保存」零丢失
        catch (e) { toastr.error('批量上传失败：' + e.message); }
    });
    $('cs_pull_all')?.addEventListener('click', async () => {
        try { await importAllCharacters(); }
        catch (e) { toastr.error('批量导入失败：' + e.message); }
    });
    // 酒馆配置一键保存 / 一键恢复
    // ── 全量上传(本设备→云端): 手机端也能用的反向全量 —— 逐类复用现有官方通道, 顺序执行 ──
    $('cs_cfg_full_upload')?.addEventListener('click', async () => {
        const st = $('cs_backup_status');
        const setStat = (m) => { if (st) st.textContent = m; };
        if (window.__csFullUploadRunning) { toastr.warning('全量上传正在进行中'); return; }
        const okc = await csConfirm('📤 全量上传（本设备→云端）', '将把本设备可同步的全部数据<b>依次上传</b>到云端对应位置：<br>① 全部角色(卡+绑定世界书+聊天) ② 全部连接预设 ③ 全部主题 ④ 全局正则 ⑤ User资料+头像 ⑥ 扩展设置快照<br><small>同名内容有差异时会弹个别确认框；云端多出来的数据不会被删除。</small><br>确定开始吗？');
        if (!okc) return;
        window.__csFullUploadRunning = true;
        const results = [];
        let step = 0; const totalSteps = 6;
        const runStep = async (label, fn) => {
            step++;
            setStat(`[${step}/${totalSteps}] ${label}中…`);
            try { const r = await fn(); results.push(`✅${label}`); return r; }
            catch (e) { results.push(`❌${label}:${(e && e.message) || e}`); return null; }
        };
        try {
            // ① 全部角色(内部自拿锁)
            await runStep('全部角色', pushAllCharacters);
            // ② 全部连接预设(PresetManager 活列表枚举)
            await runStep('连接预设', async () => {
                let names = [];
                try {
                    const pm = getContext().getPresetManager && getContext().getPresetManager('openai');
                    if (pm) { const { preset_names } = pm.getPresetList('openai'); presetNames = preset_names; }
                } catch { }
                var presetNames = Array.isArray(presetNames) ? presetNames : [];
                if (!presetNames.length) presetNames = (await _connPresetNamesOf(CONN_PRESET_GROUPS[0])) || [];
                presetNames = presetNames.filter((n) => _connPresetVisible(String(n)));
                if (!presetNames.length) { results.push('➖连接预设(无)'); return null; }
                return await pushSelectedConnPresets(presetNames.map((n) => ({ apiId: 'openai', name: String(n) })));
            });
            // ③ 全部主题(settings.themes 数组枚举)
            await runStep('全部主题', async () => {
                const names = (await _themeLocalList()).map((t) => t.name).filter(Boolean);
                if (!names.length) { results.push('➖主题(无)'); return null; }
                return await pushSelectedThemes(names);
            });
            // ④ 全局正则
            await runStep('全局正则', async () => {
                const names = (await _regexLocalList()).map((r2) => r2.name).filter(Boolean);
                if (!names.length) { results.push('➖正则(无)'); return null; }
                return await pushSelectedRegex(names);
            });
            // ⑤ User 资料+头像
            await runStep('User 资料', backupUserToCloud);
            // ⑥ extension_settings 快照
            await runStep('扩展设置快照', backupConfigToCloud);
        } finally {
            window.__csFullUploadRunning = false;
            setStat('全量上传结束：' + results.join('　'));
            toastr.info('全量上传结束：' + results.join('　'), null, { timeOut: 8000 });
        }
    });
    // ── 从云端恢复【全量数据归档】: ST 端用 st-full-backup.py 上传的 tar.gz → 官方 data-migration import ──
    $('cs_cfg_full_restore')?.addEventListener('click', async () => {
        const st = $('cs_backup_status');
        const setStat = (m) => { if (st) st.textContent = m; };
        const okc = await csConfirm('⚠⚠ 从云端恢复全量数据', '将把云端的全量数据归档<b>整个替换</b>当前设备的角色、聊天、世界书、预设、主题等全部数据！<br><b style="color:#e66">本机现有的一切会被覆盖，且无法在本机找回。</b><br>确认要继续吗？');
        if (!okc) return;
        if (!__csTryBusy()) { toastr.warning('已有同步在进行中'); return; }
        try {
            // ① 读指针
            setStat('正在读取云端全量备份指针…');
            const lc = await Gitee.getText('sync-config/full-latest.json');
            if (!lc || !lc.content) { toastr.error('云端没有全量数据归档——请先在电脑端运行 st-full-backup.py 上传'); return; }
            const meta = JSON.parse(lc.content);
            const dir = `sync-config/full/${meta.ts}`;
            // ② 分块下载拼装
            const parts = [];
            for (let i = 0; i < (meta.chunks || 0); i++) {
                setStat(`正在下载全量归档：第 ${i + 1}/${meta.chunks} 块…`);
                const pc = await Gitee.getText(`${dir}/part-${String(i).padStart(4, '0')}`);
                if (!pc) { throw new Error(`归档分块 part-${i} 缺失(上传不完整?)`); }
                const bin = atob(String(pc.content).replace(/\s/g, ''));
                const u8 = new Uint8Array(bin.length);
                for (let j = 0; j < bin.length; j++) u8[j] = bin.charCodeAt(j);
                parts.push(u8);
            }
            let totalLen = 0; parts.forEach((u) => totalLen += u.length);
            const blobParts = []; let off = 0;
            for (const u of parts) { blobParts.push(u); off += u.length; }
            const archiveBlob = new Blob(parts, { type: 'application/gzip' });
            setStat(`下载完成（${(totalLen / 1048576).toFixed(1)} MB），正在提交官方迁移…`);
            // ③ 官方 data-migration import(multipart)
            const file = new File([archiveBlob], `st-data-${meta.ts}.tar.gz`, { type: 'application/gzip' });
            const fd = new FormData(); fd.append('archive', file);
            const resp = await fetch('/api/extensions/data-migration/import', { method: 'POST', body: fd });
            if (!resp.ok) { throw new Error('导入任务启动失败 HTTP ' + resp.status + '：' + (await resp.text()).slice(0, 200)); }
            const jobPayload = await resp.json();
            const jobId = String(jobPayload.job_id || '');
            if (!jobId) { throw new Error('迁移任务未返回 job_id'); }
            // ④ 轮询到完成
            let done = false;
            for (let tick = 0; tick < 400; tick++) {
                await new Promise((r) => setTimeout(r, 1500));
                const sr = await fetch(`/api/extensions/data-migration/job?id=${encodeURIComponent(jobId)}`, { cache: 'no-store' });
                if (!sr.ok) continue;
                const status = await sr.json();
                const stage = [status.stage, status.message].filter(Boolean).join(' | ');
                const pct = Number.isFinite(Number(status.progress_percent)) ? Number(status.progress_percent).toFixed(0) + '%' : '';
                setStat(`官方迁移进行中 ${stage ? '｜ ' + stage : ''}${pct ? ' ｜ ' + pct : ''}`);
                if (['completed', 'failed', 'cancelled'].includes(String(status.state))) {
                    if (String(status.state) === 'completed') done = true;
                    else throw new Error('官方迁移未成功: ' + (status.error || status.state));
                }
                if (done) break;
            }
            setStat(done ? '✅ 全量数据迁移完成！页面将自动刷新…' : '迁移超时未确认，请稍后刷新查看');
            toastr.success('✅ 全量数据迁移完成，即将刷新酒馆', null, { timeOut: 6000 });
            setTimeout(() => location.reload(), 2500);
        } catch (e) {
            setStat('');
            toastr.error('全量恢复失败：' + ((e && e.message) || e));
        } finally { __csReleaseBusy(); }
    });
    $('cs_cfg_restore')?.addEventListener('click', async () => {
        const st = $('cs_cfg_status'); if (st) st.textContent = '正在从云端恢复酒馆配置…';
        const target = window.__cfgSelectedBackup || undefined; // 未拉列表时=恢复最新
        const prettyT = target ? String(target).replace('T', ' ') : '最新一份';
        const ok = await csConfirm('⚠ 恢复酒馆配置', `确定用云端的 <b>${escapeHtml(prettyT)}</b> 整包覆盖当前配置吗？恢复后请刷新/重载酒馆生效。<br>（插件的连接仓库/令牌/同步映射不会被覆盖）`);
        if (!ok) { if (st) st.textContent = '已取消'; return; }
        await restoreConfigFromCloud(target);
        if (st) st.textContent = '';
    });
    // ── 聊天记录清理器 ──
    window.__clnView = window.__clnView || 'local';
    window.__clnDesc = window.__clnDesc !== false; // 默认按最新修改时间倒序(最新在前)
    window.__clnRows = [];
    window.__clnChar = '';
    async function __fillCleanerChars() {
        const sel = $('cs_cln_char'); if (!sel) return;
        const cur = sel.value;
        const localNames = (getContext().characters || []).filter((x) => x && x.name && !String(x.name).startsWith('Group')).map((x) => x.name);
        let cloudNames = [];
        try { cloudNames = await Gitee.listDir('sync'); } catch { }
        const all = [...new Set([...localNames, ...cloudNames])];
        sel.innerHTML = all.map((n) => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join('');
        if (cur && all.includes(cur)) sel.value = cur;
    }
    function __clnRowHtml(r) {
        const whereTag = { both: '<b class="cs-cln-where cs-cln-where-both">双端</b>', local: '<b class="cs-cln-where cs-cln-where-local">仅本地</b>', cloud: '<b class="cs-cln-where cs-cln-where-cloud">仅云端</b>' };
        return `<div class="cs-role-item cs-cln-row" data-file="${escapeHtml(r.fileName)}">
            <input type="checkbox" value="${escapeHtml(r.fileName)}" name="cs_cln_sel">
            ${whereTag[r.where] || ''}
            <span class="cs-cln-fname" title="${escapeHtml(r.fileName)} 楼${r.mesCount ?? '?'}">${escapeHtml(r.fileName)} <small>楼${r.mesCount ?? '?'}</small></span>
            <b class="cs-cln-size">${escapeHtml(String(r.size || '?'))}</b>
            <small class="cs-cln-date">最新修改时间：${escapeHtml(r.lastTime || '?')}</small>
        </div>`;
    }
    function __filterClnRows() {
        const rows = window.__clnRows.filter((r) => window.__clnView === 'local' ? (r.where !== 'cloud') : (r.where !== 'local'));
        const key = (r) => String(r.lastTime || '');
        return window.__clnDesc === false ? [...rows].sort((a, b) => key(a).localeCompare(key(b))) : [...rows].sort((a, b) => key(b).localeCompare(key(a)));
    }
    async function __renderCleanerList() {
        const box = $('cs_cln_listbox'); const st = $('cs_cln_status'); const sel = $('cs_cln_char');
        if (!box || !sel) return;
        const charName = sel.value;
        if (!charName) { box.innerHTML = '<p class="cs-hint">（请先选择角色）</p>'; return; }
        if (st) st.textContent = '读取中…';
        showBusy(0, 0, '正在获取聊天列表…');
        const prevChecked = new Set([...document.querySelectorAll('input[name="cs_cln_sel"]:checked')].map((c) => c.value));
        let rows = [];
        try { rows = await listCleanerRows(charName); }
        catch (e) { hideBusy(); if (st) st.textContent = '读取失败：' + (e && e.message || e); return; }
        window.__clnRows = rows; window.__clnChar = charName;
        const shown = __filterClnRows();
        hideBusy();
        if (st) st.textContent = `${window.__clnView === 'local' ? '本地' : '云端'}视图：${shown.length} 条（该角色总共 ${rows.length} 条：双端 ${rows.filter(r=>r.where==='both').length} / 仅本地 ${rows.filter(r=>r.where==='local').length} / 仅云端 ${rows.filter(r=>r.where==='cloud').length}）`;
        box.innerHTML = shown.length ? shown.map(__clnRowHtml).join('')
            : `<p class="cs-hint">（${window.__clnView === 'local' ? '本地' : '云端'}没有该角色的聊天记录）</p>`;
    }
    // 角色切换 → 自动列出
    $('cs_cln_char')?.addEventListener('change', async () => { await __renderCleanerList(); });
    $('cs_cln_local')?.addEventListener('click', async () => { window.__clnView = 'local'; await __renderCleanerList(); });
    $('cs_cln_cloud')?.addEventListener('click', async () => { window.__clnView = 'cloud'; await __renderCleanerList(); });
    $('cs_cln_selall')?.addEventListener('click', () => document.querySelectorAll('input[name="cs_cln_sel"]').forEach((c) => { c.checked = true; }));
    $('cs_cln_clr')?.addEventListener('click', () => document.querySelectorAll('input[name="cs_cln_sel"]').forEach((c) => { c.checked = false; }));
    $('cs_cln_sort')?.addEventListener('click', async () => {
        window.__clnDesc = !window.__clnDesc;
        const b = $('cs_cln_sort'); if (b) b.textContent = window.__clnDesc ? '⇅ 时间倒序' : '⇅ 时间正序';
        await __renderCleanerList();
    });

    // ── 预览弹窗（左=最新一楼(非user)预览 / 右=列表，点选切换、划选、全选清空删除） ──
    // 背景滚动锁: 弹窗打开时锁住背后页面滚动(防手机拖弹窗外围带动页面), 关闭恢复; 幂等可重入
    function __csLockBgScroll() { if (window.__csBodyOverflow == null) { window.__csBodyOverflow = document.body.style.overflow || ''; document.body.style.overflow = 'hidden'; } }
    function __csUnlockBgScroll() { if (window.__csBodyOverflow != null) { document.body.style.overflow = window.__csBodyOverflow; window.__csBodyOverflow = null; } }
    // 弹窗掩码: 挂 body + absolute 视口坐标校正(html 全局缩放时 position:fixed 会退化成半个视口大小,
    // 弹窗被裁到左上、关闭按钮跑出屏幕——TT 手机端"无法关闭/关闭在页面外"的真凶, 已实测证实)。
    // 三事件防关面板(TT 关 drawer 监听的是 touchstart+mousedown, 只拦 click 无效)。
    function __csOpenMask(onMaskClick) {
        const m = document.createElement('div');
        m.style.cssText = 'position:absolute;left:0;top:0;width:0;height:0;z-index:100000;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center';
        document.body.appendChild(m);
        const apply = () => {
            if (!m.isConnected) return;
            m.style.left = window.scrollX + 'px';
            m.style.top = window.scrollY + 'px';
            m.style.width = window.innerWidth + 'px';
            m.style.height = window.innerHeight + 'px';
        };
        const refresh = () => requestAnimationFrame(apply);
        window.addEventListener('scroll', refresh, { passive: true });
        window.addEventListener('resize', refresh, { passive: true });
        window.addEventListener('orientationchange', refresh, { passive: true });
        apply();
        requestAnimationFrame(apply);
        m.addEventListener('touchstart', (e) => e.stopPropagation(), { passive: true });
        m.addEventListener('mousedown', (e) => e.stopPropagation());
        m.addEventListener('click', (e) => { e.stopPropagation(); if (onMaskClick && e.target === m) onMaskClick(); });
        m.__csDestroy = () => {
            window.removeEventListener('scroll', refresh);
            window.removeEventListener('resize', refresh);
            window.removeEventListener('orientationchange', refresh);
        };
        return m;
    }
    function __csCloseMask(m) { if (m && m.__csDestroy) m.__csDestroy(); if (m && m.isConnected) m.remove(); }
    function __clnCloseModal() { const m3 = document.getElementById('cs_cln_modal'); if (m3) { __csCloseMask(m3); __csUnlockBgScroll(); } }
    window.__clnPreview = null; // {fileName, floors, idx}
    function __clnRenderFloor() {
        const pane = document.getElementById('cs_cln_preview');
        const pv = window.__clnPreview;
        if (!pane || !pv || !pv.floors || !pv.floors.length) return;
        const f = pv.floors[pv.idx];
        const r = window.__clnRows.find((x) => x.fileName === pv.fileName);
        const who = f.is_user ? `${f.name || 'user'}（你）` : (f.name || 'AI');
        const nav = `<div class="cs-cln-fnav">
            <button class="cs-btn" id="cs_cln_f_prev" type="button"${pv.idx <= 0 ? ' disabled' : ''}>⬅ 上一楼</button>
            <span class="cs-cln-fnum">第 ${pv.idx + 1} / ${pv.floors.length} 楼 · ${escapeHtml(who)}</span>
            <button class="cs-btn" id="cs_cln_f_next" type="button"${pv.idx >= pv.floors.length - 1 ? ' disabled' : ''}>下一楼 ➡</button>
            <input id="cs_cln_f_jump" type="number" min="1" max="${pv.floors.length}" placeholder="楼层号" style="width:64px" class="text_pole">
            <button class="cs-btn" id="cs_cln_f_go" type="button">跳转</button>
        </div>`;
        // nav 为预览框固定头部(flex:none), 标题+正文放独立滚动区 fbody —— 导航物理贴顶, 不依赖 sticky
        pane.innerHTML = nav
            + `<div class="cs-cln-fbody" id="cs_cln_fbody"><div class="cs-cln-ptitle"><b>${escapeHtml(pv.fileName)}</b><br><small>最新修改时间：${escapeHtml(r ? r.lastTime : '?')} ｜ 大小 <b class="cs-cln-size">${escapeHtml(String(r ? r.size : '?'))}</b> ｜ 共 ${pv.floors.length} 楼</small></div>`
            + `<div class="cs-cln-ptext cs-cln-fl ${f.is_user ? 'cs-cln-fl-user' : 'cs-cln-fl-ai'}">${__fmtPrevText(previewAfterContent(f.mes).slice(0, 6000)) || '（这层楼没有文字内容）'}</div></div>`;
        pane.innerHTML += '<button class="cs-top-fab" type="button">↑ 回顶部</button>';
        const fbody = pane.querySelector('#cs_cln_fbody');
        fbody.scrollTop = 0; // 每次切楼都定位在这层楼内容的最上面
        requestAnimationFrame(() => { fbody.scrollTop = 0; }); // 手机 WebView 布局时序兜底
        // 回顶部按钮: 滚过一屏才出现(scroll 委托只绑一次, 楼层重渲染不叠加监听)
        if (!pane.dataset.csFabBound) {
            pane.dataset.csFabBound = '1';
            pane.addEventListener('scroll', () => {
                const fb2 = pane.querySelector('.cs-top-fab');
                const fbod = pane.querySelector('#cs_cln_fbody');
                if (fb2 && fbod) fb2.style.display = fbod.scrollTop > 300 ? 'block' : 'none';
            }, { passive: true });
        }
        pane.querySelector('.cs-top-fab')?.addEventListener('click', () => fbody.scrollTo({ top: 0, behavior: 'smooth' }));
        document.getElementById('cs_cln_f_prev')?.addEventListener('click', () => { if (pv.idx > 0) { pv.idx--; __clnRenderFloor(); } });
        document.getElementById('cs_cln_f_next')?.addEventListener('click', () => { if (pv.idx < pv.floors.length - 1) { pv.idx++; __clnRenderFloor(); } });
        const go = () => {
            const v = Number(document.getElementById('cs_cln_f_jump')?.value);
            if (v >= 1 && v <= pv.floors.length) { pv.idx = v - 1; __clnRenderFloor(); }
        };
        document.getElementById('cs_cln_f_go')?.addEventListener('click', go);
        document.getElementById('cs_cln_f_jump')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    }
    async function __clnShowPreview(fileName) {
        const pane = document.getElementById('cs_cln_preview');
        if (!pane) return;
        const r = window.__clnRows.find((x) => x.fileName === fileName);
        pane.dataset.cur = fileName;
        document.querySelectorAll('#cs_cln_modal .cs-cln-mrow').forEach((el) => el.classList.toggle('cs-cln-active', el.dataset.file === fileName));
        // 同文件已缓存 → 直接切(楼层位置重置到默认楼)
        const cached = window.__clnPreview && window.__clnPreview.fileName === fileName ? window.__clnPreview : null;
        if (cached) { cached.idx = cached.defIdx != null ? cached.defIdx : cached.floors.length - 1; __clnRenderFloor(); return; }
        pane.innerHTML = '<div class="cs-cln-ptext">读取中…</div>';
        const d = await getCleanerPreviewFull(window.__clnChar, fileName).catch(() => null);
        if (pane.dataset.cur !== fileName) return; // 已切到别的行, 丢弃过期结果
        if (!d || !d.floors || !d.floors.length) {
            const r2 = window.__clnRows.find((x) => x.fileName === fileName);
            pane.innerHTML = `<div class="cs-cln-ptitle"><b>${escapeHtml(fileName)}</b><br><small>最新修改时间：${escapeHtml(r2 ? r2.lastTime : '?')}</small></div><div class="cs-cln-ptext">（读不到内容：可能仅云端且下载失败）</div>`;
            return;
        }
        window.__clnPreview = { fileName, floors: d.floors, idx: d.defIdx, defIdx: d.defIdx };
        __clnRenderFloor();
    }
    function __clnOpenModal() {
        __clnCloseModal();
        const shown = __filterClnRows();
        if (!shown.length) { toastr.info('当前视图没有聊天记录'); return; }
        const m = __csOpenMask(() => __clnCloseModal()); m.id = 'cs_cln_modal';
        m.innerHTML = `
            <div class="cs-cln-modal">
                <div class="cs-cln-left" id="cs_cln_preview" style="user-select:text"></div>
                <div class="cs-cln-right">
                    <div class="cs-cln-mbar">
                        <div class="cs-cln-mbar-title">聊天列表 <small>点行＝只预览；勾选框＝选中</small></div>
                        <div class="cs-cln-mbar-btns">
                            <button class="cs-btn" id="cs_cln_m_selall" type="button">☑ 全选</button>
                            <button class="cs-btn" id="cs_cln_m_clr" type="button">☐ 清空</button>
                            <button class="cs-btn cs-danger-btn" id="cs_cln_m_del" type="button">🗑 删除选中</button>
                            <button class="cs-btn" id="cs_cln_m_close" type="button">✕ 关闭</button>
                        </div>
                    </div>
                    <div id="cs_cln_mlist" class="cs-roles cs-sellect" style="flex:1;overflow:auto;padding:4px;user-select:none"></div>
                </div>
            </div>`;
        // 挂 body: fixed 相对视口(挂面板容器在手机端遇 transform 祖先会吸附到页面顶部)
        // ⚠️ TT 自动关 drawer 的监听是 $('html').on('touchstart mousedown')(TT源码 script.js:14028) —— 必须三事件全拦, 只拦 click 无效(0.2.8/0.2.14 两轮实证)
        // 挂 body + 掩码由 __csOpenMask 管理(absolute 视口校正 + 三事件防关面板), 这里不再重复绑定
        __csLockBgScroll();
        document.getElementById('cs_cln_m_close').addEventListener('click', __clnCloseModal);
        document.getElementById('cs_cln_m_selall').addEventListener('click', () => document.querySelectorAll('#cs_cln_modal input[name="cs_cln_msel"]').forEach((c) => { c.checked = true; }));
        document.getElementById('cs_cln_m_clr').addEventListener('click', () => document.querySelectorAll('#cs_cln_modal input[name="cs_cln_msel"]').forEach((c) => { c.checked = false; }));
        const list = document.getElementById('cs_cln_mlist');
        list.innerHTML = shown.map((r) => `<div class="cs-role-item cs-cln-mrow" data-file="${escapeHtml(r.fileName)}" title="${escapeHtml(r.fileName)} ｜ 最新修改时间：${escapeHtml(r.lastTime || '?')}">
            <input type="checkbox" value="${escapeHtml(r.fileName)}" name="cs_cln_msel">
            <span class="cs-cln-fname">${escapeHtml(r.fileName)}</span>
            <b class="cs-cln-size">${escapeHtml(String(r.size || '?'))}</b>
        </div>`).join('');
        // 点行(非勾选框) → 切换预览
        list.addEventListener('click', (e) => {
            if (e.target instanceof HTMLInputElement) return;
            const row = e.target.closest('.cs-cln-mrow'); if (row) __clnShowPreview(row.dataset.file);
        });
        // 弹窗内拖拽划选（与角色/世界书列表同一套防双击实现：<4px 交给原生一次翻转，≥4px 拖拽+toggled 去重+one-shot 拦截）
        (function bindModalDrag() {
            let dragging = false, dragMoved = false, startX = 0, startY = 0;
            const toggled = new Set();
            list.addEventListener('mousedown', (e) => { if (e.button !== 0) return; dragging = true; dragMoved = false; startX = e.clientX; startY = e.clientY; toggled.clear(); });
            list.addEventListener('mousemove', (e) => {
                if (!dragging) return;
                if (!dragMoved) { if (Math.abs(e.clientX - startX) < 4 && Math.abs(e.clientY - startY) < 4) return; dragMoved = true; }
                const el = document.elementFromPoint(e.clientX, e.clientY);
                const rowEl = el && el.closest('.cs-cln-mrow'); // ⚠️ 弹窗行类名是 mrow, 主列表才是 row
                if (rowEl) { const cb = rowEl.querySelector('input[type="checkbox"]'); if (cb && !toggled.has(cb)) { toggled.add(cb); cb.checked = !cb.checked; } }
            });
            window.addEventListener('mouseup', () => {
                if (dragging && dragMoved) {
                    const swallow = (ev) => { ev.stopPropagation(); ev.preventDefault(); };
                    list.querySelectorAll('input[name="cs_cln_msel"]').forEach((cb) => { if (toggled.has(cb)) cb.addEventListener('click', swallow, { once: true, capture: true }); });
                }
                dragging = false; dragMoved = false;
            });
        })();
        // 弹窗内删除
        document.getElementById('cs_cln_m_del').addEventListener('click', async () => {
            const chosen = [...document.querySelectorAll('#cs_cln_modal input[name="cs_cln_msel"]:checked')].map((c) => c.value);
            if (!chosen.length) { toastr.warning('请先勾选要删除的聊天'); return; }
            const okc = await csConfirm('⚠ 永久删除聊天记录', `将删除「${escapeHtml(window.__clnChar)}」的 <b>${chosen.length}</b> 条聊天，<b>本地和云端一起删，删了就找不回来</b>：<br>${escapeHtml(csShortList(chosen, 8))}`);
            if (!okc) return;
            if (!__csTryBusy()) { toastr.warning('已有同步在进行中'); return; }
            try { const r = await deleteChatsBothSides(window.__clnChar, chosen); toastr.info(`删除完成：成功 ${r ? r.ok : 0} / 共 ${chosen.length}${r && r.fail ? `，失败 ${r.fail}（${csShortList(r.failReasons.map(x => x.name + ':' + x.reason))}）` : ''}`); }
            finally { __csReleaseBusy(); }
            __clnCloseModal(); await __renderCleanerList();
        });
        __clnShowPreview(shown[0].fileName); // 默认预览第一条
    }
    // 主列表：点行(非勾选框)打开预览弹窗 + 主列表拖拽划选（同一套防双击）
    (function bindClnList() {
        const box2 = $('cs_cln_listbox'); if (!box2 || box2.getAttribute('data-clndragbound')) return;
        box2.setAttribute('data-clndragbound', '1');
        box2.addEventListener('click', (e) => {
            if (e.target instanceof HTMLInputElement) return;
            const row = e.target.closest('.cs-cln-row'); if (row) __clnOpenModal();
        });
        let dragging = false, dragMoved = false, startX = 0, startY = 0;
        const toggled = new Set();
        box2.addEventListener('mousedown', (e) => { if (e.button !== 0) return; dragging = true; dragMoved = false; startX = e.clientX; startY = e.clientY; toggled.clear(); });
        box2.addEventListener('mousemove', (e) => {
            if (!dragging) return;
            if (!dragMoved) { if (Math.abs(e.clientX - startX) < 4 && Math.abs(e.clientY - startY) < 4) return; dragMoved = true; }
            const el = document.elementFromPoint(e.clientX, e.clientY);
            const label = el && el.closest('.cs-role-item');
            if (label) { const cb = label.querySelector('input[type="checkbox"]'); if (cb && !toggled.has(cb)) { toggled.add(cb); cb.checked = !cb.checked; } }
        });
        window.addEventListener('mouseup', () => {
            if (dragging && dragMoved) {
                const swallow = (ev) => { ev.stopPropagation(); ev.preventDefault(); };
                box2.querySelectorAll('input[name="cs_cln_sel"]').forEach((cb) => { if (toggled.has(cb)) cb.addEventListener('click', swallow, { once: true, capture: true }); });
            }
            dragging = false; dragMoved = false;
        });
    })();
    $('cs_cln_del')?.addEventListener('click', async () => {
        const sel = $('cs_cln_char'); const st = $('cs_cln_status');
        const charName = sel && sel.value;
        const chosen = [...document.querySelectorAll('input[name="cs_cln_sel"]:checked')].map((c) => c.value);
        if (!charName) { if (st) st.textContent = '请先选择角色'; return; }
        if (!chosen.length) { if (st) st.textContent = '请先勾选要删除的聊天'; return; }
        const okc = await csConfirm('⚠ 永久删除聊天记录', `将删除「${escapeHtml(charName)}」的 <b>${chosen.length}</b> 条聊天，<b>本地和云端一起删，删了就找不回来</b>：<br>${escapeHtml(csShortList(chosen, 8))}`);
        if (!okc) { if (st) st.textContent = '已取消'; return; }
        if (!__csTryBusy()) { if (st) st.textContent = '已有同步在进行中，稍后再试'; return; }
        try {
            if (st) st.textContent = '删除中…';
            const r = await deleteChatsBothSides(charName, chosen);
            if (st) st.textContent = `删除完成：成功 ${r ? r.ok : 0} / 共 ${chosen.length}${r && r.fail ? `，失败 ${r.fail}（${csShortList(r.failReasons.map(x => x.name + ':' + x.reason))}）` : ''}`;
        } finally { __csReleaseBusy(); }
        await __renderCleanerList();
    });
    // 面板打开时初始化角色下拉并自动列一次
    __fillCleanerChars().then(() => { if ($('cs_cln_char') && $('cs_cln_char').value) __renderCleanerList(); }).catch(() => { });

    // ── 酒馆配置 分项部分同步（多选选择单） ──
    window.__cfgTab = window.__cfgTab || 'conn';
    window.__cfgMode = window.__cfgMode || 'local';
    // 每类: {label, listLocal(), listCloud(), push(names), pull(names), del(names, mode)}
// ═══ 第五/第六分项: 扩展本体与配置 + 酒馆助手插件 ═══
const EXT_MANIFEST_PATH = 'config-sync/extensions/manifest.json';
const EXT_CONFIGS_DIR = 'config-sync/extensions/configs';
const TH_SCRIPTS_DIR = 'config-sync/tavern-helper/scripts';
// 配置安全清洗: 不把敏感字段带离本机(token/密钥类顶层键)
function __extSafeConfig(obj) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { __empty: true };
    const out = {};
    for (const k of Object.keys(obj)) {
        if (/token|secret|password|authorization|api_?key|apikey|key$/i.test(k)) continue;
        out[k] = obj[k];
    }
    return out;
}
// 展开 extension_settings.tavern_helper 脚本树顶层节点 → {name, type, node}
function __thTree(scope) {
    const th = extension_settings.tavern_helper;
    if (!th || !th.script || !Array.isArray(th.script.scripts)) return [];
    return th.script.scripts.map((n) => ({ name: n.name || '(未命名)', type: n.type || 'script', node: n }));
}
// 读顶层树数组(与 __thTree 同源: extension_settings 与官方 getScriptTrees 指向同一内存)
function __thGetTreeRaw() {
    const th = extension_settings.tavern_helper;
    return (th && th.script && Array.isArray(th.script.scripts)) ? th.script.scripts : [];
}
// 写树: 优先走 TavernHelper 官方接口 updateScriptTreesWith(用户确认可用, 与官方导入同通道), 缺失时退回直改+落盘
async function __thWriteTree(tree) {
    const th = window.TavernHelper;
    if (th && typeof th.updateScriptTreesWith === 'function') {
        await Promise.resolve(th.updateScriptTreesWith(() => tree, { type: 'global' }));
    } else {
        if (!extension_settings.tavern_helper) extension_settings.tavern_helper = { script: { scripts: [] } };
        extension_settings.tavern_helper.script.scripts = tree;
    }
    saveSettingsDebounced();
}
function __thFindNode(name, type) {
    const root = __thGetTreeRaw();
    return root.find((n) => n.name === name && (type ? n.type === type : true)) || null;
}
async function __thReplaceNode(name, type, node) {
    const root = __thGetTreeRaw();
    const idx = root.findIndex((n) => n.name === name && (type ? n.type === type : true));
    if (idx >= 0) root[idx] = node;
    await __thWriteTree(root);
}
async function __thRemoveNode(name, type) {
    const root = __thGetTreeRaw();
    await __thWriteTree(root.filter((n) => !(n.name === name && (type ? n.type === type : true))));
}
// 规范化云文件名: 中文/空格安全转 [A-Za-z0-9_-]
function __safeName(name) {
    const n = String(name).replace(/[^\w\u4e00-\u9fa5-]/g, '_');
    return n.slice(0, 60) || 'script';
}
async function __discoverExts() {
    const r = await fetch('/api/extensions/discover', { cache: 'no-store' });
    if (!r.ok) throw new Error('扩展清单获取失败 HTTP ' + r.status);
    const j = await r.json();
    const arr = Array.isArray(j) ? j : [];
    // 只取第三分项(内置扩展不备份, 与官方 discover 的 type 口径一致: 内置=name无前缀)
    // ⚠️ 记录每项 type(local/global): version 必须按真实目录传 global——写死 global:true 会让 user 目录(
    //    type=local)扩展永远拿不到 remoteUrl → push 存空 → 新设备无法重装(20个扩展全无URL的根因)
    window.__extType = window.__extType || {};
    const out = [];
    for (const x of arr) {
        if (String(x.name).startsWith('third-party/')) {
            window.__extType[String(x.name)] = x.type === 'global' ? 'global' : 'local';
            out.push(String(x.name));
        }
    }
    // 显示名: 每个扩展自带 manifest.json 的 display_name(官方加载器同一URL, TT/ST 服务端均挂载, 实测通)
    window.__extDisplayBy = window.__extDisplayBy || {};
    // 详情( url/branch/commit )并发取
    window.__extMeta = window.__extMeta || {};
    // 后台异步填充元数据(不阻塞列表渲染); 60s 缓存
    if (window.__extMetaFetchedAt && Date.now() - window.__extMetaFetchedAt < 60000 && out.every((f) => window.__extMeta[f])) {
        return out.sort(); // 全部有缓存, 跳过
    }
    window.__extMetaFetchedAt = Date.now();
    Promise.all(out.map(async (full) => {
        const sname = String(full).split('/').pop();
        const jobs = [];
        if (!window.__extDisplayBy[sname]) {
            jobs.push(fetch(`/scripts/extensions/${full}/manifest.json`, { cache: 'no-store' })
                .then((r) => (r.ok ? r.json() : null))
                .then((m) => { if (m && m.display_name) window.__extDisplayBy[sname] = String(m.display_name); })
                .catch(() => { }));
        }
        if (!window.__extMeta[full]) {
            // URL 获取三级: ①按type查version → ②反着再试 → ③读扩展目录 .git/config 的 remote url
            // (TT fork: discover 把数据目录报为 global, 但 version 只查 public——后装扩展必定 404;
            //  官方为扩展目录开了静态读取(users.js createExtensionsRouteHandler), .git/config 可直接拿到 remote url, 实测 TT 全局类扩展 200)
            const gFirst = window.__extType[full] === 'global';
            const nmFull = full, nmPure = String(full).split('/').pop();
            const combos = gFirst
                ? [{ n: nmFull, g: true }, { n: nmFull, g: false }, { n: nmPure, g: true }, { n: nmPure, g: false }]
                : [{ n: nmFull, g: false }, { n: nmPure, g: false }, { n: nmFull, g: true }, { n: nmPure, g: true }];
            const fetchConfigUrl = async () => {
                try {
                    const r = await fetch(`/scripts/extensions/${full}/.git/config`, { cache: 'no-store' });
                    if (!r.ok) return { url: '', err: 'HTTP ' + r.status + '(无.git/config)' };
                    const cfg = await r.text();
                    const m = String(cfg).match(/\[remote\s+"?origin"?\][\s\S]*?url\s*=\s*(\S+)/i);
                    if (m) return { url: m[1].trim(), err: '' };
                    return { url: '', err: '有.git但无origin remote' };
                } catch (e) { return { url: '', err: String((e && e.message) || e).slice(0, 80) }; }
            };
            jobs.push((async () => {
                let firstErr = '';
                const tryVersion = async (nm, g) => {
                    const r = await fetch('/api/extensions/version', {
                        method: 'POST', headers: getRequestHeaders(),
                        body: JSON.stringify({ extensionName: nm, global: g }),
                    });
                    if (!r.ok) { firstErr = 'HTTP ' + r.status + ' ' + (await r.text().catch(() => '')).slice(0, 50); return null; }
                    const v = await r.json();
                    const url = String(v.remoteUrl || '');
                    if (url) return { url, branch: String(v.currentBranchName || ''), commit: String(v.currentCommitHash || ''), upToDate: !!v.isUpToDate, err: '' };
                    firstErr = '版本查询200但remoteUrl为空';
                    return null;
                };
                for (const c of combos) {
                    try { const got = await tryVersion(c.n, c.g); if (got) { window.__extMeta[full] = got; return; } }
                    catch (e2) { if (!firstErr) firstErr = String((e2 && e2.message) || e2).slice(0, 90); }
                }
                // version 全灭 → .git/config 兜底
                const cf = await fetchConfigUrl();
                if (cf.url) {
                    window.__extMeta[full] = { url: cf.url, branch: '', commit: '', err: '' };
                } else {
                    window.__extMeta[full] = { url: '', branch: '', commit: '', err: (firstErr ? firstErr + ' 且 ' : '') + cf.err };
                }
            })().catch(() => { }));
        }
        await Promise.all(jobs);
    })).then(() => {
        window.__extMetaReady = true;
        if (window.__cfgTab === 'ext') { try { window.__renderCfgList(window.__cfgMode); } catch { } }
    }).catch(() => { });
    return out.sort();
}
// 扩展名 → extension_settings 键: 无通用规则, 用特例表+规范化匹配(源码实证: JSR=tavern_helper, kimi=kimi_reasoning_injector)
const EXT_SETTINGS_MAP = { 'JS-Slash-Runner': 'tavern_helper', 'st-kimi-reasoning-injector': 'kimi_reasoning_injector' };
function __extSettingsKey(sname) {
    if (EXT_SETTINGS_MAP[sname]) return EXT_SETTINGS_MAP[sname];
    const canon = sname.toLowerCase().replace(/[^a-z0-9_]/g, '_');
    if (extension_settings[canon] !== undefined) return canon;
    // 模糊匹配前先排除自身与无关短词: base 过短(如 'st')会撞进 st_chat_sync 或别的扩展键 → 误当设置源
    const base = canon.split('_')[0];
    if (base && base.length >= 4) {
        const b = base.toLowerCase();
        for (const k of Object.keys(extension_settings)) {
            if (k === 'st_chat_sync') continue; // 绝不把别的扩展设置判成本插件的键
            if (k.toLowerCase().replace(/[^a-z0-9_]/g, '_').includes(b)) return k;
        }
    }
    return null;
}
    // ═══ 安全包: 扩展本体快照(git仓库API树+逐文件base64 → 云端bundle; 删库后仍可从云端还原源码) ═══
const EXT_BUNDLES_DIR = 'config-sync/extensions/bundles';
// 解析仓库url → 平台与owner/repo(支持 gitee/github/gitlab; 其余平台返回 null, 本体备份跳过)
function __extRepo(remoteUrl) {
    if (!remoteUrl) return null;
    try {
        const u = new URL(remoteUrl);
        const seg = u.pathname.split('/').filter(Boolean);
        if (seg.length >= 2 && /^(gitee\.com|gitlab\.com|github\.com|www\.github\.com)$/.test(u.hostname)) {
            return { platform: u.hostname.replace(/^www\./, '').split('.')[0], owner: seg[0], repo: seg.slice(1).join('/').replace(/\.git$/, '') };
        }
    } catch { }
    return null;
}
async function __extJson(url, opts) {
    const r = await fetch(url, Object.assign({ cache: 'no-store' }, opts || {}));
    if (!r.ok) throw new Error('HTTP ' + r.status + (r.status === 403 ? '(限流)' : ''));
    return r.json();
}
// 返回文件清单 [{path, sha, type}] 或抛错(噪音目录与超大文件在 build 阶段过滤)
async function __extTree(parsed, branch) {
    const br = encodeURIComponent(branch || 'main');
    if (parsed.platform === 'gitee') {
        const j = await __extJson(`https://gitee.com/api/v5/repos/${parsed.owner}/${parsed.repo}/git/trees/${br}?recursive=1&access_token=${encodeURIComponent(settings.token)}`);
        return (j.tree || []).filter((x) => x.type === 'blob').map((x) => ({ path: x.path, sha: x.sha }));
    }
    if (parsed.platform === 'github') {
        const j = await __extJson(`https://api.github.com/repos/${parsed.owner}/${parsed.repo}/git/trees/${br}?recursive=1`);
        return (j.tree || []).filter((x) => x.type === 'blob').map((x) => ({ path: x.path, sha: x.sha }));
    }
    if (parsed.platform === 'gitlab') {
        const enc = encodeURIComponent(`${parsed.owner}/${parsed.repo}`);
        const all = [];
        for (let page = 1; page <= 20; page++) {
            const j = await __extJson(`https://gitlab.com/api/v4/projects/${enc}/repository/tree?per_page=100&recursive=true&ref=${br}&page=${page}`);
            const arr = Array.isArray(j) ? j : [];
            all.push(...arr);
            if (arr.length < 100) break;
        }
        return all.filter((x) => x.type === 'blob').map((x) => ({ path: x.path, sha: x.id }));
    }
    throw new Error('不支持平台');
}
// 取单个文件内容 → base64(无BOM) 或 null
async function __extBlobB64(parsed, sha) {
    if (parsed.platform === 'gitee') {
        const j = await __extJson(`https://gitee.com/api/v5/repos/${parsed.owner}/${parsed.repo}/git/blobs/${sha}?access_token=${encodeURIComponent(settings.token)}`);
        return (j.content && j.encoding === 'base64') ? j.content : null;
    }
    if (parsed.platform === 'github') {
        const j = await __extJson(`https://api.github.com/repos/${parsed.owner}/${parsed.repo}/git/blobs/${sha}`);
        return (j.content && j.encoding === 'base64') ? j.content : null;
    }
    if (parsed.platform === 'gitlab') {
        const enc = encodeURIComponent(`${parsed.owner}/${parsed.repo}`);
        const j = await __extJson(`https://gitlab.com/api/v4/projects/${enc}/repository/blobs/${sha}`);
        // GitLab 返回 UTF-8 文本内容(base64 化, 规避传输编码问题)
        if (typeof j.content !== 'string') return null;
        return btoa(unescape(encodeURIComponent(j.content)));
    }
    return null;
}
// 生成本体快照 → {ok, bundle?, reason?}  并发6, 120s上限
async function __buildExtBundle(full) {
    const meta = (window.__extMeta && window.__extMeta[full]) || {};
    const parsed = __extRepo(meta.url);
    if (!parsed) return { ok: false, reason: '未记录仓库URL(非gitee/gitlab/github来源)' };
    try {
        const tree = await __extTree(parsed, meta.branch || 'main');
        // 噪音目录跳过(源码仓库开发件, 与运行时无关, 且常含超大文件): node_modules/.github/.vscode/.git
        const NOISE = /(^|\/)(node_modules|\.github|\.vscode|\.git)(\/|$)/;
        const want = tree.filter((x) => !NOISE.test(x.path));
        const files = {};
        const skipped = [];
        let cursor = 0;
        const worker = async () => {
            while (cursor < want.length) {
                const i = cursor++;
                try {
                    const b64 = await __extBlobB64(parsed, want[i].sha);
                    if (b64 && b64.length < 1400000) files[want[i].path] = b64; // 1.33MB+ 的超大资源不纳入(多为附带资源, 核心代码远小于此)
                    else if (b64) skipped.push(want[i].path + '(>1.3MB)');
                    else skipped.push(want[i].path);
                } catch { skipped.push(want[i].path); }
            }
        };
        await Promise.all(Array.from({ length: 6 }, worker));
        if (!Object.keys(files).length) return { ok: false, reason: '仓库为空或全部拉取失败' };
        return { ok: true, bundle: { commit: meta.commit || '', branch: meta.branch || '', url: meta.url || '', files, skipped } };
    } catch (e) {
        return { ok: false, reason: '仓库访问失败:' + ((e && e.message) || e) };
    }
}
async function __extBundleSave(sname, bundle) {
    const p = `${EXT_BUNDLES_DIR}/${sname}.json`;
    await Gitee.putText(p, JSON.stringify(bundle), (await Gitee.getText(p).catch(() => null))?.sha, `安全包 ${sname}`);
}
async function __extBundleLoad(sname) {
    const j = await Gitee.getText(`${EXT_BUNDLES_DIR}/${sname}.json`).catch(() => null);
    if (!j || !j.content) return null;
    try { return JSON.parse(j.content); } catch { return null; }
}
// bundle → zip Blob(jszip), 供下载还原
async function __bundleToZip(bundle, sname) {
    await import('/lib/jszip.min.js');
    const JSZipInst = window.JSZip;
    const zip = new JSZipInst();
    const folder = zip.folder(sname);
    for (const p of Object.keys(bundle.files || {})) {
        try { folder.file(p, __b64ToU8(bundle.files[p])); } catch { }
    }
    return zip.generateAsync({ type: 'blob' });
}
function __b64ToU8(b64) {
    const bin = atob(b64);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return u8;
}
// zip 导出下载(浏览器触发下载; 电脑端解压后放扩展目录, 刷新即可)
async function __exportBundleZip(bundle, sname) {
    try {
        const zip = await __bundleToZip(bundle, sname);
        const url = URL.createObjectURL(zip);
        const a = document.createElement('a');
        a.href = url;
        a.download = sname + '-安全包.zip';
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
        return true;
    } catch { return false; }
}
// 调试/自测钩子
window.__extBundleLoad = __extBundleLoad;
window.__extBundleSave = __extBundleSave;
window.__exportBundleZip = __exportBundleZip;
window.__buildExtBundle = __buildExtBundle;
window.__extEnabled = __extEnabled;
window.__extSetEnabled = __extSetEnabled;
    // 扩展启用状态: 官方状态源 extension_settings.disabledExtensions(存完整名); 返回是否开启
function __extEnabled(full) {
    const de = extension_settings.disabledExtensions;
    return !(Array.isArray(de) && (de.includes(full) || de.includes(String(full).split('/').pop())));
}
async function __extSetEnabled(full, on) {
    if (!Array.isArray(extension_settings.disabledExtensions)) extension_settings.disabledExtensions = [];
    const de = extension_settings.disabledExtensions;
    const pure = String(full).split('/').pop();
    const rm = (v) => { const i = de.indexOf(v); if (i >= 0) de.splice(i, 1); };
    if (on) { rm(full); rm(pure); }
    else if (!de.includes(full) && !de.includes(pure)) de.push(full);
    saveSettingsDebounced();
}
    window.__cfgDrivers = {
ext: {
            label: '拓展',
            async listLocal() { return __discoverExts(); },
            async listCloud() {
                const mc = await Gitee.getText(EXT_MANIFEST_PATH);
                if (!mc) return [];
                const man = JSON.parse(mc.content);
                // 云端广播的显示名(本地未装也能显示好名字); 本地已采集的覆盖, 以最新为准
                window.__extDisplayBy = window.__extDisplayBy || {};
                // 云端记录的开关状态(供云端视图只读展示; enabled 缺省=未知→不显示状态)
                window.__extManCache = {};
                for (const k of Object.keys(man)) {
                    const en = man[k] && man[k].enabled;
                    window.__extManCache[k] = (en === undefined || en === null) ? null : !!en;
                    if (man[k] && man[k].dn) window.__extDisplayBy[k] = String(man[k].dn);
                }
                return Object.keys(man).sort();
            },
            displayOf(n) { // 仅显示层换名, 同步键/徽章/指纹全部仍用本名
                const sname = String(n).split('/').pop().split('|').pop();
                return (window.__extDisplayBy && window.__extDisplayBy[sname]) || n;
            },
            statusOf(n, mode) { // 本地=真实开关; 云端=manifest记录(enabled未知→null不显示)
                const sname = String(n).split('/').pop().split('|').pop();
                if (mode === 'cloud') {
                    const en = window.__extManCache ? window.__extManCache[sname] : null;
                    return en === null ? null : { on: !!en };
                }
                return { on: __extEnabled(n) };
            },
            async toggleStatus(n) {
                await __extSetEnabled(n, !__extEnabled(n));
            },
            listLocal() { return __discoverExts(); },
            async push(items) {
                const ok = [], fail = [];

                let __i = 0; const __n = items.length; for (const full of items) { __i++; showBusy(__i, __n, '上传拓展 ' + String(full).split('/').pop() + '…');
                    const sname = String(full).split('/').pop();
                    const skey = __extSettingsKey(sname);
                    try {
                        if (skey && typeof extension_settings[skey] === 'object') {
                            const safe = __extSafeConfig(extension_settings[skey]);
                            await Gitee.putText(`${EXT_CONFIGS_DIR}/${sname}.json`, JSON.stringify(safe), (await Gitee.getText(`${EXT_CONFIGS_DIR}/${sname}.json`))?.sha, `ext config ${sname}`);
                        }
                        ok.push(sname + (skey ? '' : '(无设置配置)'));
                    } catch (e) { fail.push(sname + ':' + (e.message || e)); }

                }
                // manifest 合并恒写(不论上传成否)
                let man = {};
                try { man = JSON.parse((await Gitee.getText(EXT_MANIFEST_PATH))?.content || '{}'); } catch { }
                for (const full of items) {
                    const sname = String(full).split('/').pop();
                    const meta = (window.__extMeta && window.__extMeta[full]) || {};
                    man[sname] = { url: meta.url || '', branch: meta.branch || '', commit: meta.commit || '', config: !!__extSettingsKey(sname), dn: (window.__extDisplayBy && window.__extDisplayBy[sname]) || sname, enabled: __extEnabled(full), type: (window.__extType && window.__extType[full]) || 'local' };
                }
                await Gitee.putText(EXT_MANIFEST_PATH, JSON.stringify(man, null, 2), (await Gitee.getText(EXT_MANIFEST_PATH))?.sha, 'ext manifest');
// url 缺失时附加原因(上传诊断: 让源头一眼看到为什么没记录到仓库地址)
                const urlNotes = {};
                for (const full of items) {
                    const meta = (window.__extMeta && window.__extMeta[full]) || {};
                    if (!meta.url) urlNotes[String(full).split('/').pop()] = meta.err || '本机未记录仓库URL';
                }
                return { ok: ok.length, fail: fail.length, failReasons: fail, urlNotes };
            },
            async pull(items) {
                const ok = [], fail = [], failReasons = [];
                let man = {};
                try { man = JSON.parse((await Gitee.getText(EXT_MANIFEST_PATH))?.content || '{}'); } catch { }
                let __i2 = 0; const __n2 = items.length; for (const full of items) { __i2++; showBusy(__i2, __n2, '导入拓展 ' + String(full).split('/').pop() + '…');
                    const sname = String(full).split('/').pop();
                    try {
                        const entry = man[sname] || {};
                        let installed = false;
                        try {
                            const d = await (await fetch('/api/extensions/discover', { cache: 'no-store' })).json();
                            installed = (Array.isArray(d) ? d : []).some((x) => String(x.name).includes(sname));
                        } catch { }
                        // 本机未装: 先试官方 git 重装(url 失效/删库时兜底安全包)
                        if (!installed) {
                            let rr = null;
                            if (entry.url) {
                                rr = await fetch('/api/extensions/install', {
                                    method: 'POST', headers: getRequestHeaders(),
                                    body: JSON.stringify({ url: entry.url, global: entry.type !== 'local', branch: entry.branch || '' }), // 按云端记录的安装类型装回(全局→全局/用户→用户, 不造成双份)
                                });
                            }
                            if (!entry.url || !rr.ok) {
                                const bundle = await __extBundleLoad(sname);
                                if (bundle && bundle.files) {
                                    await __exportBundleZip(bundle, sname);
                                    fail.push(sname);
                                    failReasons.push({ name: sname, reason: (entry.url ? '重装失败HTTP' + rr.status : '云端无来源URL') + '，已导出安全包zip(解压到 data/extensions/third-party/' + sname + ' 后「刷新本地」再导入)' });
                                } else {
                                    fail.push(sname);
                                    failReasons.push({ name: sname, reason: entry.url ? '重装失败 HTTP ' + rr.status + ' ' + (await rr.text()).slice(0, 60) : '本机未安装且云端无来源URL(无安全包)' });
                                }
                                continue;
                            }
                        }
                        // 写回配置(如云端有)
                        const cfg = await Gitee.getText(`${EXT_CONFIGS_DIR}/${sname}.json`);
                        if (cfg && cfg.content && sname !== 'st_chat_sync') {
                            const safe = JSON.parse(cfg.content);
                            const skey = __extSettingsKey(sname) || sname;
                            extension_settings[skey] = safe;
                            saveSettingsDebounced();
                        }
                        // 以云端记录恢复开关状态(导入不自动启用/禁用; 未知则不干预)
                        if (entry.enabled !== undefined) await __extSetEnabled(full, !!entry.enabled);
                        ok.push(sname);
                    } catch (e) { fail.push(sname); failReasons.push({ name: sname, reason: (e && e.message) || e }); }
                }
                if (ok.length) toastr.info(`导入拓展配置：成功 ${ok.length}${fail.length ? `（失败 ${fail.length}: ${csShortList(failReasons.map(x => x.name + ':' + x.reason))}）` : ''}`);
                return { ok: ok.length, fail: fail.length, failReasons };
            },
            async del(items, mode) {
                const ok = [], fail = [];
                if (mode === 'local') {
                    for (const full of items) {
                        const sname = String(full).split('/').pop();
                        try {
                            const t = (window.__extType && window.__extType[full]) || 'local';
                            const r = await fetch('/api/extensions/delete', {
                                method: 'POST', headers: getRequestHeaders(),
                                body: JSON.stringify({ extensionName: sname, global: t === 'global' }),
                            });
                            if (!r.ok) { fail.push(sname + ': HTTP ' + r.status + ' ' + (await r.text()).slice(0, 60)); continue; }
                            try { if (window.__extType) delete window.__extType[full]; if (window.__extMeta) delete window.__extMeta[full]; } catch { }
                            ok.push(sname);
                        } catch (e) { fail.push(sname + ':' + ((e && e.message) || e)); }
                    }
                    return { ok: ok.length, fail: fail.length, failReasons: fail.map((x) => ({ name: x, reason: '' })) };
                }
                let man = {};
                try { man = JSON.parse((await Gitee.getText(EXT_MANIFEST_PATH))?.content || '{}'); } catch { }
                for (const full of items) {
                    const sname = String(full).split('/').pop();
                    try {
                        const cf = await Gitee.getText(`${EXT_CONFIGS_DIR}/${sname}.json`);
                        if (cf && cf.sha) await Gitee.deleteFile(`${EXT_CONFIGS_DIR}/${sname}.json`, cf.sha, 'del ext config');
                        // 连带删除安全包(本体快照)与云端条目一起清, 不留孤儿
                        const bf = await Gitee.getText(`${EXT_BUNDLES_DIR}/${sname}.json`).catch(() => null);
                        if (bf && bf.sha) await Gitee.deleteFile(`${EXT_BUNDLES_DIR}/${sname}.json`, bf.sha, 'del ext bundle');
                        delete man[sname];
                        ok.push(sname);
                    } catch (e) { fail.push(sname + ':' + (e.message || e)); }
                }
                await Gitee.putText(EXT_MANIFEST_PATH, JSON.stringify(man, null, 2), (await Gitee.getText(EXT_MANIFEST_PATH))?.sha, 'ext manifest');
                return { ok: ok.length, fail: fail.length, failReasons: fail };
            },
            async diffMap() {
                const local = await __discoverExts();
                const map = new Map(local.map((f) => [String(f).split('/').pop(), extension_settings[String(f).split('/').pop()]]));
                const out = new Map();
                const man = (await Gitee.getText(EXT_MANIFEST_PATH).catch(() => null));
                let cloudSet = new Set();
                if (man && man.content) cloudSet = new Set(Object.keys(JSON.parse(man.content)));
                for (const key of cloudSet) {
                    if (!map.has(key)) continue; // 仅云端→存在性徽章即可
                    const skey = __extSettingsKey(key) || key;
                    let localTxt;
                    try { localTxt = JSON.stringify(__extSafeConfig(extension_settings[skey])); } catch { localTxt = null; }
                    if (localTxt === null) continue;
                    const c = await Gitee.getText(`${EXT_CONFIGS_DIR}/${key}.json`).catch(() => null);
                    if (!c) continue;
                    const lb = await gitBlobSha(new TextEncoder().encode(localTxt));
                    const p = `${EXT_CONFIGS_DIR}/${key}.json`;
                    const mem = settings.lastCloudSha && settings.lastCloudSha[p];
                    out.set(key, (lb === c.sha) ? 'same' : ((mem && c.sha !== mem) ? 'cloud' : 'local'));
                    settings.lastCloudSha[p] = c.sha;
                }
                return out;
            },
        },
        thp: {
            label: '酒馆助手',
            async listLocal() { return __thTree().map((n) => (n.type === 'folder' ? '[文件夹]' : '[脚本]') + n.name); },
            async listCloud() {
                const arr = await Gitee.listEntries(TH_SCRIPTS_DIR);
                return arr.filter((e) => e.type === 'file' && e.name.endsWith('.json')).map((e) => e.name.replace(/\.json$/, ''));
            },
            statusOf(it, mode) { // 本地脚本开/关 = 树节点 enabled; 云端无状态记录→null不显示
                if (mode === 'cloud') return null;
                const type = it.startsWith('[文件夹]') ? 'folder' : 'script';
                const name = it.replace(/^\[(脚本|文件夹)\]/, '');
                const node = __thFindNode(name, type);
                return node ? { on: !!node.enabled } : null;
            },
            async toggleStatus(it) {
                const type = it.startsWith('[文件夹]') ? 'folder' : 'script';
                const name = it.replace(/^\[(脚本|文件夹)\]/, '');
                const node = __thFindNode(name, type);
                if (!node) return;
                node.enabled = !node.enabled;
                await __thWriteTree(__thGetTreeRaw());
            },
            async push(items) {
                const ok = [], fail = [];
                let __t = 0; const __tn = items.length; for (const it of items) { __t++; showBusy(__t, __tn, '上传脚本 ' + it.replace(/[^\w一-龥-]/g, '') + '…');
                    // 行值格式: [类型]名字
                    const type = it.startsWith('[文件夹]') ? 'folder' : 'script';
                    const name = it.replace(/^\[(脚本|文件夹)\]/, '');
                    try {
                        const node = __thFindNode(name, type);
                        if (!node) { fail.push(name + ': 本地无此脚本/文件夹'); continue; }
                        const fname = __safeName(name) + '.json';
                        const txt = JSON.stringify(node, null, 2);
                        const prev = await Gitee.getText(`${TH_SCRIPTS_DIR}/${fname}`).catch(() => null);
                        await Gitee.putText(`${TH_SCRIPTS_DIR}/${fname}`, txt, prev && prev.sha ? prev.sha : undefined, `th script ${fname}`);
                        ok.push((type === 'folder' ? '📁' : '📜') + name);
                    } catch (e) { fail.push(name + ':' + ((e && e.message) || e)); }
                }
                if (fail.length) toastr.error('酒馆助手上传失败 ' + fail.length + ' 条：' + csShortList(fail.slice(0, 5)) + (fail.length > 5 ? '…' : ''));
                return { ok: ok.length, fail: fail.length, failReasons: fail };
            },
            async pull(items) {
                const ok = [], fail = [], failReasons = [];
                const replaceMode = !!settings.thReplace;
                let __t2 = 0; const __tn2 = items.length; for (const it of items) { __t2++; showBusy(__t2, __tn2, '导入脚本 ' + it.replace(/[^\w一-龥-]/g, '') + '…');
                    const type = it.startsWith('[文件夹]') ? 'folder' : 'script';
                    const name = it.replace(/^\[(脚本|文件夹)\]/, '');
                    try {
                        const fname = __safeName(name) + '.json';
                        const c = await Gitee.getText(`${TH_SCRIPTS_DIR}/${fname}`);
                        if (!c) { fail.push(name); failReasons.push({ name, reason: '云端无该插件文件' }); continue; }
                        const node = JSON.parse(c.content);
                        // 保留云端脚本原开关状态(用户要求: 导入不改变"它本身的状态"), id 尽量保留(冲突才换新)
                        node.enabled = !!node.enabled;
                        if (node.type === 'folder' && Array.isArray(node.scripts)) node.scripts.forEach((s) => { s.enabled = !!s.enabled; });
                        const freshId = () => (window.__uuidFix ? window.__uuidFix() : ('k' + Math.random().toString(36).slice(2, 10)));
                        if (!node.id || __thGetTreeRaw().some((t) => t.id === node.id)) node.id = freshId();
                        if (replaceMode) {
                            await __thReplaceNode(node.name, node.type, node);
                        } else {
                            const exists = __thFindNode(node.name, node.type);
                            if (exists) { // 同名并存: 换名并给(folder子项)换新id, 状态仍保留
                                node.name = node.name + '(1)';
                                node.id = freshId();
                                if (node.type === 'folder' && Array.isArray(node.scripts)) node.scripts.forEach((s) => { s.id = freshId(); });
                            }
                            const root = __thGetTreeRaw(); // 同名已处理: 内存引用 push 后经官方通道写回(saveSettingsDebounced 在其内)
                            root.push(node); // eslint-disable-line no-undef
                            await __thWriteTree(root);
                        }
                        // 还原结束后刷新列表行状态(重渲染由调用侧执行)
                        ok.push(node.name);
                    } catch (e) { fail.push(name); failReasons.push({ name, reason: (e && e.message) || e }); }
                }
                return { ok: ok.length, fail: fail.length, failReasons };
            },
            async del(items, mode) {
                const ok = [], fail = [];
                for (const it of items) {
                    const type = it.startsWith('[文件夹]') ? 'folder' : 'script';
                    const name = it.replace(/^\[(脚本|文件夹)\]/, '');
                    if (mode === 'cloud') {
                        const fname = __safeName(name) + '.json';
                        const c = await Gitee.getText(`${TH_SCRIPTS_DIR}/${fname}`).catch(() => null);
                        if (c && c.sha) { await Gitee.deleteFile(`${TH_SCRIPTS_DIR}/${fname}`, c.sha, 'del th script'); ok.push(name); }
                        else { fail.push(name + ': 云端无该文件'); }
                    } else {
                        await __thRemoveNode(name, type);
                        ok.push(name);
                    }
                }
                return { ok: ok.length, fail: fail.length, failReasons: fail };
            },
            async diffMap() {
                const local = __thTree();
                const out = new Map();
                const arr = await __cachedListEntries(TH_SCRIPTS_DIR);
                for (const e of arr) {
                    if (e.type !== 'file' || !e.name.endsWith('.json')) continue;
                    const key = e.name.replace(/\.json$/, '');
                    const node = local.find((n) => __safeName(n.name) === key);
                    if (!node) continue; // 仅云端
                    const lb = await gitBlobSha(new TextEncoder().encode(JSON.stringify(node.node)));
                    out.set(key, lb === e.sha ? 'same' : 'local');
                }
                return out;
            },
        },
        conn: {
            label: '预设',
            async listLocal() { return (await _connPresetLocalNames()); },
            async listCloud() { const d=[]; for (const g of CONN_PRESET_GROUPS) { const arr = await Gitee.listEntries(g.cloudDir); for (const e of arr) if (e.type==='file' && e.name.endsWith('.json') && _connPresetVisible(e.name.replace(/\.json$/,''))) d.push(`${g.apiId}|${e.name.replace(/\.json$/,'')}`); } return d; },
            async push(items) { return pushSelectedConnPresets(items.map(parseCfgItem)); },
            async pull(items) { return importSelectedConnPresets(items.map(parseCfgItem)); },
            async del(items, mode) { return deleteSelectedConnPresets(items.map(parseCfgItem), mode); },
            async diffMap() {
                const g = CONN_PRESET_GROUPS[0];
                return __diffMapOf(g.cloudDir, async (key) => {
                    const raw = await _getLocalConnPreset('openai', key);
                    if (!raw) return null;
                    const [preset] = stripPresetSensitiveFields(raw);
                    return JSON.stringify(preset);
                });
            },
        },
        theme: {
            label: '主题',
            async listLocal() { return (await _themeLocalList()).map(t => t.name); },
            async listCloud() { const arr = await Gitee.listEntries(THEME_CLOUD_DIR); return arr.filter(e => e.type==='file' && e.name.endsWith('.json')).map(e => e.name.replace(/\.json$/,'')); },
            async push(items) { return pushSelectedThemes(items); },
            async pull(items) { return importSelectedThemes(items); },
            async del(items, mode) { return deleteSelectedThemes(items, mode); },
            async diffMap() {
                const local = await _themeLocalList();
                const map = new Map(local.map((t) => [t.name, t.data]));
                return __diffMapOf(THEME_CLOUD_DIR, async (key) => {
                    const d = map.get(key);
                    return d === undefined ? null : JSON.stringify(d);
                });
            },
        },
        user: {
            label: '人设',
            async listLocal() {
                const r = await listUserPersonas();
                window.__userPersonaCache = r;
                return r.filter(x => x.where !== 'cloud').map(x => x.file);
            },
            async listCloud() {
                await Gitee.listEntries('config-sync/user/personas'); // 云端目录不通直接抛给上层红字, 不吞
                const r = await listUserPersonas();
                window.__userPersonaCache = r;
                return r.filter(x => x.where !== 'local').map(x => x.file);
            },
            // 富行渲染: 名字 + 主题色字数 + 预览
            rowHtml(file) {
                const r = (window.__userPersonaCache || []).find(x => x.file === file) || {};
                const whereTag = { both: '<b class="cs-cln-where cs-cln-where-both">双端<span class="cs-where-diff" data-where-diff=""></span></b>', local: '<b class="cs-cln-where cs-cln-where-local">仅本地</b>', cloud: '<b class="cs-cln-where cs-cln-where-cloud">仅云端</b>' };
                const nmRaw = r.name || file;
                return `${whereTag[r.where] || ''}<span style="flex:0 0 4.2em;width:4.2em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:.85em" title="${escapeHtml(nmRaw)}">${escapeHtml(nmRaw)}</span>
                    <span style="color:var(--SmartThemeQuoteColor,#f0a35e);font-weight:700;font-size:.82em;flex:none">${r.descLen || 0}字</span>
                    <span style="flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:.78em;opacity:.72">${escapeHtml(r.preview || '（无描述）')}</span>`;
            },
            async push(items) { return uploadUserPersonasToCloud(items); },
            async pull(items) { return downloadUserPersonasFromCloud(items); },
            async diffMap() {
                const dir = 'config-sync/user/personas';
                const arr = await __cachedListEntries(dir);
                const shaMap = new Map(arr.filter((e2) => e2.type === 'file' && e2.name.endsWith('.meta.json')).map((e2) => [e2.name.replace(/\.meta\.json$/, ''), e2.sha]));
                // 本地头像清单(官方接口一次): 仅云端项不参与"谁新"
                const localAv = new Set();
                try { const av = await fetch('/api/avatars/get', { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify({}) }); localAv.replace = 0; if (av.ok) (await av.json()).forEach((f) => localAv.add(f)); } catch { }
                const out = new Map();
                for (const [file, sha] of shaMap) {
                    if (!localAv.has(file)) continue;
                    const nm = (power_user.personas && power_user.personas[file]) || '';
                    const desc = (power_user.persona_descriptions && power_user.persona_descriptions[file] && power_user.persona_descriptions[file].description) || '';
                    const lv = JSON.stringify({ name: nm, description: desc }, null, 2); // 与上传格式一致(缩进2)
                    const lb = await gitBlobSha(new TextEncoder().encode(lv));
                    const p = `${dir}/${file}.meta.json`;
                    const mem = settings.lastCloudSha && settings.lastCloudSha[p];
                    out.set(file, lb === sha ? 'same' : ((mem && sha !== mem) ? 'cloud' : 'local'));
                }
                return out;
            },
            async del(items, mode) {
                if (mode === 'local') return deleteSelectedUserPersonas(items.map(x => x.value || x));
                // 云删: 逐个 Gitee.deleteFile
                for (const item of items) {
                    const f = item;
                    const c = await Gitee.getText(`config-sync/user/personas/${f}`);
                    if (c) await Gitee.deleteFile(`config-sync/user/personas/${f}`, c.sha, `delete persona ${f}`);
                }
            },
        },
        regex: {
            label: '全局正则',
            async listLocal() { return (await _regexLocalList()).map(r => r.name); },
            async listCloud() { const arr = await Gitee.listEntries(REGEX_CLOUD_DIR); return arr.filter(e => e.type==='file' && e.name.endsWith('.json')).map(e => e.name.replace(/\.json$/,'')); },
            async push(items) { return pushSelectedRegex(items); },
            async pull(items) { return importSelectedRegex(items); },
            async del(items, mode) { return deleteSelectedRegex(items, mode); },
            async diffMap() {
                const local = await _regexLocalList();
                const map = new Map(local.map((r2) => [r2.name, r2.data]));
                return __diffMapOf(REGEX_CLOUD_DIR, async (key) => {
                    const d = map.get(key);
                    return d === undefined ? null : JSON.stringify(d);
                });
            },
        },

    };
    function parseCfgItem(v) { const s = String(v); const i = s.indexOf('|'); if (i > 0 && CONN_PRESET_GROUPS.some((g) => g.apiId === s.slice(0, i))) return { apiId: s.slice(0, i), name: s.slice(i + 1) }; return { apiId: 'openai', name: s }; }
    window.__cfgRenderGen = 0;
    window.__renderCfgList = async function (mode) {
        mode = mode || window.__cfgMode;
        window.__cfgMode = mode;
        const list = $('cs_cfg_list'); const tgt = $('cs_cfg_target'); const st2 = $('cs_cfg2_status');
        if (!list) return;
        // 切分项时提示"正在切换至XX分页"(渲染完成后被列表内容覆盖)
        const TAB_NAMES = { conn: '预设', theme: '主题', regex: '全局正则', user: 'User人设', ext: '拓展', thp: '酒馆助手' };
        if (st2) { st2.textContent = '正在切换至「' + (TAB_NAMES[window.__cfgTab] || window.__cfgTab) + '」分页…'; st2.style.color = ''; }
        const __csTabSwitchedAt = Date.now();
        const tab = window.__cfgTab;
        const drv = window.__cfgDrivers[tab];
        __updateCfgViewBtns();
        const prevChecked = new Set([...document.querySelectorAll('input[name="cs_cfg_sel"]:checked')].map((c) => c.value));
        // ⚠️ 竞态防护: 快速切tab/切视图时, 旧请求返回不应覆盖新渲染
        // ⚠️ 竞态: whereSets 的 listLocal/listCloud 是异步的, renderId 必须先于它生效——否则快速切换时
        //    旧集合会被渲染到新列表上("点了预设没出双端, 再点一次就好了")
        const renderId = ++window.__cfgRenderGen;
        const whereSets = { localSet: new Set(), cloudSet: new Set() };
        try {
            if (tab !== 'user') {
                const _nm = (v) => __stripApiId(String(v).replace(/^third-party\//, '')).toLowerCase();
                let lc = null, cc = null;
                try { lc = await drv.listLocal(); } catch { }
                try { cc = await drv.listCloud(); } catch { }
                if (lc) lc.forEach((n) => whereSets.localSet.add(_nm(n)));
                if (cc) cc.forEach((n) => whereSets.cloudSet.add(_nm(n)));
                if (lc && cc) { // 双边都成功才更新缓存
                    window.__cfgWhereCache = window.__cfgWhereCache || {};
                    window.__cfgWhereCache[tab] = { local: [...whereSets.localSet], cloud: [...whereSets.cloudSet] };
                } else {
                    const c = window.__cfgWhereCache && window.__cfgWhereCache[tab];
                    if (c) { if (!lc) c.local.forEach((x) => whereSets.localSet.add(x)); if (!cc) c.cloud.forEach((x) => whereSets.cloudSet.add(x)); }
                }
            }
        } catch { }
        // 存在性徽章: 本地视图=双端/仅本地; 云端视图=(用户方案)【仅预设 conn】不显示 双端/仅云端 字样、双端项显示框内差异;
        //   主题/正则的云端视图照常显示 双端/仅云端 徽章(差异在框内), 与本地视图一致。
        // 统一名规范化(集合与行值都走同一规则, 否则第三分项带 third-party/ 前缀永不匹配)
        const _nm2 = (v) => __stripApiId(String(v).replace(/^third-party\//, '')).toLowerCase();
        const __whereOf = (n) => {
            if (tab === 'user') return '';
            const nn = _nm2(n);
            if (mode === 'cloud') {
                if (tab === 'conn') {
                    if (!whereSets.localSet.has(nn)) return '<b class="cs-cln-where cs-cln-where-cloud">仅云端</b>'; // 预设·仅云端: 也有徽章(与双端/差异一样整齐)
                    return '<b class="cs-cln-where cs-cln-where-both">双端<span class="cs-where-diff" data-where-diff=""></span></b>'; // 预设·双端: 一致显示双端, 有差异时由差异词替换(不出现空框绿线)
                }
                return whereSets.localSet.has(nn) ? '<b class="cs-cln-where cs-cln-where-both">双端<span class="cs-where-diff" data-where-diff=""></span></b>' : '<b class="cs-cln-where cs-cln-where-cloud">仅云端</b>';
            }
            return whereSets.cloudSet.has(nn) ? '<b class="cs-cln-where cs-cln-where-both">双端<span class="cs-where-diff" data-where-diff=""></span></b>' : '<b class="cs-cln-where cs-cln-where-local">仅本地</b>';
        };
        // 开/关状态芯片: 本地=可点按钮, 云端=只读(数据为云端记录)
        function __cfgTypeTag(drv, n) { // 拓展行显示安装类型(全局/用户), 来自 discover 的 type
        try {
            if (drv !== window.__cfgDrivers.ext) return '';
            const t = (window.__extType && window.__extType[String(n)]) || '';
            if (!t) return '';
            return `<b class="cs-cln-en" style="cursor:default;opacity:.8" title="安装类型(为所有人=全局 / 仅为用户)">${t === 'global' ? '全局' : '用户'}</b>`;
        } catch { return ''; }
    }
    const __cfgUpdTag = (drv, n, mode) => { // 拓展行"⬆更新"按钮: version.isUpToDate=false 时显示
        try {
            if (drv !== window.__cfgDrivers.ext || mode !== 'local') return '';
            const meta = (window.__extMeta && window.__extMeta[String(n)]) || {};
            if (meta.upToDate !== false) return '';
            return `<button type="button" class="cs-btn cs-upd-row" data-upd-n="${escapeHtml(n)}" style="padding:1px 8px;font-size:.72em;flex:none" title="检测到远端有新版本, 点击更新(多个可一起点, 最后刷新页面生效)" style="padding:0 6px;color:#6fce6f;border-color:rgba(111,206,111,.55)">New</button>`;
        } catch { return ''; }
    };
    function __cfgStatusChip(drv, n, mode) {
            if (typeof drv.statusOf !== 'function') return '';
            let st;
            try { st = drv.statusOf(n, mode); } catch { return ''; }
            if (!st) return '';
            const txt = st.on ? '开' : '关';
            if (mode === 'cloud') return `<b class="cs-cln-en" style="cursor:default" data-on="${st.on ? '1' : '0'}" title="云端记录的状态">${txt}</b>`;
            return `<button type="button" class="cs-cln-en" data-en-n="${escapeHtml(n)}" data-on="${st.on ? '1' : '0'}" title="点击切换开/关">${txt}</button>`;
        };
        if (renderId !== window.__cfgRenderGen) return; // whereSets 过期(期间有新请求) → 丢弃, 等最新渲染
        if (mode === 'cloud') {
            showBusy(0, 0, '正在获取云端列表…');
            list.innerHTML = '<p class="cs-hint">⏳ 正在获取云端列表…（云端响应慢时请稍候，最多约 45 秒）</p>';
        }
        let names = [];
        try { names = mode === 'cloud' ? await drv.listCloud() : await drv.listLocal(); }
        catch (e) {
            const why = (e && e.message) || e;
            if (st2) { st2.textContent = '读取失败：' + why; st2.style.color = '#e66'; }
            list.innerHTML = `<p class="cs-hint" style="color:#e66">⚠ 读取云端失败：${escapeHtml(why)}<br>请点设置里的「连接测试」自查（网络/仓库/token）</p>`;
            hideBusy(); return;
        }
        hideBusy();
        if (st2 && st2.textContent.startsWith('正在切换至')) { st2.textContent = ''; }
        if (st2) st2.style.color = '';
        if (renderId !== window.__cfgRenderGen) return; // 已被更新的请求取代, 丢弃本次结果
        if (tgt) tgt.textContent = mode === 'cloud' ? '当前为云端视图，将导入云端选中' : '当前为本地视图，将上传本地选中';
        list.innerHTML = names.length
            ? names.map((n) => `<label class="cs-role-item" data-id="${escapeHtml(n)}"><input type="checkbox" value="${escapeHtml(n)}" name="cs_cfg_sel" ${prevChecked.has(n) ? 'checked' : ''}>${drv.rowHtml ? drv.rowHtml(n) : `${__whereOf(n)}${__cfgStatusChip(drv, n, mode)}${__cfgTypeTag(drv, n)}${__cfgUpdTag(drv, n, mode)}<span>${escapeHtml(drv.displayOf ? drv.displayOf(n) : (drv.label === '预设' ? __stripApiId(n) : n))}</span>`}</label>`).join('')
            : `<p class="cs-hint">${mode === 'cloud' ? '✅ 云端确实没有' + drv.label + '（不是获取失败）——切「本地' + drv.label + '」勾选后点「📤 上传选中」即可传上去' : '（无本地' + drv.label + '）'}</p>`;
        __applyCfgFilter(); // 应用当前筛选(徽章已就位)
        __fillDiffBadges(); // 异步补差异徽章(存在性先行, 内容位渐进显示, 不阻塞列表)
    };
    // 分类切换
    // 分项视图按钮文案跟随 tab(用户要求: 本地预设/云端预设、本地主题/云端主题、本地正则/云端正则; User 栏隐藏)
    function __updateCfgViewBtns() {
        const map = { conn: ['本地预设', '云端预设'], theme: ['本地主题', '云端主题'], regex: ['本地正则', '云端正则'], user: ['本地人设', '云端人设'], ext: ['本地拓展', '云端拓展'], thp: ['本地酒馆助手', '云端酒馆助手'] };
        const t = window.__cfgTab;
        const l = document.getElementById('cs_cfg_local'), c = document.getElementById('cs_cfg_cloud');
        if (!l || !c) return;

        l.style.display = ''; c.style.display = '';
        const labels = map[t] || ['本地配置', '云端配置'];
        l.innerHTML = '<i class="fa-solid fa-rotate" aria-hidden="true"></i> ' + labels[0];
        c.innerHTML = '<i class="fa-solid fa-rotate" aria-hidden="true"></i> ' + labels[1];
        // user tab: 显示 一键备份/恢复全部(灾难恢复整包); 其余 tab 隐藏
        const brn = document.getElementById('cs_cfg_user_br'), rrn = document.getElementById('cs_cfg_user_rr');
        const ua = document.getElementById('cs_cfg_updall');
        if (ua) ua.style.display = t === 'ext' ? '' : 'none';
        if (brn) brn.style.display = t === 'user' ? '' : 'none';
        if (rrn) rrn.style.display = t === 'user' ? '' : 'none';

    }
    window.__updateCfgViewBtns = __updateCfgViewBtns;
    document.querySelectorAll('#chat_sync_settings .cs-tab').forEach((b) => {
        b.addEventListener('click', () => { window.__cfgTab = b.getAttribute('data-cfgtab'); window.__renderCfgList(window.__cfgMode); __updateCfgViewBtns(); });
    });
    __updateCfgViewBtns();
    if (__sentinel) __sentinel.dataset.csWired = '1'; // 本轮 DOM 绑定完成
    window.__csWireNow = () => { const r2 = $('chat_sync_settings'); wirePanelEvents(); if (r2) r2.dataset.wired = r2.dataset.wired || '1'; };
    $('cs_cfg_local')?.addEventListener('click', () => window.__renderCfgList('local'));
    $('cs_cfg_cloud')?.addEventListener('click', () => window.__renderCfgList('cloud'));
    $('cs_cfg_selall')?.addEventListener('click', () => document.querySelectorAll('input[name="cs_cfg_sel"]').forEach((c) => { if (c.closest('label') && c.closest('label').style.display === 'none') return; c.checked = true; })); // 筛选隐藏的不勾
    $('cs_cfg_clr')?.addEventListener('click', () => document.querySelectorAll('input[name="cs_cfg_sel"]').forEach((c) => { c.checked = false; }));
    // User tab: 点行(非勾选框) → 人设描述预览弹窗
    $('cs_cfg_list')?.addEventListener('click', async (e) => {
        if (window.__cfgTab !== 'user') return;
        if (e.target instanceof HTMLInputElement) return;
        const row = e.target.closest('.cs-role-item');
        if (!row) return;
        e.preventDefault(); // 阻止 label→checkbox 默认翻转(user 点行=看预览, 不是勾选; 其它 tab 不受影响)
        const file = row.querySelector('input[type="checkbox"]')?.value;
        const r = (window.__userPersonaCache || []).find(x => x.file === file);
        if (!r) return;
        let desc = (power_user.persona_descriptions && power_user.persona_descriptions[file] && power_user.persona_descriptions[file].description) || '';
        // 仅云端: 从云端 meta 取描述
        if (!desc) {
            try {
                const mc = await Gitee.getText(`config-sync/user/personas/${file}.meta.json`);
                if (mc && mc.content) desc = JSON.parse(mc.content).description || '';
            } catch { }
        }
        desc = previewAfterContent(desc);
        // 连点另一行人设时先移除旧弹窗(防叠层)
        const oldM = document.getElementById('cs_user_modal'); if (oldM) { __csCloseMask(oldM); __csUnlockBgScroll(); }
        const m = __csOpenMask(); m.id = 'cs_user_modal';
        // ⚠️ 挂 body(同 cs_cln_modal): 掩码 absolute+视口坐标校正(html 缩放时 fixed 退化); stopPropagation 防关面板
        m.innerHTML = `<div style="position:relative;width:min(640px,92vw);max-height:calc(100vh - 24px);max-height:calc(100dvh - 24px);display:flex;flex-direction:column;background:var(--SmartThemeBlurTintColor,#1b1b1b);border:1px solid var(--SmartThemeBorderColor,#333);border-radius:12px;padding:14px;overflow:hidden;box-shadow:0 8px 32px rgba(0,0,0,.5)">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;padding-bottom:8px;border-bottom:1px solid var(--SmartThemeBorderColor,#333)">
                <b style="font-size:.95em">${escapeHtml(r.name || file)} <small style="opacity:.6;font-weight:400">（人设预览）</small></b>
                <button id="__qa_pclose" style="padding:3px 14px;border-radius:8px;border:1px solid var(--SmartThemeBorderColor,#555);background:rgba(255,255,255,0.06);color:var(--SmartThemeBodyColor,#eee);cursor:pointer;font-size:.9em">✕ 关闭</button>
            </div>
            <div id="__qa_pbody" style="flex:1;min-height:0;overflow:auto;overscroll-behavior:contain;-webkit-overflow-scrolling:touch;white-space:pre-wrap;word-break:break-word;font-size:.88em;line-height:1.7;color:var(--SmartThemeBodyColor,#e1e1e1)">${__fmtPrevText(desc.slice(0, 8000)) || '（该人设暂无描述内容）'}</div>
            <button class="cs-top-fab" id="__qa_top" type="button">↑ 回顶部</button>
        </div>`;
        // 挂 body + 掩码管理/防关面板已由 __csOpenMask 完成
        __csLockBgScroll();
        const pbody = m.querySelector('#__qa_pbody');
        if (pbody) {
            pbody.scrollTop = 0;
            requestAnimationFrame(() => { pbody.scrollTop = 0; });
            pbody.addEventListener('scroll', () => {
                const fb = m.querySelector('#__qa_top');
                if (fb) fb.style.display = pbody.scrollTop > 300 ? 'block' : 'none';
            }, { passive: true });
        }
        m.querySelector('#__qa_top')?.addEventListener('click', () => pbody && pbody.scrollTo({ top: 0, behavior: 'smooth' }));
        const closeUserPop = () => { __csCloseMask(m); __csUnlockBgScroll(); };
        m.addEventListener('click', (ev) => { ev.stopPropagation(); if (ev.target === m) closeUserPop(); });
        document.getElementById('__qa_pclose').addEventListener('click', closeUserPop);
    });
    // 开/关状态按钮委托(本地列表行内): 阻止冒泡防勾选/防关面板, 翻状态后整表重渲染
    $('cs_cfg_list')?.addEventListener('click', async (ev) => {
        const btn = ev.target && ev.target.closest ? ev.target.closest('.cs-cln-en') : null;
        if (!btn) return;
        if (btn.dataset && btn.dataset.enN === undefined) return; // 云端只读徽章
        ev.preventDefault();
        ev.stopPropagation();
        const n = btn.dataset.enN;
        const drv = window.__cfgDrivers[window.__cfgTab];
        if (!drv || typeof drv.toggleStatus !== 'function') return;
        btn.disabled = true;
        try { await drv.toggleStatus(n); } catch (e) { console.warn('[chat-sync] 开关切换失败', e); }
        try { window.__renderCfgList(window.__cfgMode); } catch (e2) { console.warn(e2); }
    });
    // 筛选: 按行内徽章文本过滤(与显示一致, 不重算); 差异徽章异步填充后需重放
    window.__cfgFilter = '全部';
    function __applyRowFilter(targetId, kind) {
        try {
            const host = document.getElementById(targetId);
            if (!host) return;
            const rows = [...host.querySelectorAll('label.cs-role-item')];
            for (const r of rows) {
                if (kind === '全部') { r.style.display = ''; continue; }
                const wEl = r.querySelector('.cs-cln-where');
                const dEl = r.querySelector('.cs-where-diff');
                const w = wEl ? wEl.textContent.trim().split('·')[0] : '';
                const d = dEl ? dEl.textContent.trim() : '';
                const hit = (kind === '双端' && w === '双端') || (kind === '仅本地' && w === '仅本地') || (kind === '仅云端' && w === '仅云端') || (kind === '本地新' && d === '本地新') || (kind === '云端新' && d === '云端新');
                r.style.display = hit ? '' : 'none';
            }
        } catch { }
    }
    function __applyCfgFilter() { __applyRowFilter('cs_cfg_list', window.__cfgFilter || '全部'); }
    window.__applyCfgFilter = __applyCfgFilter;
// 连接槽位: 保存自动去重入库 / 下拉秒切 / 删除
    function __csUpsertSlot(platform, repo, token) {
        try {
            if (!repo) return;
            const arr = (settings.connSlots = Array.isArray(settings.connSlots) ? settings.connSlots : []);
            const same = arr.find((x) => x.platform === platform && x.repo === repo);
            if (same) { same.token = token; same.lastConnectAt = settings.lastConnectAt || same.lastConnectAt; }
            else arr.push({ platform, repo, token, lastConnectAt: settings.lastConnectAt || 0 });
            saveSettingsDebounced();
        } catch { }
    }
    window.__csApplySlot = async function (idx) {
        try {
            const arr = (settings.connSlots = Array.isArray(settings.connSlots) ? settings.connSlots : []);
            const sl = arr[idx];
            if (!sl) return;
            const [o, r] = String(sl.repo || '').split('/');
            settings.server = sl.platform || ''; settings.owner = o || ''; settings.repo = r || ''; settings.token = sl.token || '';
            settings.lastConnectAt = Date.now();
            saveSettingsDebounced();
            const sel = document.getElementById('cs_platform'); if (sel) sel.value = settings.server;
            const ri = document.getElementById('cs_repoinput'); if (ri) ri.value = settings.owner + '/' + settings.repo;
            const ti = document.getElementById('cs_token'); if (ti) ti.value = settings.token;
            __refreshCurRepoLine();
            autoConnectIfConfigured();
            toastr.success('已切换仓库：' + sl.repo);
        } catch (e) { toastr.error('切换槽位失败：' + ((e && e.message) || e)); }
    };
    window.__csDeleteSlot = async function (idx) {
        try {
            const arr = (settings.connSlots = Array.isArray(settings.connSlots) ? settings.connSlots : []);
            if (!arr[idx]) return;
            const ok = await csConfirm('删除槽位', `删除连接槽位 <b>${escapeHtml(arr[idx].repo)}</b>?（不影响当前已保存配置）`);
            if (!ok) return;
            arr.splice(idx, 1);
            saveSettingsDebounced();
            __refreshCurRepoLine();
        } catch { }
    };
// 上传诊断: URL缺失原因(供源头设备定位为何新设备无法重装)
    function urlNotesTxt(r2) {
        try {
            const un = (r2 && r2.urlNotes) || {};
            const ks = Object.keys(un);
            if (!ks.length) return '';
            const first = ks.slice(0, 3).map(k => k + ':' + un[k]).join('、');
            return `｜⚠ 无仓库URL ${ks.length}个（${first}${ks.length > 3 ? '…' : ''}）`;
        } catch { return ''; }
    }
    $('cs_cfg_push')?.addEventListener('click', async () => {
        const sel = [...document.querySelectorAll('input[name="cs_cfg_sel"]:checked')].map((c) => c.value);
        const st2 = $('cs_cfg2_status');
        if (!sel.length) { if (st2) st2.textContent = '请先勾选要上传的项'; return; }
        if (window.__cfgMode !== 'local') {
            if (st2) { st2.textContent = '当前是云端视图——「上传选中」上传的是本机内容，请切到「本地」视图再点'; st2.style.color = '#e66'; setTimeout(() => { if (st2.textContent.startsWith('当前是云端视图')) { st2.textContent = ''; st2.style.color = ''; } }, 4000); }
            return;
        }
        if (st2) st2.style.color = '';
        if (st2) st2.textContent = '上传中…';
        showBusy(0, 0, '📤 上传' + (window.__cfgDrivers[window.__cfgTab].label || '') + '中…');
        try {
            const r = await window.__cfgDrivers[window.__cfgTab].push(sel);
            hideBusy();
            if (!(r && typeof r.ok === 'number')) { if (st2) { st2.textContent = '❌ 上传出错：没有返回结果'; st2.style.color = '#e66'; } return; }
            try { await window.__renderCfgList(window.__cfgMode); } catch { } // 先刷新(刷新会清状态行), 再写完成文案
            if (st2) { st2.textContent = `上传完成：成功 ${r.ok}${r.fail ? `，失败 ${r.fail}` : ''}${urlNotesTxt(r)}`; st2.style.color = r.fail ? '#e66' : ''; }
        } catch (e) {
            hideBusy();
            if (st2) { st2.textContent = '❌ 上传异常：' + ((e && e.message) || e); st2.style.color = '#e66'; }
            console.warn('[chat-sync] 上传异常', e);
        }
    });
    $('cs_cfg_pull')?.addEventListener('click', async () => {
        const sel = [...document.querySelectorAll('input[name="cs_cfg_sel"]:checked')].map((c) => c.value);
        const st2 = $('cs_cfg2_status');
        if (!sel.length) { if (st2) st2.textContent = '请先勾选要导入的项'; return; }
        if (window.__cfgMode !== 'cloud') {
            if (st2) { st2.textContent = '当前是本地视图——「导入选中」导入的是云端内容，请切到「云端」视图再点'; st2.style.color = '#e66'; setTimeout(() => { if (st2.textContent.startsWith('当前是本地视图')) { st2.textContent = ''; st2.style.color = ''; } }, 4000); }
            return;
        }
        if (st2) st2.style.color = '';
        if (st2) st2.textContent = '导入中…';
        showBusy(0, 0, '📥 导入' + (window.__cfgDrivers[window.__cfgTab].label || '') + '中…');
        try {
            const r = await window.__cfgDrivers[window.__cfgTab].pull(sel);
            hideBusy();
            if (!(r && typeof r.ok === 'number')) { if (st2) { st2.textContent = '❌ 导入出错：没有返回结果'; st2.style.color = '#e66'; } return; }
            try { await window.__renderCfgList(window.__cfgMode); } catch { }
            if (st2) { st2.textContent = `导入完成：成功 ${r.ok}${r.fail ? `，失败 ${r.fail}` : ''}${r.failReasons && r.failReasons.length ? '（' + csShortList(r.failReasons.map(x => x.reason)) + '）' : ''}`; st2.style.color = r.fail ? '#e66' : ''; }
        } catch (e) {
            hideBusy();
            if (st2) { st2.textContent = '❌ 导入异常：' + ((e && e.message) || e); st2.style.color = '#e66'; }
            console.warn('[chat-sync] 导入异常', e);
        }
    });
    // 筛选 chips 点击(document委托, 面板重渲染不失效)
    document.addEventListener('click', (ev) => {
        const ub = ev.target && ev.target.closest ? ev.target.closest('.cs-upd-row') : null;
        if (ub) {
            ev.preventDefault(); ev.stopPropagation();
            const full = ub.dataset.updN;
            showBusy(0, 0, '更新扩展 ' + String(full).split('/').pop() + '…');
            const pure2 = String(full).split('/').pop();
            const gFirst2 = (window.__extType && window.__extType[full]) === 'global';
            const combos2 = gFirst2
                ? [{ n: full, g: true }, { n: full, g: false }, { n: pure2, g: true }, { n: pure2, g: false }]
                : [{ n: full, g: false }, { n: pure2, g: false }, { n: full, g: true }, { n: pure2, g: true }];
            const tryUpd = async (c) => {
                const r2 = await fetch('/api/extensions/update', { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify({ extensionName: c.n, global: c.g }) });
                if (r2.status === 404) return null;
                const j2 = await r2.json().catch(() => ({}));
                return { ok: r2.ok, j: j2 };
            };
            (async () => {
                let lastErr = '';
                for (const c of combos2) {
                    try {
                        const res = await tryUpd(c);
                        if (!res) { lastErr = '404'; continue; }
                        hideBusy();
                        if (!res.ok) { toastr.error('更新失败 HTTP ' + lastErr); return; }
                        ub.textContent = '✓';
                        ub.style.color = '#6fce6f';
                        toastr.success('✅ 扩展已更新——可继续点其它 New, 全部完成后刷新一次页面生效');
                        return;
                    } catch (e3) { lastErr = String(e3).slice(0, 80); }
                }
                hideBusy();
                toastr.error('更新失败：本插件目录缺少 git 更新元数据——请在扩展管理删除后用 URL 重装一次(' + lastErr + ')');
            })();
        }
        const b = ev.target && ev.target.closest ? ev.target.closest('.cs-flt') : null;
        if (!b) return;
        const tgt = b.dataset.target || 'cs_cfg_list';
        const grp = b.closest('span') || b.parentElement;
        if (grp) grp.querySelectorAll('.cs-flt').forEach((x) => { const on = x.dataset.flt === b.dataset.flt; x.style.opacity = on ? '1' : '.55'; x.style.fontWeight = on ? '700' : '400'; });
        if (tgt === 'cs_cfg_list') window.__cfgFilter = b.dataset.flt || '全部';
        window['__rowFilter_' + tgt] = b.dataset.flt || '全部';
        __applyRowFilter(tgt, b.dataset.flt || '全部');
    });
    // 启动自动更新勾选: 元素由 __refreshCurRepoLine 动态创建(晚于直接绑定) → 用 document 委托, 永不失绑
    document.addEventListener('change', (e) => {
        if (e.target && e.target.id === 'cs_auto_upd') {
            settings.autoUpdate = e.target.checked;
            saveSettingsDebounced();
            try { if (typeof saveSettings === 'function') saveSettings().catch(() => { }); } catch { }
        }
    });
    $('cs_cfg_updall')?.addEventListener('click', async () => {
        const sel = [...document.querySelectorAll('input[name="cs_cfg_sel"]:checked')].map((c) => c.value);
        const st2 = $('cs_cfg2_status');
        if (!sel.length) { if (st2) st2.textContent = '请先勾选要更新的拓展'; return; }
        let okN = 0, failN = 0;
        for (let i = 0; i < sel.length; i++) {
            const full = sel[i];
            const pure = String(full).split('/').pop();
            showBusy(i + 1, sel.length, '更新拓展 ' + pure + '…');
            try {
                const gF = (window.__extType && window.__extType[full]) === 'global';
                const combos = [{ n: full, g: gF }, { n: full, g: !gF }, { n: pure, g: gF }, { n: pure, g: !gF }];
                let done = false;
                for (const c of combos) {
                    const r = await fetch('/api/extensions/update', { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify({ extensionName: c.n, global: c.g }) });
                    if (r.status === 404) continue;
                    if (r.ok) { okN++; } else { failN++; }
                    done = true;
                    break;
                }
                if (!done) failN++;
            } catch { failN++; }
        }
        hideBusy();
        if (st2) st2.textContent = `更新完成：成功 ${okN} / 共 ${sel.length}${failN ? `，失败 ${failN}` : ''}——刷新页面后生效`;
        toastr.success(`⬆ 拓展更新完成(成功 ${okN}/${sel.length})——刷新一次页面全部生效`);
    });
    $('cs_cfg_del')?.addEventListener('click', async () => {
        const st2 = $('cs_cfg2_status');
        const mode = window.__cfgMode || 'local';
        const sel = [...document.querySelectorAll('input[name="cs_cfg_sel"]:checked')].map((c) => c.value);
        if (!sel.length) { if (st2) st2.textContent = '请先在上方勾选要删除的项'; return; }
        let ok;
        const disp = (v) => escapeHtml(__stripApiId(v)); // 显示剥掉 apiId| 前缀(仅已知apiId)
        if (mode === 'cloud') ok = await csConfirm('⚠ 永久删除云端配置项', `将永久删除云端配置项：<b>${sel.map(disp).join('、')}</b>。<br>删除后无法直接找回，确定删除「${sel.length}」个吗？`);
        else ok = await csConfirm('⚠ 删除本地配置项', `将删除本地配置项：<b>${sel.map(disp).join('、')}</b>。<br>确定删除「${sel.length}」个吗？`);
        if (!ok) { if (st2) st2.textContent = '已取消'; return; }
        if (st2) st2.textContent = '删除中…';
        const r = await window.__cfgDrivers[window.__cfgTab].del(sel, mode);
        try { await window.__renderCfgList(window.__cfgMode); } catch { } // 先刷新
        if (st2) st2.textContent = `删除完成：成功 ${r ? r.ok : 0} / 共 ${sel.length}${r && r.fail ? `，失败 ${r.fail}` : ''}`;
        // 精确失效(不整清缓存): 云端删→目录剔除被删文件; 本地删→只清差异缓存
        const DIR_BY_TAB = { conn: () => CONN_PRESET_GROUPS[0].cloudDir, theme: () => THEME_CLOUD_DIR, regex: () => REGEX_CLOUD_DIR, user: () => 'config-sync/user/personas' };
        try {
            const t2 = window.__cfgTab || '';
            const dir = DIR_BY_TAB[t2] && DIR_BY_TAB[t2]();
            if (mode === 'cloud' && dir) {
                __evictDirCacheItems(dir, sel, t2);
                for (const it of sel) {
                    const pure = __stripApiId(it);
                    delete __diffCache[`${dir}/${t2 === 'user' ? pure + '.meta.json' : pure + '.json'}`];
                }
            } else {
                for (const k of Object.keys(__diffCache)) delete __diffCache[k];
            }
        } catch { }
        window.__renderCfgList(mode === 'cloud' ? 'cloud' : 'local');
    });
    // ── 共享: 分项列表拖拽划选(<4px 原生翻转 / ≥4px 拖拽+one-shot拦截, 防双击双翻) ──
    function __bindCfgDragSelect(box2, chkName) {
        if (!box2 || box2.getAttribute('data-csdragbound')) return;
        box2.setAttribute('data-csdragbound', '1');
        let dragging = false, dragMoved = false, startX = 0, startY = 0;
        const toggled = new Set();
        box2.addEventListener('mousedown', (e) => { if (e.button !== 0) return; dragging = true; dragMoved = false; startX = e.clientX; startY = e.clientY; toggled.clear(); });
        box2.addEventListener('mousemove', (e) => {
            if (!dragging) return;
            if (!dragMoved) { if (Math.abs(e.clientX - startX) < 4 && Math.abs(e.clientY - startY) < 4) return; dragMoved = true; }
            const el = document.elementFromPoint(e.clientX, e.clientY);
            const row = el && el.closest('label,.cs-cln-row');
            const cb = row && row.querySelector('input[type="checkbox"]');
            if (cb && !toggled.has(cb)) { toggled.add(cb); cb.checked = !cb.checked; }
        });
        window.addEventListener('mouseup', () => {
            if (dragging && dragMoved) {
                const swallow = (ev) => { ev.stopPropagation(); ev.preventDefault(); };
                box2.querySelectorAll('input[name="' + chkName + '"]').forEach((cb) => { if (toggled.has(cb)) cb.addEventListener('click', swallow, { once: true, capture: true }); });
            }
            dragging = false; dragMoved = false;
        });
    }
    // 应用: 分项列表(预设/主题/正则共用) + User人设列表
    __bindCfgDragSelect(document.getElementById('cs_cfg_list'), 'cs_cfg_sel');

    $('cs_cfg_user_br')?.addEventListener('click', async () => { const st2 = $('cs_cfg2_status'); if (st2) st2.textContent = '备份中…'; const r = await backupUserToCloud(); if (st2) st2.textContent = r ? '' : '备份失败'; });
    $('cs_cfg_user_rr')?.addEventListener('click', async () => {
        const st2 = $('cs_cfg2_status');
        const ok = await csConfirm('⚠ 恢复 User', '确定用云端 User 备份覆盖当前用户资料吗？');
        if (!ok) return;
        if (st2) st2.textContent = '恢复中…'; const r = await restoreUserFromCloud(); if (st2) st2.textContent = r ? '恢复完成(刷新生效)' : '恢复失败';
    });
    // 分项列表 拖拽划选（同角色/世界书实现, 防双击双翻）
    (function bindCfgDragSelect() {
        const list = $('cs_cfg_list');
        if (!list || list.getAttribute('data-cfgdragbound')) return;
        list.setAttribute('data-cfgdragbound', '1');
        let dragging = false, dragMoved = false, startX = 0, startY = 0;
        const toggled = new Set();
        list.addEventListener('mousedown', (e) => { if (e.button !== 0) return; dragging = true; dragMoved = false; startX = e.clientX; startY = e.clientY; toggled.clear(); });
        list.addEventListener('mousemove', (e) => {
            if (!dragging) return;
            if (!dragMoved) { if (Math.abs(e.clientX - startX) < 4 && Math.abs(e.clientY - startY) < 4) return; dragMoved = true; }
            const el = document.elementFromPoint(e.clientX, e.clientY);
            const label = el && el.closest('.cs-cln-row');
            if (label) { const cb = label.querySelector('input[type="checkbox"]'); if (cb && !toggled.has(cb)) { toggled.add(cb); cb.checked = !cb.checked; } }
        });
        window.addEventListener('mouseup', () => {
            const wasDrag = dragging && dragMoved;
            dragging = false;
            if (!wasDrag) { toggled.clear(); return; }
            document.addEventListener('click', function oneShot(ev) {
                const cb2 = ev.target.closest && ev.target.closest('label') ? ev.target.closest('label').querySelector('input[type="checkbox"]') : null;
                if (cb2 && toggled.has(cb2)) { ev.preventDefault(); ev.stopPropagation(); toggled.delete(cb2); }
                if (!toggled.size) document.removeEventListener('click', oneShot, true);
            }, true);
        });
    })();
    if (window.__renderCfgList) window.__renderCfgList('local');
    // ── 独立全局世界书 选择同步 ──
    window.__wbListMode = window.__wbListMode || 'local';
    window.__renderWorldbookList = async function (mode) {
        mode = mode || window.__wbListMode;
        window.__wbListMode = mode;
        const list = $('cs_wb_list'); const tgt = $('cs_wb_target');
        if (!list) return;
        const prevChecked = new Set([...document.querySelectorAll('input[name="cs_wb_sel"]:checked')].map((c) => c.value));
        // 存在性徽章集合
        let wbLocalSet = new Set(), wbCloudSet = new Set();
        try { listGlobalWorldbookNames().forEach((n) => wbLocalSet.add(n)); } catch { }
        try { (await __cachedListEntries('worldbooks')).filter((e) => e.type === 'file' && e.name.endsWith('.json')).forEach((e) => wbCloudSet.add(e.name.replace(/\.json$/, ''))); } catch { }
        let names = [];
        if (mode === 'cloud') {
            list.innerHTML = '<p class="cs-hint">⏳ 获取云端世界书中…（云端响应慢时请稍候，最多约 45 秒）</p>';
            try { names = await listCloudWorldbooks(); }
            catch (e) {
                const why = (e && e.message) || e;
                if (tgt) tgt.textContent = '（读取云端失败）';
                list.innerHTML = `<p class="cs-hint" style="color:#e66">⚠ 读取云端失败：${escapeHtml(why)}<br>请点设置里的「连接测试」自查（网络/仓库/token）</p>`;
                return;
            }
            if (tgt) tgt.textContent = '当前为云端视图，将导入云端选中'; 
        } else {
            names = listGlobalWorldbookNames();
            if (tgt) tgt.textContent = '当前为本地视图（已跳过绑定卡世界书），将上传本地选中';
        }
        list.innerHTML = names.length
            ? names.map((n) => {
                const both = wbLocalSet.has(n) && wbCloudSet.has(n);
                const wcls = both ? 'both' : (mode === 'cloud' ? 'cloud' : 'local');
                const whereB = both ? '<b class="cs-cln-where cs-cln-where-both">双端<span class="cs-where-diff" data-where-diff=""></span></b>' : (mode === 'cloud' ? '<b class="cs-cln-where cs-cln-where-cloud">仅云端<span class="cs-where-diff" data-where-diff=""></span></b>' : '<b class="cs-cln-where cs-cln-where-local">仅本地<span class="cs-where-diff" data-where-diff=""></span></b>');
                return `<label class="cs-role-item" data-wb="${escapeHtml(n)}"><input type="checkbox" value="${escapeHtml(n)}" name="cs_wb_sel" ${prevChecked.has(n) ? 'checked' : ''}>${whereB}<span>${escapeHtml(n)}</span></label>`;
            }).join('')
            : `<p class="cs-hint">（无${mode === 'cloud' ? '云端' : '本地全局'}世界书）</p>`;
        __applyRowFilter('cs_wb_list', window.__rowFilter_cs_wb_list || '全部');
        // 差异徽章: 目录sha一次拿全 vs 本地内容指纹
        (async () => {
            try {
                const arr = await __cachedListEntries('worldbooks');
                const shaMap = new Map(arr.filter((e) => e.type === 'file' && e.name.endsWith('.json')).map((e) => [e.name.replace(/\.json$/, ''), e.sha]));
                const rows2 = [...list.querySelectorAll('label.cs-role-item[data-wb]')];
                for (const row of rows2) {
                    const name = row.getAttribute('data-wb');
                    const sha = shaMap.get(name);
                    const sp = row.querySelector('.cs-where-diff');
                    if (!sha) { if (sp) { sp.textContent = ''; sp.title = ''; } continue; } // 云端没有
                    let localTxt = null;
                    try { const wc = await getWorldContent(name); if (wc) localTxt = String(wc); } catch { }
                    if (localTxt === null) { if (sp) { sp.textContent = ''; sp.title = ''; } continue; } // 仅云端: 存在性徽章表达, 无谁新
                    const lb = await gitBlobSha(new TextEncoder().encode(localTxt));
                    const p2 = `worldbooks/${name}.json`;
                    const mem = settings.lastCloudSha && settings.lastCloudSha[p2];
                    const r2 = (lb === sha) ? 'same' : ((mem && sha !== mem) ? 'cloud' : 'local');
                    if (sp) { sp.textContent = r2 === 'same' ? '' : '·' + DIFF_LABEL[r2]; sp.title = r2 === 'same' ? '' : DIFF_TITLE[r2]; }
                }
            } catch { }
        })();
    };
    $('cs_wb_local')?.addEventListener('click', () => window.__renderWorldbookList('local'));
    $('cs_wb_cloud')?.addEventListener('click', () => window.__renderWorldbookList('cloud'));
    $('cs_wb_selall')?.addEventListener('click', () => document.querySelectorAll('input[name="cs_wb_sel"]').forEach((c) => { if (c.closest('label') && c.closest('label').style.display === 'none') return; c.checked = true; }));
    $('cs_wb_clr')?.addEventListener('click', () => document.querySelectorAll('input[name="cs_wb_sel"]').forEach((c) => { c.checked = false; }));
    // 世界书列表 拖拽划选（与角色列表同款实现，含<4px单击/≥4px拖拽防翻、one-shot拦截防双击双翻）
    (function bindWbDragSelect() {
        const list = $('cs_wb_list');
        if (!list || list.getAttribute('data-wbdragbound')) return;
        list.setAttribute('data-wbdragbound', '1');
        let dragging = false, dragMoved = false, startX = 0, startY = 0;
        const toggled = new Set(); // 本次拖拽中已翻转的 checkbox
        list.addEventListener('mousedown', (e) => {
            if (e.button !== 0) return;
            dragging = true; dragMoved = false;
            startX = e.clientX; startY = e.clientY;
            toggled.clear();
        });
        list.addEventListener('mousemove', (e) => {
            if (!dragging) return;
            if (!dragMoved) {
                // 未超过阈值 = 仍在「单击」阶段，不翻转，避免微小晃动引起双触发
                if (Math.abs(e.clientX - startX) < 4 && Math.abs(e.clientY - startY) < 4) return;
                dragMoved = true;
            }
            const el = document.elementFromPoint(e.clientX, e.clientY);
            const label = el && el.closest('.cs-cln-row');
            if (label) {
                const cb = label.querySelector('input[type="checkbox"]');
                if (cb && !toggled.has(cb)) {
                    toggled.add(cb);
                    cb.checked = !cb.checked; // 首次经过=勾选；拖动到已勾=取消
                }
            }
        });
        window.addEventListener('mouseup', () => {
            const wasDrag = dragging && dragMoved;
            dragging = false;
            if (!wasDrag) { toggled.clear(); return; } // 单击：交给原生 label click，不再干预
            // 是拖拽：mouseup 后原生 label click 会对刚翻转过的项再翻一次 → 拦截本次 click
            document.addEventListener('click', function oneShot(ev) {
                const cb2 = ev.target.closest && ev.target.closest('label') ? ev.target.closest('label').querySelector('input[type="checkbox"]') : null;
                if (cb2 && toggled.has(cb2)) {
                    ev.preventDefault();
                    ev.stopPropagation();
                    toggled.delete(cb2); // 该次已拦，移除避免误拦后续
                }
                if (!toggled.size) document.removeEventListener('click', oneShot, true);
            }, true);
        });
    })();
    $('cs_wb_push')?.addEventListener('click', async () => {
        try { await new Promise(r2 => setTimeout(r2, 500)); window.__renderWorldbookList(window.__wbListMode); } catch { } // 即时刷新(内部 toastr 汇总)
        const sel = [...document.querySelectorAll('input[name="cs_wb_sel"]:checked')].map((c) => c.value);
        if (!sel.length) { toastr.warning('请先勾选要上传的世界书'); return; }
        const st = $('cs_wb_status'); if (st) st.textContent = '上传中…';
        await pushSelectedWorldbooks(sel);
        if (st) st.textContent = '';
    });
    $('cs_wb_pull')?.addEventListener('click', async () => {
        try { await new Promise(r2 => setTimeout(r2, 800)); window.__renderWorldbookList(window.__wbListMode); } catch { } // 即时刷新
        const sel = [...document.querySelectorAll('input[name="cs_wb_sel"]:checked')].map((c) => c.value);
        if (!sel.length) { toastr.warning('请先勾选要导入的世界书'); return; }
        const st = $('cs_wb_status'); if (st) st.textContent = '导入中…';
        await importSelectedWorldbooks(sel);
        if (st) st.textContent = '';
    });
    // 删除选中世界书：目标随当前列表视图（本地视图→删本地全局书，云端视图→删云端全局书），逻辑同角色删除选中
    $('cs_wb_del')?.addEventListener('click', async () => {
        const st = $('cs_wb_status');
        const mode = window.__wbListMode || 'local';
        const sel = [...document.querySelectorAll('input[name="cs_wb_sel"]:checked')].map((c) => c.value);
        if (!sel.length) { if (st) st.textContent = '请先在上方勾选要删除的世界书'; return; }
        // 确认在拿锁前
        let ok;
        if (mode === 'cloud') {
            ok = await csConfirm('⚠ 永久删除云端全局世界书', `将永久删除云端全局世界书：<b>${sel.map(escapeHtml).join('、')}</b>。<br>删除后无法直接找回，确定删除「${sel.length}」个吗？`);
        } else {
            ok = await csConfirm('⚠ 删除本地全局世界书', `将删除本地全局世界书：<b>${sel.map(escapeHtml).join('、')}</b>。<br>若未上传备份将无法找回，确定删除「${sel.length}」个吗？`);
        }
        if (!ok) { if (st) st.textContent = '已取消'; return; }
        if (st) st.textContent = '删除中…';
        if (!__csTryBusy()) { if (st) st.textContent = '已有同步在进行中，稍后再试'; return; }
        try {
            showBusy(0, sel.length, mode === 'cloud' ? '删除云端世界书' : '删除本地世界书');
            // 批量删除世界书时，本地删的确认弹窗已在上方一次性取得同意，临时接管 ST 删除可能的确认(它可能弹)。
            const P = window.Popup || Popup;
            const origConfirm = P && P.show && P.show.confirm ? P.show.confirm.bind(P.show) : null;
            const origPopupConfirm = P && P.confirm ? P.confirm.bind(P) : null;
            if (origConfirm) P.show.confirm = () => Promise.resolve(1 /* AFFIRMATIVE=确定 */);
            else if (origPopupConfirm) P.confirm = () => true;
            const r = await deleteSelectedWorldbooks(sel, mode);
            if (origConfirm) P.show.confirm = origConfirm;
            else if (origPopupConfirm) P.confirm = origPopupConfirm;
            const failTxt = r && r.failReasons && r.failReasons.length ? `，失败 ${r.fail}（${r.csShortList(failReasons.map(x => `${x.name}:${x.reason}`))}）` : (r && r.fail ? `，失败 ${r.fail}` : '');
            if (st) st.textContent = `删除完成：成功 ${r ? r.ok : 0} / 共 ${sel.length}${failTxt}`;
            for (const k of Object.keys(__dirEntryCache)) delete __dirEntryCache[k];
        window.__renderWorldbookList && window.__renderWorldbookList(mode === 'cloud' ? 'cloud' : 'local');
        } finally { __csReleaseBusy(); }
    });
    if (window.__renderWorldbookList) window.__renderWorldbookList('local');
    // 刷新云端角色列表（读 sync/ 目录）
    $('cs_refresh_cloud')?.addEventListener('click', async () => {
        const sel = $('cs_cloud_char'); const st = $('cs_cloud_status');
        if (!settings.token || !settings.repo) { if (st) st.textContent = '请先配置 token+仓库'; return; }
        if (st) st.textContent = '读取云端角色…';
        try {
            const names = await Gitee.listDir('sync');
            const current = sel.value;
            sel.innerHTML = '<option value="">— 选择云端角色 —</option>';
            names.forEach((n) => {
                const opt = document.createElement('option');
                opt.value = n; opt.textContent = n;
                sel.appendChild(opt);
            });
            if (names.includes(current)) sel.value = current;
            if (st) st.textContent = names.length ? `云端有 ${names.length} 个角色` : '云端暂无角色';
        } catch (e) { if (st) st.textContent = '读取失败：' + e.message; }
    });
    // 从云端导入选中角色（全量）
    $('cs_import_cloud')?.addEventListener('click', async () => {
        const sel = $('cs_cloud_char'); const st = $('cs_cloud_status');
        const charName = sel && sel.value;
        if (!charName) { if (st) st.textContent = '请先选择要导入的云端角色'; return; }
        if (st) st.textContent = '导入中…';
        try { await importCharFromCloud(charName); if (st) st.textContent = '导入完成'; }
        catch (e) { toastr.error('导入失败：' + e.message); if (st) st.textContent = '导入失败'; }
    });
    // 删除选中文件：删除对象随当前列表视图（本地视图→删本地，云端视图→删云端）
    $('cs_del_sel')?.addEventListener('click', async () => {
        const st = $('cs_delete_status');
        const mode = window.__csListMode || 'local';
        const sel = [...document.querySelectorAll('input[name="cs_role_sel"]:checked')].map((c) => c.value);
        if (!sel.length) { if (st) st.textContent = '请先在上方勾选要删除的文件'; return; }
        // 确认在拿锁之前进行，避免「弹窗等待期间持锁」卡住后续所有同步
        let ok;
        if (mode === 'cloud') {
            ok = await csConfirm('⚠ 永久删除云端角色', `将永久删除云端角色：<b>${sel.map(escapeHtml).join('、')}</b>（角色卡＋世界书＋聊天＋清单）。<br>删除后无法直接找回，确定删除「${sel.length}」个吗？`);
        } else {
            ok = await csConfirm('⚠ 删除本地角色', `将删除本地角色：<b>${sel.map(escapeHtml).join('、')}</b> 及其全部聊天。<br>若未上传备份将无法找回，确定删除「${sel.length}」个吗？`);
        }
        if (!ok) { if (st) st.textContent = '已取消'; return; }
        if (st) st.textContent = '删除中…';
        if (!__csTryBusy()) { if (st) st.textContent = '已有同步在进行中，稍后再试'; return; }
        try {
            showBusy(0, sel.length, mode === 'cloud' ? '删除云端' : '删除本地');
            let okCount = 0, failCount = 0; const failed = [];
            // ⚠️ ST 官方 deleteCharacter 会在「处于临时聊天」时对【每个】被删角色各弹一次
            //   「您当前处于临时聊天中…将丢失未保存的消息」确认框（script.js:10773 inTempChat）。
            //   批量删除已在下方 csConfirm 取得用户一次性同意，故遍历期间临时接管确认弹窗：
            //   让官方这次临时聊天提示自动通过，避免「删 N 个角色弹 N 次窗」。
            //   仅接管本次批量遍历；结束后立即恢复，不影响其它弹窗。被删的是所选角色，与当前临时聊天无关，不会丢其消息。
            const P = window.Popup || Popup;
            const origConfirm = P && P.show && P.show.confirm ? P.show.confirm.bind(P.show) : null;
            const origPopupConfirm = P && P.confirm ? P.confirm.bind(P) : null;
            if (origConfirm) P.show.confirm = () => Promise.resolve(1 /* AFFIRMATIVE=确定 */);
            else if (origPopupConfirm) P.confirm = () => true;
            for (let i = 0; i < sel.length; i++) {
                const name = sel[i];
                showBusy(i + 1, sel.length, mode === 'cloud' ? '删除云端' : '删除本地');
                try {
                    if (mode === 'cloud') await deleteCharFromCloud(name, true);
                    else await deleteLocalCharacter(name, true, true); // 批量: 静默(已有汇总提示, 避免重复toast)
                    okCount++;
                }
                catch (e) { failCount++; failed.push(name); console.warn('[chat-sync] 删除角色失败', name, e); }
            }
            if (origConfirm) P.show.confirm = origConfirm;
            else if (origPopupConfirm) P.confirm = origPopupConfirm;
            if (st) st.textContent = `删除完成：成功 ${okCount}，失败 ${failCount}${failed.length ? `（${failed.join('、')}）` : ''}`;
            window.__renderRoleMultiList && window.__renderRoleMultiList(mode === 'cloud' ? 'cloud' : 'local');
        } finally { __csReleaseBusy(); }
    });
    $('cs_chk_open')?.addEventListener('change', (e) => { settings.autoSyncOnOpen = e.target.checked; saveSettingsDebounced(); });
    $('cs_chk_live')?.addEventListener('change', (e) => {
        settings.autoSyncLive = e.target.checked;
        saveSettingsDebounced();
        if (shouldAuto() && settings.autoSyncLive) startPolling(); else stopPolling();
        if (e.target.checked) toastr.info('双端实时同步已开启（每 ' + (Number(settings.autoSyncInterval) || 30) + ' 秒检查一次）');
    });
    $('cs_interval')?.addEventListener('change', (e) => {
        const v = Math.max(10, Number(e.target.value) || 30);
        settings.autoSyncInterval = v;
        saveSettingsDebounced();
        stopPolling();
        if (shouldAuto() && settings.autoSyncLive) startPolling();
    });
    // 自动同步范围：仅当前聊天 / 仅当前角色 / 全部聊天
    document.querySelectorAll('input[name="cs_scope"]').forEach((el) => {
        el.addEventListener('change', () => {
            const checked = document.querySelector('input[name="cs_scope"]:checked');
            settings.syncScope = checked ? checked.value : 'all';
            saveSettingsDebounced();
            const map = { chat: '仅当前聊天', char: '仅当前角色', all: '全部聊天' };
            toastr.success('自动同步范围已设为：' + (map[settings.syncScope] || settings.syncScope));
        });
    });
    // 切换角色/聊天自动推送开关
    $('cs_chk_switch')?.addEventListener('change', (e) => { settings.autoSyncOnSwitch = e.target.checked; saveSettingsDebounced(); });
}

// 挂到扩展设置面板（幂等：已存在则直接渲染，不重复创建）
function ensurePanel() {
    const container = document.getElementById('extensions_settings');
    if (!container) return;
    let div = document.getElementById('chat_sync_settings');
    if (!div) {
        div = document.createElement('div');
        div.id = 'chat_sync_settings';
        div.className = 'extension-settings';
        container.appendChild(div);
    }
    injectSettingsCss();
    renderSettingsPanel();
}

// ===== 面板卡片样式（参照余温工具箱的卡片化折叠块：主题变量 + 圆角 + hover，差异化非搬运）=====
const CHAT_SYNC_CSS = `
#chat_sync_settings .cs-card { border:1px solid var(--SmartThemeBorderColor); border-left:3px solid var(--SmartThemeQuoteColor); border-radius:12px; overflow:hidden; background:rgba(0,0,0,0.08); margin-top:10px; }
#chat_sync_settings .cs-card.cs-last { margin-bottom:28px; }
#chat_sync_settings .cs-fold > summary { display:flex; align-items:center; gap:8px; padding:9px 12px; cursor:pointer; user-select:none; font-size:13px; font-weight:700; color:var(--SmartThemeBodyColor,inherit); background:rgba(255,255,255,0.04); border-bottom:1px solid var(--SmartThemeBorderColor); list-style:none; outline:none; }
#chat_sync_settings .cs-fold > summary::-webkit-details-marker { display:none; }
#chat_sync_settings .cs-fold > summary::after { content:'▸'; transition:transform .18s ease; opacity:.7; font-size:13px; margin-left:auto; line-height:1; }
#chat_sync_settings .cs-fold[open] > summary::after { transform:rotate(90deg); }
#chat_sync_settings .cs-fold > summary:hover { filter:brightness(1.08); }
#chat_sync_settings .cs-ico { font-size:13px; color:var(--SmartThemeQuoteColor); opacity:.85; }
#chat_sync_settings .cs-body { padding:10px 12px; }
#chat_sync_settings .cs-label { display:block; margin-bottom:4px; font-size:.88em; font-weight:600; color:var(--SmartThemeBodyColor,var(--grey_color)); opacity:.9; }
#chat_sync_settings .cs-hint { font-size:.72em; color:var(--SmartThemeBodyColor,var(--grey_color)); opacity:.72; line-height:1.5; margin:3px 0 0; }
#chat_sync_settings .cs-sep { height:1px; background:var(--SmartThemeBorderColor); margin:9px 0; }
#chat_sync_settings .cs-role-item { display:flex; align-items:center; gap:6px; padding:1px 4px; cursor:pointer; border-radius:3px; }
#chat_sync_settings .cs-role-item:hover { background:var(--SmartThemeBlurTintColor,rgba(0,0,0,.06)); }
#chat_sync_settings .cs-role-item span { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:.85em; }
#chat_sync_settings .cs-role-item input { transform:scale(.85); flex:none; }
#chat_sync_settings .cs-group-title { font-size:.78em; font-weight:600; color:var(--SmartThemeBodyColor,var(--grey_color)); margin:6px 0 3px; }
#chat_sync_settings .cs-row { display:flex; gap:8px; align-items:center; }
#chat_sync_settings .cs-btn { padding:3px 10px; border-radius:8px; border:1px solid var(--SmartThemeBorderColor); background:rgba(255,255,255,0.05); color:var(--SmartThemeBodyColor,inherit); cursor:pointer; font-size:.85em; transition:filter .15s ease; }
#chat_sync_settings .cs-btn:hover { filter:brightness(1.15); }
#chat_sync_settings .cs-btn.cs-primary { border-color:var(--SmartThemeQuoteColor); color:var(--SmartThemeQuoteColor); }
#chat_sync_settings .cs-current { font-size:.9em; color:var(--SmartThemeBodyColor,inherit); }
#chat_sync_settings .cs-danger { border:1px solid #a33; border-radius:10px; padding:8px 10px; background:rgba(170,51,51,.08); }
#chat_sync_settings .cs-danger-title { color:#e06666; font-weight:600; font-size:.88em; display:flex; align-items:center; gap:6px; margin-bottom:4px; }
#chat_sync_settings .cs-btn.cs-danger-btn { border-color:#a33; color:#ff8787; background:rgba(170,51,51,.15); font-weight:400 !important; }
#chat_sync_settings .cs-btn.cs-danger-btn:hover { filter:brightness(1.2); }
/* 刷新按钮配色：本地=绿 / 云端=蓝（用户要求与 emoji 一样有辨识色） */
#chat_sync_settings .cs-btn.cs-btn-local { color:#6fce6f; border-color:rgba(111,206,111,.55); }
#chat_sync_settings .cs-btn.cs-btn-cloud { color:#6fb7f0; border-color:rgba(111,183,240,.55); }
#chat_sync_settings .cs-cln-row .cs-cln-size { color:#e8a44c; font-size:.95em; font-weight:700; }
#chat_sync_settings .cs-cln-row .cs-cln-date { color:var(--SmartThemeBodyColor,var(--grey_color)); opacity:.65; }
.cs-cln-modal { display:flex; width:min(940px,94vw); height:min(640px, calc(100vh - 24px)); height:min(640px, calc(100dvh - 24px)); background:var(--SmartThemeBlurTintColor,#1b1b1b); border:1px solid var(--SmartThemeBorderColor,#333); border-radius:12px; overflow:hidden; box-shadow:0 8px 32px rgba(0,0,0,.5); }
@media (max-width: 700px) { .cs-cln-modal { flex-direction:column; height:calc(100vh - 24px); height:calc(100dvh - 24px); } .cs-cln-left { flex:none; max-height:48%; } .cs-cln-right { flex:1; border-left:none; border-top:1px solid var(--SmartThemeBorderColor,#333); } }
.cs-cln-left { flex:1.5; display:flex; flex-direction:column; overflow:hidden; padding:0; position:relative; }
.cs-cln-right { flex:1; display:flex; flex-direction:column; border-left:1px solid var(--SmartThemeBorderColor,#333); min-width:0; }
.cs-cln-ptitle { margin-bottom:8px; font-size:.85em; line-height:1.6; }
.cs-role-avatar { width:30px; height:30px; border-radius:50%; object-fit:cover; flex:none; background:rgba(255,255,255,.06); border:1px solid var(--SmartThemeBorderColor,#333); }
.cs-role-avatar.cs-av-ph { display:inline-flex; align-items:center; justify-content:center; font-size:.9em; opacity:.55; }
.cs-cln-ptext { white-space:pre-wrap; word-break:break-word; font-size:.85em; line-height:1.7; color:var(--SmartThemeBodyColor,#e1e1e1); }
/* 预览正文格式着色: 与聊天页同款主题变量(斜体/引用/下划线) */
.cs-cln-ptext em.cs-prev-em { color: var(--SmartThemeEmColor, #7f9cf5); font-style: italic; }
.cs-cln-ptext .cs-prev-q { color: var(--SmartThemeQuoteColor, #f0a35e); }
.cs-cln-ptext u.cs-prev-u { color: var(--SmartThemeUnderlineColor, inherit); }
#cs_user_modal em.cs-prev-em { color: var(--SmartThemeEmColor, #7f9cf5); font-style: italic; }
#cs_user_modal .cs-prev-q { color: var(--SmartThemeQuoteColor, #f0a35e); }
#cs_user_modal u.cs-prev-u { color: var(--SmartThemeUnderlineColor, inherit); }
/* 楼层正文块: 用户/AI 消息分别铺主题消息色调(同聊天页) */
.cs-cln-fl { border-radius: 10px; padding: 10px 12px; }
.cs-cln-fl-user { background: var(--SmartThemeUserMesBlurTintColor, transparent); }
.cs-cln-fl-ai { background: var(--SmartThemeAiMesBlurTintColor, transparent); }
.cs-cln-mrow.cs-cln-active { background:rgba(111,183,240,.15); border-radius:4px; }
/* 回顶部浮动按钮: 滚过一屏才出现, 平滑回顶 */
.cs-top-fab { position:absolute; right:14px; bottom:14px; z-index:4; display:none; padding:6px 16px; border-radius:999px; border:1px solid var(--SmartThemeBorderColor,#555); background:rgba(22,22,26,.88); color:var(--SmartThemeBodyColor,#eee); cursor:pointer; font-size:.85em; box-shadow:0 4px 14px rgba(0,0,0,.45); backdrop-filter:blur(6px); -webkit-backdrop-filter:blur(6px); transition:filter .15s ease; }
.cs-top-fab:hover { filter:brightness(1.3); }
.cs-cln-modal .cs-cln-size { color:#e8a44c; font-weight:700; }
/* 人设管理·表格行: 每列定宽对齐 */
#chat_sync_settings .cs-prow { display:flex; align-items:center; gap:10px; padding:2px 4px; }
#chat_sync_settings .cs-prow:hover { background:rgba(255,255,255,.05); border-radius:3px; }
#chat_sync_settings .cs-prow .cs-pcol-name { flex:0 1 auto !important; max-width:110px; font-size:.85em; }
#chat_sync_settings .cs-prow .cs-pcol-count { flex:none !important; font-size:.82em; font-weight:700; color:var(--SmartThemeQuoteColor,#f0a35e); }
#chat_sync_settings .cs-prow .cs-pcol-desc { flex:1 1 0% !important; min-width:60px; font-size:.78em; opacity:.72; }
#chat_sync_settings .cs-cln-row { display:flex; align-items:center; gap:6px; padding:2px 4px; border-radius:3px; cursor:pointer; flex-wrap:nowrap; }
#chat_sync_settings .cs-cln-row:hover { background:var(--SmartThemeBlurTintColor,rgba(0,0,0,.06)); }
#chat_sync_settings .cs-cln-row .cs-cln-fname { flex:1; min-width:0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; font-size:.85em; }
#chat_sync_settings .cs-cln-row .cs-cln-date { white-space:nowrap; opacity:.65; font-size:.7em; }
.cs-cln-where { flex:none; display:inline-flex; align-items:center; justify-content:center; font-size:.72em; line-height:1.6; padding:0 2px; border-radius:999px; border:1px solid; margin-right:3px; box-sizing:border-box; white-space:nowrap; width:4.4em; text-align:center; overflow:hidden; font-weight:600; }
.cs-cln-where .cs-where-diff { flex:none; font-size:1em !important; line-height:inherit; font-family:inherit; font-weight:inherit; color:inherit; margin:0; }
.cs-chk-btn { flex:none; margin-left:8px; padding:2px 10px; font-size:.8em; font-weight:700; border-radius:999px; border:1px solid rgba(111,183,240,.6); background:rgba(111,183,240,.1); color:var(--SmartThemeBodyColor,#ddd); cursor:pointer; animation:cs_chk_pulse 2.6s ease-in-out infinite; }
.cs-chk-btn:hover { filter:brightness(1.35); }
@keyframes cs_chk_pulse { 0%,100% { box-shadow:0 0 0 rgba(111,183,240,.15); } 50% { box-shadow:0 0 9px rgba(111,183,240,.5); } }
#cs_chk_manual[data-result="newer"] { color:#6fce6f !important; border-color:rgba(111,206,111,.6) !important; }
#cs_chk_manual[data-result="fail"] { color:#e66 !important; border-color:rgba(230,102,102,.6) !important; }
#cs_chk_manual[data-result="higher"] { color:#c9b458 !important; border-color:rgba(201,180,88,.6) !important; }
.cs-upd-btn { padding:2px 6px; font-size:.75em; font-weight:700; margin-left:10px; color:#6fce6f !important; border-color:rgba(111,206,111,.6) !important; background:rgba(111,206,111,.08) !important; animation:cs_upd_pulse 2.4s ease-in-out infinite; }
@keyframes cs_upd_pulse { 0%,100% { box-shadow:0 0 0 rgba(111,206,111,.3); } 50% { box-shadow:0 0 10px rgba(111,206,111,.4); } }
.cs-cln-where-both { color:#6fce6f; border-color:rgba(111,206,111,.55); }
.cs-cln-where-local { color:#c9b458; border-color:rgba(201,180,88,.55); }
.cs-cln-where-cloud { color:#6fb7f0; border-color:rgba(111,183,240,.55); }
/* 开/关状态徽章(拓展/酒馆助手): 本地可点击切换, 云端只读(数据来自云端记录) */
.cs-cln-en { flex:none; display:inline-flex; align-items:center; margin-left:6px; padding:0 8px; font-size:.72em; font-weight:700; border-radius:999px; border:1px solid; line-height:1.6; font-family:inherit; background:transparent; cursor:pointer; }
.cs-cln-en[data-on="1"] { color:#6fce6f; border-color:rgba(111,206,111,.55); }
.cs-cln-en[data-on="0"] { color:#c9b458; border-color:rgba(201,180,88,.55); }
.cs-cln-en:hover { filter:brightness(1.3); }
/* 内容差异徽章: 同步时会跳过的引用与本地/云端新的一眼可见 */
.cs-diff-badge { flex:none; font-size:.7em; padding:1px 6px; border-radius:8px; border:1px solid; margin-left:5px; opacity:.95; }
.cs-diff-badge[data-diff="same"] { color:#6fce6f; border-color:rgba(111,206,111,.55); }
.cs-diff-badge[data-diff="local"] { color:#6fb7f0; border-color:rgba(111,183,240,.55); }
.cs-diff-badge[data-diff="cloud"] { color:#f0a35e; border-color:rgba(240,163,94,.55); }
.cs-diff-badge[data-diff="diff"] { color:#e66; border-color:rgba(230,102,102,.55); }
.cs-where-diff { flex:none !important; font-weight:700; margin-left:4px; color:inherit; }
.cs-cln-where ~ .cs-where-diff { margin-left:2px; }
.cs-where-diff[data-where-diff="cloud"] { color:#f0a35e; }
.cs-where-diff[data-where-diff="local"] { color:#6fb7f0; }
.cs-where-diff[data-where-diff="same"] { color:#6fce6f; }
.cs-cln-mbar { display:flex; flex-direction:column; gap:6px; padding:8px 10px; border-bottom:1px solid var(--SmartThemeBorderColor,#333); background:rgba(255,255,255,.03); }
.cs-cln-mbar-title { font-size:.88em; font-weight:700; }
.cs-cln-mbar-title small { font-weight:400; opacity:.65; font-size:.85em; }
.cs-cln-mbar-btns { display:flex; gap:8px; flex-wrap:wrap; }
.cs-cln-modal .cs-cln-mrow { display:flex; align-items:center; gap:6px; padding:2px 4px; border-radius:3px; cursor:pointer; }
.cs-cln-modal .cs-cln-mrow:hover { background:rgba(255,255,255,.05); }
.cs-cln-modal .cs-cln-mrow .cs-cln-fname { flex:1; min-width:0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; font-size:.85em; }
/* 弹窗挂在 body 下，吃不到 #chat_sync_settings 作用域 → 按钮/输入样式单独给（否则白底灰字原生样式） */
.cs-cln-modal .cs-btn { padding:3px 10px; border-radius:8px; border:1px solid var(--SmartThemeBorderColor,#555); background:rgba(255,255,255,0.06); color:var(--SmartThemeBodyColor,#eee); cursor:pointer; font-size:.85em; transition:filter .15s ease; }
.cs-cln-modal .cs-btn:hover:not(:disabled) { filter:brightness(1.25); }
.cs-cln-modal .cs-btn:disabled { opacity:.4; cursor:not-allowed; }
.cs-cln-modal .cs-btn.cs-danger-btn { border-color:#a33; color:#ff8787; background:rgba(170,51,51,.2); }
.cs-cln-modal .text_pole { background:rgba(0,0,0,.25); border:1px solid var(--SmartThemeBorderColor,#555); border-radius:6px; color:var(--SmartThemeBodyColor,#eee); padding:2px 6px; font-size:.85em; }
.cs-cln-fnav { flex:none; display:flex; align-items:center; gap:8px; flex-wrap:wrap; padding:8px 12px 6px; border-bottom:1px solid var(--SmartThemeBorderColor,#333); background:linear-gradient(var(--SmartThemeBlurTintColor,#1b1b1b), var(--SmartThemeBlurTintColor,#1b1b1b)), rgb(22,22,26); box-shadow:0 2px 8px rgba(0,0,0,.3); }
/* 正文独立滚动区: 导航物理固定在其上方, 不依赖 sticky */
.cs-cln-fbody { flex:1; min-height:0; overflow:auto; padding:12px; overscroll-behavior:contain; -webkit-overflow-scrolling:touch; }
.cs-cln-fnum { font-size:.82em; font-weight:700; opacity:.9; white-space:nowrap; }
`;
function injectSettingsCss() {
    if (document.getElementById('chat-sync-settings-style')) return;
    const s = document.createElement('style');
    s.id = 'chat-sync-settings-style';
    s.textContent = CHAT_SYNC_CSS;
    document.head.appendChild(s);
}

// ===================== 自动同步触发 =====================
// 是否具备自动能力（已配置连接即可；具体行为由各开关 autoSyncLive/autoSyncOnOpen/autoSyncOnSwitch 独立控制）
function shouldAuto() { return settings.token; }

// ---- 双端实时轮询 ----
let pollTimer = null;
let pollBusy = false;

// 一轮轮询：比较当前角色本地/云端的聊天，有差异则同步
async function syncPollTick() {
    if (pollBusy) return;             // 防重入（一轮未完成不开始下一轮）
    if (!shouldAuto() || !settings.autoSyncLive) return;
    const charName = currentCharName();
    if (!charName) return;
    pollBusy = true;
    try {
        // 1) 当前打开的聊天做「楼层级合并」——这是新消息产生的地方，多端并发也收敛不丢。
        //    （已有 syncMap 映射才行；否则自动改走整包拉取。）
        const mergedRes = await syncOpenChat(charName);
        // 2) 其余聊天保持文件级增量（先拉后推，粗筛避免无谓往返）
        const chatItems = await getCharChatFileNames(charName);
        await pollChatDelta(charName, chatItems, mergedRes ? false : true);
    } catch (e) {
        // 静默：轮询失败不打断用户
        if (pollCount % 10 === 0) console.warn('[chat-sync] 轮询失败', e && e.message);
    } finally {
        pollBusy = false;
    }
}

let pollCount = 0;
async function pollChatDelta(charName, chatItems, skipCurrentFile = false) {
    pollCount++;
    const base = `sync/${charName}/chats`;
    const curChat = String(ctx().chatId || '').replace(/\.jsonl$/i, '') + '.jsonl';
    // 一次目录列表拿全部 sha(分段聊天以 manifest sha 为指纹)，不再逐文件下载比对
    const shaMap = await cloudShaMap(base);
    for (const item of chatItems) {
        // 当前打开的聊天已由 syncOpenChat 做楼层级合并，文件级这里跳过，避免重复/双写
        if (skipCurrentFile && String(item.file_name).toLowerCase() === String(curChat).toLowerCase()) continue;
        const safeName = item.file_name.replace(/[\\/\\\\]/g, '_');
        const p = `${base}/${safeName}`;
        // 云端被改过（sha 变了）→ 拉取
        try {
            const cloudSha = shaMap.get(manifestPathOf(p)) || shaMap.get(p);
            const remembered = settings.lastCloudSha[p];
            if (cloudSha && remembered && cloudSha !== remembered) {
                await pullCharacterChats(charName);
                return; // 拉完重绘后本轮即可结束
            }
        } catch { /* 单文件失败忽略 */ }
        // 本端 mtime 变了 → 推送
        const lastMT = settings.lastLocalMTime[p];
        if (item.mtime !== undefined && lastMT !== undefined && lastMT !== item.mtime) {
            await pushAuto();
            return;
        }
    }
}

function startPolling() {
    if (pollTimer) return;
    const interval = Math.max(10, Number(settings.autoSyncInterval) || 30) * 1000;
    pollTimer = setInterval(syncPollTick, interval);
}
function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

// 实时更新面板里的"当前角色/绑定世界书"显示 + 切换"当前角色操作"vs"云端导入"入口（按是否打开角色）
function updateCurrentCharDisplay() {
    const el = document.getElementById('cs_char_display');
    const charName = currentCharName();
    const worldName = currentWorldName();
    if (el) el.innerHTML = `当前角色：<b>${escapeHtml(charName || '（未打开单人角色）')}</b>`
        + (worldName ? `<br>绑定世界书：<b>${escapeHtml(worldName)}</b>` : '');
    // 说明：云端管理与当前角色操作两块都常显，不分“是否打开角色”隐藏——进入角色聊天后照样能导入/删除/同步。
    // （旧版会在打开角色时隐藏云端区块，导致“没进角色卡才能操作”的困惑）
}

// 生成状态监听：生成正文时置标志（自动上传会暂缓，见 pushAuto）
// ⚠️ 上游坑：ST/TT 的 GENERATION_ENDED 只在 hideStopButton 且停止按钮曾显示时才 emit（script.js:3477）
//   —— 非流式/按钮未显示/生成被中断等场景可能 永不 emit → __csGenerating 卡死 true → 补楼/自动同步永久被拦。
//   加 watchdog 兜底：GENERATION_STARTED 时起个超长定时器，若到点标志仍 true 就强制清(绝不可能卡死)；
//   正常生成秒级~分钟级结束 → ENDED 会提前清，watchdog 不会误触发（生成不会真跑满这么久还不结束）。
let __csGenWatchdog = null;
const __CS_GEN_WATCHDOG_MS = 15 * 60 * 1000; // 15 分钟：任何真实生成都到不了这么长还没结束(2026-08-24 QA发现ST也复现假锁, 加长兜底窗口)
function __clearGenWatchdog() {
    if (__csGenWatchdog) { clearTimeout(__csGenWatchdog); __csGenWatchdog = null; }
}
function __genStart() {
    __csGenerating = true;
    __clearGenWatchdog();
    __csGenWatchdog = setTimeout(() => {
        if (__csGenerating) { console.warn('[chat-sync] 生成标志 watchdog 兜底清除(疑似上游 GENERATION_ENDED 未触发)'); __csGenerating = false; }
        __csGenWatchdog = null;
    }, __CS_GEN_WATCHDOG_MS);
}
function __genEnd() {
    __csGenerating = false;
    __clearGenWatchdog();
}
eventSource.on(event_types.GENERATION_STARTED, __genStart);
eventSource.on(event_types.GENERATION_ENDED, __genEnd);
eventSource.on(event_types.GENERATION_STOPPED, __genEnd);

// 打开角色（聊天切换）时：自动拉取 + 更新当前角色显示
eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, () => {
    updateCurrentCharDisplay();
    if (!shouldAuto() || !settings.autoSyncOnOpen) return;
    if (!currentCharName()) return;
    setTimeout(() => {
        pullAuto().catch((e) => console.warn('[chat-sync] 自动拉取失败', e));
    }, 1500); // 等楼层渲染完
});

// 切换角色/聊天时自动推送（增量）+ 更新显示
// 原生(酒馆自带聊天管理)删除聊天 → 自动刷新插件清理器列表 + 清预览缓存(反向同步)
eventSource.on(event_types.CHAT_DELETED, () => {
    try {
        window.__clnPreview = null; // 旧缓存可能指向已删文件
        if (typeof window.__renderCleanerList === 'function') window.__renderCleanerList();
    } catch { }
});
eventSource.on(event_types.CHAT_CHANGED, () => {
    updateCurrentCharDisplay();
    if (!shouldAuto() || !settings.autoSyncOnSwitch) return;
    if (!currentCharName()) return;
    setTimeout(() => {
        pushAuto().catch((e) => console.warn('[chat-sync] 切换自动推送失败', e));
    }, 200);
});

// 页面关闭时：只停轮询（不做推送——关闭页面插件无法可靠上传，改为“切换角色/聊天时自动上传备份”负责）
window.addEventListener('beforeunload', () => {
    stopPolling();
});

// 根据设置启停轮询
eventSource.on(event_types.SETTINGS_UPDATED, () => {
    if (shouldAuto() && settings.autoSyncLive) startPolling();
    else stopPolling();
});

// ===================== 斜杠命令 =====================
// 注意：不要顶到顶 import SlashCommandParser/SlashCommand——ST 1.18 的 slash-commands.js:106
// 有循环依赖 TDZ（new SlashCommandParser()），第三方插件顶层 import 会触发
// "Cannot access 'SlashCommandParser' before initialization" 导致整个插件模块不执行。
// 改为延迟注册：页面 ready 后再动态 import，绕开加载期循环依赖。
async function registerSlashCommand() {
    try {
        const { SlashCommandParser } = await import('../../../slash-commands/SlashCommandParser.js');
        const { SlashCommand } = await import('../../../slash-commands/SlashCommand.js');
        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'chat-sync',
            callback: async (args) => {
                const action = (args.raw || '').toLowerCase();
                if (action.includes('pull')) await pullAuto();
                else if (action.includes('push')) await pushAuto();
                else toastr.info('用法：/chat-sync push ｜ /chat-sync pull');
                return '';
            },
            helpString: '酒馆多端同步：/chat-sync push 同步当前角色到云端 | /chat-sync pull 拉取当前角色',
            namedArgumentList: [],
            unnamedArgumentList: [],
        }));
    } catch (e) { console.warn('[chat-sync] 注册 /chat-sync 命令失败（不影响同步功能）', e); }
}

// ===================== 初始化 =====================
// 页面加载后：若已保存完整配置，自动静默验证连接（不打扰），并把结果更新到面板状态
async function autoConnectIfConfigured() {
    if (!settings.owner || !settings.repo || !settings.token) return;
    try {
        const base = (settings.server || 'https://gitee.com/api/v5').replace(/\/$/, '');
        const isGh = base.includes('github'), isGl = base.includes('gitlab.com');
        const url = `${base}/user${isGh ? '' : (isGl ? '?private_token=' : '?access_token=') + encodeURIComponent(settings.token)}`;
        const headers = isGl ? { 'PRIVATE-TOKEN': settings.token } : (isGh ? { 'Authorization': 'Bearer ' + settings.token, 'Accept': 'application/vnd.github+json' } : { 'Authorization': 'token ' + settings.token });
        const r = await fetch(url, { headers, cache: 'no-store' });
        if (!r.ok) return;
        const u = await r.json();
        settings.lastConnectAt = Date.now();
        saveSettingsDebounced();
        __refreshCurRepoLine();
        const st = document.getElementById('cs_testresult');
        if (st) st.textContent = `✅ 已自动连接：${u.login || u.username}`;
    } catch { /* 静默：不打扰，用户可点连接测试 */ }
}

// 面板自愈: TT 手机端切界面会销毁重建 #extensions_settings 的 DOM(按钮事件全丢)——
// 监听变化, 发现本插件面板存在但哨兵未绑定时自动重跑 wirePanelEvents(哨兵标记防重复绑定)
(function __csWatchPanel() {
    let timer = null;
    const check = () => {
        try {
            const btn = document.getElementById('cs_cfg_tab_conn');
            if (btn && !btn.dataset.csWired && typeof window.__csWireNow === 'function') window.__csWireNow();
        } catch { }
    };
    const onChange = () => { clearTimeout(timer); timer = setTimeout(check, 300); };
    if (typeof jQuery !== 'undefined') {
        jQuery(() => {
            try { new MutationObserver(onChange).observe(document.body, { childList: true, subtree: true }); } catch { }
            setTimeout(check, 1200);
            setInterval(check, 5000); // 兜底轮询(MutationObserver 覆盖不到的重建方式)
        });
    }
})();
jQuery(() => {
    // 页面加载完成直接挂载设置面板到 #extensions_settings（ST 标准扩展设置区）
    ensurePanel();
    __refreshCurRepoLine();
    // 检测远程新版本(面板稳定后); 勾选了「自动更新」则启动即自动升级
    setTimeout(() => { try { if (settings.autoUpdate) { window.__csCheckUpdate && window.__csCheckUpdate({ auto: true }); } else { window.__csCheckUpdate && window.__csCheckUpdate(); } } catch { } }, 500);
    // 已配置则自动静默连接
    autoConnectIfConfigured();
    // 若已开启双端实时，页面加载后启动轮询（兜底 SETTINGS_UPDATED）
    if (shouldAuto() && settings.autoSyncLive) startPolling();
    // 延迟注册 /chat-sync 命令（绕开 ST 1.18 循环依赖）
    registerSlashCommand();
    console.log('[st-chat-sync] v0.2 角色级多端同步插件加载完成，面板已挂载');
});

// ===================== 调试出口（真机 CDP 验证用） =====================
window.__stChatSyncDebug = {
    importCharFromCloud,
    pullCurrentCharacter,
    pushCurrentCharacter,
    pushCurrentChat,
    pullCurrentChat,
    pushAuto,
    pullAuto,
    pushAllCharacters,
    importAllCharacters,
    pushSelectedCharacters,
    importSelectedCharacters,
    deleteCharFromCloud,
    exportChats,
    backupConfigToCloud,
    restoreConfigFromCloud,
    listConfigBackups,
    pushSelectedWorldbooks,
    importSelectedWorldbooks,
    deleteSelectedWorldbooks,
    listGlobalWorldbookNames,
    listCleanerRows,
    deleteChatsBothSides,
    // 分段存储直驱（测试/调试）
    getCloudChat,
    putCloudChat,
    getCloudChatSmart,
    planPartialDownload,
    get power_user_ref() { return power_user; }, // QA/调试: 官方导出对象(人设表)
    listUserPersonas,
    deleteSelectedUserPersonas,
    uploadUserPersonasToCloud,
    downloadUserPersonasFromCloud,
    getLocalConnPresetDebug: _getLocalConnPreset,
    stripPresetSensitiveFields,
    classifyChatDiff,
    readLocalChatMsgs,
    parseJsonlMessages,
    messageSignature,
    pullMergeCloudSuperset,
    getCharChatFileNames,
    currentChatFileName,
    getChatContent,
    listCloudWorldbooks,
    // 分项配置同步
    _connPresetLocalNames,
    pushSelectedConnPresets,
    importSelectedConnPresets,
    deleteSelectedConnPresets,
    fetchSettingsJson,
    _themeLocalList,
    pushSelectedThemes,
    importSelectedThemes,
    deleteSelectedThemes,
    _regexLocalList,
    pushSelectedRegex,
    importSelectedRegex,
    deleteSelectedRegex,
    _userPersonaList,
    backupUserToCloud,
    restoreUserFromCloud,
    setConfig(owner, repo, token) {
        if (owner !== undefined) settings.owner = owner;
        if (repo !== undefined) settings.repo = repo;
        if (token !== undefined) settings.token = token;
        saveSettingsDebounced();
        return this.configured;
    },
    // 基准开关: true→exportChats 阶段A 降级纯串行(读+决策逐条), 仅并发基准用, 默认关
    setBenchSerial(v) { settings.__benchSerial = !!v; saveSettingsDebounced(); return settings.__benchSerial; },
    // 调试: 强制设置生成标志(测试补楼写回时若 __csGenerating 误卡真可清) —— 仅供测试, 平时勿用
    setGenerating(v) { __csGenerating = !!v; return __csGenerating; },
    get generating() { return __csGenerating; },
    get benchSerial() { return Boolean(settings.__benchSerial); },
    // 调试：同步冲突抉择 / 进度条
    resolveUploadConflict,
    showBusy,
    hideBusy,
    get busy() { return __csSyncBusy; },
    getAvatarFor,
    deleteLocalCharacter,
    deleteCharFromCloud,
    get currentCharName() { return currentCharName(); },
    get configured() { return Boolean(settings.owner && settings.repo && settings.token); },
    get lastImport() { return diag.lastRun; },
    chatState(charName) { return chatStateSnapshot(charName || currentCharName() || ''); },
    async loadChat(realFileName, charIdx) { return loadImportedChat(realFileName, charIdx); },
    // 调试：查云端卡 b64 是否完整 → 构建 File → 走 /api/characters/import，报告每步真实结果
    async debugCardImport(charName) {
        const out = { charName };
        try {
            const cardCloud = await __cardGetSmart(`sync/${charName}`);
            out.cloudExists = Boolean(cardCloud?.b64);
            out.b64Len = cardCloud?.b64 ? cardCloud.b64.length : 0;
            if (!cardCloud?.b64) { out.b64Len = 0; return { ...out, ok: false, err: 'no cloud card b64' }; }
            const file = base64ToFile(cardCloud.b64, `${charName}.png`, 'image/png');
            out.fileSize = file.size;
            const head = new Uint8Array(await file.slice(0, 8).arrayBuffer());
            out.fileHeadHex = Array.from(head).map(b => b.toString(16).padStart(2, '0')).join('');
            const buf = new Uint8Array(await file.arrayBuffer());
            out.hasCharaChunk = new TextDecoder('latin1').decode(buf).includes('chara');
            const fd = new FormData();
            fd.append('avatar', file);
            fd.append('file_type', 'png');
            fd.append('user_name', getContext().name1);
            out.user_name = getContext().name1;
            const res = await fetch('/api/characters/import', { method: 'POST', headers: getRequestHeaders({ omitContentType: true }), body: fd, cache: 'no-cache' });
            out.httpStatus = res.status;
            const j = await res.json().catch(() => null);
            out.file_name = j?.file_name;
            out.respSpec = j?.character?.spec;
            out.respDescLen = (j?.character?.data?.description || '').length;
            out.respFirstMesLen = (j?.character?.data?.first_mes || '').length;
            return { ...out, ok: true };
        } catch (e) { return { ...out, ok: false, err: String(e && e.stack || e) }; }
    },
};
