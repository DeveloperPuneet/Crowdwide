// Optimistic UI runner, shared by every "tap and it just works" control: likes, saves, follows,
// reactions, poll votes and so on.
//
// The idea: change the screen the instant the person taps, tell the server in the background, and only
// step in if something went wrong. Rules it enforces so every control behaves the same way:
//   1. The UI changes immediately (op.write with the predicted state from op.next).
//   2. Requests for one control are sent strictly in order, so quick taps (like, unlike, like...) can never
//      race each other and leave the server in a different state from the screen.
//   3. When the LAST queued request returns, the server's own numbers replace the guess (op.fromServer),
//      so a like count that moved because other people liked meanwhile is corrected without a reload.
//   4. If a request fails (offline, rate limited, signed out, rejected) the control goes back to the last
//      state the server confirmed, any taps that were queued on top of the failed one are dropped, and a short
//      message explains what happened.
//
// op = {
//   read(scope)                  -> state object describing the control right now
//   next(state)                  -> predicted state after the tap, or null for "nothing to do"
//   write(scope, state, info)    -> paint a state ({ optimistic: true } while guessing, { reverted: true } after a failure)
//   request()                    -> Promise of the server's JSON reply (build the body when the tap happens)
//   fromServer(data, state)      -> authoritative state from the reply, or null if the reply carries none
//   anchor                       -> element after which a failure message is shown (defaults to scope)
//   failMessage                  -> optional text for the failure message
// }
(function () {
  const controls = new WeakMap();

  function describeError(error, fallback) {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return "You're offline, so that didn't save. Your change was undone.";
    const status = error && error.response && error.response.status;
    if (status === 429) return 'Too many taps too quickly. Your change was undone.';
    if (status === 401 || status === 403) return 'Please refresh the page or sign in again. Your change was undone.';
    if (error && error.userFacing && error.message) return `${error.message} Your change was undone.`;
    return fallback || "Couldn't save that. Your change was undone.";
  }

  // Short status line under a control. Success lines fade quickly; errors stay a little longer.
  function notice(anchor, text, isError) {
    if (!anchor || !anchor.parentElement) return;
    anchor.parentElement.querySelectorAll(':scope > .interaction-message').forEach((old) => old.remove());
    const message = document.createElement('span');
    message.className = `interaction-message${isError ? ' interaction-error' : ''}`;
    message.setAttribute('role', isError ? 'alert' : 'status');
    message.textContent = text;
    anchor.after(message);
    window.setTimeout(() => message.remove(), isError ? 5000 : 2200);
  }

  function run(scope, op) {
    let control = controls.get(scope);
    if (!control) {
      control = { chain: Promise.resolve(), inflight: 0, truth: null, epoch: 0 };
      controls.set(scope, control);
    }
    const current = op.read(scope);
    if (control.inflight === 0) control.truth = current; // nothing pending: this is what the server holds
    const target = op.next(current);
    if (!target) return false;
    op.write(scope, target, { optimistic: true });

    control.inflight += 1;
    const epoch = control.epoch;
    control.chain = control.chain.then(async () => {
      try {
        if (epoch !== control.epoch) return; // an earlier request failed and rolled this tap back with it
        try {
          const data = await op.request();
          if (!data || typeof data !== 'object') {
            const unexpected = new Error('Your session may have expired.');
            unexpected.userFacing = true;
            throw unexpected;
          }
          if (data.ok === false) {
            const rejected = new Error(data.error || data.message || '');
            rejected.userFacing = Boolean(rejected.message);
            throw rejected;
          }
          const server = op.fromServer ? op.fromServer(data, op.read(scope)) : null;
          control.truth = server || target;
          // Only the last request in the queue may overwrite the screen; earlier replies would undo newer taps.
          if (server && control.inflight === 1) op.write(scope, server, { optimistic: false, data });
          else if (!server && control.inflight === 1) op.write(scope, target, { optimistic: false, data });
        } catch (error) {
          control.epoch += 1;
          op.write(scope, control.truth, { optimistic: false, reverted: true });
          notice(op.anchor || scope, describeError(error, op.failMessage), true);
        }
      } finally {
        control.inflight -= 1;
      }
    });
    return true;
  }

  window.cwOptimistic = { run, notice, describeError };
})();
