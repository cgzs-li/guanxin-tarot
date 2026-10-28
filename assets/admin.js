const el = id => document.getElementById(id);
let currentOrder = null;
let adminTrial = null, feedbackBefore = null, feedbackBusy = false;
let usersAfter = null, usersBusy = false;
const dateLabel = value => value ? new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '暂无记录';
async function loadAudience() {
  el('audience-refresh').disabled = true; el('audience-status').textContent = '正在读取访问统计…';
  try {
    const data = await adminAPI('audience', {}), stats = data.stats;
    el('audience-status').textContent = stats ? '统计开始于 ' + dateLabel(stats.started) + '。今日按北京时间统计。' : '还没有访问记录，用户打开网站后会显示在这里。';
    el('audience-totals').textContent = stats ? '今日：' + stats.today.views + ' 次访问 / ' + stats.today.visitors + ' 个访客；累计：' + stats.views + ' 次访问 / ' + stats.visitors + ' 个访客。' : '';
    el('audience-list').replaceChildren();
    for (const item of data.recent) {
      const li = document.createElement('li');
      li.textContent = (item.owner ? '负责人访问' : item.username ? '账号：' + item.username : '未登录访客：' + item.visitor) + ' · ' + dateLabel(item.time);
      el('audience-list').append(li);
    }
  } catch (error) { el('audience-status').textContent = error.message; }
  finally { el('audience-refresh').disabled = false; }
}
async function loadUsers(more = false) {
  if (usersBusy) return;
  usersBusy = true; el('users-refresh').disabled = true; el('users-more').disabled = true;
  el('users-status').textContent = '正在读取注册用户…';
  try {
    const data = await adminAPI('users', more && usersAfter ? { after: usersAfter } : {});
    if (!more) el('users-list').replaceChildren();
    for (const item of data.items) {
      const li = document.createElement('li'), name = document.createElement('strong'), detail = document.createElement('p');
      name.textContent = item.username;
      detail.textContent = '注册：' + dateLabel(item.created) + '；最近活跃：' + dateLabel(item.last_seen);
      li.append(name, detail); el('users-list').append(li);
    }
    usersAfter = data.next_after; el('users-more').hidden = !usersAfter;
    el('users-status').textContent = data.total ? '共 ' + data.total + ' 个注册账号，已显示 ' + el('users-list').childElementCount + ' 个（按账号排序）。' : '还没有注册用户。';
  } catch (error) { el('users-status').textContent = error.message; }
  finally { usersBusy = false; el('users-refresh').disabled = false; el('users-more').disabled = false; }
}
el('audience-refresh').addEventListener('click', loadAudience);
el('users-refresh').addEventListener('click', () => loadUsers());
el('users-more').addEventListener('click', () => loadUsers(true));
function trialOpen() { return Boolean(adminTrial?.active && Date.now() < adminTrial.ends_at); }
function trialMessage(data) {
  adminTrial = data;
  el('trial-admin-status').textContent = trialOpen() ? '免费试用开放中，暂停收款开通；北京时间 ' + new Date(data.ends_at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) + ' 自动恢复付费。原有权益保留。' : '当前按原付费规则开放。';
}
async function loadFeedback(more = false) {
  if (feedbackBusy) return;
  feedbackBusy = true; el('feedback-refresh').disabled = true; el('feedback-more').disabled = true;
  el('feedback-list-status').textContent = '正在读取反馈…';
  try {
    const data = await adminAPI('feedback', more && feedbackBefore ? { before: feedbackBefore } : {});
    if (!more) el('admin-feedback-list').replaceChildren();
    for (const item of data.items) {
      const li = document.createElement('li'), title = document.createElement('h3'), meta = document.createElement('p'), message = document.createElement('p');
      title.textContent = item.rating + ' / 5 分 · ' + item.username;
      meta.className = 'feedback-meta'; meta.textContent = new Date(item.created).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) + ' · 牌阵 ' + item.spread_id + ' · ' + ({ 'trial-ai': '免费 AI 试用', 'owner-ai': '负责人测试', 'paid-ai': '付费 AI', local: '本地解读' }[item.mode] || item.mode) + ' · 反馈编号 ' + item.id;
      message.className = 'feedback-message'; message.textContent = item.message || '用户仅提交了评分。'; li.append(title, meta, message); el('admin-feedback-list').append(li);
    }
    feedbackBefore = data.next_before; el('feedback-more').hidden = !feedbackBefore;
    el('feedback-list-status').textContent = data.total ? '共收到 ' + data.total + ' 条反馈，已显示 ' + el('admin-feedback-list').childElementCount + ' 条。' : '还没有用户反馈。用户完成解读并提交后会显示在这里。';
  } catch (error) { el('feedback-list-status').textContent = error.message; }
  finally { feedbackBusy = false; el('feedback-refresh').disabled = false; el('feedback-more').disabled = false; }
}
el('feedback-refresh').addEventListener('click', () => loadFeedback());
el('feedback-more').addEventListener('click', () => loadFeedback(true));
async function adminAPI(path, payload) {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 95000);
  try {
    const response = await fetch('/api/admin/' + path, { method: 'POST', cache: 'no-store', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: controller.signal });
    let data; try { data = await response.json(); }
    catch { throw new Error('没有收到有效回复，请重新查询订单状态后再试，不要重复收款。'); }
    if (!response.ok) { if (response.status === 403 || response.status === 401) setLoggedIn(null); throw new Error(data.error || '操作未完成。'); }
    return data;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('等待超时。请重新查询订单状态，不要重复收款。');
    throw error;
  } finally { clearTimeout(timer); }
}
function renderOrder(order) {
  currentOrder = order; el('order-panel').hidden = false;
  el('username').textContent = order.username || el('username').textContent;
  el('product').textContent = order.title;
  el('amount').textContent = '¥' + (order.price / 100).toFixed(2);
  el('order-status').textContent = order.status === 'paid' ? '已收款开通' : '等待人工核实收款';
  el('confirm').hidden = order.status === 'paid' || trialOpen();
}
function confirmationMessage(message, field) {
  el('status').textContent = message; el('confirm-status').textContent = message;
  if (field) { field.focus(); field.scrollIntoView({ block: 'center', behavior: 'instant' }); }
}
el('lookup').addEventListener('submit', async event => {
  event.preventDefault(); const button = event.submitter; button.disabled = true;
  el('status').textContent = '正在查询…'; el('order-panel').hidden = true; currentOrder = null;
  try {
    const data = await adminAPI('order', { order_id: el('order-id').value.trim() });
    renderOrder(data.order); el('received').value = ''; el('reference').value = ''; el('verified').checked = false;
    el('confirm-status').textContent = '';
    el('status').textContent = data.order.status === 'paid' ? '此订单已开通，请核对用户账号并让用户刷新权益。' : '请先到收款工具核实到账，再填金额、真实流水号并勾选确认。';
    if (trialOpen() && data.order.status !== 'paid') el('status').textContent = '试用期间暂停收款开通，原待付款订单保留，请勿要求用户付款。';
  } catch (error) { el('status').textContent = error.message; }
  finally { button.disabled = false; }
});
el('confirm').addEventListener('submit', async event => {
  event.preventDefault();
  if (!currentOrder) { confirmationMessage('请先查询需要开通的订单。', el('order-id')); return; }
  const amount = el('received').value.trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(amount)) { confirmationMessage('请填写实际到账金额，最多两位小数。', el('received')); return; }
  const amountCents = Math.round(Number(amount) * 100);
  if (amountCents !== currentOrder.price) { confirmationMessage('实收金额与订单应收 ¥' + (currentOrder.price / 100).toFixed(2) + ' 不一致，请核对。', el('received')); return; }
  const reference = el('reference').value.trim();
  if (reference.length < 6 || reference.length > 100) { confirmationMessage('请填写收款工具中的真实交易流水号，长度6～100位。', el('reference')); return; }
  if (reference === currentOrder.id) { confirmationMessage('订单号不能代替真实收款流水号，请到收款工具查看交易详情。', el('reference')); return; }
  if (!el('verified').checked) { confirmationMessage('请先核实真实到账，并勾选“账号、套餐与金额均正确”。', el('verified')); return; }
  el('confirm-button').disabled = true; confirmationMessage('正在确认并发放权益…');
  try {
    const data = await adminAPI('confirm', { order_id: currentOrder.id, amount_cents: amountCents, reference });
    renderOrder(data.order);
    const paid = data.recipient?.paid, balance = paid?.balance;
    const summary = balance ? ' 当前权益：单张 ' + balance.single + ' 次、三张 ' + balance.triple + ' 次、复杂阵 ' + balance.complex + ' 次' + (paid.member_until > Date.now() ? '；月卡有效至 ' + new Date(paid.member_until).toLocaleDateString('zh-CN') : '') + '。' : '';
    el('status').textContent = (data.already_confirmed ? '此订单此前已开通，没有重复发放。' : '已为账号“' + (data.recipient?.username || el('username').textContent) + '”开通 ' + data.order.title + '。') + summary + ' 请让用户在“我的权益 / 订单”刷新查看。';
    el('status').scrollIntoView({ block: 'center', behavior: 'instant' });
  } catch (error) { confirmationMessage(error.message); }
  finally { el('confirm-button').disabled = false; }
});
el('model-check').addEventListener('click', async () => {
  el('model-check').disabled = true; el('model-status').textContent = '正在检测，请稍等…';
  try { const data = await adminAPI('model-check', {}); el('model-status').textContent = '真实模型连接成功：' + data.model + '；返回 ' + data.answer.length + ' 字。'; }
  catch (error) { el('model-status').textContent = error.message; }
  finally { el('model-check').disabled = false; }
});

function setLoggedIn(username) {
  el('admin-login').hidden = Boolean(username); el('admin-workspace').hidden = !username;
  el('admin-name').textContent = username || '';
  if (username) { loadFeedback(); loadAudience(); loadUsers(); adminAPI('session', {}).then(data => trialMessage(data.trial)).catch(() => {}); }
  else {
    el('admin-feedback-list').replaceChildren(); el('feedback-list-status').textContent = ''; feedbackBefore = null;
    el('audience-list').replaceChildren(); el('users-list').replaceChildren(); el('audience-totals').textContent = ''; el('audience-status').textContent = ''; el('users-status').textContent = ''; usersAfter = null;
  }
  if (!username) { currentOrder = null; el('order-panel').hidden = true; el('order-id').value = ''; el('username').textContent = ''; el('reference').value = ''; el('status').textContent = ''; }
}
el('admin-login').addEventListener('submit', async event => {
  event.preventDefault(); event.submitter.disabled = true; el('login-status').textContent = '正在登录…';
  try { const data = await adminAPI('login', { username: el('admin-username').value.trim(), password: el('admin-password').value });
    el('admin-password').value = ''; setLoggedIn(data.username); el('login-status').textContent = '';
  } catch (error) { el('login-status').textContent = error.message; }
  finally { event.submitter.disabled = false; }
});
el('admin-logout').addEventListener('click', async () => {
  try { await adminAPI('logout', {}); setLoggedIn(null); el('admin-password').value = ''; }
  catch (error) { el('status').textContent = error.message; }
});
adminAPI('session', {}).then(data => setLoggedIn(data.authenticated ? data.username : null))
  .catch(() => { el('login-status').textContent = '暂时无法检查登录状态，请重试。'; });
