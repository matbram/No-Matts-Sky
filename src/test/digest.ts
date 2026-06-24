// FNV-1a 32-bit over raw bytes — a small, stable content digest for golden tests.
// (Not a test file itself; vitest only collects `*.test.ts`.)
export function fnv1a(view: ArrayBufferView): string {
  const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i]!;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}
