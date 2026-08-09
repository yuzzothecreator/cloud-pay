import type { AppServices } from "./services/index.js";

/**
 * Populates an empty ledger with a realistic demo dataset so the dashboard
 * is immediately useful on first boot.
 */
export function seedIfEmpty(services: AppServices): void {
  const { count } = services.db.prepare(`SELECT COUNT(*) AS count FROM payments`).get() as {
    count: number;
  };
  if (count > 0) return;

  const people = [
    {
      name: "Ada Lovelace",
      email: "ada@example.com",
      phone: "+1 415 555 0101",
      amounts: [2500, 4900, 1200],
      descriptions: ["Pro plan", "Add-on seats", "Usage overage"],
    },
    {
      name: "Grace Hopper",
      email: "grace@example.com",
      phone: "+1 212 555 0142",
      amounts: [9900, 1500],
      descriptions: ["Team plan", "Support package"],
    },
    {
      name: "Alan Turing",
      email: "alan@example.com",
      phone: "+44 20 7946 0958",
      amounts: [4200],
      descriptions: ["Research credit"],
    },
    {
      name: "Katherine Johnson",
      email: "katherine@example.com",
      phone: "+1 202 555 0177",
      amounts: [15000],
      descriptions: ["Enterprise annual"],
    },
  ];

  for (const person of people) {
    person.amounts.forEach((amount, index) => {
      services.payments.create({
        amount,
        currency: "usd",
        description: person.descriptions[index] ?? "Charge",
        customerName: person.name,
        customerEmail: person.email,
        customerPhone: person.phone,
        cardNumber: "4242424242424242",
        captureMethod: "automatic",
        metadata: { plan: index === 0 ? "pro" : "addon", seeded: "true" },
        statementDescriptor: "CLOUDPAY DEMO",
      });
    });
  }

  // Authorised but uncaptured payment.
  const auth = services.payments.create({
    amount: 3200,
    currency: "usd",
    description: "Hotel hold",
    customerName: "Ada Lovelace",
    customerEmail: "ada@example.com",
    customerPhone: "+1 415 555 0101",
    cardNumber: "4242424242424242",
    captureMethod: "manual",
    metadata: { hold: "true" },
    statementDescriptor: "CLOUDPAY HOLD",
  });

  // Declined payment.
  services.payments.create({
    amount: 800,
    currency: "usd",
    description: "Failed renewal",
    customerName: "Alan Turing",
    customerEmail: "alan@example.com",
    customerPhone: "+44 20 7946 0958",
    cardNumber: "4000000000000002",
    captureMethod: "automatic",
    metadata: {},
    statementDescriptor: "CLOUDPAY DEMO",
  });

  // Partial refund on Ada's first payment.
  const adaPayments = services.payments.list({
    q: "Pro plan",
    limit: 1,
    offset: 0,
  });
  if (adaPayments.payments[0]) {
    services.payments.refund(adaPayments.payments[0].id, {
      amount: 500,
      reason: "proration",
    });
  }

  // Open a dispute on Grace's team plan.
  const grace = services.payments.list({ q: "Team plan", limit: 1, offset: 0 });
  if (grace.payments[0]) {
    services.disputes.create(grace.payments[0].id, {
      reason: "unrecognized",
      evidence: "Customer does not recognise the charge on their statement.",
    });
  }

  // Sample webhook endpoint (deliveries will fail until a real URL is listening).
  services.webhooks.create({
    url: "https://example.com/webhooks/cloud-pay",
    description: "Demo endpoint",
    events: ["*"],
  });

  services.apiKeys.create({ name: "Dashboard bootstrap" });

  // Keep the auth payment uncaptured so the UI can demonstrate capture/cancel.
  void auth;
}
