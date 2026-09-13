(function () {
  'use strict';
  var tabs = document.querySelectorAll('.admin-tab');
  if (!tabs.length) return;

  function activate(name) {
    document.querySelectorAll('.admin-tab').forEach(function (t) {
      t.classList.toggle('is-active', t.dataset.tab === name);
    });
    document.querySelectorAll('.admin-panel').forEach(function (p) {
      p.classList.toggle('is-active', p.dataset.panel === name);
    });
  }

  tabs.forEach(function (tab) {
    tab.addEventListener('click', function () {
      activate(tab.dataset.tab);
      history.replaceState(null, '', '#' + tab.dataset.tab);
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
