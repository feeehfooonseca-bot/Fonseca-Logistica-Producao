export const ROUTE_API = "https://fonseca-logistica-api.fonsecalogistica047.workers.dev";
export const MAX_DELIVERIES = 20;

export async function requestOfficialQuote(pickup, deliveries, fetchImpl = fetch, locations) {
  if (!Array.isArray(deliveries) || deliveries.length > MAX_DELIVERIES) {
    throw new Error(`Cada orçamento aceita no máximo ${MAX_DELIVERIES} entregas.`);
  }

  let response;
  try {
    response = await fetchImpl(ROUTE_API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pickup, deliveries: deliveries.map(({ address }) => address),
        ...(locations ? { locations } : {}) }),
    });
  } catch {
    throw new Error("Não foi possível conectar ao serviço de orçamento. Tente novamente.");
  }

  let quote = {};
  try {
    quote = await response.json();
  } catch {
    // A mensagem pública abaixo não expõe detalhes da resposta do serviço.
  }

  if (!response.ok) {
    throw new Error(
      typeof quote.error === "string" && quote.error
        ? quote.error
        : "Não foi possível localizar os endereços e calcular a rota.",
    );
  }

  if (locations) {
    const validPoint = point => Number.isFinite(point?.lat) && Number.isFinite(point?.lon) &&
      Math.abs(point.lat) <= 90 && Math.abs(point.lon) <= 180;
    const samePoint = (actual, selected) => !selected ||
      (actual.lat === selected.lat && actual.lon === selected.lon);
    if (!validPoint(quote.locations?.pickup) ||
        !Array.isArray(quote.locations?.deliveries) ||
        quote.locations.deliveries.length !== deliveries.length ||
        !quote.locations.deliveries.every(validPoint) ||
        !samePoint(quote.locations.pickup, locations.pickup) ||
        !quote.locations.deliveries.every((point, index) => samePoint(point, locations.deliveries[index]))) {
      throw new Error("O serviço não confirmou os pontos marcados. Não foi gerada uma estimativa para essas localizações.");
    }
  }

  const sharedTrips = quote.sharedTrips === undefined ? [] : quote.sharedTrips;
  const sharedByDelivery = new Map();
  const sharedIds = new Set();
  const validSharedTrips =
    Array.isArray(sharedTrips) &&
    sharedTrips.every((trip) => {
      if (
        !trip ||
        typeof trip.id !== "string" ||
        !trip.id ||
        sharedIds.has(trip.id) ||
        trip.classification !== "viagem" ||
        trip.routeType !== "balanced" ||
        !Array.isArray(trip.deliveryIndexes) ||
        trip.deliveryIndexes.length < 2 ||
        !Number.isSafeInteger(trip.price) ||
        trip.price < 0 ||
        !Number.isFinite(trip.distanceKm) ||
        trip.distanceKm < 0
      ) return false;

      sharedIds.add(trip.id);
      for (const index of trip.deliveryIndexes) {
        if (
          !Number.isSafeInteger(index) ||
          index < 0 ||
          index >= deliveries.length ||
          sharedByDelivery.has(index)
        ) return false;
        sharedByDelivery.set(index, trip);
      }
      return true;
    });

  const validDeliveries =
    quote.ok === true &&
    validSharedTrips &&
    Array.isArray(quote.deliveries) &&
    quote.deliveries.length === deliveries.length &&
    quote.deliveries.every((delivery, index) => {
      if (!delivery || delivery.address !== deliveries[index].address) return false;
      const sharedTrip = sharedByDelivery.get(index);
      if (sharedTrip) {
        return (
          delivery.classification === "viagem" &&
          delivery.routeType === "balanced" &&
          delivery.pricingGroupId === sharedTrip.id &&
          delivery.price === null &&
          delivery.distanceKm === null
        );
      }
      return (
        Number.isSafeInteger(delivery.price) &&
        Number.isFinite(delivery.distanceKm) &&
        delivery.price >= 0 &&
        delivery.distanceKm >= 0 &&
        delivery.pricingGroupId === undefined
      );
    });

  const officialTotal = validDeliveries
    ? quote.deliveries.reduce(
        (total, delivery) => total + (Number.isSafeInteger(delivery.price) ? delivery.price : 0),
        0,
      ) + sharedTrips.reduce((total, trip) => total + trip.price, 0)
    : NaN;

  if (
    !validDeliveries ||
    !Number.isSafeInteger(quote.totalPrice) ||
    quote.totalPrice < 0 ||
    quote.totalPrice !== officialTotal
  ) {
    throw new Error("O servidor retornou um orçamento inválido. Tente novamente.");
  }

  return quote;
}

