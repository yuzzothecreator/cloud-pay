export type PaymentStatus = "succeeded" | "declined" | "partially_refunded" | "refunded";

export type PaymentEventType =
  | "payment.created"
  | "payment.succeeded"
  | "payment.declined"
  | "refund.created"
  | "payment.refunded";

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
  amountRefunded: number;
  amountRefundable: number;
  createdAt: string;
}

export interface Refund {
  id: string;
  paymentId: string;
  amount: number;
  reason: string;
  createdAt: string;
}

export interface PaymentEvent {
  id: string;
  type: PaymentEventType;
  message: string;
  createdAt: string;
}

export interface PaymentDetail extends Payment {
  refunds: Refund[];
  events: PaymentEvent[];
}

export interface PaymentPage {
  payments: Payment[];
  total: number;
  limit: number;
  offset: number;
}

export interface PaymentStats {
  count: number;
  succeededCount: number;
  partiallyRefundedCount: number;
  refundedCount: number;
  declinedCount: number;
  grossVolume: number;
  refundedVolume: number;
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

export interface ListPaymentsParams {
  status?: string;
  q?: string;
  limit?: number;
  offset?: number;
}

export interface RefundPayload {
  amount?: number;
  reason?: string;
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

export async function fetchPayments(params: ListPaymentsParams = {}): Promise<PaymentPage> {
  const search = new URLSearchParams();
  if (params.status) search.set("status", params.status);
  if (params.q) search.set("q", params.q);
  if (params.limit !== undefined) search.set("limit", String(params.limit));
  if (params.offset !== undefined) search.set("offset", String(params.offset));
  const query = search.toString();
  return handle<PaymentPage>(await fetch(`${BASE}/payments${query ? `?${query}` : ""}`));
}

export async function fetchPayment(id: string): Promise<PaymentDetail> {
  return handle<PaymentDetail>(await fetch(`${BASE}/payments/${id}`));
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

export async function refundPayment(id: string, payload: RefundPayload = {}): Promise<Payment> {
  const res = await fetch(`${BASE}/payments/${id}/refund`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
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

export function formatStatus(status: PaymentStatus): string {
  return status.replace(/_/g, " ");
}

export function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}
