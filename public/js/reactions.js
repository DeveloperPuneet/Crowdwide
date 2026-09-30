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

  function syncRow(row, reactions) {
    row.querySelectorAll('.reaction-pill').forEach((pill) => pill.remove());
    const addEl = row.querySelector('.reaction-add');
    (reactions || []).forEach((r) => addEl.before(renderPill(r.emoji, r.count, r.reacted)));
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
    try {
      const { data } = await window.axios.post(url, new URLSearchParams({ emoji: option.dataset.emoji, _csrf: csrf() }), { headers: headers() });
      if (data.ok === false) return;
      syncRow(row, data.reactions);
    } catch (error) {
      // Leave the row as-is; a failed reaction just doesn't visibly change.
    }
  });
})();
