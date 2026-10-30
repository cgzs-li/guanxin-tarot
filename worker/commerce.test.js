import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker, { AIGateway } from './index.js';
import { spreads } from './generated-library.js';
import { trialWindow } from './trial.js';

const adminKey = 'fictional-owner-key-for-tests-only-123456789';
const sha = async value => Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))).toString('hex');
class MemoryStorage {
  constructor() { this.values = new Map(); this.queue = Promise.resolve(); }
  async get(key) { return structuredClone(this.values.get(key)); }
  async put(key, value) { this.values.set(key, structuredClone(value)); }
  async delete(key) { return this.values.delete(key); }
  async list({ prefix = '', startAfter, limit = Infinity } = {}) {
    return new Map([...this.values].filter(([key]) => key.startsWith(prefix) && (!startAfter || key > startAfter)).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).slice(0, limit).map(([key, value]) => [key, structuredClone(value)]));
  }
  transaction(run) { const task = this.queue.then(() => run(this)); this.queue = task.catch(() => {}); return task; }
}
async function fixture(storage = new MemoryStorage()) {
  const vars = { FLOWBEE_API_KEY: 'fictional-model-key', FLOWBEE_MODEL: 'test-model', FLOWBEE_BASE_URL: 'https://model.invalid/v1',
    GUANXIN_AI_ENABLED: 'true', GUANXIN_ADMIN_KEY_HASH: await sha(adminKey) };
  const gateway = new AIGateway({ storage }, vars);
  const env = { ...vars, AI_GATEWAY: { idFromName: n => n, get: () => gateway }, ASSETS: { fetch: async () => new Response('static') } };
  const request = async (path, data, cookie = '', key = '', ip = 'fictional-ip') => {
    const headers = { Cookie: cookie, 'CF-Connecting-IP': ip, 'X-Admin-Key': key };
    if (data !== undefined) { headers.Origin = 'https://site.invalid'; headers['Content-Type'] = 'application/json'; }
    const response = await worker.fetch(new Request('https://site.invalid/api/' + path,
      { headers, ...(data === undefined ? {} : { method: 'POST', body: JSON.stringify(data) }) }), env);
    return { status: response.status, body: await response.json(), cookie: response.headers.get('Set-Cookie')?.split(';')[0], headers: response.headers };
  };
  return { storage, gateway, env, request };
}
let testPhoneSequence = 0;
async function register(f, username = '测试账号') {
  const a = await f.request('account/register', { username, password: 'fictional-password-123', confirm_password: 'fictional-password-123', phone: '199' + String(++testPhoneSequence).padStart(8, '0') });
  assert.equal(a.status, 200, a.body.error); return a;
}
function reading(spreadId = 'basic', requestId = crypto.randomUUID()) {
  const sp = spreads.find(s => s.id === spreadId);
  return { request_id: requestId, question: '我怎样安排这次虚构的绘画练习？', theme: '自我', spread_id: spreadId,
    cards: sp.slots.map((_, id) => ({ id, reversed: id === 1 })), background: [] };
}
async function order(f, cookie, product = 'triple-1') {
  const r = await f.request('order', { product_id: product, request_id: crypto.randomUUID(), price: 1, paid: true }, cookie);
  assert.equal(r.status, 200); return r.body.order;
}
async function buy(f, cookie, product = 'triple-1') {
  const o = await order(f, cookie, product);
  const c = await f.request('admin/confirm', { order_id: o.id, amount_cents: o.price, reference: 'fixture-receipt-' + crypto.randomUUID() }, '', adminKey);
  assert.equal(c.status, 200, c.body.error); return o;
}
async function model(run, status = 200, content = '虚构模型回答：先安排一个十分钟的小练习。') {
  const original = globalThis.fetch, calls = [];
  globalThis.fetch = async (url, init) => { calls.push(JSON.parse(init.body)); return Response.json(status === 200
    ? { choices: [{ message: { content } }] } : { error: 'private upstream body' }, { status }); };
  try { return await run(calls); } finally { globalThis.fetch = original; }
}
function openTrial(f, ends = Date.now() + 86400000) {
  const vars = { GUANXIN_TRIAL_START: new Date(Date.now() - 1000).toISOString(), GUANXIN_TRIAL_END: new Date(ends).toISOString() };
  Object.assign(f.env, vars); Object.assign(f.gateway.env, vars); return ends;
}

async function invitedRegistration(f, username, code, phone = '199' + String(++testPhoneSequence).padStart(8, '0')) {
  return f.request('account/register', { username, password: 'fictional-password-123', confirm_password: 'fictional-password-123', phone, invite_code: code });
}
test('invitation is optional, six digit codes are unique and persist for old accounts and restarts', async () => {
  const f = await fixture(), a = await register(f), b = await register(f, '邀请码乙');
  assert.match(a.body.invite.code, /^[1-9]\d{5}$/);
  assert.notEqual(a.body.invite.code, b.body.invite.code);
  const restarted = await fixture(f.storage);
  assert.deepEqual((await restarted.request('account/me', undefined, a.cookie)).body.invite, a.body.invite);
  const key = 'user:邀请码乙', legacy = await f.storage.get(key);
  await f.storage.delete('invite:code:' + legacy.inviteCode); delete legacy.inviteCode; await f.storage.put(key, legacy);
  const updated = (await restarted.request('account/me', undefined, b.cookie)).body;
  assert.match(updated.invite.code, /^\d{6}$/);
  assert.equal((await restarted.request('account/me', undefined, b.cookie)).body.invite.code, updated.invite.code);
  assert.equal(await f.storage.get('invite:code:' + updated.invite.code), key);
});
test('successful invited registrations award once, duplicates fail, and fake payload balances are ignored', async () => {
  const f = await fixture(), a = await register(f);
  const code = a.body.invite.code, phone = '199' + String(++testPhoneSequence).padStart(8, '0');
  const first = await invitedRegistration(f, '受邀甲', code, phone);
  assert.equal(first.status, 200, first.body.error); assert.equal(first.body.invite.balance, 0);
  assert.equal((await invitedRegistration(f, '受邀甲', code, phone)).status, 409);
  assert.equal((await invitedRegistration(f, '受邀乙', code, phone)).status, 409);
  assert.deepEqual((await f.request('account/me', undefined, a.cookie)).body.invite, { code, balance: 3, total: 1 });
  const b = await f.request('account/register', { username: '普通注册丙', password: 'fictional-password-123', confirm_password: 'fictional-password-123',
    phone: '199' + String(++testPhoneSequence).padStart(8, '0'), inviteCredits: 99, inviteCount: 99 });
  assert.equal(b.status, 200); assert.equal(b.body.invite.balance, 0); assert.equal(b.body.invite.total, 0);
  assert.equal((await f.request('account/me', undefined, first.cookie)).body.invite.balance, 0);
});
test('invalid invite codes fail before registering and concurrent referred accounts never lose rewards', async () => {
  const f = await fixture(), a = await register(f);
  for (const code of ['12345', '1234567', 'abcdef', 123456, '000000']) {
    const isolated = await fixture();
    const result = await invitedRegistration(isolated, '无效邀请测试', code);
    assert.equal(result.status, 400); assert.equal(await isolated.storage.get('user:无效邀请测试'), undefined);
  }
  const g = await fixture(), owner = await register(g);
  const results = await Promise.all(['邀请并发甲', '邀请并发乙'].map(username => invitedRegistration(g, username, owner.body.invite.code)));
  assert.ok(results.every(r => r.status === 200));
  assert.equal((await g.request('account/me', undefined, owner.cookie)).body.invite.balance, 6);
});
test('invite credit unlocks preparation and any spread, consumes exactly once and preserves purchased rights', async () => {
  for (const spread of ['single', 'basic', spreads.find(s => s.slots.length > 3 && s.category !== '选择').id]) {
    const f = await fixture(), a = await register(f);
    assert.equal((await invitedRegistration(f, '受邀解读用户', a.body.invite.code)).status, 200);
    await buy(f, a.cookie, spread === 'single' ? 'single-1' : spread === 'basic' ? 'triple-1' : 'complex-1');
    const paidBefore = (await f.request('account/me', undefined, a.cookie)).body.paid;
    const p = reading(spread);
    await model(async calls => {
      assert.equal((await f.request('paid/polish', p, a.cookie)).status, 200);
      assert.equal((await f.request('account/me', undefined, a.cookie)).body.invite.balance, 3);
      const r = await f.request('paid/reading', p, a.cookie);
      assert.equal(r.status, 200, r.body.error); assert.equal(r.body.invite, true); assert.equal(r.body.followup_remaining, 1);
      assert.equal(r.body.account.invite.balance, 2); assert.deepEqual(r.body.account.paid, paidBefore);
      const restarted = await fixture(f.storage), retry = await restarted.request('paid/reading', p, a.cookie);
      assert.equal(retry.status, 200); assert.equal(retry.body.invite, true); assert.equal(calls.length, 2);
      assert.equal(retry.body.account.invite.balance, 2);
    });
  }
});
test('invite model failure returns its credit and no-credit users cannot forge or reuse invitations for AI', async () => {
  const f = await fixture(), a = await register(f), p = reading();
  await invitedRegistration(f, '受邀失败用户', a.body.invite.code);
  await model(async () => assert.equal((await f.request('paid/reading', p, a.cookie)).status, 502), 429);
  assert.equal((await f.request('account/me', undefined, a.cookie)).body.invite.balance, 3);
  await model(async () => assert.equal((await f.request('paid/reading', p, a.cookie)).status, 200));
  assert.equal((await f.request('account/me', undefined, a.cookie)).body.invite.balance, 2);
  await model(async () => {
    for (const remaining of [1, 0]) {
      const result = await f.request('paid/reading', reading(), a.cookie);
      assert.equal(result.status, 200); assert.equal(result.body.invite, true);
      assert.equal(result.body.account.invite.balance, remaining);
    }
  });
  assert.equal((await f.request('account/me', undefined, a.cookie)).body.invite.balance, 0);
  await model(async calls => {
    assert.equal((await f.request('paid/reading', { ...reading(), inviteCredits: 99, invite: true }, a.cookie)).status, 402);
    assert.equal((await f.request('paid/polish', p, a.cookie)).status, 402); assert.equal(calls.length, 0);
  });
});
test('new registration requires a mainland-format phone and cannot bypass validation through the API', async () => {
  const payload = { username: '新手机号账号', password: 'fictional-password-123', confirm_password: 'fictional-password-123' };
  for (const phone of [undefined, '', 19900000201, '12345678901', '1990000020', '199000002011', '+12125550123', '19900000abc', '<script>', '1'.repeat(33)]) {
    const f = await fixture();
    const result = await f.request('account/register', { ...payload, phone });
    assert.equal(result.status, 400); assert.match(result.body.error, /手机号/);
    assert.equal(await f.storage.get('user:新手机号账号'), undefined);
    assert.equal((await f.storage.list({ prefix: 'account:phone:' })).size, 0);
  }
});

test('normalized phone registration is unique across accounts and restarts without storing plaintext', async () => {
  const f = await fixture(), payload = { username: '手机号首个账号', password: 'fictional-password-123', confirm_password: 'fictional-password-123' };
  const result = await f.request('account/register', { ...payload, phone: ' +86 199-0000-0201 ' });
  assert.equal(result.status, 200); assert.equal(result.body.free_remaining, 1);
  const user = await f.storage.get('user:手机号首个账号'); assert.equal(user.phoneVerified, false); assert.equal(user.phoneMasked, '199****0201');
  assert.equal(JSON.stringify([...f.storage.values]).includes('19900000201'), false);
  const restarted = await fixture(f.storage);
  for (const phone of ['19900000201', '１９９０００００２０１', '+86 199 0000 0201']) {
    const duplicate = await restarted.request('account/register', { ...payload, username: '手机号第二账号', phone });
    assert.equal(duplicate.status, 409); assert.match(duplicate.body.error, /手机号已用于注册/);
    assert.equal(await f.storage.get('user:手机号第二账号'), undefined);
  }
  const login = await restarted.request('account/login', { username: payload.username, password: payload.password });
  assert.equal(login.status, 200); assert.equal(login.body.user.id, result.body.user.id);
  assert.equal((await restarted.request('admin/users', {}, '', adminKey)).body.total, 1);
});

test('simultaneous registrations reserve a phone once and failed account validation does not occupy it', async () => {
  const f = await fixture(), password = 'fictional-password-123', phone = '19900000202';
  const request = username => f.request('account/register', { username, password, confirm_password: password, phone });
  const results = await Promise.all([request('并发注册甲'), request('并发注册乙')]);
  assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
  assert.equal((await f.storage.list({ prefix: 'account:phone:' })).size, 1);
  const winner = results.find(r => r.status === 200).body.user.name;
  assert.equal((await f.request('account/register', { username: winner, password, confirm_password: password, phone: '19900000203' })).status, 409);
  assert.equal((await f.request('account/register', { username: '重试成功账号', password, confirm_password: password, phone: '19900000203' })).status, 200);
  assert.equal((await f.request('admin/users', {}, '', adminKey)).body.total, 2);
});

test('legacy accounts continue logging in without phone binding and retain paid and free rights', async () => {
  const f = await fixture(), first = await register(f); await buy(f, first.cookie); await f.request('free/reading', reading(), first.cookie);
  const key = 'user:测试账号', user = await f.storage.get(key); delete user.phoneMasked; delete user.phoneVerified; await f.storage.put(key, user);
  const before = (await f.request('account/me', undefined, first.cookie)).body;
  const result = await f.request('account/login', { username: '测试账号', password: 'fictional-password-123' });
  assert.equal(result.status, 200); assert.equal(result.body.free_remaining, 0); assert.deepEqual(result.body.paid, before.paid);
  const after = await f.storage.get(key); assert.equal(after.phoneMasked, undefined); assert.equal(after.phoneVerified, undefined);
});

test('visitor statistics deduplicate browser and page retries, link real sessions and remain admin-only', async () => {
  const f = await fixture(), firstPage = crypto.randomUUID(), nextPage = crypto.randomUUID();
  const first = await f.request('visit', { page_id: firstPage, username: 'forged-user' });
  assert.equal(first.status, 200); assert.match(first.headers.get('Set-Cookie'), /HttpOnly; Secure; SameSite=Lax/);
  const a = await register(f);
  const cookie = first.cookie + '; ' + a.cookie;
  await f.request('visit', { page_id: firstPage }, cookie);
  await f.request('visit', { page_id: nextPage }, cookie);
  await f.request('visit', { page_id: firstPage }, cookie);
  const restarted = await fixture(f.storage), report = await restarted.request('admin/audience', {}, '', adminKey);
  assert.equal(report.status, 200); assert.equal(report.body.stats.views, 2); assert.equal(report.body.stats.visitors, 1);
  assert.equal(report.body.stats.today.visitors, 1); assert.equal(report.body.recent.length, 2);
  assert.ok(report.body.recent.every(item => item.username === a.body.user.name));
  assert.ok(report.body.recent.every(item => !('page_id' in item) && !('ip' in item)));
  assert.ok((await f.storage.get('user:测试账号')).lastSeen);
  assert.equal((await f.request('admin/audience', {})).status, 403);
  assert.equal((await f.request('admin/users', {}, a.cookie)).status, 403);
  assert.equal((await f.request('visit', { page_id: '<script>' })).status, 400);
  await f.request('visit', { page_id: crypto.randomUUID() });
  assert.equal((await f.request('admin/audience', {}, '', adminKey)).body.stats.visitors, 2);
});

test('visitor daily counts reset in Beijing time and recent records stay bounded', async () => {
  const f = await fixture(), one = await f.request('visit', { page_id: crypto.randomUUID() });
  for (let i = 0; i < 101; i++) await f.request('visit', { page_id: crypto.randomUUID() }, one.cookie);
  const realNow = Date.now, now = realNow(); Date.now = () => now + 86400000;
  try {
    let report = (await f.request('admin/audience', {}, '', adminKey)).body;
    assert.equal(report.stats.today.views, 0); assert.equal(report.stats.today.visitors, 0);
    await f.request('visit', { page_id: crypto.randomUUID() }, one.cookie);
    report = (await f.request('admin/audience', {}, '', adminKey)).body;
    assert.equal(report.stats.views, 103); assert.equal(report.stats.visitors, 1);
    assert.equal(report.stats.today.views, 1); assert.equal(report.stats.today.visitors, 1); assert.equal(report.recent.length, 100);
  } finally { Date.now = realNow; }
});

test('admin user list includes legacy accounts, pages safely and never exposes credentials', async () => {
  const f = await fixture();
  for (let i = 0; i < 23; i++) await f.storage.put('user:legacy' + String(i).padStart(2, '0'), {
    name: 'legacy' + String(i).padStart(2, '0'), created: 123, salt: 'private-salt', hash: 'private-hash', sessions: ['private-session'], paidBalance: {} });
  const first = await f.request('admin/users', {}, '', adminKey);
  assert.equal(first.body.total, 23); assert.equal(first.body.items.length, 20); assert.ok(first.body.next_after);
  assert.deepEqual(Object.keys(first.body.items[0]).sort(), ['created', 'last_seen', 'username']);
  const second = await f.request('admin/users', { after: first.body.next_after }, '', adminKey);
  assert.equal(second.body.items.length, 3); assert.equal(second.body.next_after, null);
  assert.equal(new Set(first.body.items.concat(second.body.items).map(u => u.username)).size, 23);
  await register(f);
  assert.equal((await f.request('admin/users', {}, '', adminKey)).body.total, 24);
  assert.equal((await f.request('admin/users', { after: 'session:secret' }, '', adminKey)).status, 400);
});

test('trial is active only in a valid server window and expires exactly at its end', () => {
  const env = { GUANXIN_TRIAL_START: '2026-10-28T10:15:00+08:00', GUANXIN_TRIAL_END: '2026-10-30T10:15:00+08:00' };
  const start = Date.parse(env.GUANXIN_TRIAL_START), end = Date.parse(env.GUANXIN_TRIAL_END);
  assert.equal(end - start, 48 * 3600000); assert.equal(trialWindow(env, start - 1).active, false);
  assert.equal(trialWindow(env, start).active, true); assert.equal(trialWindow(env, end - 1).active, true);
  assert.equal(trialWindow(env, end).active, false); assert.equal(trialWindow({ ...env, GUANXIN_TRIAL_END: 'bad' }).active, false);
  assert.equal(trialWindow({}).active, false);
});

test('trial allows real paid endpoints and repeated local readings without spending existing rights', async () => {
  const f = await fixture(), a = await register(f); await buy(f, a.cookie); await buy(f, a.cookie, 'monthly');
  const before = (await f.request('account/me', undefined, a.cookie)).body; openTrial(f);
  await model(async () => {
    for (const id of ['single', 'basic', spreads.find(s => s.slots.length > 3 && s.category !== '选择').id]) {
      const result = await f.request('paid/reading', reading(id), a.cookie);
      assert.equal(result.status, 200); assert.equal(result.body.trial, true); assert.equal(result.body.followup_remaining, 3);
    }
    assert.equal((await f.request('paid/polish', reading(), a.cookie)).status, 200);
  });
  for (let i = 0; i < 2; i++) assert.equal((await f.request('free/reading', reading(), a.cookie)).status, 200);
  const after = (await f.request('account/me', undefined, a.cookie)).body;
  assert.deepEqual(after.paid, before.paid); assert.equal(after.free_remaining, before.free_remaining);
  assert.equal(after.orders.length, before.orders.length);
  assert.equal((await f.request('paid/reading', reading())).status, 401);
});

test('zero balance users get trial AI, preparation and three followups, then original rules resume', async () => {
  const f = await fixture(), a = await register(f), end = openTrial(f, Date.now() + 60000);
  await model(async calls => {
    assert.equal((await f.request('paid/polish', reading(), a.cookie)).status, 200);
    const result = await f.request('paid/reading', reading(), a.cookie); assert.equal(result.status, 200);
    for (let i = 0; i < 3; i++) assert.equal((await f.request('paid/followup', { session_id: result.body.session_id, request_id: crypto.randomUUID(), message: '虚构追问'+i }, a.cookie)).body.followup_remaining, 2 - i);
    assert.equal((await f.request('paid/followup', { session_id: result.body.session_id, request_id: crypto.randomUUID(), message: '超过三轮' }, a.cookie)).status, 402);
    const realNow = Date.now; Date.now = () => end;
    try {
      assert.equal((await f.request('paid/reading', reading(), a.cookie)).status, 402);
      assert.equal((await f.request('paid/polish', reading(), a.cookie)).status, 402);
      assert.equal((await f.request('account/me', undefined, a.cookie)).body.trial.active, false);
    } finally { Date.now = realNow; }
    assert.equal(calls.length, 5);
  });
});

test('trial closes checkout and confirmation server-side, reopens orders after expiry, and exposes its schedule', async () => {
  const f = await fixture(), a = await register(f), pending = await order(f, a.cookie); const end = openTrial(f, Date.now() + 60000);
  assert.equal((await f.request('order', { product_id: 'single-1', request_id: crypto.randomUUID() }, a.cookie)).status, 403);
  assert.equal((await f.request('admin/confirm', { order_id: pending.id, amount_cents: pending.price, reference: 'fictional-trial-receipt' }, '', adminKey)).status, 403);
  assert.equal((await f.request('order/status', { order_id: pending.id }, a.cookie)).body.order.status, 'pending');
  assert.equal((await f.request('account/me')).body.trial.active, true);
  const catalog = await worker.fetch(new Request('https://site.invalid/api/catalog'), f.env); assert.equal((await catalog.json()).trial.active, true);
  const realNow = Date.now; Date.now = () => end;
  try { assert.equal((await f.request('order', { product_id: 'single-1', request_id: crypto.randomUUID() }, a.cookie)).status, 200); }
  finally { Date.now = realNow; }
});

test('trial followup cannot make a new model call after expiry and failed models preserve all rights', async () => {
  const f = await fixture(), a = await register(f); const end = openTrial(f, Date.now() + 60000); let response;
  await model(async () => { response = await f.request('paid/reading', reading(), a.cookie); });
  const realNow = Date.now; Date.now = () => end;
  try { await model(async calls => { assert.equal((await f.request('paid/followup', { session_id: response.body.session_id, request_id: crypto.randomUUID(), message: '到期后的新问题' }, a.cookie)).status, 402); assert.equal(calls.length, 0); }); }
  finally { Date.now = realNow; }
  await model(async () => assert.equal((await f.request('paid/reading', reading(), a.cookie)).status, 502), 429);
  const user = (await f.request('account/me', undefined, a.cookie)).body;
  assert.equal(user.free_remaining, 1); assert.deepEqual(user.paid.balance, { single: 0, triple: 0, complex: 0 });
});

test('feedback requires a completed owned reading, is private and persists idempotently', async () => {
  const f = await fixture(), a = await register(f), b = await register(f, '反馈其他账号'), p = reading();
  const input = { reading_id: p.request_id, rating: 4, message: '虚构测试：建议说明更清楚。<img src=x onerror=alert(1)>' };
  assert.equal((await f.request('feedback', input)).status, 401);
  assert.equal((await f.request('feedback', input, a.cookie)).status, 403);
  await f.request('free/reading', p, a.cookie);
  assert.equal((await f.request('feedback', input, b.cookie)).status, 403);
  const results = await Promise.all([f.request('feedback', input, a.cookie), f.request('feedback', input, a.cookie)]);
  assert.ok(results.every(r => r.status === 200)); assert.equal(await f.storage.get('feedback-total'), 1);
  assert.equal((await f.request('feedback', { ...input, message: '改动后的反馈' }, a.cookie)).status, 409);
  assert.equal((await f.request('admin/feedback', {}, a.cookie)).status, 403);
  const restarted = await fixture(f.storage), list = await restarted.request('admin/feedback', {}, '', adminKey);
  assert.equal(list.body.total, 1); assert.equal(list.body.items[0].username, '测试账号'); assert.equal(list.body.items[0].message, input.message);
  assert.equal(list.body.items[0].spread_id, p.spread_id);
  assert.equal(list.body.items[0].question, undefined); assert.equal(list.body.items[0].answer, undefined);
});

test('AI feedback is granted only after success and accepts a rating without extra text', async () => {
  const f = await fixture(), a = await register(f); openTrial(f); const p = reading();
  await model(async () => assert.equal((await f.request('paid/reading', p, a.cookie)).status, 502), 429);
  assert.equal((await f.request('feedback', { reading_id: p.request_id, rating: 5, message: '' }, a.cookie)).status, 403);
  await model(async () => assert.equal((await f.request('paid/reading', p, a.cookie)).status, 200));
  assert.equal((await f.request('feedback', { reading_id: p.request_id, rating: 5, message: '' }, a.cookie)).status, 200);
  const item = (await f.request('admin/feedback', {}, '', adminKey)).body.items[0]; assert.equal(item.mode, 'trial-ai');
});

test('feedback validates ratings, length and pagination, limits each account and pages without gaps', async () => {
  const f = await fixture(), a = await register(f); openTrial(f); const p = reading(); await f.request('free/reading', p, a.cookie);
  for (const rating of [0, 6, '5', 2.5]) assert.equal((await f.request('feedback', { reading_id: p.request_id, rating, message: '' }, a.cookie)).status, 400);
  assert.equal((await f.request('feedback', { reading_id: p.request_id, rating: 5, message: '字'.repeat(1001) }, a.cookie)).status, 400);
  for (const [index, user] of [a, await register(f, '反馈第二人'), await register(f, '反馈第三人')].entries()) {
    for (let i = 0; i < (index < 2 ? 10 : 3); i++) { const q = reading(); await f.request('free/reading', q, user.cookie); assert.equal((await f.request('feedback', { reading_id: q.request_id, rating: 3, message: '虚构'+i }, user.cookie)).status, 200); }
  }
  assert.equal((await f.request('feedback', { reading_id: p.request_id, rating: 5, message: '' }, a.cookie)).status, 429);
  const first = (await f.request('admin/feedback', {}, '', adminKey)).body;
  assert.equal(first.total, 23); assert.equal(first.items.length, 20);
  const second = (await f.request('admin/feedback', { before: first.next_before }, '', adminKey)).body;
  assert.equal(second.items.length, 3); assert.equal(second.next_before, null);
  assert.equal(new Set([...first.items, ...second.items].map(i => i.id)).size, 23);
  assert.equal((await f.request('admin/feedback', { before: -1 }, '', adminKey)).status, 400);
});

test('registration stores a salted hash and opaque secure sessions; legacy demo rights do not appear', async () => {
  const f = await fixture(), a = await register(f);
  assert.equal(a.body.mode, 'paid'); assert.equal(a.body.free_remaining, 1); assert.equal(a.body.demo, undefined);
  for (const flag of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/']) assert.ok(a.headers.get('Set-Cookie').includes(flag));
  const saved = await f.storage.get('user:测试账号'); assert.equal(saved.hash.length, 64);
  assert.ok(!JSON.stringify([...f.storage.values.values()]).includes('fictional-password-123'));
});

test('the free local chance is persistent, atomic and never calls a model', async () => {
  const f = await fixture(), a = await register(f), inputs = [reading(), reading()];
  await model(async calls => {
    const results = await Promise.all(inputs.map(p => f.request('free/reading', p, a.cookie)));
    assert.deepEqual(results.map(r => r.status).sort(), [200, 402]); assert.equal(calls.length, 0);
    const i = results.findIndex(r => r.status === 200);
    assert.equal((await f.request('free/reading', inputs[i], a.cookie)).status, 200);
    const next = await fixture(f.storage);
    const login = await next.request('account/login', { username: '测试账号', password: 'fictional-password-123' });
    assert.equal(login.body.free_remaining, 0);
    assert.equal((await next.request('free/reading', reading(), login.cookie)).status, 402);
    assert.equal((await next.request('free/reading', { ...inputs[i], question: '另一个问题' }, login.cookie)).status, 402);
  });
});

test('invalid free input does not spend the chance; logout invalidates session', async () => {
  const f = await fixture(), a = await register(f);
  assert.equal((await f.request('free/reading', { ...reading(), cards: [] }, a.cookie)).status, 400);
  assert.equal((await f.request('account/me', undefined, a.cookie)).body.free_remaining, 1);
  assert.equal((await f.request('account/logout', {}, a.cookie)).status, 200);
  assert.equal((await f.request('paid/reading', reading(), a.cookie)).status, 401);
});

test('unpaid, forged and old demo balances cannot reach a model or confirm payment', async () => {
  const f = await fixture(), a = await register(f);
  const user = await f.storage.get('user:测试账号'); user.demoBalance = { single: 99, triple: 99, complex: 99 }; user.demoMemberUntil = Date.now() + 9999999;
  await f.storage.put('user:测试账号', user);
  await model(async calls => {
    assert.equal((await f.request('paid/reading', reading(), a.cookie)).status, 402);
    assert.equal((await f.request('paid/reading', { ...reading(), paid: true, is_member: true }, '')).status, 401);
    for (const p of ['demo/order', 'demo/checkout', 'demo/reading', 'demo/followup']) assert.equal((await f.request(p, {}, a.cookie)).status, 410);
    assert.equal((await f.request('admin/confirm', {}, a.cookie)).status, 403);
    assert.equal((await f.request('admin/confirm', {}, a.cookie, f.env.GUANXIN_ADMIN_KEY_HASH)).status, 403);
    assert.equal(calls.length, 0);
  });
});

test('orders have server prices, are idempotent and stay pending when the user refreshes', async () => {
  const f = await fixture(), a = await register(f), payload = { product_id: 'triple-1', request_id: crypto.randomUUID(), price: 1, paid: true };
  const results = await Promise.all([f.request('order', payload, a.cookie), f.request('order', payload, a.cookie)]);
  assert.equal(results[0].body.order.id, results[1].body.order.id); assert.equal(results[0].body.order.price, 390);
  const state = await f.request('order/status', { order_id: results[0].body.order.id, paid: true }, a.cookie);
  assert.equal(state.body.order.status, 'pending'); assert.equal(state.body.account.paid.balance.triple, 0);
});

test('admin validates amount and receipt; concurrent repeated confirmation grants once', async () => {
  const f = await fixture(), a = await register(f), o = await order(f, a.cookie);
  const p = { order_id: o.id, amount_cents: 390, reference: 'fixture-transaction-001' };
  assert.equal((await f.request('admin/confirm', { ...p, amount_cents: 1 }, '', adminKey)).status, 400);
  const results = await Promise.all([f.request('admin/confirm', p, '', adminKey), f.request('admin/confirm', p, '', adminKey)]);
  assert.ok(results.every(r => r.status === 200));
  assert.ok(results.every(r => r.body.recipient.username === '测试账号' && r.body.recipient.paid.balance.triple === 1));
  assert.deepEqual(results.map(r => r.body.already_confirmed).sort(), [false, true]);
  assert.equal((await f.request('account/me', undefined, a.cookie)).body.paid.balance.triple, 1);
  const state = (await f.request('order/status', { order_id: o.id }, a.cookie)).body;
  assert.equal(state.order.status, 'paid'); assert.equal(state.account.paid.balance.triple, 1);
  const o2 = await order(f, a.cookie);
  assert.equal((await f.request('admin/confirm', { ...p, order_id: o2.id }, '', adminKey)).status, 409);
  assert.ok(!JSON.stringify([...f.storage.values.values()]).includes(p.reference));
});

test('confirmation rejects order ids as receipts and broken account links without granting rights', async () => {
  const f = await fixture(), a = await register(f), o = await order(f, a.cookie);
  const payload = { order_id: o.id, amount_cents: o.price, reference: 'fictional-receipt-for-integrity-check' };
  assert.equal((await f.request('admin/confirm', { ...payload, reference: o.id }, '', adminKey)).status, 400);
  const user = await f.storage.get('user:测试账号');
  await f.storage.delete('user:测试账号');
  assert.equal((await f.request('admin/confirm', payload, '', adminKey)).status, 409);
  await f.storage.put('user:测试账号', { ...user, id: crypto.randomUUID() });
  assert.equal((await f.request('admin/confirm', payload, '', adminKey)).status, 409);
  assert.equal((await f.storage.get('paid-order:' + o.id)).status, 'pending');
  assert.equal((await f.storage.get('user:测试账号')).paidBalance.triple, 0);
});

test('monthly confirmation reports the credited account and persisted expiry without extending twice', async () => {
  const f = await fixture(), a = await register(f), o = await order(f, a.cookie, 'monthly');
  const payload = { order_id: o.id, amount_cents: o.price, reference: 'fictional-monthly-receipt-001' };
  const result = await f.request('admin/confirm', payload, '', adminKey);
  assert.equal(result.status, 200); assert.equal(result.body.recipient.username, '测试账号');
  const until = result.body.recipient.paid.member_until; assert.ok(until > Date.now() + 29 * 86400000);
  assert.equal((await f.request('admin/confirm', payload, '', adminKey)).body.recipient.paid.member_until, until);
  const me = (await f.request('account/me', undefined, a.cookie)).body;
  assert.equal(me.paid.member_until, until); assert.equal(me.orders[0].status, 'paid');
});

test('my orders returns the latest twenty own orders with confirmed status across login', async () => {
  const f = await fixture(), a = await register(f), other = await register(f, '订单隔离用户');
  const first = await buy(f, a.cookie);
  for (let i = 0; i < 19; i++) await order(f, a.cookie);
  const me = (await f.request('account/me', undefined, a.cookie)).body;
  assert.equal(me.orders.length, 20); assert.equal(me.orders.at(-1).id, first.id); assert.equal(me.orders.at(-1).status, 'paid');
  assert.deepEqual((await f.request('account/me', undefined, other.cookie)).body.orders, []);
  assert.equal((await f.request('order/status', { order_id: first.id }, other.cookie)).status, 404);
  await f.request('account/logout', {}, a.cookie);
  const restarted = await fixture(f.storage);
  const login = await restarted.request('account/login', { username: '测试账号', password: 'fictional-password-123' });
  assert.equal((await restarted.request('account/me', undefined, login.cookie)).body.orders.length, 20);
});

test('account isolation prevents reading or viewing another user order or conversation', async () => {
  const f = await fixture(), a = await register(f), b = await register(f, '另一账号'), o = await buy(f, a.cookie);
  assert.equal((await f.request('order/status', { order_id: o.id }, b.cookie)).status, 404);
  await model(async () => {
    const r = await f.request('paid/reading', reading(), a.cookie); assert.equal(r.status, 200);
    assert.equal((await f.request('paid/followup', { session_id: r.body.session_id, request_id: crypto.randomUUID(), message: '另一个用户追问' }, b.cookie)).status, 410);
  });
});

test('paid model reading debits once, retries across restart, and keeps prompt and answer encrypted', async () => {
  const f = await fixture(), a = await register(f); await buy(f, a.cookie); const p = reading();
  await model(async calls => {
    const r = await f.request('paid/reading', p, a.cookie); assert.equal(r.status, 200, r.body.error);
    assert.match(r.body.answer, /虚构模型回答/); assert.equal(r.body.account.paid.balance.triple, 0);
    const next = await fixture(f.storage), again = await next.request('paid/reading', p, a.cookie);
    assert.equal(again.status, 200); assert.equal(again.body.answer, r.body.answer); assert.equal(calls.length, 1);
    assert.equal((await f.request('paid/reading', { ...p, question: '换一个问题' }, a.cookie)).status, 409);
    assert.equal((await f.request('paid/reading', reading(), a.cookie)).status, 402);
    const stored = JSON.stringify([...f.storage.values.values()]); assert.ok(!stored.includes(p.question)); assert.ok(!stored.includes(r.body.answer));
  });
});

test('model failure refunds credit; retry uses the same operation and no duplicate charge', async () => {
  const f = await fixture(), a = await register(f); await buy(f, a.cookie); const p = reading();
  await model(async () => {
    const r = await f.request('paid/reading', p, a.cookie); assert.equal(r.status, 502);
    assert.equal((await f.request('account/me', undefined, a.cookie)).body.paid.balance.triple, 1);
  }, 429);
  await model(async calls => { assert.equal((await f.request('paid/reading', p, a.cookie)).status, 200); assert.equal(calls.length, 1); });
});

test('in-flight concurrency does not issue two model calls or spend two credits', async () => {
  const f = await fixture(), a = await register(f); await buy(f, a.cookie, 'triple-3');
  const original = globalThis.fetch; let release, started; const ready = new Promise(r => started = r), wait = new Promise(r => release = r); let calls = 0;
  globalThis.fetch = async () => { calls++; started(); await wait; return Response.json({ choices: [{ message: { content: '并发测试回答' } }] }); };
  try {
    const p = reading(), first = f.request('paid/reading', p, a.cookie); await ready;
    assert.equal((await f.request('paid/reading', p, a.cookie)).status, 409);
    assert.equal((await f.request('paid/reading', reading(), a.cookie)).status, 409);
    release(); assert.equal((await first).status, 200); assert.equal(calls, 1);
    assert.equal((await f.request('account/me', undefined, a.cookie)).body.paid.balance.triple, 2);
  } finally { release(); globalThis.fetch = original; }
});

test('followup is bound to one reading, idempotent, and capped to one pack round', async () => {
  const f = await fixture(), a = await register(f); await buy(f, a.cookie);
  await model(async calls => {
    const r = await f.request('paid/reading', reading(), a.cookie);
    const p = { session_id: r.body.session_id, request_id: crypto.randomUUID(), message: '今天先做哪一步？' };
    const one = await f.request('paid/followup', p, a.cookie); assert.equal(one.status, 200); assert.equal(one.body.followup_remaining, 0);
    assert.equal((await f.request('paid/followup', p, a.cookie)).status, 200); assert.equal(calls.length, 2);
    assert.equal((await f.request('paid/followup', { ...p, request_id: crypto.randomUUID() }, a.cookie)).status, 402);
    assert.equal((await f.request('paid/followup', { ...p, message: '改问题' }, a.cookie)).status, 409);
  });
});

test('followup model failure preserves the round and can retry', async () => {
  const f = await fixture(), a = await register(f); await buy(f, a.cookie);
  let r; await model(async () => { r = await f.request('paid/reading', reading(), a.cookie); });
  const p = { session_id: r.body.session_id, request_id: crypto.randomUUID(), message: '请把第一步说具体些' };
  await model(async () => assert.equal((await f.request('paid/followup', p, a.cookie)).status, 502), 429);
  await model(async () => assert.equal((await f.request('paid/followup', p, a.cookie)).body.followup_remaining, 0));
});

test('monthly allowance uses Beijing days, grants three rounds and falls back to packs', async () => {
  const f = await fixture(), a = await register(f); await buy(f, a.cookie, 'monthly'); await buy(f, a.cookie);
  await model(async () => {
    const r = await f.request('paid/reading', reading(), a.cookie); assert.equal(r.body.followup_remaining, 3);
    for (let i = 0; i < 3; i++) assert.equal((await f.request('paid/followup', { session_id: r.body.session_id, request_id: crypto.randomUUID(), message: '继续解释第' + i + '步' }, a.cookie)).body.followup_remaining, 2 - i);
    for (let i = 0; i < 2; i++) assert.equal((await f.request('paid/reading', reading(), a.cookie)).status, 200);
    const fallback = await f.request('paid/reading', reading(), a.cookie); assert.equal(fallback.status, 200); assert.equal(fallback.body.followup_remaining, 1);
    assert.equal((await f.request('paid/reading', reading(), a.cookie)).status, 402);
    const realNow = Date.now; Date.now = () => realNow() + 86400000;
    try { assert.equal((await f.request('paid/reading', reading(), a.cookie)).status, 200); } finally { Date.now = realNow; }
  });
});

test('wrong spread, invalid input and paused AI do not spend paid balance', async () => {
  const f = await fixture(), a = await register(f); await buy(f, a.cookie);
  assert.equal((await f.request('paid/reading', reading('single'), a.cookie)).status, 402);
  assert.equal((await f.request('paid/reading', { ...reading(), cards: [] }, a.cookie)).status, 400);
  f.gateway.env.GUANXIN_AI_ENABLED = 'false'; assert.equal((await f.request('paid/reading', reading(), a.cookie)).status, 503);
  assert.equal((await f.request('account/me', undefined, a.cookie)).body.paid.balance.triple, 1);
});

test('request boundaries and brute force limits reject cross-origin and forged admin access', async () => {
  const f = await fixture();
  const cross = await worker.fetch(new Request('https://site.invalid/api/admin/confirm', { method: 'POST', headers: { Origin: 'https://evil.invalid', 'Content-Type': 'application/json' }, body: '{}' }), f.env);
  assert.equal(cross.status, 403);
  for (let i = 0; i < 30; i++) assert.equal((await f.request('admin/order', {}, '', 'wrong-admin-key-that-is-long-enough-123')).status, 403);
  assert.equal((await f.request('admin/order', {}, '', adminKey)).status, 429);
});


test('after a process interruption, account refresh restores an expired reservation exactly once', async () => {
  const f = await fixture(), a = await register(f); await buy(f, a.cookie);
  const originalFetch = globalThis.fetch, realNow = Date.now;
  let release, started; const ready = new Promise(r => started = r), waiting = new Promise(r => release = r);
  globalThis.fetch = async () => { started(); await waiting; return Response.json({ choices: [{ message: { content: '过期的旧进程回答' } }] }); };
  try {
    const old = f.request('paid/reading', reading(), a.cookie); await ready;
    assert.equal((await f.request('account/me', undefined, a.cookie)).body.paid.balance.triple, 0);
    Date.now = () => realNow() + 121000;
    const restarted = await fixture(f.storage);
    assert.equal((await restarted.request('account/me', undefined, a.cookie)).body.paid.balance.triple, 1);
    assert.equal((await restarted.request('account/me', undefined, a.cookie)).body.paid.balance.triple, 1);
    release(); assert.equal((await old).status, 409);
    assert.equal((await restarted.request('account/me', undefined, a.cookie)).body.paid.balance.triple, 1);
  } finally { release(); Date.now = realNow; globalThis.fetch = originalFetch; }
});


test('admin setup requires the owner key, stores no plaintext, and cannot be repeated', async () => {
  const f = await fixture(); const p = { username: 'OwnerTest', password: 'fictional-admin-pass-123' };
  assert.equal((await f.request('admin/setup', p)).status, 403);
  assert.equal((await f.request('admin/setup', p, '', adminKey)).status, 200);
  assert.equal((await f.request('admin/setup', p, '', adminKey)).status, 409);
  const saved = await f.storage.get('admin:account'); assert.equal(saved.hash.length, 64);
  assert.ok(!JSON.stringify([...f.storage.values.values()]).includes(p.password));
});

test('admin login sets an isolated cookie, persists across restart and logout revokes access', async () => {
  const f = await fixture(); const p = { username: 'OwnerTest', password: 'fictional-admin-pass-123' };
  await f.request('admin/setup', p, '', adminKey);
  assert.equal((await f.request('admin/login', { ...p, password: 'wrong' })).status, 401);
  const login = await f.request('admin/login', p); assert.equal(login.status, 200);
  assert.ok(login.cookie.startsWith('__Host-guanxin_admin='));
  for (const flag of ['HttpOnly', 'Secure', 'SameSite=Lax']) assert.ok(login.headers.get('Set-Cookie').includes(flag));
  const user = await register(f); const o = await order(f, user.cookie);
  assert.equal((await f.request('admin/order', { order_id: o.id }, user.cookie)).status, 403);
  const restarted = await fixture(f.storage);
  assert.equal((await restarted.request('admin/order', { order_id: o.id }, login.cookie)).status, 200);
  assert.equal((await restarted.request('admin/session', {}, login.cookie)).body.authenticated, true);
  assert.equal((await restarted.request('admin/logout', {}, login.cookie)).status, 200);
  assert.equal((await restarted.request('admin/order', { order_id: o.id }, login.cookie)).status, 403);
});

test('admin sessions expire after two hours and login attempts are rate limited', async () => {
  const f = await fixture(), p = { username: 'OwnerTest', password: 'fictional-admin-pass-123' };
  await f.request('admin/setup', p, '', adminKey); const login = await f.request('admin/login', p);
  const realNow = Date.now; Date.now = () => realNow() + 7200001;
  try { assert.equal((await f.request('admin/session', {}, login.cookie)).body.authenticated, false); }
  finally { Date.now = realNow; }
  for (let i=0;i<9;i++) assert.equal((await f.request('admin/login', { ...p, password: 'bad' })).status, 401);
  assert.equal((await f.request('admin/login', p)).status, 429);
});


test('owner credentials sign in from the frontend and the same session opens admin routes', async () => {
  const f = await fixture(), owner = { username: 'OwnerTest', password: 'fictional-owner-password-123' };
  await f.request('admin/setup', owner, '', adminKey);
  const login = await f.request('account/login', { ...owner, username: 'ownertest' });
  assert.equal(login.status, 200); assert.equal(login.body.admin_test, true); assert.equal(login.body.user.name, 'OwnerTest');
  assert.ok(login.cookie.startsWith('__Host-guanxin_admin='));
  assert.equal((await f.request('admin/session', {}, login.cookie)).body.authenticated, true);
  assert.equal((await f.request('account/me', undefined, login.cookie)).body.admin_test, true);
  assert.equal((await f.request('admin/order', { order_id: crypto.randomUUID() }, login.cookie)).status, 404);
  assert.equal((await f.request('account/register', { ...owner, confirm_password: owner.password })).status, 409);
});

test('owner tests every spread and repeated followups without purchase, quotas, receipts or model call counters', async () => {
  const f = await fixture(), owner = { username: 'OwnerTest', password: 'fictional-owner-password-123' };
  await f.request('admin/setup', owner, '', adminKey); const login = await f.request('admin/login', owner);
  await model(async calls => {
    for (let i=0;i<2;i++) assert.equal((await f.request('free/reading', reading(), login.cookie)).status, 200);
    const complex = spreads.find(s => s.slots.length > 3 && s.category !== '选择');
    for (const id of ['single','basic',complex.id]) {
      const r = await f.request('paid/reading', reading(id), login.cookie);
      assert.equal(r.status, 200, r.body.error); assert.equal(r.body.admin_test, true);
      for (let i=0;i<4;i++) {
        const follow = await f.request('paid/followup', { session_id: r.body.session_id, request_id: crypto.randomUUID(), message: '继续测试第'+i+'步' }, login.cookie);
        assert.equal(follow.status, 200); assert.equal(follow.body.admin_test, true);
      }
    }
    assert.equal(calls.length, 15); assert.equal(f.gateway.calls.length, 0);
    const user = await f.storage.get('admin:test-user'); assert.equal(user.freeReceipt, null);
    assert.deepEqual(user.paidBalance, {single:0,triple:0,complex:0}); assert.deepEqual(user.paidUsed,{single:0,triple:0,complex:0}); assert.deepEqual(user.paidOrders,[]);
    assert.ok(![...f.storage.values.keys()].some(k=>k.startsWith('paid-order:')));
  });
});

test('owner logout and expiry revoke testing; forged frontend flags cannot unlock a normal account', async () => {
  const f = await fixture(), owner = { username: 'OwnerTest', password: 'fictional-owner-password-123' };
  await f.request('admin/setup', owner, '', adminKey); const login = await f.request('account/login', owner);
  await f.request('account/logout', {}, login.cookie);
  assert.equal((await f.request('admin/session', {}, login.cookie)).body.authenticated, false);
  assert.equal((await f.request('paid/reading', reading(), login.cookie)).status, 401);
  const user = await register(f);
  assert.equal((await f.request('paid/reading', { ...reading(), admin_test:true, isAdmin:true, role:'owner_test' }, user.cookie)).status, 402);
  const second = await f.request('admin/login', owner), realNow=Date.now; Date.now=()=>realNow()+7200001;
  try { assert.equal((await f.request('paid/reading', reading(), second.cookie)).status, 401); }
  finally { Date.now=realNow; }
});

test('preparation AI rejects anonymous, unpaid and forged access before calling the model', async () => {
  const f = await fixture(), a = await register(f);
  await model(async calls => {
    for (const path of ['paid/polish', 'paid/intake-questions']) {
      assert.equal((await f.request(path, reading())).status, 401);
      assert.equal((await f.request(path, { ...reading(), admin_test: true, role: 'owner_test', paid: true }, a.cookie)).status, 402);
    }
    assert.equal(calls.length, 0);
    assert.equal((await f.request('account/me', undefined, a.cookie)).body.free_remaining, 1);
  });
});

test('paid polish and dynamic questions use the actual question without consuming reading rights', async () => {
  const f = await fixture(), a = await register(f); await buy(f, a.cookie, 'single-1');
  const before = (await f.request('account/me', undefined, a.cookie)).body;
  await model(async calls => {
    const polished = await f.request('paid/polish', reading(), a.cookie);
    assert.equal(polished.status, 200); assert.match(polished.body.question, /小练习/);
    assert.match(calls[0].messages[1].content, /绘画练习/);
  });
  const questions = ['你最近一次绘画是什么时候？', '开始练习时最让你犹豫的是什么？', '你希望今天完成怎样的小作品？'];
  await model(async calls => {
    const result = await f.request('paid/intake-questions', reading(), a.cookie);
    assert.equal(result.status, 200); assert.deepEqual(result.body.questions, questions);
    assert.match(calls[0].messages[1].content, /绘画练习/);
  }, 200, JSON.stringify({ questions }));
  const after = (await f.request('account/me', undefined, a.cookie)).body;
  assert.deepEqual(after.paid, before.paid); assert.equal(after.free_remaining, before.free_remaining);
  assert.deepEqual(after.orders, before.orders); assert.equal(f.gateway.calls.length, 2);
  const user = await f.storage.get('user:测试账号'); user.paidBalance.single = 0; await f.storage.put('user:测试账号', user);
  assert.equal((await f.request('paid/polish', reading(), a.cookie)).status, 402);
});

test('preparation follows monthly expiry and daily allowance and preserves rights on model errors', async () => {
  const f = await fixture(), a = await register(f); await buy(f, a.cookie, 'monthly');
  await model(async () => assert.equal((await f.request('paid/polish', reading(), a.cookie)).status, 200));
  const key = 'user:测试账号', user = await f.storage.get(key);
  user.paidUsed = { single: 3, triple: 3, complex: 1 }; await f.storage.put(key, user);
  await model(async calls => {
    assert.equal((await f.request('paid/polish', reading(), a.cookie)).status, 402);
    user.paidUsed.single = 0; user.paidMemberUntil = Date.now() - 1; await f.storage.put(key, user);
    assert.equal((await f.request('paid/intake-questions', reading(), a.cookie)).status, 402);
    assert.equal(calls.length, 0);
  });
  await buy(f, a.cookie, 'single-1');
  const before = (await f.request('account/me', undefined, a.cookie)).body;
  await model(async () => assert.equal((await f.request('paid/polish', reading(), a.cookie)).status, 502), 429);
  await model(async () => assert.equal((await f.request('paid/intake-questions', reading(), a.cookie)).status, 502), 200, '{"questions":["相同？","相同？","第三问？"]}');
  assert.deepEqual((await f.request('account/me', undefined, a.cookie)).body, before);
  f.gateway.env.GUANXIN_AI_ENABLED = 'false';
  await model(async calls => {
    assert.equal((await f.request('paid/polish', reading(), a.cookie)).status, 503); assert.equal(calls.length, 0);
  });
});

test('owner preparation bypasses paid quotas but logout revokes access', async () => {
  const f = await fixture(), owner = { username: 'OwnerTest', password: 'fictional-owner-password-123' };
  await f.request('admin/setup', owner, '', adminKey); const login = await f.request('account/login', owner);
  await model(async calls => {
    assert.equal((await f.request('paid/polish', reading(), login.cookie)).status, 200);
    assert.equal(calls.length, 1); assert.equal(f.gateway.calls.length, 0);
  });
  await model(async () => {
    assert.equal((await f.request('paid/intake-questions', reading(), login.cookie)).status, 200);
  }, 200, '{"questions":["目前在练什么？","卡在哪里？","希望先完成什么？"]}');
  const me = (await f.request('account/me', undefined, login.cookie)).body;
  assert.equal(me.free_remaining, 1); assert.deepEqual(me.paid.balance, {single:0,triple:0,complex:0}); assert.deepEqual(me.orders,[]);
  await f.request('account/logout', {}, login.cookie);
  await model(async calls => {
    for (const path of ['paid/polish', 'paid/intake-questions']) assert.equal((await f.request(path, reading(), login.cookie)).status, 401);
    assert.equal(calls.length, 0);
  });
});

test('spread recommendation requires a real account and AI rights, passes actual background, and never spends a reading', async () => {
  const f = await fixture(), a = await register(f);
  const payload = { question: '如何开始练习绘画？', theme: '自我', background: [{ question: '每天能用多久？', answer: '十分钟' }] };
  await model(async calls => {
    assert.equal((await f.request('paid/recommend-spread', payload)).status, 401);
    assert.equal((await f.request('paid/recommend-spread', { ...payload, admin_test: true }, a.cookie)).status, 402);
    assert.equal((await f.request('recommend-spread', payload, a.cookie)).status, 402);
    assert.equal(calls.length, 0);
  });
  await buy(f, a.cookie);
  const before = (await f.request('account/me', undefined, a.cookie)).body;
  await model(async calls => {
    const result = await f.request('paid/recommend-spread', payload, a.cookie);
    assert.equal(result.status, 200); assert.equal(result.body.spread_id, 'triangle');
    const context = JSON.parse(calls[0].messages[1].content);
    assert.equal(context.问题, payload.question); assert.equal(context.背景[0].回答, '十分钟');
    assert.equal(context.可选牌阵.length, 26);
  }, 200, '{"spread_id":"triangle","reason":"用三张牌先梳理当下、阻碍和行动。"}');
  assert.deepEqual((await f.request('account/me', undefined, a.cookie)).body, before);
  for (const [status, content] of [[503, 'private upstream'], [200, '{"spread_id":"invented","reason":"不合法的牌阵"}']]) {
    await model(async () => assert.equal((await f.request('paid/recommend-spread', payload, a.cookie)).status, 502), status, content);
    assert.deepEqual((await f.request('account/me', undefined, a.cookie)).body, before);
  }
});

test('spread recommendation supports zero-balance trial and owner, but rejects expired trial and logged-out owner', async () => {
  const f = await fixture(), a = await register(f), payload = { question: '怎样开始？', theme: '自我', background: [] };
  openTrial(f);
  await model(async () => assert.equal((await f.request('paid/recommend-spread', payload, a.cookie)).status, 200), 200,
    '{"spread_id":"single","reason":"先关注当下可以尝试的一步。"}');
  f.gateway.env.GUANXIN_TRIAL_END = new Date(Date.now() - 1).toISOString();
  await model(async calls => { assert.equal((await f.request('paid/recommend-spread', payload, a.cookie)).status, 402); assert.equal(calls.length, 0); });
  const owner = { username: 'OwnerTest', password: 'fictional-owner-password-123' };
  await f.request('admin/setup', owner, '', adminKey); const login = await f.request('account/login', owner);
  await model(async () => assert.equal((await f.request('paid/recommend-spread', payload, login.cookie)).status, 200), 200,
    '{"spread_id":"single","reason":"先关注当下。"}');
  assert.equal(f.gateway.calls.length, 1); // Trial counts; the owner call bypasses this counter.
  await f.request('account/logout', {}, login.cookie);
  assert.equal((await f.request('paid/recommend-spread', payload, login.cookie)).status, 401);
});
