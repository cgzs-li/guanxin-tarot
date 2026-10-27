const COOKIE = '__Host-guanxin_admin';
const encode = value => new TextEncoder().encode(value);
const hex = bytes => Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
const random = () => hex(crypto.getRandomValues(new Uint8Array(32)));
const digest = async value => hex(await crypto.subtle.digest('SHA-256', encode(value)));
function error(message, status = 403) { return Object.assign(new Error(message), { status }); }
function equal(a, b) {
  let diff = a.length ^ b.length;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}
async function passwordHash(password, salt) {
  const key = await crypto.subtle.importKey('raw', encode(password), 'PBKDF2', false, ['deriveBits']);
  return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: encode(salt), iterations: 100000, hash: 'SHA-256' }, key, 256));
}
export class AdminAuth {
  constructor(storage) { this.storage = storage; }
  async setup(payload) {
    if (typeof payload.username !== 'string' || !/^[A-Za-z0-9_-]{3,24}$/.test(payload.username) ||
      typeof payload.password !== 'string' || payload.password.length < 8 || payload.password.length > 72)
      throw error('后台账号或密码格式不正确。', 400);
    const salt = random(), hash = await passwordHash(payload.password, salt);
    await this.storage.transaction(async tx => {
      if (await tx.get('admin:account')) throw error('后台账号已设置，不能重复初始化。', 409);
      await tx.put('admin:account', { username: payload.username, salt, hash, sessions: [] });
    });
    return { ok: true, username: payload.username };
  }
  async login(payload, request, rate) {
    await rate(request, 'admin-login', 10, 900000);
    const account = await this.storage.get('admin:account');
    const password = typeof payload.password === 'string' && payload.password.length <= 72 ? payload.password : '';
    const hash = await passwordHash(password, account?.salt || 'unconfigured-admin');
    if (!account || payload.username !== account.username || !equal(hash, account.hash)) throw error('后台用户名或密码不正确。', 401);
    const token = random(), key = 'admin-session:' + await digest(token), expires = Date.now() + 7200000;
    await this.storage.transaction(async tx => {
      const user = await tx.get('admin:account');
      for (const old of user.sessions.slice(0, Math.max(0, user.sessions.length - 4))) await tx.delete(old);
      user.sessions = user.sessions.slice(-4).concat(key);
      await tx.put('admin:account', user); await tx.put(key, { username: user.username, expires });
    });
    return { data: { ok: true, username: account.username }, cookie: COOKIE + '=' + token + '; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=7200' };
  }
  async session(request) {
    const token = (request.headers.get('Cookie') || '').split(';').map(s => s.trim()).find(s => s.startsWith(COOKIE + '='))?.slice(COOKIE.length + 1);
    if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
    const key = 'admin-session:' + await digest(token), session = await this.storage.get(key);
    if (session?.expires > Date.now()) return { ...session, key };
    if (session) await this.storage.delete(key);
    return null;
  }
  async logout(request) {
    const session = await this.session(request);
    if (session) await this.storage.delete(session.key);
    return COOKIE + '=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0';
  }
}
