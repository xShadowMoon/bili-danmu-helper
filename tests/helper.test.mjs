import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { splitDanmu, keyHit, songAskOf, createDanmuHelper, DEFAULTS, cleanAiLine, saysNothing, mentions, aiPrompt, chatPrompt } from '../src/danmu-helper.mjs';
import { livePacket, livePackets, createParser } from '../src/live-ws.mjs';
import { signWbiWith, mixinKeyOf } from '../src/bili.mjs';

test('splitDanmu cuts long text at punctuation', () => {
  assert.deepEqual(splitDanmu('一二三四五，六七八九十', 6), ['一二三四五，', '六七八九十']);
  assert.deepEqual(splitDanmu('short', 20), ['short']);
});

test('keyHit only answers questions unless the key starts with =', () => {
  assert.ok(keyHit('群号是多少', '群号'));
  assert.ok(keyHit('群号', '群号'));
  assert.ok(!keyHit('明天再进群聊', '进群'));
  assert.ok(keyHit('明天再进群聊', '=进群'));
  assert.ok(keyHit('is the song list somewhere?', 'song list'));
});

test('songAskOf picks the song name', () => {
  assert.equal(songAskOf('唱过晴天吗'), '晴天');
  assert.equal(songAskOf('主播《稻香》唱过没'), '稻香');
  assert.equal(songAskOf('唱过什么歌吗'), '');
});

test('live packets round-trip, including brotli batches', () => {
  const inner = Buffer.concat([livePacket(5, '{"cmd":"A"}'), livePacket(5, '{"cmd":"B"}')]);
  const z = zlib.brotliCompressSync(inner);
  const head = Buffer.alloc(16);
  head.writeUInt32BE(16 + z.length, 0); head.writeUInt16BE(16, 4); head.writeUInt16BE(3, 6); head.writeUInt32BE(5, 8); head.writeUInt32BE(1, 12);
  const out = [...livePackets(Buffer.concat([head, z]))].map(p => JSON.parse(p.body.toString()).cmd);
  assert.deepEqual(out, ['A', 'B']);
});

test('parser turns commands into events and drops duplicate gifts', () => {
  const parse = createParser();
  assert.deepEqual(parse({ cmd: 'DANMU_MSG', info: [[], '你好', [42, '观众']] }), { type: 'dm', uid: 42, uname: '观众', text: '你好' });
  const gift = { cmd: 'SEND_GIFT', data: { coin_type: 'gold', tid: 't1', uid: 1, uname: 'a', giftName: '小花', num: 2, price: 1000, total_coin: 2000 } };
  assert.equal(parse(gift).yuan, 2);
  assert.equal(parse(gift), null);
  assert.equal(parse({ cmd: 'SEND_GIFT', data: { coin_type: 'silver' } }), null);
});

test('WBI signature is stable for fixed input', () => {
  const key = mixinKeyOf('https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png', 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png');
  assert.equal(key, 'ea1db124af3c7062474693fa704f4ff8');
  assert.equal(signWbiWith(key, { foo: '114', bar: '514', zab: 1919810 }, 1702204169000),
    'bar=514&foo=114&wts=1702204169&zab=1919810&w_rid=8f6f2b5b3d485fe1886cec6a0be8c5d4');
});

test('helper sends a thank-you through the queue', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dmh-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ ...DEFAULTS, enabled: true, safety: { minGapSec: 0, maxPerStream: 10, pauseMinOnError: 1 },
    thanks: { ...DEFAULTS.thanks, sc: { enabled: true, template: '谢谢{name}～' } } }));
  const sent = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => { sent.push(Object.fromEntries(init.body)); return new Response('{"code":0,"message":""}'); };
  t.after(() => { globalThis.fetch = realFetch; });
  const h = createDanmuHelper({ dir, roomId: 123, isLive: () => true, botCookie: () => 'SESSDATA=x; bili_jct=csrf; DedeUserID=9', log: () => {}, UA: 'test' });
  h.event({ type: 'sc', uid: 1, uname: '小明' });
  await new Promise(r => setTimeout(r, 50));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].msg, '谢谢小明～');
  assert.equal(sent[0].roomid, '123');
  assert.equal(sent[0].csrf, 'csrf');
});

test('AI line checks: strip quotes, drop too long or banned', () => {
  assert.equal(cleanAiLine('「喝水啦」'), '喝水啦');
  assert.equal(cleanAiLine('弹幕：喝水'), '喝水');
  assert.equal(cleanAiLine('x'.repeat(21), 20), '');
  assert.equal(cleanAiLine('加个微信'), '');
  assert.ok(saysNothing('不说') && saysNothing('「不说」。') && !saysNothing('不说了，喝水'));
  assert.ok(mentions('助手在吗', ['助手']) && !mentions('你好', ['助手']));
  const [sys, user] = aiPrompt({ original: '喝水', persona: 'P', info: { title: 'T', liveMinutes: 75 }, recent: [{ uname: 'A', text: 'hi' }] });
  assert.ok(sys.content.startsWith('P') && user.content.includes('T') && user.content.includes('1 小时 15 分钟') && user.content.includes('A：hi'));
  assert.ok(chatPrompt({ recent: [] })[0].content.includes('不说'));
});

test('AI rewrite waits for confirmation, then sends what was approved', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dmh-ai-'));
  const sent = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opt) => {
    if (String(url).includes('chat/completions')) return { ok: true, json: async () => ({ choices: [{ message: { content: '主播喝口水吧' } }] }) };
    if (String(url).includes('msg/send')) { sent.push(new URLSearchParams(opt.body).get('msg')); return { ok: true, json: async () => ({ code: 0, message: '' }) }; }
    return { ok: true, json: async () => ({ data: {} }) };
  };
  try {
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ enabled: true, account: 'bot', maxLen: 20, safety: { minGapSec: 0, maxPerStream: 9, pauseMinOnError: 1 },
      timed: { enabled: true, onlyLive: true, intervalMin: 0.5, order: 'seq', lines: ['喝水小助手提醒主播该喝水了'] }, ai: { enabled: true, timed: true, confirm: true, confirmSec: 15 } }));
    const h = createDanmuHelper({ dir, roomId: 1, isLive: () => true, liveSince: () => Date.now() - 3600e3, botCookie: () => 'bili_jct=x; DedeUserID=9', log: () => {}, UA: 'x', ai: { key: () => 'sk-test' } });
    h.tick(); await new Promise(r => setTimeout(r, 50));
    const p = h.status().pending;
    assert.equal(p.text, '主播喝口水吧'); assert.equal(sent.length, 0);
    await h.pendingAction(p.id, 'send'); await new Promise(r => setTimeout(r, 50));
    assert.deepEqual(sent, ['主播喝口水吧']); assert.equal(h.status().pending, null);
  } finally { globalThis.fetch = realFetch; fs.rmSync(dir, { recursive: true, force: true }); }
});
