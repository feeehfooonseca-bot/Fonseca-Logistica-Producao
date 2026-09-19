import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workerSource = await readFile(new URL("./worker.js", import.meta.url), "utf8");
const workerModule = await import(
  `data:text/javascript;base64,${Buffer.from(workerSource).toString("base64")}`
);

const { calculatePrice } = workerModule;

test("tarifa local comum usa oneWayKm e inclui os primeiros 12 km", () => {
  assert.equal(calculatePrice(localPrice(8)), 15);
  assert.equal(calculatePrice(localPrice(12)), 15);
  assert.equal(calculatePrice(localPrice(12.1)), 16);
  assert.equal(calculatePrice(localPrice(15)), 19);
});

test("arredonda o valor final sempre para cima em reais inteiros", () => {
  assert.equal(calculatePrice(externalPrice(15 / 1.1)), 15);
  assert.equal(calculatePrice(externalPrice(15.01 / 1.1)), 16);
  assert.equal(calculatePrice(externalPrice(15.5 / 1.1)), 16);
  assert.equal(calculatePrice(externalPrice(16.65 / 1.1)), 17);
  assert.equal(calculatePrice(externalPrice(19.95 / 1.1)), 20);
  assert.equal(calculatePrice(externalPrice(20 / 1.1)), 20);
});

test("preserva as tarifas especiais usando a distância total do circuito", () => {
  assert.equal(calculatePrice(specialPrice("Rio Vermelho Povoado", 8)), 20);
  assert.equal(calculatePrice(specialPrice("RIO VERMELHO POVOADO", 9)), 22);
  assert.equal(calculatePrice(specialPrice("Rio Vermelho - Estação", 12)), 25);
  assert.equal(calculatePrice(specialPrice("Rio Vermelho Estacao", 13)), 27);
  assert.equal(calculatePrice(specialPrice("Rio Natal", 16)), 30);
  assert.equal(calculatePrice(specialPrice("Rio Natal", 17)), 32);
});

test("viagem externa cobra o km total e ignora oneWayKm", () => {
  assert.equal(calculatePrice(externalPrice(30, 1)), 33);
  assert.equal(calculatePrice(externalPrice(30, 999)), 33);
});

function localPrice(oneWayKm) {
  return { deliveryAddress: "Centro", isOutsideSBS: false, oneWayKm, totalKm: 99 };
}

function externalPrice(totalKm, oneWayKm = 5) {
  return { deliveryAddress: "Outra cidade", isOutsideSBS: true, oneWayKm, totalKm };
}

function specialPrice(deliveryAddress, totalKm) {
  return { deliveryAddress, isOutsideSBS: false, oneWayKm: 100, totalKm };
}

const pointsByAddress = {
  Base: { lat: -26.1, lon: -49.1, city: "São Bento do Sul" },
  Coleta: { lat: -26.2, lon: -49.2, city: "São Bento do Sul" },
  "Coleta externa": { lat: -26.25, lon: -49.25, city: "Campo Alegre" },
  Local: { lat: -26.3, lon: -49.3, city: "São Bento do Sul" },
  "Local longe": { lat: -26.31, lon: -49.31, city: "São Bento do Sul" },
  "Estrada Floresta": { lat: -26.32, lon: -49.32, city: "São Bento do Sul", suburb: "Rio Natal" },
  Externa: { lat: -26.4, lon: -49.4, city: "Campo Alegre" },
  "Externa 2": { lat: -26.5, lon: -49.5, city: "Joinville" },
};

const routeByDeliveryLat = {
  "-26.3": { distance: 14_000, legs: [4_000, 6_000, 4_000] },
  "-26.31": { distance: 18_000, legs: [5_000, 8_000, 5_000] },
  "-26.32": { distance: 17_000, legs: [5_000, 7_000, 5_000] },
  "-26.4": { distance: 30_100, legs: [2_600, 4_500, 23_000] },
  "-26.5": { distance: 20_100, legs: [3_000, 5_000, 12_100] },
};

function geoapifyResponse(body) {
  return new Response(JSON.stringify(body), { status: 200 });
}

async function requestQuote(body) {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(input);
    calls.push(url);
    if (url.pathname === "/v1/geocode/search") {
      const point = pointsByAddress[url.searchParams.get("text")];
      return geoapifyResponse({ results: point ? [point] : [] });
    }
    assert.equal(url.pathname, "/v1/routing");
    const deliveryLat = url.searchParams.get("waypoints").split("|")[2].split(",")[0];
    const route = routeByDeliveryLat[deliveryLat];
    return geoapifyResponse({
      features: [{ properties: {
        distance: route.distance,
        legs: route.legs.map((distance) => ({ distance })),
      } }],
    });
  };

  try {
    const response = await workerModule.default.fetch(
      new Request("https://worker.example.test/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
      { GEOAPIFY_API_KEY: "test-key", ENDERECO_BASE: "Base" },
    );
    return { response, body: await response.json(), calls };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function callsAt(calls, path) {
  return calls.filter((url) => url.pathname.includes(path));
}

function geocodeCount(calls, address) {
  return callsAt(calls, "/geocode/search").filter(
    (url) => url.searchParams.get("text") === address,
  ).length;
}

test("formato legado preserva contrato, ignora preço cliente e usa SHORT motorcycle", async () => {
  const { response, body, calls } = await requestQuote({ pickup: "Coleta", delivery: "Local", price: 1 });
  const routing = callsAt(calls, "/routing");
  assert.equal(response.status, 200);
  assert.equal(routing.length, 1);
  assert.equal(routing[0].searchParams.get("type"), "short");
  assert.equal(routing[0].searchParams.get("mode"), "motorcycle");
  assert.equal(body.price, 15);
  assert.equal(body.totalPrice, 15);
  assert.equal(body.oneWayKm, 10);
  assert.equal(body.distanceKm, 14);
  assert.equal(body.distanceKmBalanced, null);
  assert.equal(body.km, 14);
  assert.deepEqual(body.delivery, { lat: -26.3, lon: -49.3 });
  assert.equal(body.deliveries[0].classification, "local");
  assert.notEqual(body.price, 1);
});

test("novo formato aceita uma entrega", async () => {
  const { response, body } = await requestQuote({ pickup: "Coleta", deliveries: ["Local"] });
  assert.equal(response.status, 200);
  assert.equal(body.deliveries.length, 1);
  assert.equal(body.deliveries[0].price, 15);
  assert.equal(body.totalPrice, 15);
  assert.equal(body.price, undefined);
});

test("duas locais são calculadas por circuitos próprios e somadas após arredondar", async () => {
  const { body, calls } = await requestQuote({
    pickup: "Coleta", deliveries: ["Local", "Local longe"], price: 999,
  });
  const routing = callsAt(calls, "/routing");
  assert.deepEqual(body.deliveries.map((item) => item.price), [15, 17]);
  assert.deepEqual(body.deliveries.map((item) => item.oneWayKm), [10, 13]);
  assert.equal(body.totalPrice, 32);
  assert.equal(routing.length, 2);
  assert.ok(routing[0].searchParams.get("waypoints").includes("-26.3,-49.3"));
  assert.ok(routing[1].searchParams.get("waypoints").includes("-26.31,-49.31"));
  assert.ok(routing.every((url) => url.searchParams.get("type") === "short"));
});

test("local comum e região especial mantêm cálculos independentes", async () => {
  const { body } = await requestQuote({ pickup: "Coleta", deliveries: ["Local", "Estrada Floresta"] });
  assert.deepEqual(body.deliveries.map((item) => item.classification), ["local", "rio_natal"]);
  assert.deepEqual(body.deliveries.map((item) => item.relevantDistanceKm), [10, 17]);
  assert.deepEqual(body.deliveries.map((item) => item.price), [15, 32]);
  assert.equal(body.totalPrice, 47);
});

test("local e viagem selecionam uma rota SHORT e uma BALANCED", async () => {
  const { body, calls } = await requestQuote({ pickup: "Coleta", deliveries: ["Local", "Externa"] });
  const routing = callsAt(calls, "/routing");
  assert.deepEqual(routing.map((url) => url.searchParams.get("type")), ["short", "balanced"]);
  assert.ok(routing.every((url) => url.searchParams.get("mode") === "motorcycle"));
  assert.deepEqual(body.deliveries.map((item) => item.classification), ["local", "viagem"]);
  assert.deepEqual(body.deliveries.map((item) => item.price), [15, 34]);
  assert.equal(body.totalPrice, 49);
});

test("múltiplas viagens usam e arredondam seus circuitos completos individualmente", async () => {
  const { body, calls } = await requestQuote({ pickup: "Coleta", deliveries: ["Externa", "Externa 2"] });
  assert.deepEqual(body.deliveries.map((item) => item.distanceKm), [30.1, 20.1]);
  assert.deepEqual(body.deliveries.map((item) => item.price), [34, 23]);
  assert.equal(body.totalPrice, 57);
  assert.ok(callsAt(calls, "/routing").every((url) => url.searchParams.get("type") === "balanced"));
});

test("coleta externa torna todas as entregas viagens", async () => {
  const { body, calls } = await requestQuote({ pickup: "Coleta externa", deliveries: ["Local", "Local longe"] });
  assert.deepEqual(body.deliveries.map((item) => item.classification), ["viagem", "viagem"]);
  assert.deepEqual(body.deliveries.map((item) => item.price), [16, 20]);
  assert.ok(callsAt(calls, "/routing").every((url) => url.searchParams.get("type") === "balanced"));
});

test("geocodifica base e coleta uma vez, cada entrega uma vez, e roteia uma vez por entrega", async () => {
  const { calls } = await requestQuote({ pickup: "Coleta", deliveries: ["Local", "Local longe", "Externa"] });
  assert.equal(geocodeCount(calls, "Base"), 1);
  assert.equal(geocodeCount(calls, "Coleta"), 1);
  assert.equal(geocodeCount(calls, "Local"), 1);
  assert.equal(geocodeCount(calls, "Local longe"), 1);
  assert.equal(geocodeCount(calls, "Externa"), 1);
  assert.equal(callsAt(calls, "/geocode/search").length, 5);
  assert.equal(callsAt(calls, "/routing").length, 3);
});

test("rejeita deliveries vazio, endereço vazio, tipo inválido ou ausência de entrega", async (t) => {
  for (const body of [
    { pickup: "Coleta", deliveries: [] },
    { pickup: "Coleta", deliveries: [""] },
    { pickup: "Coleta", deliveries: [123] },
    { pickup: "Coleta", delivery: {} },
    { pickup: "Coleta" },
  ]) {
    await t.test(JSON.stringify(body), async () => {
      const result = await requestQuote(body);
      assert.equal(result.response.status, 400);
      assert.equal(result.calls.length, 0);
    });
  }
});
