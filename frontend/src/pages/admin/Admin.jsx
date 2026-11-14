// Superuser admin (/admin) -- replaces templates/admin.html + static/js/admin_page.js.
// Its own login (backend/auth/admin_auth.py: session["superuser_id"]), independent of
// the crew / Flight Surgeon sign-in, so it sits outside the main app's gate (App.jsx).
// - Unknown cards: every unrecognised tap (live -- a card tapped while this page is open
//   slides in at once), assigned here: a person card (existing astronaut, optionally
//   changing their role, or a brand-new one) or an object tag with a label.
// - Card registry: every assigned card/tag, with delete (two-step).
// - Crew accounts: role, card, sign-in status, set a username/password, clear Face ID,
//   and add a crew member. Account recovery only -- the secrets are never shown.
// - Station voice: which engine speaks Astra's replies (browser voice, offline, no echo
//   / Microsoft neural voice, needs internet, station reverb + echo), which neural voice,
//   station effects on/off, and "Test voice" to hear it before saving.
import { useState } from "react";
import { Link } from "react-router";
import { AnimatePresence, motion } from "motion/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { del, get, post, put } from "../../lib/api.js";
import { fmtTime } from "../../lib/format.js";
import { Avatar, Button, Card, CardTitle, Field, Shimmer, StatusChip, cx } from "../../components/ui/index.jsx";
import { Icon } from "../../components/ui/Icon.jsx";
import { SpaceBackdrop } from "../../components/layout/SpaceBackdrop.jsx";
import { useToast } from "../../components/overlays/Toasts.jsx";
import LogoCrew from "../../assets/brand/logo-mark-crew.svg?react";
import { audioCtx, playNeural, quindar } from "../../lib/stationAudio.js";
import { pickVoice } from "../../lib/useVoice.js";
import { RecordsBrowser } from "../../components/records/RecordsBrowser.jsx";

const KINDS = [
  ["astronaut", "Crew member card"], ["surgeon", "Flight Surgeon card"], ["exercise", "Exercise equipment"],
  ["sleep", "Sleep station"], ["meal", "Food packet"], ["medicine", "Medicine kit item"],
  ["bp_guide", "Blood pressure cuff"], ["emergency", "Emergency card"],
];
const KIND_LABEL = Object.fromEntries(KINDS);
const ROLES = ["Crew member", "Flight surgeon"];
const PERSON = new Set(["astronaut", "surgeon"]);

const useAdminAstronauts = (enabled) => useQuery({ queryKey: ["admin-astronauts"], queryFn: () => get("/admin/astronauts"), enabled });
const useUnknown = (enabled) => useQuery({ queryKey: ["admin-unknown"], queryFn: () => get("/admin/unknown-tags"), enabled });
const useAllTags = () => useQuery({ queryKey: ["tags"], queryFn: () => get("/tags") });

function refreshAll(qc) {
  ["admin-unknown", "admin-astronauts", "tags", "crew"].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
}

// ---------- login ----------
function AdminLogin() {
  const qc = useQueryClient();
  const [u, setU] = useState("");
  const [p, setP] = useState("");
  const [err, setErr] = useState("");
  async function submit(e) {
    e.preventDefault();
    setErr("");
    try {
      await post("/admin/login", { username: u, password: p });
      qc.invalidateQueries({ queryKey: ["admin-me"] });
    } catch {
      setErr("Invalid username or password.");
    }
  }
  return (
    <div className="relative flex min-h-screen items-center justify-center p-5">
      <SpaceBackdrop />
      <motion.form
        onSubmit={submit}
        initial={{ opacity: 0, y: 14 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5 }}
        className="flex w-full max-w-sm flex-col gap-4 ah-glass-strong rounded-hero p-7"
      >
        <div className="flex items-center gap-3">
          <LogoCrew width={40} height={40} aria-hidden="true" />
          <div>
            <div className="font-display text-lg font-bold">Astro Health</div>
            <div className="ah-eyebrow">Admin</div>
          </div>
        </div>
        <p className="m-0 text-sm text-muted">Superuser sign-in, for assigning NFC cards and recovering crew accounts.</p>
        <Field label="Username"><input className="ah-input" value={u} onChange={(e) => setU(e.target.value)} autoComplete="username" required /></Field>
        <Field label="Password"><input className="ah-input" type="password" value={p} onChange={(e) => setP(e.target.value)} autoComplete="current-password" required /></Field>
        {err && <p className="m-0 text-sm text-alert-fg" role="alert">{err}</p>}
        <Button variant="primary" type="submit" className="min-h-12">Sign in</Button>
        <p className="m-0 text-xs text-subtle">No account? Run <code className="text-ink-2">python -m backend.auth.create_superuser</code> on the laptop.</p>
        <Link to="/" className="text-center text-sm text-accent-text hover:underline">Back to Astro Health</Link>
      </motion.form>
    </div>
  );
}

// ---------- unknown cards ----------
function AssignCard({ tag, astronauts }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [kind, setKind] = useState("astronaut");
  const [mode, setMode] = useState("existing");
  const [pick, setPick] = useState(astronauts[0]?.id ?? "");
  const [role, setRole] = useState("Crew member");
  const [name, setName] = useState("");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const person = PERSON.has(kind);

  function changeKind(k) {
    setKind(k);
    if (k === "surgeon") setRole("Flight surgeon");
    if (k === "astronaut") setRole("Crew member");
  }

  async function assign(e) {
    e.preventDefault();
    setBusy(true);
    try {
      let astronautId = null;
      let who = "";
      if (person) {
        if (mode === "new") {
          if (!name.trim()) throw new Error("name");
          const created = await post("/astronauts", { name: name.trim(), role });
          astronautId = created.id;
          who = created.name;
        } else {
          const a = astronauts.find((x) => x.id === Number(pick));
          astronautId = a.id;
          who = a.name;
          if (a.role !== role) await put(`/astronauts/${a.id}/role`, { role });
        }
      }
      await post("/tags", { uid: tag.uid, type: kind, label: label.trim() || who || tag.uid, astronaut_id: astronautId });
      toast(`${tag.uid} assigned${who ? ` to ${who}` : ""}.`, "success");
      refreshAll(qc);
    } catch (err) {
      toast(err.message === "name" ? "Type a name for the new crew member." : "Couldn't assign that card.", "error");
    } finally {
      setBusy(false);
    }
  }

  async function dismiss() {
    await del(`/admin/unknown-tags/${encodeURIComponent(tag.uid)}`);
    qc.invalidateQueries({ queryKey: ["admin-unknown"] });
  }

  return (
    <motion.form
      layout
      onSubmit={assign}
      initial={{ opacity: 0, x: -16, scale: 0.98 }}
      animate={{ opacity: 1, x: 0, scale: 1 }}
      exit={{ opacity: 0, x: 24, transition: { duration: 0.2 } }}
      transition={{ type: "spring", stiffness: 320, damping: 30 }}
      className="flex flex-col gap-3.5 rounded-2xl border border-accent-text/30 bg-raised p-4"
    >
      <div className="flex flex-wrap items-center gap-3">
        <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent-soft text-accent-text"><Icon name="device" size={18} /></span>
        <code className="font-mono text-base font-bold tracking-wide">{tag.uid}</code>
        <span className="text-xs text-muted">tapped {tag.count}× · last {fmtTime(tag.last_seen)}</span>
        <button type="button" onClick={dismiss} className="ml-auto min-h-9 cursor-pointer rounded-lg px-3 text-label text-ink-2 hover:bg-control hover:text-ink">Dismiss</button>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Assign as">
          <select className="ah-input" value={kind} onChange={(e) => changeKind(e.target.value)}>
            {KINDS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </Field>
        {person ? (
          <Field label="Who">
            <select className="ah-input" value={mode} onChange={(e) => setMode(e.target.value)}>
              <option value="existing">An existing crew member</option>
              <option value="new">A new crew member</option>
            </select>
          </Field>
        ) : (
          <Field label="Label"><input className="ah-input" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Treadmill" /></Field>
        )}
        {person && mode === "existing" && (
          <Field label="Crew member">
            <select className="ah-input" value={pick} onChange={(e) => setPick(e.target.value)}>
              {astronauts.map((a) => <option key={a.id} value={a.id}>{a.name} ({a.role}){a.card_uid ? " · has a card" : ""}</option>)}
            </select>
          </Field>
        )}
        {person && mode === "new" && (
          <Field label="Name"><input className="ah-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Priya" /></Field>
        )}
        {person && (
          <Field label="Role">
            <select className="ah-input" value={role} onChange={(e) => setRole(e.target.value)}>
              {ROLES.map((r) => <option key={r}>{r}</option>)}
            </select>
          </Field>
        )}
      </div>
      <div className="flex justify-end">
        <Button variant="primary" type="submit" busy={busy}>{!busy && <Icon name="tick" size={16} />} Assign card</Button>
      </div>
    </motion.form>
  );
}

function UnknownCards({ astronauts }) {
  const q = useUnknown(true);
  const list = q.data || [];
  return (
    <Card className="flex flex-col gap-3">
      <CardTitle
        eyebrow="Unknown cards"
        title={list.length ? `${list.length} card${list.length > 1 ? "s" : ""} waiting` : "Nothing waiting"}
        subtitle="Any card the readers don't recognise lands here, live. Tap a new card on the reader (or the Simulator) and assign it."
        right={<span className="inline-flex items-center gap-1.5 rounded-full bg-good-bg px-2.5 py-1 text-xs font-semibold text-good-fg"><span className="h-1.5 w-1.5 animate-[ah-pulse-dot_1.6s_ease-in-out_infinite] rounded-full bg-current" />Listening</span>}
      />
      {list.length === 0 ? (
        <p className="m-0 rounded-[var(--radius-inner)] bg-raised p-4 text-sm text-muted">No unassigned taps right now.</p>
      ) : (
        <div className="flex flex-col gap-3">
          <AnimatePresence initial={false}>
            {list.map((t) => <AssignCard key={t.uid} tag={t} astronauts={astronauts} />)}
          </AnimatePresence>
        </div>
      )}
    </Card>
  );
}

// ---------- registry ----------
function Registry({ astronauts }) {
  const qc = useQueryClient();
  const toast = useToast();
  const tags = useAllTags();
  const [confirm, setConfirm] = useState(null);
  const byId = new Map(astronauts.map((a) => [a.id, a]));
  async function remove(uid) {
    try {
      await del(`/tags/${encodeURIComponent(uid)}`);
      toast(`${uid} removed.`, "success");
      refreshAll(qc);
    } catch {
      toast("Couldn't remove that card.", "error");
    } finally {
      setConfirm(null);
    }
  }
  const list = tags.data || [];
  return (
    <Card className="flex flex-col gap-3">
      <CardTitle eyebrow="Card registry" title={`${list.length} assigned card${list.length === 1 ? "" : "s"}`} subtitle="Removing a card makes it unknown again; the crew member and their data stay." />
      <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
        <AnimatePresence initial={false}>
          {list.map((t) => {
            const who = t.astronaut_id ? byId.get(t.astronaut_id) : null;
            return (
              <motion.li
                key={t.uid}
                layout
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0, x: 24 }}
                className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 rounded-[var(--radius-inner)] bg-raised px-3.5 py-2.5 text-sm sm:grid-cols-[150px_minmax(0,1fr)_minmax(0,1fr)_auto]"
              >
                <code className="font-mono font-semibold">{t.uid}</code>
                <span className="truncate text-ink-2 max-sm:order-3">{KIND_LABEL[t.type] || t.type}</span>
                <span className="flex min-w-0 items-center gap-2 max-sm:order-4">
                  {who && <Avatar name={who.name} color={who.color} size={24} />}
                  <span className="truncate">{who ? who.name : t.label}</span>
                </span>
                {confirm === t.uid ? (
                  <span className="flex gap-1.5 max-sm:order-2">
                    <button onClick={() => remove(t.uid)} className="min-h-9 cursor-pointer rounded-lg bg-alert-action px-3 text-label font-bold text-white">Remove</button>
                    <button onClick={() => setConfirm(null)} className="min-h-9 cursor-pointer rounded-lg px-3 text-label text-ink-2 hover:bg-control">Keep</button>
                  </span>
                ) : (
                  <button onClick={() => setConfirm(t.uid)} className="min-h-9 cursor-pointer justify-self-end rounded-lg px-3 text-label text-ink-2 hover:bg-control hover:text-alert-fg max-sm:order-2">Delete</button>
                )}
              </motion.li>
            );
          })}
        </AnimatePresence>
      </ul>
    </Card>
  );
}

// ---------- accounts ----------
function AccountRow({ a }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [username, setUsername] = useState(a.username || "");
  const [password, setPassword] = useState("");
  async function changeRole(role) {
    try {
      await put(`/astronauts/${a.id}/role`, { role });
      toast(`${a.name} is now: ${role}.`, "success");
      refreshAll(qc);
    } catch {
      toast("Couldn't change the role.", "error");
    }
  }
  async function savePassword(e) {
    e.preventDefault();
    try {
      await post(`/astronauts/${a.id}/password`, { username, password });
      toast(`Sign-in set for ${a.name}.`, "success");
      setPassword("");
      setOpen(false);
      refreshAll(qc);
    } catch {
      toast("Couldn't save -- the username may be taken or the password too short.", "error");
    }
  }
  async function clearFace() {
    try {
      await del(`/astronauts/${a.id}/face_id`);
      toast(`Face ID cleared for ${a.name}.`, "success");
      refreshAll(qc);
    } catch {
      toast("Couldn't clear Face ID.", "error");
    }
  }
  return (
    <li className="flex flex-col gap-3 rounded-[var(--radius-inner)] bg-raised p-3.5">
      <div className="flex flex-wrap items-center gap-3">
        <Avatar name={a.name} color={a.color} size={40} />
        <div className="min-w-[140px] flex-1">
          <div className="font-semibold">{a.name}</div>
          <div className="text-xs text-muted">{a.card_uid ? <>Card <code className="font-mono">{a.card_uid}</code></> : "No card yet"}</div>
        </div>
        <select className="ah-input min-h-10 w-auto text-label" value={a.role} onChange={(e) => changeRole(e.target.value)} aria-label={`Role for ${a.name}`}>
          {ROLES.map((r) => <option key={r}>{r}</option>)}
        </select>
        <div className="flex flex-wrap gap-1.5">
          <StatusChip level={a.has_password ? "GREEN" : "GRAY"} plain text={a.has_password ? `Password · ${a.username}` : "No password"} />
          <StatusChip level={a.has_face_id ? "GREEN" : "GRAY"} plain text={a.has_face_id ? "Face ID" : "No Face ID"} />
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button className="min-h-9 text-label" onClick={() => setOpen((o) => !o)}>{open ? "Cancel" : a.has_password ? "Reset password" : "Set password"}</Button>
        <Button className="min-h-9 text-label" onClick={clearFace} disabled={!a.has_face_id}>Clear Face ID</Button>
      </div>
      <AnimatePresence initial={false}>
        {open && (
          <motion.form
            onSubmit={savePassword}
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="grid gap-3 overflow-hidden sm:grid-cols-[1fr_1fr_auto] sm:items-end"
          >
            <Field label="Username"><input className="ah-input" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" required /></Field>
            <Field label="New password"><input className="ah-input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" required /></Field>
            <Button variant="primary" type="submit" className="min-h-11">Save</Button>
          </motion.form>
        )}
      </AnimatePresence>
    </li>
  );
}

function Accounts({ astronauts }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState("");
  const [role, setRole] = useState("Crew member");
  async function add(e) {
    e.preventDefault();
    try {
      await post("/astronauts", { name: name.trim(), role });
      toast(`${name.trim()} added. Assign them a card above.`, "success");
      setName("");
      refreshAll(qc);
    } catch {
      toast("Couldn't add that crew member.", "error");
    }
  }
  return (
    <Card className="flex flex-col gap-3">
      <CardTitle eyebrow="Crew accounts" title="People and sign-in" subtitle="Change a role, set a username and password, or clear a stuck Face ID. Passwords are never shown." />
      <form onSubmit={add} className="flex flex-wrap items-end gap-2.5 rounded-2xl border border-dashed border-line-strong p-3">
        <Field label="Add a crew member" className="min-w-[160px] flex-1"><input className="ah-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" required maxLength={60} /></Field>
        <Field label="Role"><select className="ah-input" value={role} onChange={(e) => setRole(e.target.value)}>{ROLES.map((r) => <option key={r}>{r}</option>)}</select></Field>
        <Button variant="primary" type="submit" className="min-h-11"><Icon name="plus" size={16} /> Add</Button>
      </form>
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {astronauts.map((a) => <AccountRow key={a.id} a={a} />)}
      </ul>
    </Card>
  );
}

const ENGINES = [
  ["browser", "Browser voice", "Works offline, using the computer's own voice. Beeps, speed and pitch work; echo and radio don't."],
  ["neural", "Microsoft neural voice", "Natural voice with every station effect. Needs internet; falls back to the browser voice."],
];
const ECHOES = [["off", "Off"], ["light", "Light"], ["medium", "Medium"], ["strong", "Strong"]];
const PITCHES = [["low", "Low"], ["normal", "Normal"], ["high", "High"]];
const FIELDS = ["engine", "voice", "browser_gender", "echo", "radio", "beeps", "hum", "rate", "pitch", "notices"];
const NOTICES = [["speak", "Out loud"], ["show", "Card only"], ["off", "Off"]];
// One click fills the whole form (then Test voice / Save).
const PRESETS = [
  ["Station comms", "The default: calm voice, metal-cabin echo, NASA beeps.",
    { engine: "neural", voice: "en-US-AriaNeural", browser_gender: "female", echo: "medium", radio: false, beeps: true, hum: true, rate: 1, pitch: "normal" }],
  ["Clean", "Just the voice: no echo, no beeps, no hum.",
    { engine: "neural", voice: "en-US-AriaNeural", browser_gender: "female", echo: "off", radio: false, beeps: false, hum: false, rate: 1, pitch: "normal" }],
  ["Ship computer", "Light echo, a little slower.",
    { engine: "neural", voice: "en-US-JennyNeural", browser_gender: "female", echo: "light", radio: false, beeps: true, hum: true, rate: 0.92, pitch: "normal" }],
  ["Mission control radio", "Male voice over a crackly space radio.",
    { engine: "neural", voice: "en-US-GuyNeural", browser_gender: "male", echo: "light", radio: true, beeps: true, hum: false, rate: 1.05, pitch: "normal" }],
  ["Captain", "Deep male voice, light echo.",
    { engine: "neural", voice: "en-US-AndrewNeural", browser_gender: "male", echo: "light", radio: false, beeps: true, hum: true, rate: 0.95, pitch: "low" }],
];
const SAMPLE = "Station health system online. All crew vitals are being monitored.";

function Segment({ label, options, value, onChange, disabled = false, hint }) {
  return (
    <div className={cx("flex flex-col gap-1.5", disabled && "opacity-50")}>
      <span className="text-sm font-semibold">{label}{hint && <span className="ml-2 text-xs font-normal text-muted">{hint}</span>}</span>
      <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-1.5">
        {options.map(([id, text]) => (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={value === id}
            disabled={disabled}
            onClick={() => onChange(id)}
            className={cx("min-h-10 cursor-pointer rounded-xl border px-3.5 text-label font-semibold disabled:cursor-not-allowed",
              value === id ? "border-accent-text/60 bg-accent-soft text-accent-text" : "border-line bg-raised text-ink-2 hover:text-ink")}
          >
            {text}
          </button>
        ))}
      </div>
    </div>
  );
}

function Switch({ label, hint, checked, onChange, disabled = false }) {
  return (
    <label className={cx("flex cursor-pointer items-start gap-3 text-sm", disabled && "cursor-not-allowed opacity-50")}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} className="mt-1 accent-[var(--ah-accent)]" />
      <span><span className="font-semibold">{label}</span><span className="block text-xs text-muted">{hint}</span></span>
    </label>
  );
}

function VoiceSettings() {
  const qc = useQueryClient();
  const toast = useToast();
  const saved = useQuery({ queryKey: ["admin-voice"], queryFn: () => get("/admin/voice-settings") });
  const [edits, setEdits] = useState(null); // unsaved changes; null = show what's saved
  const [testing, setTesting] = useState(false);
  if (!saved.data) return <Shimmer className="h-[640px]" />; // loading
  const form = edits || Object.fromEntries(FIELDS.map((k) => [k, saved.data[k]]));
  const set = (patch) => setEdits({ ...form, ...patch });
  const dirty = FIELDS.some((k) => form[k] !== saved.data[k]);
  const neural = form.engine === "neural";
  const voices = saved.data.voices || [];
  const activePreset = PRESETS.find(([, , p]) => FIELDS.every((k) => k === "notices" || p[k] === form[k]))?.[0];

  async function save() {
    const out = await put("/admin/voice-settings", form);
    qc.setQueryData(["admin-voice"], out);
    setEdits(null);
    qc.invalidateQueries({ queryKey: ["voice-settings"] });
    toast("Station voice saved.", "success");
  }

  async function test() {
    audioCtx(); // unlock sound inside this click
    setTesting(true);
    try {
      if (form.beeps) await quindar("start");
      let played = false;
      if (neural) {
        const res = await fetch("/api/admin/voice-test", {
          method: "POST", credentials: "same-origin",
          headers: { "Content-Type": "application/json" }, body: JSON.stringify(form),
        });
        if (res.ok) { await playNeural(await res.arrayBuffer(), { echo: form.echo, radio: form.radio }); played = true; }
        else toast("The neural voice didn't answer (no internet?) -- this is the browser voice instead.", "warn");
      }
      if (!played && window.speechSynthesis) {
        await new Promise((resolve) => {
          const u = new window.SpeechSynthesisUtterance(SAMPLE);
          const v = pickVoice(window.speechSynthesis.getVoices(), form.browser_gender);
          if (v) { u.voice = v; u.lang = v.lang; }
          u.rate = 1.02 * form.rate;
          u.pitch = { low: 0.85, normal: 1, high: 1.15 }[form.pitch];
          u.onend = resolve;
          u.onerror = resolve;
          window.speechSynthesis.cancel();
          window.speechSynthesis.speak(u);
        });
      }
      if (form.beeps) await quindar("end");
    } finally {
      setTesting(false);
    }
  }

  return (
    <Card className="flex flex-col gap-5">
      <CardTitle eyebrow="Station voice" title="How Astra sounds" subtitle="Used by the crew's chat and voice mode. Changes apply to everyone." className="mb-0" />

      <div className="flex flex-col gap-2">
        <span className="text-sm font-semibold">Presets</span>
        <div className="grid gap-2 sm:grid-cols-2">
          {PRESETS.map(([name, hint, p]) => (
            <button
              key={name}
              type="button"
              aria-pressed={activePreset === name}
              onClick={() => setEdits({ ...p, notices: form.notices })}
              className={cx("flex cursor-pointer flex-col items-start gap-0.5 rounded-xl border p-3 text-left",
                activePreset === name ? "border-accent-text/60 bg-accent-soft" : "border-line bg-raised hover:border-accent-text/40")}
            >
              <span className="text-sm font-semibold">{name}</span>
              <span className="text-xs text-muted">{hint}</span>
            </button>
          ))}
        </div>
      </div>

      <div role="radiogroup" aria-label="Voice engine" className="flex flex-col gap-2">
        {ENGINES.map(([id, label, hint]) => (
          <label key={id} className={cx("flex cursor-pointer gap-3 rounded-xl border p-3.5", form.engine === id ? "border-accent-text/60 bg-accent-soft" : "border-line bg-raised")}>
            <input type="radio" name="engine" value={id} checked={form.engine === id} onChange={() => set({ engine: id })} className="mt-1 accent-[var(--ah-accent)]" />
            <span className="flex flex-col gap-0.5">
              <span className="text-sm font-semibold">{label}</span>
              <span className="text-xs text-muted">{hint}</span>
            </span>
          </label>
        ))}
      </div>

      {neural ? (
        <label className="flex flex-col gap-1.5 text-sm font-semibold">
          Voice
          <select aria-label="Neural voice" className="ah-input min-h-11 bg-control" value={form.voice} onChange={(e) => set({ voice: e.target.value })}>
            <optgroup label="Female">{voices.filter((v) => v.gender === "female").map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}</optgroup>
            <optgroup label="Male">{voices.filter((v) => v.gender === "male").map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}</optgroup>
          </select>
        </label>
      ) : (
        <Segment label="Voice" hint="the best match this computer has" options={[["female", "Female"], ["male", "Male"]]} value={form.browser_gender} onChange={(g) => set({ browser_gender: g })} />
      )}

      <Segment label="Echo" options={ECHOES} value={neural ? form.echo : "off"} onChange={(e) => set({ echo: e })} disabled={!neural} hint={neural ? "" : "needs the neural voice"} />

      <div className="grid gap-3 sm:grid-cols-2">
        <Switch label="Space radio" hint="A narrow, crackly radio sound." checked={neural && form.radio} onChange={(v) => set({ radio: v })} disabled={!neural} />
        <Switch label="NASA beeps" hint="Quindar tones before and after each reply." checked={form.beeps} onChange={(v) => set({ beeps: v })} />
        <Switch label="Cabin hum" hint="A soft hum behind voice mode." checked={form.hum} onChange={(v) => set({ hum: v })} />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <label className="flex flex-col gap-1.5 text-sm font-semibold">
          Speed <span className="text-xs font-normal text-muted">{Math.round(form.rate * 100)}%</span>
          <input type="range" aria-label="Speed" min="0.8" max="1.3" step="0.05" value={form.rate} onChange={(e) => set({ rate: Number(e.target.value) })} className="accent-[var(--ah-accent)]" />
        </label>
        <Segment label="Pitch" options={PITCHES} value={form.pitch} onChange={(p) => set({ pitch: p })} />
      </div>

      <Segment
        label="Astra speaks first"
        hint="health warnings, reminders, messages, check-ins"
        options={NOTICES}
        value={form.notices}
        onChange={(n) => set({ notices: n })}
      />

      <div className="flex flex-wrap gap-2">
        <Button onClick={test} disabled={testing}><Icon name="volume" size={16} />{testing ? "Playing…" : "Test voice"}</Button>
        <Button variant="primary" onClick={save} disabled={!dirty}>Save</Button>
        {dirty && <span className="self-center text-xs text-check-fg">Not saved yet</span>}
      </div>
    </Card>
  );
}

function Console({ username }) {
  const qc = useQueryClient();
  const astronauts = useAdminAstronauts(true);
  const list = astronauts.data || [];
  async function logout() {
    await post("/admin/logout");
    qc.invalidateQueries({ queryKey: ["admin-me"] });
  }
  return (
    <div className="relative min-h-screen p-5 pb-24 max-md:p-4">
      <SpaceBackdrop />
      <div className="mx-auto flex max-w-6xl flex-col gap-[18px]">
        <header className="flex flex-wrap items-center gap-3 px-1">
          <LogoCrew width={40} height={40} aria-hidden="true" />
          <div className="mr-auto">
            <div className="ah-eyebrow">Astro Health · Admin</div>
            <h1 className="m-0 font-display text-display font-bold tracking-tight">Cards & accounts</h1>
          </div>
          <span className="flex min-h-11 items-center gap-2 ah-glass rounded-full px-4 text-label"><Icon name="lock" size={15} className="text-accent-text" />{username}</span>
          <Link to="/" className="flex min-h-11 items-center rounded-full px-4 text-label font-semibold text-ink-2 hover:bg-raised hover:text-ink">Back to app</Link>
          <button onClick={logout} className="flex min-h-11 cursor-pointer items-center gap-2 rounded-full px-4 text-label text-ink-2 hover:bg-raised hover:text-ink"><Icon name="logout" size={16} />Log out</button>
        </header>
        <div className={cx("grid grid-cols-1 items-start gap-[18px] xl:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)]")}>
          <div className="flex min-w-0 flex-col gap-[18px]">
            <UnknownCards astronauts={list} />
            <Registry astronauts={list} />
          </div>
          <div className="flex min-w-0 flex-col gap-[18px]">
            <Accounts astronauts={list} />
            <VoiceSettings />
          </div>
        </div>
        <RecordsBrowser title="Crew records" />
      </div>
    </div>
  );
}

export default function Admin() {
  const me = useQuery({ queryKey: ["admin-me"], queryFn: () => get("/admin/me") });
  if (me.isLoading) return <div className="min-h-screen bg-space" />;
  return me.data?.username ? <Console username={me.data.username} /> : <AdminLogin />;
}
