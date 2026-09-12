window.addEventListener('load', () => document.body.classList.add('page-ready'));

const composer = document.querySelector('#composer');
if (composer) {
  const textarea = composer.querySelector('textarea[name="body"]');
  const typeSelect = composer.querySelector('select[name="type"]');
  const count = composer.querySelector('[data-word-count]');
  const suggestions = composer.querySelector('[data-hashtag-suggestions]');
  const limits = JSON.parse(composer.dataset.wordLimits || '{"post":120,"article":550}');
  const words = () => textarea.value.trim() ? textarea.value.trim().split(/\s+/).length : 0;
  const updateCount = () => {
    const limit = limits[typeSelect.value] || limits.post;
    const total = words();
    count.textContent = `${total} / ${limit} words`;
    count.classList.toggle('word-limit-warning', total > limit);
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
  composer.addEventListener('submit', (event) => { if (words() > (limits[typeSelect.value] || limits.post)) { event.preventDefault(); updateCount(); } });
  updateCount();
}

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

document.querySelectorAll('.post-actions form, .follow-form, .block-form').forEach((form) => {
  form.addEventListener('submit', async (event) => {
    if (!window.axios) return;
    event.preventDefault();
    const button = form.querySelector('button');
    if (button) button.disabled = true;
    try {
      const response = await window.axios.post(form.action, new URLSearchParams(new FormData(form)), { headers: { 'X-CSRF-Token': document.querySelector('meta[name="csrf-token"]')?.content, 'X-Requested-With': 'XMLHttpRequest' } });
      if (response.data.liked !== undefined) {
        button.innerHTML = `${response.data.liked ? '♥' : '♡'} ${response.data.likes}`;
      }
      if (response.data.bookmarked !== undefined) button.textContent = response.data.bookmarked ? '▣ Saved' : '▱ Save';
      if (response.data.shares !== undefined) button.textContent = `↗ Share ${response.data.shares}`;
      if (response.data.following !== undefined) {
        button.classList.toggle('is-following', response.data.following);
        button.textContent = response.data.following ? 'Following' : 'Follow';
        document.querySelectorAll(`.follower-count[data-user="${form.dataset.user}"]`).forEach((el) => { el.textContent = response.data.followersCount; });
      }
      if (response.data.blocked !== undefined) {
        button.classList.toggle('is-blocked', response.data.blocked);
        button.textContent = response.data.blocked ? 'Blocked' : 'Block';
      }
    } catch (error) {
      const message = document.createElement('span');
      message.className = 'interaction-error';
      message.textContent = 'Could not update right now.';
      form.after(message);
    } finally {
      if (button) button.disabled = false;
    }
  });
});

const notificationBadge = document.querySelector('.notification-badge');
if (window.axios && notificationBadge) {
  const refreshNotifications = async () => {
    try {
      const { data } = await window.axios.get('/notifications/unread');
      notificationBadge.textContent = data.unread > 99 ? '99+' : data.unread;
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
    window.axios.get(`/dashboard/feed/more?before=${encodeURIComponent(cursor)}&feed=${mode}`)
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
