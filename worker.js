const RATE_PER_KM = 1.1;
const MAX_DELIVERIES = 20;
const GEOCODE_CACHE_TTL_SECONDS = 86400;
const GEOCODE_MIN_CONFIDENCE = 0.2;
const GEOCODE_MIN_CITY_CONFIDENCE = 0.5;
const GEOCODE_MIN_STREET_CONFIDENCE = 0.5;
const QUOTE_PROOF_VERSION = 1;
const QUOTE_TTL_SECONDS = 30 * 60;
const CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const LOW_PRECISION_GEOCODE_RESULT_TYPES = new Set([
  "unknown", "suburb", "district", "postcode", "city", "county", "state", "country",
]);
const LOW_PRECISION_GEOCODE_MATCH_TYPES = new Set([
  "match_by_postcode", "match_by_city_or_disrict", "match_by_city_or_district",
  "match_by_country_or_state",
]);

const SPECIAL_REGIONS = [
  { name: "rio_vermelho_estacao", match: "rio vermelho estacao", basePrice: 25, includedKm: 12 },
  { name: "rio_vermelho_povoado", match: "rio vermelho povoado", basePrice: 20, includedKm: 8 },
  { name: "rio_natal", match: "rio natal", basePrice: 30, includedKm: 16 },
];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const corsHeaders = corsHeadersFor(request.headers.get("Origin"), env.ALLOWED_ORIGINS);
    if (request.headers.get("Origin") && !corsHeaders) {
      return json({ error: "Origem não autorizada." }, 403);
    }
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: {
        ...corsHeaders, "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Max-Age": "86400",
      } });
    }
    if (url.pathname === "/quote/submit") {
      if (request.method !== "POST") return json({ error: "Método não permitido." }, 405, corsHeaders);
      return submitQuote(request, env, corsHeaders);
    }
    if (url.pathname.startsWith("/quote/verify/")) {
      if (request.method !== "GET") return json({ error: "Método não permitido." }, 405, corsHeaders);
      return verifyQuote(url.pathname.slice("/quote/verify/".length), env);
    }
    if (url.pathname !== "/" && url.pathname !== "/quote") {
      return json({ error: "Rota não encontrada." }, 404, corsHeaders);
    }
    const startedAt = Date.now();
    const telemetry = {
      event: "quote_processing",
      deliveryCount: 0,
      geocodingCalls: 0,
      routingCalls: 0,
      geocodeCacheHits: 0,
      geocodeCacheMisses: 0,
      technicalErrors: 0,
    };
    if (request.method !== "POST") {
      return json({ error: "Método não permitido." }, 405, corsHeaders);
    }

    try {
      if (!env.GEOAPIFY_API_KEY) {
        return json({ error: "Serviço temporariamente indisponível." }, 500, corsHeaders);
      }

      const configuredBase = readBaseCoordinates(env);
      if (!configuredBase && !validAddress(env.ENDERECO_BASE)) {
        return json({ error: "Serviço temporariamente indisponível." }, 500, corsHeaders);
      }

      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: "JSON inválido." }, 400, corsHeaders);
      }

      const pickup = validAddress(body?.pickup);
      const usesDeliveries = Object.prototype.hasOwnProperty.call(body || {}, "deliveries");
      const deliveryAddresses = usesDeliveries
        ? Array.isArray(body.deliveries) && body.deliveries.length > 0
          ? body.deliveries.map(validAddress)
          : null
        : [validAddress(body?.delivery)];

      if (!pickup || !deliveryAddresses || deliveryAddresses.some((address) => !address)) {
        return json(
          { error: "Informe os endereços de coleta e entrega." },
          400,
          corsHeaders,
        );
      }
      telemetry.deliveryCount = deliveryAddresses.length;
      if (deliveryAddresses.length > MAX_DELIVERIES) {
        return json(
          { error: `Cada orçamento aceita no máximo ${MAX_DELIVERIES} entregas.` },
          400,
          corsHeaders,
        );
      }

      const geocodes = new Map();
      const geocodeOnce = (address) => {
        const key = normalizeAddressKey(address);
        if (!geocodes.has(key)) {
          geocodes.set(key, geocode(address, env.GEOAPIFY_API_KEY, telemetry));
        }
        return geocodes.get(key);
      };
      const baseAddress = validAddress(env.ENDERECO_BASE);
      const [base, pickupPoint, ...deliveryPoints] = await Promise.all([
        configuredBase || geocodeOnce(baseAddress),
        geocodeOnce(pickup),
        ...deliveryAddresses.map(geocodeOnce),
      ]);

      if (!base) {
        return json({ error: "Não foi possível localizar a base." }, 422, corsHeaders);
      }
      if (!pickupPoint) {
        return json(
          { error: "Não foi possível confirmar o endereço de coleta. Confira rua, número e cidade." },
          422,
          corsHeaders,
        );
      }
      if (deliveryPoints.some((point) => !point)) {
        return json(
          { error: "Não foi possível confirmar o endereço de entrega. Confira rua, número e cidade." },
          422,
          corsHeaders,
        );
      }

      const pickupIsOutsideSBS = normalizeText(pickupPoint.city) !== "sao bento do sul";
      const quoteInputs = deliveryPoints.map((deliveryPoint, index) => {
        const isOutsideSBS =
          pickupIsOutsideSBS || normalizeText(deliveryPoint.city) !== "sao bento do sul";
        return {
          address: deliveryAddresses[index],
          point: deliveryPoint,
          isOutsideSBS,
          routeType: isOutsideSBS ? "balanced" : "short",
        };
      });
      const sharedExternalIndexes = usesDeliveries
        ? quoteInputs
            .map((input, index) => input.isOutsideSBS ? index : -1)
            .filter((index) => index >= 0)
        : [];
      const hasSharedExternalTrip = sharedExternalIndexes.length >= 2;

      const individualRoutePromises = quoteInputs.map(({ point, routeType, isOutsideSBS }) =>
        hasSharedExternalTrip && isOutsideSBS
          ? Promise.resolve(null)
          : getRoute(
              [base, pickupPoint, point, base],
              env.GEOAPIFY_API_KEY,
              routeType,
              telemetry,
            ),
      );
      const sharedExternalRoutePromise = hasSharedExternalTrip
        ? getRoute(
            [
              base,
              pickupPoint,
              ...sharedExternalIndexes.map((index) => quoteInputs[index].point),
              base,
            ],
            env.GEOAPIFY_API_KEY,
            "balanced",
            telemetry,
          )
        : Promise.resolve(null);

      const [routes, sharedExternalRoute] = await Promise.all([
        Promise.all(individualRoutePromises),
        sharedExternalRoutePromise,
      ]);

      if (
        (hasSharedExternalTrip && !sharedExternalRoute) ||
        routes.some((route, index) => {
          if (hasSharedExternalTrip && quoteInputs[index].isOutsideSBS) return false;
          return !route || (!quoteInputs[index].isOutsideSBS && route.oneWayKm === null);
        })
      ) {
        return json({ error: "Não foi possível calcular a rota." }, 502, corsHeaders);
      }

      const sharedTripId = hasSharedExternalTrip ? "external-shared-1" : null;
      const deliveries = quoteInputs.map((input, index) => {
        if (hasSharedExternalTrip && input.isOutsideSBS) {
          return {
            address: input.address,
            classification: "viagem",
            routeType: "balanced",
            oneWayKm: null,
            distanceKm: null,
            relevantDistanceKm: null,
            price: null,
            pricingGroupId: sharedTripId,
            delivery: { lat: input.point.lat, lon: input.point.lon },
          };
        }

        const route = routes[index];
        const specialRegion = input.isOutsideSBS
          ? null
          : identifySpecialRegion(input.point.localities, input.address);
        const price = calculatePrice({
          deliveryAddress: input.address,
          deliveryLocalities: input.point.localities,
          isOutsideSBS: input.isOutsideSBS,
          oneWayKm: route.oneWayKm,
          totalKm: route.distanceKm,
        });
        return {
          address: input.address,
          classification: input.isOutsideSBS
            ? "viagem"
            : specialRegion?.name || "local",
          routeType: input.routeType,
          oneWayKm: route.oneWayKm,
          distanceKm: route.distanceKm,
          relevantDistanceKm: input.isOutsideSBS || specialRegion
            ? route.distanceKm
            : route.oneWayKm,
          price,
          delivery: { lat: input.point.lat, lon: input.point.lon },
        };
      });

      const sharedTrips = hasSharedExternalTrip
        ? [{
            id: sharedTripId,
            classification: "viagem",
            routeType: "balanced",
            deliveryIndexes: sharedExternalIndexes,
            distanceKm: sharedExternalRoute.distanceKm,
            price: calculatePrice({
              isOutsideSBS: true,
              totalKm: sharedExternalRoute.distanceKm,
            }),
          }]
        : [];
      const totalPrice =
        deliveries.reduce(
          (total, item) => total + (Number.isSafeInteger(item.price) ? item.price : 0),
          0,
        ) +
        sharedTrips.reduce((total, trip) => total + trip.price, 0);

      const response = { ok: true, deliveries, totalPrice };
      if (sharedTrips.length) response.sharedTrips = sharedTrips;
      if (!usesDeliveries) {
        const result = deliveries[0];
        Object.assign(response, {
          price: result.price,
          oneWayKm: result.oneWayKm,
          distanceKm: result.distanceKm,
          distanceKmBalanced: result.classification === "viagem" ? result.distanceKm : null,
          km: result.distanceKm,
          distance: result.distanceKm,
          distance_km: result.distanceKm,
          pickup: { lat: pickupPoint.lat, lon: pickupPoint.lon },
          delivery: result.delivery,
        });
      }

      if (env.QUOTE_SIGNING_SECRET) {
        const snapshot = {
          version: QUOTE_PROOF_VERSION,
          pickup,
          deliveries: deliveries.map(({ delivery: _coordinates, ...item }) => item),
          sharedTrips,
          totalPrice,
          totalDistanceKm: officialTotalDistance(deliveries, sharedTrips),
        };
        response.protectedQuote = {
          snapshot,
          proof: await createProof(snapshot, env.QUOTE_SIGNING_SECRET, env.QUOTE_PROOF_TTL_SECONDS),
        };
      }

      return json(response, 200, corsHeaders);
    } catch {
      telemetry.technicalErrors += 1;
      console.error(JSON.stringify({ event: "quote_error", type: "internal" }));
      return json({ error: "Erro interno ao calcular a rota." }, 500, corsHeaders);
    } finally {
      console.log(JSON.stringify({
        ...telemetry,
        durationMs: Date.now() - startedAt,
      }));
    }
  },
};

async function createProof(snapshot, secret, configuredTtl) {
  const issuedAt = Math.floor(Date.now() / 1000);
  const requestedTtl = Number(configuredTtl);
  const ttl = Number.isInteger(requestedTtl) && requestedTtl >= 60 && requestedTtl <= 3600
    ? requestedTtl : QUOTE_TTL_SECONDS;
  const unsigned = {
    version: QUOTE_PROOF_VERSION,
    jti: randomToken(24),
    issuedAt,
    expiresAt: issuedAt + ttl,
    snapshotHash: await sha256(canonicalJson(snapshot)),
  };
  return { ...unsigned, signature: await hmac(unsigned, secret) };
}

async function submitQuote(request, env, corsHeaders) {
  if (!env.QUOTE_SIGNING_SECRET) return json({ error: "Confirmação protegida indisponível." }, 503, corsHeaders);
  if (!env.QUOTE_DB) return json({ error: "Armazenamento de orçamento indisponível." }, 503, corsHeaders);
  let body;
  try { body = await request.json(); } catch { return json({ error: "JSON inválido." }, 400, corsHeaders); }
  const proof = body?.proof;
  const snapshot = body?.snapshot;
  if (!validProofShape(proof) || !validSnapshot(snapshot)) return json({ error: "Prova de orçamento inválida." }, 400, corsHeaders);
  const expectedSignature = await hmac({
    version: proof.version, jti: proof.jti, issuedAt: proof.issuedAt,
    expiresAt: proof.expiresAt, snapshotHash: proof.snapshotHash,
  }, env.QUOTE_SIGNING_SECRET);
  const snapshotHash = await sha256(canonicalJson(snapshot));
  if (!constantTimeEqual(proof.signature, expectedSignature) || !constantTimeEqual(proof.snapshotHash, snapshotHash)) {
    return json({ error: "Prova de orçamento inválida." }, 400, corsHeaders);
  }
  if (proof.expiresAt <= Math.floor(Date.now() / 1000)) return json({ error: "Prova de orçamento expirada." }, 410, corsHeaders);
  const details = validateDetails(body.details);
  if (!details) return json({ error: "Dados complementares inválidos." }, 400, corsHeaders);

  const publicToken = await derivePublicToken(proof.jti, env.QUOTE_SIGNING_SECRET);
  let existing;
  try {
    existing = await first(env.QUOTE_DB, "SELECT code, created_at, expires_at FROM protected_quotes WHERE quote_jti = ?", proof.jti);
  } catch {
    return quoteStorageUnavailable(corsHeaders);
  }
  if (existing) return json(publicRecord(existing, publicToken, request.url, true), 200, corsHeaders);

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = `FL-${randomFromAlphabet(8)}`;
    const tokenHash = await sha256(publicToken);
    try {
      await run(env.QUOTE_DB, `INSERT INTO protected_quotes
        (code, public_token_hash, quote_jti, status, created_at, expires_at, pickup,
         deliveries_json, official_quote_json, total_price, total_distance_km, source,
         customer_name, pickup_ref, delivery_refs_json, timing_mode, scheduled_at,
         item_description, invoice_required)
        VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      code, tokenHash, proof.jti, new Date().toISOString(), new Date(proof.expiresAt * 1000).toISOString(),
      snapshot.pickup, JSON.stringify(snapshot.deliveries), JSON.stringify(snapshot), snapshot.totalPrice,
      snapshot.totalDistanceKm, details.source, details.name, details.pickupRef,
      JSON.stringify(details.deliveryRefs), details.timingMode, details.scheduledAt,
      details.item, details.invoiceRequired);
      const record = await first(env.QUOTE_DB, "SELECT code, created_at, expires_at FROM protected_quotes WHERE quote_jti = ?", proof.jti);
      return json(publicRecord(record || { code, created_at: new Date().toISOString(), expires_at: new Date(proof.expiresAt * 1000).toISOString() }, publicToken, request.url, false), 201, corsHeaders);
    } catch {
      let concurrent;
      try {
        concurrent = await first(env.QUOTE_DB, "SELECT code, created_at, expires_at FROM protected_quotes WHERE quote_jti = ?", proof.jti);
      } catch {
        return quoteStorageUnavailable(corsHeaders);
      }
      if (concurrent) return json(publicRecord(concurrent, publicToken, request.url, true), 200, corsHeaders);
      if (attempt === 4) return quoteStorageUnavailable(corsHeaders);
    }
  }
}

async function verifyQuote(token, env) {
  const headers = secureHtmlHeaders();
  if (!env.QUOTE_DB || !/^[A-Za-z0-9_-]{40,80}$/.test(token)) return htmlVerification(null, headers);
  try {
    const record = await first(env.QUOTE_DB, `SELECT code, status, created_at, expires_at, pickup,
      deliveries_json, total_price, total_distance_km, timing_mode, scheduled_at
      FROM protected_quotes WHERE public_token_hash = ?`, await sha256(token));
    return htmlVerification(record, headers);
  } catch {
    return htmlVerificationUnavailable(headers);
  }
}

function htmlVerification(record, headers) {
  let state = "🔴 INVÁLIDO / NÃO ENCONTRADO";
  if (record) {
    if (record.status !== "active") state = "🔴 INVÁLIDO";
    else if (Date.parse(record.expires_at) <= Date.now()) state = "🟡 EXPIRADO";
    else state = "🟢 VÁLIDO";
  }
  let deliveries = [];
  try { deliveries = JSON.parse(record?.deliveries_json || "[]"); } catch { deliveries = []; }
  const destinations = deliveries.map((item) => `<li>${escapeHtml(item.address)}</li>`).join("");
  const content = record ? `<dl><dt>Código</dt><dd>${escapeHtml(record.code)}</dd><dt>Coleta</dt><dd>${escapeHtml(record.pickup)}</dd><dt>Destinos</dt><dd><ol>${destinations}</ol></dd><dt>Distância</dt><dd>${escapeHtml(record.total_distance_km)} km</dd><dt>Valor</dt><dd>R$ ${escapeHtml(record.total_price)}</dd><dt>Solicitado</dt><dd>${escapeHtml(record.created_at)}</dd>${record.scheduled_at ? `<dt>Agendamento</dt><dd>${escapeHtml(record.scheduled_at)}</dd>` : ""}<dt>Validade</dt><dd>${escapeHtml(record.expires_at)}</dd></dl>` : "";
  return new Response(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Verificação de orçamento</title></head><body><main><h1>${state}</h1>${content}</main></body></html>`, { status: record ? 200 : 404, headers });
}

function htmlVerificationUnavailable(headers) {
  return new Response("<!doctype html><html lang=\"pt-BR\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width\"><title>Verificação indisponível</title></head><body><main><h1>Serviço temporariamente indisponível</h1><p>Tente novamente mais tarde.</p></main></body></html>", { status: 503, headers });
}

function validProofShape(value) {
  return value?.version === QUOTE_PROOF_VERSION && /^[A-Za-z0-9_-]{20,80}$/.test(value.jti) &&
    Number.isInteger(value.issuedAt) && Number.isInteger(value.expiresAt) &&
    /^[a-f0-9]{64}$/.test(value.snapshotHash) && /^[a-f0-9]{64}$/.test(value.signature);
}

function validSnapshot(value) {
  return value?.version === QUOTE_PROOF_VERSION && validAddress(value.pickup) &&
    Array.isArray(value.deliveries) && value.deliveries.length > 0 && value.deliveries.length <= MAX_DELIVERIES &&
    Array.isArray(value.sharedTrips) && Number.isSafeInteger(value.totalPrice) && value.totalPrice >= 0 &&
    typeof value.totalDistanceKm === "number" && Number.isFinite(value.totalDistanceKm) && value.totalDistanceKm >= 0;
}

function validateDetails(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const limited = (input, max) => input == null ? null : typeof input === "string" && input.trim().length <= max ? input.trim() : undefined;
  const deliveryRefs = value.deliveryRefs ?? [];
  const result = {
    name: limited(value.name, 120), pickupRef: limited(value.pickupRef, 200), item: limited(value.item, 200),
    scheduledAt: limited(value.scheduledAt, 40), source: limited(value.source, 40), deliveryRefs,
    timingMode: value.timingMode ?? null, invoiceRequired: value.invoiceRequired ?? null,
  };
  if (Object.values(result).includes(undefined) || !Array.isArray(deliveryRefs) || deliveryRefs.length > MAX_DELIVERIES ||
      deliveryRefs.some((item) => limited(item, 200) === undefined) ||
      (result.source && !/^[A-Za-z0-9._-]+$/.test(result.source)) ||
      ![null, "now", "scheduled"].includes(result.timingMode) ||
      ![null, true, false].includes(result.invoiceRequired)) return null;
  result.deliveryRefs = deliveryRefs.map((item) => item.trim());
  return result;
}

function officialTotalDistance(deliveries, sharedTrips) {
  return Math.round((deliveries.reduce((sum, item) => sum + (typeof item.distanceKm === "number" ? item.distanceKm : 0), 0) +
    sharedTrips.reduce((sum, item) => sum + item.distanceKm, 0)) * 10) / 10;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

async function hmac(value, secret) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(canonicalJson(value))));
}
async function derivePublicToken(jti, secret) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const token = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`quote-verification-token:v1:${jti}`));
  return base64Url(new Uint8Array(token));
}
async function sha256(value) { return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))); }
function hex(buffer) { return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join(""); }
function constantTimeEqual(a, b) { if (typeof a !== "string" || a.length !== b.length) return false; let different = 0; for (let i = 0; i < a.length; i += 1) different |= a.charCodeAt(i) ^ b.charCodeAt(i); return different === 0; }
function randomToken(bytes) { const data = crypto.getRandomValues(new Uint8Array(bytes)); return base64Url(data); }
function base64Url(bytes) { let value = ""; for (const byte of bytes) value += String.fromCharCode(byte); return btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
function randomFromAlphabet(length) { const bytes = crypto.getRandomValues(new Uint8Array(length)); return [...bytes].map((byte) => CODE_ALPHABET[byte % CODE_ALPHABET.length]).join(""); }
function first(db, sql, ...values) { return db.prepare(sql).bind(...values).first(); }
function run(db, sql, ...values) { return db.prepare(sql).bind(...values).run(); }
function publicRecord(record, token, requestUrl, idempotent) { return { ok: true, code: record.code, createdAt: record.created_at, expiresAt: record.expires_at, verificationUrl: `${new URL(requestUrl).origin}/quote/verify/${token}`, idempotent }; }
function quoteStorageUnavailable(corsHeaders) { return json({ error: "Armazenamento de orçamento temporariamente indisponível." }, 503, corsHeaders); }
function escapeHtml(value) { return String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]); }
function secureHtmlHeaders() { return { "Content-Type": "text/html; charset=UTF-8", "Cache-Control": "no-store", "Content-Security-Policy": "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'", "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY", "Referrer-Policy": "no-referrer" }; }

export function calculatePrice({
  deliveryAddress,
  deliveryLocalities = [],
  isOutsideSBS,
  oneWayKm,
  totalKm,
}) {
  let rawPrice;

  if (isOutsideSBS) {
    rawPrice = totalKm * RATE_PER_KM;
  } else {
    const specialRegion = identifySpecialRegion(deliveryLocalities, deliveryAddress);
    if (specialRegion) {
      rawPrice =
        specialRegion.basePrice +
        Math.max(0, totalKm - specialRegion.includedKm) * RATE_PER_KM;
    } else {
      rawPrice = 15 + Math.max(0, oneWayKm - 12) * RATE_PER_KM;
    }
  }

  return Math.ceil(rawPrice);
}

function validAddress(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function corsHeadersFor(origin, configuredOrigins) {
  if (!origin) return {};

  const allowedOrigins = String(configuredOrigins || "")
    .split(",")
    .map((value) => value.trim())
    .filter(isCanonicalWebOrigin);

  if (!allowedOrigins.includes(origin)) return null;
  return {
    "Access-Control-Allow-Origin": origin,
    Vary: "Origin",
  };
}

function isCanonicalWebOrigin(value) {
  if (!value || value === "*") return false;
  try {
    const parsed = new URL(value);
    return (parsed.protocol === "https:" || parsed.protocol === "http:") && parsed.origin === value;
  } catch {
    return false;
  }
}

function identifySpecialRegion(deliveryLocalities, deliveryAddress) {
  const geocodedLocation = normalizeText(deliveryLocalities.join(" "));
  const rawAddress = normalizeText(deliveryAddress);
  return (
    SPECIAL_REGIONS.find(
      ({ match }) => geocodedLocation.includes(match) || rawAddress.includes(match),
    ) || null
  );
}

function normalizeText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeAddressKey(value) {
  return String(value).normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

function readBaseCoordinates(env) {
  if (env.BASE_LAT === undefined || env.BASE_LON === undefined) return null;
  const lat = Number(env.BASE_LAT);
  const lon = Number(env.BASE_LON);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  return { lat, lon, city: "", localities: [] };
}

async function geocode(address, apiKey, telemetry) {
  const cache = globalThis.caches?.default;
  let cacheRequest = null;
  if (cache) {
    try {
      cacheRequest = await geocodeCacheRequest(address);
    } catch {
      telemetry.technicalErrors += 1;
    }
  }
  if (cache && cacheRequest) {
    try {
      const cachedResponse = await cache.match(cacheRequest);
      if (cachedResponse) {
        const cachedPoint = await cachedResponse.json();
        if (validCachedGeocodePoint(cachedPoint)) {
          telemetry.geocodeCacheHits += 1;
          return cachedPoint;
        }
      }
    } catch {
      telemetry.technicalErrors += 1;
    }
  }
  telemetry.geocodeCacheMisses += 1;
  telemetry.geocodingCalls += 1;
  const url =
    "https://api.geoapify.com/v1/geocode/search?" +
    new URLSearchParams({
      text: address,
      format: "json",
      limit: "1",
      filter: "countrycode:br",
      apiKey,
    });
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Erro Geoapify geocode: ${response.status}`);

  const payload = await response.json();
  const result = payload?.results?.[0];
  if (!isAcceptableGeocodeResult(result)) return null;
  const point = {
    lat: Number(result.lat),
    lon: Number(result.lon),
    city: result.city || result.county || result.municipality || "",
    localities: [
      result.suburb,
      result.district,
      result.neighbourhood,
      result.quarter,
      result.village,
      result.hamlet,
    ].filter((value) => typeof value === "string" && value.trim()),
  };
  if (!validPoint(point)) return null;

  if (cache && cacheRequest) {
    try {
      await cache.put(cacheRequest, new Response(JSON.stringify(point), {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": `public, max-age=${GEOCODE_CACHE_TTL_SECONDS}`,
        },
      }));
    } catch {
      telemetry.technicalErrors += 1;
    }
  }
  return point;
}

async function geocodeCacheRequest(address) {
  const bytes = new TextEncoder().encode(normalizeAddressKey(address));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hash = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return new Request(`https://geocode-cache.invalid/v2/${hash}`);
}

function isAcceptableGeocodeResult(result) {
  if (!validPoint(result)) return false;

  const rank = result?.rank;
  if (!rank || typeof rank !== "object") return false;

  const confidence = Number(rank.confidence);
  const cityConfidence = Number(rank.confidence_city_level);
  const streetConfidence = Number(rank.confidence_street_level);
  const resultType = String(result.result_type || "").toLowerCase();
  const matchType = String(rank.match_type || "").toLowerCase();

  if (!Number.isFinite(confidence) || confidence < GEOCODE_MIN_CONFIDENCE) return false;
  if (LOW_PRECISION_GEOCODE_RESULT_TYPES.has(resultType)) return false;
  if (LOW_PRECISION_GEOCODE_MATCH_TYPES.has(matchType)) return false;
  if (Number.isFinite(cityConfidence) && cityConfidence < GEOCODE_MIN_CITY_CONFIDENCE) return false;
  if (Number.isFinite(streetConfidence) && streetConfidence < GEOCODE_MIN_STREET_CONFIDENCE) return false;

  return true;
}

function validPoint(point) {
  return Number.isFinite(point?.lat) && Number.isFinite(point?.lon) &&
    point.lat >= -90 && point.lat <= 90 && point.lon >= -180 && point.lon <= 180;
}

function validCachedGeocodePoint(point) {
  return validPoint(point) && typeof point.city === "string" &&
    Array.isArray(point.localities) &&
    point.localities.every((value) => typeof value === "string");
}

async function getRoute(points, apiKey, routeType = "short", telemetry) {
  telemetry.routingCalls += 1;
  const waypoints = points.map((point) => `${point.lat},${point.lon}`).join("|");
  const url =
    "https://api.geoapify.com/v1/routing?" +
    new URLSearchParams({
      waypoints,
      mode: "motorcycle",
      type: routeType,
      details: "instruction_details",
      apiKey,
    });
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Erro Geoapify routing: ${response.status}`);

  const routeProperties = (await response.json())?.features?.[0]?.properties;
  const meters = routeProperties?.distance;
  if (typeof meters !== "number" || !Number.isFinite(meters) || meters < 0) return null;

  const oneWayLegs = routeProperties?.legs?.slice(0, 2);
  const hasValidOneWayLegs =
    oneWayLegs?.length === 2 &&
    oneWayLegs.every(
      (leg) => typeof leg?.distance === "number" && Number.isFinite(leg.distance) &&
        leg.distance >= 0,
    );

  return {
    distanceKm: Math.round((meters / 1000) * 10) / 10,
    oneWayKm: hasValidOneWayLegs
      ? Math.round(
          (oneWayLegs.reduce((total, leg) => total + leg.distance, 0) / 1000) * 10,
        ) / 10
      : null,
  };
}

function json(data, status, corsHeaders) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json; charset=UTF-8",
      "Cache-Control": "no-store",
    },
  });
}
