// "Send post" sheet: pick people and groups and the post is delivered into
// those chats. Only this counts toward a post's share number; copying the link
// or using the phone's share sheet does not.
(function () {
  const sheet = document.querySelector('[data-share-sheet]');
  if (!sheet || !window.axios) return;
  const list = sheet.querySelector('[data-share-list]');
  const search = sheet.querySelector('[data-share-search]');
  const note = sheet.querySelector('[data-share-note]');
  const sendButton = sheet.querySelector('[data-share-send]');
  const copyButton = sheet.querySelector('[data-share-copy]');
  const nativeButton = sheet.querySelector('[data-share-native]');
  const status = sheet.querySelector('[data-share-status]');
  const csrf = () => document.querySelector('meta[name="csrf-token"]')?.content || '';
  let postId = null; let postUrl = ''; let opener = null;
  const selected = new Set();
  let timer; let requestId = 0;

  const say = (text, isError) => {
    status.textContent = text || '';
    status.hidden = !text;
    status.classList.toggle('is-error', Boolean(isError));
  };

  const updateSendButton = () => {
    sendButton.disabled = selected.size === 0;
    sendButton.textContent = selected.size ? `Send (${selected.size})` : 'Send';
  };

  const row = (item, meta) => {
    const label = document.createElement('label');
    label.className = 'share-target';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.value = item.id;
    checkbox.checked = selected.has(item.id);
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) {
        if (selected.size >= 10) { checkbox.checked = false; say('You can send to up to 10 chats at once.', true); return; }
        selected.add(item.id);
      } else selected.delete(item.id);
      say('');
      updateSendButton();
    });
    const avatar = document.createElement('span');
    avatar.className = 'avatar small';
    if (item.avatar) { const img = document.createElement('img'); img.src = item.avatar; img.alt = ''; img.loading = 'lazy'; avatar.append(img); } else avatar.textContent = (item.name || '?').trim().charAt(0).toUpperCase();
    const text = document.createElement('span');
    text.className = 'share-target-name';
    const name = document.createElement('strong');
    name.textContent = item.name;
    text.append(name);
    if (meta) { const small = document.createElement('small'); small.textContent = meta; text.append(small); }
    const tick = document.createElement('span');
    tick.className = 'share-target-tick';
    label.append(avatar, text, checkbox, tick);
    return label;
  };

  const render = (data) => {
    const parts = [];
    const section = (title, items, meta) => {
      if (!items.length) return;
      const heading = document.createElement('h3');
      heading.textContent = title;
      parts.push(heading, ...items.map((item) => row(item, meta ? meta(item) : '')));
    };
    section('Groups', data.groups || [], (group) => `${group.members} members`);
    section('People', data.people || []);
    if (!parts.length) {
      const empty = document.createElement('p');
      empty.className = 'share-sheet-empty';
      empty.textContent = search.value.trim() ? 'No one matches that search.' : 'Follow people or start a chat to send posts to them here.';
      parts.push(empty);
    }
    list.replaceChildren(...parts);
  };

  const load = async (query) => {
    const thisRequest = ++requestId;
    try {
      const { data } = await window.axios.get('/share/targets', { params: { q: query } });
      if (thisRequest === requestId) render(data);
    } catch (error) {
      if (thisRequest === requestId) list.replaceChildren(Object.assign(document.createElement('p'), { className: 'share-sheet-empty', textContent: 'Could not load your chats. Try again.' }));
    }
  };

  const open = (button) => {
    opener = button;
    postId = button.dataset.postId;
    postUrl = new URL(button.dataset.postUrl || `/posts/${postId}`, window.location.origin).href;
    selected.clear();
    search.value = '';
    note.value = '';
    say('');
    updateSendButton();
    nativeButton.hidden = !navigator.share;
    list.replaceChildren(Object.assign(document.createElement('p'), { className: 'share-sheet-empty', textContent: 'Loading your chats...' }));
    sheet.hidden = false;
    document.body.classList.add('no-scroll');
    load('');
    search.focus({ preventScroll: true });
  };

  const close = () => {
    if (sheet.hidden) return;
    sheet.hidden = true;
    document.body.classList.remove('no-scroll');
    opener?.focus?.({ preventScroll: true });
  };

  document.addEventListener('click', (event) => {
    const button = event.target.closest('[data-share-open]');
    if (button) { event.preventDefault(); open(button); }
  });
  sheet.querySelectorAll('[data-share-close]').forEach((el) => el.addEventListener('click', close));
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape') close(); });
  search.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => load(search.value.trim()), 250); });

  sendButton.addEventListener('click', async () => {
    if (!selected.size || !postId) return;
    sendButton.disabled = true;
    say('Sending...');
    try {
      const body = new URLSearchParams();
      selected.forEach((id) => body.append('targets', id));
      body.set('note', note.value.trim());
      const { data } = await window.axios.post(`/posts/${postId}/share/send`, body, { headers: { 'X-CSRF-Token': csrf(), 'X-Requested-With': 'XMLHttpRequest' } });
      document.querySelectorAll(`[data-share-count-for="${postId}"]`).forEach((el) => { el.textContent = data.shares; });
      say(`Sent to ${data.sent} ${data.sent === 1 ? 'chat' : 'chats'}.`);
      window.setTimeout(close, 900);
    } catch (error) {
      say(error.response?.data?.error || 'Could not send that right now.', true);
      updateSendButton();
    }
  });

  copyButton.addEventListener('click', async () => {
    const label = copyButton.querySelector('span');
    try {
      await navigator.clipboard.writeText(postUrl);
      label.textContent = 'Link copied';
    } catch (error) {
      label.textContent = 'Copy failed';
    }
    window.setTimeout(() => { label.textContent = 'Copy link'; }, 1600);
  });
  nativeButton.addEventListener('click', async () => {
    try { await navigator.share({ title: document.title, url: postUrl }); } catch (error) { /* dismissed */ }
  });
})();
