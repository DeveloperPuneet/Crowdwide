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

  const pendingBubble = ({ body, gif }) => {
    const wrap = document.createElement('div');
    wrap.className = 'chat-msg is-own is-pending';
    const main = document.createElement('div');
    main.className = 'chat-msg-main';
    const bubble = document.createElement('div');
    bubble.className = `chat-bubble${gif && !body ? ' is-media' : ''}`;
    if (gif) {
      const image = document.createElement('img');
      image.className = 'chat-gif';
      image.src = gif.preview || gif.url;
      image.alt = gif.title || 'GIF';
      bubble.append(image);
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
    const params = new URLSearchParams();
    if (payload.body) params.set('body', payload.body);
    if (payload.gif) {
      params.set('gifUrl', payload.gif.url);
      params.set('gifPreview', payload.gif.preview || '');
      params.set('gifTitle', payload.gif.title || '');
      params.set('gifWidth', payload.gif.width || '');
      params.set('gifHeight', payload.gif.height || '');
    }
    params.set('_csrf', csrf());
    bubble.classList.remove('is-failed');
    bubble.querySelector('.chat-status').textContent = 'Sending...';
    bubble.querySelector('.chat-retry')?.remove();
    try {
      const { data } = await window.axios.post(form.action, params, { headers: headers() });
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
    if (!payload.body && !payload.gif) return;
    showError('');
    const bubble = pendingBubble(payload);
    list.append(bubble);
    if (empty) empty.hidden = true;
    pinned = true;
    toBottom(false);
    deliver(payload, bubble);
  }

  const autosize = () => {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 140)}px`;
  };

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const body = input.value.trim();
    if (!body) return;
    send({ body });
    input.value = '';
    autosize();
    input.focus();
  });
  input.addEventListener('input', autosize);
  input.addEventListener('keydown', (event) => {
    // Enter sends (Shift+Enter = new line). Touch keyboards keep Enter as a new line.
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && !isTouch) {
      event.preventDefault();
      form.requestSubmit();
    }
  });

  form.querySelector('[data-gif-trigger]')?.addEventListener('click', (event) => {
    if (!window.CWGif) return;
    window.CWGif.open(event.currentTarget, (gif) => send({ gif }));
  });

  // ---- start ----
  trackIds();
  decorate();
  toBottom(false);
  window.addEventListener('load', () => { decorate(); if (pinned) toBottom(false); });
  if (!isTouch) input.focus({ preventScroll: true }); // don't pop the phone keyboard open on arrival
  schedule(delay);
})();
