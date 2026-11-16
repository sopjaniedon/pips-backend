import { describe, expect, it } from "vitest";
import type { FormField } from "@prisma/client";
import { buildSteps } from "./definition.js";

let id = 0;
const f = (code: string, type: FormField["type"], label = code): FormField => ({
  id: ++id, formId: 1, legacyFieldId: null, code, type, label, help: null, info: null, required: false,
  sortOrder: id, options: null, properties: null, sensitivity: "NONE",
});

describe("wizard steps", () => {
  const fields = [f("A", "HEADING", "Personal *"), f("name", "TEXT", "Name *"), f("B", "HEADING"), f("pp", "TEXT"), f("C", "HEADING"), f("cv", "FILE")];
  it("makes one step per heading by default", () => {
    const steps = buildSteps(fields, {});
    expect(steps.map(s => s.title)).toEqual(["Personal", "B", "C"]);
    expect(steps[0].sections[0].fields[0].label).toBe("Name");
  });
  it("groups headings as configured and appends unlisted ones", () => {
    const steps = buildSteps(fields, { steps: [["A", "B"]] });
    expect(steps.map(s => s.sections.map(x => x.code))).toEqual([["A", "B"], ["C"]]);
  });
});
