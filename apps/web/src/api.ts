export type PaymentStatus = "succeeded" | "declined" | "refunded";

export interface Payment {
  id: string;
  amount: number;
  currency: string;
  description: string;
  customerName: string;
  customerEmail: string;
  cardLast4: string;
  cardBrand: string;
  status: PaymentStatus;
  failureReason: string | null;
  createdAt: string;
}

export interface PaymentStats {
  count: number;
  succeededCount: number;
  refundedCount: number;
  declinedCount: number;
  grossVolume: number;
  netVolume: number;
  currency: string;
}

export interface CreatePaymentPayload {
  amount: number;
  currency: string;
  description: string;
  customerName: string;
  customerEmail: string;
  cardNumber: string;
}

const BASE = "/api";

async function handle<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message =
      (body && (body.message as string)) || `Request failed with status ${res.status}`;
    throw new Error(message);
  }
  return body as T;
}

export async function fetchPayments(): Promise<Payment[]> {
  const data = await handle<{ payments: Payment[] }>(await fetch(`${BASE}/payments`));
  return data.payments;
}

export async function fetchStats(): Promise<PaymentStats> {
  return handle<PaymentStats>(await fetch(`${BASE}/stats`));
}

export async function createPayment(payload: CreatePaymentPayload): Promise<Payment> {
  const res = await fetch(`${BASE}/payments`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return handle<Payment>(res);
}

export async function refundPayment(id: string): Promise<Payment> {
  const res = await fetch(`${BASE}/payments/${id}/refund`, { method: "POST" });
  return handle<Payment>(res);
}

export function formatMoney(amountCents: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currency.toUpperCase(),
    }).format(amountCents / 100);
  } catch {
    return `${(amountCents / 100).toFixed(2)} ${currency.toUpperCase()}`;
  }
}
