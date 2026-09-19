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

      const baseAddress = String(env.ENDERECO_BASE).trim();
      const [base, pickupPoint, ...deliveryPoints] = await Promise.all([
        geocode(baseAddress, env.GEOAPIFY_API_KEY),
        geocode(pickup, env.GEOAPIFY_API_KEY),
        ...deliveryAddresses.map((address) => geocode(address, env.GEOAPIFY_API_KEY)),
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
          getRoute([base, pickupPoint, point, base], env.GEOAPIFY_API_KEY, routeType),
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
          base: { lat: base.lat, lon: base.lon },
          pickup: { lat: pickupPoint.lat, lon: pickupPoint.lon },
          delivery: result.delivery,
        });
      }

      return json(response, 200, corsHeaders);
    } catch (error) {
      console.error(error);
      return json({ error: "Erro interno ao calcular a rota." }, 500, corsHeaders);
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
    localities: [
      result.suburb,
      result.district,
      result.neighbourhood,
      result.quarter,
      result.village,
      result.hamlet,
    ].filter((value) => typeof value === "string" && value.trim()),
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
