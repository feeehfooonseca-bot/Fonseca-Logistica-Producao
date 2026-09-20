import assert from "node:assert/strict";
import test from "node:test";

import { ROUTE_API, requestOfficialQuote } from "./frontend-quote.mjs";

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
    { deliveries: [], totalPrice: 0 },
    { deliveries: [{ price: "15", distanceKm: 14 }], totalPrice: 15 },
    { deliveries: [{ price: 15, distanceKm: -1 }], totalPrice: 15 },
    { deliveries: [{ price: 15, distanceKm: 14 }], totalPrice: 16 },
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
});
