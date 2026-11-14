import { describe, expect, it } from "vitest";
import { distance, dropOutliers, GUIDANCE, meanDescriptor, tooSimilar, yawOf } from "./faceId.js";

const vec = (f) => Array.from({ length: 128 }, (_, i) => f(i));
const base = vec((i) => Math.sin(i) * 0.1);
const near = (k) => base.map((x, i) => x + Math.cos(i * k) * 0.02);

describe("Face ID helpers", () => {
  it("measures distance and averages descriptors", () => {
    expect(distance(base, base)).toBe(0);
    expect(distance(vec(() => 0), vec(() => 0.1))).toBeCloseTo(Math.sqrt(128 * 0.01), 6);
    expect(meanDescriptor([vec(() => 0), vec(() => 1)])[5]).toBe(0.5);
  });
  it("drops an odd-one-out sample but keeps a consistent set", () => {
    const set = [near(1), near(2), near(3), near(4)];
    expect(dropOutliers(set)).toHaveLength(4);
    const stranger = vec((i) => Math.cos(i) * 0.15);
    expect(dropOutliers([...set, stranger])).toHaveLength(4);
  });
  it("skips frames nearly identical to one already kept", () => {
    expect(tooSimilar(base, [base])).toBe(true);
    expect(tooSimilar(near(1), [near(5)])).toBe(false);
  });
  it("tells a straight face from a turned one", () => {
    const pts = Array.from({ length: 68 }, () => ({ x: 0, y: 0 }));
    for (let i = 36; i <= 41; i++) pts[i] = { x: 40, y: 50 };
    for (let i = 42; i <= 47; i++) pts[i] = { x: 80, y: 50 };
    pts[30] = { x: 60, y: 80 };
    expect(Math.abs(yawOf(pts))).toBeLessThan(0.05);
    pts[30] = { x: 80, y: 80 };
    expect(yawOf(pts)).toBeGreaterThan(0.3);
  });
  it("has a guidance line for every reason", () => {
    for (const r of ["ok", "dark", "none", "many", "far", "turned", "moving"]) expect(GUIDANCE[r]).toBeTruthy();
  });
});
