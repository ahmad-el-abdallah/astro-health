// Talking over Astra ("barge-in"). While she speaks, the voice screen keeps listening; the
// question is whether what it hears is YOU (stop her and listen) or HER OWN VOICE leaking from
// the speakers into the microphone (ignore it). Her words are known (the reply text), so:
// words she's saying don't count; two or more new words -- or a short "stop"/"wait" -- do.
// Headphones make this most reliable.

const norm = (t) => String(t || "").toLowerCase().replace(/[^a-z0-9' ]+/g, " ").split(/\s+/).filter(Boolean);

const STOP_WORDS = /^(stop|wait|hold on|hang on|pause|quiet|shh+|enough|hey|astra|hey astra|one sec(ond)?)$/;

/** Just "stop"/"wait"/"hold on"…: stop her, but there's no question to send. */
export function isStopCommand(text) {
  return STOP_WORDS.test(norm(text).join(" "));
}

function newWords(text, replyText) {
  const said = new Set(norm(replyText));
  return norm(text).filter((w) => w.length > 1 && !said.has(w));
}

/** Should what the mic is hearing (so far) stop her? minNew: how many words she isn't saying
 *  it takes (2; 3 in a noisy room, lib/hearing.js). */
export function isBargeIn(text, replyText, minNew = 2) {
  if (isStopCommand(text)) return true;
  const words = norm(text);
  const fresh = newWords(text, replyText);
  return fresh.length >= minNew || (words.length >= minNew + 1 && fresh.length / words.length >= 0.5);
}

/** A final phrase that is really just her own voice picked up by the mic. */
export function isEcho(text, replyText) {
  if (!replyText) return false;
  const words = norm(text);
  if (!words.length) return true;
  const fresh = newWords(text, replyText).length;
  // All her words, or a long run of them with one misheard word. A short "yes"/"no" is never
  // echo -- that's you answering her question.
  return !isBargeIn(text, replyText) && (fresh === 0 || (words.length >= 4 && fresh <= 1));
}

/** The part of `text` she had actually said, cut back to a whole word. */
export function spokenPart(text, chars) {
  const t = String(text || "");
  if (chars >= t.length) return t;
  if (chars <= 0) return "";
  const cut = t.slice(0, chars);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trim();
}
