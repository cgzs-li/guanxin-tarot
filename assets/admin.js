const el = id => document.getElementById(id);
let currentOrder = null;
async function adminAPI(path, payload) {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 95000);
  try {
    const response = await fetch('/api/admin/' + path, { method: 'POST', cache: 'no-store', credentials: 'omit',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': el('admin-key').value.trim() }, body: JSON.stringify(payload), signal: controller.signal });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '操作未完成。');
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
el('lookup').addEventListener('submit', async event => {
  event.preventDefault(); const button = event.submitter; button.disabled = true;
  el('status').textContent = '正在查询…'; el('order-panel').hidden = true; currentOrder = null;
  try {
    const data = await adminAPI('order', { order_id: el('order-id').value.trim() });
    renderOrder(data.order); el('received').value = ''; el('reference').value = ''; el('verified').checked = false;
    el('status').textContent = '请先到收款工具核实到账。';
  } catch (error) { el('status').textContent = error.message; }
  finally { button.disabled = false; }
});
el('confirm').addEventListener('submit', async event => {
  event.preventDefault(); if (!currentOrder || !el('verified').checked) return;
  const amount = el('received').value.trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(amount)) { el('status').textContent = '金额请填写最多两位小数。'; return; }
  const amountCents = Math.round(Number(amount) * 100);
  if (amountCents !== currentOrder.price) { el('status').textContent = '实收金额与订单不一致，请核对。'; return; }
  el('confirm-button').disabled = true; el('status').textContent = '正在确认并发放权益…';
  try {
    const data = await adminAPI('confirm', { order_id: currentOrder.id, amount_cents: amountCents, reference: el('reference').value.trim() });
    renderOrder(data.order); el('status').textContent = data.already_confirmed ? '此订单此前已开通，没有重复发放。' : '已开通。请让用户刷新到账状态。';
  } catch (error) { el('status').textContent = error.message; }
  finally { el('confirm-button').disabled = false; }
});
el('model-check').addEventListener('click', async () => {
  el('model-check').disabled = true; el('model-status').textContent = '正在检测，请稍等…';
  try { const data = await adminAPI('model-check', {}); el('model-status').textContent = '真实模型连接成功：' + data.model + '；返回 ' + data.answer.length + ' 字。'; }
  catch (error) { el('model-status').textContent = error.message; }
  finally { el('model-check').disabled = false; }
});
