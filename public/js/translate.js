// "Translate" button on posts and comments. The button sits inside the same
// <article> as the [data-translatable] element holding the text (its plain
// original text, in data-original) - that keeps this file free of any
// per-context wiring, so a single click handler covers post-detail, feed
// cards and every level of a comment thread.
(function () {
  if (!window.axios) return;
  const originalHtml = new WeakMap();
  let languagesPromise = null;

  function getLanguages() {
    if (!languagesPromise) languagesPromise = window.axios.get('/translate/languages').then(({ data }) => data).catch(() => ({ configured: false, languages: [] }));
    return languagesPromise;
  }

  function guessLang() {
    const lang = (navigator.language || 'en').split('-')[0].toLowerCase();
    return /^[a-z]{2}$/.test(lang) ? lang : 'en';
  }

  function findTarget(trigger) {
    const container = trigger.closest('article');
    return container ? container.querySelector('[data-translatable]') : null;
  }

  function setBusy(trigger, busy) {
    trigger.disabled = busy;
    trigger.classList.toggle('is-busy', busy);
  }

  function setLabel(trigger, translated) {
    const label = trigger.querySelector('.label');
    if (label) label.textContent = translated ? 'Show original' : 'Translate';
    trigger.classList.toggle('is-translated', translated);
  }

  function showNote(trigger, text) {
    trigger.parentElement.querySelector('.translate-note')?.remove();
    const note = document.createElement('span');
    note.className = 'translate-note';
    note.textContent = text;
    trigger.after(note);
    window.setTimeout(() => note.remove(), 3000);
  }

  async function translateTarget(target, trigger, lang) {
    if (!originalHtml.has(target)) originalHtml.set(target, target.innerHTML);
    setBusy(trigger, true);
    try {
      const { data } = await window.axios.post('/translate', new URLSearchParams({ text: target.dataset.original, target: lang, _csrf: document.querySelector('meta[name="csrf-token"]')?.content }), { headers: { 'X-Requested-With': 'XMLHttpRequest' } });
      if (data.ok === false) { showNote(trigger, data.error || 'Translation is unavailable right now.'); return; }
      target.textContent = data.translatedText;
      target.dataset.translated = 'true';
      target.dataset.translatedLang = lang;
      setLabel(trigger, true);
    } catch (error) {
      showNote(trigger, 'Translation failed. Try again.');
    } finally {
      setBusy(trigger, false);
    }
  }

  function restoreTarget(target, trigger) {
    if (originalHtml.has(target)) target.innerHTML = originalHtml.get(target);
    delete target.dataset.translated;
    setLabel(trigger, false);
  }

  async function ensureLangSelect(trigger, target, currentLang) {
    let select = trigger.parentElement.querySelector(':scope > .translate-lang-select');
    if (select) { select.hidden = false; return select; }
    const { configured, languages } = await getLanguages();
    if (!configured || !languages.length) return null;
    select = document.createElement('select');
    select.className = 'translate-lang-select';
    select.setAttribute('aria-label', 'Translate to');
    languages.forEach(({ code, name }) => { const option = document.createElement('option'); option.value = code; option.textContent = name; select.append(option); });
    select.value = currentLang;
    select.addEventListener('click', (event) => event.stopPropagation());
    select.addEventListener('change', () => translateTarget(target, trigger, select.value));
    trigger.after(select);
    return select;
  }

  document.addEventListener('click', async (event) => {
    const trigger = event.target.closest('[data-translate-trigger]');
    if (!trigger) return;
    const target = findTarget(trigger);
    if (!target || trigger.disabled) return;
    if (target.dataset.translated === 'true') {
      restoreTarget(target, trigger);
      const select = trigger.parentElement.querySelector(':scope > .translate-lang-select');
      if (select) select.hidden = true;
      return;
    }
    const lang = guessLang();
    await translateTarget(target, trigger, lang);
    if (target.dataset.translated === 'true') await ensureLangSelect(trigger, target, lang);
  });
})();
