#!/usr/bin/env node
// 弹幕助手：连上直播间，按 data/settings.json 自动发定时弹幕、感谢、关键词回复、开播/下播一句话、休息提醒。
//
//   node index.mjs                 运行
//   node index.mjs login           扫码登录（用来收消息，也默认用它发弹幕）
//   node index.mjs login --sender  单独登录一个发弹幕的小号（settings.json 里 account 改成 "own"）
//   node index.mjs say 你好         手动发一条（走同一个队列和限速）
//   node index.mjs test 你好        不管总开关直接试发一条
//   node index.mjs ai-try [chat]    让 AI 试写一条（换说法 / 插话），只打印不发
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBili, showQrInTerminal, UA } from './src/bili.mjs';
import { connectLive } from './src/live-ws.mjs';
import { createDanmuHelper, DEFAULTS } from './src/danmu-helper.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const cfgPath = path.resolve(DIR, args.includes('--config') ? args[args.indexOf('--config') + 1] : 'config.json');

function log(level, text) { console.log(`${new Date().toLocaleString('sv-SE')} ${level} ${text}`); }

function loadConfig() {
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8').replace(/^﻿/, '')); } catch (e) {
    if (e.code !== 'ENOENT') throw new Error(`${cfgPath} 读不了：${e.message}`);
  }
  const dataDir = path.resolve(DIR, cfg.dataDir || 'data');
  return { room: Number(cfg.room) || 0, dataDir, loginFile: path.resolve(dataDir, cfg.loginFile || 'bili-login.json'),
    senderLoginFile: path.resolve(dataDir, cfg.senderLoginFile || 'sender-login.json'),
    songsFile: cfg.songsFile ? path.resolve(DIR, cfg.songsFile) : path.join(dataDir, 'songs.txt'),
    discordWebhook: cfg.discordWebhook || '',
    // AI（可选）：密钥写在 config.json 的 deepseekKey，或者环境变量 DEEPSEEK_API_KEY；都别提交到 git
    ai: { key: process.env.DEEPSEEK_API_KEY || cfg.deepseekKey || '', model: cfg.aiModel || 'deepseek-flash', baseUrl: cfg.aiBaseUrl || 'https://api.deepseek.com',
      personaFile: cfg.personaFile ? path.resolve(DIR, cfg.personaFile) : '', streamer: cfg.streamer || '主播' },
    confirmPort: cfg.confirmPort === undefined ? 18790 : Number(cfg.confirmPort) || 0 };
}

// 歌单：一行一首。观众问「唱过 xxx 吗」时在这里找。
function songFinder(file) {
  let list = [], mtime = -1;
  return name => {
    try {
      const m = fs.statSync(file).mtimeMs;
      if (m !== mtime) { mtime = m; list = fs.readFileSync(file, 'utf8').split(/\r?\n/).map(x => x.trim()).filter(Boolean); }
    } catch { list = []; }
    const key = s => s.toLowerCase().replace(/[\s《》「」"“”'’]/g, '');
    const q = key(name);
    return list.find(x => key(x) === q) || list.find(x => key(x).includes(q) && q.length >= 2) || null;
  };
}

// 人设文件：纯文本，# 开头的行不算
const readPersona = file => { if (!file) return ''; try { return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(l => !l.trim().startsWith('#')).join('\n').trim(); } catch { return ''; } };

// AI 写好的弹幕在这个本机小页面确认：http://127.0.0.1:端口/
const CONFIRM_PAGE = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>弹幕确认</title>
<style>:root{--bg:#f6f6f8;--fg:#222;--mut:#777;--line:#ddd;--acc:#6c4fb3}@media (prefers-color-scheme:dark){:root{--bg:#18171d;--fg:#eee;--mut:#999;--line:#333;--acc:#a78bfa}}
body{margin:0;padding:16px;background:var(--bg);color:var(--fg);font:15px/1.6 system-ui,"Microsoft YaHei",sans-serif}.card{max-width:520px;margin:0 auto;border:1px solid var(--line);border-radius:12px;padding:14px}
.mut{color:var(--mut);font-size:13px}.row{display:flex;gap:6px;margin-top:8px}input{flex:1;min-width:0;padding:8px;border:1px solid var(--line);border-radius:8px;background:transparent;color:inherit;font:inherit}
button{display:inline-flex;align-items:center;justify-content:center;padding:8px 10px;border:1px solid var(--line);border-radius:8px;background:transparent;color:var(--acc);cursor:pointer}button.go{background:var(--acc);color:#fff;border-color:var(--acc)}svg{width:16px;height:16px}</style></head>
<body><div class="card" id="c"><span class="mut">没有等确认的弹幕</span></div><script>
const I={send:'<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2 7 9"/><path d="M14 2 9.5 14 7 9 2 6.5z"/></svg>',redo:'<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9"/><path d="M13.5 2.5v3h-3"/></svg>',no:'<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="m4 4 8 8M12 4l-8 8"/></svg>'};
let cur=null;const c=document.getElementById('c');
const esc=t=>String(t).replace(/[&<>"]/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[m]);
async function act(a){const t=document.getElementById('t');const r=await (await fetch('/pending',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:cur.id,action:a,text:a==='send'?t.value:undefined})})).json();if(!r.ok)alert(r.error);cur=null;poll();}
function draw(p){if(!p){cur=null;c.innerHTML='<span class="mut">没有等确认的弹幕</span>';return}if(cur&&cur.id===p.id&&cur.text===p.text){tick();return}cur=p;
c.innerHTML='<b>'+esc(p.kind)+'</b> <span class="mut" id="left"></span>'+(p.original?'<div class="mut">原句：'+esc(p.original)+'</div>':'')+'<div class="row"><input id="t" maxlength="40" value="'+esc(p.text)+'"><button class="go" title="发送" onclick="act(&quot;send&quot;)">'+I.send+'</button><button title="换一条" onclick="act(&quot;redo&quot;)">'+I.redo+'</button><button title="不用" onclick="act(&quot;original&quot;)">'+I.no+'</button></div>';tick()}
function tick(){const l=document.getElementById('left');if(cur&&l){const s=Math.max(0,Math.ceil((cur.until-Date.now())/1000));l.textContent=s+' 秒后'+(cur.original?'发原句':'不发')}}
async function poll(){try{draw((await (await fetch('/pending')).json()).pending)}catch{}}
setInterval(poll,2000);setInterval(tick,1000);poll();
</script></body></html>`;
function startConfirmPage(port, helper) {
  const server = http.createServer(async (req, res) => {
    const send = (code, body, type = 'application/json; charset=utf-8') => { res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(typeof body === 'string' ? body : JSON.stringify(body)); };
    try {
      if (req.method === 'GET' && req.url === '/') return send(200, CONFIRM_PAGE, 'text/html; charset=utf-8');
      if (req.method === 'GET' && req.url === '/pending') { const p = helper.status().pending; return send(200, { pending: p?.until > Date.now() ? p : null }); }
      if (req.method === 'POST' && req.url === '/pending') {
        // 只接受本页面发来的请求：别的网页跨站 POST 会带别的 Origin
        const origin = req.headers.origin;
        if (origin && origin !== `http://127.0.0.1:${port}` && origin !== `http://localhost:${port}`) return send(403, { ok: false, error: '来源不对' });
        let raw = ''; for await (const c of req) raw += c;
        const b = JSON.parse(raw || '{}');
        try { return send(200, { ok: true, pending: await helper.pendingAction(String(b.id ?? ''), String(b.action ?? ''), b.text) }); }
        catch (e) { return send(200, { ok: false, error: e.message }); }
      }
      send(404, { ok: false });
    } catch (e) { send(500, { ok: false, error: e.message }); }
  });
  server.on('error', e => log('WARNING', `弹幕确认页没开起来（端口 ${port}）：${e.message}`));
  server.listen(port, '127.0.0.1', () => log('INFO', `AI 写的弹幕在这里确认：http://127.0.0.1:${port}/`));
}

async function discord(url, text) {
  if (!url) return;
  try { await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: '弹幕助手', content: text }), signal: AbortSignal.timeout(15000) }); }
  catch (e) { log('WARNING', `Discord 提醒没发出去：${e.message}`); }
}

async function main() {
  const cfg = loadConfig();
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  const bili = createBili({ loginFile: cfg.loginFile, log });

  if (args[0] === 'login') {
    const file = args.includes('--sender') ? cfg.senderLoginFile : cfg.loginFile;
    const { uid } = await bili.qrLogin(showQrInTerminal, { file });
    log('INFO', `登录成功（UID ${uid}），存在 ${file}`);
    return;
  }
  if (!cfg.room) throw new Error(`先在 ${cfgPath} 里写上直播间号：{"room": 房间号}（可以照 config.example.json 抄）`);

  // 开播状态：每 30 秒查一次；连续两次「没在播」才算下播，第一次查到的状态只记下不触发
  const live = { on: false, since: 0, known: false, offline: 0, title: '', area: '' };
  let helper;
  async function pollLive() {
    try {
      const j = await bili.getJson(`https://api.live.bilibili.com/room/v1/Room/get_info?room_id=${cfg.room}`, { Referer: `https://live.bilibili.com/${cfg.room}` });
      if (j.code !== 0) throw new Error(`${j.code} ${j.message}`);
      const on = j.data.live_status === 1;
      live.title = j.data.title || ''; live.area = j.data.area_name || '';
      const since = on ? Date.parse(String(j.data.live_time).replace(' ', 'T') + '+08:00') || Date.now() : 0;
      if (!live.known) { Object.assign(live, { known: true, on, since }); log('INFO', `直播间 ${cfg.room} ${on ? '正在直播' : '没在播'}`); return; }
      if (on) {
        live.offline = 0;
        if (!live.on) { Object.assign(live, { on: true, since }); log('INFO', '开播了'); helper.liveStart(); }
        else live.since = since || live.since;
      } else if (live.on && ++live.offline >= 2) {
        Object.assign(live, { on: false, since: 0 }); log('INFO', '下播了'); helper.liveEnd();
      }
    } catch (e) { log('WARNING', `查开播状态失败：${e.message}`); }
  }

  helper = createDanmuHelper({
    dir: cfg.dataDir, roomId: cfg.room, UA, log,
    isLive: () => live.on, liveSince: () => live.since,
    findSong: songFinder(cfg.songsFile),
    botCookie: () => bili.currentLogin()?.cookie ?? '',
    ownLoginFile: cfg.senderLoginFile,
    alert: text => discord(cfg.discordWebhook, text),
    ai: { key: () => cfg.ai.key, persona: () => readPersona(cfg.ai.personaFile), info: () => ({ title: live.title, area: live.area }),
      model: cfg.ai.model, baseUrl: cfg.ai.baseUrl, streamer: cfg.ai.streamer },
  });
  const settingsFile = path.join(cfg.dataDir, 'settings.json');
  if (!fs.existsSync(settingsFile)) {
    fs.writeFileSync(settingsFile, JSON.stringify(DEFAULTS, null, 2));
    log('INFO', `已生成 ${settingsFile}：所有功能默认关着，打开 enabled 和想用的功能后保存，不用重启`);
  }

  if (args[0] === 'ai-try') {
    await pollLive();
    const r = await helper.aiTry(args[1] === 'chat' ? 'chat' : 'timed');
    log('INFO', r.original ? `原句「${r.original}」→「${r.text}」` : r.text);
    process.exit(0);
  }
  if (args[0] === 'say' || args[0] === 'test') {
    const text = args.slice(1).filter(x => x !== '--config' && x !== args[args.indexOf('--config') + 1]).join(' ');
    const r = args[0] === 'test' ? await helper.test(text) : await helper.manual(text, undefined, '命令行');
    log('INFO', r || '已发出');
    process.exit(0);
  }

  if (!bili.currentLogin()) log('WARNING', '还没登录B站：收到的名字会被打码，也发不了弹幕。运行 node index.mjs login 扫码登录');
  await pollLive();
  setInterval(pollLive, 30e3);
  connectLive({ bili, roomId: cfg.room, log, onEvent: ev => helper.event(ev) });
  setInterval(() => helper.tick(), 15e3);
  if (cfg.confirmPort) startConfirmPage(cfg.confirmPort, helper);
  log('INFO', `弹幕助手在跑：直播间 ${cfg.room}，设置文件 ${settingsFile}`);
}

main().catch(e => { log('ERROR', e.message); process.exit(1); });
