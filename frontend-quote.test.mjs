import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { MAX_DELIVERIES, ROUTE_API, requestOfficialQuote } from "./frontend-quote.mjs";

function response(body, { ok = true } = {}) {
  return { ok, async json() { return body; } };
}

test("envia uma entrega no contrato moderno do Worker", async () => {
  let request;
  const quote = await requestOfficialQuote("Coleta", [{ address: "Entrega A" }], async (...args) => {
    request = args;
    return response({
      ok: true,
      deliveries: [{ address: "Entrega A", price: 15, distanceKm: 14 }],
      totalPrice: 15,
    });
  });

  assert.equal(request[0], ROUTE_API);
  assert.equal(request[1].method, "POST");
  assert.deepEqual(request[1].headers, { "Content-Type": "application/json" });
  assert.deepEqual(JSON.parse(request[1].body), {
    pickup: "Coleta",
    deliveries: ["Entrega A"],
  });
  assert.equal(quote.totalPrice, 15);
});

test("frontend aceita 20 entregas e rejeita 21 sem chamar o Worker", async () => {
  assert.equal(MAX_DELIVERIES, 20);
  const deliveries = Array.from({ length: MAX_DELIVERIES }, (_, index) => ({
    address: `Entrega ${index + 1}`,
  }));
  let calls = 0;
  const fetchImpl = async (_url, options) => {
    calls++;
    const requested = JSON.parse(options.body).deliveries;
    return response({
      ok: true,
      deliveries: requested.map((address) => ({ address, price: 15, distanceKm: 10 })),
      totalPrice: 300,
    });
  };

  const quote = await requestOfficialQuote("Coleta", deliveries, fetchImpl);
  assert.equal(quote.deliveries.length, 20);
  assert.equal(calls, 1);

  await assert.rejects(
    requestOfficialQuote("Coleta", [...deliveries, { address: "Entrega 21" }], fetchImpl),
    /no máximo 20 entregas/,
  );
  assert.equal(calls, 1);
});

test("preserva múltiplas entregas, ordem, preços individuais e soma oficial", async () => {
  const deliveries = [{ address: "Entrega B" }, { address: "Entrega A" }];
  const quote = await requestOfficialQuote("Coleta", deliveries, async () => response({
    ok: true,
    deliveries: [
      { address: "Entrega B", price: 17, distanceKm: 18 },
      { address: "Entrega A", price: 15, distanceKm: 14 },
    ],
    totalPrice: 32,
  }));

  assert.deepEqual(quote.deliveries.map(({ address }) => address), ["Entrega B", "Entrega A"]);
  assert.deepEqual(quote.deliveries.map(({ price }) => price), [17, 15]);
  assert.equal(quote.totalPrice, 32);
});

test("rejeita quantidade, valores e soma incompatíveis", async (t) => {
  const invalidQuotes = [
    { ok: true, deliveries: [], totalPrice: 0 },
    { ok: false, deliveries: [{ address: "Entrega", price: 15, distanceKm: 14 }], totalPrice: 15 },
    { ok: true, deliveries: [{ address: "Entrega", price: "15", distanceKm: 14 }], totalPrice: 15 },
    { ok: true, deliveries: [{ address: "Entrega", price: 15.5, distanceKm: 14 }], totalPrice: 15.5 },
    { ok: true, deliveries: [{ address: "Entrega", price: 15, distanceKm: -1 }], totalPrice: 15 },
    { ok: true, deliveries: [{ address: "Entrega", price: 15, distanceKm: 14 }], totalPrice: 16 },
  ];

  for (const quote of invalidQuotes) {
    await t.test(JSON.stringify(quote), async () => {
      await assert.rejects(
        requestOfficialQuote("Coleta", [{ address: "Entrega" }], async () => response(quote)),
        /orçamento inválido/,
      );
    });
  }
});

test("contrato real frontend e Worker preserva ordem, cálculo individual e soma", async () => {
  const workerSource = await readFile(new URL("./worker.js", import.meta.url), "utf8");
  const worker = await import(
    `data:text/javascript;base64,${Buffer.from(workerSource).toString("base64")}`
  );
  const geocodePoint = (lat, lon, city) => ({
    lat,
    lon,
    city,
    result_type: "street",
    rank: {
      confidence: 1,
      confidence_city_level: 1,
      confidence_street_level: 1,
      match_type: "full_match",
    },
  });
  const points = {
    Coleta: geocodePoint(-26.2, -49.2, "São Bento do Sul"),
    Local: geocodePoint(-26.3, -49.3, "São Bento do Sul"),
    Externa: geocodePoint(-26.4, -49.4, "Campo Alegre"),
  };
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  const originalLog = console.log;
  const originalError = console.error;
  delete globalThis.caches;
  console.log = () => {};
  console.error = () => {};
  globalThis.fetch = async (input) => {
    const url = new URL(input);
    if (url.pathname === "/v1/geocode/search") {
      return response({ results: [points[url.searchParams.get("text")]] });
    }
    const deliveryLat = url.searchParams.get("waypoints").split("|")[2].split(",")[0];
    const route = deliveryLat === "-26.3"
      ? { distance: 14_000, legs: [4_000, 6_000, 4_000] }
      : { distance: 30_100, legs: [2_600, 4_500, 23_000] };
    return response({ features: [{ properties: {
      distance: route.distance,
      legs: route.legs.map((distance) => ({ distance })),
    } }] });
  };

  try {
    const quote = await requestOfficialQuote(
      "Coleta",
      [{ address: "Externa" }, { address: "Local" }],
      (url, init) => worker.default.fetch(new Request(url, init), {
        GEOAPIFY_API_KEY: "test-key",
        BASE_LAT: "-26.1",
        BASE_LON: "-49.1",
      }),
    );
    assert.deepEqual(quote.deliveries.map(({ address }) => address), ["Externa", "Local"]);
    assert.deepEqual(quote.deliveries.map(({ price }) => price), [34, 15]);
    assert.equal(quote.totalPrice, 49);
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
    console.error = originalError;
    if (originalCaches === undefined) delete globalThis.caches;
    else globalThis.caches = originalCaches;
  }
});

test("rejeita resposta que não preserva a ordem das entregas", async () => {
  await assert.rejects(
    requestOfficialQuote(
      "Coleta",
      [{ address: "Entrega A" }, { address: "Entrega B" }],
      async () => response({
        ok: true,
        deliveries: [
          { address: "Entrega B", price: 17, distanceKm: 18 },
          { address: "Entrega A", price: 15, distanceKm: 14 },
        ],
        totalPrice: 32,
      }),
    ),
    /orçamento inválido/,
  );
});

test("propaga erro controlado do Worker e trata resposta não JSON", async () => {
  await assert.rejects(
    requestOfficialQuote("Coleta", [{ address: "Entrega" }], async () =>
      response({ error: "Origem não autorizada." }, { ok: false })),
    /Origem não autorizada/,
  );
  await assert.rejects(
    requestOfficialQuote("Coleta", [{ address: "Entrega" }], async () => ({
      ok: false,
      async json() { throw new SyntaxError("invalid JSON"); },
    })),
    /Não foi possível localizar/,
  );
  await assert.rejects(
    requestOfficialQuote("Coleta", [{ address: "Entrega" }], async () => {
      throw new TypeError("detalhe interno da rede");
    }),
    /^Error: Não foi possível conectar ao serviço de orçamento\. Tente novamente\.$/,
  );
});

test("HTML local inicializa a calculadora sem depender de módulo externo", async () => {
  const localHtml = await readFile(new URL("./TESTE-LOCAL-CELULAR.html", import.meta.url), "utf8");
  const indexHtml = await readFile(new URL("./index.html", import.meta.url), "utf8");
  assert.doesNotMatch(localHtml, /import\s+\{?\s*requestOfficialQuote/);
  assert.doesNotMatch(localHtml, /src=["'][^"']*frontend-quote\.mjs/);
  assert.doesNotMatch(localHtml, /<script\s+type=["']module["'][^>]*>/);
  assert.match(localHtml, /async function requestOfficialQuote\(pickup,deliveries\)/);
  assert.match(localHtml, /await requestOfficialQuote\(pickup,deliveries\)/);
  assert.match(localHtml, /delivery\.pricingGroupId===sharedTrip\.id/);
  assert.match(localHtml, /delivery\.price===null&&delivery\.distanceKm===null/);
  assert.match(localHtml, /Incluída na viagem compartilhada/);
  assert.match(localHtml, /Viagem compartilhada — entregas/);
  assert.match(localHtml, /Valor da viagem:/);
  assert.match(localHtml, /sharedTrips\.reduce\(\(a,x\)=>a\+Number\(x\.distanceKm\),0\)/);
  assert.match(indexHtml, /import \{ MAX_DELIVERIES, requestOfficialQuote \}/);
  assert.match(localHtml, /MAX_DELIVERIES=20/);
  for (const html of [indexHtml, localHtml]) {
    assert.match(html, /length>=MAX_DELIVERIES/);
    assert.match(html, /Limite de \$\{MAX_DELIVERIES\} entregas atingido/);
  }
});


test("aceita orçamento com duas viagens externas em grupo compartilhado", async () => {
  const deliveries = [{ address: "Campo Alegre" }, { address: "Joinville" }];
  const quote = await requestOfficialQuote("Coleta", deliveries, async () => response({
    ok: true,
    deliveries: [
      {
        address: "Campo Alegre",
        classification: "viagem",
        routeType: "balanced",
        price: null,
        distanceKm: null,
        pricingGroupId: "external-shared-1",
      },
      {
        address: "Joinville",
        classification: "viagem",
        routeType: "balanced",
        price: null,
        distanceKm: null,
        pricingGroupId: "external-shared-1",
      },
    ],
    sharedTrips: [{
      id: "external-shared-1",
      classification: "viagem",
      routeType: "balanced",
      deliveryIndexes: [0, 1],
      distanceKm: 150,
      price: 165,
    }],
    totalPrice: 165,
  }));

  assert.equal(quote.totalPrice, 165);
  assert.equal(quote.sharedTrips[0].price, 165);
});

test("rejeita grupo compartilhado adulterado ou total incompatível", async (t) => {
  const deliveries = [{ address: "A" }, { address: "B" }];
  const base = {
    ok: true,
    deliveries: [
      { address: "A", classification: "viagem", routeType: "balanced", price: null, distanceKm: null, pricingGroupId: "g" },
      { address: "B", classification: "viagem", routeType: "balanced", price: null, distanceKm: null, pricingGroupId: "g" },
    ],
    sharedTrips: [{
      id: "g", classification: "viagem", routeType: "balanced",
      deliveryIndexes: [0, 1], distanceKm: 100, price: 110,
    }],
    totalPrice: 110,
  };
  const invalid = [
    { ...base, totalPrice: 109 },
    { ...base, sharedTrips: [{ ...base.sharedTrips[0], deliveryIndexes: [0] }] },
    { ...base, sharedTrips: [{ ...base.sharedTrips[0], routeType: "short" }] },
    { ...base, deliveries: [{ ...base.deliveries[0], price: 1 }, base.deliveries[1]] },
  ];
  for (const quote of invalid) {
    await t.test(JSON.stringify(quote), async () => {
      await assert.rejects(
        requestOfficialQuote("Coleta", deliveries, async () => response(quote)),
        /orçamento inválido/,
      );
    });
  }
});
