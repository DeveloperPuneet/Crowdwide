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
document.querySelectorAll('.post-card video, .post-card audio').forEach((media) => {
  media.preload = 'none';
});

const sidebarToggle = document.querySelector('.sidebar-toggle');
const appLayout = document.querySelector('.app-layout');
if (sidebarToggle && appLayout) {
  const collapsed = localStorage.getItem('crowdwide-sidebar-collapsed') === 'true';
  appLayout.classList.toggle('sidebar-collapsed', collapsed);
  sidebarToggle.setAttribute('aria-expanded', String(!collapsed));
  sidebarToggle.textContent = collapsed ? '›' : '‹';
  sidebarToggle.addEventListener('click', () => {
    const next = !appLayout.classList.contains('sidebar-collapsed');
    appLayout.classList.toggle('sidebar-collapsed', next);
    localStorage.setItem('crowdwide-sidebar-collapsed', String(next));
    sidebarToggle.setAttribute('aria-expanded', String(!next));
    sidebarToggle.textContent = next ? '›' : '‹';
  });
}

if (window.axios) {
  const appUrl = document.querySelector('meta[name="app-url"]')?.content || window.location.origin;
  const heartbeat = () => window.axios.get(`${appUrl.replace(/\/$/, '')}/health`).catch(() => {});
  heartbeat();
  window.setInterval(heartbeat, 13 * 60 * 1000);
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
