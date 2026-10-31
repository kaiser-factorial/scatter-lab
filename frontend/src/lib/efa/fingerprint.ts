import type { EfaPreparedData } from "./types";
/** Hash the encoded response snapshot, its missingness, transformations and membership. */
export async function fingerprintPrepared(
  data: EfaPreparedData,
): Promise<string> {
  const meta = new TextEncoder().encode(
    JSON.stringify({
      items: data.items,
      rows: data.rows,
      originalRowCount: data.originalRowCount,
    }),
  );
  const bytes = new Uint8Array(
    meta.byteLength + data.codes.byteLength + data.observed.byteLength,
  );
  bytes.set(meta);
  bytes.set(
    new Uint8Array(
      data.codes.buffer,
      data.codes.byteOffset,
      data.codes.byteLength,
    ),
    meta.byteLength,
  );
  bytes.set(data.observed, meta.byteLength + data.codes.byteLength);
  return Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
}
