// Every text colour must stay readable (WCAG AA, 4.5:1) on the lightest surface a card or
// tile can have, in both palettes (crew and doctor). Reads the real tokens from index.css,
// so lowering a colour there fails this test.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("./index.css", import.meta.url), "utf8");

// Each palette block declares --ah-bg first; split on that to get one block per palette.
const palettes = css.split(/(?=--ah-bg:\s*#)/).slice(1).map((block) => {
  const get = (name) => (block.match(new RegExp(`--ah-${name}:\\s*(#[0-9a-fA-F]{6})`)) || [])[1];
  return { bg: get("surface-3"), text: get("text"), text2: get("text-2"), muted: get("text-muted"), subtle: get("text-subtle") };
});

function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const ratio = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

describe("text contrast", () => {
  it("finds both palettes", () => {
    expect(palettes.length).toBeGreaterThanOrEqual(2);
  });
  palettes.forEach((p, i) => {
    for (const key of ["text", "text2", "muted", "subtle"]) {
      it(`palette ${i + 1}: ${key} is at least 4.5:1 on the lightest surface`, () => {
        expect(p[key]).toBeTruthy();
        expect(ratio(p[key], p.bg)).toBeGreaterThanOrEqual(4.5);
      });
    }
  });
});
