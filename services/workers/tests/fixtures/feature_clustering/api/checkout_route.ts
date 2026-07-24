import { createCheckout } from "../shared/checkout";

export function postCheckout(cartId: string) {
  return createCheckout(cartId);
}
