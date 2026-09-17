// A stand-in for the parts of the `stripe` package's types the recipe uses.
// The real `Stripe.Event` is a union discriminated by `type`, as this one is.
// With `stripe` installed, delete this file.
declare module "stripe" {
  namespace Stripe {
    interface Customer {
      id: string;
    }

    namespace Checkout {
      interface Session {
        id: string;
        client_reference_id: string | null;
        customer: string | Customer | null;
        amount_total: number | null;
        currency: string | null;
        payment_status: "no_payment_required" | "paid" | "unpaid";
      }
    }

    interface CheckoutSessionCompletedEvent {
      id: string;
      type: "checkout.session.completed";
      data: { object: Checkout.Session };
    }

    interface CheckoutSessionExpiredEvent {
      id: string;
      type: "checkout.session.expired";
      data: { object: Checkout.Session };
    }

    type Event = CheckoutSessionCompletedEvent | CheckoutSessionExpiredEvent;
  }

  class Stripe {
    constructor(apiKey: string);
    webhooks: {
      constructEvent(payload: string | Buffer, header: string, secret: string): Stripe.Event;
    };
  }

  export default Stripe;
}
