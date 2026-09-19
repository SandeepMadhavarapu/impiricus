export interface ShareSession { token: string; expiresAt: string; receiveUrl: string }
export interface ReceivedGuide { medicationSlug: string; label: string; path: string }
async function post<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), cache: "no-store", signal });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? "Unable to connect. Try again.");
  return data;
}
export const requestSession = (medicationSlug: string, signal?: AbortSignal) => post<ShareSession>("/api/share-sessions", { medicationSlug }, signal);
export const resolveToken = (token: string, signal?: AbortSignal) => post<ReceivedGuide>("/api/share-sessions/resolve", { token }, signal);
