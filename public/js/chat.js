// Direct-message and group-chat behaviour. The page never reloads while
// chatting: messages are sent and received in the background, the composer stays
// pinned to the bottom, and only the message list scrolls.
(function () {
  const shell = document.querySelector('[data-chat]');
  if (!shell || !window.axios) return;

  const scroller = shell.querySelector('[data-chat-scroll]');
  const list = shell.querySelector('[data-chat-messages]');
  const empty = shell.querySelector('[data-chat-empty]');
  const form = shell.querySelector('[data-chat-form]');
  const input = shell.querySelector('[data-chat-input]');
  const replyToInput = form?.querySelector('[data-chat-reply-to]');
  const replyingTo = form?.querySelector('[data-chat-replying-to]');
  const replySender = form?.querySelector('[data-chat-reply-sender]');
  const replyBody = form?.querySelector('[data-chat-reply-body]');
  const selectionBar = shell.querySelector('[data-chat-selection-bar]');
  const selectionCount = shell.querySelector('[data-chat-selection-count]');
  const deleteSelected = shell.querySelector('[data-chat-delete-selected]');
  const selectionToggle = shell.querySelector('[data-chat-select-toggle]');
  const attachmentInput = form?.querySelector('[data-chat-attachment]');
  const attachmentSelected = form?.querySelector('[data-chat-attachment-selected]');
  const attachmentName = form?.querySelector('[data-chat-attachment-name]');
  const removeAttachment = form?.querySelector('[data-chat-attachment-remove]');
  const searchForm = shell.querySelector('[data-message-search-form]');
  const searchResults = shell.querySelector('[data-message-search-results]');
  const errorBox = shell.querySelector('[data-chat-error]');
  const jump = shell.querySelector('[data-chat-jump]');
  const pollUrl = shell.dataset.pollUrl;
  const MIN_ID = '000000000000000000000000';
  let lastId = shell.dataset.lastId || '';
  let oldestId = null;
  let hasMore = Boolean(shell.querySelector('[data-chat-more]'));
  let polling = false;
  let delay = 3000;
  let timer;

  const csrf = () => document.querySelector('meta[name="csrf-token"]')?.content || '';
  const headers = () => ({ 'X-CSRF-Token': csrf(), 'X-Requested-With': 'XMLHttpRequest' });
  const timeFormat = new Intl.DateTimeFormat([], { hour: 'numeric', minute: '2-digit' });
  const isTouch = window.matchMedia?.('(pointer: coarse)').matches;

  // Keep the chat panel within the actually visible viewport when mobile
  // browser chrome or the on-screen keyboard changes its height.
  const syncViewportHeight = () => {
    const height = window.visualViewport?.height || window.innerHeight;
    document.documentElement.style.setProperty('--chat-viewport-height', `${Math.round(height)}px`);
  };
  syncViewportHeight();
  window.addEventListener('resize', syncViewportHeight);
  window.visualViewport?.addEventListener('resize', syncViewportHeight);

  // ---- times and day separators (local time, so done in the browser) ----
  const dayKey = (date) => `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
  const dayLabel = (date) => {
    const today = new Date();
    const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
    if (dayKey(date) === dayKey(today)) return 'Today';
    if (dayKey(date) === dayKey(yesterday)) return 'Yesterday';
    return date.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short', year: date.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
  };

  const decorate = () => {
    list.querySelectorAll('.chat-time:not([data-done])').forEach((el) => {
      const date = new Date(el.getAttribute('datetime'));
      if (!Number.isNaN(date.getTime())) { el.textContent = timeFormat.format(date); el.dataset.done = '1'; }
    });
    list.querySelectorAll('.chat-day').forEach((el) => el.remove());
    let previous = null;
    Array.from(list.children).forEach((child) => {
      const iso = child.dataset.time;
      if (!iso || child.classList.contains('is-pending')) return;
      const date = new Date(iso);
      if (Number.isNaN(date.getTime())) return;
      const key = dayKey(date);
      if (key !== previous) {
        const separator = document.createElement('div');
        separator.className = 'chat-day';
        separator.innerHTML = '<span></span>';
        separator.firstChild.textContent = dayLabel(date);
        list.insertBefore(separator, child);
        previous = key;
      }
    });
    if (empty) empty.hidden = Boolean(list.querySelector('.chat-msg, .chat-system'));
  };

  // ---- scrolling ----
  const nearBottom = () => scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 140;
  const toBottom = (smooth) => scroller.scrollTo({ top: scroller.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  scroller.addEventListener('scroll', () => { if (nearBottom() && jump) jump.hidden = true; });
  jump?.addEventListener('click', () => { toBottom(true); jump.hidden = true; });
  // GIFs and post previews change height as they load; stay pinned if we were.
  let pinned = true;
  list.addEventListener('load', () => { if (pinned) toBottom(false); }, true);
  scroller.addEventListener('scroll', () => { pinned = nearBottom(); });

  const idOf = (el) => el.dataset.id || '';
  const trackIds = () => {
    const ids = Array.from(list.querySelectorAll('[data-id]')).map(idOf).filter(Boolean).sort();
    if (ids.length) { oldestId = ids[0]; if (ids[ids.length - 1] > lastId) lastId = ids[ids.length - 1]; }
  };

  const toNodes = (html) => {
    const template = document.createElement('template');
    template.innerHTML = html;
    return Array.from(template.content.children);
  };

  const selectedMessages = () => Array.from(list.querySelectorAll('[data-chat-select-message]:checked'));
  const updateSelection = () => {
    const selected = selectedMessages();
    if (selectionCount) selectionCount.textContent = `${selected.length} selected`;
    if (deleteSelected) deleteSelected.disabled = selected.length === 0;
  };
  const setSelecting = (enabled) => {
    shell.classList.toggle('is-selecting', enabled);
    if (selectionToggle) {
      selectionToggle.setAttribute('aria-pressed', String(enabled));
      selectionToggle.textContent = enabled ? 'Selecting' : 'Select';
    }
    if (selectionBar) selectionBar.hidden = !enabled;
    if (!enabled) list.querySelectorAll('[data-chat-select-message]:checked').forEach((checkbox) => { checkbox.checked = false; });
    updateSelection();
  };

  selectionToggle?.addEventListener('click', () => setSelecting(!shell.classList.contains('is-selecting')));
  shell.querySelector('[data-chat-selection-cancel]')?.addEventListener('click', () => setSelecting(false));
  list.addEventListener('change', (event) => {
    if (event.target.matches('[data-chat-select-message]')) updateSelection();
  });
  deleteSelected?.addEventListener('click', async () => {
    const ids = selectedMessages().map((checkbox) => checkbox.value);
    if (!ids.length || !window.confirm(`Delete ${ids.length === 1 ? 'this message' : `these ${ids.length} messages`}? This cannot be undone.`)) return;
    deleteSelected.disabled = true;
    try {
      const { data } = await window.axios.post(shell.dataset.deleteUrl, { messageIds: ids }, { headers: headers() });
      const deletedIds = new Set(data.deleted || []);
      Array.from(list.querySelectorAll('[data-id]')).forEach((message) => {
        if (deletedIds.has(message.dataset.id)) message.remove();
      });
      setSelecting(false);
      decorate();
      showError('');
    } catch (error) {
      showError(error.response?.data?.error || 'Could not delete the selected messages.');
      updateSelection();
    }
  });

  const clearReply = () => {
    if (replyToInput) replyToInput.value = '';
    if (replyingTo) replyingTo.hidden = true;
  };
  list.addEventListener('click', (event) => {
    const replyButton = event.target.closest('[data-reply-message]');
    if (replyButton) {
      if (replyToInput) replyToInput.value = replyButton.dataset.messageId;
      if (replySender) replySender.textContent = `Replying to ${replyButton.dataset.senderName}`;
      if (replyBody) replyBody.textContent = replyButton.dataset.replyBody;
      if (replyingTo) replyingTo.hidden = false;
      input?.focus({ preventScroll: true });
      return;
    }
    const jumpButton = event.target.closest('[data-reply-jump]');
    if (!jumpButton) return;
    const targetId = jumpButton.dataset.replyJump;
    const target = Array.from(list.querySelectorAll('[data-id]')).find((message) => message.dataset.id === targetId);
    if (target) {
      target.scrollIntoView({ block: 'center', behavior: 'smooth' });
      target.classList.add('is-search-match');
      setTimeout(() => target.classList.remove('is-search-match'), 1800);
    } else {
      window.location.href = `${window.location.pathname}?focus=${encodeURIComponent(targetId)}`;
    }
  });
  form?.querySelector('[data-chat-reply-cancel]')?.addEventListener('click', clearReply);

  // Adds messages that are not on screen yet, keeping them in id (time) order.
  const addMessages = (items, { prepend = false } = {}) => {
    const fresh = items.filter((item) => item.id && !list.querySelector(`[data-id="${item.id}"]`));
    if (!fresh.length) return 0;
    if (prepend) {
      const before = scroller.scrollHeight;
      const first = list.firstElementChild;
      fresh.forEach((item) => toNodes(item.html).forEach((node) => list.insertBefore(node, first)));
      decorate();
      scroller.scrollTop += scroller.scrollHeight - before;
    } else {
      fresh.forEach((item) => toNodes(item.html).forEach((node) => list.append(node)));
      decorate();
    }
    trackIds();
    return fresh.length;
  };

  // ---- receiving ----
  const schedule = (ms) => { clearTimeout(timer); timer = setTimeout(poll, ms); };
  async function poll() {
    if (polling) return;
    if (document.hidden) return schedule(15000);
    polling = true;
    try {
      const { data } = await window.axios.get(pollUrl, { params: { after: lastId || MIN_ID } });
      const items = data.messages || [];
      const stick = nearBottom();
      const incoming = items.filter((item) => !list.querySelector(`[data-id="${item.id}"]`));
      const added = addMessages(items);
      if (added) {
        const fromOthers = incoming.some((item) => !item.html.includes('chat-msg is-own'));
        if (stick) toBottom(false);
        else if (fromOthers && jump) jump.hidden = false;
        delay = 3000;
      } else delay = Math.min(delay * 1.25, 10000);
    } catch (error) {
      delay = Math.min(delay * 2, 30000);
    } finally {
      polling = false;
      schedule(delay);
    }
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { delay = 3000; schedule(0); } });

  // ---- older messages ----
  shell.querySelector('[data-chat-more]')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    if (!hasMore || !oldestId) return;
    button.disabled = true;
    try {
      const { data } = await window.axios.get(shell.dataset.historyUrl || pollUrl, { params: { before: oldestId } });
      addMessages(data.messages || [], { prepend: true });
      hasMore = Boolean(data.hasMore);
      if (!hasMore) button.remove(); else button.disabled = false;
    } catch (error) {
      button.disabled = false;
      showError('Could not load earlier messages.');
    }
  });

  // ---- sending ----
  const showError = (text) => {
    if (!errorBox) return;
    errorBox.textContent = text || '';
    errorBox.hidden = !text;
  };

  searchForm?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const query = new FormData(searchForm).get('q')?.toString().trim() || '';
    searchResults.replaceChildren();
    searchResults.hidden = false;
    if (query.length < 2) {
      searchResults.textContent = 'Enter at least 2 characters.';
      return;
    }
    searchResults.textContent = 'Searching…';
    const button = searchForm.querySelector('button[type="submit"]');
    if (button) button.disabled = true;
    try {
      const { data } = await window.axios.get(searchForm.action, { params: { q: query } });
      searchResults.replaceChildren();
      if (!data.results?.length) {
        searchResults.textContent = 'No matching messages.';
        return;
      }
      data.results.forEach((result) => {
        const link = document.createElement('a');
        link.className = 'chat-search-result';
        link.href = result.href;
        const sender = document.createElement('strong');
        sender.textContent = result.sender;
        const snippet = document.createElement('span');
        snippet.textContent = result.excerpt;
        const time = document.createElement('time');
        time.textContent = new Intl.DateTimeFormat([], { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(result.createdAt));
        link.append(sender, snippet, time);
        searchResults.append(link);
      });
    } catch (error) {
      searchResults.textContent = error.response?.data?.error || 'Could not search this conversation.';
    } finally {
      if (button) button.disabled = false;
    }
  });
  searchForm?.querySelector('input[type="search"]')?.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && searchResults) searchResults.hidden = true;
  });

  const syncAttachmentSelection = () => {
    if (!attachmentSelected || !attachmentName || !attachmentInput) return;
    const file = attachmentInput.files?.[0];
    attachmentName.textContent = file ? file.name : '';
    attachmentSelected.hidden = !file;
  };

  attachmentInput?.addEventListener('change', syncAttachmentSelection);
  removeAttachment?.addEventListener('click', () => {
    if (attachmentInput) attachmentInput.value = '';
    syncAttachmentSelection();
  });

  const pendingBubble = ({ body, gif, file, replyTo }) => {
    const wrap = document.createElement('div');
    wrap.className = 'chat-msg is-own is-pending';
    const main = document.createElement('div');
    main.className = 'chat-msg-main';
    if (replyTo) {
      const quote = document.createElement('div');
      quote.className = 'chat-reply-quote-pending';
      quote.textContent = 'Replying to a message';
      main.append(quote);
    }
    const bubble = document.createElement('div');
    bubble.className = `chat-bubble${gif && !body ? ' is-media' : ''}`;
    if (gif) {
      const image = document.createElement('img');
      image.className = 'chat-gif';
      image.src = gif.preview || gif.url;
      image.alt = gif.title || 'GIF';
      bubble.append(image);
    }
    if (file) {
      const attachment = document.createElement('div');
      attachment.className = 'chat-attachment-pending';
      attachment.textContent = file.name;
      bubble.append(attachment);
    }
    if (body) {
      const text = document.createElement('p');
      text.className = 'chat-text';
      text.textContent = body;
      bubble.append(text);
    }
    const status = document.createElement('span');
    status.className = 'chat-time chat-status';
    status.textContent = 'Sending...';
    main.append(bubble, status);
    wrap.append(main);
    return wrap;
  };

  async function deliver(payload, bubble) {
    const formData = new FormData(form);
    const body = payload.body ?? input.value.trim();
    const file = payload.file || attachmentInput?.files?.[0];
    if (body) formData.set('body', body);
    else formData.delete('body');
    if (payload.gif) {
      formData.set('gifUrl', payload.gif.url);
      formData.set('gifPreview', payload.gif.preview || '');
      formData.set('gifTitle', payload.gif.title || '');
      formData.set('gifWidth', payload.gif.width || '');
      formData.set('gifHeight', payload.gif.height || '');
    } else {
      formData.delete('gifUrl');
      formData.delete('gifPreview');
      formData.delete('gifTitle');
      formData.delete('gifWidth');
      formData.delete('gifHeight');
    }
    if (file) formData.set('attachment', file);
    else formData.delete('attachment');
    if (payload.replyTo) formData.set('replyTo', payload.replyTo);
    else formData.delete('replyTo');
    bubble.classList.remove('is-failed');
    bubble.querySelector('.chat-status').textContent = 'Sending...';
    bubble.querySelector('.chat-retry')?.remove();
    try {
      const { data } = await window.axios.post(form.action, formData, { headers: headers() });
      if (attachmentInput) attachmentInput.value = '';
      if (attachmentSelected) attachmentSelected.hidden = true;
      if (attachmentName) attachmentName.textContent = '';
      const item = data.message;
      const alreadyThere = list.querySelector(`[data-id="${item.id}"]`); // the poll may have delivered it first
      if (alreadyThere) bubble.remove();
      else { const [node] = toNodes(item.html); bubble.replaceWith(node); }
      trackIds();
      decorate();
      if (pinned) toBottom(false);
      delay = 3000;
    } catch (error) {
      bubble.classList.add('is-failed');
      bubble.querySelector('.chat-status').textContent = error.response?.data?.error || 'Not sent.';
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'chat-retry';
      retry.textContent = 'Retry';
      retry.addEventListener('click', () => deliver(payload, bubble));
      bubble.querySelector('.chat-msg-main').append(retry);
    }
  }

  function send(payload) {
    const file = payload.file || attachmentInput?.files?.[0];
    if (!payload.body && !payload.gif && !file) return;
    payload = { ...payload, replyTo: payload.replyTo || replyToInput?.value || '' };
    showError('');
    const bubble = pendingBubble({ ...payload, file });
    list.append(bubble);
    if (empty) empty.hidden = true;
    pinned = true;
    toBottom(false);
    deliver(payload, bubble);
  }

  if (form && input) {
    const autosize = () => {
      input.style.height = 'auto';
      input.style.height = `${Math.min(input.scrollHeight, 140)}px`;
    };

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const body = input.value.trim();
      const file = attachmentInput?.files?.[0];
      if (!body && !file) return;
      send({ body, file });
      clearReply();
      input.value = '';
      if (attachmentInput) attachmentInput.value = '';
      syncAttachmentSelection();
      autosize();
      input.focus({ preventScroll: true });
    });
    input.addEventListener('input', autosize);
    input.addEventListener('keydown', (event) => {
      // Enter sends (Shift+Enter = new line). Touch keyboards keep Enter as a new line.
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && !isTouch) {
        event.preventDefault();
        form.requestSubmit();
      }
    });
  }

  form?.querySelector('[data-gif-trigger]')?.addEventListener('click', (event) => {
    if (!window.CWGif) return;
    window.CWGif.open(event.currentTarget, (gif) => { send({ gif }); clearReply(); });
  });

  // ---- start ----
  trackIds();
  decorate();
  const focusMessage = shell.dataset.focusId && list.querySelector(`[data-id="${shell.dataset.focusId}"]`);
  if (focusMessage) {
    pinned = false;
    focusMessage.classList.add('is-search-match');
    focusMessage.scrollIntoView({ block: 'center' });
  } else toBottom(false);
  window.addEventListener('load', () => { decorate(); if (pinned) toBottom(false); });
  if (input && !isTouch) input.focus({ preventScroll: true }); // don't pop the phone keyboard open on arrival
  schedule(delay);
})();
