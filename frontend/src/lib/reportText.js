// Turns the backend's automatic crew-report strings into readable sentences, at display
// time (so reports already stored read well too). Unknown text passes through unchanged.
const tidy = (s) => s.replace(/_/g, " ").replace(/\s+/g, " ").trim();

export function reportText(body) {
  if (body == null) return body;
  let m = /^RED assessment:\s*(?:RED:\s*)?(.*)$/i.exec(body);
  if (m) return `Red result in an assessment: ${tidy(m[1]) || "overall check"}.`;
  m = /^RED symptoms reported:\s*(.*)$/i.exec(body);
  if (m) return `Reported red-flag symptoms: ${tidy(m[1])}.`;
  m = /^Danger \(discomfort\):\s*(.*)$/i.exec(body);
  if (m) return `Reported severe discomfort: ${tidy(m[1])}.`;
  m = /^EMERGENCY:\s*(.*)$/i.exec(body);
  if (m) return `EMERGENCY: ${m[1]}`;
  return body;
}
