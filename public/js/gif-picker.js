// GIF picker shared by chat, group chat and comments.
//
//   window.CWGif.open(triggerElement, (gif) => { ... })
//
// `gif` is { url, preview, title, width, height }. Comment forms
// (form[data-gif-form]) are wired automatically: picking a GIF attaches it to
// the form as a removable preview; it is sent together with the comment.
(function () {
  const csrf = () => document.querySelector('meta[name="csrf-token"]')?.content || '';
  let root; let grid; let search; let status; let more; let onPick = null; let trigger = null;
  let nextPos = null; let query = ''; let loading = false; let timer; let requestId = 0;

  function build() {
    if (root) return;
    root = document.createElement('div');
    root.className = 'gif-picker';
    root.hidden = true;
    root.innerHTML = `
      <div class="gif-picker-backdrop" data-gif-close></div>
      <div class="gif-picker-panel" role="dialog" aria-modal="true" aria-label="Choose a GIF">
        <div class="gif-picker-head">
          <input type="search" class="gif-picker-search" placeholder="Search GIFs" aria-label="Search GIFs" autocomplete="off">
          <button type="button" class="gif-picker-close" data-gif-close aria-label="Close">&times;</button>
        </div>
        <div class="gif-picker-body">
          <div class="gif-picker-grid" role="list"></div>
          <p class="gif-picker-status" role="status"></p>
          <button type="button" class="gif-picker-more" hidden>Load more</button>
        </div>
        <p class="gif-picker-credit">Powered by GIPHY</p>
      </div>`;
    document.body.append(root);
    grid = root.querySelector('.gif-picker-grid');
    search = root.querySelector('.gif-picker-search');
    status = root.querySelector('.gif-picker-status');
    more = root.querySelector('.gif-picker-more');
    root.querySelectorAll('[data-gif-close]').forEach((el) => el.addEventListener('click', close));
    document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && !root.hidden) close(); });
    search.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => { query = search.value.trim(); load(true); }, 350);
    });
    more.addEventListener('click', () => load(false));
    root.querySelector('.gif-picker-body').addEventListener('scroll', (event) => {
      const body = event.currentTarget;
      if (nextPos !== null && !loading && body.scrollHeight - body.scrollTop - body.clientHeight < 240) load(false);
    });
    grid.addEventListener('click', (event) => {
      const item = event.target.closest('[data-gif-index]');
      if (!item) return;
      const gif = JSON.parse(item.dataset.gif);
      const handler = onPick;
      close();
      if (handler) handler(gif);
    });
  }

  function setStatus(text) {
    status.textContent = text || '';
    status.hidden = !text;
  }

  async function load(reset) {
    if (loading && !reset) return;
    const thisRequest = ++requestId;
    loading = true;
    if (reset) { grid.replaceChildren(); nextPos = null; more.hidden = true; }
    setStatus('Loading...');
    try {
      const { data } = await window.axios.get('/gifs/search', { params: { q: query, pos: reset ? 0 : (nextPos || 0) } });
      if (thisRequest !== requestId) return;
      const fragment = document.createDocumentFragment();
      (data.results || []).forEach((gif, index) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'gif-item';
        button.setAttribute('role', 'listitem');
        button.dataset.gifIndex = String(index);
        button.dataset.gif = JSON.stringify(gif);
        button.setAttribute('aria-label', gif.title || 'GIF');
        const image = document.createElement('img');
        image.src = gif.preview || gif.url;
        image.alt = gif.title || 'GIF';
        image.loading = 'lazy';
        if (gif.width && gif.height) { image.width = gif.width; image.height = gif.height; }
        button.append(image);
        fragment.append(button);
      });
      grid.append(fragment);
      nextPos = data.next ?? null;
      more.hidden = nextPos === null;
      setStatus(grid.children.length ? '' : 'No GIFs found. Try another search.');
    } catch (error) {
      if (thisRequest !== requestId) return;
      setStatus(error.response?.data?.error || 'GIFs could not be loaded right now.');
    } finally {
      if (thisRequest === requestId) loading = false;
    }
  }

  function open(anchor, callback) {
    build();
    trigger = anchor || null;
    onPick = callback;
    root.hidden = false;
    document.body.classList.add('no-scroll');
    search.value = '';
    query = '';
    load(true);
    search.focus({ preventScroll: true });
  }

  function close() {
    if (!root || root.hidden) return;
    root.hidden = true;
    document.body.classList.remove('no-scroll');
    onPick = null;
    trigger?.focus?.({ preventScroll: true });
  }

  // ---- comment forms: attach a GIF to the form ----
  function setFormGif(form, gif) {
    const set = (name, value) => { const input = form.elements[name]; if (input) input.value = value || ''; };
    set('gifUrl', gif?.url); set('gifPreview', gif?.preview); set('gifTitle', gif?.title); set('gifWidth', gif?.width); set('gifHeight', gif?.height);
    const preview = form.querySelector('[data-gif-preview]');
    if (!preview) return;
    preview.hidden = !gif;
    const image = preview.querySelector('img');
    if (image) image.src = gif ? (gif.preview || gif.url) : '';
  }

  document.addEventListener('click', (event) => {
    const button = event.target.closest('[data-gif-trigger]');
    if (!button) return;
    const form = button.closest('form[data-gif-form]');
    if (!form) return; // chat.js handles the chat composer
    event.preventDefault();
    open(button, (gif) => { setFormGif(form, gif); form.querySelector('[data-comment-input]')?.focus(); });
  });
  document.addEventListener('click', (event) => {
    const remove = event.target.closest('[data-gif-remove]');
    if (!remove) return;
    const form = remove.closest('form[data-gif-form]');
    if (form) setFormGif(form, null);
  });
  document.addEventListener('gif:clear', (event) => {
    if (event.target.matches?.('form[data-gif-form]')) setFormGif(event.target, null);
  });

  window.CWGif = { open, close, csrf };
})();
