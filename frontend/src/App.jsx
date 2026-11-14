// Top-level wiring: data cache, motion settings, router, auth gate, and the overlays that
// must work signed in or not (simulator, emergency, toasts).
import { lazy, Suspense } from "react";
import { MotionConfig, motion } from "motion/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Navigate, Route, Routes, useLocation } from "react-router";
import { AuthProvider, useAuth } from "./auth/AuthProvider.jsx";
import { queryClient } from "./lib/queries.js";
import { AppShell } from "./components/layout/AppShell.jsx";
import { SimulatorDock } from "./components/SimulatorDock.jsx";
import { EmergencyOverlay } from "./components/overlays/EmergencyOverlay.jsx";
import { AstraProvider } from "./components/AstraProvider.jsx";
import { ToastProvider } from "./components/overlays/Toasts.jsx";
import { Login } from "./pages/Login.jsx";
import LogoCrew from "./assets/brand/logo-mark-crew.svg?react";

// Each page is its own chunk, loaded when first opened -- the login screen ships small,
// and heavy pages (3D, charts) never cost anything until you visit them.
const Overview = lazy(() => import("./pages/crew/Overview.jsx"));
const Body = lazy(() => import("./pages/crew/health/Body.jsx"));
const Trends = lazy(() => import("./pages/crew/health/Trends.jsx"));
const Mind = lazy(() => import("./pages/crew/daily/Mind.jsx"));
const Sleep = lazy(() => import("./pages/crew/daily/Sleep.jsx"));
const Mission = lazy(() => import("./pages/crew/mission/Mission.jsx"));
const Today = lazy(() => import("./pages/crew/daily/Today.jsx"));
const Exercise = lazy(() => import("./pages/crew/daily/Exercise.jsx"));
const CrewOverview = lazy(() => import("./pages/doctor/CrewOverview.jsx"));
const Alerts = lazy(() => import("./pages/doctor/Alerts.jsx"));
const CrewProfile = lazy(() => import("./pages/doctor/CrewProfile.jsx"));
const Records = lazy(() => import("./pages/doctor/Records.jsx"));
const Admin = lazy(() => import("./pages/admin/Admin.jsx"));
const StatusBoard = lazy(() => import("./pages/StatusBoard.jsx"));

function Splash() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-space">
      <motion.div animate={{ opacity: [0.4, 1, 0.4], scale: [0.96, 1, 0.96] }} transition={{ duration: 1.6, repeat: Infinity }}>
        <LogoCrew width={56} height={56} aria-label="Loading" />
      </motion.div>
    </div>
  );
}

// Doctor screens are for the Flight Surgeon only (the backend enforces it too). Crew
// pages are open to both: the surgeon views them for whichever crew member is picked.
function DoctorOnly({ children }) {
  const { isSurgeon } = useAuth();
  return isSurgeon ? children : <Navigate to="/" replace />;
}

// The Simulator/Emergency overlays are dev tooling for the normal crew/doctor app --
// /status-board is meant to sit on a real shared screen, so neither belongs there.
function KioskOverlays() {
  const { pathname } = useLocation();
  if (pathname === "/status-board") return null;
  return (
    <>
      <SimulatorDock />
      <EmergencyOverlay />
    </>
  );
}

function Gate() {
  const { user, checking } = useAuth();
  if (checking) return <Splash />;
  if (!user) return <Login />;
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<Overview />} />
        <Route path="body" element={<Body />} />
        <Route path="trends" element={<Trends />} />
        <Route path="mind" element={<Mind />} />
        <Route path="sleep" element={<Sleep />} />
        <Route path="mission" element={<Mission />} />
        <Route path="exercise" element={<Exercise />} />
        <Route path="today" element={<Today />} />
        <Route path="schedule" element={<Navigate to="/today" replace />} />
        <Route path="learn" element={<Navigate to="/" replace />} />
        <Route path="doctor" element={<DoctorOnly><CrewOverview /></DoctorOnly>} />
        <Route path="doctor/alerts" element={<DoctorOnly><Alerts /></DoctorOnly>} />
        <Route path="doctor/crew/:id" element={<DoctorOnly><CrewProfile /></DoctorOnly>} />
        <Route path="doctor/records" element={<DoctorOnly><Records /></DoctorOnly>} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <MotionConfig reducedMotion="user">
        <BrowserRouter>
          <AuthProvider>
            <ToastProvider>
              {/* /admin has its own superuser login, and /status-board is a read-only,
                  unauthenticated shared-display view (aggregate-only backend response) --
                  both sit outside the crew/doctor gate. */}
              <AstraProvider>
                <Routes>
                  <Route path="/admin" element={<Suspense fallback={<Splash />}><Admin /></Suspense>} />
                  <Route path="/status-board" element={<Suspense fallback={<Splash />}><StatusBoard /></Suspense>} />
                  <Route path="*" element={<Gate />} />
                </Routes>
                <KioskOverlays />
              </AstraProvider>
            </ToastProvider>
          </AuthProvider>
        </BrowserRouter>
      </MotionConfig>
    </QueryClientProvider>
  );
}
