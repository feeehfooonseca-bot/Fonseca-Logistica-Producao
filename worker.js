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
  async scheduled(_event, env, ctx) {
    if (!env.QUOTE_DB) return;
    ctx.waitUntil((async()=>{
      await env.QUOTE_DB.prepare("DELETE FROM abuse_counters WHERE expires_at < ?").bind(Math.floor(Date.now()/1000)).run();
      await env.QUOTE_DB.prepare("DELETE FROM protected_quotes WHERE expires_at < ?").bind(new Date(Date.now()-72*3600000).toISOString()).run();
    })());
  },
  async fetch(request, env) {
    const url = new URL(request.url);
    const corsHeaders = corsHeadersFor(request.headers.get("Origin"), env.ALLOWED_ORIGINS);
    if (request.headers.get("Origin") && !corsHeaders) {
      return json({ error: "Origem não autorizada." }, 403);
    }
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: {
        ...corsHeaders, "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, X-Fonseca-Session", "Access-Control-Max-Age": "86400",
      } });
    }
    const knownPost = ["/", "/quote", "/quote/submit", "/locations/search", "/security/session"].includes(url.pathname);
    const verifyRead = url.pathname.startsWith("/quote/verify/") && request.method === "GET";
    if ((knownPost && request.method === "POST") || verifyRead) {
      const denied = await abuseGuard(request, env, corsHeaders, verifyRead);
      if (denied) return denied;
    }
    if (url.pathname === "/security/session") {
      if (request.method !== "POST") return json({ error: "Método não permitido." }, 405, corsHeaders);
      return issueBrowserSession(request, env, corsHeaders);
    }
    if (url.pathname === "/quote/submit") {
      if (request.method !== "POST") return json({ error: "Método não permitido." }, 405, corsHeaders);
      return submitQuote(request, env, corsHeaders);
    }
    if (url.pathname.startsWith("/quote/verify/")) {
      if (request.method !== "GET") return json({ error: "Método não permitido." }, 405, corsHeaders);
      return verifyQuote(url.pathname.slice("/quote/verify/".length), env);
    }
    if (url.pathname === "/locations/search") {
      if (request.method !== "POST") return json({ error: "Método não permitido." }, 405, corsHeaders);
      try {
        const body = await readBoundedJson(request);
        const text = validAddress(body?.text);
        if (!text) return json({ error: "Informe rua, estabelecimento ou cidade." }, 400, corsHeaders);
        const provider = body?.provider || "geoapify";
        if (!["geoapify", "tomtom"].includes(provider)) return json({ error: "Fonte de busca inválida." }, 400, corsHeaders);
        if (provider === "tomtom") {
          if (!env.TOMTOM_API_KEY) return json({ error: "Teste TomTom ainda não ativado. Use a busca atual por enquanto." }, 503, corsHeaders);
          const searchBody = {
            query: text, maxResults: 5,
            filters: { types: ["poi", "address", "street", "intersection", "area"], countryCodesIso2: ["BR"] },
            ...(validPoint(body.center) ? { preferences: { geometry: { type: "point", coordinates: [body.center.lon, body.center.lat] } } } : {}),
          };
          const response = await fetch("https://api.tomtom.com/maps/orbis/places/discover", {
            method: "POST", headers: {
              "TomTom-Api-Key": env.TOMTOM_API_KEY, "TomTom-Api-Version": "3",
              "Attributes": "results(position,title,subtitles,type,address.countryCodeIso2)",
              "Content-Type": "application/json", "Accept-Language": "pt-BR",
            }, body: JSON.stringify(searchBody), signal: AbortSignal.timeout(10000),
          });
          if (!response.ok) throw new Error("search unavailable");
          const payload = await response.json();
          const results = (Array.isArray(payload.results) ? payload.results : []).flatMap(result => {
            const coordinates = result.position?.coordinates;
            const point = { lat: coordinates?.[1], lon: coordinates?.[0] };
            if (result.address?.countryCodeIso2 !== "BR" || !validPoint(point)) return [];
            const label = [result.title, ...(Array.isArray(result.subtitles) ? result.subtitles : [])].filter(value => typeof value === "string" && value.trim()).join(", ");
            return [{ ...point, label: label || text, approximate: result.type === "area" || result.type === "street" }];
          }).slice(0, 5);
          return json({ provider, results }, 200, corsHeaders);
        }
        if (!env.GEOAPIFY_API_KEY) return json({ error: "Busca temporariamente indisponível." }, 503, corsHeaders);
        const response = await fetch("https://api.geoapify.com/v1/geocode/autocomplete?" + new URLSearchParams({
          text, format: "json", limit: "5", filter: "countrycode:br", lang: "pt",
          ...(validPoint(body.center) ? { bias: `proximity:${body.center.lon},${body.center.lat}` } : {}),
          apiKey: env.GEOAPIFY_API_KEY,
        }), { signal: AbortSignal.timeout(10000) });
        if (!response.ok) throw new Error("search unavailable");
        const payload = await response.json();
        const results = (Array.isArray(payload.results) ? payload.results : []).filter(validPoint).map(result => ({
          lat: result.lat, lon: result.lon, label: result.formatted || result.address_line1 || text,
          approximate: !isAcceptableGeocodeResult(result),
        }));
        return json({ provider, results }, 200, corsHeaders);
      } catch {
        return json({ error: "Não foi possível buscar. Você pode marcar o ponto no mapa." }, 503, corsHeaders);
      }
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
        body = await readBoundedJson(request);
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

      const locations = body.locations;
      if (locations !== undefined && (!locations || typeof locations !== "object" ||
          (locations.pickup != null && !validPoint(locations.pickup)) ||
          !Array.isArray(locations.deliveries) || locations.deliveries.length !== deliveryAddresses.length ||
          locations.deliveries.some(point => point != null && !validPoint(point)))) {
        return json({ error: "Localização inválida. Confirme os pontos no mapa." }, 400, corsHeaders);
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
        locations?.pickup ? resolveSelectedPoint(locations.pickup, env.GEOAPIFY_API_KEY, telemetry) : geocodeOnce(pickup),
        ...deliveryAddresses.map((address, index) => locations?.deliveries[index]
          ? resolveSelectedPoint(locations.deliveries[index], env.GEOAPIFY_API_KEY, telemetry)
          : geocodeOnce(address)),
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
      if (locations) response.locations = {
        pickup: { lat: pickupPoint.lat, lon: pickupPoint.lon },
        deliveries: deliveryPoints.map(({ lat, lon }) => ({ lat, lon })),
      };
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
        if (response.locations) snapshot.locations = response.locations;
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
  try { body = await readBoundedJson(request); } catch { return json({ error: "JSON inválido." }, 400, corsHeaders); }
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
  const invoiceRequiredDb = details.invoiceRequired === null ? null : Number(details.invoiceRequired);
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
      details.item, invoiceRequiredDb);
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
  if (!/^[A-Za-z0-9_-]{40,80}$/.test(token)) return htmlVerification(null, headers);
  if (!env.QUOTE_DB) return htmlVerificationUnavailable(headers);
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

/** @param {unknown} value */
function validateDetails(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const data = /** @type {{deliveryRefs?: unknown, name?: unknown, pickupRef?: unknown,
    item?: unknown, scheduledAt?: unknown, source?: unknown,
    timingMode?: unknown, invoiceRequired?: unknown}} */ (value);
  const limited = (input, max) => input == null ? null : typeof input === "string" && input.trim().length <= max ? input.trim() : undefined;
  const deliveryRefs = data.deliveryRefs ?? [];
  const timingMode = data.timingMode ?? null;
  const invoiceRequired = data.invoiceRequired ?? null;
  if (timingMode !== null && timingMode !== "now" && timingMode !== "scheduled") return null;
  if (invoiceRequired !== null && typeof invoiceRequired !== "boolean") return null;
  if (!Array.isArray(deliveryRefs)) return null;
  const result = {
    name: limited(data.name, 120), pickupRef: limited(data.pickupRef, 200), item: limited(data.item, 200),
    scheduledAt: limited(data.scheduledAt, 40), source: limited(data.source, 40), deliveryRefs,
    timingMode: typeof timingMode === "string" ? timingMode : null,
    invoiceRequired: typeof invoiceRequired === "boolean" ? invoiceRequired : null,
  };
  if (Object.values(result).includes(undefined) || !Array.isArray(deliveryRefs) || deliveryRefs.length > MAX_DELIVERIES ||
      deliveryRefs.some((item) => typeof item !== "string" || limited(item, 200) === undefined) ||
      (result.source && !/^[A-Za-z0-9._-]+$/.test(result.source))) return null;
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
  deliveryAddress = "",
  deliveryLocalities = [],
  isOutsideSBS,
  oneWayKm = NaN,
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
  return typeof value === "string" && value.trim() && value.length <= 500 && !/[\u0000-\u001f\u007f]/.test(value) ? value.trim() : null;
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
  // Cloudflare supplies caches.default; other JS runtimes may omit this extension.
  const cacheStorage = /** @type {{default?: Cache} | undefined} */ (Reflect.get(globalThis, "caches"));
  const cache = cacheStorage?.default;
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
      limit: "5",
      filter: "countrycode:br",
      apiKey,
    });
  const response = await fetch(url, { signal: AbortSignal.timeout(12000) });
  if (!response.ok) throw new Error(`Erro Geoapify geocode: ${response.status}`);

  const payload = await response.json();
  const result = payload?.results?.find(isAcceptableGeocodeResult);
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

async function resolveSelectedPoint(point, apiKey, telemetry) {
  // The client selects coordinates; locality and pricing classification remain server-owned.
  telemetry.geocodingCalls += 1;
  const response = await fetch("https://api.geoapify.com/v1/geocode/reverse?" + new URLSearchParams({
    lat: String(point.lat), lon: String(point.lon), format: "json", limit: "1", lang: "pt", apiKey,
  }), { signal: AbortSignal.timeout(12000) });
  if (!response.ok) throw new Error("reverse geocode unavailable");
  const result = (await response.json())?.results?.[0];
  const city = result?.city || result?.municipality;
  if (result?.country_code !== "br" || typeof city !== "string" || !city.trim()) return null;
  return {
    lat: point.lat, lon: point.lon, city,
    localities: [result.suburb, result.district, result.neighbourhood, result.quarter,
      result.village, result.hamlet].filter(value => typeof value === "string" && value.trim()),
  };
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
  const response = await fetch(url, { signal: AbortSignal.timeout(12000) });
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
      "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer",
    },
  });
}



// Rollout is explicit: enable only after migration, Turnstile and frontend are ready.
const REQUEST_BODY_LIMIT = 32768;
async function readBoundedJson(request) {
  const reader=request.body?.getReader();
  if (!reader) throw new Error("invalid json");
  const chunks=[];let size=0;
  while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;
    if(size>REQUEST_BODY_LIMIT){await reader.cancel();throw new Error("body too large");}chunks.push(value);}
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
  const result=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes));
  if(!result||typeof result!=="object"||Array.isArray(result))throw new Error("invalid json");
  return result;
}
function securityEnabled(env){return env.SECURITY_ENABLED === "true";}
function securityReady(env){return typeof env.ABUSE_SIGNING_SECRET === "string" && env.ABUSE_SIGNING_SECRET.length>=32 && env.TURNSTILE_SECRET_KEY && env.QUOTE_DB;}
function limitedJson(message,status,cors){const response=json({error:message},status,cors);if(status===429)response.headers.set("Retry-After","60");return response;}
async function consumeLimit(env,scope,identity,limit,period){
  const now=Math.floor(Date.now()/1000),bucket=Math.floor(now/period)*period;
  const key=await hmac({purpose:"abuse-counter-v1",scope,identity,day:Math.floor(now/86400)},env.ABUSE_SIGNING_SECRET);
  const row=await env.QUOTE_DB.prepare(`INSERT INTO abuse_counters (counter_key,bucket,requests,expires_at) VALUES (?,?,1,?)
    ON CONFLICT(counter_key,bucket) DO UPDATE SET requests=requests+1 WHERE requests < ? RETURNING requests`)
    .bind(key,bucket,bucket+period+86400,limit).first();
  return !!row;
}
async function abuseGuard(request,env,cors,verifyRead){
  if(request.method==="POST"){
    if(!/^application\/json(?:\s*;|$)/i.test(request.headers.get("Content-Type")||""))return limitedJson("Envie os dados em JSON.",415,cors);
    const length=request.headers.get("Content-Length");
    if(length && (!/^\d+$/.test(length)||Number(length)>REQUEST_BODY_LIMIT))return limitedJson("Solicitação muito grande.",413,cors);
  }
  if(!securityEnabled(env))return null;
  if(!securityReady(env))return limitedJson("Proteção temporariamente indisponível. Tente novamente.",503,cors);
  const ip=request.headers.get("CF-Connecting-IP"),origin=request.headers.get("Origin"),path=new URL(request.url).pathname;
  if(!ip||(!verifyRead&&!origin))return limitedJson("Acesse a calculadora pelo site oficial.",403,cors);
  const scope=verifyRead?"verify":path==="/security/session"?"session":path==="/locations/search"?"search":path==="/quote/submit"?"submit":"quote";
  try{
    const limit={session:6,search:60,quote:10,submit:10,verify:60}[scope];
    if(!await consumeLimit(env,scope,ip,limit,60))return limitedJson("Muitas solicitações. Aguarde um minuto e tente novamente.",429,cors);
    if(!verifyRead&&scope!=="session"&&!await validBrowserSession(request,env))return limitedJson("Validação de acesso necessária. Tente novamente.",401,cors);
    // Global caps count operations, not exact provider credits.
    if(scope==="quote"||scope==="search"){
      const configured=Number(scope==="quote"?env.DAILY_QUOTE_LIMIT:env.DAILY_SEARCH_LIMIT);
      const daily=Number.isInteger(configured)&&configured>=10&&configured<=10000?configured:scope==="quote"?200:1000;
      if(!await consumeLimit(env,"daily-"+scope,"global",daily,86400))return limitedJson("Limite de consultas atingido. Solicite atendimento pelo WhatsApp.",429,cors);
    }
    return null;
  }catch{return limitedJson("Proteção temporariamente indisponível. Tente novamente.",503,cors);}
}
async function sessionIdentity(request,env){return hmac({purpose:"browser-session-identity-v1",origin:request.headers.get("Origin"),ip:request.headers.get("CF-Connecting-IP")},env.ABUSE_SIGNING_SECRET);}
async function issueBrowserSession(request,env,cors){
  if(!securityEnabled(env))return json({enabled:false},200,cors);
  try{
    const body=await readBoundedJson(request),token=body.turnstileToken;
    if(typeof token!=="string"||!token||token.length>2048)return limitedJson("Complete a validação de acesso.",400,cors);
    const response=await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify",{
      method:"POST",headers:{"Content-Type":"application/json"},signal:AbortSignal.timeout(10000),
      body:JSON.stringify({secret:env.TURNSTILE_SECRET_KEY,response:token,remoteip:request.headers.get("CF-Connecting-IP")})});
    if(!response.ok)return limitedJson("Validação temporariamente indisponível.",503,cors);
    const validation=await response.json(),hostname=new URL(request.headers.get("Origin")).hostname;
    if(validation.success!==true||validation.hostname!==hostname||validation.action!=="fonseca_session")return limitedJson("Não foi possível validar o acesso. Tente novamente.",403,cors);
    const session={version:1,id:randomToken(24),identity:await sessionIdentity(request,env),expiresAt:Math.floor(Date.now()/1000)+1200};
    const encoded=base64Url(new TextEncoder().encode(JSON.stringify(session)));
    const signature=await hmac({purpose:"browser-session-v1",encoded},env.ABUSE_SIGNING_SECRET);
    return json({token:encoded+"."+signature,expiresAt:session.expiresAt},200,cors);
  }catch{return limitedJson("Validação temporariamente indisponível. Tente novamente.",503,cors);}
}
async function validBrowserSession(request,env){
  const token=request.headers.get("X-Fonseca-Session");if(!token||token.length>1000)return false;
  const [encoded,signature,...rest]=token.split(".");if(rest.length||!encoded||!/^[a-f0-9]{64}$/.test(signature||""))return false;
  try{
    if(!constantTimeEqual(signature,await hmac({purpose:"browser-session-v1",encoded},env.ABUSE_SIGNING_SECRET)))return false;
    const session=JSON.parse(atob(encoded.replace(/-/g,"+").replace(/_/g,"/")));
    const now=Math.floor(Date.now()/1000);
    return session.version===1&&Number.isInteger(session.expiresAt)&&session.expiresAt>now&&session.expiresAt<=now+1200&&constantTimeEqual(session.identity,await sessionIdentity(request,env));
  }catch{return false;}
}
