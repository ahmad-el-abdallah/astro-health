// Crew · Learn (AstroHealth-Redesign crew-07; port of static/js/tabs/learn.js): the basics
// as numbered cards, the five hazards of spaceflight with icons, and the body-systems
// section (kept from the old tab -- the mockup's reference screenshot was cut off before it).
import { motion } from "motion/react";
import { useContent } from "../../lib/queries.js";
import { Card, StatusChip } from "../../components/ui/index.jsx";
import { Icon } from "../../components/ui/Icon.jsx";

const HAZARD_ICON = { space_radiation: "hazard-radiation", isolation_confinement: "hazard-isolation", distance_from_earth: "hazard-distance", gravity_fields: "hazard-gravity", hostile_environment: "hazard-environment" };
const grid = { initial: {}, animate: { transition: { staggerChildren: 0.05 } } };

function Section({ title, children }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="m-0 px-1 font-display text-xl font-semibold">{title}</h2>
      {children}
    </section>
  );
}

export default function Learn() {
  const content = useContent();
  const c = content.data;
  if (!c) return null;
  return (
    <>
      <Section title="The basics">
        <motion.div variants={grid} className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(250px,1fr))]">
          {c.learn_cards.map((card, i) => (
            <Card key={card.title} hover className="flex flex-col gap-2.5">
              <span className="font-mono text-xs text-accent-text">{String(i + 1).padStart(2, "0")}</span>
              <h3 className="m-0 text-base font-semibold">{/green, yellow, red/i.test(card.title) ? "Green, yellow, red" : card.title}</h3>
              {/green, yellow, red/i.test(card.title) ? (
                <div className="flex flex-col gap-2 text-[13px] text-ink-2">
                  <span className="flex items-center gap-2"><StatusChip level="GREEN" /> Normal.</span>
                  <span className="flex items-center gap-2"><StatusChip level="YELLOW" /> Pay attention and take the suggested action.</span>
                  <span className="flex items-center gap-2"><StatusChip level="RED" /> Act now — the flight surgeon is alerted.</span>
                </div>
              ) : (
                <p className="m-0 text-sm text-ink-2">{card.body}</p>
              )}
              {i === 0 && <a href="#hazards" className="mt-auto text-sm font-semibold">See the five hazards →</a>}
            </Card>
          ))}
        </motion.div>
      </Section>

      <Section title={<span id="hazards">The five hazards of spaceflight</span>}>
        <motion.div variants={grid} className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(250px,1fr))]">
          {Object.entries(c.hazards).map(([id, h]) => (
            <Card key={id} hover className="flex flex-col gap-3">
              <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-accent-soft text-accent-text"><Icon name={HAZARD_ICON[id]} size={22} /></span>
              <h3 className="m-0 text-base font-semibold">{h.label}</h3>
              <p className="m-0 text-sm text-ink-2">{h.summary}</p>
            </Card>
          ))}
        </motion.div>
      </Section>

      <Section title="Body systems">
        <motion.div variants={grid} className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(280px,1fr))]">
          {Object.entries(c.body_parts).map(([id, b]) => (
            <Card key={id} hover className="flex flex-col gap-2">
              <h3 className="m-0 text-base font-semibold">{b.label}</h3>
              <p className="m-0 text-sm text-ink-2">{b.what_it_does}</p>
              <p className="m-0 text-[13px] text-muted"><strong className="text-ink-2">In space:</strong> {b.space_effects}</p>
              <p className="m-0 text-[13px] text-muted"><strong className="text-ink-2">What to do:</strong> {b.what_to_do}</p>
            </Card>
          ))}
        </motion.div>
      </Section>
    </>
  );
}
