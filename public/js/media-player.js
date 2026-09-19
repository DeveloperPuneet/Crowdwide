/* Crowdwide custom media player
 * Progressively enhances every <video>/<audio> inside .post-media-frame
 * (feed posts, post detail, profile) into a themed player with custom
 * controls. Falls back to native controls if JS fails or the browser
 * lacks a feature.
 */
(function () {
  'use strict';

  var ICONS = {
    play: '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>',
    pause: '<svg viewBox="0 0 24 24"><path d="M7 5h4v14H7zm6 0h4v14h-4z"/></svg>',
    volume: '<svg viewBox="0 0 24 24"><path d="M4 9v6h4l5 5V4L8 9H4zm11.5 3a4.5 4.5 0 0 0-2.5-4.03v8.06A4.5 4.5 0 0 0 15.5 12z"/></svg>',
    muted: '<svg viewBox="0 0 24 24"><path d="M4 9v6h4l5 5V4L8 9H4zm14.6 3l2.9-2.9-1.4-1.4L17.2 10.6l-2.9-2.9-1.4 1.4 2.9 2.9-2.9 2.9 1.4 1.4 2.9-2.9 2.9 2.9 1.4-1.4z"/></svg>',
    fullscreen: '<svg viewBox="0 0 24 24"><path d="M4 9h2V6a1 1 0 0 1 1-1h3V3H7a3 3 0 0 0-3 3zm0 6v3a3 3 0 0 0 3 3h3v-2H7a1 1 0 0 1-1-1v-3zm16-6V7a3 3 0 0 0-3-3h-3v2h3a1 1 0 0 1 1 1v3zm0 6h-2v3a1 1 0 0 1-1 1h-3v2h3a3 3 0 0 0 3-3z"/></svg>',
    note: '<svg viewBox="0 0 24 24"><path d="M9 17V5l11-2v12M9 17a3 3 0 1 1-3-3 3 3 0 0 1 3 3zm11-2a3 3 0 1 1-3-3 3 3 0 0 1 3 3z"/></svg>'
  };
  var SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];

  function fmtTime(sec) {
    if (!isFinite(sec) || sec < 0) sec = 0;
    var m = Math.floor(sec / 60);
    var s = Math.floor(sec % 60);
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  function enhance(media) {
    if (!media || media.dataset.cwEnhanced) return;
    var kind = media.tagName.toLowerCase(); // 'video' | 'audio'
    media.dataset.cwEnhanced = '1';
    media.removeAttribute('controls');
    media.setAttribute('playsinline', '');

    var frame = media.closest('.post-media-frame') || media.parentElement;
    var player = document.createElement('div');
    player.className = 'cw-player cw-player--' + kind;

    if (kind === 'audio') {
      var face = document.createElement('div');
      face.className = 'cw-audio-face';
      face.innerHTML =
        '<div class="cw-audio-icon">' + ICONS.note + '</div>' +
        '<div class="cw-audio-meta">Audio clip<small class="cw-time-total">--:--</small></div>';
      player.appendChild(face);
    }

    media.parentNode.insertBefore(player, media);
    player.appendChild(media);

    var centerBtn, spinner;
    if (kind === 'video') {
      centerBtn = document.createElement('button');
      centerBtn.type = 'button';
      centerBtn.className = 'cw-center-btn';
      centerBtn.setAttribute('aria-label', 'Play');
      centerBtn.innerHTML = '<span class="cw-center-disc">' + ICONS.play + '</span>';
      player.appendChild(centerBtn);

      spinner = document.createElement('div');
      spinner.className = 'cw-spinner';
      spinner.innerHTML = '<span></span>';
      player.appendChild(spinner);
    }

    var controls = document.createElement('div');
    controls.className = 'cw-controls';

    var playBtn = document.createElement('button');
    playBtn.type = 'button';
    playBtn.className = 'cw-btn cw-play';
    playBtn.setAttribute('aria-label', 'Play');
    playBtn.innerHTML = ICONS.play;

    var seek = document.createElement('div');
    seek.className = 'cw-seek';
    seek.setAttribute('role', 'slider');
    seek.setAttribute('aria-label', 'Seek');
    seek.setAttribute('tabindex', '0');
    seek.innerHTML =
      '<div class="cw-seek-track">' +
        '<div class="cw-seek-buffered"></div>' +
        '<div class="cw-seek-fill"></div>' +
        '<div class="cw-seek-handle"></div>' +
      '</div>';

    var time = document.createElement('div');
    time.className = 'cw-time';
    time.textContent = '0:00 / 0:00';

    var volume = document.createElement('div');
    volume.className = 'cw-volume';
    volume.innerHTML =
      '<button type="button" class="cw-btn cw-mute" aria-label="Mute">' + ICONS.volume + '</button>' +
      '<div class="cw-volume-track"><input type="range" class="cw-volume-range" min="0" max="1" step="0.05" value="1" aria-label="Volume"></div>';

    var speed = document.createElement('div');
    speed.className = 'cw-speed';
    speed.innerHTML =
      '<button type="button" class="cw-btn cw-speed-btn" aria-label="Playback speed">1x</button>' +
      '<div class="cw-speed-menu">' + SPEEDS.map(function (s) {
        return '<button type="button" data-speed="' + s + '"' + (s === 1 ? ' class="is-active"' : '') + '>' + s + 'x</button>';
      }).join('') + '</div>';

    controls.appendChild(playBtn);
    controls.appendChild(seek);
    controls.appendChild(time);
    controls.appendChild(volume);
    controls.appendChild(speed);

    if (kind === 'video') {
      var fsBtn = document.createElement('button');
      fsBtn.type = 'button';
      fsBtn.className = 'cw-btn cw-fullscreen';
      fsBtn.setAttribute('aria-label', 'Fullscreen');
      fsBtn.innerHTML = ICONS.fullscreen;
      controls.appendChild(fsBtn);
    }

    player.appendChild(controls);

    // ---- behaviour ----
    function setPlayIcon(playing) {
      playBtn.innerHTML = playing ? ICONS.pause : ICONS.play;
      playBtn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
      if (centerBtn) centerBtn.querySelector('.cw-center-disc').innerHTML = playing ? ICONS.pause : ICONS.play;
      player.classList.toggle('is-playing', playing);
    }

    function togglePlay() {
      if (media.paused) {
        // pause any other Crowdwide player before playing this one
        document.querySelectorAll('audio[data-cw-enhanced], video[data-cw-enhanced]').forEach(function (other) {
          if (other !== media && !other.paused) other.pause();
        });
        var p = media.play();
        if (p && p.catch) p.catch(function () {});
      } else {
        media.pause();
      }
    }

    playBtn.addEventListener('click', togglePlay);
    if (centerBtn) centerBtn.addEventListener('click', togglePlay);
    if (kind === 'video') {
      media.addEventListener('click', togglePlay);
    }

    media.addEventListener('play', function () { setPlayIcon(true); });
    media.addEventListener('pause', function () { setPlayIcon(false); });
    media.addEventListener('waiting', function () { player.classList.add('is-buffering'); });
    media.addEventListener('playing', function () { player.classList.remove('is-buffering'); });

    var fill = seek.querySelector('.cw-seek-fill');
    var handle = seek.querySelector('.cw-seek-handle');
    var bufferedEl = seek.querySelector('.cw-seek-buffered');
    var dragging = false;

    function updateProgress() {
      if (!media.duration || dragging) return;
      var pct = (media.currentTime / media.duration) * 100;
      fill.style.width = pct + '%';
      handle.style.left = pct + '%';
      time.textContent = fmtTime(media.currentTime) + ' / ' + fmtTime(media.duration);
    }

    function updateBuffered() {
      if (!media.duration || !media.buffered.length) return;
      var end = media.buffered.end(media.buffered.length - 1);
      bufferedEl.style.width = Math.min(100, (end / media.duration) * 100) + '%';
    }

    media.addEventListener('timeupdate', updateProgress);
    media.addEventListener('progress', updateBuffered);
    media.addEventListener('loadedmetadata', function () {
      time.textContent = fmtTime(0) + ' / ' + fmtTime(media.duration);
      var totalLabel = player.querySelector('.cw-time-total');
      if (totalLabel) totalLabel.textContent = fmtTime(media.duration);
    });
    media.addEventListener('ended', function () { setPlayIcon(false); fill.style.width = '0%'; handle.style.left = '0%'; });

    // Keep each video's real proportions. The frame starts at 16:9 (so the
    // layout doesn't jump around) and switches to the clip's own ratio as soon
    // as the browser knows it - portrait phone clips, square clips and
    // ultra-wide clips all get a frame that fits them.
    if (kind === 'video') {
      var box = media.closest('.media-box');
      var frameEl = media.closest('.post-media-frame');
      var applyRatio = function () {
        if (!media.videoWidth || !media.videoHeight) return;
        if (box) {
          box.style.setProperty('--ar', media.videoWidth + ' / ' + media.videoHeight);
          box.classList.add('has-ratio');
        }
        if (frameEl) {
          var r = media.videoWidth / media.videoHeight;
          frameEl.dataset.orientation = r > 1.05 ? 'landscape' : r < 0.95 ? 'portrait' : 'square';
        }
      };
      media.addEventListener('loadedmetadata', applyRatio);
      if (media.readyState >= 1) applyRatio();

      // Don't keep playing (and buffering) a video that has been scrolled away.
      if ('IntersectionObserver' in window) {
        new IntersectionObserver(function (entries) {
          entries.forEach(function (entry) {
            if (!entry.isIntersecting && !media.paused && !document.fullscreenElement) media.pause();
          });
        }, { threshold: 0.15 }).observe(player);
      }
    }

    function seekToClientX(clientX) {
      var rect = seek.getBoundingClientRect();
      var pct = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
      if (media.duration) {
        media.currentTime = pct * media.duration;
        fill.style.width = (pct * 100) + '%';
        handle.style.left = (pct * 100) + '%';
      }
    }

    seek.addEventListener('pointerdown', function (e) {
      dragging = true;
      seek.classList.add('is-dragging');
      seek.setPointerCapture(e.pointerId);
      seekToClientX(e.clientX);
    });
    seek.addEventListener('pointermove', function (e) { if (dragging) seekToClientX(e.clientX); });
    ['pointerup', 'pointercancel'].forEach(function (ev) {
      seek.addEventListener(ev, function () { dragging = false; seek.classList.remove('is-dragging'); });
    });
    seek.addEventListener('keydown', function (e) {
      if (!media.duration) return;
      if (e.key === 'ArrowRight') media.currentTime = Math.min(media.duration, media.currentTime + 5);
      if (e.key === 'ArrowLeft') media.currentTime = Math.max(0, media.currentTime - 5);
    });

    var muteBtn = volume.querySelector('.cw-mute');
    var volRange = volume.querySelector('.cw-volume-range');
    muteBtn.addEventListener('click', function () {
      media.muted = !media.muted;
      muteBtn.innerHTML = media.muted || media.volume === 0 ? ICONS.muted : ICONS.volume;
      muteBtn.setAttribute('aria-label', media.muted ? 'Unmute' : 'Mute');
    });
    volRange.addEventListener('input', function () {
      media.volume = parseFloat(volRange.value);
      media.muted = media.volume === 0;
      muteBtn.innerHTML = media.muted ? ICONS.muted : ICONS.volume;
    });

    var speedBtn = speed.querySelector('.cw-speed-btn');
    speedBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      speed.classList.toggle('is-open');
    });
    speed.querySelectorAll('[data-speed]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var rate = parseFloat(btn.dataset.speed);
        media.playbackRate = rate;
        speedBtn.textContent = rate + 'x';
        speed.querySelectorAll('[data-speed]').forEach(function (b) { b.classList.toggle('is-active', b === btn); });
        speed.classList.remove('is-open');
      });
    });
    document.addEventListener('click', function (e) {
      if (!speed.contains(e.target)) speed.classList.remove('is-open');
    });

    if (kind === 'video') {
      var fsButton = controls.querySelector('.cw-fullscreen');
      fsButton.addEventListener('click', function () {
        if (document.fullscreenElement === player) {
          document.exitFullscreen();
        } else if (player.requestFullscreen) {
          player.requestFullscreen();
        }
      });

      // Show/hide chrome on hover or tap for touch devices.
      var hideTimer;
      function nudgeUI() {
        player.classList.add('show-ui');
        clearTimeout(hideTimer);
        hideTimer = setTimeout(function () { player.classList.remove('show-ui'); }, 2200);
      }
      player.addEventListener('pointermove', nudgeUI);
      player.addEventListener('pointerdown', nudgeUI);
    }
  }

  function scan(root) {
    (root || document).querySelectorAll('.post-media-frame video, .post-media-frame audio').forEach(enhance);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { scan(document); });
  } else {
    scan(document);
  }

  // Catch media added later (infinite scroll, async comment/post inserts, etc).
  if ('MutationObserver' in window) {
    var mo = new MutationObserver(function (mutations) {
      mutations.forEach(function (m) {
        m.addedNodes && m.addedNodes.forEach(function (node) {
          if (node.nodeType !== 1) return;
          if (node.matches && node.matches('.post-media-frame video, .post-media-frame audio')) enhance(node);
          scan(node);
        });
      });
    });
    mo.observe(document.body, { childList: true, subtree: true });
  }
})();
