import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VoiceService, decodeWav } from './voice.js';
import worker from './index.js';

function wav(seconds = 35) {
  const b = Buffer.alloc(44 + 48000 * seconds);
  b.write('RIFF'); b.writeUInt32LE(b.length - 8, 4); b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(24000, 24); b.writeUInt32LE(48000, 28); b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(b.length - 44, 40);
  return b.toString('base64');
}
function fixture() {
  const id = crypto.randomUUID(), account = { user: { id: 'owned-user' } }, values = new Map();
  values.set('paid-conversation:' + id, { userId: account.user.id, expires: Date.now() + 3600000, readingToken: 'initial-reading', token: 'later-followup' });
  let summaries = 0, rates = 0;
  const c = { storage: { get: async k => structuredClone(values.get(k)), put: async (k, v) => values.set(k, v), transaction: async f => f(c.storage) },
    rate: async () => { rates++; }, paid: { checkAI() {} }, gateway: { env: { FLOWBEE_TTS_API_KEY: 'private-tts-secret' },
      open: async token => { assert.equal(token, 'initial-reading'); return { history: [{ role: 'assistant', content: '原始解读' }] }; },
      complete: async () => { summaries++; return '这次解读邀请你先观察自己的感受，把注意力放在可以做的小事上。'.repeat(6); } } };
  return { id, account, values, c, voice: new VoiceService(c), counts: () => ({ summaries, rates }) };
}
async function tts(run, response) {
  const original = globalThis.fetch, calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, ...JSON.parse(init.body) });
    return response ? response() : Response.json({ choices: [{ message: { audio: { data: wav() } } }] });
  };
  try { await run(calls); } finally { globalThis.fetch = original; }
}
test('voice endpoint requires login, same origin and POST', async () => {
  const env = { AI_GATEWAY: { idFromName: () => 1, get: () => ({ fetch: async () => Response.json({ error: 'login' }, { status: 401 }) }) } };
  const post = headers => worker.fetch(new Request('https://site.invalid/api/paid/voice', { method: 'POST', headers, body: '{}' }), env);
  assert.equal((await post({ Origin: 'https://other.invalid', 'Content-Type': 'application/json' })).status, 403);
  assert.equal((await worker.fetch(new Request('https://site.invalid/api/paid/voice'), env)).status, 405);
  assert.equal((await post({ Origin: 'https://site.invalid', 'Content-Type': 'application/json' })).status, 401);
});
test('voice rejects local-only, forged text, other users, expired trials and disabled AI before model calls', async () => {
  const f = fixture();
  for (const [account, payload, status] of [
    [f.account, { session_id: crypto.randomUUID() }, 410],
    [f.account, { session_id: f.id, text: 'arbitrary speech' }, 400],
    [{ user: { id: 'other' } }, { session_id: f.id }, 410]
  ]) await assert.rejects(f.voice.generate(account, payload), e => e.status === status);
  const session = f.values.get('paid-conversation:' + f.id); session.trialEndsAt = Date.now() - 1;
  await assert.rejects(f.voice.generate(f.account, { session_id: f.id }), e => e.status === 402);
  delete session.trialEndsAt; session.adminTest = true;
  await assert.rejects(f.voice.generate(f.account, { session_id: f.id }), e => e.status === 403);
  delete session.adminTest; delete f.c.gateway.env.FLOWBEE_TTS_API_KEY;
  await assert.rejects(f.voice.generate(f.account, { session_id: f.id }), e => e.status === 503);
  assert.equal(f.counts().summaries, 0);
});
test('owner and paid/trial voice uses original reading, selected voice, single flight and replay cache without charging', async () => {
  await tts(async calls => {
    const f = fixture();
    const [a, b] = await Promise.all([f.voice.generate(f.account, { session_id: f.id }, 'ip'), f.voice.generate(f.account, { session_id: f.id }, 'ip')]);
    assert.equal(a.headers.get('Content-Type'), 'audio/wav'); assert.match(a.headers.get('Cache-Control'), /no-store/);
    assert.equal((await a.arrayBuffer()).byteLength, (await b.arrayBuffer()).byteLength);
    await f.voice.generate(f.account, { session_id: f.id }, 'ip');
    assert.equal(calls.length, 1); assert.equal(f.counts().summaries, 1);
    assert.deepEqual(calls[0].audio, { voice: '冰糖', format: 'wav' });
    assert.equal(calls[0].messages[1].role, 'assistant'); assert.equal(calls[0].model, 'mimo-v2.5-tts');
    assert.equal(f.values.get('voice-attempt:' + f.id), 1);
    f.values.get('paid-conversation:' + f.id).expires = Date.now() - 1;
    await assert.rejects(f.voice.generate(f.account, { session_id: f.id }), e => e.status === 410);
  });
});
test('upstream failure is retryable, bounded across restarts and does not leak upstream data', async () => {
  await tts(async calls => {
    const f = fixture();
    for (let i = 0; i < 3; i++) {
      f.voice = new VoiceService(f.c);
      await assert.rejects(f.voice.generate(f.account, { session_id: f.id }, 'ip'), e => e.status === 502 && !e.message.includes('private'));
    }
    await assert.rejects(f.voice.generate(f.account, { session_id: f.id }, 'ip'), e => e.status === 429);
    assert.equal(calls.length, 3); assert.equal(f.voice.pending.size, 0);
  }, () => new Response('private upstream body', { status: 503 }));
});
test('invalid, truncated, tiny and oversized audio never reaches the player', () => {
  for (const data of ['', 'private invalid', Buffer.alloc(44).toString('base64'), wav(1), wav(76)])
    assert.throws(() => decodeWav(data));
  const broken = Buffer.from(wav(35), 'base64').subarray(0, 60).toString('base64');
  assert.throws(() => decodeWav(broken));
  assert.equal(decodeWav(wav()).duration, 35);
});
