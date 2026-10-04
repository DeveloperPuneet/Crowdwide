(function () {
  'use strict';

  var dialog;
  var content;
  var lastTrigger;

  function getDialog() {
    if (dialog) return dialog;

    dialog = document.createElement('dialog');
    dialog.className = 'media-viewer';
    dialog.setAttribute('aria-label', 'Media viewer');
    dialog.innerHTML = '<button class="media-viewer-close" type="button" aria-label="Close media viewer">&times;</button><div class="media-viewer-content"></div>';
    content = dialog.querySelector('.media-viewer-content');
    dialog.querySelector('.media-viewer-close').addEventListener('click', function () {
      dialog.close();
    });
    dialog.addEventListener('click', function (event) {
      if (event.target === dialog) dialog.close();
    });
    dialog.addEventListener('close', function () {
      content.replaceChildren();
      document.body.classList.remove('media-viewer-open');
      if (lastTrigger && lastTrigger.isConnected) lastTrigger.focus();
      lastTrigger = null;
    });
    document.body.appendChild(dialog);
    return dialog;
  }

  function openViewer(trigger, kind, source, alt) {
    if (!source) return;
    var viewer = getDialog();
    if (viewer.open) viewer.close();
    lastTrigger = trigger;
    content.replaceChildren();

    var media = document.createElement(kind);
    media.src = source;
    if (kind === 'img') {
      media.alt = alt || 'Expanded post image';
    } else {
      media.controls = true;
      media.playsInline = true;
      media.preload = 'metadata';
      media.setAttribute('aria-label', 'Expanded post video');
    }
    content.appendChild(media);
    document.body.classList.add('media-viewer-open');
    viewer.showModal();
    viewer.querySelector('.media-viewer-close').focus();
  }

  document.addEventListener('click', function (event) {
    var target = event.target;
    if (!(target instanceof Element)) return;

    var expandButton = target.closest('[data-media-viewer-trigger]');
    if (expandButton) {
      event.preventDefault();
      event.stopPropagation();
      var video = expandButton.closest('.media-viewer-trigger-wrap, .media-box')?.querySelector('video');
      if (video) openViewer(expandButton, 'video', video.dataset.mediaSrc || video.currentSrc || video.src, '');
      return;
    }

    var media = target.closest('[data-media-viewer]');
    if (!media) return;
    event.preventDefault();
    event.stopPropagation();
    openViewer(media, media.tagName.toLowerCase() === 'video' ? 'video' : 'img', media.dataset.mediaSrc, media.alt);
  }, true);

  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && dialog?.open) dialog.close();

    var target = event.target;
    if (!(target instanceof HTMLImageElement) || !target.matches('[data-media-viewer]')) return;
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    openViewer(target, 'img', target.dataset.mediaSrc, target.alt);
  });
})();
