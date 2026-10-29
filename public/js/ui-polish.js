/* UI polish helpers: composer co-author picker, "More options" badge, post menu and report dialog.
   Plain progressive enhancement - every control still works as a normal link/form without this file. */
(() => {
  'use strict';

  // ------------------------------------------------------------------ composer: co-author picker
  const initCoAuthors = (picker) => {
    const max = Number(picker.dataset.max) || 5;
    const form = picker.closest('form');
    const selectedBox = picker.querySelector('[data-ca-selected]');
    const input = picker.querySelector('[data-ca-input]');
    const list = picker.querySelector('[data-ca-results]');
    let people = [];
    try { people = JSON.parse(picker.dataset.people || '[]'); } catch (error) { people = []; }
    const chosen = new Map();
    let remote = [];
    let active = -1;
    let timer;
    let requestId = 0;

    const notify = () => form?.dispatchEvent(new CustomEvent('composer:coauthors', { detail: { count: chosen.size } }));
    const initial = (name) => (String(name || '?').trim().charAt(0) || '?').toUpperCase();
    const avatar = (person) => {
      const span = document.createElement('span');
      span.className = 'ca-avatar';
      span.textContent = initial(person.name);
      if (person.picture) {
        const img = document.createElement('img');
        img.alt = '';
        img.src = person.picture;
        img.addEventListener('error', () => img.remove());
        span.append(img);
      }
      return span;
    };

    const renderSelected = () => {
      selectedBox.replaceChildren(...Array.from(chosen.values()).map((person) => {
        const chip = document.createElement('span');
        chip.className = 'ca-chip';
        const hidden = document.createElement('input');
        hidden.type = 'hidden';
        hidden.name = 'coAuthors';
        hidden.value = person.id;
        const name = document.createElement('span');
        name.className = 'ca-chip-name';
        name.textContent = person.name;
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'ca-chip-remove';
        remove.setAttribute('aria-label', `Remove ${person.name}`);
        remove.textContent = '×';
        remove.addEventListener('click', () => { chosen.delete(person.id); renderSelected(); renderList(); notify(); input.focus(); });
        chip.append(hidden, avatar(person), name, remove);
        return chip;
      }));
      selectedBox.hidden = chosen.size === 0;
      input.disabled = false;
      input.placeholder = chosen.size >= max ? `Limit reached (${max}). Remove someone to add another.` : 'Search people to credit…';
    };

    const matches = () => {
      const query = input.value.trim().toLowerCase().replace(/^@/, '');
      const local = query ? people.filter((person) => person.name.toLowerCase().includes(query)) : people;
      const seen = new Set(local.map((person) => person.id));
      const merged = [...local, ...remote.filter((person) => !seen.has(person.id))];
      return { query, rows: merged.slice(0, 30) };
    };

    const close = () => { list.hidden = true; input.setAttribute('aria-expanded', 'false'); active = -1; };
    const open = () => { list.hidden = false; input.setAttribute('aria-expanded', 'true'); };

    function renderList() {
      const { query, rows } = matches();
      list.replaceChildren();
      if (chosen.size >= max) {
        const full = document.createElement('li');
        full.className = 'ca-empty';
        full.textContent = `You can add up to ${max} co-authors.`;
        list.append(full);
        return;
      }
      if (!rows.length) {
        const empty = document.createElement('li');
        empty.className = 'ca-empty';
        empty.textContent = query
          ? (query.length < 2 ? 'Keep typing to search everyone…' : 'No one found. Try a name or @handle.')
          : 'Follow people to see them here, or type a name to search everyone.';
        list.append(empty);
        return;
      }
      if (!query) {
        const head = document.createElement('li');
        head.className = 'ca-group';
        head.textContent = 'People you follow & your followers';
        head.setAttribute('role', 'presentation');
        list.append(head);
      }
      rows.forEach((person) => {
        const item = document.createElement('li');
        item.setAttribute('role', 'option');
        const picked = chosen.has(person.id);
        item.className = `ca-option${picked ? ' is-picked' : ''}`;
        item.setAttribute('aria-selected', picked ? 'true' : 'false');
        item.dataset.id = person.id;
        const text = document.createElement('span');
        text.className = 'ca-option-text';
        const name = document.createElement('strong');
        name.textContent = person.name;
        text.append(name);
        if (person.handle) { const handle = document.createElement('small'); handle.textContent = `@${person.handle}`; text.append(handle); }
        const mark = document.createElement('span');
        mark.className = 'ca-option-mark';
        mark.textContent = picked ? 'Added' : 'Add';
        item.append(avatar(person), text, mark);
        item.addEventListener('mousedown', (event) => event.preventDefault()); // keep focus in the search box
        item.addEventListener('click', () => toggle(person));
        list.append(item);
      });
    }

    const toggle = (person) => {
      if (chosen.has(person.id)) chosen.delete(person.id);
      else if (chosen.size < max) chosen.set(person.id, person);
      renderSelected();
      renderList();
      notify();
    };

    const options = () => Array.from(list.querySelectorAll('.ca-option'));
    const highlight = (index) => {
      const items = options();
      if (!items.length) return;
      active = (index + items.length) % items.length;
      items.forEach((item, i) => item.classList.toggle('is-active', i === active));
      items[active].scrollIntoView({ block: 'nearest' });
    };

    input.addEventListener('focus', () => { renderList(); open(); });
    input.addEventListener('click', () => { renderList(); open(); });
    input.addEventListener('input', () => {
      renderList();
      open();
      clearTimeout(timer);
      const query = input.value.trim().replace(/^@/, '');
      const mine = ++requestId;
      if (query.length < 2) { remote = []; return; }
      timer = setTimeout(() => {
        fetch(`/users/suggest?q=${encodeURIComponent(query)}`, { credentials: 'same-origin', headers: { Accept: 'application/json' } })
          .then((response) => (response.ok ? response.json() : []))
          .then((rows) => {
            if (mine !== requestId) return; // a newer keystroke superseded this answer
            remote = (Array.isArray(rows) ? rows : []).map((row) => ({ id: String(row.id), name: row.name || row.handle, handle: row.handle, picture: row.profilePicture || '' }));
            renderList();
          })
          .catch(() => {});
      }, 180);
    });
    input.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowDown') { event.preventDefault(); open(); highlight(active + 1); }
      else if (event.key === 'ArrowUp') { event.preventDefault(); open(); highlight(active - 1); }
      else if (event.key === 'Enter') {
        // Enter in this box must never submit (publish) the whole post.
        event.preventDefault();
        const item = options()[active] || (input.value.trim() ? options()[0] : null);
        if (item) { const person = [...people, ...remote].find((p) => p.id === item.dataset.id); if (person) toggle(person); }
      } else if (event.key === 'Escape') { if (!list.hidden) { event.stopPropagation(); close(); } }
      else if (event.key === 'Backspace' && !input.value && chosen.size) {
        const last = Array.from(chosen.keys()).pop();
        chosen.delete(last); renderSelected(); renderList(); notify();
      }
    });
    document.addEventListener('click', (event) => { if (!picker.contains(event.target)) close(); });
    form?.addEventListener('reset', () => setTimeout(() => { chosen.clear(); remote = []; input.value = ''; renderSelected(); close(); notify(); }, 0));
    renderSelected();
  };
  document.querySelectorAll('[data-coauthor-picker]').forEach(initCoAuthors);

  // ------------------------------------------------------------------ composer: "More options" badge
  document.querySelectorAll('[data-composer-options]').forEach((details) => {
    const form = details.closest('form');
    const badge = details.querySelector('[data-options-badge]');
    if (!form || !badge) return;
    const update = () => {
      const parts = [];
      const files = form.querySelector('input[type="file"][name="media"]')?.files?.length || 0;
      if (files) parts.push(`${files} media`);
      const coAuthors = form.querySelectorAll('input[name="coAuthors"]').length;
      if (coAuthors) parts.push(`${coAuthors} co-author${coAuthors === 1 ? '' : 's'}`);
      if (form.querySelector('[name="scheduledAt"]')?.value) parts.push('scheduled');
      if (form.querySelector('[name="contentWarning"]')?.value.trim()) parts.push('warning');
      if (form.querySelector('[name="quest"]')?.value) parts.push('quest');
      badge.textContent = parts.join(' · ');
      badge.hidden = parts.length === 0;
    };
    form.addEventListener('composer:attachments', update);
    form.addEventListener('composer:coauthors', update);
    form.addEventListener('input', update);
    form.addEventListener('change', update);
    form.addEventListener('reset', () => setTimeout(update, 0));
    update();
  });

  // ------------------------------------------------------------------ post "⋯" menu
  const menus = Array.from(document.querySelectorAll('[data-post-menu]'));
  const closeMenus = (except) => menus.forEach((menu) => { if (menu !== except && menu.open) menu.open = false; });
  menus.forEach((menu) => {
    menu.addEventListener('toggle', () => {
      if (menu.open) { closeMenus(menu); menu.querySelector('[role="menuitem"]')?.focus({ preventScroll: true }); }
    });
    menu.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') { menu.open = false; menu.querySelector('summary')?.focus(); return; }
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      const items = Array.from(menu.querySelectorAll('[role="menuitem"]'));
      if (!items.length) return;
      event.preventDefault();
      const index = items.indexOf(document.activeElement);
      items[(index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus();
    });
  });
  document.addEventListener('click', (event) => { if (!event.target.closest('[data-post-menu]')) closeMenus(); });

  // Report: opens in a dialog so the menu keeps one fixed size.
  document.querySelectorAll('[data-report-open]').forEach((button) => {
    const dialog = document.getElementById(button.dataset.reportOpen);
    if (!dialog) return;
    button.addEventListener('click', () => {
      closeMenus();
      if (typeof dialog.showModal === 'function') dialog.showModal(); else dialog.setAttribute('open', '');
    });
    dialog.querySelectorAll('[data-dialog-close]').forEach((close) => close.addEventListener('click', () => { if (dialog.close) dialog.close(); else dialog.removeAttribute('open'); }));
    dialog.addEventListener('click', (event) => { if (event.target === dialog && dialog.close) dialog.close(); });
  });
})();
