export function createCheckout(cartId: string) {
  return { cartId, status: "ready" };
}
