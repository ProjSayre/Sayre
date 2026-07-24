import { createCheckout } from "../shared/checkout";

export function CheckoutPanel({ cartId }: { cartId: string }) {
  return <button onClick={() => createCheckout(cartId)}>Checkout</button>;
}
