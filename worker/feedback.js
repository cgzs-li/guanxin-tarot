const fail = (message, status = 400) => Object.assign(new Error(message), { status });
function readingId(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9-]{16,80}$/.test(value)) throw fail('解读编号无效，请完成一次解读后再反馈。');
  return value;
}
export class Feedback {
  constructor(storage) { this.storage = storage; }
  async grant(account, payload, mode) {
    const key = 'feedback-grant:' + account.user.id + ':' + readingId(payload.request_id);
    if (!await this.storage.get(key)) await this.storage.put(key, { spread_id: payload.spread_id, mode, created: Date.now() });
  }
  async submit(account, payload) {
    const id = readingId(payload.reading_id);
    if (!Number.isInteger(payload.rating) || payload.rating < 1 || payload.rating > 5) throw fail('请选择 1～5 分的体验评分。');
    if (typeof payload.message !== 'string' || payload.message.trim().length > 1000) throw fail('反馈内容最多 1000 个字符。');
    const message = payload.message.trim(), key = 'feedback-user:' + account.user.id + ':' + id;
    return this.storage.transaction(async tx => {
      const grant = await tx.get('feedback-grant:' + account.user.id + ':' + id);
      if (!grant) throw fail('没有找到你已完成的这次解读，请完成解读后再反馈。', 403);
      const old = await tx.get(key);
      if (old) {
        if (old.rating !== payload.rating || old.message !== message) throw fail('这次解读已提交反馈，请勿重复提交。', 409);
        return { ok: true, id: old.id, already_submitted: true };
      }
      const day = new Date(Date.now() + 28800000).toISOString().slice(0, 10), limitKey = 'feedback-limit:' + account.user.id;
      const usage = await tx.get(limitKey), count = usage?.day === day ? usage.count : 0;
      if (count >= 10) throw fail('今天已提交较多反馈，请明天再试。', 429);
      const total = (await tx.get('feedback-total') || 0) + 1;
      const saved = { id: total, username: account.user.name, reading_id: id, ...grant, rating: payload.rating, message, created: Date.now() };
      await tx.put('feedback-record:' + total, saved); await tx.put(key, { id: total, rating: payload.rating, message });
      await tx.put('feedback-total', total); await tx.put(limitKey, { day, count: count + 1 });
      return { ok: true, id: total, already_submitted: false };
    });
  }
  async list(payload) {
    const total = await this.storage.get('feedback-total') || 0;
    if (payload.before !== undefined && (!Number.isInteger(payload.before) || payload.before < 1 || payload.before > total + 1)) throw fail('反馈分页编号不正确，请刷新列表。');
    const before = payload.before ?? total + 1, start = Math.min(total, before - 1), ids = [];
    for (let id = start; id > Math.max(0, start - 20); id--) ids.push(id);
    const items = (await Promise.all(ids.map(id => this.storage.get('feedback-record:' + id)))).filter(Boolean);
    return { total, items, next_before: start > 20 ? start - 19 : null };
  }
}
