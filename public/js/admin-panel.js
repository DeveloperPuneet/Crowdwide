(function () {
  'use strict';
  var tabs = document.querySelectorAll('.admin-tab');
  if (!tabs.length) return;

  function activate(name) {
    document.querySelectorAll('.admin-tab').forEach(function (t) {
      t.classList.toggle('is-active', t.dataset.tab === name);
      t.setAttribute('aria-selected', String(t.dataset.tab === name));
      t.tabIndex = t.dataset.tab === name ? 0 : -1;
    });
    document.querySelectorAll('.admin-panel').forEach(function (p) {
      p.classList.toggle('is-active', p.dataset.panel === name);
      p.hidden = p.dataset.panel !== name;
    });
  }

  tabs.forEach(function (tab) {
    tab.addEventListener('click', function () {
      activate(tab.dataset.tab);
      history.replaceState(null, '', '#' + tab.dataset.tab);
    });
    tab.addEventListener('keydown', function (event) {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      event.preventDefault();
      var direction = event.key === 'ArrowRight' ? 1 : -1;
      var index = Array.prototype.indexOf.call(tabs, tab);
      var next = tabs[(index + direction + tabs.length) % tabs.length];
      activate(next.dataset.tab);
      next.focus();
    });
  });

  var initial = (location.hash || '').replace('#', '');
  activate(tabs[0] && document.querySelector('.admin-panel[data-panel="' + initial + '"]') ? initial : tabs[0].dataset.tab);

  document.addEventListener('click', function (e) {
    var toggle = e.target.closest('[data-edit-toggle]');
    if (!toggle) return;
    var row = document.getElementById(toggle.dataset.editToggle);
    if (row) row.classList.toggle('is-open');
  });
})();
