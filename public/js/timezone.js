// Tells the server which time zone this browser is in, so scheduled emails (the
// Sunday newsletter at 10:30) arrive on the member's own clock. Sent only when
// it differs from what is already saved, and at most once per browser session.
(() => {
  const saved = document.currentScript?.dataset.saved || '';
  let zone = '';
  try { zone = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (error) { return; }
  if (!zone || zone === saved) return;
  try { if (sessionStorage.getItem('cw-tz-sent') === zone) return; } catch (error) { /* storage unavailable */ }
  fetch('/settings/timezone', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': document.querySelector('meta[name="csrf-token"]')?.content || '' },
    body: JSON.stringify({ timezone: zone })
  }).then((response) => {
    if (response.ok) { try { sessionStorage.setItem('cw-tz-sent', zone); } catch (error) { /* ignore */ } }
  }).catch(() => {});
})();
