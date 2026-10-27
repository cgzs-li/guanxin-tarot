// Account-based trial and manually verified paid access. Legacy demo balances are never used.
import { PaidService, paidPaths, paidSummary } from './paid.js';
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
  '/api/free/reading', '/api/paid/polish', '/api/paid/intake-questions', ...paidPaths
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
  return { mode: 'paid', admin_test: user.role === 'owner_test', user: { id: user.id, name: user.name }, free_remaining: user.freeReceipt ? 0 : 1,
    paid: paidSummary(user) };
}
export class Commerce {
  constructor(state, validate, gateway) { this.storage = state.storage; this.validate = validate; this.gateway = gateway; this.paid = new PaidService(state, gateway, products); }
  accountData(user) { return allowance(user); }
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
  async ownerAccount(session) {
    const key = 'admin:test-user';
    const user = await this.storage.transaction(async tx => {
      let user = await tx.get(key);
      if (!user) { user = { id: crypto.randomUUID(), name: session.username, role: 'owner_test', freeReceipt: null,
        paidBalance: { single: 0, triple: 0, complex: 0 }, paidMemberUntil: 0, paidOrders: [] }; await tx.put(key, user); }
      return user;
    });
    return { key, user, isAdmin: true, sessionKey: session.key };
  }
  async account(request, required = true) {
    const admin = await this.paid.auth.session(request);
    if (admin) return this.ownerAccount(admin);
    const token = (request.headers.get('Cookie') || '').split(';').map(s => s.trim()).find(s => s.startsWith(SESSION_COOKIE + '='))?.slice(SESSION_COOKIE.length + 1);
    if (token && /^[a-f0-9]{64}$/.test(token)) {
      const sessionKey = 'session:' + await digest(token);
      const session = await this.storage.get(sessionKey);
      if (session?.expires > Date.now()) {
        const user = await this.storage.get(session.userKey);
        if (user) return { key: session.userKey, sessionKey, user };
      } else if (session) await this.storage.delete(sessionKey);
    }
    if (required) throw new CommerceError('请先登录，免费机会和付费权益会保存在你的账号里。', 401);
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
    await this.paid.recover({ key: userKey });
    return reply(allowance(await this.storage.get(userKey)), 200, SESSION_COOKIE + '=' + token + '; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=604800');
  }
  async me(request) {
    const account = await this.account(request, false);
    if (!account) return reply({ mode: 'paid', user: null });
    await this.paid.recover(account);
    account.user = await this.storage.get(account.key);
    const orders = await Promise.all((account.user.paidOrders || []).slice(-12).reverse().map(orderId => this.storage.get('paid-order:' + orderId)));
    return reply({ ...allowance(account.user), orders: orders.filter(Boolean).map(o => this.paid.publicOrder(o)) });
  }
  async register(request, payload) {
    await this.rate(request, 'register', 5, 3600000);
    const username = name(payload.username), pass = password(payload.password);
    const owner = await this.storage.get('admin:account');
    if (owner && name(owner.username) === username) throw new CommerceError('这是负责人账号，请直接使用登录。', 409);
    if (payload.confirm_password !== pass) throw new CommerceError('两次输入的密码不一致。');
    const salt = hex(crypto.getRandomValues(new Uint8Array(16)));
    const hash = await passwordHash(pass, salt);
    const key = 'user:' + username;
    await this.storage.transaction(async tx => {
      if (await tx.get(key)) throw new CommerceError('这个账号已被使用，请换一个或直接登录。', 409);
      await tx.put(key, { id: crypto.randomUUID(), name: username, salt, hash, created: Date.now(),
        freeReceipt: null, paidBalance: { single: 0, triple: 0, complex: 0 }, paidMemberUntil: 0, paidOrders: [] });
    });
    return this.signIn(key);
  }
  async login(request, payload) {
    await this.rate(request, 'login', 15, 900000);
    const username = name(payload.username), pass = password(payload.password);
    const owner = await this.storage.get('admin:account');
    if (owner && name(owner.username) === username) {
      const result = await this.paid.auth.login({ username: owner.username, password: pass }, request, this.rate.bind(this));
      const account = await this.ownerAccount({ username: owner.username });
      return reply(allowance(account.user), 200, result.cookie);
    }
    const key = 'user:' + username, user = await this.storage.get(key);
    const hash = await passwordHash(pass, user?.salt || 'missing-account-salt');
    if (!user || !equal(hash, user.hash)) throw new CommerceError('账号或密码不正确，请检查后重试。', 401);
    return this.signIn(key);
  }
  async freeReading(account, payload) {
    const context = this.validate(payload);
    if (account.isAdmin) return reply({ context, account: allowance(account.user), mode: 'local', admin_test: true });
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
  async fetch(request, payload) {
    try {
      const path = new URL(request.url).pathname;
      if (path === '/api/account/me') return await this.me(request);
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new CommerceError('请求格式不正确。');
      if (path === '/api/account/register') return await this.register(request, payload);
      if (path === '/api/account/login') return await this.login(request, payload);
      const ip = request.headers.get('X-Visitor-IP');
      if (path.startsWith('/api/admin/')) {
        const auth = this.paid.auth;
        if (path === '/api/admin/login') {
          const result = await auth.login(payload, request, this.rate.bind(this));
          return reply(result.data, 200, result.cookie);
        }
        if (path === '/api/admin/logout') return reply({ ok: true }, 200, await auth.logout(request));
        if (path === '/api/admin/session') {
          const session = await auth.session(request);
          return reply({ authenticated: Boolean(session), username: session?.username || null });
        }
        if (path === '/api/admin/setup') {
          await this.paid.admin(request, this.rate.bind(this), true);
          return reply(await auth.setup(payload));
        }
        await this.paid.admin(request, this.rate.bind(this));
        if (path === '/api/admin/order') {
          const order = await this.paid.findOrder(payload.order_id);
          return reply({ order: { ...this.paid.publicOrder(order), username: order.username } });
        }
        if (path === '/api/admin/confirm') return reply(await this.paid.confirm(payload));
        if (path === '/api/admin/model-check') {
          this.paid.checkAI();
          await this.rate(request, 'model-check', 3, 3600000);
          const result = await this.gateway.reading({ question: '虚构验收：我怎样安排每天十分钟的绘画练习？', theme: '自我',
            spread_id: 'basic', cards: [{ id: 0, reversed: false }, { id: 1, reversed: true }, { id: 17, reversed: false }] }, ip);
          return reply({ ok: true, answer: result.answer, model: this.gateway.env.FLOWBEE_MODEL });
        }
      }
      const account = await this.account(request);
      if (path === '/api/account/logout') {
        await this.storage.delete(account.sessionKey);
        const response = reply({ ok: true }, 200, SESSION_COOKIE + '=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0');
        response.headers.append('Set-Cookie', await this.paid.auth.logout(request));
        return response;
      }
      if (path === '/api/free/reading') return await this.freeReading(account, payload);
      if (path === '/api/paid/polish' || path === '/api/paid/intake-questions')
        return reply(await this.paid.prepare(account, payload, ip, path === '/api/paid/polish'));
      if (path === '/api/order') return reply(await this.paid.order(account, payload));
      if (path === '/api/order/status') {
        const order = await this.paid.findOrder(payload.order_id);
        if (order.userId !== account.user.id) throw new CommerceError('没有找到属于你的订单。', 404);
        return reply({ order: this.paid.publicOrder(order), account: allowance(await this.storage.get(account.key)) });
      }
      if (path === '/api/paid/reading') return reply(await this.paid.reading(account, payload, ip));
      if (path === '/api/paid/followup') return reply(await this.paid.followup(account, payload, ip));
      return reply({ error: '接口不存在。' }, 404);
    } catch (error) {
      return reply({ error: error.status ? error.message : '暂时无法完成操作，请稍后重试。' }, error.status || 500);
    }
  }
}

