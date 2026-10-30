// Notifications page: mark read / unread / all read without reloading.
//
// Everything runs through cwOptimistic (see optimistic.js) on ONE scope - the list - so quick clicks are sent
// in order, the screen changes the instant you click, and a failed request puts everything back exactly as the
// server last confirmed it. The state of the page is:
//   flags  - for every loaded row, is it unread?
//   hidden - unread notifications that are not on screen yet (older pages not loaded), so the total stays right
(function () {
  const page = document.querySelector('[data-notifications]');
  const list = page && page.querySelector('[data-notification-list]');
  if (!page || !list || !window.axios || !window.cwOptimistic) return;

  const totalBadge = page.querySelector('[data-notification-total]');
  const markAllButton = page.querySelector('[data-mark-all]');
  const status = page.querySelector('[data-notification-status]');
  const token = () => document.querySelector('meta[name="csrf-token"]')?.content;
  const headers = () => ({ 'X-CSRF-Token': token(), 'X-Requested-With': 'XMLHttpRequest', Accept: 'application/json' });
  const items = () => Array.from(list.querySelectorAll('[data-notification]'));
  const weight = (item) => Number(item.dataset.weight) || 1;

  // Unread notifications that exist but are not rendered: the server total minus what the loaded rows hold.
  let hiddenInitial = Math.max(0, (Number(page.dataset.unreadTotal) || 0) - items().reduce((sum, item) => sum + (Number(item.dataset.unreadCount) || 0), 0));

  const read = () => ({ flags: items().map((item) => item.dataset.unread === '1'), hidden: hiddenInitial, items: items() });
  const totalOf = (state) => state.flags.reduce((sum, unread, index) => sum + (unread ? (Number(state.items[index].dataset.unreadCount) || weight(state.items[index])) : 0), 0) + state.hidden;

  function syncBell(total) {
    const badge = document.querySelector('.notification-badge');
    if (!badge) return;
    badge.hidden = !total;
    badge.classList.toggle('notification-dot-visible', Boolean(total));
    badge.closest('a')?.setAttribute('aria-label', total ? 'Notifications, you have new activity' : 'Notifications');
  }

  function paintItem(item, unread) {
    item.dataset.unread = unread ? '1' : '0';
    item.dataset.unreadCount = unread ? String(weight(item)) : '0';
    item.classList.toggle('notification-unread', unread);
    const toggle = item.querySelector('[data-notification-toggle]');
    if (toggle) {
      const label = unread ? 'Mark as read' : 'Mark as unread';
      toggle.setAttribute('aria-pressed', String(!unread));
      toggle.setAttribute('aria-label', label);
      toggle.title = label;
    }
  }

  function write(_scope, state) {
    const rows = items();
    rows.forEach((item, index) => { if (index < state.flags.length) paintItem(item, state.flags[index]); });
    hiddenInitial = state.hidden;
    const total = totalOf({ ...state, items: rows });
    if (totalBadge) { totalBadge.textContent = String(total); totalBadge.hidden = !total; }
    if (markAllButton) markAllButton.disabled = !total;
    syncBell(total);
    page.dataset.unreadNow = String(total);
  }

  const post = async (url, body) => (await window.axios.post(url, body, { headers: headers() })).data;

  function toggleItem(item) {
    const index = items().indexOf(item);
    if (index < 0) return;
    const nowUnread = item.dataset.unread === '1';
    const ids = (item.dataset.ids || '').split(',').filter(Boolean);
    window.cwOptimistic.run(list, {
      read,
      next: (state) => ({ ...state, flags: state.flags.map((flag, i) => (i === index ? !nowUnread : flag)) }),
      write,
      request: () => post('/notifications/mark', { ids, read: nowUnread }),
      fromServer: () => null,
      anchor: status,
      failMessage: "Couldn't update that notification. Your change was undone."
    });
  }

  function markAllRead() {
    if (!markAllButton || markAllButton.disabled) return;
    window.cwOptimistic.run(list, {
      read,
      next: (state) => (totalOf(state) ? { ...state, flags: state.flags.map(() => false), hidden: 0 } : null),
      write,
      request: () => post('/notifications/read', {}),
      fromServer: () => null,
      anchor: status,
      failMessage: "Couldn't mark everything as read. Your change was undone."
    });
  }

  // Clicking the dot flips one row; Mark all read flips everything. Neither navigates or reloads.
  page.addEventListener('click', (event) => {
    const toggle = event.target.closest('[data-notification-toggle]');
    if (toggle) { event.preventDefault(); toggleItem(toggle.closest('[data-notification]')); return; }
    const link = event.target.closest('.notification-link');
    if (link) {
      // Opening a notification counts as reading it. The request is fire-and-forget and survives the page
      // change; the row is painted read first so there is no flash of "unread" when coming back.
      const item = link.closest('[data-notification]');
      if (item && item.dataset.unread === '1') {
        const ids = (item.dataset.ids || '').split(',').filter(Boolean);
        const index = items().indexOf(item);
        write(list, { ...read(), flags: read().flags.map((flag, i) => (i === index ? false : flag)) });
        try {
          window.fetch('/notifications/mark', { method: 'POST', keepalive: true, credentials: 'same-origin', headers: { ...headers(), 'Content-Type': 'application/json' }, body: JSON.stringify({ ids, read: true }) }).catch(() => {});
        } catch (error) { /* the 60s badge refresh and the page itself will reconcile */ }
      }
    }
  });
  page.querySelector('[data-mark-all-form]')?.addEventListener('submit', (event) => { event.preventDefault(); markAllRead(); });

  // "Show earlier": appends the next page in place.
  const loadMore = () => {
    const box = list.querySelector('[data-notification-more]');
    const button = box && box.querySelector('[data-notification-more-button]');
    if (!box || !button || button.disabled) return;
    button.disabled = true;
    button.textContent = 'Loading…';
    const labels = list.querySelectorAll('.notification-day');
    const lastLabel = labels.length ? labels[labels.length - 1].dataset.dayLabel : '';
    const query = new URLSearchParams({ before: box.dataset.before, lastLabel, filter: page.dataset.filter });
    window.axios.get(`/notifications/more?${query}`, { headers: { Accept: 'application/json' } })
      .then(({ data }) => {
        const wrapper = document.createElement('div');
        wrapper.innerHTML = data.html || '';
        const fresh = Array.from(wrapper.querySelectorAll('[data-notification]'));
        // Rows that were already unread when loaded come out of the "hidden" count: they are on screen now.
        const added = fresh.reduce((sum, item) => sum + (Number(item.dataset.unreadCount) || 0), 0);
        hiddenInitial = Math.max(0, hiddenInitial - added);
        box.before(...Array.from(wrapper.children));
        if (typeof initAvatars === 'function') initAvatars(list);
        if (data.hasMore && data.nextBefore) { box.dataset.before = data.nextBefore; button.disabled = false; button.textContent = 'Show earlier'; }
        else box.remove();
      })
      .catch(() => { button.disabled = false; button.textContent = 'Could not load. Try again'; });
  };
  list.addEventListener('click', (event) => { if (event.target.closest('[data-notification-more-button]')) loadMore(); });

  // Keep the heading in step with the bell when the 60s poll in app.js learns of new activity elsewhere.
  window.addEventListener('pageshow', () => syncBell(Number(page.dataset.unreadNow ?? page.dataset.unreadTotal) || 0));
})();
