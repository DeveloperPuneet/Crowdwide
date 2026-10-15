// Installable-app support: registers the service worker and powers the
// "Install app" buttons (any element with [data-pwa-install]).
(function () {
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('/sw.js').catch(function () { /* unsupported or blocked: the site works without it */ });
    });
  }

  var buttons = Array.prototype.slice.call(document.querySelectorAll('[data-pwa-install]'));
  if (!buttons.length) return;

  var standalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  if (standalone) return; // already running as an installed app

  var deferredPrompt = null;
  var isIos = /iphone|ipad|ipod/i.test(window.navigator.userAgent) && !window.MSStream;

  function show() { buttons.forEach(function (button) { button.hidden = false; }); }
  function hide() { buttons.forEach(function (button) { button.hidden = true; }); }

  window.addEventListener('beforeinstallprompt', function (event) {
    event.preventDefault();
    deferredPrompt = event;
    show();
  });
  window.addEventListener('appinstalled', function () {
    deferredPrompt = null;
    hide();
  });

  // iOS Safari never fires beforeinstallprompt; show the manual steps instead.
  if (isIos) show();

  buttons.forEach(function (button) {
    button.addEventListener('click', function () {
      if (deferredPrompt) {
        deferredPrompt.prompt();
        deferredPrompt.userChoice.finally(function () { deferredPrompt = null; hide(); });
        return;
      }
      if (isIos) {
        window.alert('To install Crowdwide: tap the Share button in Safari, then choose "Add to Home Screen".');
      }
    });
  });
})();
