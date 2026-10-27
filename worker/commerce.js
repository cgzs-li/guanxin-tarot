// Demo commerce only. No handler here calls a model or creates a paid entitlement.
const enc = new TextEncoder();
const DAY = 86400000;
const SESSION_COOKIE = '__Host-guanxin_session';
export const products = [
  { id: 'single-1', title: '单张次卡', tier: 'single', count: 1, price: 190 },
  { id: 'single-5', title: '单张 5 次包', tier: 'single', count: 5, price: 790 },
  { id: 'triple-1', title: '三张次卡', tier: 'triple', count: 1, price: 390 },
  { id: 'triple-3', title: '三张 3 次包', tier: 'triple', count: 3, price: 990 },
  { id: 'complex-1', title: '复杂牌阵次卡', tier: 'complex', count: 1, price: 990 },
  { id: 'complex-3', title: '复杂牌阵 3 次包', tier: 'complex', count: 3, price: 2590 },
  { id: 'monthly', title: '观心月卡', tier: 'monthly', count: 30, price: 2990 }
];
export const commercePaths = new Set([
  '/api/account/me', '/api/account/register', '/api/account/login', '/api/account/logout',
  '/api/demo/order', '/api/demo/checkout', '/api/demo/reading', '/api/demo/followup', '/api/free/reading'
]);
class CommerceError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
const hex = bytes => Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
async function digest(value) { return hex(await crypto.subtle.digest('SHA-256', enc.encode(value))); }
function reply(data, status = 200, cookie) {
  const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
  if (cookie) headers['Set-Cookie'] = cookie;
  return Response.json(data, { status, headers });
}
function id(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9-]{16,80}$/.test(value)) throw new CommerceError('操作编号无效，请刷新后重试。');
  return value;
}
function name(value) {
  if (typeof value !== 'string') throw new CommerceError('请填写账号。');
  const result = value.normalize('NFKC').trim().toLowerCase();
  if (!/^[\p{L}\p{N}_-]{3,24}$/u.test(result)) throw new CommerceError('账号请使用 3～24 位中文、字母、数字、横线或下划线。');
  return result;
}
function password(value) {
  if (typeof value !== 'string' || value.length < 8 || value.length > 72) throw new CommerceError('密码请使用 8～72 个字符。');
  return value;
}
async function passwordHash(value, salt) {
  const key = await crypto.subtle.importKey('raw', enc.encode(value), 'PBKDF2', false, ['deriveBits']);
  return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: enc.encode(salt), iterations: 100000, hash: 'SHA-256' }, key, 256));
}
function equal(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
const chinaDay = () => new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
export const spreadTier = count => count === 1 ? 'single' : count === 3 ? 'triple' : 'complex';
function allowance(user) {
  const day = chinaDay();
  const used = user.demoDay === day ? user.demoUsed : { single: 0, triple: 0, complex: 0 };
  const member = user.demoMemberUntil > Date.now();
  return {
    mode: 'demo', user: { id: user.id, name: user.name },
    free_remaining: user.freeReceipt ? 0 : 1,
    demo: { balance: user.demoBalance, member_until: user.demoMemberUntil || null,
      remaining_today: member ? { single: Math.max(0, 3 - used.single), triple: Math.max(0, 3 - used.triple), complex: Math.max(0, 1 - used.complex) } : null },
    real_ai_available: false
  };
}
export class Commerce {
  constructor(state, validate) { this.storage = state.storage; this.validate = validate; }
  async rate(request, kind, limit, windowMs) {
    const key = 'rate:' + kind + ':' + (await digest(request.headers.get('X-Visitor-IP') || 'unknown')).slice(0, 32);
    await this.storage.transaction(async tx => {
      const now = Date.now();
      let value = await tx.get(key);
      if (!value || now - value.start >= windowMs) value = { start: now, count: 0 };
      if (value.count >= limit) throw new CommerceError('操作较频繁，请稍后再试。', 429);
      value.count++;
      await tx.put(key, value);
    });
  }
  async account(request, required = true) {
    const token = (request.headers.get('Cookie') || '').split(';').map(s => s.trim()).find(s => s.startsWith(SESSION_COOKIE + '='))?.slice(SESSION_COOKIE.length + 1);
    if (token && /^[a-f0-9]{64}$/.test(token)) {
      const sessionKey = 'session:' + await digest(token);
      const session = await this.storage.get(sessionKey);
      if (session?.expires > Date.now()) {
        const user = await this.storage.get(session.userKey);
        if (user) return { key: session.userKey, sessionKey, user };
      } else if (session) await this.storage.delete(sessionKey);
    }
    if (required) throw new CommerceError('请先登录，免费机会和演示权益会保存在你的账号里。', 401);
    return null;
  }
  async signIn(userKey) {
    const token = hex(crypto.getRandomValues(new Uint8Array(32)));
    const sessionKey = 'session:' + await digest(token);
    const expires = Date.now() + 7 * DAY;
    const user = await this.storage.transaction(async tx => {
      const current = await tx.get(userKey);
      const sessions = current.sessions || [];
      for (const old of sessions.slice(0, Math.max(0, sessions.length - 4))) await tx.delete(old);
      current.sessions = sessions.slice(-4).concat(sessionKey);
      await tx.put(sessionKey, { userKey, expires });
      await tx.put(userKey, current);
      return current;
    });
    return reply(allowance(user), 200, SESSION_COOKIE + '=' + token + '; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=604800');
  }
  async me(request) {
    const account = await this.account(request, false);
    if (!account) return reply({ mode: 'demo', user: null, real_ai_available: false });
    const orders = await Promise.all((account.user.orders || []).slice(-12).reverse().map(orderId => this.storage.get('order:' + orderId)));
    return reply({ ...allowance(account.user), orders: orders.filter(Boolean).map(o => ({ id: o.id, product_id: o.productId, title: o.title, price: o.price, status: o.status, created: o.created })) });
  }
  async register(request, payload) {
    await this.rate(request, 'register', 5, 3600000);
    const username = name(payload.username), pass = password(payload.password);
    if (payload.confirm_password !== pass) throw new CommerceError('两次输入的密码不一致。');
    const salt = hex(crypto.getRandomValues(new Uint8Array(16)));
    const hash = await passwordHash(pass, salt);
    const key = 'user:' + username;
    await this.storage.transaction(async tx => {
      if (await tx.get(key)) throw new CommerceError('这个账号已被使用，请换一个或直接登录。', 409);
      await tx.put(key, { id: crypto.randomUUID(), name: username, salt, hash, created: Date.now(),
        freeReceipt: null, demoBalance: { single: 0, triple: 0, complex: 0 }, demoMemberUntil: 0, orders: [] });
    });
    return this.signIn(key);
  }
  async login(request, payload) {
    await this.rate(request, 'login', 15, 900000);
    const username = name(payload.username), pass = password(payload.password);
    const key = 'user:' + username, user = await this.storage.get(key);
    const hash = await passwordHash(pass, user?.salt || 'missing-account-salt');
    if (!user || !equal(hash, user.hash)) throw new CommerceError('账号或密码不正确，请检查后重试。', 401);
    return this.signIn(key);
  }
  async freeReading(account, payload) {
    const context = this.validate(payload);
    const operation = id(payload.request_id), fingerprint = await digest(JSON.stringify(context));
    const user = await this.storage.transaction(async tx => {
      const user = await tx.get(account.key);
      if (user.freeReceipt && (user.freeReceipt.id !== operation || user.freeReceipt.fingerprint !== fingerprint))
        throw new CommerceError('你的免费本地解读已使用。可以查看套餐，或继续浏览牌义资料库。', 402);
      user.freeReceipt = { id: operation, fingerprint, created: user.freeReceipt?.created || Date.now() };
      await tx.put(account.key, user);
      return user;
    });
    return reply({ context, receipt_id: operation, account: allowance(user), mode: 'local' });
  }
  async order(account, payload) {
    const product = products.find(p => p.id === payload.product_id);
    if (!product) throw new CommerceError('套餐不存在。');
    const operation = id(payload.request_id);
    const result = await this.storage.transaction(async tx => {
      const key = 'order-request:' + account.user.id + ':' + operation;
      const oldId = await tx.get(key);
      if (oldId) {
        const old = await tx.get('order:' + oldId);
        if (old.productId !== product.id) throw new CommerceError('操作编号已用于其他套餐，请重新选择。', 409);
        return old;
      }
      const user = await tx.get(account.key);
      const day = chinaDay();
      if (user.orderDay !== day) { user.orderDay = day; user.orderCount = 0; }
      if (user.orderCount >= 30) throw new CommerceError('今天演示订单较多，请明天再试。', 429);
      const order = { id: crypto.randomUUID(), userId: user.id, productId: product.id, title: product.title,
        price: product.price, status: 'demo_pending', created: Date.now() };
      user.orders = (user.orders || []).slice(-19).concat(order.id);
      user.orderCount++;
      await tx.put('order:' + order.id, order);
      await tx.put(key, order.id);
      await tx.put(account.key, user);
      return order;
    });
    return reply({ order: result, simulated: true });
  }
  async checkout(account, payload) {
    const orderId = id(payload.order_id);
    const result = await this.storage.transaction(async tx => {
      const order = await tx.get('order:' + orderId);
      if (!order || order.userId !== account.user.id) throw new CommerceError('未找到属于你的订单。', 404);
      const user = await tx.get(account.key);
      if (order.status === 'demo_pending') {
        const product = products.find(p => p.id === order.productId);
        if (product.tier === 'monthly') user.demoMemberUntil = Math.max(Date.now(), user.demoMemberUntil || 0) + 30 * DAY;
        else user.demoBalance[product.tier] += product.count;
        order.status = 'demo_completed'; order.completed = Date.now();
        await tx.put('order:' + order.id, order);
        await tx.put(account.key, user);
      }
      return { order, account: allowance(user), simulated: true };
    });
    return reply(result);
  }
  demoAnswer(context) {
    const cards = context.本次抽牌;
    const action = (cards.find(c => c.牌位.kind === 'action') || cards[0]).参考牌义.action;
    return '【付费功能演示 · 本地示例，不是大模型回答】\n\n' +
      cards.map(c => c.牌位.title + '：' + c.牌名 + ' · ' + c.朝向 + '\n' + c.参考牌义.meaning).join('\n\n') +
      '\n\n可以先尝试\n' + action +
      '\n\n请将这些意象与真实经历对照。这份示例不分析他人的内心，也不预测结果；正式 AI 解读将在接通支付后开放。';
  }
  async demoReading(account, payload) {
    const context = this.validate(payload), operation = id(payload.request_id);
    const fingerprint = await digest(JSON.stringify(context));
    const tier = spreadTier(payload.cards.length);
    const answer = this.demoAnswer(context);
    const result = await this.storage.transaction(async tx => {
      const existing = await tx.get('demo-request:' + account.user.id + ':' + operation);
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw new CommerceError('该操作编号已用于其他抽牌，请刷新后重试。', 409);
        const session = await tx.get('demo-reading:' + existing.sessionId);
        if (!session || session.expires <= Date.now()) throw new CommerceError('演示对话已过期，请重新开始。', 410);
        return { session_id: existing.sessionId, followup_remaining: session.limit - session.used, account: allowance(await tx.get(account.key)) };
      }
      const user = await tx.get(account.key), day = chinaDay();
      if (user.demoDay !== day) { user.demoDay = day; user.demoUsed = { single: 0, triple: 0, complex: 0 }; user.demoTotal = 0; }
      if (user.demoTotal >= 40) throw new CommerceError('今天的功能演示已达上限，请明天再试。', 429);
      const member = user.demoMemberUntil > Date.now();
      const cap = tier === 'complex' ? 1 : 3;
      if (member && user.demoUsed[tier] < cap) user.demoUsed[tier]++;
      else if (user.demoBalance[tier] > 0) user.demoBalance[tier]--;
      else throw new CommerceError('当前牌阵的演示次数不足，请选择对应的次数包或月卡。', 402);
      user.demoTotal++;
      const sessionId = crypto.randomUUID(), limit = member ? 3 : 1;
      await tx.put('demo-reading:' + sessionId, { userId: user.id, spreadId: payload.spread_id, cards: payload.cards, used: 0, limit, expires: Date.now() + 3600000 });
      await tx.put('demo-request:' + user.id + ':' + operation, { sessionId, fingerprint });
      await tx.put(account.key, user);
      return { session_id: sessionId, followup_remaining: limit, account: allowance(user) };
    });
    return reply({ ...result, answer, simulated: true });
  }
  async demoFollowup(account, payload) {
    const sessionId = id(payload.session_id), operation = id(payload.request_id);
    if (typeof payload.message !== 'string' || !payload.message.trim() || payload.message.length > 600) throw new CommerceError('追问请填写 1～600 个字符。');
    const fingerprint = await digest(payload.message.trim());
    const result = await this.storage.transaction(async tx => {
      const session = await tx.get('demo-reading:' + sessionId);
      if (!session || session.userId !== account.user.id || session.expires <= Date.now()) throw new CommerceError('这次演示对话已过期，请重新开始。', 410);
      const key = 'demo-followup:' + sessionId + ':' + operation;
      const old = await tx.get(key);
      if (old) {
        if (old.fingerprint !== fingerprint) throw new CommerceError('该操作编号已用于另一条追问。', 409);
        return { followup_remaining: session.limit - session.used };
      }
      if (session.used >= session.limit) throw new CommerceError('本次演示的追问已用完。次卡含 1 轮，月卡含 3 轮。', 402);
      session.used++;
      await tx.put('demo-reading:' + sessionId, session);
      await tx.put(key, { fingerprint });
      return { followup_remaining: session.limit - session.used };
    });
    return reply({ ...result, session_id: sessionId, simulated: true,
      answer: '【追问演示 · 固定示例，不是大模型回答】\n\n正式开放后，AI 会结合原问题、同一组牌和对话继续回答。当前只演示追问流程与轮数。\n\n你可以先把追问整理成三点：已经发生的事实、仍未确认的信息，以及自己愿意尝试的一小步。' });
  }
  async fetch(request, payload) {
    try {
      const path = new URL(request.url).pathname;
      if (path === '/api/account/me') return await this.me(request);
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new CommerceError('请求格式不正确。');
      if (path === '/api/account/register') return await this.register(request, payload);
      if (path === '/api/account/login') return await this.login(request, payload);
      const account = await this.account(request);
      if (path === '/api/account/logout') {
        await this.storage.delete(account.sessionKey);
        return reply({ ok: true }, 200, SESSION_COOKIE + '=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0');
      }
      if (path === '/api/free/reading') return await this.freeReading(account, payload);
      if (path === '/api/demo/order') return await this.order(account, payload);
      if (path === '/api/demo/checkout') return await this.checkout(account, payload);
      if (path === '/api/demo/reading') return await this.demoReading(account, payload);
      if (path === '/api/demo/followup') return await this.demoFollowup(account, payload);
      return reply({ error: '接口不存在。' }, 404);
    } catch (error) {
      return reply({ error: error.status ? error.message : '暂时无法完成操作，请稍后重试。' }, error.status || 500);
    }
  }
}

