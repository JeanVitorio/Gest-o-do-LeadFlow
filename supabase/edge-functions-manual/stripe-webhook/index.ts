// @ts-nocheck
// Fonte versionada do webhook já usado pelo LeadFlow.
// Esta é a única função deste pacote que deve permanecer com verify_jwt = false.
import { createClient } from "npm:@supabase/supabase-js@2";
import Stripe from "npm:stripe@18.5.0";

let stripeClient = null;
const stripeCryptoProvider = Stripe.createSubtleCryptoProvider();
const handledEvents = new Set([
  "checkout.session.completed",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "invoice.paid",
  "invoice.payment_failed",
]);

function getStripe() {
  if (stripeClient) return stripeClient;
  const secretKey = Deno.env.get("STRIPE_SECRET_KEY");
  if (!secretKey) throw new Error("STRIPE_SECRET_KEY não configurada");
  stripeClient = new Stripe(secretKey);
  return stripeClient;
}

Deno.serve(async (request) => {
  if (request.method !== "POST") {
    return new Response("Método não permitido", { status: 405 });
  }

  const signature = request.headers.get("stripe-signature") ?? "";
  const webhookSecret = Deno.env.get("STRIPE_WEBHOOK_SECRET") ?? "";
  const body = await request.text();
  if (!signature || !webhookSecret) {
    return new Response("Webhook não configurado", { status: 500 });
  }

  let event;
  try {
    event = await getStripe().webhooks.constructEventAsync(
      body,
      signature,
      webhookSecret,
      undefined,
      stripeCryptoProvider,
    );
  } catch (error) {
    console.error("Assinatura Stripe inválida:", error);
    return new Response("Assinatura inválida", { status: 400 });
  }

  if (!handledEvents.has(event.type)) {
    return Response.json({ received: true, ignored: true });
  }

  try {
    const subscription = await subscriptionFromEvent(event);
    if (!subscription) return Response.json({ received: true, ignored: true });

    const tenantId = subscription.metadata.tenant_id;
    if (!tenantId) throw new Error("Assinatura Stripe sem tenant_id");

    const item = subscription.items.data[0];
    if (!item) throw new Error("Assinatura Stripe sem preço");
    const productId =
      typeof item.price.product === "string" ? item.price.product : item.price.product.id;
    const customerId =
      typeof subscription.customer === "string"
        ? subscription.customer
        : subscription.customer.id;
    const period = subscriptionPeriod(subscription);
    const payloadHash = await sha256(body);

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !serviceRole) {
      throw new Error("Configuração Supabase indisponível");
    }

    const admin = createClient(supabaseUrl, serviceRole);
    const { error } = await admin.rpc("prospecta_sync_stripe_subscription", {
      p_event_id: event.id,
      p_event_type: event.type,
      p_event_created_at: new Date(event.created * 1000).toISOString(),
      p_payload_hash: payloadHash,
      p_tenant_id: tenantId,
      p_customer_id: customerId,
      p_subscription_id: subscription.id,
      p_price_id: item.price.id,
      p_product_id: productId,
      p_status: event.type === "invoice.payment_failed" ? "past_due" : subscription.status,
      p_period_start: new Date(period.start * 1000).toISOString(),
      p_period_end: new Date(period.end * 1000).toISOString(),
      p_cancel_at_period_end: subscription.cancel_at_period_end,
    });
    if (error) throw error;

    return Response.json({ received: true });
  } catch (error) {
    console.error(`Falha ao processar ${event.type}:`, error);
    return new Response("Falha temporária no webhook", { status: 500 });
  }
});

async function subscriptionFromEvent(event) {
  const stripe = getStripe();
  if (event.type === "customer.subscription.updated") {
    return await stripe.subscriptions.retrieve(event.data.object.id);
  }
  if (event.type === "customer.subscription.deleted") {
    return event.data.object;
  }
  if (event.type === "checkout.session.completed") {
    const subscriptionId = objectId(event.data.object.subscription);
    return subscriptionId ? await stripe.subscriptions.retrieve(subscriptionId) : null;
  }
  if (event.type === "invoice.paid" || event.type === "invoice.payment_failed") {
    const invoice = event.data.object;
    const subscriptionId = objectId(
      invoice.subscription ?? invoice.parent?.subscription_details?.subscription ?? null,
    );
    return subscriptionId ? await stripe.subscriptions.retrieve(subscriptionId) : null;
  }
  return null;
}

function subscriptionPeriod(subscription) {
  const item = subscription.items.data[0];
  const start = subscription.current_period_start ?? item.current_period_start;
  const end = subscription.current_period_end ?? item.current_period_end;
  if (!start || !end) throw new Error("Período da assinatura Stripe ausente");
  return { start, end };
}

function objectId(value) {
  if (typeof value === "string") return value;
  return value?.id ?? null;
}

async function sha256(value) {
  const data = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(hash)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
