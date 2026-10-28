// Authenticated local trial and manually confirmed paid AI access.
const commerce = { account: null, products: [], mode: 'free', requestId: '', paidData: null,
  busy: false, flow: 0, order: null, cartId: '', cartProduct: '', afterAuth: null };
const money = cents => (cents / 100).toFixed(1).replace(/\.0$/, '');
const tierName = { single: '单张', triple: '三张', complex: '复杂牌阵', monthly: '月卡' };
let trialState = null, trialReceived = 0, trialTimer;
const visitPageId = crypto.randomUUID();
let visitAccount, visitQueue = Promise.resolve();
function recordVisit(data) {
  const account = data?.user?.id || '';
  if (account === visitAccount) return;
  visitAccount = account;
  visitQueue = visitQueue.catch(() => {}).then(() => commerceAPI('/api/visit', { page_id: visitPageId })).catch(() => {});
}
function trialActive() { return Boolean(trialState?.active && trialState.server_now + Date.now() - trialReceived < trialState.ends_at); }
function trialEndLabel() { return new Date(trialState.ends_at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }); }
function setTrial(state) {
  if (!state) return;
  const wasActive = trialActive(); trialState = state; trialReceived = Date.now();
  clearTimeout(trialTimer);
  if (state.active) trialTimer = setTimeout(() => { updateTrialUI(); switchReadingMode(commerce.mode); refreshAccount().catch(() => {}); }, Math.max(0, state.ends_at - state.server_now) + 50);
  updateTrialUI();
  if (!wasActive && trialActive()) switchReadingMode('paid');
}
function updateTrialUI() {
  const active = trialActive();
  $('trial-banner-copy').textContent = active ? '限时免费试用 · ' + trialEndLabel() + '（北京时间）前，登录即可免费使用 AI；当前暂停充值。' : '每账号一次免费本地解读；AI 解读和继续使用需要充值。';
  for (const id of ['plans-open', 'plans-inline', 'member-plans']) $(id).hidden = active;
  $('reading-paid-label').textContent = active ? '限时免费 AI 解读' : '付费 AI 解读';
  $('reading-free-label').textContent = active ? '本地牌义解读' : '免费本地解读';
  $('site-small-note').textContent = active ? '26 套牌阵 · 1–10 张牌 · 试用期不消耗原有次数' : '26 套牌阵 · 1–10 张牌 · 每个账号 1 次免费本地解读';
  if (active) $('free-summary').textContent = '免费试用开放中 · AI 解读每次含 3 轮追问，服务繁忙时请稍后重试';
  $('plans-trial-note').hidden = !active;
  $('create-order').disabled = active || !commerce.products.length;
  if (active) { $('plans-selection').hidden = true; $('checkout-payment').hidden = true; $('copy-payment-order').hidden = true; }
  else { $('copy-payment-order').hidden = false; if (commerce.order) $('checkout-payment').hidden = commerce.order.status === 'paid'; }
}
function commercePayload() {
  return { question: userQuestion, theme, spread_id: selectedSpread.id, request_id: commerce.requestId,
    cards: draw.map((id, i) => ({ id, reversed: orientations[i] })),
    background: intakeQuestions.map((question, i) => ({ question, answer: intakeAnswers[i] || '' })),
    option_a: selectedSpread.category === '选择' ? optionA : '', option_b: selectedSpread.category === '选择' ? optionB : '' };
}
async function commerceAPI(path, data) {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 95000);
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
    : '套餐包含 AI 润色、动态三问与解读。点击润色或进入下一步会发送问题给模型；解读成功后使用 1 次对应权益。';
  $('start').textContent = mode === 'free' ? '开始我的免费体验 ↗' : '开始 AI 解读 ↗';
  if (trialActive()) {
    $('reading-mode-help').textContent = '限时试用：AI 润色、三问、解读与 3 轮追问免费；不扣原有次卡、月卡或免费机会。' + trialEndLabel() + '（北京时间）恢复原付费规则。';
    $('start').textContent = mode === 'free' ? '开始本地解读 ↗' : '开始免费 AI 解读 ↗';
  }
  if (commerce.account?.admin_test) { $('reading-mode-help').textContent = '负责人测试：可重复抽牌、解读和追问，不充值、不扣次。模型服务本身的可用性仍适用。'; $('start').textContent = mode === 'free' ? '测试本地解读 ↗' : '测试 AI 解读 ↗'; }
  updateChargeNote(); updatePreparationUI();
}
function preparationAIEnabled() { return commerce.mode === 'paid' && hasPaidAccess(); }
function updatePreparationUI() {
  const enabled = preparationAIEnabled();
  $('polish-question').hidden = !enabled; $('polish-help').hidden = !enabled;
  $('intake-regenerate').hidden = !enabled || intakeStep === 3;
  $('polish-help').textContent = '将当前问题发送给 AI 润色，先预览再决定是否采用；不额外扣解读次数。';
  $('intake-help').textContent = enabled
    ? 'AI 会根据你的问题拟定三个背景问题，可逐项填写或跳过；生成三问不额外扣解读次数。'
    : '按问题与主题补充本地背景问题，可逐项填写或跳过；免费模式不调用 AI。';
  $('planning-privacy').textContent = enabled
    ? '进入下一步会发送当前问题以生成 AI 三问；润色需主动点击。填写的背景与牌面会在解读时发送给模型。牌阵仍可自行选择。'
    : '背景提问与牌阵建议使用本地规则。免费解读不调用模型，成功生成完整解读后使用免费机会。';
  if (!enabled) { resetPolish(); cancelPreparation('questions'); $('intake-ai-status').textContent = ''; }
}
function updateChargeNote() {
  $('reading-charge-note').textContent = commerce.mode === 'free'
    ? '本次为免费本地解读 · 成功生成后使用 1 次免费机会，不含 AI。'
    : '本次为付费 AI 解读 · 成功生成后使用对应牌阵 1 次权益，模型失败不扣次。';
  if (commerce.account?.admin_test) $('reading-charge-note').textContent = '负责人测试 · 无需充值，不扣次数';
  else if (trialActive()) $('reading-charge-note').textContent = '限时免费试用 · 本次不扣次卡、月卡或原免费机会';
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
  $('phone-field').hidden = !registration;
  $('account-phone').required = registration;
  $('account-phone').disabled = !registration;
  $('account-phone').setCustomValidity('');
  if (!registration) $('account-phone').value = '';
  $('account-password').autocomplete = registration ? 'new-password' : 'current-password';
  $('auth-submit').textContent = registration ? '注册，领取免费机会' : '登录';
  $('auth-status').textContent = '';
}
function setAccount(data) {
  setTrial(data?.trial);
  recordVisit(data);
  const wasAdmin = commerce.account?.admin_test;
  if (data?.user && !data.orders && data.user.id === commerce.account?.user.id) data = { ...data, orders: commerce.account.orders };
  commerce.account = data?.user ? data : null;
  $('account-open').textContent = data?.user ? '我的权益 / 订单' : '登录 / 注册';
  $('auth-view').hidden = Boolean(data?.user);
  $('member-view').hidden = !data?.user;
  $('admin-open').hidden = !data?.admin_test;
  switchReadingMode(data?.admin_test && !wasAdmin ? 'paid' : wasAdmin && !data?.admin_test ? 'free' : commerce.mode);
  const free = data?.user ? data.free_remaining : 1;
  $('free-summary').textContent = data?.user
    ? (free ? '你的免费本地解读还未使用' : '你的免费本地解读已使用')
    : '注册即可领取 1 次免费本地解读';
  if (!data?.user) { if (trialActive()) $('free-summary').textContent = '登录或注册即可参加两天免费 AI 试用'; return; }
  if (data.admin_test) $('free-summary').textContent = '负责人测试 · 本地和 AI 均可重复使用，无需充值';
  else if (trialActive()) $('free-summary').textContent = '限时免费试用开放中 · 原有权益保留，不扣次数';
  $('member-name').textContent = data.user.name;
  $('member-free').textContent = data.admin_test ? '负责人不限次数测试 · 不扣免费机会' : free ? '1 次 · 不含 AI' : '已使用';
  const paid = data.paid, activeMember = paid.member_until > Date.now();
  $('member-balances').textContent = '单张 ' + paid.balance.single + ' 次 · 三张 ' + paid.balance.triple + ' 次 · 复杂牌阵 ' + paid.balance.complex + ' 次';
  $('member-monthly').textContent = activeMember
    ? '月卡有效至 ' + new Date(paid.member_until).toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' }) +
      '；今日剩余：单张 ' + paid.remaining_today.single + '、三张 ' + paid.remaining_today.triple + '、复杂阵 ' + paid.remaining_today.complex
    : '暂未开通月卡';
  if (data.admin_test) { $('member-balances').textContent = '负责人测试：全部牌阵可用，不扣次数'; $('member-monthly').textContent = '无需月卡；AI 追问不受套餐轮数限制'; }
  const list = $('member-orders'); list.replaceChildren();
  for (const order of data.orders || []) {
    const li = document.createElement('li');
    const title = document.createElement('strong'); title.textContent = order.title + ' · ¥' + money(order.price);
    const detail = document.createElement('p'); detail.textContent = (order.status === 'paid' ? '已收款开通' : '待收款确认') +
      ' · ' + new Date(order.created).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
    const id = document.createElement('p'); id.className = 'order-number'; id.textContent = '订单号：' + order.id;
    const button = document.createElement('button'); button.type = 'button'; button.className = 'text-btn';
    button.textContent = order.status === 'paid' ? '查看订单' : '查看订单 / 继续付款';
    button.addEventListener('click', () => viewOrder(order, button));
    li.append(title, detail, id, button);
    list.append(li);
  }
  if (!list.childElementCount) { const li = document.createElement('li'); li.textContent = '还没有订单。'; list.append(li); }
}
function showCheckout(order) {
  commerce.order = order;
  const paid = order.status === 'paid';
  $('checkout-title').textContent = paid ? '订单已开通' : '待收款确认';
  $('checkout-name').textContent = order.title; $('checkout-price').textContent = '¥' + money(order.price);
  $('checkout-id').textContent = order.id; $('checkout-payment').hidden = paid;
  $('copy-payment-order').textContent = paid ? '复制订单信息' : '复制订单信息，发给负责人';
  $('checkout-copy-status').textContent = '';
  $('checkout-status').textContent = paid ? '此订单已确认收款并开通，无需再次付款。可在“我的权益 / 订单”查看当前剩余权益。' : '如已付款，请勿重复付款。联系负责人核实到账后开通。';
  $('refresh-payment').hidden = false; $('checkout-return').hidden = !paid;
  $('checkout-return').textContent = $('session').hidden ? '返回，开始 AI 解读' : '返回当前抽牌';
  $('checkout-panel').hidden = false; $('plans-selection').hidden = true;
  if ($('account-dialog').open) closeDialog($('account-dialog'));
  if (!$('plans-dialog').open) openDialog($('plans-dialog'));
  updateTrialUI();
  $('checkout-title').focus();
}
async function viewOrder(order, button) {
  button.disabled = true; $('member-status').textContent = '正在查询订单…';
  try {
    const result = await commerceAPI('/api/order/status', { order_id: order.id });
    setAccount(result.account); await refreshAccount();
    $('member-status').textContent = ''; showCheckout(result.order);
  } catch (error) { $('member-status').textContent = error.message; }
  finally { button.disabled = false; }
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
  if (trialActive()) { $('input-error').textContent = '目前是免费试用期，无需充值。登录后直接开始 AI 解读即可。'; return; }
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
    const data = await commerceAPI(commerce.mode === 'free' ? '/api/free/reading' : '/api/paid/reading', commercePayload());
    if (version !== commerce.flow) return;
    if (data.account) setAccount(data.account);
    commerce.paidData = data.answer ? data : null;
    showLocalReading();
    $('reading-result-label').textContent = data.admin_test ? (data.answer ? '负责人 AI 测试 · 不扣次数' : '负责人本地测试 · 不扣次数') : data.trial ? (data.answer ? '限时免费 AI 解读 · 未扣次数' : '限时免费本地解读 · 未扣次数') : data.answer ? 'AI 综合解读 · 已使用付费权益' : '免费本地解读 · 未使用 AI';
    $('reading-feedback').hidden = false; $('feedback-submit').disabled = false; $('feedback-status').textContent = ''; $('feedback-form').reset();
    $('feedback-form').dataset.readingId = commerce.requestId;
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
let voiceController = null, voiceURL = '';
function resetVoice() {
  voiceController?.abort(); voiceController = null;
  const audio = $('reading-audio'); audio.pause(); audio.removeAttribute('src'); audio.load(); audio.hidden = true;
  if (voiceURL) URL.revokeObjectURL(voiceURL); voiceURL = '';
  $('reading-voice').hidden = true; $('voice-generate').disabled = false; $('voice-generate').hidden = false;
  $('voice-generate').textContent = '生成语音解读'; $('voice-status').textContent = '';
}
const resetTextAI = resetAI;
resetAI = function () { resetVoice(); resetTextAI(); };
$('voice-generate').addEventListener('click', async () => {
  if (!commerce.paidData?.session_id || voiceController) return;
  const session = commerce.paidData.session_id, flow = commerce.flow, controller = new AbortController();
  voiceController = controller; $('voice-generate').disabled = true;
  $('voice-status').textContent = '正在整理重点并生成语音，通常需要几十秒；你可以先阅读文字。';
  const timer = setTimeout(() => controller.abort(), 175000);
  try {
    const response = await fetch('/api/paid/voice', { method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ session_id: session }), signal: controller.signal });
    if (!response.ok) {
      const data = await response.json().catch(() => ({})); throw new Error(data.error || '语音暂时无法生成，请稍后重试。');
    }
    if (!response.headers.get('Content-Type')?.startsWith('audio/wav')) throw new Error('语音格式异常，请重试。');
    const blob = await response.blob();
    if (flow !== commerce.flow || session !== commerce.paidData?.session_id || controller.signal.aborted) return;
    if (voiceURL) URL.revokeObjectURL(voiceURL);
    voiceURL = URL.createObjectURL(blob); const audio = $('reading-audio'); audio.src = voiceURL; audio.hidden = false;
    $('voice-generate').hidden = true; $('voice-status').textContent = '语音已准备好，点击播放。你可以暂停或拖动进度。';
  } catch (error) {
    if (flow === commerce.flow && session === commerce.paidData?.session_id) {
      $('voice-status').textContent = error.name === 'AbortError' ? '生成超时，请重试。文字解读已保留。' : error.message;
      $('voice-generate').textContent = '重试生成语音';
    }
  } finally {
    clearTimeout(timer);
    if (voiceController === controller) { voiceController = null; $('voice-generate').disabled = false; }
  }
});
$('reading-audio').addEventListener('error', () => {
  if (!voiceURL) return;
  $('voice-status').textContent = '播放失败，请重试生成语音。文字解读已保留。';
  $('voice-generate').hidden = false; $('voice-generate').textContent = '重试生成语音';
});
function commercePrepareAI() {
  resetAI(); $('ai-panel').hidden = false;
  $('ai-consent').textContent = 'AI 解读会将本次问题、背景、牌面及有限对话发送给模型服务。回答仅作参考，请结合现实判断。';
  $('ai-title').textContent = commerce.paidData ? '结合你的问题，再往前看一步。' : '需要结合背景的 AI 解读？';
  $('ai-generate').disabled = Boolean(commerce.paidData);
  $('ai-generate').textContent = commerce.paidData ? 'AI 解读已生成' : '使用付费 AI 解读';
  $('ai-panel').querySelector('.ai-intro').textContent = commerce.paidData ? '以下为大模型针对本次问题和固定牌面的回答。' : '本地免费解读已完成。AI 解读和追问需先充值，可沿用当前这组牌。';
  if (!commerce.paidData && trialActive()) { $('ai-generate').textContent = '免费生成 AI 解读'; $('ai-panel').querySelector('.ai-intro').textContent = '试用期可免费使用 AI，沿用当前这组牌，不消耗原有次数。'; }
  if (commerce.paidData) {
    $('reading-voice').hidden = false;
    aiSession = commerce.paidData.session_id;
    aiMessage('assistant', commerce.paidData.answer);
    $('ai-followup-form').hidden = commerce.paidData.followup_remaining <= 0;
    $('ai-followup-help').textContent = commerce.paidData.admin_test ? '负责人测试：可继续追问，沿用同一组牌，不扣次数。' : '还可追问 ' + commerce.paidData.followup_remaining + ' 轮；沿用同一组牌。';
  }
  aiStatus(commerce.paidData ? 'AI 解读已生成；本地牌义仍可在下方对照。' : '每账号只有一次免费本地解读。继续解读或使用 AI 需要充值。');
  if (!commerce.paidData && trialActive()) aiStatus('试用期 AI 免费，每次解读包含 3 轮追问。');
}
async function commerceFollowup(payload) {
  const version = aiVersion, controller = new AbortController();
  aiController = controller; $('ai-send').disabled = true; $('ai-followup').readOnly = true;
  $('ai-panel').setAttribute('aria-busy', 'true'); aiStatus('AI 正在回答…');
  if (!commerce.followupId || commerce.followupMessage !== payload.message) {
    commerce.followupId = crypto.randomUUID(); commerce.followupMessage = payload.message;
  }
  try {
    const data = await commerceAPI('/api/paid/followup', { ...payload, request_id: commerce.followupId });
    if (version !== aiVersion) return;
    aiMessage('user', payload.message); aiMessage('assistant', data.answer);
    $('ai-followup').value = ''; commerce.followupId = '';
    $('ai-followup-help').textContent = data.admin_test ? '负责人测试：可继续追问，不扣次数。' : '本次追问剩余 ' + data.followup_remaining + ' 轮。';
    $('ai-followup-form').hidden = data.followup_remaining <= 0;
    aiStatus(data.followup_remaining > 0 ? 'AI 已回复，可以继续追问。' : '本次追问已用完，完整解读仍可阅读。');
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
  if (!commerce.account || (!trialActive() && commerce.mode === 'free' && !commerce.account.free_remaining) || (commerce.mode === 'paid' && !hasPaidAccess())) {
    event.stopImmediatePropagation(); event.preventDefault();
    if (!commerce.account) showAuth('register');
    else { if (commerce.mode === 'free') switchReadingMode('paid'); $('input-error').textContent = '免费本地解读已使用，继续解读请先充值。'; openPlans(); }
  }
}, true);
$('begin-draw').addEventListener('click', () => {
  if ($('session').hidden) return;
  commerce.requestId = crypto.randomUUID(); commerce.paidData = null; commerce.flow++; commerce.followupId = '';
  $('session-error').textContent = ''; $('reading-result-label').textContent = ''; updateChargeNote();
  $('reading-feedback').hidden = true; delete $('feedback-form').dataset.readingId;
});
$('reset').addEventListener('click', () => { resetVoice(); commerce.flow++; commerce.paidData = null; $('reading-feedback').hidden = true; delete $('feedback-form').dataset.readingId; });
$('feedback-form').addEventListener('submit', async event => {
  event.preventDefault(); const readingId = $('feedback-form').dataset.readingId, flow = commerce.flow;
  if (!readingId) return;
  $('feedback-submit').disabled = true; $('feedback-status').textContent = '正在提交反馈…';
  try {
    await commerceAPI('/api/feedback', { reading_id: readingId, rating: Number($('feedback-rating').value), message: $('feedback-message').value });
    if (flow === commerce.flow) $('feedback-status').textContent = '反馈已收到，谢谢！负责人可在后台查看。';
  } catch (error) { if (flow === commerce.flow) { $('feedback-status').textContent = error.message; $('feedback-submit').disabled = false; } }
});
$('plans-open').addEventListener('click', openPlans);
$('plans-inline').addEventListener('click', openPlans);
$('member-plans').addEventListener('click', openPlans);
$('account-open').addEventListener('click', async () => {
  $('member-status').textContent = '';
  try { await refreshAccount(); } catch { $('member-status').textContent = $('auth-status').textContent = '账号状态暂未刷新，请重试。'; }
  if (commerce.account) openDialog($('account-dialog')); else showAuth('login');
});
$('member-refresh').addEventListener('click', async () => {
  $('member-refresh').disabled = true; $('member-status').textContent = '正在刷新权益与订单…';
  try { await refreshAccount(); $('member-status').textContent = '权益与订单已更新。'; }
  catch (error) { $('member-status').textContent = error.message; }
  finally { $('member-refresh').disabled = false; }
});
$('auth-login-tab').addEventListener('click', () => setAuthTab('login'));
$('auth-register-tab').addEventListener('click', () => setAuthTab('register'));
$('account-phone').addEventListener('input', () => $('account-phone').setCustomValidity(''));
$('auth-form').addEventListener('submit', async event => {
  event.preventDefault();
  const registration = $('auth-form').dataset.tab === 'register';
  if (registration) {
    const mobile = $('account-phone').value.normalize('NFKC').trim().replace(/[\s-]/g, '').replace(/^\+86/, '');
    if (!/^1[3-9]\d{9}$/.test(mobile)) {
      $('account-phone').setCustomValidity('请填写 11 位中国大陆手机号。'); $('account-phone').reportValidity();
      $('auth-status').textContent = '手机号格式不正确，请检查后重试。'; return;
    }
  }
  const button = $('auth-submit'); button.disabled = true;
  $('auth-status').textContent = '正在验证，请稍等…';
  try {
    const data = await commerceAPI(registration ? '/api/account/register' : '/api/account/login', {
      username: $('account-username').value, password: $('account-password').value, confirm_password: $('account-confirm-password').value,
      ...(registration ? { phone: $('account-phone').value } : {}) });
    setAccount(data); $('account-password').value = ''; $('account-confirm-password').value = ''; $('account-phone').value = '';
    closeDialog($('account-dialog')); $('input-error').textContent = '';
    const next = commerce.afterAuth; commerce.afterAuth = null;
    if (next) next();
  } catch (error) { $('auth-status').textContent = error.message; }
  finally { button.disabled = false; }
});
$('account-logout').addEventListener('click', async () => {
  $('account-logout').disabled = true;
  try {
    await commerceAPI('/api/account/logout', {}); setAccount(null); resetAI(); commerce.flow++; commerce.paidData = null;
    $('reading-feedback').hidden = true; delete $('feedback-form').dataset.readingId;
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
  $('create-order').disabled = true; $('plans-status').textContent = '正在生成订单…';
  try {
    if (!commerce.cartId || commerce.cartProduct !== product.id) { commerce.cartId = crypto.randomUUID(); commerce.cartProduct = product.id; }
    const data = await commerceAPI('/api/order', { product_id: product.id, request_id: commerce.cartId });
    showCheckout(data.order);
    refreshAccount().catch(() => {});
  } catch (error) {
    $('plans-status').textContent = error.message;
    if (error.status === 401) { setAccount(null); closeDialog($('plans-dialog')); showAuth('login', openPlans); }
  } finally { $('create-order').disabled = false; }
});
$('checkout-back').addEventListener('click', () => { $('checkout-panel').hidden = true; $('plans-selection').hidden = false; $('plans-status').textContent = ''; });
document.querySelectorAll('[data-payment-method]').forEach(button => button.addEventListener('click', () => {
  const alipay = button.dataset.paymentMethod === 'alipay', name = alipay ? '支付宝' : '微信';
  const original = '/assets/payments/' + (alipay ? 'alipay-original.jpg' : 'wechat-original.png');
  $('payment-qr-image').src = '/assets/payments/' + (alipay ? 'alipay' : 'wechat') + '-qr.png';
  $('payment-qr-image').alt = name + '收款二维码'; $('payment-qr-label').textContent = name + '收款码';
  $('payment-qr-save').href = original; $('payment-qr-save').download = '观心-' + name + '收款码.' + (alipay ? 'jpg' : 'png');
  $('payment-qr-open').href = original;
  document.querySelectorAll('[data-payment-method]').forEach(b => b.setAttribute('aria-pressed', String(b === button)));
}));
async function copyPaymentText(value, message) {
  try {
    await navigator.clipboard.writeText(value);
    $('checkout-copy-status').textContent = message;
  } catch {
    $('checkout-copy-status').textContent = '复制未成功，请长按或选中页面上的微信号、套餐、金额和订单号，手动复制。';
  }
}
$('copy-payment-wechat').addEventListener('click', () => copyPaymentText($('payment-wechat').textContent, '微信号已复制，请到微信搜索添加。'));
$('copy-payment-order').addEventListener('click', () => {
  if (!commerce.order) return;
  const order = commerce.order;
  copyPaymentText('观心套餐开通\n套餐：' + order.title + '\n应付金额：¥' + money(order.price) + '\n订单号：' + order.id,
    '订单信息已复制，请发给负责人核对。付款后由负责人核实到账并开通。');
});
$('refresh-payment').addEventListener('click', async () => {
  if (!commerce.order) return;
  $('refresh-payment').disabled = true; $('checkout-status').textContent = '正在查询到账状态…';
  try {
    const result = await commerceAPI('/api/order/status', { order_id: commerce.order.id });
    setAccount(result.account); showCheckout(result.order);
    try { await refreshAccount(); } catch { /* The order status and current rights are already updated. */ }
    if (result.order.status !== 'paid') {
      $('checkout-status').textContent = '暂未确认收款。请添加上方微信 LZRRR_0201，发送订单信息；付款后由负责人核实到账并开通。点击刷新只查询状态，不会自动充值。';
      return;
    }
    $('checkout-status').textContent = '管理员已确认收款，付费权益已到账，无需重复付款。';
    $('checkout-return').hidden = false;
    $('checkout-return').textContent = $('session').hidden ? '返回，开始 AI 解读' : '返回当前抽牌';
    switchReadingMode('paid'); commerce.cartId = '';
  } catch (error) { $('checkout-status').textContent = error.message; }
  finally { $('refresh-payment').disabled = false; }
});
$('checkout-return').addEventListener('click', () => { closeDialog($('plans-dialog')); if (!$('session').hidden && !$('results').hidden && !commerce.paidData) readCommercial(); });
$('share-site').addEventListener('click', async () => {
  const url = 'https://tarot.ruichi0201.cn/?from=share';
  try {
    if (navigator.share) await navigator.share({ title: '观心 · 留一点时间，听见自己', text: trialActive() ? '限时免费 AI 卡牌自我探索，' + trialEndLabel() + '（北京时间）结束试用，之后恢复套餐。' : '一次免费的卡牌自我探索，不含 AI，了解当下与下一步。', url });
    else { await navigator.clipboard.writeText(url); $('share-status').textContent = '网站链接已复制，不包含你的问题或抽牌结果。'; }
  } catch (error) {
    if (error.name !== 'AbortError') $('share-status').textContent = '可直接分享网址：' + url;
  }
});
switchReadingMode('free');
Promise.allSettled([
  refreshAccount(),
  commerceAPI('/api/catalog').then(data => { setTrial(data.trial); commerce.products = data.products; renderProducts(); $('create-order').disabled = trialActive(); })
]).then(results => {
  if (results[0].status === 'rejected') $('free-summary').textContent = '账号服务暂时不可用，请刷新后重试。';
  if (results[1].status === 'rejected') {
    $('plans-status').textContent = '套餐暂时加载失败，请刷新后重试。';
    $('create-order').disabled = true;
  }
});


function hasPaidAccess() {
  const paid = commerce.account?.paid;
  if (commerce.account?.admin_test) return true;
  if (commerce.account && trialActive()) return true;
  return Boolean(paid && (Object.values(paid.balance).some(n => n > 0) || (paid.remaining_today && Object.values(paid.remaining_today).some(n => n > 0))));
}
