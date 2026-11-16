const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ejs = require('ejs');
const Community = require('../src/models/Community');
const communityController = require('../src/controllers/communityController');
const router = require('../src/routes/web');
const createApp = require('../src/app');
const { icon } = require('../src/utils/icons');
const request = require('supertest');

const findRoute = (path) => router.stack.find((layer) => layer.route?.path === path)?.route;

test('community map route is registered before the dynamic community page route', () => {
  const mapIndex = router.stack.findIndex((layer) => layer.route?.path === '/community-map');
  const detailIndex = router.stack.findIndex((layer) => layer.route?.path === '/communities/:slug');
  assert.ok(mapIndex >= 0);
  assert.ok(detailIndex >= 0);
  assert.ok(mapIndex < detailIndex);
});

test('community map queries public communities with shared locations or no selected location', async (t) => {
  let query;
  let selectedFields;
  const communities = [
    { _id: 'c1', name: 'Map Makers', slug: 'map-makers', isPrivate: false, showOnMap: true, locationLabel: 'London, UK', locationLat: 51.5, locationLng: -0.1 },
    { _id: 'c2', name: 'Wandering Makers', slug: 'wandering-makers', isPrivate: false, showOnMap: false }
  ];
  t.mock.method(Community, 'find', (filter) => {
    query = filter;
    return { sort: () => ({ limit: () => ({ select: (fields) => { selectedFields = fields; return { lean: () => Promise.resolve(communities) }; } }) }) };
  });
  t.mock.method(Community, 'distinct', () => Promise.resolve(['creative', 'learning']));
  const res = { render(view, data) { this.view = view; this.data = data; } };

  await communityController.communityMap({ query: {} }, res);

  assert.equal(query.isPrivate, false);
  assert.equal(query.$or[0].showOnMap, true);
  assert.match(selectedFields, /\bshowOnMap\b/);
  assert.deepEqual(query.$or[0].locationLat, { $gte: -90, $lte: 90 });
  assert.deepEqual(query.$or[0].locationLng, { $gte: -180, $lte: 180 });
  assert.ok(query.$or[1].$or.some((condition) => condition.locationLat?.$exists === false));
  assert.ok(query.$or[1].$or.some((condition) => condition.locationLng?.$exists === false));
  assert.deepEqual(res.data.mappedCommunities.map((community) => community.slug), ['map-makers']);
  assert.deepEqual(res.data.unmappedCommunities.map((community) => community.slug), ['wandering-makers']);
  assert.equal(res.view, 'pages/community-map');
  assert.deepEqual(res.data.mapCommunities, communities);
  assert.deepEqual(res.data.categories, ['creative', 'learning']);
});

test('unmapped community rows use a synthetic roaming label and never expose saved coordinates', async () => {
  const views = path.join(__dirname, '..', 'src', 'views');
  const html = await ejs.renderFile(path.join(views, 'partials', 'community-map-row.ejs'), {
    community: { name: 'Wandering Makers', slug: 'wandering-makers', locationLabel: '', locationLat: 51.5, locationLng: -0.1, hashtags: [], membersCount: 2 },
    mapped: false,
    icon
  });
  assert.match(html, /data-map-group="unmapped"/);
  assert.match(html, /data-lat="" data-lng=""/);
  assert.match(html, /Roaming · no location shared/);
  assert.match(html, /Find roaming dot/);
  assert.doesNotMatch(html, /data-lat="51\.5"/);
});

test('community radar route is registered and ranks communities by recent activity', async (t) => {
  const route = router.stack.find((layer) => layer.route?.path === '/communities/rising');
  assert.ok(route, 'the rising communities route should exist');

  const communities = [
    { _id: 'c1', name: 'Rising Readers', slug: 'rising-readers', description: 'Book lovers', category: 'learning', hashtags: ['books'], membersCount: 120, avatarImage: '', createdAt: new Date('2025-01-10') },
    { _id: 'c2', name: 'Quiet Makers', slug: 'quiet-makers', description: 'Makers', category: 'creative', hashtags: ['design'], membersCount: 30, avatarImage: '', createdAt: new Date('2025-01-18') }
  ];

  t.mock.method(Community, 'find', () => ({
    select: () => ({ sort: () => ({ lean: () => Promise.resolve(communities) }) })
  }));
  t.mock.method(Community, 'distinct', () => Promise.resolve(['learning', 'creative']));
  t.mock.method(require('../src/models/Post'), 'aggregate', () => Promise.resolve([
    { _id: 'c1', count: 9, likes: 28, commentSignals: 6, shares: 4, views: 120 },
    { _id: 'c2', count: 4, likes: 12, commentSignals: 3, shares: 2, views: 60 }
  ]));

  const res = { render(view, data) { this.view = view; this.data = data; } };
  await communityController.risingCommunities({ session: { user: { id: 'u1' } } }, res);

  assert.equal(res.view, 'pages/rising-communities');
  assert.ok(Array.isArray(res.data.risingCommunities));
  assert.equal(res.data.risingCommunities[0].slug, 'rising-readers');
  assert.ok(res.data.risingCommunities[0].score > res.data.risingCommunities[1].score);
});

test('Leaflet map assets are served locally and CSP permits both tile providers', async () => {
  const app = createApp({ port: 3000 });
  const [script, stylesheet, mapScript, mapPage, communitySettings] = await Promise.all([
    request(app).get('/vendor/leaflet/leaflet.js'),
    request(app).get('/vendor/leaflet/leaflet.css'),
    request(app).get('/js/community-map.js'),
    request(app).get('/community-map'),
    request(app).get('/communities/test-community/manage')
  ]);

  assert.equal(script.status, 200);
  assert.equal(stylesheet.status, 200);
  assert.equal(mapScript.status, 200);
  const policy = mapScript.headers['content-security-policy'];
  assert.match(policy, /https:\/\/\*\.basemaps\.cartocdn\.com/);
  assert.match(policy, /https:\/\/tile\.openstreetmap\.org/);
  assert.match(policy, /https:\/\/api\.maptiler\.com/);
  assert.equal(mapPage.headers['referrer-policy'], 'strict-origin-when-cross-origin');
  assert.equal(communitySettings.headers['referrer-policy'], 'strict-origin-when-cross-origin');
});

test('Google tag renders exactly once in the page head with an allowed CSP nonce', async () => {
  const response = await request(createApp({ port: 3000 })).get('/docs');
  assert.equal(response.status, 200);

  const head = response.text.match(/<head>[\s\S]*?<\/head>/)?.[0];
  assert.ok(head, 'page should contain a head element');
  assert.equal((head.match(/https:\/\/www\.googletagmanager\.com\/gtag\/js\?id=G-VW1V8S9J0V/g) || []).length, 1);
  assert.equal((head.match(/gtag\('config', 'G-VW1V8S9J0V'\)/g) || []).length, 1);

  const nonce = head.match(/<script nonce="([^"]+)">[\s\S]*?gtag\('config'/)?.[1];
  assert.ok(nonce, 'inline Google tag should have a CSP nonce');
  const policy = response.headers['content-security-policy'];
  assert.ok(policy.includes('https://www.googletagmanager.com'));
  assert.ok(policy.includes(`'nonce-${nonce}'`));
  assert.ok(policy.includes('https://www.google-analytics.com'));
});

test('map tile loading follows OSM policy and falls back to CARTO and optional MapTiler', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'community-map.js'), 'utf8');
  const mountMap = (apiKey) => {
    const urls = [];
    const options = [];
    const handlers = [];
    const warning = { hidden: true, textContent: '' };
    const mapContainer = { dataset: { mapApiKey: apiKey }, parentElement: { querySelector: () => warning } };
    const map = {
      setView() { return this; },
      on() {},
      removeLayer() {},
      getZoom() { return 2; }
    };
    const L = {
      map: () => map,
      tileLayer(url, layerOptions) {
        urls.push(url);
        options.push(layerOptions);
        return {
          addTo() { return this; },
          on(event, handler) { if (event === 'tileerror') handlers.push(handler); return this; }
        };
      }
    };
    const document = {
      querySelector: () => null,
      querySelectorAll: (selector) => selector === '[data-community-discovery-map]' ? [mapContainer] : []
    };
    vm.runInNewContext(source, { document, L, encodeURIComponent, Math });
    const failCurrentProvider = () => handlers.at(-1)();
    return { urls, options, warning, failCurrentProvider };
  };

  const noKey = mountMap('');
  assert.match(noKey.urls[0], /^https:\/\/tile\.openstreetmap\.org\/\{z\}\/\{x\}\/\{y\}\.png$/);
  assert.match(noKey.options[0].attribution, /OpenStreetMap contributors/);
  assert.equal(noKey.options[0].updateWhenIdle, true);
  assert.equal(noKey.options[0].updateWhenZooming, false);
  assert.equal(noKey.options[0].keepBuffer, 0);
  noKey.failCurrentProvider();
  assert.match(noKey.urls[1], /basemaps\.cartocdn\.com/);
  noKey.failCurrentProvider();
  assert.equal(noKey.urls.length, 2);
  assert.equal(noKey.warning.hidden, false);
  assert.match(noKey.warning.textContent, /OpenStreetMap and CARTO tiles are unavailable/);

  const withKey = mountMap('test-key');
  withKey.failCurrentProvider();
  assert.match(withKey.urls[1], /basemaps\.cartocdn\.com/);
  withKey.failCurrentProvider();
  assert.match(withKey.urls[2], /api\.maptiler\.com/);
  assert.match(withKey.urls[2], /key=test-key/);
});

test('discovery map colors markers and smoothly moves communities without shared locations', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'community-map.js'), 'utf8');
  const rows = [
    { dataset: { lat: '51.5', lng: '-0.1', members: '100', name: 'London Makers', location: 'London', category: 'creative', topics: '', slug: 'london-makers', mapGroup: 'mapped' }, querySelector: () => null },
    { dataset: { lat: '', lng: '', members: '10', name: 'Wandering Makers', location: 'Roaming somewhere', category: 'creative', topics: '', slug: 'wandering-makers', mapGroup: 'unmapped' }, querySelector: () => null }
  ];
  const markerOptions = [];
  const markers = [];
  const map = {
    setView() { return this; },
    fitBounds() { return this; },
    getZoom() { return 2; },
    on() {},
    flyTo() {}
  };
  const mapContainer = { dataset: { mapApiKey: '' }, parentElement: { querySelector: () => ({ hidden: true }) } };
  const count = { textContent: '' };
  const frameCallbacks = [];
  const sections = [
    { dataset: { mapSection: 'mapped' }, hidden: false, querySelector: () => ({ textContent: '' }) },
    { dataset: { mapSection: 'unmapped' }, hidden: false, querySelector: () => ({ textContent: '' }) }
  ];
  const randomValues = [0.01, 0.2, 0.4, 0.26, 0.5, 0.6, 0.3, 0.9, 0.9, 0.6, 0.7, 0.3];
  const math = Object.create(Math);
  math.random = () => randomValues.shift() ?? 0.5;
  let filterSearch;
  const search = { value: '', addEventListener: (event, callback) => { if (event === 'input') filterSearch = callback; } };
  let now = 0;
  const L = {
    map: () => map,
    tileLayer: () => ({ on() { return this; }, addTo() { return this; } }),
    circleMarker(position, options) {
      markerOptions.push(options);
      const marker = {
        position: { lat: position[0], lng: position[1] },
        addTo() { return this; },
        bindPopup() { return this; },
        getLatLng() { return this.position; },
        setLatLng(next) { this.position = { lat: next[0], lng: next[1] }; return this; },
        removeFrom() { return this; },
        openPopup() {}
      };
      markers.push(marker);
      return marker;
    },
    featureGroup: () => ({ getBounds: () => ({ pad: () => ({}) }) })
  };
  const document = {
    querySelector: (selector) => selector === '[data-map-search]' ? search : selector === '[data-map-category]' ? null : selector === '[data-map-count]' ? count : null,
    querySelectorAll: (selector) => selector === '[data-community-discovery-map]' ? [mapContainer] : selector === '[data-map-community]' ? rows : selector === '[data-map-section]' ? sections : [],
    createElement: () => ({ append() {}, className: '', textContent: '', href: '' })
  };

  vm.runInNewContext(source, {
    document, L, Math: math, encodeURIComponent,
    requestAnimationFrame: (callback) => frameCallbacks.push(callback),
    performance: { now: () => now }
  });

  assert.notEqual(markerOptions[0].fillColor, markerOptions[1].fillColor, 'each community receives its own random marker color');
  assert.equal(markerOptions[1].radius, 4, 'communities without a location get a small marker');
  assert.equal(frameCallbacks.length, 1, 'roaming markers start an animation loop');
  const startingPosition = { ...markers[1].position };
  now = 10000;
  frameCallbacks.shift()(now);
  assert.notDeepEqual(markers[1].position, startingPosition, 'the no-location marker moves over time');
  filterSearch();
  assert.equal(count.textContent, '2 communities shown');
  assert.equal(sections[0].hidden, false);
  assert.equal(sections[1].hidden, false);
});

test('current-location control rounds the pin and fills a broad reverse-geocoded label', async () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'community-map.js'), 'utf8');
  let onClick;
  let geoSuccess;
  let requestedUrl;
  let mapCenter;
  const latitudeInput = { value: '' };
  const longitudeInput = { value: '' };
  const showOnMap = { checked: false };
  const locationLabel = { value: '' };
  const locationStatus = { textContent: '' };
  const locationButton = { disabled: false, addEventListener: (event, callback) => { if (event === 'click') onClick = callback; } };
  const mapContainer = { dataset: { lat: '', lng: '', mapApiKey: 'test-key' }, parentElement: { querySelector: () => ({ hidden: true }) } };
  const map = {
    setView(center) { mapCenter = center; return this; },
    getZoom() { return 2; },
    on() {},
    removeLayer() {}
  };
  const document = {
    querySelector(selector) {
      return {
        '[data-location-lat]': latitudeInput,
        '[data-location-lng]': longitudeInput,
        '[data-show-on-map]': showOnMap,
        '[data-location-label]': locationLabel,
        '[data-use-current-location]': locationButton,
        '[data-location-status]': locationStatus
      }[selector] || null;
    },
    querySelectorAll: (selector) => selector === '[data-owner-location-map]' ? [mapContainer] : []
  };
  const L = {
    map: () => map,
    tileLayer: () => ({ on() { return this; }, addTo() { return this; } }),
    marker: () => ({ addTo() { return this; }, setLatLng() { return this; } })
  };
  const navigator = { geolocation: { getCurrentPosition: (success, failure, options) => { geoSuccess = { success, failure, options }; } } };
  const fetch = async (url) => {
    requestedUrl = String(url);
    return { ok: true, json: async () => ({ features: [{ place_type: ['locality'], text: 'Mountain View', context: [{ id: 'region.1', text: 'California' }, { id: 'country.1', text: 'United States' }] }] }) };
  };

  vm.runInNewContext(source, { document, L, navigator, fetch, URLSearchParams, encodeURIComponent, Math });
  onClick();
  assert.equal(locationButton.disabled, true);
  assert.equal(geoSuccess.options.enableHighAccuracy, false);
  await geoSuccess.success({ coords: { latitude: 37.4219, longitude: -122.0841 } });

  assert.equal(latitudeInput.value, '37.42');
  assert.equal(longitudeInput.value, '-122.08');
  assert.equal(showOnMap.checked, true);
  assert.equal(locationLabel.value, 'Mountain View, California, United States');
  assert.match(requestedUrl, /api\.maptiler\.com\/geocoding\/\-122\.08,37\.42/);
  assert.deepEqual(Array.from(mapCenter), [37.42, -122.08]);
  assert.equal(locationButton.disabled, false);
  assert.match(locationStatus.textContent, /Review it, then save community controls/);
});
