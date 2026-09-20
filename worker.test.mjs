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

async function requestQuote(body, options = {}) {
  const calls = [];
  const logs = [];
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  const originalConsoleLog = console.log;
  const originalConsoleError = console.error;
  const errorLogs = [];
  if (options.cache) globalThis.caches = { default: options.cache };
  else delete globalThis.caches;
  console.log = (message) => logs.push(JSON.parse(message));
  console.error = (message) => errorLogs.push(JSON.parse(message));
  globalThis.fetch = async (input) => {
    const url = new URL(input);
    calls.push(url);
    if (options.fetch) return options.fetch(url, calls);
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
    const headers = { "Content-Type": "application/json", ...options.headers };
    if (options.origin) headers.Origin = options.origin;
    const method = options.method || "POST";
    const response = await workerModule.default.fetch(
      new Request("https://worker.example.test/", {
        method,
        headers,
        body: method === "POST"
          ? options.rawBody === undefined ? JSON.stringify(body) : options.rawBody
          : undefined,
      }),
      {
        GEOAPIFY_API_KEY: "test-key",
        ENDERECO_BASE: "Base",
        ...options.env,
      },
    );
    const responseBody = response.status === 204 ? null : await response.json();
    return { response, body: responseBody, calls, logs, errorLogs };
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalConsoleLog;
    console.error = originalConsoleError;
    if (originalCaches === undefined) delete globalThis.caches;
    else globalThis.caches = originalCaches;
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
  assert.equal(body.base, undefined);
  assert.equal(body.deliveries[0].classification, "local");
  assert.notEqual(body.price, 1);
});

test("origin permitido recebe CORS sem wildcard", async () => {
  const { response } = await requestQuote(
    { pickup: "Coleta", delivery: "Local" },
    { origin: "https://app.example.test", env: { ALLOWED_ORIGINS: "https://app.example.test" } },
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), "https://app.example.test");
  assert.equal(response.headers.get("Vary"), "Origin");
  assert.notEqual(response.headers.get("Access-Control-Allow-Origin"), "*");
});

test("origin não permitido ou parecido é rejeitado antes de chamadas externas", async (t) => {
  for (const origin of ["https://evil.example", "https://app.example.test.evil.example"]) {
    await t.test(origin, async () => {
      const { response, body, calls } = await requestQuote(
        { pickup: "Coleta", delivery: "Local" },
        { origin, env: { ALLOWED_ORIGINS: "https://app.example.test" } },
      );
      assert.equal(response.status, 403);
      assert.deepEqual(body, { error: "Origem não autorizada." });
      assert.equal(response.headers.get("Access-Control-Allow-Origin"), null);
      assert.equal(calls.length, 0);
    });
  }
});

test("requisição sem Origin continua funcionando sem header CORS", async () => {
  const { response, body } = await requestQuote(
    { pickup: "Coleta", delivery: "Local" },
    { env: { ALLOWED_ORIGINS: "https://app.example.test" } },
  );
  assert.equal(response.status, 200);
  assert.equal(body.price, 15);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), null);
});

test("OPTIONS autorizado responde ao preflight somente com CORS necessário", async () => {
  const { response, calls } = await requestQuote(null, {
    method: "OPTIONS",
    origin: "https://app.example.test",
    headers: { "Access-Control-Request-Method": "POST" },
    env: { ALLOWED_ORIGINS: "https://app.example.test" },
  });
  assert.equal(response.status, 204);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), "https://app.example.test");
  assert.equal(response.headers.get("Access-Control-Allow-Methods"), "POST, OPTIONS");
  assert.equal(response.headers.get("Access-Control-Allow-Headers"), "Content-Type");
  assert.equal(calls.length, 0);
});

test("OPTIONS não autorizado não libera CORS", async () => {
  const { response, calls } = await requestQuote(null, {
    method: "OPTIONS",
    origin: "https://evil.example",
    env: { ALLOWED_ORIGINS: "https://app.example.test" },
  });
  assert.equal(response.status, 403);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), null);
  assert.equal(response.headers.get("Access-Control-Allow-Methods"), null);
  assert.equal(calls.length, 0);
});

test("múltiplos origins configurados são comparados de forma exata", async (t) => {
  const configured = "https://app.example.test, https://www.example.test:8443";
  for (const origin of ["https://app.example.test", "https://www.example.test:8443"]) {
    await t.test(origin, async () => {
      const { response } = await requestQuote(
        { pickup: "Coleta", delivery: "Local" },
        { origin, env: { ALLOWED_ORIGINS: configured } },
      );
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("Access-Control-Allow-Origin"), origin);
    });
  }
});

test("configuração CORS malformada ou wildcard nunca abre o acesso", async (t) => {
  for (const configured of ["*", "not-a-url", "https://app.example.test/path", ", ,"] ) {
    await t.test(configured, async () => {
      const { response, calls } = await requestQuote(
        { pickup: "Coleta", delivery: "Local" },
        { origin: "https://app.example.test", env: { ALLOWED_ORIGINS: configured } },
      );
      assert.equal(response.status, 403);
      assert.notEqual(response.headers.get("Access-Control-Allow-Origin"), "*");
      assert.equal(calls.length, 0);
    });
  }
});

test("campos controlados pelo cliente não alteram cálculo, rota ou credenciais", async () => {
  const injected = {
    pickup: "Coleta",
    delivery: "Local",
    price: 999,
    totalPrice: 999,
    RATE_PER_KM: 999,
    oneWayKm: 999,
    totalKm: 999,
    routeType: "balanced",
    mode: "car",
    isOutsideSBS: true,
    base: { lat: 1, lon: 2 },
    pickupCoordinates: { lat: 3, lon: 4 },
    deliveryCoordinates: { lat: 5, lon: 6 },
    GEOAPIFY_API_KEY: "client-key",
  };
  const { body, calls } = await requestQuote(injected);
  const routing = callsAt(calls, "/routing")[0];
  assert.equal(body.price, 15);
  assert.equal(body.totalPrice, 15);
  assert.equal(body.oneWayKm, 10);
  assert.equal(body.distanceKm, 14);
  assert.equal(body.deliveries[0].classification, "local");
  assert.equal(body.deliveries[0].routeType, "short");
  assert.equal(routing.searchParams.get("type"), "short");
  assert.equal(routing.searchParams.get("mode"), "motorcycle");
  assert.equal(routing.searchParams.get("apiKey"), "test-key");
  assert.ok(routing.searchParams.get("waypoints").startsWith("-26.1,-49.1|-26.2,-49.2"));
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

test("BASE_LAT e BASE_LON válidos eliminam a geocodificação da base", async () => {
  const { response, calls } = await requestQuote(
    { pickup: "Coleta", delivery: "Local" },
    { env: { BASE_LAT: "-26.1", BASE_LON: "-49.1", ENDERECO_BASE: undefined } },
  );
  assert.equal(response.status, 200);
  assert.equal(geocodeCount(calls, "Base"), 0);
  assert.equal(callsAt(calls, "/geocode/search").length, 2);
});

test("ausência ou coordenadas inválidas da base usam ENDERECO_BASE", async (t) => {
  for (const env of [
    {},
    { BASE_LAT: "inválida", BASE_LON: "-49.1" },
    { BASE_LAT: "91", BASE_LON: "-49.1" },
    { BASE_LAT: "-26.1", BASE_LON: "181" },
  ]) {
    await t.test(JSON.stringify(env), async () => {
      const { response, calls } = await requestQuote(
        { pickup: "Coleta", delivery: "Local" },
        { env },
      );
      assert.equal(response.status, 200);
      assert.equal(geocodeCount(calls, "Base"), 1);
    });
  }
});

test("reutiliza coleta e endereços repetidos dentro da mesma requisição", async () => {
  const { body, calls } = await requestQuote({
    pickup: "Coleta",
    deliveries: ["Local", "Local", "Local longe", "Local longe"],
  });
  assert.equal(geocodeCount(calls, "Coleta"), 1);
  assert.equal(geocodeCount(calls, "Local"), 1);
  assert.equal(geocodeCount(calls, "Local longe"), 1);
  assert.equal(callsAt(calls, "/routing").length, 4);
  assert.deepEqual(body.deliveries.map((item) => item.price), [15, 15, 17, 17]);
  assert.equal(body.totalPrice, 64);
});

function memoryCache() {
  const entries = new Map();
  return {
    async match(request) {
      return entries.get(request.url)?.clone();
    },
    async put(request, response) {
      entries.set(request.url, response.clone());
    },
  };
}

test("cache hit evita novas chamadas externas de geocoding", async () => {
  const cache = memoryCache();
  const first = await requestQuote(
    { pickup: "Coleta", delivery: "Local" },
    { cache, env: { BASE_LAT: "-26.1", BASE_LON: "-49.1" } },
  );
  const second = await requestQuote(
    { pickup: "Coleta", delivery: "Local" },
    { cache, env: { BASE_LAT: "-26.1", BASE_LON: "-49.1" } },
  );
  assert.equal(callsAt(first.calls, "/geocode/search").length, 2);
  assert.equal(callsAt(second.calls, "/geocode/search").length, 0);
  assert.equal(second.logs[0].geocodeCacheHits, 2);
  assert.equal(second.logs[0].geocodingCalls, 0);
  assert.equal(callsAt(second.calls, "/routing").length, 1);
});

test("cache miss consulta Geoapify e não inclui endereço nem API key na chave", async () => {
  const requestedKeys = [];
  const cache = {
    async match(request) {
      requestedKeys.push(request.url);
      return undefined;
    },
    async put() {},
  };
  const { calls, logs } = await requestQuote(
    { pickup: "Coleta", delivery: "Local" },
    { cache, env: { BASE_LAT: "-26.1", BASE_LON: "-49.1" } },
  );
  assert.equal(callsAt(calls, "/geocode/search").length, 2);
  assert.equal(logs[0].geocodeCacheMisses, 2);
  assert.ok(requestedKeys.every((key) => !key.includes("Coleta") && !key.includes("test-key")));
});

test("falha de cache não impede orçamento e é contabilizada", async () => {
  const cache = {
    async match() { throw new Error("cache indisponível"); },
    async put() { throw new Error("cache indisponível"); },
  };
  const { response, body, calls, logs } = await requestQuote(
    { pickup: "Coleta", delivery: "Local" },
    { cache, env: { BASE_LAT: "-26.1", BASE_LON: "-49.1" } },
  );
  assert.equal(response.status, 200);
  assert.equal(body.price, 15);
  assert.equal(callsAt(calls, "/geocode/search").length, 2);
  assert.equal(logs[0].technicalErrors, 4);
});

test("falha externa retorna e registra somente informações controladas", async () => {
  const originalFetch = globalThis.fetch;
  const originalConsoleLog = console.log;
  const originalConsoleError = console.error;
  const logs = [];
  const errors = [];
  delete globalThis.caches;
  console.log = (message) => logs.push(message);
  console.error = (message) => errors.push(message);
  globalThis.fetch = async () => {
    throw new Error("https://api.geoapify.com/private?apiKey=secret&text=endereco-cliente");
  };

  try {
    const response = await workerModule.default.fetch(
      new Request("https://worker.example.test/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pickup: "Coleta", delivery: "Local" }),
      }),
      { GEOAPIFY_API_KEY: "secret", ENDERECO_BASE: "Base" },
    );
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: "Erro interno ao calcular a rota." });
    const output = [...logs, ...errors].join("\n");
    assert.doesNotMatch(output, /secret|endereco-cliente|api\.geoapify\.com|Coleta|Local|Base/);
    assert.deepEqual(JSON.parse(errors[0]), { event: "quote_error", type: "internal" });
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalConsoleLog;
    console.error = originalConsoleError;
  }
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

test("fronteiras completas da tarifa local comum", () => {
  const cases = [
    [0, 15], [11.9, 15], [12, 15], [12.0001, 16],
    [13, 17], [15, 19], [16, 20], [20, 24],
  ];
  for (const [kilometers, expected] of cases) {
    assert.equal(calculatePrice(localPrice(kilometers)), expected, `${kilometers} km`);
  }
});

test("fronteiras e arredondamento das três regiões especiais", () => {
  const regions = [
    ["Rio Vermelho Povoado", 8, 20],
    ["Rio Vermelho Estação", 12, 25],
    ["Rio Natal", 16, 30],
  ];
  for (const [address, limit, basePrice] of regions) {
    assert.equal(calculatePrice(specialPrice(address, limit - 0.1)), basePrice);
    assert.equal(calculatePrice(specialPrice(address, limit)), basePrice);
    assert.equal(calculatePrice(specialPrice(address, limit + 0.001)), basePrice + 1);
    assert.equal(calculatePrice(specialPrice(address, limit + 3.5)), Math.ceil(basePrice + 3.85));
  }
});

test("regiões especiais usam primeiro a localidade do geocoder e depois o endereço", () => {
  assert.equal(calculatePrice({
    deliveryAddress: "Endereço sintético sem bairro",
    deliveryLocalities: ["Rio Vermelho Povoado"],
    isOutsideSBS: false,
    oneWayKm: 99,
    totalKm: 8,
  }), 20);
  assert.equal(calculatePrice({
    deliveryAddress: "Via sintética, Rio Natal",
    deliveryLocalities: [],
    isOutsideSBS: false,
    oneWayKm: 99,
    totalKm: 16,
  }), 30);
});

test("circuito de cada entrega é BASE, COLETA, ENTREGA, BASE sem terceira rota", async () => {
  const { calls } = await requestQuote({ pickup: "Coleta", deliveries: ["Local", "Externa"] });
  const routes = callsAt(calls, "/routing");
  assert.equal(routes.length, 2);
  for (const route of routes) {
    const waypoints = route.searchParams.get("waypoints").split("|");
    assert.equal(waypoints.length, 4);
    assert.equal(waypoints[0], waypoints[3]);
    assert.equal(waypoints[1], "-26.2,-49.2");
  }
});

test("coleta externa com entrega externa permanece viagem BALANCED", async () => {
  const { body, calls } = await requestQuote({ pickup: "Coleta externa", delivery: "Externa" });
  assert.equal(body.deliveries[0].classification, "viagem");
  assert.equal(body.deliveries[0].routeType, "balanced");
  assert.equal(body.price, 34);
  assert.equal(callsAt(calls, "/routing")[0].searchParams.get("type"), "balanced");
});

test("ordem, endereço repetido e preços individuais são preservados", async () => {
  const { body, calls } = await requestQuote({
    pickup: "Coleta",
    deliveries: ["Externa", "Local", "Externa", "Local longe"],
  });
  assert.deepEqual(body.deliveries.map(({ address }) => address),
    ["Externa", "Local", "Externa", "Local longe"]);
  assert.deepEqual(body.deliveries.map(({ price }) => price), [34, 15, 34, 17]);
  assert.equal(body.totalPrice, 100);
  assert.equal(geocodeCount(calls, "Externa"), 1);
  assert.equal(callsAt(calls, "/routing").length, 4);
});

test("soma preços já arredondados, nunca o total bruto", () => {
  const individual = [15, 16.65, 19.95].map((raw) =>
    calculatePrice(externalPrice(raw / 1.1)));
  assert.deepEqual(individual, [15, 17, 20]);
  assert.equal(individual.reduce((sum, value) => sum + value, 0), 52);
});

test("uma entrega com base configurada faz duas geocodificações e uma rota", async () => {
  const { calls, logs } = await requestQuote(
    { pickup: "Coleta", delivery: "Local" },
    { env: { BASE_LAT: "-26.1", BASE_LON: "-49.1" } },
  );
  assert.equal(callsAt(calls, "/geocode/search").length, 2);
  assert.equal(callsAt(calls, "/routing").length, 1);
  assert.equal(logs[0].geocodingCalls, 2);
  assert.equal(logs[0].routingCalls, 1);
});

test("cache adversarial inválido é ignorado sem alterar preço", async (t) => {
  const variants = [
    ["JSON inválido", () => new Response("{")],
    ["objeto vazio", () => geoapifyResponse({})],
    ["latitude inválida", () => geoapifyResponse({ lat: 91, lon: -49, city: "São Bento do Sul", localities: [] })],
    ["longitude inválida", () => geoapifyResponse({ lat: -26, lon: -181, city: "São Bento do Sul", localities: [] })],
    ["strings inesperadas", () => geoapifyResponse({ lat: "-26", lon: "-49", city: "São Bento do Sul", localities: [] })],
    ["resposta antiga incompleta", () => geoapifyResponse({ lat: -26, lon: -49 })],
  ];
  for (const [name, response] of variants) {
    await t.test(name, async () => {
      const cache = { async match() { return response(); }, async put() {} };
      const { response: result, body, calls } = await requestQuote(
        { pickup: "Coleta", delivery: "Local" },
        { cache, env: { BASE_LAT: "-26.1", BASE_LON: "-49.1" } },
      );
      assert.equal(result.status, 200);
      assert.equal(body.price, 15);
      assert.equal(callsAt(calls, "/geocode/search").length, 2);
    });
  }
});

test("resultado vazio ou inválido de geocoding não é gravado no cache", async (t) => {
  for (const result of [[], [{ lat: "NaN", lon: -49, city: "São Bento do Sul" }]]) {
    await t.test(JSON.stringify(result), async () => {
      let puts = 0;
      const cache = { async match() {}, async put() { puts += 1; } };
      const { response } = await requestQuote(
        { pickup: "Desconhecido", delivery: "Local" },
        { cache, env: { BASE_LAT: "-26.1", BASE_LON: "-49.1" }, fetch(url) {
          if (url.pathname.includes("geocode")) {
            const isUnknown = url.searchParams.get("text") === "Desconhecido";
            return geoapifyResponse({ results: isUnknown ? result : [pointsByAddress.Local] });
          }
          throw new Error("routing não deveria ocorrer");
        } },
      );
      assert.equal(response.status, 422);
      assert.equal(puts, 1);
    });
  }
});

test("payload malicioso não sobrescreve nenhum campo oficial", async () => {
  const { body, calls } = await requestQuote({
    pickup: "Coleta", delivery: "Local", price: 999, totalPrice: 999,
    RATE_PER_KM: 999, tarifa: 999, basePrice: 999, includedKm: 999,
    oneWayKm: 999, distanceKm: 999, totalKm: 999, routeType: "balanced",
    mode: "truck", classification: "viagem", isOutsideSBS: true,
    base: { lat: 0, lon: 0 }, BASE_LAT: 0, BASE_LON: 0,
    ENDERECO_BASE: "Ataque", GEOAPIFY_API_KEY: "ataque",
    pickupCoordinates: { lat: 0, lon: 0 }, deliveryCoordinates: { lat: 0, lon: 0 },
    localities: ["Rio Natal"], extra: "permitido e ignorado",
  });
  assert.equal(body.price, 15);
  assert.equal(body.totalPrice, 15);
  assert.equal(body.deliveries[0].classification, "local");
  const route = callsAt(calls, "/routing")[0];
  assert.equal(route.searchParams.get("mode"), "motorcycle");
  assert.equal(route.searchParams.get("type"), "short");
  assert.equal(route.searchParams.get("apiKey"), "test-key");
});

test("entradas inválidas e bodies adversariais falham antes da Geoapify", async (t) => {
  const bodies = [
    undefined, null, 42, [], {}, { pickup: "" }, { pickup: "   ", delivery: "Local" },
    { pickup: 7, delivery: "Local" }, { pickup: {}, delivery: "Local" },
    { pickup: [], delivery: "Local" }, { pickup: "Coleta", delivery: null },
    { pickup: "Coleta", delivery: [] }, { pickup: "Coleta", deliveries: [null] },
    { pickup: "Coleta", deliveries: [{}] }, { pickup: "Coleta", deliveries: [["Local"]] },
  ];
  for (const body of bodies) {
    await t.test(JSON.stringify(body), async () => {
      const result = await requestQuote(body);
      assert.equal(result.response.status, 400);
      assert.equal(result.calls.length, 0);
    });
  }
  const malformed = await requestQuote(null, { rawBody: "{não-json" });
  assert.equal(malformed.response.status, 400);
  assert.deepEqual(malformed.body, { error: "JSON inválido." });
  assert.equal(malformed.calls.length, 0);
});

test("Unicode, espaços e caixa reutilizam geocoding mantendo entregas independentes", async () => {
  const variants = ["  RUA ÁGUA   VERDE  ", "rua água verde", "RUA ÁGUA VERDE"];
  const { response, body, calls } = await requestQuote(
    { pickup: "Coleta", deliveries: variants },
    { fetch(url) {
      if (url.pathname.includes("geocode")) {
        const address = url.searchParams.get("text");
        const point = address === "Coleta" ? pointsByAddress.Coleta : pointsByAddress.Local;
        return geoapifyResponse({ results: [point] });
      }
      return geoapifyResponse({ features: [{ properties: {
        distance: 14_000, legs: [{ distance: 4_000 }, { distance: 6_000 }, { distance: 4_000 }],
      } }] });
    } },
  );
  assert.equal(response.status, 200);
  assert.equal(callsAt(calls, "/geocode/search").length, 3);
  assert.equal(callsAt(calls, "/routing").length, 3);
  assert.deepEqual(body.deliveries.map(({ price }) => price), [15, 15, 15]);
});

test("CORS rejeita variações parecidas de protocolo, porta, prefixo, sufixo e subdomínio", async (t) => {
  const origins = [
    "http://app.example.test", "https://app.example.test:444",
    "https://sub.app.example.test", "https://evil-app.example.test",
    "https://app.example.test.evil.test",
  ];
  for (const origin of origins) {
    await t.test(origin, async () => {
      const { response, calls } = await requestQuote(
        { pickup: "Coleta", delivery: "Local" },
        { origin, env: { ALLOWED_ORIGINS: "https://app.example.test" } },
      );
      assert.equal(response.status, 403);
      assert.equal(response.headers.get("Access-Control-Allow-Origin"), null);
      assert.equal(calls.length, 0);
    });
  }
});

test("falhas externas e respostas de rota inválidas são controladas", async (t) => {
  const cases = [
    ["geocode HTTP", 500, (url) => url.pathname.includes("geocode")
      ? new Response("erro sensível", { status: 503 }) : null],
    ["routing HTTP", 500, (url) => url.pathname.includes("routing")
      ? new Response("erro sensível", { status: 503 }) : defaultSynthetic(url)],
    ["routing sem features", 502, (url) => url.pathname.includes("routing")
      ? geoapifyResponse({}) : defaultSynthetic(url)],
    ["routing sem legs local", 502, (url) => url.pathname.includes("routing")
      ? geoapifyResponse({ features: [{ properties: { distance: 1000 } }] }) : defaultSynthetic(url)],
    ["distância negativa", 502, (url) => url.pathname.includes("routing")
      ? geoapifyResponse({ features: [{ properties: { distance: -1, legs: [{ distance: 1 }, { distance: 1 }] } }] }) : defaultSynthetic(url)],
  ];
  for (const [name, status, fetchMock] of cases) {
    await t.test(name, async () => {
      const { response, body, errorLogs } = await requestQuote(
        { pickup: "Coleta", delivery: "Local" }, { fetch: fetchMock },
      );
      assert.equal(response.status, status);
      assert.match(body.error, /^(Erro interno|Não foi possível)/);
      assert.doesNotMatch(JSON.stringify({ body, errorLogs }), /test-key|Coleta|Local|Base|-26\./);
    });
  }
});

function defaultSynthetic(url) {
  if (url.pathname.includes("geocode")) {
    const point = pointsByAddress[url.searchParams.get("text")];
    return geoapifyResponse({ results: point ? [point] : [] });
  }
  return geoapifyResponse({ features: [{ properties: {
    distance: 14_000, legs: [{ distance: 4_000 }, { distance: 6_000 }, { distance: 4_000 }],
  } }] });
}

test("telemetria contém somente contadores técnicos esperados", async () => {
  const { logs } = await requestQuote({ pickup: "Coleta", deliveries: ["Local", "Externa"] });
  assert.equal(logs.length, 1);
  const telemetry = logs[0];
  assert.deepEqual(Object.keys(telemetry).sort(), [
    "deliveryCount", "durationMs", "event", "geocodeCacheHits", "geocodeCacheMisses",
    "geocodingCalls", "routingCalls", "technicalErrors",
  ]);
  assert.equal(telemetry.deliveryCount, 2);
  assert.equal(telemetry.geocodingCalls, 4);
  assert.equal(telemetry.routingCalls, 2);
  assert.equal(telemetry.geocodeCacheHits, 0);
  assert.equal(telemetry.geocodeCacheMisses, 4);
  assert.equal(telemetry.technicalErrors, 0);
  assert.ok(Number.isFinite(telemetry.durationMs) && telemetry.durationMs >= 0);
  assert.doesNotMatch(JSON.stringify(telemetry), /Coleta|Local|Externa|test-key|api\.geoapify|-26\./);
});

test("contratos legado e novo não expõem a base", async () => {
  const legacy = await requestQuote({ pickup: "Coleta", delivery: "Local" });
  assert.deepEqual(Object.keys(legacy.body).sort(), [
    "deliveries", "delivery", "distance", "distanceKm", "distanceKmBalanced",
    "distance_km", "km", "ok", "oneWayKm", "pickup", "price", "totalPrice",
  ]);
  const modern = await requestQuote({ pickup: "Coleta", deliveries: ["Local", "Externa"] });
  assert.deepEqual(Object.keys(modern.body).sort(), ["deliveries", "ok", "totalPrice"]);
  assert.equal(JSON.stringify(modern.body).includes('"base"'), false);
});

test("cenários históricos usam somente regras e distâncias sintéticas", () => {
  assert.equal(calculatePrice(localPrice(10)), 15, "Centro de São Bento do Sul");
  assert.equal(calculatePrice(localPrice(15)), 19, "Serra Alta");
  assert.equal(calculatePrice(localPrice(16)), 20, "Cruzeiro");
  assert.equal(calculatePrice(specialPrice("Rio Natal", 17)), 32, "Rio Natal");
  assert.equal(calculatePrice(externalPrice(30.2)), 34, "Campo Alegre");
  assert.equal(calculatePrice(externalPrice(147.5)), 163, "viagem mais longa");
});
