// The app sidebar, in three forms (AppShell picks one):
// - expanded (264px) and
// - collapsed to an icon rail (76px) on tablet/desktop -- toggled with the edge button
//   or Ctrl/⌘+B, remembered per browser. The width animates in AppShell; in here every
//   icon, avatar and logo sits at the SAME x in both widths, so nothing jumps -- labels
//   just fade and get clipped as the rail closes. In the rail, hovering or focusing an
//   item shows a glass tooltip with its name (and alert count).
// - a slide-in drawer on phones (`drawer`), with a close button.
// The active page's highlight is one shared-layout pill that glides between items.
import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { NavLink } from "react-router";
import { AnimatePresence, motion } from "motion/react";
import { useAuth } from "../../auth/AuthProvider.jsx";
import { CREW_NAV, DOCTOR_NAV } from "../../nav.js";
import { useAlerts, useCrew, useSummary } from "../../lib/queries.js";
import { useToday } from "../../lib/useToday.js";
import { serialStatusStore, useStore } from "../../lib/socket.js";
import { STRINGS } from "../../strings.js";
import { Icon } from "../ui/Icon.jsx";
import { Avatar, cx } from "../ui/index.jsx";
import LogoCrew from "../../assets/brand/logo-mark-crew.svg?react";
import LogoDoctor from "../../assets/brand/logo-mark-doctor.svg?react";

const DOT = { GREEN: "bg-good-fg", YELLOW: "bg-check-fg", RED: "bg-alert-fg", GRAY: "bg-subtle" };
const RING = { GREEN: "ring-good-fg/70", YELLOW: "ring-check-fg/70", RED: "ring-alert-fg/80", GRAY: "ring-line-strong" };
const PILL_SPRING = { type: "spring", stiffness: 420, damping: 38 };

// Text that fades out as the rail closes (and back in, a beat later, as it opens).
function Fade({ hidden, className = "", children }) {
  return (
    <span
      aria-hidden={hidden || undefined}
      className={cx(
        "min-w-0 whitespace-nowrap transition-opacity",
        hidden ? "opacity-0 duration-100" : "opacity-100 delay-100 duration-200",
        className,
      )}
    >
      {children}
    </span>
  );
}

// Rail-only tooltip, portalled to <body> so the sidebar's scroll clipping can't cut it off.
function RailTip({ enabled, label, extra, children }) {
  const ref = useRef(null);
  const [pos, setPos] = useState(null);
  const open = () => {
    if (!enabled || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    setPos({ x: r.right + 14, y: r.top + r.height / 2 });
  };
  const close = () => setPos(null);
  return (
    <div ref={ref} onPointerEnter={open} onPointerLeave={close} onFocusCapture={open} onBlurCapture={close}>
      {children}
      {createPortal(
        <AnimatePresence>
          {enabled && pos && (
            <motion.div
              key="tip"
              role="tooltip"
              initial={{ opacity: 0, x: -6 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -4 }}
              transition={{ duration: 0.14 }}
              style={{ left: pos.x, top: pos.y }}
              className="pointer-events-none fixed z-[80] flex -translate-y-1/2 items-center gap-2 ah-glass-strong rounded-xl px-3 py-2 text-label font-semibold whitespace-nowrap text-ink shadow-[0_12px_30px_rgba(0,0,0,.45)]"
            >
              {label}
              {extra != null && <span className="rounded-full bg-alert-action px-1.5 text-caption font-bold text-white">{extra}</span>}
            </motion.div>
          )}
        </AnimatePresence>,
        document.body,
      )}
    </div>
  );
}

function NavItem({ item, badge, collapsed, pillId, onNavigate }) {
  return (
    <RailTip enabled={collapsed} label={item.label} extra={badge}>
      <NavLink to={item.to} end={item.end} onClick={onNavigate} aria-label={item.label} className="block rounded-xl">
        {({ isActive }) => (
          <span
            className={cx(
              "relative flex h-11 items-center gap-3 overflow-hidden rounded-xl pl-[16px] pr-3 text-sm transition-colors duration-200",
              isActive ? "font-semibold text-accent-on" : "text-ink-2 hover:bg-raised hover:text-ink",
            )}
          >
            {isActive && (
              <motion.span
                layoutId={pillId}
                className="absolute inset-0 rounded-xl bg-accent shadow-[0_6px_22px_rgb(var(--ah-accent-rgb)/.35),inset_0_1px_0_rgba(255,255,255,.22)]"
                transition={PILL_SPRING}
              />
            )}
            <Icon name={item.icon} size={19} className="relative shrink-0" />
            <Fade hidden={collapsed} className="relative flex-1 truncate">{item.label}</Fade>
            {badge != null && !collapsed && (
              <span className={cx("relative rounded-full px-1.5 py-px text-caption font-bold", isActive ? "bg-white/25 text-white" : "bg-alert-action text-white")}>{badge}</span>
            )}
            {badge != null && collapsed && (
              <span className="absolute top-2 left-[30px] h-2.5 w-2.5 rounded-full bg-alert-action ring-2 ring-[var(--ah-surface-1)]" />
            )}
          </span>
        )}
      </NavLink>
    </RailTip>
  );
}

// Group heading; in the rail it turns into a short divider (same height, so nothing shifts).
function GroupLabel({ text, collapsed }) {
  return (
    <div className="relative flex h-7 items-center px-3">
      <Fade hidden={collapsed} className="text-caption font-semibold tracking-[0.12em] text-subtle uppercase">{text}</Fade>
      <span className={cx("absolute left-[18px] h-px w-4 bg-line-strong transition-opacity duration-200", collapsed ? "opacity-100" : "opacity-0")} />
    </div>
  );
}

const DEVICE_TONE = {
  connected: { dot: "bg-good-fg", text: "text-good-fg" },
  simulation: { dot: "bg-check-fg", text: "text-check-fg" },
  connecting: { dot: "bg-check-fg", text: "text-check-fg" },
  reconnecting: { dot: "bg-alert-fg", text: "text-alert-fg" },
};

// The CYD link status (real serial_status broadcasts -- no battery: there's no battery data).
function DeviceStatus({ collapsed }) {
  const status = useStore(serialStatusStore);
  const tone = DEVICE_TONE[status] || DEVICE_TONE.connecting;
  const label = STRINGS.serialStatus[status] || status;
  return (
    <RailTip enabled={collapsed} label={`CYD device · ${label}`}>
      <div className="flex items-center gap-3 rounded-2xl border border-line bg-raised p-[5px] pr-3">
        <span className="relative flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-control text-ink-2">
          <Icon name="device" size={18} />
          <span className={cx("absolute top-1.5 right-1.5 h-2 w-2 rounded-full", tone.dot, status !== "connected" && "animate-[ah-pulse-dot_1.6s_ease-in-out_infinite]")} />
        </span>
        <Fade hidden={collapsed} className="flex flex-col">
          <span className="text-caption font-semibold tracking-[0.1em] text-subtle uppercase">CYD device</span>
          <motion.span key={status} initial={{ opacity: 0, y: 3 }} animate={{ opacity: 1, y: 0 }} className={cx("text-xs font-semibold", tone.text)}>
            {label}
          </motion.span>
        </Fade>
      </div>
    </RailTip>
  );
}

export function Sidebar({ collapsed = false, drawer = false, onNavigate, onAccount, onClose }) {
  const { user, isSurgeon, signOut } = useAuth();
  const summary = useSummary(isSurgeon ? null : user?.astronaut_id);
  const alerts = useAlerts(isSurgeon);
  const crew = useCrew(isSurgeon);
  const groups = isSurgeon ? DOCTOR_NAV : CREW_NAV;
  const openAlerts = (alerts.data || []).filter((a) => !a.acknowledged).length;
  const today = useToday(isSurgeon ? null : user?.astronaut_id); // daily check-ins due now
  const Logo = isSurgeon ? LogoDoctor : LogoCrew;
  // Two separate pills, so the drawer and the desktop sidebar never fight over one layoutId.
  const pillId = drawer ? "nav-pill-drawer" : "nav-pill";

  return (
    <nav
      aria-label={isSurgeon ? "Doctor navigation" : "Crew navigation"}
      className={cx("h-full overflow-hidden rounded-card-l", drawer ? "ah-glass-strong" : "ah-glass")}
    >
      {/* Scrolling happens on this inner layer, so the glass rim stays put. */}
      <div className="flex h-full flex-col gap-4 overflow-x-hidden overflow-y-auto px-3 py-4">
        <div className="flex items-center gap-3 px-[7px]">
          <Logo width={38} height={38} aria-hidden="true" className="shrink-0" />
          <Fade hidden={collapsed} className="flex flex-1 flex-col">
            <span className="font-display text-base leading-tight font-bold tracking-tight">Astro Health</span>
            <span className="text-caption tracking-[0.08em] text-muted">{isSurgeon ? "MEDICAL CONSOLE" : "STATION · CREW"}</span>
          </Fade>
          {drawer && (
            <button onClick={onClose} aria-label="Close menu" className="flex h-10 w-10 shrink-0 cursor-pointer items-center justify-center rounded-xl text-ink-2 hover:bg-raised hover:text-ink">
              <Icon name="close" size={18} />
            </button>
          )}
        </div>

        {/* Who's signed in: opens Account; Log out sits right next to it. */}
        <RailTip enabled={collapsed} label={`${user?.name || ""} · Account`}>
          <div className="flex items-center gap-1 rounded-2xl border border-line bg-raised p-[5px]">
            <button
              onClick={() => { onNavigate?.(); onAccount?.(); }}
              className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 rounded-xl text-left"
              aria-label={`Account and security for ${user?.name || "you"}`}
            >
              <span className="relative shrink-0">
                <Avatar name={user?.name} color={summary.data?.astronaut?.color} size={40} />
                <span className="absolute -right-0.5 -bottom-0.5 h-3 w-3 rounded-full border-2 border-[var(--ah-surface-1)] bg-good-fg" />
              </span>
              <Fade hidden={collapsed} className="flex flex-col">
                <span className="truncate text-sm font-semibold">{user?.name}</span>
                <span className="text-xs text-muted">{isSurgeon ? "Flight surgeon" : "Crew member"}</span>
              </Fade>
            </button>
            <AnimatePresence initial={false}>
              {!collapsed && (
                <motion.button
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1, transition: { delay: 0.12, duration: 0.2 } }}
                  exit={{ opacity: 0, transition: { duration: 0.06 } }}
                  onClick={signOut}
                  aria-label="Log out"
                  title="Log out"
                  className="flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-lg text-muted transition-colors hover:bg-control hover:text-ink"
                >
                  <Icon name="logout" size={17} />
                </motion.button>
              )}
            </AnimatePresence>
          </div>
        </RailTip>

        <div className="flex flex-col gap-3">
          {groups.map((g, gi) => (
            <div key={gi} className="flex flex-col gap-0.5">
              {g.group && <GroupLabel text={g.group} collapsed={collapsed} />}
              {g.items.map((item) => (
                <NavItem
                  key={item.to}
                  item={item}
                  collapsed={collapsed}
                  pillId={pillId}
                  onNavigate={onNavigate}
                  badge={item.showsAlerts && openAlerts ? openAlerts : item.showsDue && today.due ? today.due : null}
                />
              ))}
            </div>
          ))}

          {isSurgeon && (crew.data || []).length > 0 && (
            <div className="flex flex-col gap-0.5">
              <GroupLabel text="Crew" collapsed={collapsed} />
              {crew.data.map((a) => (
                <RailTip key={a.id} enabled={collapsed} label={`${a.name}${a.session_active ? " · live" : ""}`}>
                  <NavLink to={`/doctor/crew/${a.id}`} onClick={onNavigate} aria-label={a.name} className="block rounded-xl">
                    {({ isActive }) => (
                      <span
                        className={cx(
                          "flex h-11 items-center gap-3 rounded-xl pl-[12px] pr-3 text-sm transition-colors",
                          isActive ? "bg-control text-ink" : "text-ink-2 hover:bg-raised hover:text-ink",
                        )}
                      >
                        <span className={cx("relative flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-control text-caption font-bold text-ink ring-2", RING[a.status] || RING.GRAY)}>
                          {a.name?.[0]}
                          <span className={cx("absolute -right-0.5 -bottom-0.5 h-2.5 w-2.5 rounded-full border-2 border-[var(--ah-surface-1)]", DOT[a.status] || DOT.GRAY)} />
                        </span>
                        <Fade hidden={collapsed} className="flex-1 truncate">{a.name}</Fade>
                        {a.session_active && !collapsed && <span className="text-caption font-semibold text-accent-text">live</span>}
                      </span>
                    )}
                  </NavLink>
                </RailTip>
              ))}
            </div>
          )}
        </div>

        <div className="mt-auto pt-2">
          <DeviceStatus collapsed={collapsed} />
        </div>
      </div>
    </nav>
  );
}
