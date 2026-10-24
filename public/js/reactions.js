// Emoji reactions on comments, direct messages and group messages. Each
// .reaction-row carries the target type/id (and group id, for group chat) in
// data attributes; this file is the single place that knows which endpoint
// each type hits, so comment-node.ejs and chat-message.ejs only need to
// render the row - no per-context wiring in the templates themselves.
(function () {
  if (!window.axios) return;
  const csrf = () => document.querySelector('meta[name="csrf-token"]')?.content;
  const headers = () => ({ 'X-CSRF-Token': csrf(), 'X-Requested-With': 'XMLHttpRequest' });

  function endpointFor(row) {
    const id = row.dataset.targetId;
    switch (row.dataset.reactionTarget) {
      case 'comment': return `/comments/${id}/react`;
      case 'dm': return `/messages/${id}/react`;
      case 'group': return `/groups/${row.dataset.groupId}/messages/${id}/react`;
      default: return null;
    }
  }

  function renderPill(emoji, count, reacted) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `reaction-pill${reacted ? ' is-selected' : ''}`;
    button.dataset.emoji = emoji;
    button.setAttribute('aria-pressed', String(reacted));
    button.innerHTML = `<span class="reaction-emoji">${emoji}</span><span class="count">${count}</span>`;
    return button;
  }

  // Brings the pills in line with a list of { emoji, count, reacted }. Existing pills are updated in place (so the
  // one you just tapped keeps keyboard focus), new emoji are added before the "+" picker, and empty ones are removed.
  function syncRow(row, reactions) {
    const addEl = row.querySelector('.reaction-add');
    const wanted = new Map((reactions || []).filter((r) => r.count > 0).map((r) => [r.emoji, r]));
    row.querySelectorAll('.reaction-pill').forEach((pill) => {
      const entry = wanted.get(pill.dataset.emoji);
      if (!entry) { pill.remove(); return; }
      pill.classList.toggle('is-selected', Boolean(entry.reacted));
      pill.setAttribute('aria-pressed', String(Boolean(entry.reacted)));
      const count = pill.querySelector('.count');
      if (count) count.textContent = entry.count;
      wanted.delete(pill.dataset.emoji);
    });
    wanted.forEach((entry) => addEl.before(renderPill(entry.emoji, entry.count, entry.reacted)));
  }

  function readRow(row) {
    return Array.from(row.querySelectorAll('.reaction-pill')).map((pill) => ({
      emoji: pill.dataset.emoji,
      count: parseInt(pill.querySelector('.count')?.textContent, 10) || 0,
      reacted: pill.classList.contains('is-selected')
    }));
  }

  // Every emoji toggles on its own (like Slack): tap once to add yours, again to take it back.
  function toggleEmoji(state, emoji) {
    const list = state.map((entry) => ({ ...entry }));
    const found = list.find((entry) => entry.emoji === emoji);
    if (!found) return [...list, { emoji, count: 1, reacted: true }];
    found.count = Math.max(0, found.count + (found.reacted ? -1 : 1));
    found.reacted = !found.reacted;
    return list.filter((entry) => entry.count > 0);
  }

  function closePicker(picker) {
    picker.hidden = true;
    picker.closest('.reaction-add')?.querySelector('.reaction-add-trigger')?.setAttribute('aria-expanded', 'false');
  }

  document.addEventListener('click', (event) => {
    document.querySelectorAll('.reaction-picker:not([hidden])').forEach((picker) => {
      if (!picker.closest('.reaction-add')?.contains(event.target)) closePicker(picker);
    });
  });

  document.addEventListener('click', async (event) => {
    const trigger = event.target.closest('.reaction-add-trigger');
    if (trigger) {
      const picker = trigger.nextElementSibling;
      const wasOpen = !picker.hidden;
      document.querySelectorAll('.reaction-picker').forEach(closePicker);
      if (!wasOpen) { picker.hidden = false; trigger.setAttribute('aria-expanded', 'true'); }
      return;
    }
    const option = event.target.closest('.reaction-picker-option, .reaction-pill');
    if (!option) return;
    const row = option.closest('.reaction-row');
    if (!row) return;
    const url = endpointFor(row);
    if (!url) return;
    const picker = row.querySelector('.reaction-picker');
    if (picker) closePicker(picker);
    // Update the pills straight away and sync with the server in the background (see optimistic.js).
    const emoji = option.dataset.emoji;
    const body = new URLSearchParams({ emoji, _csrf: csrf() });
    window.cwOptimistic.run(row, {
      read: readRow,
      next: (state) => toggleEmoji(state, emoji),
      write: syncRow,
      fromServer: (data) => (Array.isArray(data.reactions) ? data.reactions : null),
      anchor: row,
      failMessage: "Couldn't save that reaction. It was removed again.",
      request: async () => (await window.axios.post(url, body, { headers: headers() })).data
    });
  });
})();
