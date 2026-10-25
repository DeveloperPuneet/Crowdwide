// Reveal the page as soon as the HTML is ready. Waiting for the window "load"
// event meant a slow font, CDN script or large image kept the loading screen
// up (and the site feeling stuck) long after the content was usable.
const markPageReady = () => document.body.classList.add('page-ready');
markPageReady();
window.addEventListener('load', markPageReady);

const removeBrokenAvatar = (image) => {
  const avatar = image.closest('.avatar');
  if (!avatar) return;
  image.remove();
  avatar.classList.remove('has-image');
  avatar.classList.remove('image-loaded');
};
const showLoadedAvatar = (image) => {
  const avatar = image.closest('.avatar');
  if (avatar) avatar.classList.add('image-loaded');
};
// Avatar images start hidden (the initial shows) until they load. This must also run for
// anything added after the first paint - infinite-scroll feed pages, new comments, live
// chat - otherwise those profile pictures stay invisible.
const initAvatarImage = (image) => {
  if (image.dataset.avatarInit === '1') return;
  image.dataset.avatarInit = '1';
  if (image.complete) {
    if (image.naturalWidth === 0) removeBrokenAvatar(image);
    else showLoadedAvatar(image);
  } else {
    image.addEventListener('load', () => showLoadedAvatar(image), { once: true });
    image.addEventListener('error', () => removeBrokenAvatar(image), { once: true });
  }
};
const initAvatars = (root = document) => {
  if (root.matches?.('.avatar img')) initAvatarImage(root);
  root.querySelectorAll?.('.avatar img').forEach(initAvatarImage);
};
initAvatars();
if (typeof MutationObserver !== 'undefined') {
  new MutationObserver((mutations) => {
    mutations.forEach((mutation) => mutation.addedNodes.forEach((node) => { if (node.nodeType === 1) initAvatars(node); }));
  }).observe(document.body, { childList: true, subtree: true });
}
const removeBrokenCommunityAvatar = (image) => {
  const glyph = image.closest('.search-community-glyph');
  if (!glyph) return;
  image.remove();
  glyph.classList.remove('image-loaded');
};
const showLoadedCommunityAvatar = (image) => {
  const glyph = image.closest('.search-community-glyph');
  if (glyph) glyph.classList.add('image-loaded');
};
document.querySelectorAll('.search-community-avatar').forEach((image) => {
  if (image.complete) {
    if (image.naturalWidth === 0) removeBrokenCommunityAvatar(image);
    else showLoadedCommunityAvatar(image);
  } else {
    image.addEventListener('load', () => showLoadedCommunityAvatar(image), { once: true });
    image.addEventListener('error', () => removeBrokenCommunityAvatar(image), { once: true });
  }
});
document.addEventListener('error', (event) => {
  if (event.target instanceof HTMLImageElement) {
    removeBrokenAvatar(event.target);
    removeBrokenCommunityAvatar(event.target);
  }
}, true);

document.querySelectorAll('textarea[data-word-limit]').forEach((textarea) => {
  const limit = Number(textarea.dataset.wordLimit);
  const counter = textarea.form?.querySelector('[data-word-count]');
  const countWords = () => textarea.value.trim() ? textarea.value.trim().split(/\s+/).length : 0;
  const updateWordCount = () => {
    const count = countWords();
    if (counter) {
      if (counter.hasAttribute('data-word-count-remaining')) {
        const wordLabel = (total) => `${total} ${total === 1 ? 'word' : 'words'}`;
        counter.textContent = count > limit
          ? `${wordLabel(count)} used · ${wordLabel(count - limit)} over limit`
          : `${wordLabel(count)} used · ${wordLabel(limit - count)} left`;
      } else {
        counter.textContent = `${count} / ${limit} words`;
      }
      counter.classList.toggle('is-over', count > limit);
    }
    textarea.setAttribute('aria-invalid', String(count > limit));
  };
  textarea.addEventListener('input', updateWordCount);
  textarea.form?.addEventListener('submit', (event) => {
    if (countWords() <= limit) return;
    event.preventDefault();
    updateWordCount();
    textarea.focus();
  });
  updateWordCount();
});

document.querySelectorAll('[data-bio-limit]').forEach((bio) => {
  const words = bio.textContent.trim().split(/\s+/).filter(Boolean);
  if (words.length <= 12) return;
  bio.textContent = `${words.slice(0, 12).join(' ')}…`;
});

// Web fonts are added after the page is already on screen. A <link> in <head>
// blocks rendering until the font host answers, so a slow or blocked
// fonts.googleapis.com used to leave the page blank or half-loaded (text has
// a system-font fallback and swaps once the fonts arrive).
const loadWebFonts = () => {
  if (document.querySelector('link[data-web-fonts]')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.dataset.webFonts = '1';
  link.href = 'https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=Space+Grotesk:wght@500;600;700&display=swap';
  document.head.append(link);
};
loadWebFonts();

document.querySelectorAll('[data-warning-toggle]').forEach((toggle) => {
  toggle.addEventListener('click', () => {
    const card = toggle.closest('.has-content-warning');
    card?.classList.remove('has-content-warning');
    toggle.remove();
  });
});

const composer = document.querySelector('#composer');
if (composer) {
  const openComposer = document.querySelector('[data-composer-open]');
  const setComposerOpen = (open, { focus = true } = {}) => {
    composer.classList.toggle('composer-hidden', !open);
    openComposer?.setAttribute('aria-expanded', String(open));
    if (open) {
      composer.scrollIntoView({ behavior: 'smooth', block: 'center' });
      composer.querySelector('textarea')?.focus({ preventScroll: true });
    } else if (focus) {
      openComposer?.focus({ preventScroll: true });
    }
  };
  openComposer?.addEventListener('click', () => setComposerOpen(composer.classList.contains('composer-hidden')));
  composer.querySelector('[data-composer-close]')?.addEventListener('click', () => setComposerOpen(false));
  composer.addEventListener('keydown', (event) => { if (event.key === 'Escape') setComposerOpen(false); });
  const textarea = composer.querySelector('textarea[name="body"]');
  // "Answer" on the Question of the Day card (or ?ask=qotd from a reminder): open the
  // composer with the question and #qotd already in place.
  const fillComposer = (text) => {
    if (!textarea || !text) return;
    if (!textarea.value.trim()) textarea.value = text;
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    setComposerOpen(true);
    textarea.setSelectionRange(0, 0);
  };
  document.querySelectorAll('[data-qotd-answer]').forEach((link) => link.addEventListener('click', (event) => {
    event.preventDefault();
    fillComposer(link.dataset.prefill);
  }));
  if (composer.dataset.prefill) fillComposer(composer.dataset.prefill);
  const typeSelect = composer.querySelector('select[name="type"]');
  const communitySelect = composer.querySelector('[data-community-select]');
  const questSelect = composer.querySelector('[data-quest-picker]');
  const questHint = composer.querySelector('[data-quest-hint]');
  const count = composer.querySelector('[data-word-count]');
  const progress = composer.querySelector('.word-limit-meter');
  const progressFill = composer.querySelector('[data-word-progress]');
  const suggestions = composer.querySelector('[data-hashtag-suggestions]');
  const pollFields = composer.querySelector('.poll-composer');
  const limits = JSON.parse(composer.dataset.wordLimits || '{"post":60,"article":300,"poll":60}');
  const words = () => textarea.value.trim() ? textarea.value.trim().split(/\s+/).length : 0;
  const updateCount = () => {
    const limit = limits[typeSelect.value] || limits.post;
    const total = words();
    count.textContent = `${total} / ${limit} words`;
    count.classList.toggle('word-limit-warning', total > limit);
    if (progress && progressFill) {
      progress.setAttribute('aria-valuemax', String(limit));
      progress.setAttribute('aria-valuenow', String(total));
      progressFill.style.width = `${Math.min(100, (total / limit) * 100)}%`;
      progress.classList.toggle('is-warning', total >= limit * 0.8 && total <= limit);
      progress.classList.toggle('is-over', total > limit);
    }

    if (pollFields) pollFields.hidden = typeSelect.value !== 'poll';
  };
  const updateQuestOptions = (source) => {
    if (!communitySelect || !questSelect) return;
    const selectedQuest = questSelect.selectedOptions[0];
    const questCommunityId = selectedQuest?.dataset.community;
    if (source === 'quest' && questSelect.value && questCommunityId) communitySelect.value = questCommunityId;
    if (source === 'community' && questSelect.value && questCommunityId !== communitySelect.value) questSelect.value = '';
    if (questHint) {
      questHint.textContent = questSelect.value
        ? 'This post will be shared with the selected quest community.'
        : questSelect.options.length > 1
          ? 'Choose one of the active quests you have joined; its community will be selected for you.'
          : 'Join an active community quest to link a post to it.';
    }
  };
  const renderSuggestions = (items) => {
    suggestions.replaceChildren(...items.map(({ tag }) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = `#${tag}`;
      // Replace the partial "#tag" the person is currently typing (at the
      // caret) instead of appending a new one at the end of the textarea -
      // appending was the bug: picking a suggestion left the half-typed
      // hashtag in place and tacked a second, complete one on afterward.
      button.addEventListener('click', () => {
        const caret = textarea.selectionStart;
        const before = textarea.value.slice(0, caret);
        const match = before.match(/#([a-z0-9_]*)$/i);
        const tokenStart = match ? caret - match[0].length : caret;
        textarea.focus();
        textarea.setSelectionRange(tokenStart, caret);
        textarea.setRangeText(`#${tag} `, tokenStart, caret, 'end');
        suggestions.replaceChildren();
        updateCount();
      });
      return button;
    }));
  };
  let suggestionTimer;
  textarea.addEventListener('input', () => {
    updateCount();
    const match = textarea.value.match(/(?:^|\s)#([a-z0-9_]*)$/i);
    if (!match) return suggestions.replaceChildren();
    clearTimeout(suggestionTimer);
    suggestionTimer = setTimeout(() => fetch(`/hashtags/suggest?q=${encodeURIComponent(match[1])}`).then((response) => response.json()).then(renderSuggestions).catch(() => {}), 120);
  });
  typeSelect.addEventListener('change', updateCount);
  communitySelect?.addEventListener('change', () => updateQuestOptions('community'));
  questSelect?.addEventListener('change', () => updateQuestOptions('quest'));
  composer.addEventListener('submit', (event) => {
    if (words() > (limits[typeSelect.value] || limits.post)) { event.preventDefault(); updateCount(); return; }
    composer.classList.add('composer-hidden');
  });
  updateCount();
  updateQuestOptions('quest');
}

document.querySelectorAll('[data-chat-search-toggle]').forEach((toggle) => {
  const form = document.getElementById(toggle.getAttribute('aria-controls'));
  const closeButton = form?.querySelector('[data-chat-search-close]');
  if (!form) return;

  const close = (restoreFocus = true) => {
    form.hidden = true;
    toggle.setAttribute('aria-expanded', 'false');
    form.parentElement.querySelector('[data-message-search-results]')?.setAttribute('hidden', '');
    if (restoreFocus) toggle.focus();
  };
  toggle.addEventListener('click', () => {
    if (!form.hidden) {
      close();
      return;
    }
    form.hidden = false;
    toggle.setAttribute('aria-expanded', 'true');
    form.querySelector('input[type="search"]')?.focus();
  });
  closeButton?.addEventListener('click', () => close());
  form.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') close();
  });
});

document.querySelectorAll('[data-mention-input]').forEach((input) => {
  // The suggestion list lives in a wrapper around the input and floats over
  // whatever is below it. It is only ever in the page (and visible) while
  // there are real suggestions - no empty box, and it never squeezes the
  // input inside a flex row like the comment form.
  let wrap = input.parentElement?.classList.contains('mention-wrap') ? input.parentElement : null;
  if (!wrap) {
    wrap = document.createElement('div');
    wrap.className = 'mention-wrap';
    input.parentNode.insertBefore(wrap, input);
    wrap.append(input);
  }
  const menu = document.createElement('div');
  menu.className = 'mention-suggestions';
  menu.setAttribute('role', 'listbox');
  menu.hidden = true;
  wrap.append(menu);
  let timer;
  let requestId = 0;
  const close = () => { menu.hidden = true; menu.replaceChildren(); };
  input.addEventListener('keydown', (event) => { if (event.key === 'Escape' && !menu.hidden) { event.stopPropagation(); close(); } });
  input.addEventListener('input', () => {
    const before = input.value.slice(0, input.selectionStart);
    const match = before.match(/(?:^|\s)@([a-z0-9._-]*)$/i);
    if (!match || !match[1]) { clearTimeout(timer); requestId += 1; return close(); }
    clearTimeout(timer);
    const thisRequest = ++requestId;
    timer = setTimeout(() => fetch(`/users/suggest?q=${encodeURIComponent(match[1])}`).then((response) => response.json()).then((users) => {
      if (thisRequest !== requestId) return; // a newer keystroke superseded this answer
      if (!Array.isArray(users) || !users.length) return close();
      menu.replaceChildren(...users.map((user) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.setAttribute('role', 'option');
        const name = document.createElement('strong');
        name.textContent = user.name;
        const handle = document.createElement('span');
        handle.textContent = ` @${user.handle}`;
        button.append(name, handle);
        button.addEventListener('click', () => {
          const caret = input.selectionStart;
          const current = input.value.slice(0, caret);
          const tokenStart = current.lastIndexOf(`@${match[1]}`);
          input.focus();
          input.setSelectionRange(tokenStart, caret);
          input.setRangeText(`@${user.handle} `, tokenStart, caret, 'end');
          close();
        });
        return button;
      }));
      menu.hidden = false;
    }).catch(close), 120);
  });
  document.addEventListener('click', (event) => { if (event.target !== input && !menu.contains(event.target)) close(); });
});

document.querySelectorAll('.media-picker input[type="file"]').forEach((input) => {
  input.multiple = true;
  const label = input.closest('.media-picker');
  if (!label) return;

  label.classList.add('upload-dropzone');
  label.innerHTML = '';
  const icon = document.createElement('span');
  icon.className = 'upload-dropzone-icon';
  icon.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>';
  const copy = document.createElement('span');
  copy.className = 'upload-dropzone-copy';
  copy.innerHTML = '<strong>Drop media here</strong><small>or click to browse · paste with Ctrl+V</small>';
  const status = document.createElement('span');
  status.className = 'upload-status';
  const preview = document.createElement('div');
  preview.className = 'upload-preview';
  label.append(icon, copy, status, preview, input);

  const limits = { image: 1.5 * 1024 * 1024, video: 4 * 1024 * 1024, audio: 2 * 1024 * 1024 };
  const getKind = (file) => file.type.startsWith('image/') ? 'image' : file.type.startsWith('video/') ? 'video' : file.type.startsWith('audio/') ? 'audio' : null;
  const formatSize = (bytes) => bytes < 1024 * 1024 ? `${Math.ceil(bytes / 1024)}KB` : `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  const setStatus = (message, error = false) => {
    status.textContent = message;
    status.classList.toggle('upload-status-error', error);
  };
  const syncFiles = (files) => {
    const selected = Array.from(files);
    if (selected.length > 2) return setStatus('Choose up to 2 files.', true);
    const valid = [];
    for (const file of selected) {
      const kind = getKind(file);
      if (!kind) return setStatus(`${file.name} is not a supported image, video, or audio file.`, true);
      if (file.size >= limits[kind]) return setStatus(`${file.name} is too large (${formatSize(file.size)}).`, true);
      valid.push(file);
    }
    const transfer = new DataTransfer();
    valid.forEach((file) => transfer.items.add(file));
    input.files = transfer.files;
    preview.replaceChildren();
    valid.forEach((file, index) => {
      const kind = getKind(file);
      const item = document.createElement('div');
      item.className = 'upload-preview-item';
      const media = kind === 'image' ? document.createElement('img') : kind === 'video' ? document.createElement('video') : document.createElement('audio');
      media.src = URL.createObjectURL(file);
      media.setAttribute('aria-label', file.name);
      if (kind !== 'image') media.controls = true;
      if (kind === 'video') media.preload = 'metadata';
      const details = document.createElement('span');
      details.textContent = `${file.name} · ${formatSize(file.size)}`;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'upload-remove';
      remove.setAttribute('aria-label', `Remove ${file.name}`);
      remove.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
      remove.addEventListener('click', (event) => {
        event.preventDefault();
        syncFiles(valid.filter((_, fileIndex) => fileIndex !== index));
      });
      item.append(media, details, remove);
      preview.append(item);
    });
    setStatus(valid.length ? `${valid.length} file${valid.length === 1 ? '' : 's'} ready to upload.` : 'No media selected.');
    // Per-file details: only offer a second set of fields when a second file is attached.
    const secondDetails = input.closest('form')?.querySelector('[data-media-meta="2"]');
    if (secondDetails) secondDetails.hidden = valid.length < 2;
  };

  const initialSecond = input.closest('form')?.querySelector('[data-media-meta="2"]');
  if (initialSecond) initialSecond.hidden = true;
  input.addEventListener('change', () => syncFiles(input.files));
  ['dragenter', 'dragover'].forEach((eventName) => label.addEventListener(eventName, (event) => {
    event.preventDefault();
    label.classList.add('upload-dropzone-active');
  }));
  ['dragleave', 'drop'].forEach((eventName) => label.addEventListener(eventName, (event) => {
    event.preventDefault();
    label.classList.remove('upload-dropzone-active');
  }));
  label.addEventListener('drop', (event) => syncFiles(event.dataTransfer.files));
  const flashMessage = document.querySelector('.flash-error');
  if (flashMessage) setStatus(flashMessage.textContent.trim(), true);
  document.addEventListener('paste', (event) => {
    if (document.activeElement?.closest('#composer') && Array.from(event.clipboardData?.files || []).length) {
      event.preventDefault();
      syncFiles(event.clipboardData.files);
    }
  });
});

document.querySelectorAll('.post-card img').forEach((image) => {
  image.loading = 'lazy';
  image.decoding = 'async';
});

// Post cards: tap anywhere on the card (except its own controls) to open the post.
// Delegated, so cards added later by infinite scroll behave the same way.
const cardInteractiveSelector = 'form,button,a,input,select,textarea,video,audio,summary,details,label,.cw-player,.share-menu,.post-poll';
document.addEventListener('click', (event) => {
  // Only a plain primary click on the card's own surface opens the post. Links,
  // buttons, modified clicks (new tab) and clicks another handler already
  // dealt with must never be turned into a second navigation.
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  const card = event.target.closest('.post-card[data-post-url]');
  if (!card || event.target.closest(cardInteractiveSelector)) return;
  if (String(window.getSelection?.() || '').length) return; // don't hijack text selection
  window.location.href = card.dataset.postUrl;
});

// Long bodies are clamped in the feed; offer a "Read more" link only when text is really cut off.
// It runs once at start and again on window load (images and fonts change the
// height), so it must be idempotent: it reuses the link it already added
// instead of adding a second "Read more" every time.
const enhanceCards = (root = document) => {
  root.querySelectorAll('.post-card[data-post-url] .post-body').forEach((body) => {
    const existing = body.nextElementSibling?.classList.contains('post-read-more') ? body.nextElementSibling : null;
    const clipped = body.scrollHeight > body.clientHeight + 2;
    if (!clipped) { existing?.remove(); return; }
    if (existing) return;
    const more = document.createElement('a');
    more.className = 'post-read-more';
    more.href = body.closest('.post-card').dataset.postUrl;
    more.textContent = 'Read more';
    body.after(more);
  });
};
enhanceCards();
window.addEventListener('load', () => enhanceCards());

document.querySelectorAll('.post-card audio').forEach((media) => {
  media.addEventListener('contextmenu', (event) => event.preventDefault());
});

document.querySelectorAll('[data-drawer-open]').forEach((toggle) => {
  const header = toggle.closest('header');
  const drawer = (header?.nextElementSibling?.classList.contains('nav-drawer') ? header.nextElementSibling : null) || document.querySelector('.nav-drawer');
  if (!drawer) return;
  const focusable = () => Array.from(drawer.querySelectorAll('a[href], button:not([disabled]), input:not([disabled])'));
  const previousOverflow = document.body.style.overflow;
  const open = () => {
    if (drawer.classList.contains('is-open')) return;
    drawer.inert = false;
    drawer.setAttribute('aria-hidden', 'false');
    drawer.classList.add('is-open');
    toggle.setAttribute('aria-expanded', 'true');
    document.body.style.overflow = 'hidden';
    requestAnimationFrame(() => focusable()[0]?.focus());
  };
  const close = (restoreFocus = true) => {
    if (!drawer.classList.contains('is-open')) return;
    drawer.classList.remove('is-open');
    drawer.setAttribute('aria-hidden', 'true');
    drawer.inert = true;
    toggle.setAttribute('aria-expanded', 'false');
    document.body.style.overflow = previousOverflow;
    if (restoreFocus) toggle.focus();
  };
  toggle.addEventListener('click', open);
  drawer.querySelectorAll('[data-drawer-close]').forEach((el) => el.addEventListener('click', close));
  drawer.querySelectorAll('a').forEach((link) => link.addEventListener('click', () => close(false)));
  document.addEventListener('keydown', (event) => {
    if (!drawer.classList.contains('is-open')) return;
    if (event.key === 'Escape') {
      close();
      return;
    }
    if (event.key !== 'Tab') return;
    const items = focusable();
    const first = items[0];
    const last = items[items.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  });
});

// Sidebar behaviour (home page copy and site-wide rail): both start collapsed and, when opened, float OVER the
// page behind a dimmed backdrop. The page layout never changes, so the feed is never shifted or squeezed.
// Clicking the backdrop or pressing Escape closes it, and it always starts closed on the next page load.
document.querySelectorAll('[data-sidebar-toggle]').forEach((toggle) => {
  const layout = toggle.closest('.app-layout, .settings-layout');
  if (!layout) return;
  const scrim = document.querySelector('[data-sidebar-scrim]');
  const apply = (open) => {
    layout.classList.toggle('sidebar-collapsed', !open);
    toggle.setAttribute('aria-expanded', String(open));
    toggle.setAttribute('aria-label', open ? 'Close sidebar' : 'Open sidebar');
    // Only the home sidebar floats over the page (it has a backdrop); settings keeps its in-grid collapse.
    if (scrim) scrim.hidden = !open;
  };
  apply(!layout.classList.contains('sidebar-collapsed'));
  toggle.addEventListener('click', () => apply(layout.classList.contains('sidebar-collapsed')));
  scrim?.addEventListener('click', () => apply(false));
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && scrim && !layout.classList.contains('sidebar-collapsed')) { apply(false); toggle.focus(); }
  });
});

// Site-wide sidebar rail (every signed-in page except the home page, which has its own copy).
document.querySelectorAll('[data-rail-toggle]').forEach((toggle) => {
  const rail = toggle.closest('.app-rail');
  if (!rail) return;
  const scrim = document.querySelector('[data-rail-scrim]');
  const apply = (open) => {
    rail.classList.toggle('is-open', open);
    toggle.setAttribute('aria-expanded', String(open));
    toggle.setAttribute('aria-label', open ? 'Close sidebar' : 'Open sidebar');
    // The open rail always floats over the page, so it always gets a backdrop that closes it.
    if (scrim) scrim.hidden = !open;
  };
  apply(false);
  toggle.addEventListener('click', () => apply(!rail.classList.contains('is-open')));
  scrim?.addEventListener('click', () => apply(false));
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && rail.classList.contains('is-open')) { apply(false); toggle.focus(); }
  });

  // Name tooltips while the rail is collapsed (icons alone are hard to tell apart).
  const tip = document.createElement('div');
  tip.className = 'rail-tip';
  tip.setAttribute('role', 'presentation');
  document.body.appendChild(tip);
  const showTip = (target) => {
    if (rail.classList.contains('is-open')) return;
    const rect = target.getBoundingClientRect();
    tip.textContent = target.getAttribute('data-tip') || '';
    tip.style.left = `${rect.right + 12}px`;
    tip.style.top = `${rect.top + rect.height / 2 - 14}px`;
    tip.classList.add('is-on');
  };
  const hideTip = () => tip.classList.remove('is-on');
  rail.addEventListener('mouseover', (event) => { const t = event.target.closest('[data-tip]'); if (t) showTip(t); });
  rail.addEventListener('mouseout', (event) => { if (event.target.closest('[data-tip]')) hideTip(); });
  rail.addEventListener('focusin', (event) => { const t = event.target.closest('[data-tip]'); if (t) showTip(t); });
  rail.addEventListener('focusout', hideTip);
  rail.querySelector('.rail-scroll')?.addEventListener('scroll', hideTip, { passive: true });
  toggle.addEventListener('click', hideTip);
});

document.querySelectorAll('.settings-nav').forEach((sidebar) => {
  const layout = sidebar.closest('.settings-layout');
  if (!layout) return;
  const toggle = document.createElement('button');
  toggle.className = 'sidebar-toggle';
  toggle.type = 'button';
  toggle.setAttribute('aria-expanded', 'true');
  toggle.setAttribute('aria-label', 'Close sidebar');
  toggle.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 18 9 12 15 6"/></svg>';
  sidebar.prepend(toggle);
  toggle.addEventListener('click', () => {
    const collapsed = layout.classList.toggle('sidebar-collapsed');
    toggle.setAttribute('aria-expanded', String(!collapsed));
    toggle.setAttribute('aria-label', collapsed ? 'Open sidebar' : 'Close sidebar');
  });
});

if (window.axios) {
  // Same-origin on purpose: the configured APP_URL can differ from the address
  // people actually use (www vs bare domain), which turned this into a blocked
  // cross-origin request.
  const heartbeat = () => window.axios.get('/health').catch(() => {});
  heartbeat();
  window.setInterval(heartbeat, 13 * 60 * 1000);
}

const asyncInteractionSelector = '.post-actions form, .post-view-actions form, .follow-form, .block-form, .mute-form, [data-async-interaction]';
// Status line under a control ("Vote recorded.", or why a change was undone). Shared with optimistic.js.
const showInteractionMessage = (form, text, error = false) => window.cwOptimistic.notice(form, text, error);

// Drops a freshly posted comment (server-rendered HTML) into the thread.
const insertComment = (form, data) => {
  const thread = document.querySelector('.post-detail-thread');
  if (!thread || !data.html) return;
  const holder = document.createElement('div');
  holder.innerHTML = data.html;
  const comment = holder.firstElementChild;
  if (!comment) return;
  comment.classList.add('thread-comment-new');
  const parent = data.parent ? thread.querySelector(`[data-comment-id="${data.parent}"]`) : null;
  if (parent) {
    parent.append(comment);
    parent.querySelector(':scope > .thread-comment-actions > .thread-reply')?.removeAttribute('open');
  } else {
    thread.append(comment); // top-level comments read oldest-first, so the new one goes last
    comment.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
  document.querySelector('[data-no-comments]')?.setAttribute('hidden', '');
  if (data.commentsCount !== undefined) document.querySelectorAll('[data-comment-total]').forEach((el) => { el.textContent = data.commentsCount; });
};

// ---- Optimistic controls ---------------------------------------------------------------------------------------
// Each spec describes one kind of control: how to read its state from the page, what the state becomes after a
// tap, how to paint a state, and how to read the server's reply. cwOptimistic.run (public/js/optimistic.js)
// does the rest: instant update, in-order background requests, reconcile with the server, undo on failure.
const countOf = (el) => { const n = parseInt(String(el?.textContent || '').replace(/[^\d]/g, ''), 10); return Number.isFinite(n) ? n : 0; };
const submitButtonOf = (form) => form.querySelector('button[type="submit"]');

const optimisticSpecs = [
  { // like a post or a comment
    match: (form) => Boolean(form.querySelector('.action-like')),
    scope: (form) => form,
    read: (form) => { const button = form.querySelector('.action-like'); return { liked: button.classList.contains('is-liked'), likes: countOf(button.querySelector('.count')) }; },
    next: (state) => ({ liked: !state.liked, likes: Math.max(0, state.likes + (state.liked ? -1 : 1)) }),
    fromServer: (data, state) => (data.liked === undefined ? null : { liked: Boolean(data.liked), likes: Number.isFinite(Number(data.likes)) ? Number(data.likes) : state.likes }),
    write: (form, state, info) => {
      const button = form.querySelector('.action-like');
      // The heart is an SVG that CSS fills when .is-liked is set.
      button.classList.toggle('is-liked', state.liked);
      button.setAttribute('aria-pressed', String(state.liked));
      const likeCount = button.querySelector('.count');
      if (likeCount) likeCount.textContent = state.likes;
      if (info.optimistic && state.liked) { button.classList.remove('just-liked'); void button.offsetWidth; button.classList.add('just-liked'); }
      if (!form.classList.contains('comment-like-form')) document.querySelectorAll('[data-like-total]').forEach((el) => { el.textContent = state.likes; });
    }
  },
  { // save / unsave a post
    match: (form) => Boolean(form.querySelector('.action-save')),
    scope: (form) => form,
    read: (form) => ({ saved: form.querySelector('.action-save').classList.contains('is-saved') }),
    next: (state) => ({ saved: !state.saved }),
    fromServer: (data) => (data.bookmarked === undefined ? null : { saved: Boolean(data.bookmarked) }),
    write: (form, state) => {
      const button = form.querySelector('.action-save');
      button.classList.toggle('is-saved', state.saved);
      button.setAttribute('aria-pressed', String(state.saved));
      const label = button.querySelector('.label');
      if (label) label.textContent = state.saved ? 'Saved' : 'Save';
    }
  },
  { // follow / unfollow / cancel a follow request
    match: (form) => form.classList.contains('follow-form'),
    scope: (form) => form,
    read: (form) => {
      const button = submitButtonOf(form);
      const following = button.classList.contains('is-following');
      const requested = !following && button.textContent.trim() === 'Requested';
      // Remember what the idle label was ("Follow" or "Follow back") so unfollowing restores it exactly.
      if (!following && !requested) button.dataset.idleLabel = button.textContent.trim();
      const counter = document.querySelector(`.follower-count[data-user="${form.dataset.user}"]`);
      return { following, requested, followers: counter ? countOf(counter) : null };
    },
    next: (state, form) => {
      if (state.following || state.requested) return { following: false, requested: false, followers: state.followers === null ? null : Math.max(0, state.followers - (state.following ? 1 : 0)) };
      // A private profile turns a follow into a request; the server reply corrects it if we guessed wrong.
      if (form.dataset.private === 'true') return { following: false, requested: true, followers: state.followers };
      return { following: true, requested: false, followers: state.followers === null ? null : state.followers + 1 };
    },
    fromServer: (data, state) => (data.following === undefined ? null : { following: Boolean(data.following), requested: Boolean(data.requested), followers: data.followersCount ?? state.followers }),
    write: (form, state) => {
      const button = submitButtonOf(form);
      button.classList.toggle('is-following', state.following);
      button.textContent = state.following ? 'Following' : state.requested ? 'Requested' : (button.dataset.idleLabel || 'Follow');
      if (state.followers !== null) document.querySelectorAll(`.follower-count[data-user="${form.dataset.user}"]`).forEach((el) => { el.textContent = state.followers; });
    }
  },
  { // block / unblock
    match: (form) => form.classList.contains('block-form'),
    scope: (form) => form,
    read: (form) => ({ blocked: submitButtonOf(form).classList.contains('is-blocked') }),
    next: (state) => ({ blocked: !state.blocked }),
    fromServer: (data) => (data.blocked === undefined ? null : { blocked: Boolean(data.blocked) }),
    write: (form, state) => { const button = submitButtonOf(form); button.classList.toggle('is-blocked', state.blocked); button.textContent = state.blocked ? 'Blocked' : 'Block'; }
  },
  { // mute / unmute
    match: (form) => form.classList.contains('mute-form'),
    scope: (form) => form,
    read: (form) => ({ muted: submitButtonOf(form).classList.contains('is-muted') }),
    next: (state) => ({ muted: !state.muted }),
    fromServer: (data) => (data.muted === undefined ? null : { muted: Boolean(data.muted) }),
    write: (form, state) => { const button = submitButtonOf(form); button.classList.toggle('is-muted', state.muted); button.textContent = state.muted ? 'Unmute' : 'Mute'; }
  },
  { // the post author's "heart" on a comment
    match: (form) => form.classList.contains('comment-author-heart-form'),
    scope: (form) => form,
    read: (form) => ({ hearted: submitButtonOf(form).classList.contains('is-selected') }),
    next: (state) => ({ hearted: !state.hearted }),
    fromServer: (data) => (data.hearted === undefined ? null : { hearted: Boolean(data.hearted) }),
    write: (form, state) => {
      const button = submitButtonOf(form);
      button.classList.toggle('is-selected', state.hearted);
      button.setAttribute('aria-pressed', String(state.hearted));
      button.title = state.hearted ? 'Remove your heart' : 'Heart this comment as the post author';
      form.closest('.thread-comment')?.classList.toggle('is-hearted', state.hearted);
      const head = form.closest('article.thread-comment')?.querySelector(':scope > .thread-comment-head');
      let badge = head?.querySelector('.author-heart-badge');
      if (state.hearted && !badge && head) {
        badge = document.createElement('span');
        badge.className = 'author-heart-badge';
        badge.title = 'Hearted by the post author';
        badge.innerHTML = button.querySelector('svg')?.outerHTML || '';
        head.append(badge);
      } else if (!state.hearted && badge) badge.remove();
    }
  },
  { // Celebrate / Insightful / Support / Funny on a post: one choice at a time, tap again to remove
    match: (form) => Boolean(form.querySelector('[data-reaction]')) && Boolean(form.closest('.reaction-strip, .reaction-bar')),
    scope: (form) => form.closest('.reaction-strip, .reaction-bar'),
    read: (strip) => {
      const counts = {};
      let selected = null;
      strip.querySelectorAll('[data-reaction]').forEach((button) => {
        counts[button.dataset.reaction] = countOf(button.querySelector('.count'));
        if (button.classList.contains('is-selected')) selected = button.dataset.reaction;
      });
      return { selected, counts };
    },
    next: (state, form) => {
      const type = form.querySelector('[data-reaction]').dataset.reaction;
      const counts = { ...state.counts };
      if (state.selected === type) { counts[type] = Math.max(0, (counts[type] || 0) - 1); return { selected: null, counts }; }
      if (state.selected) counts[state.selected] = Math.max(0, (counts[state.selected] || 0) - 1);
      counts[type] = (counts[type] || 0) + 1;
      return { selected: type, counts };
    },
    fromServer: (data, state) => (data.reaction === undefined ? null : { selected: data.reaction || null, counts: data.counts || state.counts }),
    write: (strip, state) => {
      strip.querySelectorAll('[data-reaction]').forEach((button) => {
        const on = button.dataset.reaction === state.selected;
        button.classList.toggle('is-selected', on);
        button.setAttribute('aria-pressed', String(on));
        const count = button.querySelector('.count');
        if (count && state.counts[button.dataset.reaction] !== undefined) count.textContent = state.counts[button.dataset.reaction];
      });
    }
  },
  { // vote in a poll: one vote, no changing it afterwards
    match: (form) => Boolean(form.closest('.post-poll')) && form.querySelector('input[name="optionIndex"]'),
    scope: (form) => form.closest('.post-poll'),
    read: (poll) => {
      const buttons = [...poll.querySelectorAll('form button')];
      return { voted: buttons.some((button) => button.disabled || button.classList.contains('is-selected')), choice: buttons.findIndex((button) => button.classList.contains('is-selected')), counts: buttons.map((button) => countOf(button.querySelector('span'))) };
    },
    next: (state, form) => {
      if (state.voted) return null; // already voted: nothing to change, nothing to send
      const choice = Number(form.querySelector('input[name="optionIndex"]').value);
      const counts = state.counts.slice();
      counts[choice] = (counts[choice] || 0) + 1;
      return { voted: true, choice, counts };
    },
    fromServer: (data, state) => (data.voted === undefined ? null : (data.voted ? state : { voted: true, choice: -1, counts: state.counts.map((n, i) => (i === state.choice ? Math.max(0, n - 1) : n)) })),
    write: (poll, state) => {
      [...poll.querySelectorAll('form button')].forEach((button, index) => {
        button.disabled = state.voted;
        button.classList.toggle('is-selected', state.voted && index === state.choice);
        const span = button.querySelector('span');
        if (span && state.counts[index] !== undefined) span.textContent = state.counts[index];
      });
    }
  }
];

const csrfHeaders = () => ({ 'X-CSRF-Token': document.querySelector('meta[name="csrf-token"]')?.content, 'X-Requested-With': 'XMLHttpRequest' });

document.addEventListener('submit', async (event) => {
  const form = event.target.closest('form');
  if (!form || !form.matches(asyncInteractionSelector) || !window.axios) return;
  event.preventDefault();

  const spec = optimisticSpecs.find((candidate) => candidate.match(form));
  if (spec) {
    // Build the request body now: it must describe THIS tap even if the form changes before it is sent.
    const body = new URLSearchParams(new FormData(form));
    window.cwOptimistic.run(spec.scope(form), {
      read: spec.read,
      next: (state) => spec.next(state, form),
      write: spec.write,
      fromServer: spec.fromServer,
      anchor: form,
      request: async () => (await window.axios.post(form.action, body, { headers: csrfHeaders() })).data
    });
    return;
  }

  // Everything else (posting a comment, a reply post) creates something new, so it waits for the server's
  // copy of it and shows a disabled button meanwhile.
  if (form.dataset.pending === 'true') return;
  form.dataset.pending = 'true';
  const button = submitButtonOf(form);
  if (button) button.disabled = true;
  try {
    const response = await window.axios.post(form.action, new URLSearchParams(new FormData(form)), { headers: csrfHeaders() });
    const data = response.data;
    if (data.ok === false) return showInteractionMessage(form, data.error || 'Could not update right now.', true);
    if (data.html) {
      insertComment(form, data);
      form.reset();
      form.dispatchEvent(new CustomEvent('gif:clear', { bubbles: true }));
    }
    if (data.reply) {
      form.reset();
      showInteractionMessage(form, 'Reply published.');
    }
  } catch (error) {
    showInteractionMessage(form, window.cwOptimistic.describeError(error, 'Could not send that right now. Please try again.'), true);
  } finally {
    form.dataset.pending = 'false';
    if (button) button.disabled = false;
  }
});

const notificationBadge = document.querySelector('.notification-badge');
if (window.axios && notificationBadge) {
  const refreshNotifications = async () => {
    try {
      const { data } = await window.axios.get('/notifications/unread');
      notificationBadge.textContent = '';
      notificationBadge.classList.toggle('notification-dot-visible', Boolean(data.unread));
      notificationBadge.hidden = !data.unread;
      // The dot is only visual, so say it in words on the link itself (only the label changes: no announcement on every poll).
      notificationBadge.closest('a')?.setAttribute('aria-label', data.unread ? 'Notifications, you have new activity' : 'Notifications');
    } catch (error) {
      notificationBadge.hidden = true;
    }
  };
  refreshNotifications();
  window.setInterval(refreshNotifications, 60 * 1000);
}

document.querySelectorAll('form').forEach((form) => {
  if (form.method.toLowerCase() === 'post' && !form.querySelector('input[name="_csrf"]')) {
    const token = document.querySelector('meta[name="csrf-token"]')?.content;
    if (token) {
      const csrfInput = document.createElement('input');
      csrfInput.type = 'hidden';
      csrfInput.name = '_csrf';
      csrfInput.value = token;
      form.appendChild(csrfInput);
    }
  }
  form.addEventListener('submit', (event) => {
    // Wait a tick before disabling: a submit button that is disabled inside
    // its own submit event can lose its name/value (breaking "Save draft"),
    // and a submit that another handler cancelled (word limit, async
    // interaction) must not leave the button disabled.
    window.setTimeout(() => {
      if (event.defaultPrevented) return;
      const submit = event.submitter || form.querySelector('button[type="submit"]');
      if (submit) {
        submit.disabled = true;
        submit.style.opacity = '0.7';
      }
    }, 0);
  });
});

// Confirmation prompts (delete post/comment/user...). These used to be inline
// onsubmit="" attributes, which the site's Content-Security-Policy blocks, so
// the confirmation silently never appeared.
document.addEventListener('submit', (event) => {
  const message = event.target.closest?.('form[data-confirm]')?.dataset.confirm;
  if (message && !window.confirm(message)) {
    event.preventDefault();
    event.stopImmediatePropagation();
  }
}, true);

// Lazy-load / infinite scroll for the home feed. Pages come from the same
// ranked list as the first page (page number, not a date cursor), so a page
// never repeats or skips posts whichever tab is open.
const feedSentinel = document.getElementById('feed-sentinel');
if (feedSentinel && window.axios && 'IntersectionObserver' in window) {
  const feedList = document.getElementById('feed-posts');
  const endNote = document.getElementById('feed-end-note');
  let loading = false;
  let done = false;
  const finish = () => {
    done = true;
    observer.disconnect();
    if (endNote) endNote.style.display = 'block';
  };
  const observer = new IntersectionObserver((entries) => {
    if (!entries[0].isIntersecting || loading || done) return;
    loading = true;
    const nextPage = (Number(feedSentinel.dataset.page) || 1) + 1;
    const view = feedSentinel.dataset.feedView || 'for-you';
    window.axios.get(`/dashboard/feed/more?page=${nextPage}&view=${encodeURIComponent(view)}`)
      .then(({ data }) => {
        if (data.html) {
          const wrapper = document.createElement('div');
          wrapper.innerHTML = data.html;
          const existing = new Set(Array.from(feedList.querySelectorAll('.post-card')).map((card) => card.id));
          feedList.append(...Array.from(wrapper.children).filter((card) => !existing.has(card.id)));
          Array.from(wrapper.querySelectorAll('.post-card img')).forEach((img) => { img.loading = 'lazy'; img.decoding = 'async'; });
          initAvatars(feedList);
          enhanceCards(feedList);
        }
        feedSentinel.dataset.page = String(data.page || nextPage);
        if (data.done || !data.html) finish();
      })
      .catch(() => { done = true; observer.disconnect(); })
      .finally(() => { loading = false; });
  }, { rootMargin: '400px' });
  observer.observe(feedSentinel);
}


// "Copy" buttons next to a read-only field, e.g. the group invite link.
document.addEventListener('click', async (event) => {
  const shareButton = event.target.closest('[data-share-invite]');
  if (shareButton) {
    const status = shareButton.closest('.invite-share')?.querySelector('.invite-share-status');
    const url = shareButton.dataset.url;
    const title = shareButton.dataset.title || 'Join me on Crowdwide';
    if (!url) return;
    try {
      if (navigator.share) await navigator.share({ title, text: title, url });
      else {
        await navigator.clipboard.writeText(url);
        if (status) status.textContent = 'Invite link copied. Paste it into any app to share.';
      }
    } catch (error) {
      if (error.name !== 'AbortError' && status) status.textContent = 'Sharing was unavailable. Copy the invite link instead.';
    }
    return;
  }
  const button = event.target.closest('[data-copy-target]');
  if (!button) return;
  const field = document.querySelector(button.dataset.copyTarget);
  if (!field) return;
  const label = button.querySelector('span');
  try {
    await navigator.clipboard.writeText(field.value);
    if (label) { label.textContent = 'Copied'; window.setTimeout(() => { label.textContent = 'Copy'; }, 1600); }
  } catch (error) {
    field.select();
    if (label) label.textContent = 'Press Ctrl+C';
  }
});

// The "Comment" action on a post jumps to the comment box and focuses it.
document.addEventListener('click', (event) => {
  const link = event.target.closest('[data-focus-comment]');
  if (!link) return;
  event.preventDefault();
  const field = document.getElementById('comment-body');
  if (!field) return;
  field.scrollIntoView({ behavior: 'smooth', block: 'center' });
  field.focus({ preventScroll: true });
});

// Textareas grow with their content (up to a comfortable cap) instead of scrolling inside a tiny box.
(() => {
  const MAX_HEIGHT = Math.round(window.innerHeight * 0.7);
  const fit = (textarea) => {
    if (!textarea.isConnected || textarea.offsetParent === null) return;
    textarea.style.height = 'auto';
    const next = Math.min(textarea.scrollHeight + (textarea.offsetHeight - textarea.clientHeight), MAX_HEIGHT);
    textarea.style.height = `${next}px`;
    textarea.style.overflowY = textarea.scrollHeight > MAX_HEIGHT ? 'auto' : 'hidden';
  };
  const setup = (textarea) => {
    if (textarea.dataset.autosize === 'on' || textarea.hasAttribute('data-no-autosize')) return;
    textarea.dataset.autosize = 'on';
    textarea.style.resize = 'none';
    textarea.addEventListener('input', () => fit(textarea));
    textarea.addEventListener('focus', () => fit(textarea));
    textarea.form?.addEventListener('reset', () => window.setTimeout(() => fit(textarea), 0));
    fit(textarea);
  };
  const scan = (root = document) => root.querySelectorAll?.('textarea').forEach(setup);
  scan();
  window.addEventListener('resize', () => document.querySelectorAll('textarea[data-autosize="on"]').forEach(fit));
  window.addEventListener('load', () => document.querySelectorAll('textarea[data-autosize="on"]').forEach(fit));
  // Re-fit hidden textareas when their container is revealed (composer, reply boxes, <details>).
  new MutationObserver((records) => {
    records.forEach((record) => {
      if (record.type === 'childList') record.addedNodes.forEach((node) => { if (node.nodeType === 1) { if (node.matches('textarea')) setup(node); scan(node); } });
      else if (record.target.querySelectorAll) record.target.querySelectorAll('textarea[data-autosize="on"]').forEach(fit);
    });
  }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'hidden', 'open'] });
  document.addEventListener('toggle', (event) => event.target.querySelectorAll?.('textarea[data-autosize="on"]').forEach(fit), true);
  window.autosizeTextareas = () => document.querySelectorAll('textarea[data-autosize="on"]').forEach(fit);
})();

// Mobile bottom menu: "Post" opens the composer on the feed, or jumps to it from anywhere else.
(() => {
  const compose = document.querySelector('[data-bottom-compose]');
  const openFeedComposer = () => document.querySelector('[data-composer-open]');
  compose?.addEventListener('click', (event) => {
    const opener = openFeedComposer();
    if (opener && document.querySelector('#composer')) { event.preventDefault(); opener.click(); }
  });
  if (window.location.hash === '#composer') openFeedComposer()?.click();
})();

// Dismissible "earn Waves" tip for new members.
(() => {
  const tip = document.querySelector('[data-earn-tip]');
  if (!tip) return;
  let dismissed = false;
  try { dismissed = window.localStorage.getItem('cw-earn-tip') === '1'; } catch (error) { /* storage unavailable */ }
  tip.hidden = dismissed;
  tip.querySelector('[data-earn-tip-close]')?.addEventListener('click', () => {
    tip.hidden = true;
    try { window.localStorage.setItem('cw-earn-tip', '1'); } catch (error) { /* ignore */ }
  });
})();


document.querySelectorAll('[data-welcome-back-close]').forEach((button) => button.addEventListener('click', () => button.closest('.welcome-back-card')?.remove()));

// "Copy link" buttons (e.g. on the weekly top page).
document.querySelectorAll('[data-copy-link]').forEach((button) => button.addEventListener('click', async () => {
  const label = button.querySelector('span');
  const url = button.dataset.copyLink;
  try {
    await navigator.clipboard.writeText(url);
    if (label) { const original = label.textContent; label.textContent = 'Link copied'; setTimeout(() => { label.textContent = original; }, 2000); }
  } catch (error) {
    window.prompt('Copy this link', url);
  }
}));
