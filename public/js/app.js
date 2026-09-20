// Reveal the page as soon as the HTML is ready. Waiting for the window "load"
// event meant a slow font, CDN script or large image kept the loading screen
// up (and the site feeling stuck) long after the content was usable.
const markPageReady = () => document.body.classList.add('page-ready');
markPageReady();
window.addEventListener('load', markPageReady);

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
  const typeSelect = composer.querySelector('select[name="type"]');
  const count = composer.querySelector('[data-word-count]');
  const progress = composer.querySelector('.word-limit-meter');
  const progressFill = composer.querySelector('[data-word-progress]');
  const suggestions = composer.querySelector('[data-hashtag-suggestions]');
  const pollFields = composer.querySelector('.poll-composer');
  const limits = JSON.parse(composer.dataset.wordLimits || '{"post":120,"article":550,"poll":120}');
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
  const renderSuggestions = (items) => {
    suggestions.replaceChildren(...items.map(({ tag }) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = `#${tag}`;
      button.addEventListener('click', () => { textarea.value += `${textarea.value && !/\s$/.test(textarea.value) ? ' ' : ''}#${tag} `; suggestions.replaceChildren(); updateCount(); textarea.focus(); });
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
  composer.addEventListener('submit', (event) => {
    if (words() > (limits[typeSelect.value] || limits.post)) { event.preventDefault(); updateCount(); return; }
    composer.classList.add('composer-hidden');
  });
  updateCount();
}

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
  };

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
  const open = () => { drawer.classList.add('is-open'); toggle.setAttribute('aria-expanded', 'true'); document.body.style.overflow = 'hidden'; };
  const close = () => { drawer.classList.remove('is-open'); toggle.setAttribute('aria-expanded', 'false'); document.body.style.overflow = ''; };
  toggle.addEventListener('click', open);
  drawer.querySelectorAll('[data-drawer-close]').forEach((el) => el.addEventListener('click', close));
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape') close(); });
});

document.querySelectorAll('[data-sidebar-toggle]').forEach((toggle) => {
  const layout = toggle.closest('.app-layout, .settings-layout');
  if (!layout) return;
  toggle.addEventListener('click', () => {
    const collapsed = layout.classList.toggle('sidebar-collapsed');
    toggle.setAttribute('aria-expanded', String(!collapsed));
    toggle.setAttribute('aria-label', collapsed ? 'Open sidebar' : 'Close sidebar');
  });
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
const showInteractionMessage = (form, text, error = false) => {
  form.parentElement.querySelector('.interaction-message')?.remove();
  const message = document.createElement('span');
  message.className = `interaction-message${error ? ' interaction-error' : ''}`;
  message.textContent = text;
  form.after(message);
  if (!error) window.setTimeout(() => message.remove(), 2200);
};

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

document.addEventListener('submit', async (event) => {
  const form = event.target.closest('form');
  if (!form || !form.matches(asyncInteractionSelector) || !window.axios) return;
  event.preventDefault();
  if (form.dataset.pending === 'true') return;
  form.dataset.pending = 'true';
  const button = form.querySelector('button[type="submit"]');
  if (button) button.disabled = true;
  try {
    const response = await window.axios.post(form.action, new URLSearchParams(new FormData(form)), { headers: { 'X-CSRF-Token': document.querySelector('meta[name="csrf-token"]')?.content, 'X-Requested-With': 'XMLHttpRequest' } });
    const data = response.data;
    if (data.ok === false) return showInteractionMessage(form, data.error || 'Could not update right now.', true);
    if (data.liked !== undefined) {
      // The heart is an SVG that CSS fills when .is-liked is set.
      button.classList.toggle('is-liked', Boolean(data.liked));
      button.setAttribute('aria-pressed', String(Boolean(data.liked)));
      const likeCount = button.querySelector('.count');
      if (likeCount) likeCount.textContent = data.likes;
      if (data.liked) { button.classList.remove('just-liked'); void button.offsetWidth; button.classList.add('just-liked'); }
      if (!form.classList.contains('comment-like-form')) document.querySelectorAll('[data-like-total]').forEach((el) => { el.textContent = data.likes; });
    }
    if (data.bookmarked !== undefined) {
      button.classList.toggle('is-saved', Boolean(data.bookmarked));
      button.setAttribute('aria-pressed', String(Boolean(data.bookmarked)));
      const saveLabel = button.querySelector('.label');
      if (saveLabel) saveLabel.textContent = data.bookmarked ? 'Saved' : 'Save';
    }
    if (data.following !== undefined) {
      button.classList.toggle('is-following', data.following);
      button.textContent = data.following ? 'Following' : 'Follow';
      document.querySelectorAll(`.follower-count[data-user="${form.dataset.user}"]`).forEach((el) => { el.textContent = data.followersCount; });
    }
    if (data.blocked !== undefined) {
      button.classList.toggle('is-blocked', data.blocked);
      button.textContent = data.blocked ? 'Blocked' : 'Block';
    }
    if (data.muted !== undefined) {
      button.classList.toggle('is-muted', data.muted);
      button.textContent = data.muted ? 'Unmute' : 'Mute';
    }
    if (data.voted !== undefined) {
      form.closest('.post-poll')?.querySelectorAll('button').forEach((option) => { option.disabled = true; });
      button.classList.add('is-selected');
      showInteractionMessage(form, data.voted ? 'Vote recorded.' : 'You already voted.');
    }
    if (data.reaction !== undefined) {
      const reactionBar = form.closest('.reaction-bar');
      reactionBar?.querySelectorAll('button').forEach((reactionButton) => reactionButton.classList.remove('is-selected'));
      if (data.reaction) button.classList.add('is-selected');
      if (data.counts) reactionBar?.querySelectorAll('[data-reaction]').forEach((reactionButton) => {
        const count = reactionButton.querySelector('.count');
        if (count) count.textContent = data.counts[reactionButton.dataset.reaction] ?? count.textContent;
      });
    }
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
    showInteractionMessage(form, 'Could not update right now.', true);
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
