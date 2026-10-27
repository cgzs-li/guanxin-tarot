import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker, { AIGateway } from './index.js';
import { spreads } from './generated-library.js';

class MemoryStorage {
  constructor() { this.values = new Map(); this.queue = Promise.resolve(); }
  async get(key) { return structuredClone(this.values.get(key)); }
  async put(key, value) { this.values.set(key, structuredClone(value)); }
  async delete(key) { return this.values.delete(key); }
  transaction(run) {
    const operation = this.queue.then(() => run(this));
    this.queue = operation.catch(() => {});
    return operation;
  }
}
function fixture(storage = new MemoryStorage()) {
  const gateway = new AIGateway({ storage }, {});
  const env = { AI_GATEWAY: { idFromName: n => n, get: () => gateway }, ASSETS: { fetch: async () => new Response('static') } };
  const request = async (path, data, cookie = '', ip = 'test-ip') => {
    const headers = { Cookie: cookie, 'CF-Connecting-IP': ip };
    if (data !== undefined) { headers.Origin = 'https://site.invalid'; headers['Content-Type'] = 'application/json'; }
    const r = await worker.fetch(new Request('https://site.invalid/api/' + path,
      { headers, ...(data === undefined ? {} : { method: 'POST', body: JSON.stringify(data) }) }), env);
    const body = await r.json();
    return { status: r.status, body, cookie: r.headers.get('Set-Cookie')?.split(';')[0], headers: r.headers };
  };
  return { storage, env, request };
}
async function register(f, username = '测试账号', ip = 'test-ip') {
  const result = await f.request('account/register', { username, password: 'fictional-test-pass-123', confirm_password: 'fictional-test-pass-123' }, '', ip);
  assert.equal(result.status, 200, result.body.error);
  return result;
}
function reading(spreadId = 'basic', requestId = crypto.randomUUID()) {
  const sp = spreads.find(s => s.id === spreadId);
  return { request_id: requestId, question: '我如何安排绘画练习？', theme: '自我', spread_id: sp.id,
    cards: sp.slots.map((_, id) => ({ id, reversed: false })), background: [] };
}
async function buy(f, cookie, product = 'triple-1') {
  const order = await f.request('demo/order', { product_id: product, request_id: crypto.randomUUID(), price: 1, paid: true }, cookie);
  assert.equal(order.status, 200);
  const checkout = await f.request('demo/checkout', { order_id: order.body.order.id }, cookie);
  assert.equal(checkout.status, 200);
  return { order, checkout };
}

test('registration persists only salted password hashes and uses secure opaque sessions', async () => {
  const f = fixture(), account = await register(f);
  const cookie = account.headers.get('Set-Cookie');
  for (const flag of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/']) assert.ok(cookie.includes(flag));
  assert.ok(cookie.startsWith('__Host-guanxin_session='));
  assert.equal(account.body.free_remaining, 1);
  const saved = await f.storage.get('user:测试账号');
  assert.equal(saved.hash.length, 64); assert.equal(saved.salt.length, 32);
  assert.ok(!JSON.stringify([...f.storage.values.values()]).includes('fictional-test-pass-123'));
  assert.equal(account.body.user.name, '测试账号');
});

test('anonymous and forged sessions cannot consume free or demo rights', async () => {
  const f = fixture();
  for (const cookie of ['', '__Host-guanxin_session=' + 'a'.repeat(64)]) {
    assert.equal((await f.request('free/reading', reading(), cookie)).status, 401);
    assert.equal((await f.request('demo/reading', reading(), cookie)).status, 401);
    assert.equal((await f.request('demo/order', { product_id: 'monthly', request_id: crypto.randomUUID() }, cookie)).status, 401);
  }
});

test('one free reading survives restart/login and concurrent attempts; retry is idempotent', async () => {
  const f = fixture(), a = await register(f);
  const payloads = [reading(), reading()];
  const attempts = await Promise.all(payloads.map(p => f.request('free/reading', p, a.cookie)));
  assert.deepEqual(attempts.map(r => r.status).sort(), [200, 402]);
  const winner = attempts.findIndex(r => r.status === 200);
  assert.equal((await f.request('free/reading', payloads[winner], a.cookie)).status, 200);
  const replacement = fixture(f.storage);
  const login = await replacement.request('account/login', { username: '测试账号', password: 'fictional-test-pass-123' });
  assert.equal(login.status, 200); assert.equal(login.body.free_remaining, 0);
  assert.equal((await replacement.request('free/reading', reading(), login.cookie)).status, 402);
  assert.equal((await replacement.request('free/reading', { ...payloads[winner], question: '改动问题' }, login.cookie)).status, 402);
});

test('invalid cards do not spend the free chance and prompt text is not persisted', async () => {
  const f = fixture(), a = await register(f);
  assert.equal((await f.request('free/reading', { ...reading(), cards: [] }, a.cookie)).status, 400);
  assert.equal((await f.request('account/me', undefined, a.cookie)).body.free_remaining, 1);
  assert.equal((await f.request('free/reading', reading(), a.cookie)).status, 200);
  assert.ok(!JSON.stringify([...f.storage.values.values()]).includes('我如何安排绘画练习'));
});

test('order amount is authoritative; repeated and concurrent confirmations grant only once', async () => {
  const f = fixture(), a = await register(f), operation = crypto.randomUUID();
  const order = await f.request('demo/order', { product_id: 'triple-3', request_id: operation, price: 0, status: 'paid' }, a.cookie);
  assert.equal(order.body.order.price, 990); assert.equal(order.body.order.status, 'demo_pending');
  const retry = await f.request('demo/order', { product_id: 'triple-3', request_id: operation }, a.cookie);
  assert.equal(retry.body.order.id, order.body.order.id);
  assert.equal((await f.request('demo/order', { product_id: 'single-1', request_id: operation }, a.cookie)).status, 409);
  const both = await Promise.all([1, 2].map(() => f.request('demo/checkout', { order_id: order.body.order.id, paid: true }, a.cookie)));
  for (const result of both) {
    assert.equal(result.status, 200); assert.equal(result.body.account.demo.balance.triple, 3);
    assert.equal(result.body.order.status, 'demo_completed'); assert.equal(result.body.account.real_ai_available, false);
  }
  const user = await f.storage.get('user:测试账号'); assert.equal(user.demoBalance.triple, 3); assert.equal(user.paid, undefined);
});

test('orders and conversations cannot be used by another account', async () => {
  const f = fixture(), a = await register(f, '用户甲'), b = await register(f, '用户乙');
  const { order } = await buy(f, a.cookie);
  assert.equal((await f.request('demo/checkout', { order_id: order.body.order.id }, b.cookie)).status, 404);
  const generated = await f.request('demo/reading', reading(), a.cookie);
  assert.equal((await f.request('demo/followup', { session_id: generated.body.session_id, message: '追问', request_id: crypto.randomUUID() }, b.cookie)).status, 410);
});

test('demo packs match spread tier; valid read and retry spend once; invalid data spends nothing', async () => {
  const f = fixture(), a = await register(f);
  await buy(f, a.cookie, 'single-1');
  assert.equal((await f.request('demo/reading', reading('basic'), a.cookie)).status, 402);
  assert.equal((await f.request('demo/reading', { ...reading('single'), cards: [] }, a.cookie)).status, 400);
  const one = reading('single');
  const both = await Promise.all([1, 2].map(() => f.request('demo/reading', one, a.cookie)));
  for (const r of both) {
    assert.equal(r.status, 200); assert.equal(r.body.account.demo.balance.single, 0);
    assert.ok(r.body.answer.includes('不是大模型回答'));
    assert.ok(!r.body.answer.includes('undefined')); assert.ok(r.body.simulated);
  }
  assert.equal(both[0].body.session_id, both[1].body.session_id);
  assert.equal((await f.request('demo/reading', reading('single'), a.cookie)).status, 402);
  assert.equal((await f.request('account/me', undefined, a.cookie)).body.free_remaining, 1);
});

test('one pack followup and idempotent retries enforce the limit on the server', async () => {
  const f = fixture(), a = await register(f); await buy(f, a.cookie);
  const r = await f.request('demo/reading', reading(), a.cookie);
  const p = { session_id: r.body.session_id, message: '我怎样开始第一步？', request_id: crypto.randomUUID() };
  assert.equal((await f.request('demo/followup', p, a.cookie)).body.followup_remaining, 0);
  assert.equal((await f.request('demo/followup', p, a.cookie)).status, 200);
  assert.equal((await f.request('demo/followup', { ...p, message: '改动原问题' }, a.cookie)).status, 409);
  assert.equal((await f.request('demo/followup', { ...p, request_id: crypto.randomUUID() }, a.cookie)).status, 402);
  assert.ok(!JSON.stringify([...f.storage.values.values()]).includes('我怎样开始第一步'));
});

test('monthly daily limits, pack fallback and three followups enforce distinct rights', async () => {
  const f = fixture(), a = await register(f); await buy(f, a.cookie, 'monthly'); await buy(f, a.cookie, 'triple-1');
  let first;
  for (let i = 0; i < 3; i++) {
    const r = await f.request('demo/reading', reading(), a.cookie);
    assert.equal(r.status, 200); assert.equal(r.body.followup_remaining, 3);
    assert.equal(r.body.account.demo.balance.triple, 1);
    first ||= r;
  }
  const overflow = await f.request('demo/reading', reading(), a.cookie);
  assert.equal(overflow.status, 200); assert.equal(overflow.body.account.demo.balance.triple, 0);
  assert.equal((await f.request('demo/reading', reading(), a.cookie)).status, 402);
  for (let i = 0; i < 3; i++) assert.equal((await f.request('demo/followup', { session_id: first.body.session_id, message: '第一步怎么做？', request_id: crypto.randomUUID() }, a.cookie)).status, 200);
  assert.equal((await f.request('demo/followup', { session_id: first.body.session_id, message: '还可以呢？', request_id: crypto.randomUUID() }, a.cookie)).status, 402);
});

test('monthly quotas reset on Beijing calendar day and expiry removes member rights', async () => {
  const f = fixture(), a = await register(f); await buy(f, a.cookie, 'monthly');
  assert.equal((await f.request('demo/reading', reading('celtic'), a.cookie)).status, 200);
  assert.equal((await f.request('demo/reading', reading('celtic'), a.cookie)).status, 402);
  const saved = Date.now; const now = saved();
  try {
    Date.now = () => now + 25 * 3600000;
    assert.equal((await f.request('demo/reading', reading('celtic'), a.cookie)).status, 200);
    Date.now = () => now + 31 * 86400000;
    const login = await f.request('account/login', { username: '测试账号', password: 'fictional-test-pass-123' });
    assert.equal(login.status, 200); assert.equal(login.body.demo.remaining_today, null);
    assert.equal((await f.request('demo/reading', reading('celtic'), login.cookie)).status, 402);
  } finally { Date.now = saved; }
});

test('all real AI endpoints stay blocked, including after a simulated purchase', async () => {
  const f = fixture(), a = await register(f); await buy(f, a.cookie, 'monthly');
  const original = globalThis.fetch;
  globalThis.fetch = async () => { assert.fail('No public demo/free route may reach a model'); };
  try {
    for (const path of ['polish', 'intake-questions', 'recommend-spread', 'reading', 'followup']) {
      const r = await f.request(path, { ...reading(), paid: true, is_member: true, session_id: 'forged' }, a.cookie);
      assert.equal(r.status, 402);
    }
    assert.equal((await f.request('status')).body.configured, false);
    assert.equal((await f.request('free/reading', reading(), a.cookie)).status, 200);
    assert.equal((await f.request('demo/reading', reading(), a.cookie)).status, 200);
  } finally { globalThis.fetch = original; }
});

test('logout and session expiry revoke access; credentials never appear in public account response', async () => {
  const f = fixture(), a = await register(f);
  const info = await f.request('account/me', undefined, a.cookie);
  assert.ok(!JSON.stringify(info.body).includes('salt')); assert.ok(!JSON.stringify(info.body).includes('hash'));
  assert.equal((await f.request('account/logout', {}, a.cookie)).status, 200);
  assert.equal((await f.request('account/me', undefined, a.cookie)).body.user, null);
  assert.equal((await f.request('free/reading', reading(), a.cookie)).status, 401);
});

test('cross-site, malformed, wrong-method and oversized commerce requests are rejected', async () => {
  const f = fixture();
  assert.equal((await worker.fetch(new Request('https://site.invalid/api/account/register', { method: 'POST', headers: { Origin: 'https://evil.invalid', 'Content-Type': 'application/json' }, body: '{}' }), f.env)).status, 403);
  assert.equal((await worker.fetch(new Request('https://site.invalid/api/demo/checkout'), f.env)).status, 405);
  assert.equal((await f.request('account/me', {})).status, 405);
  const response = await worker.fetch(new Request('https://site.invalid/api/account/register', { method: 'POST', headers: { Origin: 'https://site.invalid', 'Content-Type': 'application/json' }, body: 'x'.repeat(196609) }), f.env);
  assert.equal(response.status, 413);
  const paused = await worker.fetch(new Request('https://site.invalid/api/account/me'), { ...f.env, GUANXIN_SITE_ENABLED: 'false' });
  assert.equal(paused.status, 503);
});

test('registration and login attempts are rate limited independently of model limits', async () => {
  const f = fixture();
  for (let i = 0; i < 5; i++) await register(f, '限流账号' + i, 'rate-test');
  assert.equal((await f.request('account/register', { username: '限流账号6', password: 'fictional-test-pass-123', confirm_password: 'fictional-test-pass-123' }, '', 'rate-test')).status, 429);
  for (let i = 0; i < 15; i++) assert.equal((await f.request('account/login', { username: '不存在的账号', password: 'fictional-test-pass-123' }, '', 'rate-test')).status, 401);
  assert.equal((await f.request('account/login', { username: '不存在的账号', password: 'fictional-test-pass-123' }, '', 'rate-test')).status, 429);
});

