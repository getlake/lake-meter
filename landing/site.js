// Copy-to-clipboard for the install command.
document.querySelectorAll('[data-copy]').forEach((b) => {
  b.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(b.dataset.copy); } catch { /* clipboard blocked: the command is visible anyway */ }
    b.classList.add('done');
    setTimeout(() => b.classList.remove('done'), 1600);
    if (window.goatcounter?.count) window.goatcounter.count({ path: 'copy-install', title: 'Copied install command', event: true });
  });
});

// GoatCounter events. count.js loads async, so queue until window.goatcounter.count exists (polls for up to 15 s).
const gcQueue = [];
let gcTimer = null;
const gcFlush = () => { const gc = window.goatcounter; if (!(gc && gc.count)) return false; while (gcQueue.length) gc.count(gcQueue.shift()); return true; };
function gcEvent(path, title) {
  gcQueue.push({ path, title: title || path, event: true });
  if (gcFlush() || gcTimer) return;
  let n = 0;
  gcTimer = setInterval(() => { if (gcFlush() || ++n > 60) { clearInterval(gcTimer); gcTimer = null; } }, 250);
}

// A/B tests on the hero (buckets are set by the inline script in <head>).
// One exposure event per test per session, one CTA-click event per session tagged with both buckets.
// Skipped for automation, obvious bots and ?ab= QA overrides, so they never count.
(() => {
  const d = document.documentElement;
  const h1 = d.dataset.abH1, cta = d.dataset.abCta;
  if (!h1 || !cta) return;
  if (navigator.webdriver || d.dataset.abQa || /bot|crawl|spider|preview|headless|lighthouse/i.test(navigator.userAgent)) return;
  const once = (key, fn) => { try { if (sessionStorage.getItem(key)) return; sessionStorage.setItem(key, '1'); } catch { /* storage blocked: count anyway */ } fn(); };
  const combo = `h1-${h1}_cta-${cta}`;
  once('lake_ab_seen_meter_h1', () => gcEvent(`ab/meter-h1/${h1}`, `A/B exposure: headline ${h1}`));
  once('lake_ab_seen_meter_cta', () => gcEvent(`ab/meter-cta/${cta}`, `A/B exposure: CTA ${cta}`));
  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-ab-target]');
    if (!el) return;
    once('lake_ab_click_meter_cta', () => gcEvent(`ab/meter-cta-click/${combo}`, `A/B CTA click (${el.dataset.abTarget})`));
    if (el.dataset.abTarget.startsWith('copy')) once('lake_ab_copy_meter', () => gcEvent(`ab/meter-copy/${combo}`, 'A/B install copied'));
  });
})();

// Team pilot CTA: count one click per session. The link opens a GitHub issue template.
document.querySelectorAll('[data-team-pilot]').forEach((a) => {
  a.addEventListener('click', () => {
    try { if (sessionStorage.getItem('lake_team_pilot')) return; sessionStorage.setItem('lake_team_pilot', '1'); } catch { /* storage blocked: count anyway */ }
    gcEvent('team-pilot', 'Request a team pilot');
  });
});
