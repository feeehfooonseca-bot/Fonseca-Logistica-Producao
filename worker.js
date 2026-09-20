const RATE_PER_KM = 1.1;
const GEOCODE_CACHE_TTL_SECONDS = 86400;

const SPECIAL_REGIONS = [
  { name: "rio_vermelho_estacao", match: "rio vermelho estacao", basePrice: 25, includedKm: 12 },
  { name: "rio_vermelho_povoado", match: "rio vermelho povoado", basePrice: 20, includedKm: 8 },
  { name: "rio_natal", match: "rio natal", basePrice: 30, includedKm: 16 },
];

export default {
  async fetch(request, env) {
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
    const origin = request.headers.get("Origin");
    const corsHeaders = corsHeadersFor(origin, env.ALLOWED_ORIGINS);

    if (origin && !corsHeaders) {
      return json({ error: "Origem não autorizada." }, 403);
    }

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          ...corsHeaders,
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
          "Access-Control-Max-Age": "86400",
        },
      });
    }

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
        return json({ error: "Falha ao localizar endereço de coleta." }, 422, corsHeaders);
      }
      if (deliveryPoints.some((point) => !point)) {
        return json({ error: "Falha ao localizar endereço de entrega." }, 422, corsHeaders);
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
      const routes = await Promise.all(
        quoteInputs.map(({ point, routeType }) =>
          getRoute(
            [base, pickupPoint, point, base],
            env.GEOAPIFY_API_KEY,
            routeType,
            telemetry,
          ),
        ),
      );

      if (
        routes.some(
          (route, index) => !route || (!quoteInputs[index].isOutsideSBS && route.oneWayKm === null),
        )
      ) {
        return json({ error: "Não foi possível calcular a rota." }, 502, corsHeaders);
      }

      const deliveries = quoteInputs.map((input, index) => {
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
      const totalPrice = deliveries.reduce((total, item) => total + item.price, 0);

      const response = { ok: true, deliveries, totalPrice };
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
        if (validPoint(cachedPoint)) {
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

  const result = (await response.json())?.results?.[0];
  if (!result) return null;
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
  return new Request(`https://geocode-cache.invalid/v1/${hash}`);
}

function validPoint(point) {
  return Number.isFinite(point?.lat) && Number.isFinite(point?.lon) &&
    point.lat >= -90 && point.lat <= 90 && point.lon >= -180 && point.lon <= 180;
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
  if (typeof meters !== "number" || !Number.isFinite(meters)) return null;

  const oneWayLegs = routeProperties?.legs?.slice(0, 2);
  const hasValidOneWayLegs =
    oneWayLegs?.length === 2 &&
    oneWayLegs.every(
      (leg) => typeof leg?.distance === "number" && Number.isFinite(leg.distance),
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
