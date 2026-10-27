import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker, { AIGateway, buildContext } from './index.js';
import { spreads, cardLibrary } from './generated-library.js';

const env = { FLOWBEE_API_KEY: 'fake-test-secret-not-a-real-key', FLOWBEE_MODEL: 'test-model', FLOWBEE_BASE_URL: 'https://model.invalid/v1' };
const spread = spreads.find(s => s.slots.length === 3 && s.category !== '选择');
const payload = { question: '我如何安排绘画学习？', theme: '自我', spread_id: spread.id,
  cards: spread.slots.map((s, id) => ({ id, reversed: id === 1 })), background: [{ question: '卡在哪里？', answer: '总是拖延' }] };
const gateway = () => new AIGateway({}, { ...env });
const post = (path, value, ip = 'test-ip') => new Request('https://gateway.internal/api/' + path,
  { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Visitor-IP': ip }, body: JSON.stringify(value) });
async function mocked(content, run, status = 200) {
  const original = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url, ...JSON.parse(init.body) });
    return Response.json(status === 200 ? { choices: [{ message: { content } }] } : { error: env.FLOWBEE_API_KEY }, { status });
  };
  try { return await run(requests); } finally { globalThis.fetch = original; }
}

test('78 cards and 25 spreads use authoritative names, positions and orientations', () => {
  assert.equal(cardLibrary.length, 78); assert.equal(spreads.length, 25);
  const context = buildContext({ ...payload, cards: payload.cards.map(c => ({ ...c, name: '伪造牌名' })) });
  assert.equal(context.本次抽牌[0].牌名, cardLibrary[0].name);
  assert.equal(context.本次抽牌[1].朝向, '逆位');
  assert.deepEqual(context.本次抽牌[1].参考牌义, cardLibrary[1].reversed);
  assert.deepEqual(context.本次抽牌[1].牌位, spread.slots[1]);
});

test('invalid cards, counts, theme, background and ambiguous options are rejected', () => {
  const choose = spreads.find(s => s.category === '选择');
  for (const value of [null, { ...payload, theme: '伪造' }, { ...payload, question: '' }, { ...payload, spread_id: '__proto__' },
    { ...payload, cards: [] }, { ...payload, cards: payload.cards.map(() => ({ id: 0, reversed: false })) },
    { ...payload, cards: payload.cards.map(c => ({ ...c, id: true })) }, { ...payload, cards: payload.cards.map(c => ({ ...c, reversed: 'false' })) },
    { ...payload, background: [null] }, { ...payload, background: Array(4).fill({ question: '', answer: '' }) },
    { ...payload, spread_id: choose.id, cards: choose.slots.map((s, id) => ({ id, reversed: false })), option_a: '一样', option_b: '一样' }])
    assert.throws(() => buildContext(value));
});

test('polish and both preparation endpoints preserve response contracts', async () => {
  await mocked('我如何开始学习绘画？', async () => {
    const r = await gateway().fetch(post('polish', payload)); assert.equal(r.status, 200); assert.match((await r.json()).question, /绘画/);
  });
  await mocked('```json\n{"questions":["目前学了什么？","哪里最困难？","希望做到什么？"]}\n```', async () => {
    const r = await gateway().fetch(post('intake-questions', payload)); assert.equal(r.status, 200); assert.equal((await r.json()).questions.length, 3);
  });
  await mocked(JSON.stringify({ spread_id: spread.id, reason: '三个牌位帮助整理学习步骤。' }), async requests => {
    const r = await gateway().fetch(post('recommend-spread', payload)); assert.equal(r.status, 200);
    const context = JSON.parse(requests[0].messages[1].content);
    assert.equal(context.可选牌阵.length, 25); assert.equal(context.背景[0].回答, '总是拖延');
  });
});

test('malformed, duplicate questions and invented spread recommendations fail safely', async () => {
  for (const [path, content] of [['intake-questions', '{}'], ['intake-questions', '{"questions":["a","a","b"]}'],
    ['recommend-spread', '{"spread_id":"invented","reason":"推荐"}'], ['recommend-spread', '{"spread_id":"__proto__","reason":"推荐"}']]) {
    await mocked(content, async () => { const r = await gateway().fetch(post(path, payload)); assert.equal(r.status, 502); });
  }
});

test('encrypted session survives gateway replacement, preserves cards and recent followups', async () => {
  await mocked('这是虚构测试回复。', async requests => {
    const r = await gateway().fetch(post('reading', payload)); assert.equal(r.status, 200);
    const first = await r.json(); assert.ok(first.session_id.startsWith('v1.')); assert.ok(!first.session_id.includes(payload.question));
    const next = await gateway().fetch(post('followup', { session_id: first.session_id, message: '第一步做什么？' })); assert.equal(next.status, 200);
    const second = await next.json(); assert.notEqual(second.session_id, first.session_id);
    assert.equal(requests[0].messages[1].content, requests[1].messages[1].content);
    const third = await gateway().fetch(post('followup', { session_id: second.session_id, message: '第二步呢？' })); assert.equal(third.status, 200);
    assert.ok(requests[2].messages.some(m => m.content === '第一步做什么？'));
    assert.equal(requests[2].messages[1].content, requests[0].messages[1].content);
  });
});

test('tampered, expired and changed-key sessions never call the model', async () => {
  const app = gateway();
  const token = await app.seal({ version: 1, expires: Date.now() + 3600000, context: buildContext(payload), history: [] });
  const expired = await app.seal({ version: 1, expires: Date.now() - 1, context: {}, history: [] });
  await mocked('should not run', async requests => {
    for (const id of ['v1.invalid', expired, token.slice(0, 12) + (token[12] === 'A' ? 'B' : 'A') + token.slice(13)]) {
      assert.equal((await app.fetch(post('followup', { session_id: id, message: '追问' }))).status, 410);
    }
    const changed = new AIGateway({}, { ...env, FLOWBEE_API_KEY: 'different-fake-key' });
    assert.equal((await changed.fetch(post('followup', { session_id: token, message: '追问' }))).status, 410);
    assert.equal(requests.length, 0);
  });
});

test('short conversation stays bounded across many large replies', async () => {
  await mocked('测'.repeat(11900), async requests => {
    const app = gateway();
    let data = await (await app.fetch(post('reading', payload))).json();
    for (let i = 0; i < 12; i++) {
      const response = await app.fetch(post('followup', { session_id: data.session_id, message: '问'.repeat(600) }));
      assert.equal(response.status, 200); data = await response.json();
      assert.ok(data.session_id.length < 180000);
      const state = await app.open(data.session_id);
      assert.ok(state.history.length <= 5);
      assert.ok(state.history.reduce((n, m) => n + m.content.length, 0) <= 24000);
    }
    assert.equal(requests.length, 13);
  });
});

test('upstream errors, invalid JSON and oversized replies do not leak upstream data or keys', async () => {
  for (const status of [401, 403, 429, 500]) await mocked('unused', async () => {
    const r = await gateway().fetch(post('polish', payload)); assert.equal(r.status, 502);
    assert.ok(!(await r.text()).includes(env.FLOWBEE_API_KEY));
  }, status);
  const original = globalThis.fetch;
  try {
    for (const body of ['invalid-json', 'x'.repeat(1048577)]) {
      globalThis.fetch = async () => new Response(body);
      const r = await gateway().fetch(post('polish', payload)); assert.ok(r.status >= 400);
    }
    globalThis.fetch = async () => { throw new Error('network error ' + env.FLOWBEE_API_KEY); };
    const r = await gateway().fetch(post('polish', payload)); assert.equal(r.status, 504); assert.ok(!(await r.text()).includes(env.FLOWBEE_API_KEY));
  } finally { globalThis.fetch = original; }
});

test('20 per-IP hourly requests and 300 daily requests coordinate in a gateway', async () => {
  await mocked('清晰的问题？', async () => {
    const app = gateway();
    for (let i = 0; i < 20; i++) assert.equal((await app.fetch(post('polish', payload))).status, 200);
    assert.equal((await app.fetch(post('polish', payload))).status, 429);
    const global = gateway();
    for (let i = 0; i < 300; i++) assert.equal((await global.fetch(post('polish', payload, 'ip-' + i))).status, 200);
    assert.equal((await global.fetch(post('polish', payload, 'new-ip'))).status, 429);
  });
});

test('same session concurrent followup returns 409', async () => {
  const app = gateway();
  const id = await app.seal({ version: 1, expires: Date.now() + 3600000, context: buildContext(payload), history: [] });
  const original = globalThis.fetch;
  let release; let started;
  const ready = new Promise(resolve => { started = resolve; });
  globalThis.fetch = async () => { started(); await new Promise(resolve => { release = resolve; }); return Response.json({ choices: [{ message: { content: '回复' } }] }); };
  try {
    const first = app.fetch(post('followup', { session_id: id, message: '问题' }));
    await ready;
    const second = await app.fetch(post('followup', { session_id: id, message: '重复问题' })); assert.equal(second.status, 409);
    release(); assert.equal((await first).status, 200);
  } finally { globalThis.fetch = original; }
});

test('routing enforces same-origin JSON, pause switches and static file allowlist', async () => {
  const stub = { idFromName: name => name, get: () => ({ fetch: async () => jsonStub() }) };
  const jsonStub = () => Response.json({ ok: true });
  let assetsCalled = 0;
  const full = { ...env, AI_GATEWAY: stub, ASSETS: { fetch: async () => { assetsCalled++; return new Response('page'); } } };
  const request = (path, origin = 'https://site.invalid', type = 'application/json') => new Request('https://site.invalid' + path,
    { method: 'POST', headers: { Origin: origin, 'Content-Type': type }, body: '{}' });
  assert.equal((await worker.fetch(request('/api/polish', 'https://evil.invalid'), full)).status, 403);
  assert.equal((await worker.fetch(request('/api/polish', 'https://site.invalid', 'text/plain'), full)).status, 415);
  assert.equal((await worker.fetch(request('/api/polish'), full)).status, 200);
  assert.equal((await worker.fetch(request('/api/polish'), { ...full, GUANXIN_AI_ENABLED: 'false' })).status, 503);
  const status = await worker.fetch(new Request('https://site.invalid/api/status'), { ...full, GUANXIN_AI_ENABLED: 'false' }); assert.equal((await status.json()).configured, false);
  assert.equal((await worker.fetch(new Request('https://site.invalid/'), { ...full, GUANXIN_SITE_ENABLED: 'false' })).status, 503);
  assert.equal(assetsCalled, 0);
  for (const path of ['/llm-backend/config.local.json', '/worker/index.js', '/wrangler.jsonc']) assert.equal((await worker.fetch(new Request('https://site.invalid' + path), full)).status, 404);
  const page = await worker.fetch(new Request('https://site.invalid/'), full); assert.equal(page.status, 200); assert.equal(page.headers.get('Cache-Control'), 'no-store');
  assert.equal(assetsCalled, 1);
});

test('oversized or invalid client JSON is rejected before a model call', async () => {
  for (const body of ['{', 'x'.repeat(196609)]) {
    const response = await gateway().fetch(new Request('https://gateway.internal/api/polish', { method: 'POST', body })); assert.ok([400, 413].includes(response.status));
  }
});
