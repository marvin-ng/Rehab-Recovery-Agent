// API layer + the auth boundary. The API key lives ONLY in localStorage,
// entered by the user — it is never hardcoded, never bundled, never committed.
// Every request sends it as x-api-key. A 401 clears the stored key so the app
// falls back to the entry screen (no silent retry).
import type { DashboardPayload, LogSessionRequest } from "./types";

const KEY_STORAGE = "rehab.apiKey";

const LOG_SESSION_URL = import.meta.env.VITE_LOG_SESSION_URL as string;
const DASHBOARD_URL = import.meta.env.VITE_DASHBOARD_URL as string;

export function getApiKey(): string | null {
  return localStorage.getItem(KEY_STORAGE);
}

export function setApiKey(key: string): void {
  localStorage.setItem(KEY_STORAGE, key);
}

export function clearApiKey(): void {
  localStorage.removeItem(KEY_STORAGE);
}

// Thrown on a 401 so callers can distinguish "bad key, re-prompt" from other
// failures. The App-level handler clears the key and re-shows the gate.
export class UnauthorizedError extends Error {
  constructor() {
    super("unauthorized");
    this.name = "UnauthorizedError";
  }
}

async function apiFetch<T>(url: string, init: RequestInit = {}): Promise<T> {
  const key = getApiKey();
  if (!key) throw new UnauthorizedError();

  const res = await fetch(url, {
    ...init,
    headers: {
      ...(init.headers || {}),
      "x-api-key": key,
    },
  });

  if (res.status === 401) {
    clearApiKey();
    throw new UnauthorizedError();
  }
  if (!res.ok) {
    let detail = "";
    try {
      const body = await res.json();
      detail = body?.error ? `: ${body.error}` : "";
    } catch {
      /* non-JSON error body */
    }
    throw new Error(`request failed (${res.status})${detail}`);
  }
  return res.json() as Promise<T>;
}

export function fetchDashboard(): Promise<DashboardPayload> {
  return apiFetch<DashboardPayload>(DASHBOARD_URL, { method: "GET" });
}

export function submitSession(payload: LogSessionRequest): Promise<{ ok: boolean }> {
  return apiFetch(LOG_SESSION_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}
