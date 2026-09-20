// Tiny axios-compatible client built on fetch(), served from our own origin.
//
// The site used to load axios from a public CDN. Where that CDN is slow or
// blocked (some ISPs block jsDelivr), `window.axios` never appeared, every
// "async" form silently fell back to a full page reload, and background
// features (notification badge, infinite scroll) never started. Owning this
// file removes that dependency: it is tiny, cached, and always available.
(function () {
  const JSON_TYPE = /json/i;

  function withParams(url, params) {
    if (!params) return url;
    const query = new URLSearchParams(params).toString();
    if (!query) return url;
    return url + (url.includes('?') ? '&' : '?') + query;
  }

  async function request(method, url, data, config = {}) {
    const headers = new Headers(config.headers || {});
    let body;
    if (data instanceof URLSearchParams || data instanceof FormData || typeof data === 'string') {
      body = data; // the browser sets the right Content-Type (and multipart boundary)
    } else if (data !== undefined && data !== null) {
      body = JSON.stringify(data);
      if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
    }
    const response = await fetch(withParams(url, config.params), {
      method,
      headers,
      body,
      credentials: 'same-origin',
      signal: config.signal
    });
    const type = response.headers.get('content-type') || '';
    let payload = null;
    try {
      payload = JSON_TYPE.test(type) ? await response.json() : await response.text();
    } catch (error) { /* empty body */ }
    const result = { data: payload, status: response.status, headers: response.headers };
    if (!response.ok) {
      const error = new Error(`Request failed with status ${response.status}`);
      error.response = result;
      throw error;
    }
    return result;
  }

  window.axios = {
    get: (url, config) => request('GET', url, undefined, config),
    post: (url, data, config) => request('POST', url, data, config)
  };
})();
