import { customAlphabet } from "nanoid";

const alpha = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 20);

export function newId(prefix: string): string {
  return `${prefix}_${alpha()}`;
}
