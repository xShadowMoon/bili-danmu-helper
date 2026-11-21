// Live-room message connection (danmaku, gifts, SC, guards, follows) over Bilibili's WebSocket protocol.
// 直播间实时消息：包头 16 字节（总长、头长、协议版本、操作码、序号）+ 内容；版本 3 是 brotli 压缩的一串包。
import zlib from 'node:zlib';

export function livePacket(op, body = '') {
  const data = Buffer.from(body);
  const head = Buffer.alloc(16);
  head.writeUInt32BE(16 + data.length, 0);
  head.writeUInt16BE(16, 4);
  head.writeUInt16BE(1, 6);
  head.writeUInt32BE(op, 8);
  head.writeUInt32BE(1, 12);
  return Buffer.concat([head, data]);
}

export function* livePackets(buf) {
  for (let i = 0; i + 16 <= buf.length;) {
    const len = buf.readUInt32BE(i), headLen = buf.readUInt16BE(i + 4), ver = buf.readUInt16BE(i + 6), op = buf.readUInt32BE(i + 8);
    if (len < 16) break;
    const body = buf.subarray(i + headLen, i + len);
    if (ver === 3) yield* livePackets(zlib.brotliDecompressSync(body));
    else if (ver === 2) yield* livePackets(zlib.inflateSync(body));
    else yield { op, body };
    i += len;
  }
}

// One level of protobuf: varints as numbers, length-delimited fields as raw bytes.
export function pbFields(buf) {
  const out = {};
  let i = 0;
  const varint = () => { let r = 0, s = 1, b; do { b = buf[i++]; r += (b & 0x7f) * s; s *= 128; } while (b & 0x80); return r; };
  while (i < buf.length) {
    const key = varint(), f = Math.floor(key / 8), wt = key % 8;
    if (wt === 0) out[f] ??= varint();
    else if (wt === 2) { const len = varint(); out[f] ??= buf.subarray(i, i + len); i += len; }
    else if (wt === 1) i += 8;
    else if (wt === 5) i += 4;
    else break;
  }
  return out;
}

// Turn a raw command into a small event: { type: 'dm' | 'gift' | 'sc' | 'guard' | 'follow', uid, uname, ... } or null.
export function createParser() {
  const seenTids = [];
  const fresh = tid => {
    if (!tid) return true;
    if (seenTids.includes(String(tid))) return false;
    seenTids.push(String(tid));
    if (seenTids.length > 500) seenTids.shift();
    return true;
  };
  return function parse(m) {
    const cmd = String(m?.cmd ?? '').split(':')[0];
    const d = m?.data ?? {};
    if (cmd === 'DANMU_MSG') {
      const [uid, uname] = m.info?.[2] ?? [];
      return uid ? { type: 'dm', uid, uname, text: String(m.info?.[1] ?? '').slice(0, 100) } : null;
    }
    if (cmd === 'INTERACT_WORD') return Number(d.msg_type) === 2 ? { type: 'follow', uid: d.uid, uname: d.uname } : null;
    if (cmd === 'INTERACT_WORD_V2' && d.pb) {   // protobuf: 1 = uid, 2 = name, 5 = kind (2 = follow)
      const f = pbFields(Buffer.from(d.pb, 'base64'));
      return Number(f[5]) === 2 ? { type: 'follow', uid: f[1], uname: String(f[2] ?? '') } : null;
    }
    if (cmd === 'SEND_GIFT_V2' && d.pb) {   // 1 = uid, 2 = name, 10 = gift: 2 name, 3 count, 5 unit price, 7 total, 8 coin type, 9 serial
      const top = pbFields(Buffer.from(d.pb, 'base64'));
      const g = top[10] ? pbFields(top[10]) : {};
      if (String(g[8] ?? '') !== 'gold' || !fresh(g[9] && String(g[9]))) return null;
      return { type: 'gift', uid: top[1], uname: String(top[2] ?? ''), name: String(g[2] ?? ''), num: g[3] || 1, yuan: (g[7] || (g[5] ?? 0) * (g[3] || 1)) / 1000 };
    }
    if (cmd === 'SEND_GIFT' && d.coin_type === 'gold') {
      if (!fresh(d.tid)) return null;
      return { type: 'gift', uid: d.uid, uname: d.uname, name: d.giftName, num: d.num, yuan: (d.total_coin || d.price * d.num) / 1000 };
    }
    if (cmd === 'SUPER_CHAT_MESSAGE') return { type: 'sc', uid: d.uid, uname: d.user_info?.uname, num: 1, yuan: Number(d.price) || 0, text: d.message };
    if (cmd === 'GUARD_BUY') return { type: 'guard', uid: d.uid, uname: d.username, name: d.gift_name, num: d.num, yuan: (d.price * (d.num || 1)) / 1000 };
    return null;
  };
}

// Keep a connection to the room open; calls onEvent(event) for parsed events. Reconnects by itself.
export function connectLive({ bili, roomId, onEvent, log = () => {}, WebSocketImpl = globalThis.WebSocket }) {
  const parse = createParser();
  let ws = null, beat = null, timer = null, closed = false, up = false, warned = false;
  const retry = ms => { if (!closed) timer = setTimeout(open, ms); };
  async function open() {
    let authed = false;
    try {
      await bili.ensureKeys();
      const room = Number(typeof roomId === 'function' ? roomId() : roomId);
      const lg = bili.currentLogin();
      const info = await bili.getJson('https://api.live.bilibili.com/xlive/web-room/v1/index/getDanmuInfo?' +
        bili.signWbi({ id: room, type: 0, web_location: '444.8' }),
      { Cookie: bili.cookie, Referer: `https://live.bilibili.com/${room}`, Origin: 'https://live.bilibili.com' });
      if (info.code !== 0) throw new Error(`拿直播间连接信息失败（${info.code} ${info.message}）`);
      const host = info.data.host_list?.[0] ?? { host: 'broadcastlv.chat.bilibili.com', wss_port: 443 };
      ws = new WebSocketImpl(`wss://${host.host}:${host.wss_port}/sub`);
      ws.binaryType = 'arraybuffer';
      ws.onopen = () => {
        ws.send(livePacket(7, JSON.stringify({ uid: Number(lg?.uid ?? 0), roomid: room, protover: 3,
          buvid: bili.cookie.match(/buvid3=([^;]+)/)?.[1] ?? '', platform: 'web', type: 2, key: info.data.token })));
        beat = setInterval(() => { try { ws.send(livePacket(2)); } catch {} }, 30e3);
      };
      ws.onmessage = e => {
        try {
          for (const p of livePackets(Buffer.from(e.data))) {
            if (p.op === 8 && !authed) {
              authed = true;
              if (!up) log('INFO', `已连上直播间 ${room} 的实时消息${lg ? '' : '（没登录，名字会被打码）'}`);
              up = true; warned = false;
            } else if (p.op === 5) {
              const ev = parse(JSON.parse(p.body.toString('utf8')));
              if (ev) onEvent({ t: Date.now(), ...ev });
            }
          }
        } catch (err) { log('WARNING', `解析直播间消息出错（${err.message}）`); }
      };
      ws.onclose = () => {
        clearInterval(beat);
        if (up && !closed) log('WARNING', '直播间连接断了，稍后重连');
        up = false;
        retry(authed ? 5000 : 60e3);
      };
    } catch (e) {
      clearInterval(beat);
      if (!warned) log('WARNING', `连不上直播间（${e.message}），每分钟重试`);
      warned = true;
      retry(60e3);
    }
  }
  open();
  return { close() { closed = true; clearTimeout(timer); clearInterval(beat); try { ws?.close(); } catch {} }, get up() { return up; } };
}
