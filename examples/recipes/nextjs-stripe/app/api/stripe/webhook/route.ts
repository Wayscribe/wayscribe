import { after } from "next/server";
import Stripe from "stripe";
import { formatAmount, markOrderPaid } from "@/lib/orders";
import { recorder } from "@/lib/recorder";

// The SDK needs Node's crypto, so this handler does not run on the Edge runtime.
export const runtime = "nodejs";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY ?? "");

export async function POST(request: Request): Promise<Response> {
  // The signature is over the exact bytes, so read the body as text.
  const raw = await request.text();
  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(
      raw,
      request.headers.get("stripe-signature") ?? "",
      process.env.STRIPE_WEBHOOK_SECRET ?? ""
    );
  } catch {
    // Unverified: nothing in it can be trusted to name a record.
    return new Response("invalid signature", { status: 400 });
  }
  if (event.type !== "checkout.session.completed") return new Response(null, { status: 204 });

  const session = event.data.object;
  const orderId = session.client_reference_id;
  if (orderId === null) return new Response("no order", { status: 422 });

  // Stripe retries a webhook until it gets a 2xx. A journey id derived from the
  // order (experimental) puts every delivery on the order's one journey.
  const entity = { type: "order", id: orderId };
  const journey = recorder.continueJourney({
    journeyId: recorder.journeyIdFor(entity),
    entity,
    // Experimental. Public text: no ids, no names, no email addresses.
    label: `Checkout ${session.payment_status} · ${formatAmount(session.amount_total, session.currency)}`
  });

  // A serverless function can be frozen once it has answered. `after` runs
  // once the response is sent, success or not, so the events still leave.
  after(() => recorder.flush());

  // The Stripe-Signature header is on the built-in redaction list, so it is
  // stored as [REDACTED]; the signature and the body together would be a
  // request your endpoint accepts.
  journey.record({
    operation: "received",
    name: "receive-stripe-webhook",
    input: { headers: request.headers, event },
    metadata: { stripeEventId: event.id }
  });

  const customerId = typeof session.customer === "string" ? session.customer : session.customer?.id;
  // Aliases are masked when read; these are customer identifiers.
  journey.identify({
    stripeCheckoutSession: session.id,
    ...(customerId === undefined ? {} : { stripeCustomer: customerId })
  });

  try {
    await journey.persist("mark-order-paid", { orderId, checkoutSessionId: session.id }, () =>
      markOrderPaid(orderId, session.id)
    );
  } catch {
    // Recorded by persist. A 500 makes Stripe deliver it again.
    return new Response("could not record payment", { status: 500 });
  }

  journey.finish();
  return new Response(null, { status: 200 });
}
