const tileProviders = [
  { url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>' },
  { url: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', attribution: '&copy; OpenStreetMap contributors &copy; CARTO' }
];

function addResilientTiles(map, mapContainer) {
  const tileError = mapContainer.parentElement.querySelector('[data-map-tile-error]');
  const apiKey = mapContainer.dataset.mapApiKey || '';
  const providers = [...tileProviders];
  if (apiKey) {
    providers.push({
      url: `https://api.maptiler.com/maps/streets/{z}/{x}/{y}.png?key=${encodeURIComponent(apiKey)}`,
      attribution: '&copy; MapTiler &copy; OpenStreetMap contributors'
    });
  }
  let providerIndex = 0;
  let handlingFailure = false;
  let layer;
  const loadProvider = () => {
    handlingFailure = false;
    layer = L.tileLayer(providers[providerIndex].url, {
      maxZoom: 19,
      attribution: providers[providerIndex].attribution,
      updateWhenIdle: true,
      updateWhenZooming: false,
      keepBuffer: 0,
      detectRetina: false
    });
    layer.on('tileerror', () => {
      if (handlingFailure) return;
      handlingFailure = true;
      if (providerIndex < providers.length - 1) {
        map.removeLayer(layer);
        providerIndex += 1;
        loadProvider();
      } else if (tileError) {
        tileError.textContent = apiKey
          ? 'Map tiles could not be loaded. Check your MAPTILER_API_KEY and network access. The community list remains available.'
          : 'OpenStreetMap and CARTO tiles are unavailable on this network. Add a browser-restricted MAPTILER_API_KEY to enable the fallback; the community list remains available.';
        tileError.hidden = false;
      }
    });
    layer.addTo(map);
  };
  loadProvider();
}

function addLocationPicker(mapContainer) {
  const latitudeInput = document.querySelector('[data-location-lat]');
  const longitudeInput = document.querySelector('[data-location-lng]');
  const showOnMap = document.querySelector('[data-show-on-map]');
  const locationLabel = document.querySelector('[data-location-label]');
  const useCurrentLocationButton = document.querySelector('[data-use-current-location]');
  const locationStatus = document.querySelector('[data-location-status]');
  const clearButton = document.querySelector('[data-clear-community-location]');
  const apiKey = mapContainer.dataset.mapApiKey || '';
  const latitude = Number(mapContainer.dataset.lat);
  const longitude = Number(mapContainer.dataset.lng);
  const hasLocation = Number.isFinite(latitude) && Number.isFinite(longitude) && mapContainer.dataset.lat !== '' && mapContainer.dataset.lng !== '';
  const map = L.map(mapContainer, { scrollWheelZoom: false }).setView(hasLocation ? [latitude, longitude] : [20, 0], hasLocation ? 7 : 2);
  addResilientTiles(map, mapContainer);
  let marker = null;
  const setLocation = (lat, lng) => {
    const roundedLat = Number(lat.toFixed(2));
    const roundedLng = Number(lng.toFixed(2));
    latitudeInput.value = String(roundedLat);
    longitudeInput.value = String(roundedLng);
    if (marker) marker.setLatLng([roundedLat, roundedLng]);
    else marker = L.marker([roundedLat, roundedLng]).addTo(map);
    showOnMap.checked = true;
    map.setView([roundedLat, roundedLng], Math.max(map.getZoom(), 7));
  };
  const reverseGeocode = async (lat, lng) => {
    if (!apiKey) return '';
    const params = new URLSearchParams({ key: apiKey, limit: '1', types: 'place,locality,district,region,country' });
    const response = await fetch(`https://api.maptiler.com/geocoding/${lng},${lat}.json?${params}`, {
      headers: { Accept: 'application/json' },
      credentials: 'omit'
    });
    if (!response.ok) return '';
    const data = await response.json();
    const feature = data.features?.[0];
    if (!feature) return '';
    const broadTypes = new Set(['place', 'locality', 'district', 'region', 'country']);
    const names = [];
    if ((feature.place_type || []).some((type) => broadTypes.has(type)) && feature.text) names.push(feature.text);
    for (const item of feature.context || []) {
      const type = String(item.id || '').split('.')[0];
      if (broadTypes.has(type) && item.text) names.push(item.text);
    }
    return [...new Set(names)].slice(0, 4).join(', ');
  };
  useCurrentLocationButton?.addEventListener('click', () => {
    if (!navigator.geolocation) {
      if (locationStatus) locationStatus.textContent = 'This browser does not support location access.';
      return;
    }
    useCurrentLocationButton.disabled = true;
    if (locationStatus) locationStatus.textContent = 'Requesting location permission…';
    navigator.geolocation.getCurrentPosition(async ({ coords }) => {
      const lat = Number(coords.latitude.toFixed(2));
      const lng = Number(coords.longitude.toFixed(2));
      setLocation(lat, lng);
      locationLabel.value = 'Approximate location';
      if (locationStatus) locationStatus.textContent = 'Pin set to an approximate location. Finding a city or region…';
      if (apiKey) {
        try {
          const placeName = await reverseGeocode(lat, lng);
          if (placeName) locationLabel.value = placeName.slice(0, 100);
        } catch (error) {
          // Keep the approximate location label if reverse geocoding is unavailable.
        }
      }
      if (locationStatus) locationStatus.textContent = `Location set: ${locationLabel.value}. Review it, then save community controls.`;
      useCurrentLocationButton.disabled = false;
    }, (error) => {
      const messages = {
        1: 'Location permission was denied. Allow location access in your browser settings and try again.',
        2: 'Your current location is unavailable. Try again or click the map to place the pin.',
        3: 'Location request timed out. Try again or click the map to place the pin.'
      };
      if (locationStatus) locationStatus.textContent = messages[error.code] || 'Could not get your location. Try again or click the map to place the pin.';
      useCurrentLocationButton.disabled = false;
    }, { enableHighAccuracy: false, maximumAge: 60000, timeout: 12000 });
  });
  if (hasLocation) marker = L.marker([latitude, longitude]).addTo(map);
  map.on('click', (event) => setLocation(event.latlng.lat, event.latlng.lng));
  clearButton?.addEventListener('click', () => {
    latitudeInput.value = '';
    longitudeInput.value = '';
    locationLabel.value = '';
    showOnMap.checked = false;
    if (locationStatus) locationStatus.textContent = '';
    if (marker) map.removeLayer(marker);
    marker = null;
  });
}

function addDiscoveryMap(mapContainer) {
  const searchInput = document.querySelector('[data-map-search]');
  const categorySelect = document.querySelector('[data-map-category]');
  const countOutput = document.querySelector('[data-map-count]');
  const emptyMessage = document.querySelector('[data-map-empty]');
  const rows = [...document.querySelectorAll('[data-map-community]')];
  const map = L.map(mapContainer).setView([20, 0], 2);
  addResilientTiles(map, mapContainer);
  const markers = rows.map((row) => {
    const lat = Number(row.dataset.lat);
    const lng = Number(row.dataset.lng);
    const members = Number(row.dataset.members) || 0;
    const marker = L.circleMarker([lat, lng], {
      radius: Math.min(18, 7 + Math.sqrt(members) / 5),
      color: '#f8ab62',
      weight: 2,
      fillColor: '#44bdb0',
      fillOpacity: 0.78
    });
    const popup = document.createElement('div');
    popup.className = 'community-map-popup';
    const name = document.createElement('strong');
    name.textContent = row.dataset.name;
    const location = document.createElement('span');
    location.textContent = row.dataset.location;
    const link = document.createElement('a');
    link.href = `/communities/${encodeURIComponent(row.dataset.slug)}`;
    link.textContent = 'Open community';
    popup.append(name, location, link);
    marker.bindPopup(popup);
    marker.addTo(map);
    row.querySelector('[data-map-focus]')?.addEventListener('click', () => {
      map.flyTo([lat, lng], Math.max(map.getZoom(), 7), { duration: 0.45 });
      marker.openPopup();
    });
    return { row, marker, searchText: `${row.dataset.name} ${row.dataset.location} ${row.dataset.category} ${row.dataset.topics}`.toLowerCase() };
  });
  if (markers.length > 1) map.fitBounds(L.featureGroup(markers.map(({ marker }) => marker)).getBounds().pad(0.12), { maxZoom: 8 });
  else if (markers.length === 1) map.setView(markers[0].marker.getLatLng(), 7);

  const filterResults = () => {
    const query = (searchInput?.value || '').trim().toLowerCase();
    const category = categorySelect?.value || '';
    let visible = 0;
    markers.forEach(({ row, marker, searchText }) => {
      const matches = (!query || searchText.includes(query)) && (!category || row.dataset.category === category);
      if (matches) {
        marker.addTo(map);
        row.hidden = false;
        visible += 1;
      } else {
        marker.removeFrom(map);
        row.hidden = true;
      }
    });
    if (countOutput) countOutput.textContent = `${visible} mapped communit${visible === 1 ? 'y' : 'ies'}`;
    if (emptyMessage) emptyMessage.hidden = visible > 0;
  };
  searchInput?.addEventListener('input', filterResults);
  categorySelect?.addEventListener('change', filterResults);
}

document.querySelectorAll('[data-owner-location-map]').forEach(addLocationPicker);
document.querySelectorAll('[data-community-discovery-map]').forEach(addDiscoveryMap);
