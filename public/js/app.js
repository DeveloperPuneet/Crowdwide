window.addEventListener('load', () => document.body.classList.add('page-ready'));

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
  openComposer?.addEventListener('click', () => {
    const isOpening = composer.classList.toggle('composer-hidden') === false;
    openComposer.setAttribute('aria-expanded', String(isOpening));
    if (!isOpening) return;
    composer.scrollIntoView({ behavior: 'smooth', block: 'center' });
    composer.querySelector('textarea')?.focus();
  });
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
  const menu = document.createElement('div');
  menu.className = 'mention-suggestions';
  menu.hidden = true;
  input.insertAdjacentElement('afterend', menu);
  let timer;
  const close = () => { menu.hidden = true; menu.replaceChildren(); };
  input.addEventListener('input', () => {
    const before = input.value.slice(0, input.selectionStart);
    const match = before.match(/(?:^|\s)@([a-z0-9._-]*)$/i);
    if (!match || !match[1]) return close();
    clearTimeout(timer);
    timer = setTimeout(() => fetch(`/users/suggest?q=${encodeURIComponent(match[1])}`).then((response) => response.json()).then((users) => {
      menu.replaceChildren(...users.map((user) => {
        const button = document.createElement('button');
        button.type = 'button';
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
      menu.hidden = !users.length;
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
  icon.textContent = '↑';
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
      remove.textContent = '×';
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

document.querySelectorAll('.feed-column .post-card').forEach((postCard) => {
  const postId = postCard.id.replace('post-', '');
  if (!postId) return;
  const openLink = document.createElement('a');
  openLink.className = 'post-open-link';
  openLink.href = `/posts/${postId}`;
  openLink.textContent = 'Open post and comments →';
  const actions = postCard.querySelector('.post-actions');
  if (actions) actions.before(openLink);
  postCard.addEventListener('click', (event) => {
    if (event.target.closest('form,button,a,input,select,textarea,video,audio')) return;
    window.location.href = openLink.href;
  });
});

document.querySelectorAll('.post-card video, .post-card audio').forEach((media) => {
  media.preload = 'none';
  media.addEventListener('contextmenu', (event) => event.preventDefault());
  media.setAttribute('controlsList', 'nodownload');
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
    toggle.textContent = collapsed ? '›' : '×';
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
  toggle.textContent = '×';
  sidebar.prepend(toggle);
  toggle.addEventListener('click', () => {
    const collapsed = layout.classList.toggle('sidebar-collapsed');
    toggle.setAttribute('aria-expanded', String(!collapsed));
    toggle.setAttribute('aria-label', collapsed ? 'Open sidebar' : 'Close sidebar');
    toggle.textContent = collapsed ? '›' : '×';
  });
});

if (window.axios) {
  const appUrl = document.querySelector('meta[name="app-url"]')?.content || window.location.origin;
  const heartbeat = () => window.axios.get(`${appUrl.replace(/\/$/, '')}/health`).catch(() => {});
  heartbeat();
  window.setInterval(heartbeat, 13 * 60 * 1000);
}

const closeShareMenus = (except) => {
  document.querySelectorAll('.share-menu.is-open').forEach((menu) => {
    if (menu !== except) menu.classList.remove('is-open');
  });
};

const showShareMenu = (form, url) => {
  let menu = form.querySelector('.share-menu');
  if (!menu) {
    menu = document.createElement('div');
    menu.className = 'share-menu';
    menu.innerHTML = '<button type="button" data-share-action="native">Share...</button><button type="button" data-share-action="copy">Copy link</button><a data-share-action="x" target="_blank" rel="noopener noreferrer">Post to X</a><a data-share-action="whatsapp" target="_blank" rel="noopener noreferrer">Send on WhatsApp</a>';
    form.append(menu);
    menu.addEventListener('click', async (event) => {
      const action = event.target.closest('[data-share-action]')?.dataset.shareAction;
      if (!action) return;
      if (action === 'native' && navigator.share) {
        try { await navigator.share({ title: document.title, url }); } catch (error) { if (error.name !== 'AbortError') event.target.textContent = 'Sharing unavailable'; }
      }
      if (action === 'copy') {
        try {
          await navigator.clipboard.writeText(url);
          event.target.textContent = 'Link copied';
          window.setTimeout(() => { event.target.textContent = 'Copy link'; }, 1600);
        } catch (error) { event.target.textContent = 'Copy failed'; }
      }
      if (action === 'x') window.open(`https://x.com/intent/post?url=${encodeURIComponent(url)}`, '_blank', 'noopener,noreferrer');
      if (action === 'whatsapp') window.open(`https://wa.me/?text=${encodeURIComponent(url)}`, '_blank', 'noopener,noreferrer');
      if (action !== 'copy') closeShareMenus(menu);
    });
  }
  menu.querySelector('[data-share-action="native"]').hidden = !navigator.share;
  menu.querySelector('[data-share-action="x"]').href = `https://x.com/intent/post?url=${encodeURIComponent(url)}`;
  menu.querySelector('[data-share-action="whatsapp"]').href = `https://wa.me/?text=${encodeURIComponent(url)}`;
  closeShareMenus(menu);
  menu.classList.toggle('is-open');
};

document.addEventListener('click', (event) => {
  if (!event.target.closest('.share-form')) closeShareMenus();
});

const asyncInteractionSelector = '.post-actions form, .follow-form, .block-form, .mute-form, [data-async-interaction]';
const showInteractionMessage = (form, text, error = false) => {
  form.parentElement.querySelector('.interaction-message')?.remove();
  const message = document.createElement('span');
  message.className = `interaction-message${error ? ' interaction-error' : ''}`;
  message.textContent = text;
  form.after(message);
  if (!error) window.setTimeout(() => message.remove(), 2200);
};

const appendComment = (form, body) => {
  const thread = document.querySelector('.post-detail-thread');
  if (!thread) return;
  const parentId = form.querySelector('input[name="parent"]')?.value;
  const parent = parentId ? thread.querySelector(`[data-comment-id="${parentId}"]`) : null;
  const comment = document.createElement('article');
  comment.className = 'thread-comment thread-comment-new';
  comment.dataset.depth = parent ? '1' : '0';
  const text = document.createElement('p');
  text.textContent = body;
  const time = document.createElement('time');
  time.textContent = 'Just now';
  comment.append(text, time);
  (parent || thread).append(comment);
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
    if (data.liked !== undefined && form.classList.contains('comment-like-form')) button.textContent = `${data.liked ? '♥' : '♡'} ${data.likes}`;
    else if (data.liked !== undefined) button.textContent = `${data.liked ? '♥' : '♡'} ${data.likes}`;
    if (data.bookmarked !== undefined) button.textContent = data.bookmarked ? '▣ Saved' : '▱ Save';
    if (data.shares !== undefined) {
      button.textContent = '↗ Share';
      if (data.url) showShareMenu(form, data.url);
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
    }
    if (data.comment) {
      appendComment(form, data.comment.body);
      form.reset();
      showInteractionMessage(form, 'Comment posted.');
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
  form.addEventListener('submit', () => {
    const submit = form.querySelector('button[type="submit"]');
    if (submit) {
      submit.disabled = true;
      submit.style.opacity = '0.7';
    }
  });
});

// Lazy-load / infinite scroll for the home feed.
const feedSentinel = document.getElementById('feed-sentinel');
if (feedSentinel && window.axios && 'IntersectionObserver' in window) {
  const feedList = document.getElementById('feed-posts');
  const endNote = document.getElementById('feed-end-note');
  let loading = false;
  let done = false;
  const observer = new IntersectionObserver((entries) => {
    if (!entries[0].isIntersecting || loading || done) return;
    loading = true;
    const cursor = feedSentinel.dataset.cursor;
    const mode = feedSentinel.dataset.feedMode;
    const view = feedSentinel.dataset.feedView;
    window.axios.get(`/dashboard/feed/more?before=${encodeURIComponent(cursor)}&feed=${mode}&view=${encodeURIComponent(view || '')}`)
      .then(({ data }) => {
        if (data.html) {
          const wrapper = document.createElement('div');
          wrapper.innerHTML = data.html;
          const existing = new Set(Array.from(feedList.querySelectorAll('.post-card')).map((card) => card.id));
          feedList.append(...Array.from(wrapper.children).filter((card) => !existing.has(card.id)));
          Array.from(wrapper.querySelectorAll('.post-card img')).forEach((img) => { img.loading = 'lazy'; img.decoding = 'async'; });
        }
        if (data.cursor) feedSentinel.dataset.cursor = data.cursor;
        if (data.done || !data.html) {
          done = true;
          observer.disconnect();
          if (endNote) endNote.style.display = 'block';
        }
      })
      .catch(() => { done = true; observer.disconnect(); })
      .finally(() => { loading = false; });
  }, { rootMargin: '400px' });
  observer.observe(feedSentinel);
}
