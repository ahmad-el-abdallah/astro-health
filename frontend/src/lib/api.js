// Every backend call goes through here (port of the old static/js/core/main.js api()).
// Same-origin in both setups: Flask serves the built app, and `npm run dev`'s Vite
// server proxies /api to Flask (see vite.config.js), so the session cookie just works.
export class ApiError extends Error {
  constructor(path, status, body) {
    super(`${path} -> ${status}`);
    this.status = status;
    this.body = body;
  }
}

export async function api(path, options = {}) {
  const res = await fetch(`/api${path}`, {
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    ...options,
  });
  const ct = res.headers.get("content-type") || "";
  const body = ct.includes("json") ? await res.json().catch(() => null) : await res.text();
  // 401 = not signed in (403 is "signed in, but not allowed"). Outside the separate /admin
  // login and the auth routes themselves, it means the crew/surgeon login expired.
  if (res.status === 401 && !path.startsWith("/admin") && !path.startsWith("/auth/") && typeof window !== "undefined") {
    window.dispatchEvent(new Event("ah:unauthorized"));
  }
  if (!res.ok) throw new ApiError(path, res.status, body);
  return body;
}

export const get = (path) => api(path);
export const post = (path, body) => api(path, { method: "POST", body: JSON.stringify(body ?? {}) });
export const put = (path, body) => api(path, { method: "PUT", body: JSON.stringify(body ?? {}) });
export const del = (path) => api(path, { method: "DELETE" });
