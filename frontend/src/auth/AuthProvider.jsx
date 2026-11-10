// Who is signed in, and who they're looking at. Port of static/js/core/auth.js.
//
// - Login is a Flask session cookie (backend/auth/auth.py); GET /auth/me restores it on
//   refresh. NFC is the primary method: while nobody is signed in, any "scan" broadcast
//   (a real CYD/Pico tap or the Simulator) is tried as a login.
// - Crew members only ever see their own data (the backend enforces it); the Flight
//   Surgeon can pick any crew member -- useAstronautPicker() mirrors that rule.
// - "Done" on the CYD broadcasts logout_requested, which signs this browser out too if
//   it's that astronaut. Idle timeouts and re-taps deliberately do not (docs/CLAUDE.md).
// - The role drives the theme: <html data-role="crew|doctor"> = blue vs teal accent.
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { get, post } from "../lib/api.js";
import { queryClient, useCrew } from "../lib/queries.js";
import { useSocketEvent } from "../lib/socket.js";

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null); // { astronaut_id, name, role }
  const [checking, setChecking] = useState(true);
  const [viewedId, setViewedId] = useState(null); // surgeon's chosen crew member
  const navigate = useNavigate();

  const isSurgeon = user?.role === "Flight surgeon";

  useEffect(() => {
    get("/auth/me")
      .then((me) => { if (me.astronaut_id) setUser(me); })
      .catch(() => {})
      .finally(() => setChecking(false));
  }, []);

  useEffect(() => {
    document.documentElement.dataset.role = isSurgeon ? "doctor" : "crew";
  }, [isSurgeon]);

  const signIn = useCallback((me) => {
    queryClient.clear();
    setViewedId(null);
    setUser(me);
    // Each role lands on its own home: crew → Mission overview, surgeon → Crew overview.
    navigate(me.role === "Flight surgeon" ? "/doctor" : "/", { replace: true });
  }, [navigate]);

  const signOut = useCallback(async () => {
    try { await post("/auth/logout"); } catch { /* still clear the local state */ }
    queryClient.clear();
    setViewedId(null);
    setUser(null);
    // Start the next person at their own home page, not wherever the last one was.
    navigate("/", { replace: true });
  }, [navigate]);

  useSocketEvent("scan", async (d) => {
    if (user || !d?.uid) return;
    try {
      signIn(await post("/auth/nfc_login", { uid: d.uid }));
    } catch {
      // Not every tap is a login (exercise/meal/emergency tags broadcast "scan" too).
    }
  });

  useSocketEvent("logout_requested", (d) => {
    if (user && d?.astronaut_id === user.astronaut_id) signOut();
  });

  const value = useMemo(
    () => ({ user, checking, isSurgeon, signIn, signOut, viewedId, setViewedId }),
    [user, checking, isSurgeon, signIn, signOut, viewedId],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  return useContext(AuthContext);
}

// "Which astronaut is this page about?" A crew member is locked to themselves; the
// Flight Surgeon picks from the crew list (and the choice follows them across pages).
export function useAstronautPicker() {
  const { user, isSurgeon, viewedId, setViewedId } = useAuth();
  const crew = useCrew(isSurgeon);
  if (!isSurgeon) {
    const self = user ? [{ id: user.astronaut_id, name: user.name }] : [];
    return { id: user?.astronaut_id ?? null, setId: () => {}, options: self, locked: true };
  }
  const options = crew.data || [];
  const id = viewedId ?? options[0]?.id ?? null;
  return { id, setId: setViewedId, options, locked: false };
}
