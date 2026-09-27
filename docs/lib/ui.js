// Page chrome shared by every page: theme toggle and (?) tooltips.
export const store = {
  get(k, d) { try { const v = localStorage.getItem('arb:' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('arb:' + k, JSON.stringify(v)); } catch { /* private mode: fine */ } },
};

export function initChrome() {
  // theme: system → light → dark
  const root = document.documentElement;
  const apply = t => { if (t === 'system') root.removeAttribute('data-theme'); else root.setAttribute('data-theme', t); };
  let theme = store.get('theme', 'system');
  apply(theme);
  const btn = document.getElementById('theme-btn');
  const label = () => { if (btn) btn.textContent = { system: 'Theme: auto', light: 'Theme: light', dark: 'Theme: dark' }[theme]; };
  label();
  btn?.addEventListener('click', () => {
    theme = { system: 'light', light: 'dark', dark: 'system' }[theme];
    apply(theme); store.set('theme', theme); label();
  });

  // tooltips: hover, focus or tap a (?) button
  const pop = document.createElement('div');
  pop.id = 'tip-pop'; pop.hidden = true; pop.setAttribute('role', 'tooltip');
  document.body.appendChild(pop);
  let pinned = null;
  const show = el => {
    pop.textContent = el.dataset.tip; pop.hidden = false;
    const r = el.getBoundingClientRect();
    const w = Math.min(300, window.innerWidth - 24);
    pop.style.maxWidth = w + 'px';
    const left = Math.max(12, Math.min(r.left - w / 2 + 8, window.innerWidth - w - 12));
    pop.style.left = left + 'px';
    const below = r.bottom + 8;
    pop.style.top = (below + pop.offsetHeight > window.innerHeight - 60 ? r.top - pop.offsetHeight - 8 : below) + 'px';
  };
  const hide = () => { if (!pinned) pop.hidden = true; };
  document.addEventListener('mouseover', e => { const t = e.target.closest('.tip'); if (t) show(t); });
  document.addEventListener('mouseout', e => { if (e.target.closest('.tip')) hide(); });
  document.addEventListener('focusin', e => { const t = e.target.closest('.tip'); if (t) show(t); });
  document.addEventListener('focusout', e => { if (e.target.closest('.tip')) { pinned = null; hide(); } });
  document.addEventListener('click', e => {
    const t = e.target.closest('.tip');
    if (t) { e.preventDefault(); pinned = pinned === t ? null : t; if (pinned) show(t); else hide(); }
    else if (pinned) { pinned = null; hide(); }
  });
  window.addEventListener('scroll', () => { pinned = null; pop.hidden = true; }, { passive: true });
}

export async function copyText(text, btn) {
  try { await navigator.clipboard.writeText(text); flash(btn, 'Copied'); }
  catch {
    const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); flash(btn, 'Copied'); } catch { flash(btn, 'Select & copy'); }
    ta.remove();
  }
}
function flash(btn, msg) { if (!btn) return; const o = btn.textContent; btn.textContent = msg; setTimeout(() => (btn.textContent = o), 1400); }
