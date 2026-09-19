import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workerSource = await readFile(new URL("./worker.js", import.meta.url), "utf8");
const workerModule = await import(
  `data:text/javascript;base64,${Buffer.from(workerSource).toString("base64")}`
);

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

async function requestQuote(delivery) {
  const calls = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (input) => {
    const url = new URL(input);
    calls.push(url);

    if (url.pathname === "/v1/geocode/search") {
      const point = pointsByAddress[url.searchParams.get("text")];
      return geoapifyResponse({
        results: point
          ? [{ lat: point.lat, lon: point.lon, city: point.city }]
          : [],
      });
    }

    assert.equal(url.pathname, "/v1/routing");
    const isBalanced = url.searchParams.get("type") === "balanced";
    const legs = isBalanced
      ? [{ distance: 2_600 }, { distance: 4_500 }, { distance: 3_700 }]
      : [{ distance: 2_300 }, { distance: 4_100 }, { distance: 3_600 }];
    return geoapifyResponse({
      features: [{ properties: { distance: isBalanced ? 10_800 : 10_000, legs } }],
    });
  };

  try {
    const response = await workerModule.default.fetch(
      new Request("https://worker.example.test/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pickup: "Coleta", delivery }),
      }),
      { GEOAPIFY_API_KEY: "test-key", ENDERECO_BASE: "Base" },
    );

    return { response, body: await response.json(), calls };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("usa somente o circuito short para entrega local", async () => {
  const { response, body, calls } = await requestQuote("Local");
  const geocodingCalls = calls.filter((url) =>
    url.pathname.includes("/geocode/"),
  );
  const routingCalls = calls.filter((url) => url.pathname.includes("/routing"));

  assert.equal(response.status, 200);
  assert.equal(geocodingCalls.length, 3);
  assert.equal(routingCalls.length, 1);
  assert.equal(routingCalls[0].searchParams.get("type"), "short");

  for (const url of routingCalls) {
    assert.equal(url.searchParams.get("mode"), "motorcycle");
    assert.deepEqual(url.searchParams.get("waypoints").split("|"), [
      "-26.1,-49.1",
      "-26.2,-49.2",
      "-26.3,-49.3",
      "-26.1,-49.1",
    ]);
  }

  assert.notEqual(body.oneWayKm, body.distanceKm / 2);
  assert.deepEqual(body, {
    ok: true,
    oneWayKm: 6.4,
    distanceKm: 10,
    distanceKmBalanced: null,
    km: 10,
    distance: 10,
    distance_km: 10,
    base: { lat: -26.1, lon: -49.1 },
    pickup: { lat: -26.2, lon: -49.2 },
    delivery: { lat: -26.3, lon: -49.3 },
  });
});

test("usa somente o circuito balanced para entrega externa", async () => {
  const { response, body, calls } = await requestQuote("Externa");

  assert.equal(response.status, 200);
  const routingCalls = calls.filter((url) => url.pathname.includes("/routing"));

  assert.equal(routingCalls.length, 1);
  assert.equal(routingCalls[0].searchParams.get("type"), "balanced");
  assert.equal(routingCalls[0].searchParams.get("mode"), "motorcycle");
  assert.equal(body.km, 10.8);
  assert.equal(body.distanceKm, 10.8);
  assert.equal(body.distanceKmBalanced, 10.8);
  assert.equal(body.oneWayKm, 7.1);
  assert.notEqual(body.oneWayKm, body.distanceKm / 2);
});
