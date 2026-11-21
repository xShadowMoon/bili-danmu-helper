// 弹幕助手：往直播间自动发弹幕。
// 设置在 settings.json（改完下一轮就生效，不用重启），运行情况写进 status.json。
// 功能：定时弹幕、感谢礼物 / 上舰 / SC / 关注、关键词自动回复、开播 / 下播一句话、开播满一小时提醒休息、观众问「唱过 xxx 吗」查歌切。
// 任何一句话都可以用「||」写几种说法：B站把第一种吞了（只有自己看得到），就自动换下一种再发。
// 所有弹幕统一排队：两条之间至少隔几秒、每场有总上限、B站报错就暂停一会儿，连续出错发提醒。
// 发弹幕用哪个号：account = 'bot'（主登录 bili-login.json，也用来收直播间消息）或 'own'（单独登录的发弹幕小号，sender-login.json）。
import fs from 'node:fs';
import path from 'node:path';

export const DEFAULTS = {
  enabled: false,            // 总开关：关着时什么都不发。每个功能也都默认关着，要自己打开
  account: 'bot',
  maxLen: 0,                 // 一条弹幕最多几个字：0 = 自动（问B站这个号在这个直播间能发多长），太长自动拆成几条
  safety: { minGapSec: 6, maxPerStream: 150, pauseMinOnError: 10 },
  timed: { enabled: false, onlyLive: true, intervalMin: 15, order: 'random', lines: ['喝水小助手提醒主播该喝水了'] },
  thanks: {
    gift: { enabled: false, minYuan: 1, mergeSec: 8, template: '谢谢{name}的{gift}×{num}～' },
    guard: { enabled: false, template: '感谢{name}开通{gift}！欢迎上船～' },
    sc: { enabled: false, template: '谢谢{name}的醒目留言～' },
    follow: { enabled: false, mergeSec: 30, template: '谢谢{name}的关注～' },
  },
  replies: { enabled: false, cooldownSec: 60, userCooldownSec: 30, rules: [
    { keys: ['歌单', '唱过什么'], reply: '歌单在主播的动态置顶里～' },
  ] },
  liveStart: { enabled: false, delaySec: 30, text: '开播啦，大家好～' },
  liveEnd: { enabled: false, text: '今天辛苦啦，晚安，下次见～' },
  // 开播满一段时间提醒休息：{hours} 是播了几小时、{minutes} 是几分钟
  breakReminder: { enabled: false, everyMin: 60, text: '已经播了{hours}小时啦，起来活动一下、喝口水～' },
  // 观众问「唱过晴天吗」「晴天唱过没」：查歌单（songs.txt），{song} 是歌名
  songAsk: { enabled: false, cooldownSec: 30, yes: '唱过《{song}》！', no: '还没唱过《{song}》～' },
};

const merge = (base, over) => {
  if (Array.isArray(base) || typeof base !== 'object' || base === null) return over === undefined ? base : over;
  const out = { ...base };
  for (const k of Object.keys(over ?? {})) out[k] = k in base ? merge(base[k], over[k]) : over[k];
  return out;
};
const fill = (tpl, v) => String(tpl).replace(/\{(\w+)\}/g, (_, k) => v[k] ?? '');
// 按字数拆成几条（尽量在标点处断开）
export function splitDanmu(text, max) {
  const chars = [...String(text).replace(/\s+/g, ' ').trim()], out = [];
  while (chars.length > max) {
    let cut = max;
    for (let i = max; i > max * 0.5; i--) if (/[，。！？、,.!?~～ ]/.test(chars[i - 1])) { cut = i; break; }
    out.push(chars.splice(0, cut).join('').trim());
  }
  if (chars.length) out.push(chars.join('').trim());
  return out.filter(Boolean);
}

// 关键词回复只回「在问」的弹幕：要么带问句的词（吗、多少、怎么、有没有、？…），要么整条就是这个词（「群号」「加群」）。
// 「明天再进群聊」只是提到进群，不回。关键词前面加「=」表示只要出现就回，不管是不是在问。
const ASK_WORDS = /[?？]|吗|嘛|么|呢|多少|几|哪|什么|啥|怎么|如何|有没有|有无|求|能不能|可以|在哪/;
export function keyHit(text, key) {
  let k = String(key ?? '').trim().toLowerCase();
  if (!k) return false;
  const any = k.startsWith('=') || k.startsWith('＝');
  if (any) k = k.slice(1).trim();
  k = k.replace(/\s+/g, '');
  const t = String(text).toLowerCase().replace(/\s+/g, '');
  if (!k || !t.includes(k)) return false;
  return any || ASK_WORDS.test(t.replace(k, '')) || [...t].length <= [...k].length + 2;
}

// 从弹幕里认出「唱过 xxx 吗」问的是哪首歌
export function songAskOf(text) {
  const t = String(text).replace(/^\s*(?:主播|姐姐|哥哥|你|请问|问一下|想问)\s*/, '').trim();
  const m = t.match(/^(?:有没有|是否|之前)?\s*唱过\s*[《「“"]?(.{1,20}?)[》」”"]?\s*(?:吗|嘛|么|没|没有|不)\s*[?？!！~～]*$/) ??
    t.match(/^[《「“"]?(.{1,20}?)[》」”"]?\s*(?:有没有|有|你)?\s*唱过\s*(?:吗|嘛|么|没|没有|不)\s*[?？!！~～]*$/);
  const song = m?.[1]?.replace(/^(?:这首|那首)|(?:这首歌|这歌|的歌|这首)$/g, '').trim();
  return song && song.length >= 1 && !/^(什么|啥|哪些|哪首|几首)/.test(song) ? song : '';
}

export function createDanmuHelper({ dir, roomId, isLive, liveSince = () => 0, findSong = () => null, botCookie, log, alert, UA,
  settingsFile = path.join(dir, 'settings.json'), statusFile = path.join(dir, 'status.json'), ownLoginFile = path.join(dir, 'sender-login.json') }) {
  const SETTINGS = settingsFile, STATUS = statusFile, OWN = ownLoginFile;
  let settings = DEFAULTS, settingsMtime = -1;
  const status = { sent: [], errors: [], recentDm: [], session: { start: 0, count: 0 }, pausedUntil: 0, lastTimedAt: 0, failStreak: 0, today: { day: '', count: 0 }, breakN: 0, breakFor: 0 };
  try { Object.assign(status, JSON.parse(fs.readFileSync(STATUS, 'utf8'))); } catch {}
  const queue = [];
  let sending = false, lastSentAt = 0, timedIdx = -1, myUid = '';
  const room = () => (typeof roomId === 'function' ? roomId() : roomId);
  // 这个号在这个直播间一条弹幕最多能发几个字（B站按等级和粉丝牌给）。
  // 问这个接口在B站算「进直播间」，会出现在进房记录里，所以问得越少越好：
  // 查到的数存进状态文件，重启沿用；只在直播中、而且没查过 / 换了账号 / 超过 7 天才再问一次。
  const limit = { n: 0, at: 0, account: '', ...(status.lengthLimit ?? {}) };
  async function refreshLimit() {
    const account = load().account;
    if (!isLive() || (limit.n && limit.account === account && Date.now() - limit.at < 7 * 86400e3)) return;
    if (Date.now() - (limit.triedAt ?? 0) < 3600e3) return;   // 查失败了也别每分钟重试
    limit.triedAt = Date.now();
    try {
      const j = await (await fetch(`https://api.live.bilibili.com/xlive/web-room/v1/index/getInfoByUser?room_id=${room()}&from=0`, { headers: { Cookie: cookie(), 'User-Agent': UA, Referer: `https://live.bilibili.com/${room()}` }, signal: AbortSignal.timeout(10000) })).json();
      const n = Number(j.data?.property?.danmu?.length) || 0;
      if (n) { Object.assign(limit, { n, at: Date.now(), account }); status.lengthLimit = { n, at: limit.at, account }; saveStatus(); }
    } catch {}
  }

  function load() {
    try {
      const m = fs.statSync(SETTINGS).mtimeMs;
      if (m !== settingsMtime) { settingsMtime = m; settings = merge(DEFAULTS, JSON.parse(fs.readFileSync(SETTINGS, 'utf8').replace(/^﻿/, ''))); }
    } catch { if (settingsMtime !== 0) { settingsMtime = 0; settings = DEFAULTS; try { fs.writeFileSync(SETTINGS, JSON.stringify(DEFAULTS, null, 2)); } catch {} } }
    return settings;
  }
  function saveStatus() {
    status.queue = queue.length; status.maxLen = limit.n;
    try { const tmp = STATUS + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(status, null, 1)); fs.renameSync(tmp, STATUS); } catch {}
  }
  function cookie() {
    if (load().account === 'own') { try { return JSON.parse(fs.readFileSync(OWN, 'utf8')).cookie || ''; } catch { return ''; } }
    return botCookie() || '';
  }

  async function sendNow(text, roomOverride) {
    const rid = roomOverride || room();
    const ck = cookie(), csrf = ck.match(/bili_jct=([^;]+)/)?.[1];
    if (!csrf) throw Object.assign(new Error(settings.account === 'own' ? '发弹幕的账号还没登录（运行 node index.mjs login --sender）' : 'B站账号还没登录（运行 node index.mjs login）'), { fatal: true });
    myUid = ck.match(/DedeUserID=(\d+)/)?.[1] || myUid;
    const body = new URLSearchParams({ bubble: '0', msg: text, color: '16777215', mode: '1', room_type: '0', jumpfrom: '0', reply_mid: '0', reply_attr: '0',
      replay_dmid: '', statistics: '{"appId":100,"platform":5}', fontsize: '25', rnd: String(Math.floor(Date.now() / 1000)), roomid: String(rid), csrf, csrf_token: csrf });
    const r = await fetch('https://api.live.bilibili.com/msg/send', { method: 'POST', body,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: ck, 'User-Agent': UA, Origin: 'https://live.bilibili.com', Referer: `https://live.bilibili.com/${rid}` },
      signal: AbortSignal.timeout(15000) });
    const j = await r.json().catch(() => ({ code: r.status, message: `HTTP ${r.status}` }));
    if (j.code !== 0) throw Object.assign(new Error(`B站拒绝了（${j.code} ${j.message || j.msg || ''}）`), { code: j.code });
    // code 0 但 message 不为空：多半是被B站屏蔽词吞了，别人看不到
    return j.message || j.msg ? `已发出，但B站提示「${j.message || j.msg}」（可能被屏蔽词拦了）` : '';
  }

  const failManual = msg => { for (const j of queue) j.fail?.(new Error(msg)); };
  async function pump() {
    if (sending) return;
    sending = true;
    try {
      while (queue.length) {
        const s = load();
        // 总开关关着：自动的都不发，手动发的照常排队
        if (!s.enabled) { for (let i = queue.length - 1; i >= 0; i--) if (!queue[i].manual) queue.splice(i, 1); if (!queue.length) break; }
        if (Date.now() < status.pausedUntil) { failManual(`弹幕助手出错后暂停中，${Math.ceil((status.pausedUntil - Date.now()) / 60e3)} 分钟后再试`); break; }
        if (status.session.count >= s.safety.maxPerStream) { log('WARNING', `弹幕助手：这场已经发了 ${status.session.count} 条，到上限了，先不发`); failManual(`这场已经发了 ${status.session.count} 条，到每场上限了`); queue.length = 0; break; }
        const wait = lastSentAt + s.safety.minGapSec * 1000 - Date.now();
        if (wait > 0) await new Promise(r => setTimeout(r, wait));
        const job = queue.shift();
        try {
          const note = await sendNow(job.text, job.room);
          lastSentAt = Date.now(); status.failStreak = 0; status.session.count++;
          const day = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
          if (status.today.day !== day) status.today = { day, count: 0 };
          status.today.count++;
          status.sent.unshift({ t: Date.now(), kind: job.kind, text: job.text, note: note || undefined, filtered: !!note || undefined }); status.sent.length = Math.min(status.sent.length, 60);
          log('INFO', `弹幕助手：发了「${job.text}」（${job.kind}）${note ? '，' + note : ''}`);
          job.done?.(note);
          // 被 B站吞了，而且写了备用说法：换下一种马上再发（排在队伍最前面）
          if (note && job.alts?.length) { queue.unshift({ text: job.alts[0], kind: job.kind.replace(/（备用写法）$/, '') + '（备用写法）', alts: job.alts.slice(1) }); log('INFO', `弹幕助手：换备用写法「${job.alts[0]}」再发`); }
        } catch (e) {
          lastSentAt = Date.now(); status.failStreak++;
          status.errors.unshift({ t: Date.now(), text: job.text, error: e.message }); status.errors.length = Math.min(status.errors.length, 30);
          log('WARNING', `弹幕助手：「${job.text}」没发出去：${e.message}`);
          job.fail?.(e);
          // 发太快 / 被禁言 / 没登录：暂停一会儿，别越发越糟
          if (e.fatal || status.failStreak >= 2) { status.pausedUntil = Date.now() + (e.fatal ? 30 : s.safety.pauseMinOnError) * 60e3; failManual('弹幕助手连续出错，先暂停一会儿'); queue.length = 0; }
          if (status.failStreak === 3 || e.fatal) alert?.(`⚠️ 弹幕助手发不出弹幕了：${e.message}。先暂停 ${e.fatal ? 30 : s.safety.pauseMinOnError} 分钟，之后自动再试。`);
        }
        saveStatus();
      }
    } finally { sending = false; saveStatus(); }
  }
  function say(text, kind) {
    const s = load();
    if (!s.enabled || !text) return;
    // 「说法1 || 说法2 || 说法3」：先发第一种，被吞了再换下一种（太长要拆开的话就不换了）
    const [first, ...alts] = String(text).split(/\s*\|\|\s*/).map(x => x.trim()).filter(Boolean);
    if (!first) return;
    const parts = splitDanmu(first, Math.max(5, Number(s.maxLen) || limit.n || 20));
    for (const part of parts) queue.push({ text: part, kind, alts: parts.length === 1 ? alts : [] });
    if (queue.length > 20) queue.splice(0, queue.length - 20);   // 排太多说明来不及发了，丢掉最早的
    pump();
  }

  // 感谢合并：同一个人同一种礼物几秒内连着送，合成一条；关注几十秒内的合成一条
  const giftBuf = new Map(), followBuf = { names: [], timer: null };
  function onGift(ev) {
    const g = load().thanks.gift;
    if (!g.enabled) return;
    const key = `${ev.uid}|${ev.name}`, cur = giftBuf.get(key) ?? { ...ev, num: 0, yuan: 0 };
    cur.num += Number(ev.num) || 1; cur.yuan += Number(ev.yuan) || 0;
    clearTimeout(cur.timer);
    cur.timer = setTimeout(() => { giftBuf.delete(key); if (cur.yuan >= g.minYuan) say(fill(g.template, { name: cur.uname, gift: cur.name, num: cur.num }), '感谢礼物'); }, g.mergeSec * 1000);
    giftBuf.set(key, cur);
  }
  function onFollow(ev) {
    const f = load().thanks.follow;
    if (!f.enabled || !ev.uname) return;
    if (!followBuf.names.includes(ev.uname)) followBuf.names.push(ev.uname);
    if (followBuf.timer) return;
    followBuf.timer = setTimeout(() => {
      const names = followBuf.names.splice(0); followBuf.timer = null;
      const who = names.length > 2 ? `${names.slice(0, 2).join('、')}等${names.length}人` : names.join('、');
      say(fill(f.template, { name: who }), '感谢关注');
    }, f.mergeSec * 1000);
  }
  const ruleAt = new Map(), userAt = new Map();
  function onDanmu(ev) {
    const r = load().replies;
    myUid = cookie().match(/DedeUserID=(\d+)/)?.[1] || myUid;   // 自己发的弹幕不回
    if (!ev.text || String(ev.uid) === String(myUid)) return;
    if (Date.now() - (userAt.get(String(ev.uid)) ?? 0) < (r.userCooldownSec ?? 30) * 1000) return;
    const sa = settings.songAsk, song = sa.enabled ? songAskOf(ev.text) : '';
    if (song) {
      if (Date.now() - (ruleAt.get('song') ?? 0) < sa.cooldownSec * 1000) return;
      ruleAt.set('song', Date.now()); userAt.set(String(ev.uid), Date.now());
      const hit = findSong(song);
      say(fill(hit ? sa.yes : sa.no, { song: hit || song, name: ev.uname }), '唱过吗');
      return;
    }
    if (!r.enabled) return;
    const text = String(ev.text).toLowerCase();
    for (const [i, rule] of (r.rules ?? []).entries()) {
      if (!rule.reply || !(rule.keys ?? []).some(k => keyHit(text, k))) continue;
      if (Date.now() - (ruleAt.get(i) ?? 0) < r.cooldownSec * 1000) return;
      ruleAt.set(i, Date.now()); userAt.set(String(ev.uid), Date.now());
      say(fill(rule.reply, { name: ev.uname }), '自动回复');
      return;
    }
  }

  return {
    // 直播间收到的消息：type = dm / gift / guard / sc / follow
    event(ev) {
      try {
        if (ev.type === 'dm' && ev.text) {
          status.recentDm.unshift({ t: Date.now(), uname: ev.uname, text: String(ev.text).slice(0, 60), me: String(ev.uid) === String(myUid) || undefined });
          status.recentDm.length = Math.min(status.recentDm.length, 60);
          if (Date.now() - (status.dmSavedAt ?? 0) > 3000) { status.dmSavedAt = Date.now(); saveStatus(); }
        }
        if (!load().enabled) return;
        if (ev.type === 'dm') onDanmu(ev);
        else if (ev.type === 'gift') onGift(ev);
        else if (ev.type === 'follow') onFollow(ev);
        else if (ev.type === 'guard' && settings.thanks.guard.enabled) say(fill(settings.thanks.guard.template, { name: ev.uname, gift: ev.name || '舰长' }), '感谢上舰');
        else if (ev.type === 'sc' && settings.thanks.sc.enabled) say(fill(settings.thanks.sc.template, { name: ev.uname }), '感谢SC');
      } catch (e) { log('WARNING', `弹幕助手处理消息出错：${e.message}`); }
    },
    liveStart() {
      status.session = { start: Date.now(), count: 0 }; status.lastTimedAt = Date.now(); saveStatus();
      const s = load().liveStart;
      if (s.enabled) setTimeout(() => say(s.text, '开播'), s.delaySec * 1000);
    },
    liveEnd() { const s = load().liveEnd; if (s.enabled) say(s.text, '下播'); },
    // 每 15 秒跑一次：定时弹幕
    tick() {
      const s = load(), t = s.timed;
      if (s.enabled) refreshLimit();
      const br = s.breakReminder, since = liveSince();
      if (s.enabled && br.enabled && since && isLive()) {
        const every = Math.max(10, Number(br.everyMin) || 60), n = Math.floor((Date.now() - since) / (every * 60e3));
        if (status.breakFor !== since) { status.breakFor = since; status.breakN = n; }   // 换了一场（或者中途重启）：从现在这一档开始算，不补发
        else if (n > status.breakN) {
          status.breakN = n;
          const mins = n * every, hours = mins % 60 === 0 ? String(mins / 60) : (mins / 60).toFixed(1);
          say(fill(br.text, { hours, minutes: mins }), '休息提醒');
        }
      }
      if (!s.enabled || !t.enabled || !t.lines?.length) return saveStatus();
      if (t.onlyLive && !isLive()) return saveStatus();
      // 从开播那一刻开始算：刚开播不发，满一个间隔才发第一条；中途重启也照开播时间接着算
      if (since && status.lastTimedAt < since) status.lastTimedAt = since;
      const every = Math.max(0.5, Number(t.intervalMin) || 15) * 60e3, last = status.lastTimedAt;
      if (Date.now() - last < every) return;
      // 按开播时间对齐：下一条记成「该发的时刻」而不是「实际发出的时刻」，不会每次晚几十秒越拖越晚
      status.lastTimedAt = Date.now() - last < every * 2 ? last + every : Date.now();
      const lines = t.lines.filter(l => String(l).trim());
      if (!lines.length) return;
      if (t.order === 'seq') timedIdx = (timedIdx + 1) % lines.length;
      else { let i; do { i = Math.floor(Math.random() * lines.length); } while (lines.length > 1 && i === timedIdx); timedIdx = i; }
      say(lines[timedIdx], '定时弹幕');
    },
    // test：不管总开关，直接发一条试试
    // manual：手动发一条，和自动弹幕共用队列、间隔、每场上限和出错暂停；总开关关着也发。
    // 12 秒内发出就返回结果，否则返回还在排第几。room 可以指定别的直播间。
    manual(text, roomOverride, from = '手动') {
      const msg = String(text ?? '').replace(/\s+/g, ' ').trim();
      if (!msg) return Promise.reject(new Error('没写内容'));
      if ([...msg].length > 40) return Promise.reject(new Error('最多 40 字'));
      if (Date.now() < status.pausedUntil) return Promise.reject(new Error(`弹幕助手出错后暂停中，${Math.ceil((status.pausedUntil - Date.now()) / 60e3)} 分钟后再试`));
      return new Promise((resolve, reject) => {
        const job = { text: msg, kind: '手动（' + from + '）', manual: true, room: roomOverride || undefined,
          done: note => { clearTimeout(timer); resolve(note ? 'B站提示：' + note : '已发出'); }, fail: e => { clearTimeout(timer); reject(e); } };
        const timer = setTimeout(() => { job.done = job.fail = null; resolve(`排队中，第 ${Math.max(1, queue.indexOf(job) + 1)} 条`); }, 12000);
        queue.push(job);
        pump();
      });
    },
    async test(text) { const note = await sendNow(String(text).slice(0, 40)); log('INFO', `弹幕助手：试发了「${text}」`); return note; },
    status: () => ({ ...status, queue: queue.length, maxLen: limit.n }),
  };
}
