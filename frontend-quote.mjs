export const ROUTE_API = "https://fonseca-logistica-api.fonsecalogistica047.workers.dev";

export async function requestOfficialQuote(pickup, deliveries, fetchImpl = fetch) {
  let response;
  try {
    response = await fetchImpl(ROUTE_API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pickup, deliveries: deliveries.map(({ address }) => address) }),
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

  const validDeliveries =
    quote.ok === true &&
    Array.isArray(quote.deliveries) &&
    quote.deliveries.length === deliveries.length &&
    quote.deliveries.every(
      (delivery, index) =>
        delivery &&
        delivery.address === deliveries[index].address &&
        Number.isSafeInteger(delivery.price) &&
        Number.isFinite(delivery.distanceKm) &&
        delivery.price >= 0 &&
        delivery.distanceKm >= 0,
    );
  const individualTotal = validDeliveries
    ? quote.deliveries.reduce((total, delivery) => total + delivery.price, 0)
    : NaN;

  if (
    !validDeliveries ||
    !Number.isSafeInteger(quote.totalPrice) ||
    quote.totalPrice < 0 ||
    quote.totalPrice !== individualTotal
  ) {
    throw new Error("O servidor retornou um orçamento inválido. Tente novamente.");
  }

  return quote;
}
