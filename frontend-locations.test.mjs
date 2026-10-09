import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocationState } from './frontend-locations.mjs';
import { requestOfficialQuote } from './frontend-quote.mjs';

test('ponto pertence ao endereço confirmado e é invalidado ao editar ou limpar', () => {
  const state = createLocationState();
  state.set('pickup', 'Rua A', { lat: -26.2, lon: -49.3 });
  state.set('delivery', 'Rua B', { lat: -26.4, lon: -49.5 });
  assert.deepEqual(state.get('pickup', 'Rua A'), { lat: -26.2, lon: -49.3 });
  assert.equal(state.get('pickup', 'Rua nova'), null);
  state.clear('pickup');
  assert.equal(state.get('pickup', 'Rua A'), null);
  assert.deepEqual(state.get('delivery', 'Rua B'), { lat: -26.4, lon: -49.5 });
});

test('frontend rejeita servidor antigo que ignora coordenadas e ponto diferente do confirmado', async () => {
  const locations = { pickup: { lat: -26.2, lon: -49.3 }, deliveries: [null] };
  const quote = { ok: true, deliveries: [{ address: 'Rua B', price: 15, distanceKm: 8 }], totalPrice: 15 };
  for (const returned of [undefined, { pickup: { lat: -26.1, lon: -49.3 }, deliveries: [{ lat: -26.4, lon: -49.5 }] }]) {
    await assert.rejects(requestOfficialQuote('Rua A', [{ address: 'Rua B' }], async () =>
      new Response(JSON.stringify({ ...quote, locations: returned })), locations), /não confirmou os pontos/);
  }
  let sent;
  const result = await requestOfficialQuote('Rua A', [{ address: 'Rua B' }], async (_, options) => {
    sent = JSON.parse(options.body);
    return new Response(JSON.stringify({ ...quote, locations: { pickup: locations.pickup, deliveries: [{ lat: -26.4, lon: -49.5 }] } }));
  }, locations);
  assert.deepEqual(sent.locations, locations);
  assert.equal(result.totalPrice, 15);
});
