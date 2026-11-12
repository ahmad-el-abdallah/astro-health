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
// - Scans must never be silently lost (docs/CLAUDE.md "Lost NFC scans"): a scan while this
//   page *thinks* someone is signed in re-checks with the server first (the 1 h web login
//   may have expired underneath it); any 401 from the API means the login is gone; and
//   after the live connection drops and comes back, a scan made during the gap is
//   replayed (GET /recent-scan).
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { get, post } from "../lib/api.js";
import { queryClient, useCrew } from "../lib/queries.js";
import { onReconnect, useSocketEvent } from "../lib/socket.js";

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

  // The page thinks someone's signed in, but is the server's login still alive? If not,
  // forget it locally (shows the login screen). Returns true if still signed in.
  const stillSignedIn = useCallback(async () => {
    try {
      const me = await get("/auth/me");
      if (me.astronaut_id) return true;
    } catch { /* offline: treat as unknown -> not signed in for this check */ }
    queryClient.clear();
    setViewedId(null);
    setUser(null);
    return false;
  }, []);

  const loginWithScan = useCallback(async (uid) => {
    if (!uid) return;
    if (user && (await stillSignedIn())) return; // a real, live login: a tap doesn't switch it
    try {
      signIn(await post("/auth/nfc_login", { uid }));
    } catch {
      // Not every tap is a login (exercise/meal/emergency tags broadcast "scan" too).
    }
  }, [user, stillSignedIn, signIn]);

  useSocketEvent("scan", (d) => loginWithScan(d?.uid));

  // Back online after a drop: re-sync the login, refresh data, and replay a card tap made
  // while we couldn't hear it (only one newer than the gap, plus a little slack).
  useEffect(() => onReconnect(async (gapSeconds) => {
    queryClient.invalidateQueries();
    const signedIn = user ? await stillSignedIn() : false;
    if (signedIn) return;
    try {
      const recent = await get("/recent-scan");
      if (recent.uid && recent.age_s <= gapSeconds + 3) loginWithScan(recent.uid);
    } catch { /* nothing to replay */ }
  }), [user, stillSignedIn, loginWithScan]);

  // Any 401 from the API while signed in = the server's login expired: show the login screen.
  useEffect(() => {
    const onUnauthorized = () => { if (user) stillSignedIn(); };
    window.addEventListener("ah:unauthorized", onUnauthorized);
    return () => window.removeEventListener("ah:unauthorized", onUnauthorized);
  }, [user, stillSignedIn]);

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
