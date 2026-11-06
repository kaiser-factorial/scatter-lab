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
      ...(data.imputation ? { imputation: data.imputation } : {}),
      ...(data.numericReverseOffsets ? { numericReverseOffsets: data.numericReverseOffsets } : {}),
    }),
  );
  const bytes = new Uint8Array(
    meta.byteLength + data.codes.byteLength + data.observed.byteLength + (data.numeric?.byteLength ?? 0) + (data.fittingObserved?.byteLength ?? 0),
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
  if (data.numeric) bytes.set(new Uint8Array(data.numeric.buffer, data.numeric.byteOffset, data.numeric.byteLength),
    meta.byteLength + data.codes.byteLength + data.observed.byteLength);
  if (data.fittingObserved) bytes.set(data.fittingObserved,
    meta.byteLength + data.codes.byteLength + data.observed.byteLength + (data.numeric?.byteLength ?? 0));
  return Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
}
