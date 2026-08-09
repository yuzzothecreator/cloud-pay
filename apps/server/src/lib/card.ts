/** Luhn checksum validation for card numbers. */
export function isLuhnValid(cardNumber: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = cardNumber.length - 1; i >= 0; i--) {
    let digit = Number(cardNumber[i]);
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

/** Rough card-brand detection from the leading digits. */
export function detectBrand(cardNumber: string): string {
  if (/^4/.test(cardNumber)) return "visa";
  if (/^5[1-5]/.test(cardNumber) || /^2[2-7]/.test(cardNumber)) return "mastercard";
  if (/^3[47]/.test(cardNumber)) return "amex";
  if (/^6(?:011|5)/.test(cardNumber)) return "discover";
  return "unknown";
}

/**
 * Simulated processor decisions keyed on well-known test card numbers so the
 * demo behaves deterministically without contacting a real payment network.
 */
export const DECLINE_CARDS: Record<string, string> = {
  "4000000000000002": "card_declined",
  "4000000000009995": "insufficient_funds",
  "4000000000000069": "expired_card",
  "4000000000000119": "processing_error",
  "4000000000000259": "lost_card",
};
