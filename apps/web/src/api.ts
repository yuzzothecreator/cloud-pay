export type PaymentStatus = "succeeded" | "declined" | "partially_refunded" | "refunded";

export type PaymentEventType =
  | "payment.created"
  | "payment.succeeded"
  | "payment.declined"
  | "refund.created"
  | "payment.refunded"
  | "dispute.opened"
  | "dispute.won"
  | "dispute.lost";

export interface Payment {
  id: string;
  merchantId: string;
  customerId: string | null;
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

export interface Customer {
  id: string;
  name: string;
  email: string;
  phone: string;
  metadata: Record<string, string>;
  paymentCount: number;
  totalSpent: number;
  createdAt: string;
}

export interface Price {
  id: string;
  productId: string;
  unitAmount: number;
  currency: string;
  interval: string | null;
  intervalCount: number | null;
  active: boolean;
  createdAt: string;
}

export interface Product {
  id: string;
  name: string;
  description: string;
  active: boolean;
  metadata: Record<string, string>;
  prices: Price[];
  createdAt: string;
}

export interface Subscription {
  id: string;
  customerId: string;
  customerName: string;
  customerEmail: string;
  priceId: string;
  productName: string;
  unitAmount: number;
  currency: string;
  interval: string | null;
  status: string;
  currentPeriodStart: string;
  currentPeriodEnd: string;
  cancelAtPeriodEnd: boolean;
  latestPaymentId: string | null;
  invoices: {
    id: string;
    amount: number;
    currency: string;
    status: string;
    periodStart: string;
    periodEnd: string;
    createdAt: string;
  }[];
  createdAt: string;
}

export interface WebhookEndpoint {
  id: string;
  url: string;
  secret: string;
  enabledEvents: string[];
  active: boolean;
  createdAt: string;
}

export interface WebhookDelivery {
  id: string;
  endpointId: string;
  eventType: string;
  payload: Record<string, unknown>;
  status: string;
  attempts: number;
  createdAt: string;
  deliveredAt: string | null;
}

export interface Dispute {
  id: string;
  paymentId: string;
  paymentAmount: number;
  customerName: string;
  amount: number;
  reason: string;
  status: string;
  evidenceDueBy: string;
  createdAt: string;
  resolvedAt: string | null;
}

export interface Payout {
  id: string;
  amount: number;
  currency: string;
  status: string;
  arrivalDate: string | null;
  createdAt: string;
}

export interface Balance {
  available: number;
  pending: number;
  currency: string;
  lifetimeVolume: number;
  lifetimeFees: number;
}

export interface AnalyticsReport {
  dailyVolume: { date: string; gross: number; net: number; refunds: number; count: number }[];
  statusBreakdown: { status: string; count: number; volume: number }[];
  brandBreakdown: { brand: string; count: number; volume: number }[];
  topCustomers: { customerId: string | null; name: string; email: string; volume: number; count: number }[];
  subscriptionMetrics: {
    active: number;
    trialing: number;
    pastDue: number;
    canceled: number;
    mrr: number;
  };
  disputeMetrics: { open: number; won: number; lost: number; totalAmount: number };
}

export interface ApiKey {
  id: string;
  prefix: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
}

const BASE = "/api";
const API_KEY_STORAGE = "cloud-pay-api-key";

export function getStoredApiKey(): string | null {
  return localStorage.getItem(API_KEY_STORAGE);
}

export function setStoredApiKey(key: string): void {
  localStorage.setItem(API_KEY_STORAGE, key);
}

async function handle<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message =
      (body && (body.message as string)) || `Request failed with status ${res.status}`;
    throw new Error(message);
  }
  return body as T;
}

function headers(): HeadersInit {
  const key = getStoredApiKey();
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (key) h.Authorization = `Bearer ${key}`;
  return h;
}

async function apiGet<T>(path: string): Promise<T> {
  return handle<T>(await fetch(`${BASE}${path}`, { headers: headers() }));
}

async function apiSend<T>(path: string, method: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: headers(),
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return handle<T>(res);
}

export async function fetchSetup(): Promise<{ apiKey: string }> {
  return apiGet("/setup");
}

export async function fetchPayments(params: Record<string, string | number | undefined> = {}): Promise<PaymentPage> {
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== "") search.set(k, String(v));
  }
  const q = search.toString();
  return apiGet(`/payments${q ? `?${q}` : ""}`);
}

export async function fetchPayment(id: string): Promise<PaymentDetail> {
  return apiGet(`/payments/${id}`);
}

export async function fetchStats(): Promise<PaymentStats> {
  return apiGet("/stats");
}

export async function fetchAnalytics(days = 30): Promise<AnalyticsReport> {
  return apiGet(`/analytics?days=${days}`);
}

export async function fetchBalance(): Promise<Balance> {
  return apiGet("/balance");
}

export async function createPayment(payload: Record<string, unknown>): Promise<Payment> {
  return apiSend("/payments", "POST", payload);
}

export async function refundPayment(id: string, payload: Record<string, unknown> = {}): Promise<Payment> {
  return apiSend(`/payments/${id}/refund`, "POST", payload);
}

export async function fetchCustomers(params: Record<string, string | number | undefined> = {}) {
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== "") search.set(k, String(v));
  }
  const q = search.toString();
  return apiGet<{ customers: Customer[]; total: number }>(`/customers${q ? `?${q}` : ""}`);
}

export async function createCustomer(payload: Record<string, unknown>): Promise<Customer> {
  return apiSend("/customers", "POST", payload);
}

export async function fetchProducts() {
  return apiGet<{ products: Product[]; total: number }>("/products");
}

export async function createProduct(payload: Record<string, unknown>): Promise<Product> {
  return apiSend("/products", "POST", payload);
}

export async function addPrice(productId: string, payload: Record<string, unknown>): Promise<Price> {
  return apiSend(`/products/${productId}/prices`, "POST", payload);
}

export async function fetchSubscriptions() {
  return apiGet<{ subscriptions: Subscription[]; total: number }>("/subscriptions");
}

export async function createSubscription(payload: Record<string, unknown>): Promise<Subscription> {
  return apiSend("/subscriptions", "POST", payload);
}

export async function cancelSubscription(id: string): Promise<Subscription> {
  return apiSend(`/subscriptions/${id}/cancel`, "POST", { atPeriodEnd: true });
}

export async function fetchWebhooks() {
  return apiGet<{ endpoints: WebhookEndpoint[] }>("/webhooks");
}

export async function createWebhook(payload: Record<string, unknown>): Promise<WebhookEndpoint> {
  return apiSend("/webhooks", "POST", payload);
}

export async function deleteWebhook(id: string): Promise<void> {
  await apiSend(`/webhooks/${id}`, "DELETE");
}

export async function fetchWebhookDeliveries() {
  return apiGet<{ deliveries: WebhookDelivery[]; total: number }>("/webhook-deliveries");
}

export async function fetchDisputes() {
  return apiGet<{ disputes: Dispute[]; total: number }>("/disputes");
}

export async function createDispute(payload: Record<string, unknown>): Promise<Dispute> {
  return apiSend("/disputes", "POST", payload);
}

export async function resolveDispute(id: string, outcome: "won" | "lost"): Promise<Dispute> {
  return apiSend(`/disputes/${id}/resolve`, "POST", { outcome });
}

export async function submitDisputeEvidence(id: string): Promise<Dispute> {
  return apiSend(`/disputes/${id}/evidence`, "POST", {});
}

export async function fetchPayouts() {
  return apiGet<{ payouts: Payout[]; total: number }>("/payouts");
}

export async function createPayout(amount: number): Promise<Payout> {
  return apiSend("/payouts", "POST", { amount, currency: "usd" });
}

export async function fetchApiKeys() {
  return apiGet<{ keys: ApiKey[] }>("/api-keys");
}

export async function createApiKey(name: string) {
  return apiSend<{ id: string; key: string; prefix: string; name: string }>("/api-keys", "POST", { name });
}

export async function revokeApiKey(id: string): Promise<void> {
  await apiSend(`/api-keys/${id}`, "DELETE");
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
