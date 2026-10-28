const COOKIE = '__Host-guanxin_visitor';
const day = () => new Date(Date.now() + 28800000).toISOString().slice(0, 10);
const invalid = () => Object.assign(new Error('访问记录格式不正确，请刷新后重试。'), { status: 400 });
export class Audience {
  constructor(storage) { this.storage = storage; }
  async visit(request, payload, account) {
    if (typeof payload.page_id !== 'string' || !/^[a-f0-9-]{36}$/.test(payload.page_id)) throw invalid();
    const oldToken = (request.headers.get('Cookie') || '').split(';').map(s => s.trim()).find(s => s.startsWith(COOKIE + '='))?.slice(COOKIE.length + 1);
    const token = /^[a-f0-9-]{36}$/.test(oldToken || '') ? oldToken : crypto.randomUUID();
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))), b => b.toString(16).padStart(2, '0')).join('');
    await this.storage.transaction(async tx => {
      const now = Date.now(), today = day(), key = 'visitor:' + hash;
      const visitor = await tx.get(key), recent = await tx.get('audience:recent') || [];
      const existing = recent.find(item => item.visitor === hash.slice(0, 12) && item.page_id === payload.page_id);
      const freshPage = !existing && visitor?.page_id !== payload.page_id;
      const stats = await tx.get('audience:stats') || { started: now, views: 0, visitors: 0, today: { day: today, views: 0, visitors: 0 } };
      if (stats.today.day !== today) stats.today = { day: today, views: 0, visitors: 0 };
      if (!visitor) stats.visitors++;
      if (visitor?.day !== today) stats.today.visitors++;
      if (freshPage) { stats.views++; stats.today.views++; }
      await tx.put(key, { page_id: payload.page_id, day: today });
      const item = { visitor: hash.slice(0, 12), page_id: payload.page_id, username: account?.isAdmin ? null : account?.user.name || null, owner: Boolean(account?.isAdmin), time: now };
      if (existing) Object.assign(existing, item); else recent.unshift(item);
      await tx.put('audience:stats', stats); await tx.put('audience:recent', recent.slice(0, 100));
      if (account && !account.isAdmin) {
        const user = await tx.get(account.key);
        if (user) { user.lastSeen = now; await tx.put(account.key, user); }
      }
    });
    return { cookie: oldToken === token ? undefined : COOKIE + '=' + token + '; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=31536000' };
  }
  async overview() {
    const stats = await this.storage.get('audience:stats');
    return { stats: stats ? { ...stats, today: stats.today.day === day() ? stats.today : { day: day(), views: 0, visitors: 0 } } : null,
      recent: (await this.storage.get('audience:recent') || []).map(({ page_id, ...item }) => item) };
  }
  async users(payload) {
    if (payload.after !== undefined && (typeof payload.after !== 'string' || !/^user:[\p{L}\p{N}_-]{3,24}$/u.test(payload.after))) throw invalid();
    return this.storage.transaction(async tx => {
      let total = await tx.get('audience:user-total');
      if (total === undefined) {
        total = 0; let after;
        for (;;) {
          const batch = await tx.list({ prefix: 'user:', limit: 500, ...(after ? { startAfter: after } : {}) });
          total += batch.size;
          if (batch.size < 500) break;
          after = [...batch.keys()].at(-1);
        }
        await tx.put('audience:user-total', total);
      }
      const batch = [...await tx.list({ prefix: 'user:', limit: 21, ...(payload.after ? { startAfter: payload.after } : {}) })];
      return { total, items: batch.slice(0, 20).map(([, u]) => ({ username: u.name, created: u.created, last_seen: u.lastSeen || null })),
        next_after: batch.length > 20 ? batch[19][0] : null };
    });
  }
}
