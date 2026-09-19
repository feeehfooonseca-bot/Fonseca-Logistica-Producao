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
  Local: { lat: -26.3, lon: -49.3, city: "São Bento do Sul" },
  Externa: { lat: -26.4, lon: -49.4, city: "Campo Alegre" },
};

function geoapifyResponse(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

async function requestQuote(delivery, extraBody = {}) {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(input);
    calls.push(url);
    if (url.pathname === "/v1/geocode/search") {
      const point = pointsByAddress[url.searchParams.get("text")];
      return geoapifyResponse({
        results: point ? [{ lat: point.lat, lon: point.lon, city: point.city }] : [],
      });
    }

    assert.equal(url.pathname, "/v1/routing");
    const isBalanced = url.searchParams.get("type") === "balanced";
    const legs = isBalanced
      ? [{ distance: 2_600 }, { distance: 4_500 }, { distance: 22_900 }]
      : [{ distance: 5_000 }, { distance: 7_100 }, { distance: 3_600 }];
    return geoapifyResponse({
      features: [{ properties: { distance: isBalanced ? 30_000 : 15_700, legs } }],
    });
  };

  try {
    const response = await workerModule.default.fetch(
      new Request("https://worker.example.test/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pickup: "Coleta", delivery, ...extraBody }),
      }),
      { GEOAPIFY_API_KEY: "test-key", ENDERECO_BASE: "Base" },
    );
    return { response, body: await response.json(), calls };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("orçamento local retorna preço oficial com uma rota SHORT motorcycle", async () => {
  const { response, body, calls } = await requestQuote("Local", { price: 1 });
  const routingCalls = calls.filter((url) => url.pathname.includes("/routing"));

  assert.equal(response.status, 200);
  assert.equal(routingCalls.length, 1);
  assert.equal(routingCalls[0].searchParams.get("type"), "short");
  assert.equal(routingCalls[0].searchParams.get("mode"), "motorcycle");
  assert.equal(body.price, 16);
  assert.equal(body.oneWayKm, 12.1);
  assert.equal(body.distanceKm, 15.7);
  assert.equal(body.distanceKmBalanced, null);
  assert.notEqual(body.price, 1);
});

test("orçamento externo retorna preço pelo circuito com uma rota BALANCED", async () => {
  const { response, body, calls } = await requestQuote("Externa");
  const routingCalls = calls.filter((url) => url.pathname.includes("/routing"));

  assert.equal(response.status, 200);
  assert.equal(routingCalls.length, 1);
  assert.equal(routingCalls[0].searchParams.get("type"), "balanced");
  assert.equal(routingCalls[0].searchParams.get("mode"), "motorcycle");
  assert.equal(body.price, 33);
  assert.equal(body.oneWayKm, 7.1);
  assert.equal(body.distanceKm, 30);
  assert.equal(body.distanceKmBalanced, 30);
});
