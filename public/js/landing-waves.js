(() => {
  const section = document.querySelector('.landing-waves[data-waves-url]');
  if (!section) return;

  const list = section.querySelector('[data-waves-list]');
  const status = section.querySelector('[data-waves-status]');
  const endpoint = section.dataset.wavesUrl;
  const formatter = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
  let refreshing = false;

  function renderUsers(users) {
    list.replaceChildren();
    if (!users.length) {
      const empty = document.createElement('li');
      empty.className = 'landing-waves-empty';
      empty.textContent = 'No Waves balances yet. Be among the first to earn some.';
      list.append(empty);
      return;
    }

    users.forEach((person, index) => {
      const row = document.createElement('li');
      row.className = 'landing-waves-row';

      const rank = document.createElement('span');
      rank.className = 'landing-waves-rank';
      rank.setAttribute('aria-label', `Rank ${index + 1}`);
      rank.textContent = String(index + 1).padStart(2, '0');
      row.append(rank);

      const avatar = document.createElement('span');
      avatar.className = `avatar small${person.profilePicture ? ' has-image' : ''}`;
      const initial = document.createElement('span');
      initial.className = 'avatar-initial';
      initial.setAttribute('aria-hidden', 'true');
      initial.textContent = (person.name || '?').trim().charAt(0).toUpperCase() || '?';
      avatar.append(initial);
      if (person.profilePicture) {
        const image = document.createElement('img');
        image.className = 'avatar-image';
        image.src = person.profilePicture;
        image.alt = '';
        image.setAttribute('aria-hidden', 'true');
        avatar.append(image);
      }
      row.append(avatar);

      const name = document.createElement('a');
      name.className = 'landing-waves-name';
      name.href = `/u/${encodeURIComponent(String(person._id))}`;
      name.textContent = person.name || 'Member';
      row.append(name);

      const balance = document.createElement('span');
      balance.className = 'landing-waves-balance';
      balance.setAttribute('role', 'img');
      balance.setAttribute('aria-label', `${formatter.format(Number(person.wavesBalance) || 0)} Waves`);
      const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      icon.setAttribute('class', 'icon icon-waves');
      icon.setAttribute('width', '15');
      icon.setAttribute('height', '15');
      icon.setAttribute('viewBox', '0 0 24 24');
      icon.setAttribute('fill', 'none');
      icon.setAttribute('stroke', 'currentColor');
      icon.setAttribute('stroke-width', '2');
      icon.setAttribute('stroke-linecap', 'round');
      icon.setAttribute('stroke-linejoin', 'round');
      icon.setAttribute('aria-hidden', 'true');
      for (const curve of ['M2 12c2.5-4 5-4 7.5 0s5 4 7.5 0 5-4 7 0', 'M2 18c2.5-4 5-4 7.5 0s5 4 7.5 0 5-4 7 0']) {
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', curve);
        icon.append(path);
      }
      balance.append(icon);
      balance.append(document.createTextNode(` ${formatter.format(Number(person.wavesBalance) || 0)}`));
      row.append(balance);

      list.append(row);
    });
  }

  async function refresh() {
    if (refreshing || document.visibilityState === 'hidden') return;
    refreshing = true;
    try {
      const response = await fetch(endpoint, { headers: { Accept: 'application/json' }, cache: 'no-store' });
      const result = await response.json();
      if (!response.ok || !Array.isArray(result.users)) {
        throw new Error(result.error || 'Invalid leaderboard response');
      }
      renderUsers(result.users);
      status.textContent = `Live · updated ${new Date(result.updatedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
    } catch {
      status.textContent = 'Could not refresh · showing last update';
    } finally {
      refreshing = false;
    }
  }

  window.setInterval(refresh, 60_000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refresh();
  });
})();
