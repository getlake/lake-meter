// Copy-to-clipboard for the install command.
document.querySelectorAll('[data-copy]').forEach((b) => {
  b.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(b.dataset.copy); } catch { /* clipboard blocked: the command is visible anyway */ }
    b.classList.add('done');
    setTimeout(() => b.classList.remove('done'), 1600);
    if (window.goatcounter?.count) window.goatcounter.count({ path: 'copy-install', title: 'Copied install command', event: true });
  });
});

// Waitlist: posts to a free form backend once data-endpoint is set to an https form backend (e.g. a Formspree URL).
// Until then it opens a pre-filled email to the Lake research inbox, so signups still arrive.
const form = document.getElementById('waitlist');
const note = document.getElementById('form-note');
form?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = form.email.value.trim();
  if (!form.email.checkValidity()) { note.textContent = 'Please enter a valid email.'; return; }
  const endpoint = form.dataset.endpoint;
  if (window.goatcounter?.count) window.goatcounter.count({ path: 'waitlist-submit', title: 'Waitlist submit', event: true });
  if (endpoint && endpoint.startsWith('https://')) {
    try {
      const r = await fetch(endpoint, { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify({ email, source: 'lake-meter landing' }) });
      if (!r.ok) throw new Error();
      note.textContent = "You're on the list. We'll write once, when Pro opens.";
      form.reset();
      return;
    } catch { /* fall through to email */ }
  }
  const subject = encodeURIComponent('lake-meter Pro waitlist');
  const body = encodeURIComponent(`Please add me to the lake-meter Pro waitlist: ${email}`);
  window.location.href = `mailto:${form.dataset.mailto}?subject=${subject}&body=${body}`;
  note.textContent = 'Your email app should open with the request ready to send.';
});
