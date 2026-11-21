#!/usr/bin/env node
// 弹幕助手：连上直播间，按 data/settings.json 自动发定时弹幕、感谢、关键词回复、开播/下播一句话、休息提醒。
//
//   node index.mjs                 运行
//   node index.mjs login           扫码登录（用来收消息，也默认用它发弹幕）
//   node index.mjs login --sender  单独登录一个发弹幕的小号（settings.json 里 account 改成 "own"）
//   node index.mjs say 你好         手动发一条（走同一个队列和限速）
//   node index.mjs test 你好        不管总开关直接试发一条
import fs from 'node:fs';
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
    discordWebhook: cfg.discordWebhook || '' };
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
  const live = { on: false, since: 0, known: false, offline: 0 };
  let helper;
  async function pollLive() {
    try {
      const j = await bili.getJson(`https://api.live.bilibili.com/room/v1/Room/get_info?room_id=${cfg.room}`, { Referer: `https://live.bilibili.com/${cfg.room}` });
      if (j.code !== 0) throw new Error(`${j.code} ${j.message}`);
      const on = j.data.live_status === 1;
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
  });
  const settingsFile = path.join(cfg.dataDir, 'settings.json');
  if (!fs.existsSync(settingsFile)) {
    fs.writeFileSync(settingsFile, JSON.stringify(DEFAULTS, null, 2));
    log('INFO', `已生成 ${settingsFile}：所有功能默认关着，打开 enabled 和想用的功能后保存，不用重启`);
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
  log('INFO', `弹幕助手在跑：直播间 ${cfg.room}，设置文件 ${settingsFile}`);
}

main().catch(e => { log('ERROR', e.message); process.exit(1); });
