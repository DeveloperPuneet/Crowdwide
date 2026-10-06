(() => {
  const celebration = document.querySelector('[data-profile-anniversary]');
  if (!celebration) return;

  const joinedAt = new Date(celebration.dataset.joinedAt);
  if (!Number.isFinite(joinedAt.getTime())) return;

  const joinedDateLabel = document.querySelector('[data-profile-joined-date]');
  if (joinedDateLabel) {
    joinedDateLabel.textContent = joinedAt.toLocaleDateString(undefined, {
      month: 'long',
      day: 'numeric',
      year: 'numeric'
    });
  }

  const updateCelebration = () => {
    const today = new Date();
    const joinedMonth = joinedAt.getMonth();
    const joinedDay = joinedAt.getDate();
    const isLeapDayJoin = joinedMonth === 1 && joinedDay === 29;
    const isNonLeapFebruaryEnd = today.getMonth() === 1
      && today.getDate() === 28
      && new Date(today.getFullYear(), 2, 0).getDate() === 28;
    const anniversaryToday = (today.getMonth() === joinedMonth && today.getDate() === joinedDay)
      || (isLeapDayJoin && isNonLeapFebruaryEnd);
    const years = today.getFullYear() - joinedAt.getFullYear();
    const celebrating = anniversaryToday && years > 0;

    celebration.hidden = !celebrating;
    if (celebrating) {
      celebration.querySelector('[data-anniversary-years]').textContent = `${years} ${years === 1 ? 'year' : 'years'} on Crowdwide`;
    }
  };

  const scheduleNextLocalDay = () => {
    const now = new Date();
    const nextLocalDay = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    window.setTimeout(() => {
      updateCelebration();
      scheduleNextLocalDay();
    }, nextLocalDay.getTime() - now.getTime() + 50);
  };

  updateCelebration();
  scheduleNextLocalDay();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') updateCelebration();
  });
})();
