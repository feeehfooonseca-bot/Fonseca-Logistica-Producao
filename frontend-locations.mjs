import { ROUTE_API } from './frontend-quote.mjs';

export function createLocationState() {
  const points = new Map();
  return {
    set(id, address, point) { points.set(id, { address, lat: point.lat, lon: point.lon }); },
    clear(id) { points.delete(id); },
    get(id, address) {
      const point = points.get(id);
      return point?.address === address ? { lat: point.lat, lon: point.lon } : null;
    },
  };
}

let leafletPromise;
function loadLeaflet() {
  if (window.L) return Promise.resolve(window.L);
  if (!leafletPromise) leafletPromise = new Promise((resolve, reject) => {
    const css = document.createElement('link');
    css.rel = 'stylesheet'; css.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
    document.head.append(css);
    const script = document.createElement('script');
    script.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
    script.onload = () => window.L ? resolve(window.L) : reject(new Error('Mapa indisponível.'));
    script.onerror = () => reject(new Error('Não foi possível carregar o mapa. Confira sua conexão.'));
    document.head.append(script);
  });
  return leafletPromise;
}

export function setupLocations({ onChange }) {
  const state = createLocationState();
  const dialog = document.createElement('dialog');
  dialog.className = 'location-dialog';
  dialog.innerHTML = `<div class="location-dialog-head"><h2 id="locationTitle">Confirmar localização</h2><button type="button" data-close aria-label="Fechar mapa">×</button></div>
    <p>Toque no mapa para marcar o local exato. Amplie para conferir a entrada.</p>
    <form class="location-search"><label for="locationQuery">Buscar rua, estabelecimento ou cidade</label><div><input id="locationQuery" placeholder="Ex.: rua e cidade"><button type="submit">Buscar</button></div></form>
    <div class="location-results"></div><div class="location-map" aria-label="Mapa para selecionar localização"></div>
    <p class="location-message" role="status" aria-live="polite"></p>
    <div class="location-dialog-actions"><button type="button" data-gps>Usar minha localização</button><button type="button" data-confirm disabled>Confirmar ponto</button></div>`;
  dialog.setAttribute('aria-labelledby', 'locationTitle'); document.body.append(dialog);
  const mapEl = dialog.querySelector('.location-map');
  const message = dialog.querySelector('.location-message');
  const confirm = dialog.querySelector('[data-confirm]');
  const gps = dialog.querySelector('[data-gps]');
  const form = dialog.querySelector('form');
  const searchButton = form.querySelector('button');
  const query = dialog.querySelector('input');
  const results = dialog.querySelector('.location-results');
  let map, marker, activeInput, activeNote, selected, L, generation = 0, searchAbort;
  const icon = () => L.divIcon({ className: 'location-pin', html: '<span></span>', iconSize: [24, 24], iconAnchor: [12, 12] });
  function select(lat, lon) {
    selected = { lat, lon }; confirm.disabled = false;
    if (marker) marker.setLatLng([lat, lon]);
    else marker = L.marker([lat, lon], { icon: icon() }).addTo(map);
    message.textContent = 'Ponto marcado. Confira o local antes de confirmar.';
  }
  dialog.querySelector('[data-close]').onclick = () => dialog.close();
  dialog.addEventListener('close', () => { generation++; searchAbort?.abort(); gps.disabled = false; activeInput?.focus(); });
  form.onsubmit = async event => {
    event.preventDefault(); const text = query.value.trim(); if (text.length < 3) { message.textContent = 'Informe rua e cidade para buscar.'; return; }
    searchAbort?.abort(); searchAbort = new AbortController();
    const signal = searchAbort.signal, current = generation;
    results.replaceChildren(); message.textContent = 'Buscando…';
    try {
      const response = await fetch(`${ROUTE_API}/locations/search`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }), signal });
      const payload = await response.json();
      if (signal.aborted || current !== generation || !dialog.open) return;
      if (!response.ok) throw new Error(payload.error || 'Busca indisponível. Marque o ponto diretamente no mapa.');
      for (const result of payload.results || []) {
        const button = document.createElement('button'); button.type = 'button';
        button.textContent = result.label + (result.approximate ? ' — localização aproximada' : '');
        button.onclick = () => {
          map.setView([result.lat, result.lon], result.approximate ? 14 : 17);
          // Search results guide the map; only an explicit map click confirms the delivery point.
          selected = null; confirm.disabled = true; if (marker) { marker.remove(); marker = null; }
          message.textContent = 'Toque no local exato no mapa para marcar o ponto.';
        }; results.append(button);
      }
      message.textContent = results.childElementCount ? 'Escolha um resultado e marque o ponto exato no mapa.' : 'Endereço não encontrado. Navegue no mapa e marque o local.';
    } catch (error) { if (!signal.aborted && current === generation) message.textContent = error.message; }
  };
  gps.onclick = () => {
    if (!navigator.geolocation) { message.textContent = 'Localização indisponível. Marque o ponto no mapa.'; return; }
    const current = generation; gps.disabled = true; message.textContent = 'Obtendo sua localização…';
    navigator.geolocation.getCurrentPosition(position => {
      if (current !== generation || !dialog.open) return;
      gps.disabled = false;
      map.setView([position.coords.latitude, position.coords.longitude], 17);
      select(position.coords.latitude, position.coords.longitude);
      message.textContent = `Localização recebida (precisão aproximada de ${Math.ceil(position.coords.accuracy)} m). Ajuste o ponto no mapa se necessário.`;
    }, () => {
      if (current !== generation || !dialog.open) return;
      gps.disabled = false; message.textContent = 'Não foi possível obter sua localização. Permita o acesso ou marque o ponto no mapa.';
    }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 });
  };
  confirm.onclick = () => {
    if (!selected || !activeInput?.isConnected) return;
    if (!activeInput.value.trim()) activeInput.value = 'Local marcado no mapa';
    state.set(activeInput.id, activeInput.value.trim(), selected);
    activeNote.textContent = 'Ponto confirmado no mapa. Se editar o endereço, confirme novamente.';
    onChange(); dialog.close();
  };
  async function open(input, note) {
    activeInput = input; activeNote = note; generation++; selected = null; confirm.disabled = true; gps.disabled = true; searchButton.disabled = true;
    const current = generation;
    results.replaceChildren(); query.value = input.value.trim(); message.textContent = 'Carregando mapa…';
    dialog.showModal();
    try {
      L = await loadLeaflet(); if (!dialog.open || current !== generation) return;
      if (!map) {
        map = L.map(mapEl).setView([-26.25, -49.38], 13);
        L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
          maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
        }).addTo(map);
        map.on('click', event => select(event.latlng.lat, event.latlng.lng));
        mapEl.addEventListener('keydown', event => {
          if (event.key === 'Enter') { event.preventDefault(); const center = map.getCenter(); select(center.lat, center.lng); }
        });
      }
      map.invalidateSize();
      gps.disabled = false;
      searchButton.disabled = false;
      if (marker) { marker.remove(); marker = null; }
      const previous = state.get(input.id, input.value.trim());
      map.setView(previous ? [previous.lat, previous.lon] : [-26.25, -49.38], previous ? 17 : 13);
      if (previous) select(previous.lat, previous.lon);
      else message.textContent = 'Busque uma rua ou cidade, ou toque no mapa para marcar o local.';
    } catch (error) { if (current === generation) message.textContent = error.message; }
  }
  function bind(root = document) {
    root.querySelectorAll('#dcPickup, .delivery-address').forEach(input => {
      if (input.dataset.locationBound) return; input.dataset.locationBound = '1';
      const controls = document.createElement('div'); controls.className = 'location-controls';
      const button = document.createElement('button'); button.type = 'button'; button.textContent = 'Não encontrou? Marcar no mapa';
      const note = document.createElement('small'); note.setAttribute('aria-live', 'polite');
      controls.append(button, note); input.closest('.address-input-wrap').after(controls);
      button.onclick = () => open(input, note);
      input.addEventListener('input', () => { state.clear(input.id); note.textContent = ''; onChange(); });
    });
  }
  bind();
  return { bind, state, locations(pickup, deliveries) {
    const points = { pickup: state.get('dcPickup', pickup), deliveries: deliveries.map(delivery => state.get(delivery.inputId, delivery.address)) };
    return points.pickup || points.deliveries.some(Boolean) ? points : undefined;
  } };
}
