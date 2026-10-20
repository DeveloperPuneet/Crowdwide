// Live moderation: review buttons submit in the background so the page never reloads,
// the card leaves the queue at once, and community queues sync with other moderators.
(() => {
  if (!window.axios) return;
  const SELECTOR = 'form[action="/moderator/actions"], form[action^="/communities/"][action$="/review"], form[action^="/communities/"][action$="/pin"], form[action^="/moderator/widewaves/"]';
  const csrf = () => document.querySelector('meta[name="csrf-token"]')?.content;

  let toast;
  const say = (text, error = false) => {
    if (!toast) {
      toast = document.createElement('div');
      toast.className = 'live-toast';
      toast.setAttribute('role', 'status');
      toast.setAttribute('aria-live', 'polite');
      document.body.appendChild(toast);
    }
    toast.textContent = text;
    toast.classList.toggle('is-error', error);
    toast.classList.add('is-visible');
    clearTimeout(say.timer);
    say.timer = setTimeout(() => toast.classList.remove('is-visible'), 3200);
  };

  const bumpCounts = (delta, absolute) => {
    document.querySelectorAll('[data-live-count]').forEach((el) => {
      const next = absolute !== undefined ? absolute : Math.max(0, (Number.parseInt(el.textContent, 10) || 0) + delta);
      el.textContent = String(next);
    });
  };

  const syncEmpty = (list) => {
    if (!list) return;
    const remaining = list.querySelectorAll('[data-live-item]').length;
    list.querySelectorAll('[data-live-empty]').forEach((el) => { el.hidden = remaining > 0; });
  };

  const removeItem = (item, list) => {
    item.classList.add('is-leaving');
    setTimeout(() => { item.remove(); syncEmpty(list); }, 220);
  };

  document.addEventListener('submit', async (event) => {
    const form = event.target.closest?.('form');
    if (!form || !form.matches(SELECTOR)) return;
    event.preventDefault();
    if (form.dataset.pending === 'true') return;
    form.dataset.pending = 'true';
    const buttons = form.closest('[data-live-item]')?.querySelectorAll('button') || form.querySelectorAll('button');
    buttons.forEach((b) => { b.disabled = true; });
    const item = form.closest('[data-live-item]');
    const list = form.closest('[data-live-list]');
    try {
      let data;
      try {
        data = new FormData(form, event.submitter);
      } catch (e) {
        data = new FormData(form);
      }
      const { data: result } = await window.axios.post(form.getAttribute('action'), new URLSearchParams(data), {
        headers: { 'X-CSRF-Token': csrf(), 'X-Requested-With': 'XMLHttpRequest', Accept: 'application/json' }
      });
      if (!result || typeof result !== 'object') {
        // An HTML answer means the panel password prompt intercepted the request.
        say('Open the moderator panel and confirm your password first, then try again.', true);
        return;
      }
      say(result.message || (result.ok ? 'Done.' : 'Could not complete that.'), !result.ok);
      if (result.ok) {
        if (result.remove && item) {
          removeItem(item, list);
          if (result.pending !== undefined) bumpCounts(0, result.pending); else bumpCounts(-1);
        } else {
          const action = form.querySelector('[name="action"]')?.value;
          if (action === 'edit-post') {
            const text = form.querySelector('textarea[name="payload[body]"]')?.value;
            const body = item?.querySelector('.mod-card-body > p:not(.mod-poll)');
            if (text && body) body.textContent = text;
          }
          if (result.pinned !== undefined) {
            const btn = form.querySelector('button');
            if (btn) btn.textContent = result.pinned ? 'Unpin post' : 'Pin post';
          }
          form.closest('details')?.removeAttribute('open');
          form.querySelectorAll('input[name="reason"]').forEach((input) => { input.value = ''; });
        }
      }
    } catch (error) {
      say('Could not reach the server. Nothing was changed.', true);
    } finally {
      form.dataset.pending = 'false';
      buttons.forEach((b) => { b.disabled = false; });
    }
  });

  // Community moderators: keep the pending-post queue in step with the server.
  const queue = document.querySelector('[data-review-queue-url]');
  if (queue) {
    const url = queue.dataset.reviewQueueUrl;
    const banner = queue.querySelector('[data-live-new]');
    const poll = async () => {
      if (document.hidden) return;
      try {
        const { data } = await window.axios.get(url, { headers: { 'X-Requested-With': 'XMLHttpRequest' } });
        if (!data?.ok) return;
        const ids = new Set(data.ids);
        let removed = 0;
        queue.querySelectorAll('[data-live-item][data-post-id]').forEach((el) => {
          if (!ids.has(el.dataset.postId)) { removeItem(el, queue); removed += 1; }
        });
        const known = new Set([...queue.querySelectorAll('[data-live-item][data-post-id]')].map((el) => el.dataset.postId));
        const fresh = data.ids.filter((id) => !known.has(id)).length;
        if (banner) {
          banner.hidden = fresh === 0;
          const label = banner.querySelector('[data-live-new-count]');
          if (label) label.textContent = String(fresh);
        }
        if (removed || fresh >= 0) bumpCounts(0, data.ids.length);
      } catch (e) { /* offline: try again next tick */ }
    };
    setInterval(poll, 15000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
    queue.querySelector('[data-live-new] button')?.addEventListener('click', () => window.location.reload());
  }
})();
