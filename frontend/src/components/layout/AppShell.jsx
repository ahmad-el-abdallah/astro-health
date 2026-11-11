// App shell (DESIGN-SPEC §3): sidebar + main column. Only the active page is mounted
// (React Router), which is what keeps hidden pages from running animations/3D in the
// background -- the old app kept all 11 tabs alive at once.
//
// Sidebar (Sidebar.jsx): tablet/desktop get a sticky column that collapses to an icon rail
// (edge button or Ctrl/⌘+B; the choice is remembered per browser, and the first visit
// starts collapsed below 1200px). Phones get a ☰ button in the top bar and the same
// sidebar as a slide-in drawer.
import { Suspense, useCallback, useEffect, useState } from "react";
import { useLocation, useOutlet } from "react-router";
import { AnimatePresence, motion } from "motion/react";
import { useAuth } from "../../auth/AuthProvider.jsx";
import { navItemFor } from "../../nav.js";
import { STRINGS } from "../../strings.js";
import { AccountDrawer } from "../overlays/AccountDrawer.jsx";
import { useToast } from "../overlays/Toasts.jsx";
import { useSocketEvent } from "../../lib/socket.js";
import { Shimmer } from "../ui/index.jsx";
import { page } from "../ui/motion.js";
import { Icon } from "../ui/Icon.jsx";
import { useMediaQuery } from "../../lib/useMediaQuery.js";
import { EASE_ENTER } from "../ui/motion.js";
import { Sidebar } from "./Sidebar.jsx";
import { TopBar } from "./TopBar.jsx";
import { SpaceBackdrop } from "./SpaceBackdrop.jsx";

function PageLoading() {
  return (
    <div className="grid gap-[18px] md:grid-cols-3">
      <Shimmer className="h-40 md:col-span-2" />
      <Shimmer className="h-40" />
      <Shimmer className="h-64 md:col-span-3" />
    </div>
  );
}

const RAIL_KEY = "ah-sidebar";
const WIDTH = { expanded: 264, collapsed: 76 };

function initialCollapsed() {
  try {
    const saved = localStorage.getItem(RAIL_KEY);
    if (saved) return saved === "collapsed";
  } catch { /* storage blocked */ }
  return window.innerWidth < 1200;
}

function useSidebar() {
  const isPhone = useMediaQuery("(max-width: 767px)");
  const [collapsed, setCollapsed] = useState(initialCollapsed);
  const [drawerOpen, setDrawerOpen] = useState(false);

  const toggleRail = useCallback(() => {
    setCollapsed((c) => {
      try { localStorage.setItem(RAIL_KEY, c ? "expanded" : "collapsed"); } catch { /* not remembered */ }
      return !c;
    });
  }, []);
  const toggle = useCallback(() => (isPhone ? setDrawerOpen((o) => !o) : toggleRail()), [isPhone, toggleRail]);

  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "b") {
        const t = e.target;
        if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
        e.preventDefault();
        toggle();
      } else if (e.key === "Escape") {
        setDrawerOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggle]);

  return { isPhone, collapsed, toggleRail, drawerOpen: isPhone && drawerOpen, setDrawerOpen, toggle };
}

// A crew member hears about a Flight Surgeon reply the moment it arrives (after the
// comms delay), on whatever page they're on. The full thread is on their Overview.
function ReplyNotifier() {
  const { user, isSurgeon } = useAuth();
  const toast = useToast();
  useSocketEvent("message_delivered", (m) => {
    if (!isSurgeon && m?.from_role === "surgeon" && m.astronaut_id === user?.astronaut_id) {
      toast(`Message from your Flight Surgeon: ${String(m.body || "").slice(0, 80)}`, "info");
    }
  });
  return null;
}

export function AppShell() {
  const location = useLocation();
  const outlet = useOutlet();
  const { isSurgeon } = useAuth();
  const [accountOpen, setAccountOpen] = useState(false);
  const sb = useSidebar();
  const closeDrawer = () => sb.setDrawerOpen(false);
  const openAccount = () => setAccountOpen(true);
  const item = navItemFor(location.pathname, isSurgeon);
  const eyebrow = item?.eyebrow || (isSurgeon ? "Medical console" : "Station · Crew");
  // Pages that are about one crew member show the Flight Surgeon's astronaut picker.
  const showPicker = !location.pathname.startsWith("/doctor");

  return (
    <div className="flex min-h-screen gap-5 p-5 pb-24 max-md:p-4 max-md:pb-24">
      <SpaceBackdrop />
      <ReplyNotifier />

      {!sb.isPhone && (
        // Only this column's width animates; the sidebar inside keeps every icon at a fixed x.
        <motion.div
          className="relative shrink-0"
          initial={false}
          animate={{ width: sb.collapsed ? WIDTH.collapsed : WIDTH.expanded }}
          transition={{ duration: 0.26, ease: EASE_ENTER }}
        >
          <div className="sticky top-5 h-[calc(100vh-40px)]">
            <Sidebar collapsed={sb.collapsed} onAccount={openAccount} />
            <button
              onClick={sb.toggleRail}
              aria-label={sb.collapsed ? "Expand sidebar" : "Collapse sidebar"}
              aria-expanded={!sb.collapsed}
              title={`${sb.collapsed ? "Expand" : "Collapse"} sidebar (${/Mac/.test(navigator.platform) ? "⌘" : "Ctrl"}+B)`}
              className="group absolute top-[30px] -right-3.5 z-10 flex h-7 w-7 cursor-pointer items-center justify-center ah-glass-strong rounded-full text-ink-2 shadow-[0_4px_14px_rgba(0,0,0,.4)] transition-colors hover:text-ink"
            >
              <motion.span animate={{ rotate: sb.collapsed ? 180 : 0 }} transition={{ duration: 0.26, ease: EASE_ENTER }} className="flex">
                <Icon name="chevron-left" size={15} />
              </motion.span>
            </button>
          </div>
        </motion.div>
      )}

      <AnimatePresence>
        {sb.drawerOpen && (
          <>
            <motion.div
              key="scrim"
              className="fixed inset-0 z-[110] bg-black/55"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={closeDrawer}
            />
            <motion.div
              key="drawer"
              role="dialog"
              aria-modal="true"
              aria-label="Menu"
              className="fixed inset-y-3 left-3 z-[111] w-[min(300px,calc(100vw-48px))]"
              initial={{ x: "-110%" }}
              animate={{ x: 0 }}
              exit={{ x: "-110%" }}
              transition={{ type: "spring", stiffness: 380, damping: 38 }}
            >
              <Sidebar drawer onNavigate={closeDrawer} onClose={closeDrawer} onAccount={openAccount} />
            </motion.div>
          </>
        )}
      </AnimatePresence>

      <div className="flex min-w-0 flex-1 flex-col gap-[18px]">
        <TopBar
          eyebrow={eyebrow}
          title={item?.title || item?.label || ""}
          onAccount={openAccount}
          showPicker={showPicker}
          onMenu={sb.isPhone ? () => sb.setDrawerOpen(true) : null}
        />
        <AnimatePresence mode="wait" initial={false}>
          <motion.main
            key={location.pathname}
            variants={page}
            initial="initial"
            animate="animate"
            exit="exit"
            className="flex flex-col gap-[18px]"
          >
            <Suspense fallback={<PageLoading />}>{outlet}</Suspense>
          </motion.main>
        </AnimatePresence>
        <footer className="mt-auto pt-6 text-center text-xs text-subtle">{STRINGS.footerDisclaimer}</footer>
      </div>

      <AccountDrawer open={accountOpen} onClose={() => setAccountOpen(false)} />
    </div>
  );
}
