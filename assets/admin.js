const el = id => document.getElementById(id);
let currentOrder = null;
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
  el('confirm').hidden = order.status === 'paid';
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
