// Composer WideWave picker: shows trending WideWaves, lets you search, and stores the
// choice in the hidden "widewave" field. A post goes to a community OR a WideWave.
(() => {
  // Create page: live preview of the name, forced to the allowed characters.
  const nameField = document.querySelector('.ww-name-input input[name="name"]');
  const preview = document.querySelector('[data-ww-name-preview]');
  if (nameField && preview) {
    const sync = () => {
      nameField.value = nameField.value.toLowerCase().replace(/^ww\//, '').replace(/[^a-z0-9_]/g, '');
      preview.textContent = nameField.value || 'name';
    };
    nameField.addEventListener('input', sync);
    sync();
  }
})();
(() => {
  const composer = document.querySelector('[data-ww-composer], #composer');
  const picker = document.querySelector('[data-ww-picker]');
  const input = composer?.querySelector('[data-ww-input]');
  const openButton = composer?.querySelector('[data-ww-open]');
  if (!composer || !picker || !input || !openButton || !window.axios) return;

  const label = openButton.querySelector('[data-ww-label]');
  const list = picker.querySelector('[data-ww-list]');
  const heading = picker.querySelector('[data-ww-heading]');
  const search = picker.querySelector('[data-ww-search]');
  const createLink = picker.querySelector('[data-ww-create]');
  const communitySelect = composer.querySelector('[data-community-select]');
  let timer;
  let lastFocus = null;

  const setChoice = (name) => {
    input.value = name || '';
    label.textContent = name ? `ww/${name}` : 'WideWave';
    openButton.classList.toggle('is-selected', Boolean(name));
    if (name && communitySelect && communitySelect.value) communitySelect.value = '';
  };
  const close = () => {
    picker.hidden = true;
    document.body.classList.remove('ww-picker-open');
    lastFocus?.focus?.();
  };
  const choose = (name) => { setChoice(name); close(); };

  const row = (wave) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'ww-pick';
    button.setAttribute('role', 'option');
    const title = document.createElement('strong');
    title.textContent = `ww/${wave.name}`;
    const desc = document.createElement('span');
    desc.textContent = wave.description;
    const stat = document.createElement('small');
    stat.textContent = wave.weekPosts ? `${wave.weekPosts} post${wave.weekPosts === 1 ? '' : 's'} this week` : `${wave.posts} post${wave.posts === 1 ? '' : 's'}`;
    button.append(title, desc, stat);
    button.addEventListener('click', () => choose(wave.name));
    return button;
  };

  const render = (data) => {
    const items = data.query ? data.results : data.trending;
    heading.textContent = data.query ? `Results for “${data.query}”` : 'Trending now';
    list.replaceChildren(...items.map(row));
    if (!items.length) {
      const empty = document.createElement('p');
      empty.className = 'ww-picker-empty';
      empty.textContent = data.query ? 'No WideWave matches yet.' : 'No WideWaves yet. Be the first to create one.';
      list.append(empty);
    }
    if (data.canCreate && data.suggestedName) {
      createLink.hidden = false;
      createLink.textContent = `Create ww/${data.suggestedName}`;
      createLink.href = `/widewaves/new?name=${encodeURIComponent(data.suggestedName)}`;
    } else {
      createLink.hidden = true;
    }
  };

  const load = async (query = '') => {
    try {
      const { data } = await window.axios.get('/widewaves/search', { params: { q: query }, headers: { 'X-Requested-With': 'XMLHttpRequest' } });
      render(data);
    } catch (error) {
      list.textContent = 'Could not load WideWaves. Try again.';
    }
  };

  openButton.addEventListener('click', () => {
    lastFocus = openButton;
    picker.hidden = false;
    document.body.classList.add('ww-picker-open');
    search.value = '';
    load('');
    search.focus();
  });
  picker.addEventListener('click', (event) => { if (event.target === picker || event.target.closest('[data-ww-close]')) close(); });
  picker.querySelector('[data-ww-clear]').addEventListener('click', () => choose(''));
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && !picker.hidden) close(); });
  search.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => load(search.value.trim()), 220); });
  communitySelect?.addEventListener('change', () => { if (communitySelect.value) setChoice(''); });
  // The in-page composer clears the topic choice after a post goes out.
  input.addEventListener('ww:reset', () => setChoice(''));

  const preset = input.dataset.preset || '';
  if (preset) {
    setChoice(preset);
    const open = document.querySelector('[data-composer-open]');
    if (composer.classList.contains('composer-hidden')) open?.click();
  }
})();

// Threads-style quick composer: grows with the text, shows the picked photo, and
// never posts without a WideWave (it opens the picker instead).
(() => {
  const form = document.querySelector('[data-ww-composer]');
  if (!form) return;
  const text = form.querySelector('textarea');
  const file = form.querySelector('[data-ww-file]');
  const fileName = form.querySelector('[data-ww-file-name]');
  const input = form.querySelector('[data-ww-input]');
  const open = form.querySelector('[data-ww-open]');
  const grow = () => { text.style.height = 'auto'; text.style.height = `${Math.min(text.scrollHeight, 320)}px`; };
  text.addEventListener('input', grow);
  text.addEventListener('focus', () => form.classList.add('is-open'));
  file?.addEventListener('change', () => {
    const picked = file.files && file.files[0];
    fileName.hidden = !picked;
    fileName.textContent = picked ? `Photo: ${picked.name}` : '';
    if (picked) form.classList.add('is-open');
  });
  form.addEventListener('submit', (event) => {
    if (input.value) return;
    event.preventDefault();
    open?.click();
  });
  const focusComposer = () => { form.scrollIntoView({ block: 'center' }); text.focus(); };
  if (window.location.hash === '#ww-composer') focusComposer();
  document.querySelector('[data-bottom-compose]')?.addEventListener('click', (event) => {
    if (window.location.pathname === '/widewaves' || window.location.pathname.startsWith('/ww/')) { event.preventDefault(); focusComposer(); }
  });
})();
