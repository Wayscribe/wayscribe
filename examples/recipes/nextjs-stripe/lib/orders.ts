// Your application's own code. Nothing here knows about Wayscribe.

const paid = new Map<string, string>();

/** Stands in for your database write. */
export function markOrderPaid(
  orderId: string,
  checkoutSessionId: string
): Promise<{ orderId: string }> {
  paid.set(orderId, checkoutSessionId);
  return Promise.resolve({ orderId });
}

/** `1999` and `usd` become `19.99 USD`. */
export function formatAmount(amount: number | null, currency: string | null): string {
  if (amount === null || currency === null) return "no amount";
  return `${(amount / 100).toFixed(2)} ${currency.toUpperCase()}`;
}
