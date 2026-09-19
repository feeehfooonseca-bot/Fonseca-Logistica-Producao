const RATE_PER_KM = 1.1;

const SPECIAL_REGIONS = [
  { name: "rio_vermelho_estacao", match: "rio vermelho estacao", basePrice: 25, includedKm: 12 },
  { name: "rio_vermelho_povoado", match: "rio vermelho povoado", basePrice: 20, includedKm: 8 },
  { name: "rio_natal", match: "rio natal", basePrice: 30, includedKm: 16 },
];

export default {
  async fetch(request, env) {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    if (request.method !== "POST") {
      return json({ error: "Método não permitido." }, 405, corsHeaders);
    }

    try {
      if (!env.GEOAPIFY_API_KEY) {
        return json({ error: "GEOAPIFY_API_KEY não configurada." }, 500, corsHeaders);
      }

      if (!env.ENDERECO_BASE) {
        return json({ error: "ENDERECO_BASE não configurado." }, 500, corsHeaders);
      }

      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: "JSON inválido." }, 400, corsHeaders);
      }

      const pickup = String(body?.pickup || "").trim();
      const delivery = String(body?.delivery || "").trim();

      if (!pickup || !delivery) {
        return json(
          { error: "Informe os endereços de coleta e entrega." },
          400,
          corsHeaders,
        );
      }

      const baseAddress = String(env.ENDERECO_BASE).trim();
      const [base, pickupPoint, deliveryPoint] = await Promise.all([
        geocode(baseAddress, env.GEOAPIFY_API_KEY),
        geocode(pickup, env.GEOAPIFY_API_KEY),
        geocode(delivery, env.GEOAPIFY_API_KEY),
      ]);

      if (!base) {
        return json({ error: "Não foi possível localizar a base." }, 422, corsHeaders);
      }
      if (!pickupPoint) {
        return json({ error: "Falha ao localizar endereço de coleta." }, 422, corsHeaders);
      }
      if (!deliveryPoint) {
        return json({ error: "Falha ao localizar endereço de entrega." }, 422, corsHeaders);
      }

      const isOutsideSBS = normalizeText(deliveryPoint.city) !== "sao bento do sul";
      const routeType = isOutsideSBS ? "balanced" : "short";
      const route = await getRoute(
        [base, pickupPoint, deliveryPoint, base],
        env.GEOAPIFY_API_KEY,
        routeType,
      );

      if (!route || (!isOutsideSBS && route.oneWayKm === null)) {
        return json({ error: "Não foi possível calcular a rota." }, 502, corsHeaders);
      }

      const price = calculatePrice({
        deliveryAddress: delivery,
        isOutsideSBS,
        oneWayKm: route.oneWayKm,
        totalKm: route.distanceKm,
      });

      return json(
        {
          ok: true,
          price,
          oneWayKm: route.oneWayKm,
          distanceKm: route.distanceKm,
          distanceKmBalanced: isOutsideSBS ? route.distanceKm : null,
          km: route.distanceKm,
          distance: route.distanceKm,
          distance_km: route.distanceKm,
          base: { lat: base.lat, lon: base.lon },
          pickup: { lat: pickupPoint.lat, lon: pickupPoint.lon },
          delivery: { lat: deliveryPoint.lat, lon: deliveryPoint.lon },
        },
        200,
        corsHeaders,
      );
    } catch (error) {
      console.error(error);
      return json({ error: "Erro interno ao calcular a rota." }, 500, corsHeaders);
    }
  },
};

export function calculatePrice({ deliveryAddress, isOutsideSBS, oneWayKm, totalKm }) {
  let rawPrice;

  if (isOutsideSBS) {
    rawPrice = totalKm * RATE_PER_KM;
  } else {
    const specialRegion = identifySpecialRegion(deliveryAddress);
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

function identifySpecialRegion(deliveryAddress) {
  const normalizedAddress = normalizeText(deliveryAddress);
  return SPECIAL_REGIONS.find(({ match }) => normalizedAddress.includes(match)) || null;
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

async function geocode(address, apiKey) {
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
  return {
    lat: Number(result.lat),
    lon: Number(result.lon),
    city: result.city || result.county || result.municipality || "",
  };
}

async function getRoute(points, apiKey, routeType = "short") {
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
