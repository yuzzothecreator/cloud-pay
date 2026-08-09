import { customAlphabet } from "nanoid";

const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz";

export const newId = customAlphabet(alphabet, 20);

export function prefixedId(prefix: string): string {
  return `${prefix}_${newId()}`;
}
