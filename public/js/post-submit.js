// Sending a new post, and saving an edit, without leaving the page.
//
// What this script guarantees (and what to test by hand):
//   - Publishing shows the post straight away as a "Posting..." card. The composer keeps the person's text
//     until the server confirms it, so nothing is lost.
//   - If the request fails or times out, the card turns into "Couldn't post" with Retry / Edit / Discard.
//     The text is also kept in this browser, so a reload does not lose it either. Retry re-sends the same
//     attempt under the same request id, so if the first try did reach the server no second post appears.
//   - Tapping Publish twice (or pressing Enter twice) while a request is pending sends exactly one request.
//     The server also refuses a second post with the same request id.
//   - Saving an edit several times in a row sends the saves strictly one after another, each against the
//     revision the server last confirmed. An older save can never land after (and overwrite) a newer one,
//     and a reply that belongs to an older save never clears the "Saving..." state of a newer one.
(function () {
  const SEND_TIMEOUT_MS = 45 * 1000;
  const EDIT_TIMEOUT_MS = 30 * 1000;
  const STORE_KEY = 'cw-unsent-post';

  const csrfHeaders = () => ({
    'X-CSRF-Token': document.querySelector('meta[name="csrf-token"]')?.content,
    'X-Requested-With': 'XMLHttpRequest'
  });

  const newRequestId = () => {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
    return `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
  };

  const store = {
    read() { try { return JSON.parse(window.localStorage.getItem(STORE_KEY) || 'null'); } catch (error) { return null; } },
    write(value) { try { window.localStorage.setItem(STORE_KEY, JSON.stringify(value)); } catch (error) { /* private mode */ } },
    clear() { try { window.localStorage.removeItem(STORE_KEY); } catch (error) { /* private mode */ } }
  };

  // Posts a FormData/URLSearchParams body and gives up after `timeoutMs`. Always rejects with an Error whose
  // `.kind` says why: 'timeout', 'offline', 'status' (server answered with an error) or 'network'.
  async function send(url, body, timeoutMs) {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), timeoutMs);
    try {
      return (await window.axios.post(url, body, { headers: csrfHeaders(), signal: controller.signal })).data;
    } catch (error) {
      if (error && error.name === 'AbortError') error.kind = 'timeout';
      else if (error && error.response) error.kind = 'status';
      else if (typeof navigator !== 'undefined' && navigator.onLine === false) error.kind = 'offline';
      else error.kind = 'network';
      throw error;
    } finally {
      window.clearTimeout(timer);
    }
  }

  function explain(error, action) {
    const data = error && error.response && error.response.data;
    if (data && typeof data === 'object' && data.error) return data.error;
    if (error.kind === 'timeout') return `That took too long, so the ${action} may not have gone through.`;
    if (error.kind === 'offline') return `You're offline, so the ${action} didn't go through.`;
    const status = error.response && error.response.status;
    if (status === 429) return 'Too many requests too quickly. Wait a moment and try again.';
    if (status === 401 || status === 403) return 'Your session may have expired. Refresh the page or sign in again.';
    return `Couldn't complete the ${action} right now.`;
  }

  // ---------------------------------------------------------------- new posts (dashboard composer)

  function initComposer(composer) {
    const feed = document.getElementById('feed-posts');
    if (!feed || !window.axios) return; // no feed on this page: the normal form submit still works
    const textarea = composer.querySelector('textarea[name="body"]');
    let pending = false;
    let failed = null; // { snapshot, requestId, fingerprint, card }

    // One polite live region for outcomes that have no card (draft saved, scheduled, awaiting review).
    const live = document.createElement('p');
    live.className = 'composer-status';
    live.setAttribute('role', 'status');
    live.hidden = true;
    feed.before(live);
    const say = (text, link) => {
      live.replaceChildren(document.createTextNode(text));
      if (link) {
        live.append(' ');
        const anchor = document.createElement('a');
        anchor.href = link.href;
        anchor.textContent = link.label;
        live.append(anchor);
      }
      live.hidden = !text;
    };

    const setBusy = (busy) => {
      pending = busy;
      composer.setAttribute('aria-busy', String(busy));
      composer.querySelectorAll('button[type="submit"]').forEach((button) => {
        button.disabled = busy;
        button.style.opacity = busy ? '0.7' : '';
      });
    };

    // A snapshot is everything the server needs, copied now, so a retry sends exactly what was published
    // even if the composer has been edited since.
    const takeSnapshot = (submitter) => {
      let data;
      try { data = new FormData(composer, submitter || undefined); } catch (error) { data = new FormData(composer); }
      if (submitter && submitter.name && !data.has(submitter.name)) data.append(submitter.name, submitter.value);
      data.delete('clientRequestId');
      return data;
    };
    const fingerprintOf = (data) => {
      const parts = [];
      data.forEach((value, key) => {
        if (key === '_csrf') return;
        parts.push(`${key}=${value instanceof File ? `file:${value.name}:${value.size}:${value.lastModified}` : value}`);
      });
      return parts.join('\u0001');
    };

    const makeCard = (text, isDraft) => {
      const card = document.createElement('article');
      card.className = 'post-card post-card-pending';
      card.setAttribute('aria-busy', 'true');
      const head = document.createElement('p');
      head.className = 'post-pending-state';
      head.setAttribute('role', 'status');
      const body = document.createElement('div');
      body.className = 'post-body post-pending-body';
      body.textContent = text;
      const actions = document.createElement('div');
      actions.className = 'post-pending-actions';
      card.append(head, body, actions);
      card.cwHead = head;
      card.cwActions = actions;
      card.cwIsDraft = isDraft;
      return card;
    };
    const showSending = (card) => {
      card.setAttribute('aria-busy', 'true');
      card.classList.remove('is-failed');
      card.cwHead.setAttribute('role', 'status');
      card.cwHead.textContent = card.cwIsDraft ? 'Saving draft…' : 'Posting…';
      card.cwActions.replaceChildren();
    };
    const actionButton = (label, handler, className = 'button-ghost') => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `button ${className} button-small`;
      button.textContent = label;
      button.addEventListener('click', handler);
      return button;
    };
    const showFailed = (card, message) => {
      card.setAttribute('aria-busy', 'false');
      card.classList.add('is-failed');
      card.cwHead.setAttribute('role', 'alert');
      card.cwHead.textContent = `Not posted. ${message} Your text is saved - nothing was lost.`;
      card.cwActions.replaceChildren(
        actionButton('Retry', () => attempt(card), 'button-primary'),
        actionButton('Edit', () => {
          composer.classList.remove('composer-hidden');
          document.querySelector('[data-composer-open]')?.setAttribute('aria-expanded', 'true');
          textarea?.focus();
        }),
        actionButton('Discard', () => discard(card))
      );
    };

    const rememberUnsent = () => {
      if (!failed) return;
      const fields = [];
      let hadFiles = false;
      failed.snapshot.forEach((value, key) => {
        if (value instanceof File) { if (value.size) hadFiles = true; return; }
        if (key !== '_csrf') fields.push([key, value]);
      });
      store.write({ fields, hadFiles, requestId: failed.requestId, savedAt: Date.now() });
    };

    const discard = (card) => {
      card.remove();
      failed = null;
      store.clear();
      say('Unsent post discarded.');
    };

    const resetComposer = () => {
      composer.reset();
      composer.dispatchEvent(new CustomEvent('gif:clear', { bubbles: true }));
      composer.querySelectorAll('[data-hashtag-suggestions]').forEach((node) => node.replaceChildren());
      textarea?.dispatchEvent(new Event('input', { bubbles: true }));
      composer.querySelector('select[name="type"]')?.dispatchEvent(new Event('change', { bubbles: true }));
      composer.querySelector('[data-ww-input]')?.dispatchEvent(new Event('ww:reset', { bubbles: true }));
    };

    async function attempt(card) {
      if (pending) return; // a request is already on its way
      setBusy(true);
      showSending(card);
      const body = new FormData();
      failed.snapshot.forEach((value, key) => body.append(key, value));
      body.set('clientRequestId', failed.requestId);
      try {
        const data = await send(composer.getAttribute('action') || '/posts', body, Number(composer.dataset.sendTimeoutMs) || SEND_TIMEOUT_MS);
        if (!data || typeof data !== 'object' || data.ok === false) {
          const rejected = new Error((data && data.error) || 'Your session may have expired.');
          rejected.kind = 'status';
          rejected.response = { data: { error: rejected.message }, status: 200 };
          throw rejected;
        }
        succeed(card, data);
      } catch (error) {
        if (error && error.kind === 'status' && error.response && error.response.status === 422) {
          // The server read the post and said no (word limit, blocked word, ...). Retrying the identical post
          // can't help, so make that clear and let them edit instead.
          showFailed(card, explain(error, 'post'));
          card.cwActions.querySelector('button')?.remove();
        } else {
          showFailed(card, explain(error, 'post'));
        }
        rememberUnsent();
      } finally {
        setBusy(false);
      }
    }

    function succeed(card, data) {
      const wasDraft = card.cwIsDraft;
      failed = null;
      store.clear();
      resetComposer();
      composer.classList.add('composer-hidden');
      document.querySelector('[data-composer-open]')?.setAttribute('aria-expanded', 'false');
      if (data.html) {
        const holder = document.createElement('div');
        holder.innerHTML = data.html;
        const real = holder.firstElementChild;
        const duplicate = real && real.id && document.getElementById(real.id);
        if (real && !duplicate) {
          card.replaceWith(real);
          if (typeof initAvatars === 'function') initAvatars(real.parentElement || document);
          if (typeof enhanceCards === 'function') enhanceCards(real.parentElement || document);
        } else {
          card.remove();
        }
        say(data.duplicate ? 'Your post was already published.' : 'Posted.', { href: data.url, label: 'View post' });
      } else {
        card.remove();
        const text = data.message || (wasDraft ? 'Draft saved. It is visible only to you.' : 'Done.');
        say(data.status === 'scheduled' && data.scheduledAt ? `Scheduled for ${new Date(data.scheduledAt).toLocaleString()}.` : text, data.url ? { href: data.url, label: 'View' } : null);
      }
    }

    composer.addEventListener('submit', (event) => {
      if (event.defaultPrevented) return; // e.g. over the word limit: app.js already stopped it
      event.preventDefault();
      if (pending) return; // second tap while the first request is still out
      if (!textarea || !textarea.value.trim()) return;
      const snapshot = takeSnapshot(event.submitter);
      const fingerprint = fingerprintOf(snapshot);
      const isDraft = snapshot.get('saveAsDraft') === 'on';
      let card = failed && failed.card;
      // Re-publishing the very same content after a failure is the same attempt (same request id), so it
      // can never double up. Changed content is a different post and gets its own id.
      const requestId = failed && failed.fingerprint === fingerprint ? failed.requestId : newRequestId();
      if (card) { card.cwIsDraft = isDraft; card.querySelector('.post-pending-body').textContent = textarea.value.trim(); }
      else {
        card = makeCard(textarea.value.trim(), isDraft);
        feed.prepend(card);
      }
      failed = { snapshot, requestId, fingerprint, card };
      composer.classList.add('composer-hidden');
      say('');
      attempt(card);
    });

    // Something unsent from an earlier visit (the tab was closed or reloaded after a failure).
    const saved = store.read();
    if (saved && Array.isArray(saved.fields) && saved.fields.some(([key, value]) => key === 'body' && String(value).trim())) {
      const snapshot = new FormData();
      saved.fields.forEach(([key, value]) => snapshot.append(key, value));
      const text = String(snapshot.get('body') || '').trim();
      const card = makeCard(text, snapshot.get('saveAsDraft') === 'on');
      feed.prepend(card);
      failed = { snapshot, requestId: saved.requestId || newRequestId(), fingerprint: fingerprintOf(snapshot), card };
      showFailed(card, 'This post from your last visit was never sent.');
      if (saved.hadFiles) card.cwHead.textContent += ' Attached files need to be added again.';
      if (saved.hadFiles) card.cwActions.querySelector('button')?.remove();
      // Edit puts the saved text back into the composer.
      const editButton = Array.from(card.cwActions.querySelectorAll('button')).find((button) => button.textContent === 'Edit');
      editButton?.addEventListener('click', () => {
        if (textarea && !textarea.value.trim()) {
          textarea.value = text;
          textarea.dispatchEvent(new Event('input', { bubbles: true }));
          const type = snapshot.get('type');
          const typeSelect = composer.querySelector('select[name="type"]');
          if (type && typeSelect) { typeSelect.value = type; typeSelect.dispatchEvent(new Event('change', { bubbles: true })); }
        }
      });
    }
  }

  // ---------------------------------------------------------------- editing a post

  function initEditForm(form) {
    if (!window.axios) return;
    const textarea = form.querySelector('textarea[name="body"]');
    const revisionInput = form.querySelector('input[name="revision"]');
    const submit = form.querySelector('button[type="submit"]');
    if (!textarea || !revisionInput || !submit) return;
    const postUrl = form.dataset.postUrl || '/dashboard';

    const status = document.createElement('p');
    status.className = 'post-compose-status';
    status.setAttribute('role', 'status');
    status.hidden = true;
    form.querySelector('.post-compose-footer')?.before(status);
    const show = (text, kind) => {
      status.textContent = text;
      status.hidden = !text;
      status.classList.toggle('is-error', kind === 'error');
      status.setAttribute('role', kind === 'error' ? 'alert' : 'status');
    };

    let revision = Number(revisionInput.value) || 0; // last revision the server confirmed
    let latestSeq = 0; // numbers every Save tap
    let inflight = 0;
    let lastSaved = textarea.value.trim();
    let chain = Promise.resolve();
    let blocked = false; // a conflict: stop sending until the page is reloaded

    const refreshButton = () => {
      const saving = inflight > 0;
      submit.setAttribute('aria-busy', String(saving));
      submit.classList.toggle('is-saving', saving);
    };

    form.addEventListener('submit', (event) => {
      if (event.defaultPrevented) return; // over the word limit
      event.preventDefault();
      if (blocked) return show('Reload the page to get the latest text before saving again.', 'error');
      const text = textarea.value.trim();
      if (!text) return;
      if (text === lastSaved && inflight === 0) { window.location.assign(postUrl); return; }
      latestSeq += 1;
      const seq = latestSeq;
      inflight += 1;
      refreshButton();
      show('Saving…');
      chain = chain.then(async () => {
        try {
          // A newer tap is already queued behind this one and carries the full, newer text: skip this one.
          if (seq !== latestSeq) return;
          if (blocked) return;
          const body = new URLSearchParams();
          body.set('body', text);
          body.set('revision', String(revision));
          let data;
          try {
            data = await send(form.getAttribute('action'), body, Number(form.dataset.saveTimeoutMs) || EDIT_TIMEOUT_MS);
          } catch (error) {
            const reply = error.response && error.response.data;
            if (error.response && error.response.status === 409 && reply && reply.conflict) {
              blocked = true;
              if (typeof reply.revision === 'number') revision = reply.revision;
              if (seq === latestSeq) show('This post was changed somewhere else, so this save was not applied. Reload to see the latest text.', 'error');
              return;
            }
            if (seq === latestSeq) show(`${explain(error, 'save')} Your text is still here - press Save to try again.`, 'error');
            return;
          }
          if (!data || data.ok === false) {
            if (seq === latestSeq) show(`${(data && data.error) || 'Your session may have expired.'} Your text is still here.`, 'error');
            return;
          }
          // Only move the revision forward, never back.
          if (typeof data.revision === 'number' && data.revision > revision) revision = data.revision;
          revisionInput.value = String(revision);
          lastSaved = text;
          // Only the newest save may touch the screen's state.
          if (seq === latestSeq) {
            if (textarea.value.trim() === text) {
              show('Saved.');
              window.setTimeout(() => window.location.assign(postUrl), 350);
            } else {
              show('Saved. You have changed the text since - press Save again to keep those changes.');
            }
          }
        } finally {
          inflight -= 1;
          refreshButton();
        }
      });
    });
  }

  // ---------------------------------------------------------------- start

  document.addEventListener('DOMContentLoaded', () => {
    const composer = document.querySelector('#composer');
    if (composer) initComposer(composer);
    document.querySelectorAll('form[data-edit-post]').forEach(initEditForm);
  });
  if (document.readyState !== 'loading') {
    // Loaded after the page was ready: DOMContentLoaded already fired.
    const composer = document.querySelector('#composer');
    if (composer && !composer.dataset.postSubmitReady) { composer.dataset.postSubmitReady = '1'; initComposer(composer); }
    document.querySelectorAll('form[data-edit-post]:not([data-ready])').forEach((form) => { form.dataset.ready = '1'; initEditForm(form); });
  }

  window.cwPostSubmit = { send, explain, newRequestId };
})();
