// Survey builder (admin): add / remove questions and answer options.
// Field names use a per-question key (questions[KEY][text], questions[KEY][options][]);
// the server reads them in key order, so removing a middle question is safe.
(function () {
  'use strict';
  var MAX_OPTIONS = 10;
  var MAX_QUESTIONS = 30;
  var nextKey = 1000;

  function renumber(form) {
    form.querySelectorAll('[data-survey-q]').forEach(function (question, qi) {
      var number = qi + 1;
      var label = question.querySelector('[data-q-number]');
      if (label) label.textContent = number;
      var text = question.querySelector('[data-q-text]');
      if (text) text.setAttribute('aria-label', 'Question ' + number + ' text');
      question.querySelectorAll('.survey-option input').forEach(function (input, oi) {
        input.placeholder = 'Option ' + (oi + 1);
        input.setAttribute('aria-label', 'Question ' + number + ' option ' + (oi + 1));
      });
    });
  }

  function newOption(question) {
    var wrap = document.createElement('div');
    wrap.className = 'survey-option';
    var input = document.createElement('input');
    input.type = 'text';
    input.maxLength = 150;
    input.name = 'questions[' + question.dataset.index + '][options][]';
    var remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'survey-icon-btn';
    remove.setAttribute('data-remove-option', '');
    remove.setAttribute('aria-label', 'Remove this option');
    remove.innerHTML = '&times;';
    wrap.appendChild(input);
    wrap.appendChild(remove);
    return wrap;
  }

  document.addEventListener('click', function (event) {
    var form = event.target.closest('[data-survey-builder]');
    if (!form) return;

    if (event.target.closest('[data-add-question]')) {
      var template = document.getElementById('survey-q-template');
      var list = form.querySelector('[data-questions]');
      if (!template || !list || list.querySelectorAll('[data-survey-q]').length >= MAX_QUESTIONS) return;
      var key = nextKey++;
      var html = template.innerHTML.replace(/__Q__/g, String(key)).replace(/__N__/g, String(list.querySelectorAll('[data-survey-q]').length + 1));
      list.insertAdjacentHTML('beforeend', html);
      renumber(form);
      var added = list.querySelector('[data-survey-q]:last-of-type [data-q-text]');
      if (added) added.focus();
      return;
    }

    var question = event.target.closest('[data-survey-q]');
    if (!question) return;

    if (event.target.closest('[data-add-option]')) {
      var options = question.querySelector('[data-options]');
      if (options.children.length >= MAX_OPTIONS) return;
      var option = newOption(question);
      options.appendChild(option);
      renumber(form);
      option.querySelector('input').focus();
      return;
    }

    if (event.target.closest('[data-remove-option]')) {
      var holder = question.querySelector('[data-options]');
      if (holder.children.length <= 2) return; // a poll needs at least two choices
      event.target.closest('.survey-option').remove();
      renumber(form);
      return;
    }

    if (event.target.closest('[data-remove-question]')) {
      if (form.querySelectorAll('[data-survey-q]').length <= 1) return;
      question.remove();
      renumber(form);
    }
  });
})();
