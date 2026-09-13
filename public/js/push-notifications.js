// Push notifications are strictly opt-in: nothing here runs automatically.
// The service worker is only registered, and permission only requested,
// after the user clicks the "Enable push notifications" button below.
(function () {
  const toggle = document.getElementById('push-toggle');
  if (!toggle) return; // Not on the notifications settings page.

  const statusText = document.getElementById('push-status');
  const csrfToken = document.querySelector('meta[name="csrf-token"]')?.content;

  function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const rawData = window.atob(base64);
    return Uint8Array.from([...rawData].map((char) => char.charCodeAt(0)));
  }

  async function postJson(url, body) {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
      body: JSON.stringify(body || {})
    });
    if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || 'Request failed.');
    return response.json();
  }

  function setStatus(message) {
    if (statusText) statusText.textContent = message;
  }

  async function getExistingSubscription() {
    if (!('serviceWorker' in navigator)) return null;
    const registration = await navigator.serviceWorker.getRegistration('/sw.js');
    return registration ? registration.pushManager.getSubscription() : null;
  }

  async function refreshToggleState() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      toggle.disabled = true;
      setStatus('Push notifications are not supported in this browser.');
      return;
    }
    if (Notification.permission === 'denied') {
      toggle.disabled = true;
      setStatus('Notifications are blocked for this site in your browser settings.');
      return;
    }
    const subscription = await getExistingSubscription();
    toggle.checked = Boolean(subscription);
    setStatus(subscription ? 'Push notifications are on for this device.' : 'Push notifications are off for this device.');
  }

  async function enable() {
    setStatus('Requesting permission…');
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      toggle.checked = false;
      setStatus('Permission was not granted, so push notifications stayed off.');
      return;
    }
    const { publicKey } = await (await fetch('/settings/push/public-key')).json();
    const registration = await navigator.serviceWorker.register('/sw.js');
    await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey)
    });
    await postJson('/settings/push/subscribe', { subscription: subscription.toJSON() });
    setStatus('Push notifications are on for this device.');
  }

  async function disable() {
    const subscription = await getExistingSubscription();
    if (subscription) {
      await postJson('/settings/push/unsubscribe', { endpoint: subscription.endpoint });
      await subscription.unsubscribe();
    }
    setStatus('Push notifications are off for this device.');
  }

  toggle.addEventListener('change', async () => {
    toggle.disabled = true;
    try {
      if (toggle.checked) await enable();
      else await disable();
    } catch (error) {
      toggle.checked = !toggle.checked;
      setStatus(error.message || 'Something went wrong. Try again.');
    } finally {
      toggle.disabled = false;
    }
  });

  refreshToggleState();
})();
