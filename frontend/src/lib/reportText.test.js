import { describe, expect, it } from "vitest";
import { reportText } from "./reportText.js";

describe("reportText", () => {
  it("rewrites the automatic report formats", () => {
    expect(reportText("RED assessment: RED: temperature, symptoms")).toBe("Red result in an assessment: temperature, symptoms.");
    expect(reportText("RED symptoms reported: shortness_of_breath, chest_pain")).toBe("Reported red-flag symptoms: shortness of breath, chest pain.");
    expect(reportText("Danger (discomfort): skeleton")).toBe("Reported severe discomfort: skeleton.");
  });
  it("leaves free text alone", () => {
    expect(reportText("Please tell the doctor my back hurts")).toBe("Please tell the doctor my back hurts");
    expect(reportText(null)).toBeNull();
  });
});
