// Public commerce demo: authenticated local trial and separately labelled demo rights.
const commerce = { account: null, products: [], mode: 'free', requestId: '', demoData: null,
  busy: false, flow: 0, order: null, cartId: '', cartProduct: '', afterAuth: null };
const money = cents => (cents / 100).toFixed(1).replace(/\.0$/, '');
const tierName = { single: '单张', triple: '三张', complex: '复杂牌阵', monthly: '月卡' };
function commercePayload() {
  return { question: userQuestion, theme, spread_id: selectedSpread.id, request_id: commerce.requestId,
    cards: draw.map((id, i) => ({ id, reversed: orientations[i] })),
    background: intakeQuestions.map((question, i) => ({ question, answer: intakeAnswers[i] || '' })),
    option_a: selectedSpread.category === '选择' ? optionA : '', option_b: selectedSpread.category === '选择' ? optionB : '' };
}
async function commerceAPI(path, data) {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(path, { ...(data === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }),
      credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
    let body; try { body = await response.json(); } catch { throw new Error('没有收到有效回复，请稍后重试。'); }
    if (!response.ok) { const error = new Error(body.error || '操作未完成，请重试。'); error.status = response.status; throw error; }
    return body;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('等待超时，当前内容已保留。可以重试，同一操作不会重复扣次。');
    throw error;
  } finally { clearTimeout(timer); }
}
function switchReadingMode(mode) {
  commerce.mode = mode;
  document.querySelectorAll('[name="reading-mode"]').forEach(r => { r.checked = r.value === mode; });
  $('reading-mode-help').textContent = mode === 'free'
    ? '每个账号有 1 次完整本地解读。不会调用 AI，点击阅读并成功生成后才使用机会。'
    : '先模拟选择套餐，再体验示例解读与追问。全程不扣款，不调用真实 AI。';
  $('start').textContent = mode === 'free' ? '开始我的免费体验 ↗' : '开始付费功能演示 ↗';
  updateChargeNote();
}
function updateChargeNote() {
  $('reading-charge-note').textContent = commerce.mode === 'free'
    ? '本次为免费本地解读 · 成功生成后使用 1 次免费机会，不含 AI。'
    : '本次为付费功能演示 · 成功展示示例后使用对应牌阵 1 次演示权益，未实际收款。';
}
function showAuth(tab = 'login', after) {
  if (after) commerce.afterAuth = after;
  $('auth-status').textContent = '';
  setAuthTab(tab);
  openDialog($('account-dialog'));
  setTimeout(() => $('account-username').focus(), 0);
}
function setAuthTab(tab) {
  const registration = tab === 'register';
  $('auth-form').dataset.tab = tab;
  $('auth-login-tab').setAttribute('aria-pressed', String(!registration));
  $('auth-register-tab').setAttribute('aria-pressed', String(registration));
  $('confirm-password-field').hidden = !registration;
  $('account-confirm-password').required = registration;
  $('account-password').autocomplete = registration ? 'new-password' : 'current-password';
  $('auth-submit').textContent = registration ? '注册，领取免费机会' : '登录';
  $('auth-status').textContent = '';
}
function setAccount(data) {
  commerce.account = data?.user ? data : null;
  $('account-open').textContent = data?.user ? '我的权益' : '登录 / 注册';
  $('auth-view').hidden = Boolean(data?.user);
  $('member-view').hidden = !data?.user;
  const free = data?.user ? data.free_remaining : 1;
  $('free-summary').textContent = data?.user
    ? (free ? '你的免费本地解读还未使用' : '你的免费本地解读已使用')
    : '注册即可领取 1 次免费本地解读';
  if (!data?.user) return;
  $('member-name').textContent = data.user.name;
  $('member-free').textContent = free ? '1 次 · 不含 AI' : '已使用';
  const demo = data.demo, activeMember = demo.member_until > Date.now();
  $('member-balances').textContent = '单张 ' + demo.balance.single + ' 次 · 三张 ' + demo.balance.triple + ' 次 · 复杂牌阵 ' + demo.balance.complex + ' 次';
  $('member-monthly').textContent = activeMember
    ? '演示月卡有效至 ' + new Date(demo.member_until).toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' }) +
      '；今日剩余：单张 ' + demo.remaining_today.single + '、三张 ' + demo.remaining_today.triple + '、复杂阵 ' + demo.remaining_today.complex
    : '暂未开通演示月卡';
  const list = $('member-orders'); list.replaceChildren();
  for (const order of data.orders || []) {
    const li = document.createElement('li');
    li.textContent = order.title + ' · ¥' + money(order.price) + ' · ' + (order.status === 'demo_completed' ? '已模拟完成，未扣款' : '待模拟确认') +
      ' · ' + new Date(order.created).toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' });
    list.append(li);
  }
  if (!list.childElementCount) { const li = document.createElement('li'); li.textContent = '还没有演示订单。'; list.append(li); }
}
async function refreshAccount() {
  const data = await commerceAPI('/api/account/me');
  setAccount(data);
  return data;
}
function chosenProduct() { return commerce.products.find(p => p.id === document.querySelector('[name="product"]:checked')?.value); }
function renderProducts() {
  const container = $('product-options'); container.replaceChildren();
  for (const tier of ['single', 'triple', 'complex', 'monthly']) {
    const section = document.createElement('section'); section.className = 'plan-group';
    const heading = document.createElement('h3'); heading.textContent = tier === 'monthly' ? '观心月卡' : tierName[tier] + '解读';
    const description = document.createElement('p');
    description.textContent = tier === 'monthly' ? '30 天有效，到期不自动续费。' : tier === 'complex' ? '适用 4～10 张牌，包含 1 轮追问。' : '适用' + tierName[tier] + '牌阵，包含 1 轮追问。';
    section.append(heading, description);
    for (const product of commerce.products.filter(p => p.tier === tier)) {
      const label = document.createElement('label'); label.className = 'product-option';
      const radio = document.createElement('input'); radio.type = 'radio'; radio.name = 'product'; radio.value = product.id;
      const title = document.createElement('span'); title.textContent = tier === 'monthly' ? '月卡' : product.count + ' 次';
      const price = document.createElement('strong'); price.textContent = '¥' + money(product.price);
      label.append(radio, title, price); section.append(label);
    }
    if (tier === 'monthly') {
      const note = document.createElement('p'); note.textContent = '每天单张 3 次、三张 3 次、复杂阵 1 次；每次 3 轮追问。次数不跨日累积，按北京时间刷新。';
      section.append(note);
    }
    container.append(section);
  }
}
function openPlans() {
  $('checkout-panel').hidden = true; $('plans-selection').hidden = false; $('plans-status').textContent = '';
  const tier = selectedSpread.slots.length === 1 ? 'single' : selectedSpread.slots.length === 3 ? 'triple' : 'complex';
  const radio = document.querySelector('[name="product"][value="' + tier + '-1"]');
  if (radio) radio.checked = true;
  if ($('account-dialog').open) closeDialog($('account-dialog'));
  openDialog($('plans-dialog'));
}
async function readCommercial() {
  if (commerce.busy || opened !== draw.length || !draw.length) return;
  if (!commerce.account) { showAuth('login'); return; }
  const version = commerce.flow;
  commerce.busy = true; $('read').disabled = true; $('reset').disabled = true;
  $('read').textContent = '正在整理本次解读…'; $('session-error').textContent = '';
  try {
    const data = await commerceAPI(commerce.mode === 'free' ? '/api/free/reading' : '/api/demo/reading', commercePayload());
    if (version !== commerce.flow) return;
    if (data.account) setAccount(data.account);
    commerce.demoData = data.simulated ? data : null;
    showLocalReading();
    $('reading-result-label').textContent = data.simulated ? '付费功能演示 · 示例由本地牌义组织，不是 AI 回答' : '免费本地解读 · 未使用 AI';
    await prepareAI();
  } catch (error) {
    if (version !== commerce.flow) return;
    $('session-error').textContent = error.message;
    $('read').textContent = '重试阅读解读';
    if (error.status === 401) { setAccount(null); showAuth('login'); }
    if (error.status === 402) openPlans();
  } finally {
    commerce.busy = false; $('read').disabled = false; $('reset').disabled = false;
  }
}
function commercePrepareAI() {
  resetAI(); $('ai-panel').hidden = false;
  $('ai-consent').textContent = '当前为付费流程演示，不实际扣款，也不会把你的问题发给大模型。正式 AI 服务尚未开放。';
  $('ai-title').textContent = commerce.demoData ? '这是一次付费功能演示。' : '想进一步梳理这个问题？';
  $('ai-generate').disabled = Boolean(commerce.demoData);
  $('ai-generate').textContent = commerce.demoData ? '示例解读已展示' : '查看 AI 套餐（演示）';
  $('ai-panel').querySelector('.ai-intro').textContent = commerce.demoData
    ? '以下内容用于体验解读、权益与追问流程，示例以本地牌义组织。'
    : 'AI 解读与追问为付费功能。你可以先了解套餐，免费解读仍可在下方阅读。';
  if (commerce.demoData) {
    aiSession = commerce.demoData.session_id;
    aiMessage('assistant', commerce.demoData.answer);
    $('ai-followup-form').hidden = commerce.demoData.followup_remaining <= 0;
    $('ai-followup-help').textContent = '演示追问 · 还可问 ' + commerce.demoData.followup_remaining + ' 轮；沿用同一组牌。不会调用真实 AI。';
  }
  aiStatus(commerce.demoData ? '演示完成，未实际扣款，未调用大模型。' : '免费本地解读已完成。AI 服务将在接入真实支付后开放。');
}
async function commerceFollowup(payload) {
  const version = aiVersion, controller = new AbortController();
  aiController = controller; $('ai-send').disabled = true; $('ai-followup').readOnly = true;
  $('ai-panel').setAttribute('aria-busy', 'true'); aiStatus('正在展示追问示例…');
  if (!commerce.followupId || commerce.followupMessage !== payload.message) {
    commerce.followupId = crypto.randomUUID(); commerce.followupMessage = payload.message;
  }
  try {
    const data = await commerceAPI('/api/demo/followup', { ...payload, request_id: commerce.followupId });
    if (version !== aiVersion) return;
    aiMessage('user', payload.message); aiMessage('assistant', data.answer);
    $('ai-followup').value = ''; commerce.followupId = '';
    $('ai-followup-help').textContent = '演示追问剩余 ' + data.followup_remaining + ' 轮。示例不是大模型回答。';
    $('ai-followup-form').hidden = data.followup_remaining <= 0;
    aiStatus(data.followup_remaining > 0 ? '追问示例已展示，未调用大模型。' : '本次演示追问已用完，完整示例仍可阅读。');
  } catch (error) {
    if (version !== aiVersion) return;
    aiStatus(error.message, true);
    if (error.status === 401) { setAccount(null); showAuth('login'); }
  } finally {
    if (version === aiVersion) { aiController = null; $('ai-send').disabled = false; $('ai-followup').readOnly = false; $('ai-panel').removeAttribute('aria-busy'); }
  }
}
document.querySelectorAll('[name="reading-mode"]').forEach(input => input.addEventListener('change', () => switchReadingMode(input.value)));
$('start').addEventListener('click', event => {
  if (!$('user-question').value.trim()) return;
  if (!commerce.account || (commerce.mode === 'free' && !commerce.account.free_remaining)) {
    event.stopImmediatePropagation(); event.preventDefault();
    if (!commerce.account) showAuth('register');
    else { $('input-error').textContent = '免费本地解读已使用。可以选择付费功能演示，或继续浏览牌义。'; openPlans(); }
  }
}, true);
$('begin-draw').addEventListener('click', () => {
  if ($('session').hidden) return;
  commerce.requestId = crypto.randomUUID(); commerce.demoData = null; commerce.flow++; commerce.followupId = '';
  $('session-error').textContent = ''; $('reading-result-label').textContent = ''; updateChargeNote();
});
$('reset').addEventListener('click', () => { commerce.flow++; commerce.demoData = null; });
$('plans-open').addEventListener('click', openPlans);
$('plans-inline').addEventListener('click', openPlans);
$('member-plans').addEventListener('click', openPlans);
$('account-open').addEventListener('click', async () => {
  try { await refreshAccount(); } catch { $('auth-status').textContent = '账号状态暂未刷新，请重试。'; }
  if (commerce.account) openDialog($('account-dialog')); else showAuth('login');
});
$('auth-login-tab').addEventListener('click', () => setAuthTab('login'));
$('auth-register-tab').addEventListener('click', () => setAuthTab('register'));
$('auth-form').addEventListener('submit', async event => {
  event.preventDefault(); const button = $('auth-submit'); button.disabled = true;
  $('auth-status').textContent = '正在验证，请稍等…';
  try {
    const registration = $('auth-form').dataset.tab === 'register';
    const data = await commerceAPI(registration ? '/api/account/register' : '/api/account/login', {
      username: $('account-username').value, password: $('account-password').value, confirm_password: $('account-confirm-password').value });
    setAccount(data); $('account-password').value = ''; $('account-confirm-password').value = '';
    closeDialog($('account-dialog')); $('input-error').textContent = '';
    const next = commerce.afterAuth; commerce.afterAuth = null;
    if (next) next();
  } catch (error) { $('auth-status').textContent = error.message; }
  finally { button.disabled = false; }
});
$('account-logout').addEventListener('click', async () => {
  $('account-logout').disabled = true;
  try {
    await commerceAPI('/api/account/logout', {}); setAccount(null); resetAI(); commerce.flow++; commerce.demoData = null;
    $('home').hidden = false; $('intake').hidden = true; $('session').hidden = true; $('results').replaceChildren();
    $('user-question').value = ''; $('user-question').dispatchEvent(new Event('input')); intakeAnswers = []; intakeDraftKey = '';
    setJourney(0); closeDialog($('account-dialog'));
  } catch (error) { $('member-status').textContent = error.message; }
  finally { $('account-logout').disabled = false; }
});
$('product-options').addEventListener('change', () => { commerce.cartId = ''; commerce.cartProduct = ''; $('plans-status').textContent = ''; });
$('create-order').addEventListener('click', async () => {
  const product = chosenProduct();
  if (!product) { $('plans-status').textContent = '请先选择一个套餐。'; return; }
  if (!commerce.account) {
    closeDialog($('plans-dialog')); showAuth('register', openPlans); return;
  }
  $('create-order').disabled = true; $('plans-status').textContent = '正在生成演示订单…';
  try {
    if (!commerce.cartId || commerce.cartProduct !== product.id) { commerce.cartId = crypto.randomUUID(); commerce.cartProduct = product.id; }
    const data = await commerceAPI('/api/demo/order', { product_id: product.id, request_id: commerce.cartId });
    commerce.order = data.order;
    $('checkout-name').textContent = data.order.title; $('checkout-price').textContent = '¥' + money(data.order.price);
    $('checkout-id').textContent = data.order.id;
    $('checkout-status').textContent = ''; $('confirm-demo-payment').hidden = false; $('checkout-return').hidden = true;
    $('checkout-panel').hidden = false; $('plans-selection').hidden = true; $('checkout-title').focus();
  } catch (error) {
    $('plans-status').textContent = error.message;
    if (error.status === 401) { setAccount(null); closeDialog($('plans-dialog')); showAuth('login', openPlans); }
  } finally { $('create-order').disabled = false; }
});
$('checkout-back').addEventListener('click', () => { $('checkout-panel').hidden = true; $('plans-selection').hidden = false; $('plans-status').textContent = ''; });
$('confirm-demo-payment').addEventListener('click', async () => {
  if (!commerce.order) return;
  $('confirm-demo-payment').disabled = true; $('checkout-status').textContent = '正在确认演示订单…';
  try {
    const result = await commerceAPI('/api/demo/checkout', { order_id: commerce.order.id });
    setAccount(result.account);
    $('checkout-status').textContent = '已模拟完成，未扣款。演示权益已到账，可体验示例解读与追问，不包含真实 AI。';
    $('confirm-demo-payment').hidden = true; $('checkout-return').hidden = false;
    switchReadingMode('demo');
    const product = commerce.products.find(p => p.id === commerce.order.productId);
    if (!$('session').hidden) {
      $('checkout-return').textContent = '返回当前抽牌';
    } else if (product && product.tier !== 'monthly') {
      selectedSpread = spreads.find(s => s.id === ({ single: 'single', triple: 'basic', complex: 'celtic' })[product.tier]);
      spreadDraftKey = theme + '|' + $('user-question').value.trim();
    }
    commerce.cartId = '';
  } catch (error) { $('checkout-status').textContent = error.message; }
  finally { $('confirm-demo-payment').disabled = false; }
});
$('checkout-return').addEventListener('click', () => closeDialog($('plans-dialog')));
$('share-site').addEventListener('click', async () => {
  const url = 'https://tarot.ruichi0201.cn/?from=share';
  try {
    if (navigator.share) await navigator.share({ title: '观心 · 留一点时间，听见自己', text: '一次免费的卡牌自我探索，不含 AI，了解当下与下一步。', url });
    else { await navigator.clipboard.writeText(url); $('share-status').textContent = '网站链接已复制，不包含你的问题或抽牌结果。'; }
  } catch (error) {
    if (error.name !== 'AbortError') $('share-status').textContent = '可直接分享网址：' + url;
  }
});
switchReadingMode('free');
Promise.allSettled([
  refreshAccount(),
  commerceAPI('/api/catalog').then(data => { commerce.products = data.products; renderProducts(); $('create-order').disabled = false; })
]).then(results => {
  if (results[0].status === 'rejected') $('free-summary').textContent = '账号服务暂时不可用，请刷新后重试。';
  if (results[1].status === 'rejected') {
    $('plans-status').textContent = '套餐暂时加载失败，请刷新后重试。';
    $('create-order').disabled = true;
  }
});

