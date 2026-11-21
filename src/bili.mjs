// Bilibili web API helpers: visitor cookie activation, WBI signing, optional QR-code login.
// B站网页接口：访客 cookie 激活、WBI 签名、可选的扫码登录。登录信息只存在本地 loginFile 里。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
export const MIXIN_TAB = [46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
  37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52];
// Fingerprint parameters the dynamic feed expects from a browser.
export const DM = {
  dm_img_list: '[]',
  dm_img_str: 'V2ViR0wgMS4wIChPcGVuR0wgRVMgMi4wIENocm9taXVtKQ',
  dm_cover_img_str: 'QU5HTEUgKE5WSURJQSwgTlZJRElBIEdlRm9yY2UgUlRYIDQwNjAgTGFwdG9wIEdQVSAoMHgwMDAwMjhFMCkgRGlyZWN0M0QxMSB2c181XzAgcHNfNV8wLCBEM0QxMSlHb29nbGUgSW5jLiAoTlZJRElBKQ',
  dm_img_inter: '{"ds":[],"wh":[0,0,0],"of":[0,0,0]}',
};
const KEEP_COOKIES = ['SESSDATA', 'bili_jct', 'DedeUserID', 'DedeUserID__ckMd5', 'sid'];
const sleep = ms => new Promise(r => setTimeout(r, ms));

export function mixinKeyOf(imgUrl, subUrl) {
  const key = u => String(u).split('/').pop().split('.')[0];
  const raw = key(imgUrl) + key(subUrl);
  return MIXIN_TAB.map(i => raw[i]).join('').slice(0, 32);
}

export function signWbiWith(mixinKey, params, now = Date.now()) {
  const p = { ...params, wts: Math.floor(now / 1000) };
  const query = Object.keys(p).sort().map(k =>
    `${encodeURIComponent(k)}=${encodeURIComponent(String(p[k]).replace(/[!'()*]/g, ''))}`).join('&');
  return query + '&w_rid=' + crypto.createHash('md5').update(query + mixinKey).digest('hex');
}

export function createBili({ loginFile, log = () => {}, fetchImpl = globalThis.fetch, wait = sleep } = {}) {
  let cookie = '', mixinKey = '', keysAt = 0, emptyStreak = 0;
  let login = null, loginMtime = -1, loginBad = false, announced = false;

  async function getJson(url, headers = {}, init = {}) {
    const res = await fetchImpl(url, { headers: { 'User-Agent': UA, ...headers }, signal: AbortSignal.timeout(15000), ...init });
    const text = await res.text();
    try { return JSON.parse(text); } catch {
      throw new Error(`B站返回了网页而不是数据（HTTP ${res.status}，${url.split('?')[0]}），可能是请求太频繁被限制了`);
    }
  }

  // The saved login, or null. Re-reads the file when it changes.
  function currentLogin() {
    let mtime = 0;
    try { mtime = loginFile ? fs.statSync(loginFile).mtimeMs : 0; } catch {}
    if (mtime !== loginMtime) {
      loginMtime = mtime;
      try { login = mtime ? JSON.parse(fs.readFileSync(loginFile, 'utf8').replace(/^﻿/, '')) : null; } catch { login = null; }
      loginBad = false; announced = false; keysAt = 0;
    }
    return login?.cookie && !loginBad ? login : null;
  }

  const headersFor = (mid, tab = 'video') => ({ Cookie: cookie, Referer: `https://space.bilibili.com/${mid}/${tab}`, Origin: 'https://space.bilibili.com' });

  // Get a visitor cookie like the website does and "activate" it, otherwise the feed API returns empty lists.
  async function refreshKeys(mid = 2) {
    const hex = n => crypto.randomBytes(n).toString('hex').toUpperCase();
    const spi = await getJson('https://api.bilibili.com/x/frontend/finger/spi');
    const uuid = `${hex(4)}-${hex(2)}-${hex(2)}-${hex(2)}-${hex(6)}${String(Date.now() % 100000).padStart(5, '0')}infoc`;
    const visitor = `buvid3=${spi.data.b_3}; buvid4=${encodeURIComponent(spi.data.b_4)}; b_nut=${Math.floor(Date.now() / 1000)}; ` +
      `_uuid=${uuid}; buvid_fp=${crypto.randomBytes(16).toString('hex')}`;
    const lg = currentLogin();
    cookie = lg ? `${lg.cookie}; ${visitor}` : visitor;
    const payload = JSON.stringify({
      '3064': 1, '5062': Date.now(), '03bf': 'https://www.bilibili.com/', '39c8': '333.1387.fp.risk', '34f1': '', 'd402': '', '654a': '',
      '6e7c': '1920x1080',
      '3c43': { '2673': 0, '5766': 24, '6527': 0, '7003': 1, '807e': 1, 'b8ce': UA, '641c': 0, '07a4': 'zh-CN', '1c57': 8, '0bd0': 8,
        '748e': [1920, 1080], 'd61f': [1920, 1040], 'fc9d': -480, '6aa9': 'Asia/Shanghai', '75b8': 1, '3b21': 1, '8a1c': 0,
        'd52f': 'not available', 'adca': 'Win32', '80c9': [], '13ab': '', 'bfe9': '', 'a3c1': [], '6bc5': '', 'ed31': 0, '72bd': 0,
        '097b': 0, '52cd': [0, 0, 0], 'a658': [], 'd02f': '124.04347527516074' },
      '54ef': '{"in_new_ab":true,"ab_version":{},"ab_split_num":{}}', '8b94': '', 'df35': uuid, '07a4': 'zh-CN', '5f45': null, 'db46': 0,
    });
    await getJson('https://api.bilibili.com/x/internal/gaia-gateway/ExClimbWuzhi',
      { ...headersFor(mid), 'Content-Type': 'application/json' }, { method: 'POST', body: JSON.stringify({ payload }) });
    const nav = await getJson('https://api.bilibili.com/x/web-interface/nav', headersFor(mid));
    if (lg) {
      if (nav.data?.isLogin) {
        if (!announced) log('INFO', `用B站账号「${nav.data.uname}」（UID ${nav.data.mid}）查询`);
        announced = true;
      } else {
        loginBad = true;
        cookie = visitor;
        log('WARNING', 'B站登录已过期，先用访客方式查询。重新登录：node index.mjs login');
      }
    }
    mixinKey = mixinKeyOf(nav.data.wbi_img.img_url, nav.data.wbi_img.sub_url);
    keysAt = Date.now();
    await wait(3000 + Math.random() * 2000);   // a freshly activated cookie often gets empty lists for a few seconds
  }

  async function ensureKeys(mid) {
    currentLogin();
    if (!mixinKey || Date.now() - keysAt > 6 * 3600e3) await refreshKeys(mid);
  }

  // Signed call to a space API; resets the cookie on errors so the next call starts fresh.
  async function api(mid, tab, url) {
    await ensureKeys(mid);
    const body = await getJson(url(), headersFor(mid, tab)).catch(e => { keysAt = 0; throw e; });
    if (body.code !== 0) { keysAt = 0; throw new Error(`B站返回 ${body.code} ${body.message}`); }
    return body.data;
  }

  // QR-code login: onQr(url) shows the code (e.g. in the terminal); returns { uid } on success.
  async function qrLogin(onQr, { file = loginFile, timeoutMs = 180e3 } = {}) {
    const gen = await getJson('https://passport.bilibili.com/x/passport-login/web/qrcode/generate', { Referer: 'https://www.bilibili.com/' });
    if (gen.code !== 0) throw new Error(`生成登录二维码失败：${gen.code} ${gen.message}`);
    await onQr(gen.data.url);
    for (const deadline = Date.now() + timeoutMs; Date.now() < deadline;) {
      await wait(3000);
      const res = await fetchImpl(`https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key=${gen.data.qrcode_key}`,
        { headers: { 'User-Agent': UA, Referer: 'https://www.bilibili.com/' }, signal: AbortSignal.timeout(15000) });
      const body = await res.json();
      const code = body.data?.code;
      if (code === 86038) throw new Error('二维码过期了，再运行一次');
      if (code !== 0) continue;
      const jar = Object.fromEntries(res.headers.getSetCookie().map(c => c.split(';')[0].split('='))
        .filter(([k]) => KEEP_COOKIES.includes(k)).map(([k, ...v]) => [k, v.join('=')]));
      if (!jar.SESSDATA) throw new Error('登录成功了但没拿到 SESSDATA');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; '),
        uid: jar.DedeUserID, refresh_token: body.data.refresh_token, savedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
      keysAt = 0;
      return { uid: jar.DedeUserID };
    }
    throw new Error('3 分钟内没有扫码确认');
  }

  return {
    getJson, currentLogin, refreshKeys, ensureKeys, api, qrLogin,
    signWbi: params => signWbiWith(mixinKey, params),
    get cookie() { return cookie; },
    // Three empty feeds in a row: switch to a new visitor cookie next time.
    noteEmptyFeed() { if (++emptyStreak >= 3) { keysAt = 0; emptyStreak = 0; } },
    resetEmptyFeed() { emptyStreak = 0; },
  };
}

// Print a QR code in the terminal (needs the optional "qrcode" package), with the raw URL as fallback.
export async function showQrInTerminal(url) {
  try {
    const QRCode = (await import('qrcode')).default;
    console.log(await QRCode.toString(url, { type: 'terminal', small: true }));
  } catch {
    console.log('（装了 qrcode 包才能在这里显示二维码：npm install）');
  }
  console.log('用 B站 App 扫码并在手机上确认登录，或把这个网址转成二维码：\n' + url);
}
