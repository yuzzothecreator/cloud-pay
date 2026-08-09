export type PaymentStatus =
  | "requires_capture"
  | "succeeded"
  | "declined"
  | "partially_refunded"
  | "refunded"
  | "canceled";

export type PaymentEventType =
  | "payment.created"
  | "payment.authorized"
  | "payment.succeeded"
  | "payment.captured"
  | "payment.declined"
  | "payment.canceled"
  | "refund.created"
  | "payment.refunded"
  | "dispute.created"
  | "dispute.updated"
  | "customer.created"
  | "customer.updated";

export type DisputeStatus = "needs_response" | "under_review" | "won" | "lost" | "withdrawn";

export type DisputeReason =
  | "fraudulent"
  | "product_not_received"
  | "product_unacceptable"
  | "duplicate"
  | "subscription_canceled"
  | "unrecognized"
  | "general";

export interface Payment {
  id: string;
  amount: number;
  currency: string;
  description: string;
  customerId: string | null;
  customerName: string;
  customerEmail: string;
  cardLast4: string;
  cardBrand: string;
  status: PaymentStatus;
  failureReason: string | null;
  amountRefunded: number;
  amountRefundable: number;
  amountCapturable: number;
  captureMethod: "automatic" | "manual";
  metadata: Record<string, string>;
  statementDescriptor: string;
  createdAt: string;
  updatedAt: string;
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
  requiresCaptureCount: number;
  partiallyRefundedCount: number;
  refundedCount: number;
  declinedCount: number;
  canceledCount: number;
  grossVolume: number;
  refundedVolume: number;
  netVolume: number;
  currency: string;
}

export interface Customer {
  id: string;
  name: string;
  email: string;
  phone: string;
  metadata: Record<string, string>;
  paymentCount: number;
  lifetimeValue: number;
  createdAt: string;
  updatedAt: string;
}

export interface CustomerPage {
  customers: Customer[];
  total: number;
  limit: number;
  offset: number;
}

export interface Dispute {
  id: string;
  paymentId: string;
  amount: number;
  currency: string;
  reason: DisputeReason;
  status: DisputeStatus;
  evidence: string;
  createdAt: string;
  updatedAt: string;
}

export interface DisputePage {
  disputes: Dispute[];
  total: number;
  limit: number;
  offset: number;
}

export interface WebhookEndpoint {
  id: string;
  url: string;
  secret: string;
  description: string;
  enabled: boolean;
  events: string[];
  createdAt: string;
}

export interface WebhookDelivery {
  id: string;
  endpointId: string;
  eventId: string;
  eventType: string;
  payload: unknown;
  status: "pending" | "delivered" | "failed";
  attempts: number;
  lastError: string | null;
  responseStatus: number | null;
  createdAt: string;
  deliveredAt: string | null;
}

export interface ApiKey {
  id: string;
  name: string;
  prefix: string;
  secret?: string;
  lastUsedAt: string | null;
  createdAt: string;
  revokedAt: string | null;
}

export interface AnalyticsSnapshot {
  days: number;
  currency: string;
  series: Array<{
    date: string;
    volume: number;
    refunded: number;
    net: number;
    count: number;
    declined: number;
  }>;
  totals: {
    volume: number;
    refunded: number;
    net: number;
    count: number;
    declined: number;
    customers: number;
    openDisputes: number;
    webhookFailures: number;
  };
  topCustomers: Array<{
    id: string;
    name: string;
    email: string;
    lifetimeValue: number;
    paymentCount: number;
  }>;
  statusBreakdown: Array<{ status: string; count: number }>;
}

export interface CreatePaymentPayload {
  amount: number;
  currency: string;
  description: string;
  customerName: string;
  customerEmail: string;
  customerPhone?: string;
  cardNumber: string;
  captureMethod?: "automatic" | "manual";
  metadata?: Record<string, string>;
  statementDescriptor?: string;
}

export interface ListPaymentsParams {
  status?: string;
  q?: string;
  customerId?: string;
  limit?: number;
  offset?: number;
}

export interface RefundPayload {
  amount?: number;
  reason?: string;
}

const BASE = "/api";

async function handle<T>(res: Response): Promise<T> {
  if (res.status === 204) return undefined as T;
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message =
      (body && (body.message as string)) || `Request failed with status ${res.status}`;
    throw new Error(message);
  }
  return body as T;
}

function qs(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") search.set(key, String(value));
  }
  const query = search.toString();
  return query ? `?${query}` : "";
}

export async function fetchPayments(params: ListPaymentsParams = {}): Promise<PaymentPage> {
  return handle<PaymentPage>(
    await fetch(
      `${BASE}/payments${qs({
        status: params.status,
        q: params.q,
        customerId: params.customerId,
        limit: params.limit,
        offset: params.offset,
      })}`,
    ),
  );
}

export async function fetchPayment(id: string): Promise<PaymentDetail> {
  return handle<PaymentDetail>(await fetch(`${BASE}/payments/${id}`));
}

export async function fetchStats(): Promise<PaymentStats> {
  return handle<PaymentStats>(await fetch(`${BASE}/stats`));
}

export async function fetchAnalytics(days = 14): Promise<AnalyticsSnapshot> {
  return handle<AnalyticsSnapshot>(await fetch(`${BASE}/analytics${qs({ days })}`));
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

export async function capturePayment(id: string, amount?: number): Promise<Payment> {
  const res = await fetch(`${BASE}/payments/${id}/capture`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(amount !== undefined ? { amount } : {}),
  });
  return handle<Payment>(res);
}

export async function cancelPayment(id: string): Promise<Payment> {
  const res = await fetch(`${BASE}/payments/${id}/cancel`, { method: "POST" });
  return handle<Payment>(res);
}

export async function createDispute(
  paymentId: string,
  payload: { amount?: number; reason?: DisputeReason; evidence?: string },
): Promise<Dispute> {
  const res = await fetch(`${BASE}/payments/${paymentId}/disputes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return handle<Dispute>(res);
}

export async function fetchCustomers(params: {
  q?: string;
  limit?: number;
  offset?: number;
} = {}): Promise<CustomerPage> {
  return handle<CustomerPage>(
    await fetch(`${BASE}/customers${qs({ q: params.q, limit: params.limit, offset: params.offset })}`),
  );
}

export async function upsertCustomer(payload: {
  name: string;
  email: string;
  phone?: string;
  metadata?: Record<string, string>;
}): Promise<Customer> {
  const res = await fetch(`${BASE}/customers`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return handle<Customer>(res);
}

export async function fetchDisputes(params: {
  status?: string;
  limit?: number;
  offset?: number;
} = {}): Promise<DisputePage> {
  return handle<DisputePage>(
    await fetch(
      `${BASE}/disputes${qs({ status: params.status, limit: params.limit, offset: params.offset })}`,
    ),
  );
}

export async function updateDispute(
  id: string,
  payload: { status?: DisputeStatus; evidence?: string },
): Promise<Dispute> {
  const res = await fetch(`${BASE}/disputes/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return handle<Dispute>(res);
}

export async function fetchWebhookEndpoints(): Promise<WebhookEndpoint[]> {
  const res = await handle<{ endpoints: WebhookEndpoint[] }>(
    await fetch(`${BASE}/webhooks/endpoints`),
  );
  return res.endpoints;
}

export async function createWebhookEndpoint(payload: {
  url: string;
  description?: string;
  events?: string[];
}): Promise<WebhookEndpoint> {
  const res = await fetch(`${BASE}/webhooks/endpoints`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return handle<WebhookEndpoint>(res);
}

export async function updateWebhookEndpoint(
  id: string,
  payload: { url?: string; description?: string; enabled?: boolean; events?: string[] },
): Promise<WebhookEndpoint> {
  const res = await fetch(`${BASE}/webhooks/endpoints/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return handle<WebhookEndpoint>(res);
}

export async function deleteWebhookEndpoint(id: string): Promise<void> {
  await handle(await fetch(`${BASE}/webhooks/endpoints/${id}`, { method: "DELETE" }));
}

export async function fetchWebhookDeliveries(endpointId?: string): Promise<WebhookDelivery[]> {
  const res = await handle<{ deliveries: WebhookDelivery[] }>(
    await fetch(`${BASE}/webhooks/deliveries${qs({ endpointId })}`),
  );
  return res.deliveries;
}

export async function retryWebhookDelivery(id: string): Promise<WebhookDelivery> {
  const res = await fetch(`${BASE}/webhooks/deliveries/${id}/retry`, { method: "POST" });
  return handle<WebhookDelivery>(res);
}

export async function fetchApiKeys(): Promise<ApiKey[]> {
  const res = await handle<{ keys: ApiKey[] }>(await fetch(`${BASE}/api-keys`));
  return res.keys;
}

export async function createApiKey(name: string): Promise<ApiKey> {
  const res = await fetch(`${BASE}/api-keys`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  return handle<ApiKey>(res);
}

export async function revokeApiKey(id: string): Promise<ApiKey> {
  const res = await fetch(`${BASE}/api-keys/${id}/revoke`, { method: "POST" });
  return handle<ApiKey>(res);
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

export function formatStatus(status: string): string {
  return status.replace(/_/g, " ");
}

export function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}
