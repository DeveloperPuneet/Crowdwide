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
    layer = L.tileLayer(providers[providerIndex].url, { maxZoom: 19, attribution: providers[providerIndex].attribution });
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
          : 'The no-key map services are unavailable on this network. Add a browser-restricted MAPTILER_API_KEY to enable the fallback; the community list remains available.';
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
  const clearButton = document.querySelector('[data-clear-community-location]');
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
  };
  if (hasLocation) marker = L.marker([latitude, longitude]).addTo(map);
  map.on('click', (event) => setLocation(event.latlng.lat, event.latlng.lng));
  clearButton?.addEventListener('click', () => {
    latitudeInput.value = '';
    longitudeInput.value = '';
    locationLabel.value = '';
    showOnMap.checked = false;
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
