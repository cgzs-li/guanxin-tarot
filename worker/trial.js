export function trialWindow(env, now = Date.now()) {
  const starts = Date.parse(env.GUANXIN_TRIAL_START || ''), ends = Date.parse(env.GUANXIN_TRIAL_END || '');
  const valid = Number.isFinite(starts) && Number.isFinite(ends) && ends > starts;
  const active = valid && now >= starts && now < ends;
  return { active, starts_at: valid ? starts : null, ends_at: valid ? ends : null, server_now: active ? now : null };
}
