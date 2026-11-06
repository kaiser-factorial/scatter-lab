import { EfaError } from "../types";
import { COMPANION_PROTOCOL, NATIVE_KERNEL_SHA, type CompanionConnection, type CompanionSession } from "./types";

export function validateConnection(connection: CompanionConnection): CompanionConnection {
  let url: URL;
  try { url = new URL(connection.url); } catch { throw new EfaError("companion", "Enter the local companion URL and pairing token."); }
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.username || url.password || url.pathname !== "/" || url.search || url.hash || !/^[a-f0-9]{64}$/.test(connection.token))
    throw new EfaError("companion", "The companion must use http://127.0.0.1:PORT and its 64-character pairing token.");
  return { url: url.origin, token: connection.token };
}
export async function companionRequest(connection: CompanionConnection, path: string, method = "GET", body?: ArrayBuffer, timeoutMs = 30000): Promise<Response> {
  const verified = validateConnection(connection);
  try {
    const response = await fetch(verified.url + path, { method, body, redirect: "error", credentials: "omit", cache: "no-store",
      headers: { Authorization: `Bearer ${verified.token}`, ...(body ? { "Content-Type": "application/octet-stream" } : {}) }, signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) {
      const detail: Record<number, string> = {
        401: "The pairing token was rejected. Reconnect using the token from the running companion.",
        403: "The companion rejected this workbench origin. Restart it with the exact --origin shown in setup.",
        409: "The companion is busy or this session was stopped. Wait for process cleanup and rerun explicitly.",
        413: "The request exceeds the companion transport limits.",
        422: "The companion rejected a source or block, or its native process failed. This run was stopped.",
        503: "The Scala JVM could not start with native BLAS. Check Java and the companion's native BLAS installation.",
      };
      throw new EfaError("companion-unavailable", detail[response.status] ?? "The companion request failed. Check the local process and rerun explicitly.");
    }
    return response;
  } catch (error) { if (error instanceof EfaError) throw error; throw new EfaError("companion-unavailable", "Local Scala companion request failed. Check pairing, allowed origin, browser local-network permission and the companion process. No backend substitution was made."); }
}
export async function connectCompanion(connection: CompanionConnection) {
  const verified = validateConnection(connection);
  const identity = await (await companionRequest(verified, "/v1/health")).json();
  if (identity.protocol !== COMPANION_PROTOCOL || identity.kernelSha256 !== NATIVE_KERNEL_SHA)
    throw new EfaError("companion-version", "The Scala companion version does not match this workbench. Restart it using this checkout.");
  return verified;
}
export async function createCompanionSession(connection: CompanionConnection, id = crypto.randomUUID()): Promise<CompanionSession> {
  const value = await (await companionRequest(connection, `/v1/jobs/${id}`, "POST")).json();
  if (value.id !== id) throw new EfaError("companion-protocol", "Invalid companion session.");
  return { ...connection, id: value.id };
}
export async function closeCompanionSession(session: CompanionSession) {
  await companionRequest(session, `/v1/jobs/${session.id}`, "DELETE", undefined, 5000);
}
