import { AdminAuth } from './admin-auth.js';
const DAY = 86400000;
const day = () => new Date(Date.now() + 28800000).toISOString().slice(0, 10);
export const paidPaths = new Set(['/api/order', '/api/order/status', '/api/paid/reading', '/api/paid/followup',
  '/api/admin/order', '/api/admin/confirm', '/api/admin/model-check', '/api/admin/setup', '/api/admin/login', '/api/admin/session', '/api/admin/logout']);
class PaidError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
const hash = async value => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), b => b.toString(16).padStart(2, '0')).join('');
const operation = value => {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9-]{16,80}$/.test(value)) throw new PaidError('操作编号无效，请刷新后重试。');
  return value;
};
const tierFor = count => count === 1 ? 'single' : count === 3 ? 'triple' : 'complex';
function defaults(user) {
  user.paidBalance ??= { single: 0, triple: 0, complex: 0 };
  user.paidMemberUntil ??= 0;
  if (user.paidDay !== day()) { user.paidDay = day(); user.paidUsed = { single: 0, triple: 0, complex: 0 }; }
  return user;
}
export function paidSummary(user) {
  defaults(user);
  return { balance: user.paidBalance, member_until: user.paidMemberUntil || null,
    remaining_today: user.paidMemberUntil > Date.now() ? {
      single: Math.max(0, 3 - user.paidUsed.single), triple: Math.max(0, 3 - user.paidUsed.triple), complex: Math.max(0, 1 - user.paidUsed.complex)
    } : null };
}
function refund(user, reservation) {
  if (reservation.source === 'pack') user.paidBalance[reservation.tier]++;
  if (reservation.source === 'monthly' && user.paidDay === reservation.day)
    user.paidUsed[reservation.tier] = Math.max(0, user.paidUsed[reservation.tier] - 1);
}
export class PaidService {
  constructor(state, gateway, products) { this.storage = state.storage; this.gateway = gateway; this.products = products; this.auth = new AdminAuth(state.storage); }
  checkAI() {
    const env = this.gateway.env;
    if (env.GUANXIN_AI_ENABLED === 'false' || !env.FLOWBEE_API_KEY || !env.FLOWBEE_MODEL)
      throw new PaidError('AI 暂时不可用，本次不会扣次数，请稍后再试。', 503);
  }
  async admin(request, rate, keyOnly = false) {
    await rate(request, 'admin', 30, 900000);
    if (!keyOnly && await this.auth.session(request)) return;
    const secret = request.headers.get('X-Admin-Key') || '';
    if (secret.length < 32 || secret.length > 256 || !this.gateway.env.GUANXIN_ADMIN_KEY_HASH)
      throw new PaidError('管理凭证不正确。', 403);
    const received = await hash(secret), expected = this.gateway.env.GUANXIN_ADMIN_KEY_HASH;
    let diff = received.length ^ expected.length;
    for (let i = 0; i < received.length; i++) diff |= received.charCodeAt(i) ^ (expected.charCodeAt(i) || 0);
    if (diff) throw new PaidError('管理凭证不正确。', 403);
  }
  async findOrder(orderId) {
    const order = await this.storage.get('paid-order:' + operation(orderId));
    if (!order) throw new PaidError('没有找到这笔正式订单。', 404);
    return order;
  }
  async order(account, payload) {
    const product = this.products.find(p => p.id === payload.product_id);
    if (!product) throw new PaidError('套餐不存在。');
    const id = operation(payload.request_id);
    const order = await this.storage.transaction(async tx => {
      const key = 'paid-order-request:' + account.user.id + ':' + id;
      const previous = await tx.get(key);
      if (previous) {
        const saved = await tx.get('paid-order:' + previous);
        if (saved.product_id !== product.id) throw new PaidError('操作编号已用于其他套餐。', 409);
        return saved;
      }
      const user = await tx.get(account.key);
      if (user.paidOrderDay !== day()) { user.paidOrderDay = day(); user.paidOrderCount = 0; }
      if (user.paidOrderCount >= 20) throw new PaidError('今天创建的订单较多，请明天再试。', 429);
      const created = { id: crypto.randomUUID(), userId: user.id, userKey: account.key, username: user.name,
        product_id: product.id, title: product.title, price: product.price, status: 'pending', created: Date.now() };
      user.paidOrders = (user.paidOrders || []).slice(-19).concat(created.id); user.paidOrderCount++;
      await tx.put('paid-order:' + created.id, created); await tx.put(key, created.id); await tx.put(account.key, user);
      return created;
    });
    return { order: this.publicOrder(order), payment_mode: 'manual' };
  }
  publicOrder(order) {
    return { id: order.id, title: order.title, product_id: order.product_id, price: order.price, status: order.status,
      created: order.created, confirmed: order.confirmed || null };
  }
  async confirm(payload) {
    const orderId = operation(payload.order_id);
    if (typeof payload.reference !== 'string' || payload.reference.trim().length < 6 || payload.reference.length > 100)
      throw new PaidError('请填入至少 6 位的真实收款流水编号，不能用订单号代替。');
    const receiptHash = await hash(payload.reference.trim());
    return this.storage.transaction(async tx => {
      const order = await tx.get('paid-order:' + orderId);
      if (!order) throw new PaidError('没有找到这笔正式订单。', 404);
      if (!Number.isInteger(payload.amount_cents) || payload.amount_cents !== order.price)
        throw new PaidError('核对金额必须与订单应收金额完全一致。');
      if (order.status === 'paid') {
        if (order.receiptHash !== receiptHash) throw new PaidError('该订单已用其他流水确认，请核对。', 409);
        return { order: this.publicOrder(order), already_confirmed: true };
      }
      const used = await tx.get('paid-receipt:' + receiptHash);
      if (used && used !== order.id) throw new PaidError('这笔收款流水已用于其他订单。', 409);
      const user = defaults(await tx.get(order.userKey));
      const product = this.products.find(p => p.id === order.product_id);
      if (product.tier === 'monthly') user.paidMemberUntil = Math.max(Date.now(), user.paidMemberUntil) + 30 * DAY;
      else user.paidBalance[product.tier] += product.count;
      order.status = 'paid'; order.confirmed = Date.now(); order.receiptHash = receiptHash;
      await tx.put('paid-order:' + order.id, order); await tx.put('paid-receipt:' + receiptHash, order.id); await tx.put(order.userKey, user);
      return { order: this.publicOrder(order), already_confirmed: false };
    });
  }
  async reading(account, payload, ip) {
    this.checkAI();
    const context = this.gateway.commerce.validate(payload), id = operation(payload.request_id);
    const fingerprint = await hash(JSON.stringify(context)), tier = tierFor(payload.cards.length);
    const key = 'paid-reading-request:' + account.user.id + ':' + id;
    const lock = crypto.randomUUID();
    const reservation = await this.storage.transaction(async tx => {
      const user = defaults(await tx.get(account.key));
      const old = await tx.get(key);
      if (old && old.fingerprint !== fingerprint) throw new PaidError('该操作编号已用于其他抽牌，请重新开始。', 409);
      if (old?.status === 'done') {
        if (old.expires <= Date.now()) throw new PaidError('这次 AI 解读已过期，请重新开始。', 410);
        return old;
      }
      if (user.paidPending) {
        const pending = await tx.get(user.paidPending);
        if (pending?.status === 'pending' && pending.lease > Date.now()) throw new PaidError('上一份 AI 解读仍在生成，请稍后重试。', 409);
        if (pending?.status === 'pending') { refund(user, pending); pending.status = 'failed'; await tx.put(user.paidPending, pending); }
        user.paidPending = null;
      }
      const cap = tier === 'complex' ? 1 : 3;
      let source;
      if (account.isAdmin) source = 'owner';
      else if (user.paidMemberUntil > Date.now() && user.paidUsed[tier] < cap) { source = 'monthly'; user.paidUsed[tier]++; }
      else if (user.paidBalance[tier] > 0) { source = 'pack'; user.paidBalance[tier]--; }
      else throw new PaidError('当前牌阵的付费次数不足，请先充值对应套餐。', 402);
      const saved = { status: 'pending', fingerprint, tier, source, day: day(), lock, lease: Date.now() + 120000,
        limit: source === 'owner' ? Number.MAX_SAFE_INTEGER : source === 'monthly' ? 3 : 1, sessionId: crypto.randomUUID() };
      user.paidPending = key; await tx.put(key, saved); await tx.put(account.key, user); return saved;
    });
    if (reservation.status === 'done') return { ...(await this.gateway.open(reservation.result)).response, account: await this.accountData(account) };
    try {
      const result = await this.gateway.reading(payload, ip, account.isAdmin === true);
      const response = { answer: result.answer, session_id: reservation.sessionId, followup_remaining: reservation.limit, admin_test: account.isAdmin === true };
      const expires = Date.now() + 3600000;
      const encrypted = await this.gateway.seal({ version: 1, history: [], response, expires });
      await this.storage.transaction(async tx => {
        const current = await tx.get(key);
        if (current?.lock !== lock || current.status !== 'pending') throw new PaidError('生成状态已变化，请刷新查看权益。', 409);
        await tx.put('paid-conversation:' + reservation.sessionId, { userId: account.user.id, adminTest: account.isAdmin === true, token: result.session_id,
          used: 0, limit: reservation.limit, expires });
        await tx.put(key, { ...current, status: 'done', result: encrypted, expires });
        const user = await tx.get(account.key); if (user.paidPending === key) user.paidPending = null; await tx.put(account.key, user);
      });
      return { ...response, account: await this.accountData(account) };
    } catch (error) {
      await this.storage.transaction(async tx => {
        const current = await tx.get(key);
        if (current?.lock === lock && current.status === 'pending') {
          const user = defaults(await tx.get(account.key)); refund(user, current); user.paidPending = null;
          await tx.put(account.key, user); await tx.put(key, { ...current, status: 'failed' });
        }
      });
      throw error;
    }
  }
  async accountData(account) {
    await this.recover(account);
    const user = await this.storage.get(account.key);
    return this.gateway.commerce.accountData(user);
  }
  async recover(account) {
    await this.storage.transaction(async tx => {
      const user = defaults(await tx.get(account.key));
      if (!user.paidPending) return;
      const pending = await tx.get(user.paidPending);
      if (pending?.status === 'pending' && pending.lease > Date.now()) return;
      if (pending?.status === 'pending') {
        refund(user, pending); pending.status = 'failed'; await tx.put(user.paidPending, pending);
      }
      user.paidPending = null; await tx.put(account.key, user);
    });
  }
  async followup(account, payload, ip) {
    this.checkAI();
    const sessionId = operation(payload.session_id), id = operation(payload.request_id);
    if (typeof payload.message !== 'string' || !payload.message.trim() || payload.message.length > 600)
      throw new PaidError('追问请填写 1～600 个字符。');
    const fingerprint = await hash(payload.message.trim()), lock = crypto.randomUUID();
    const key = 'paid-followup:' + sessionId + ':' + id, sessionKey = 'paid-conversation:' + sessionId;
    const state = await this.storage.transaction(async tx => {
      const session = await tx.get(sessionKey);
      if (!session || session.userId !== account.user.id || session.expires <= Date.now()) throw new PaidError('这次 AI 对话已过期，请重新开始。', 410);
      const old = await tx.get(key);
      if (old && old.fingerprint !== fingerprint) throw new PaidError('该操作编号已用于其他追问。', 409);
      if (old?.result) return { cached: old.result };
      if (session.adminTest && !account.isAdmin) throw new PaidError('请重新登录负责人账号。', 403);
      if (session.pending?.lease > Date.now()) throw new PaidError('上一条追问仍在回答，请稍后重试。', 409);
      if (session.used >= session.limit) throw new PaidError('本次追问次数已用完，请充值后开始新的解读。', 402);
      session.pending = { lock, lease: Date.now() + 120000 }; await tx.put(sessionKey, session);
      await tx.put(key, { fingerprint }); return session;
    });
    if (state.cached) return (await this.gateway.open(state.cached)).response;
    try {
      const result = await this.gateway.followup({ session_id: state.token, message: payload.message.trim() }, ip, account.isAdmin === true);
      const response = { answer: result.answer, session_id: sessionId, followup_remaining: state.limit - state.used - 1, admin_test: account.isAdmin === true };
      const expires = Date.now() + 3600000, encrypted = await this.gateway.seal({ version: 1, history: [], response, expires });
      await this.storage.transaction(async tx => {
        const current = await tx.get(sessionKey);
        if (current?.pending?.lock !== lock) throw new PaidError('追问状态已变化，请重试。', 409);
        current.token = result.session_id; current.used++; current.pending = null; current.expires = expires;
        await tx.put(sessionKey, current); await tx.put(key, { fingerprint, result: encrypted });
      });
      return response;
    } catch (error) {
      await this.storage.transaction(async tx => {
        const current = await tx.get(sessionKey);
        if (current?.pending?.lock === lock) { current.pending = null; await tx.put(sessionKey, current); }
      });
      throw error;
    }
  }
}
