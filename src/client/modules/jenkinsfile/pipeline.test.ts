import { describe, expect, it } from "vitest";
import { STEPS, stepSpec } from "./catalog";
import { createStage, hasErrors, isEmptyArg, moveStage, newPipeline, toInput, validatePipeline } from "./pipeline";
import type { JenkinsfileStage } from "../../../server/types";

const stages: JenkinsfileStage[] = ["a", "b", "c"].map((id) => ({ id, step: "semVerStage", args: {} }));
const ids = (list: JenkinsfileStage[]) => list.map((s) => s.id).join("");

describe("moveStage", () => {
  it("moves a card down and up", () => {
    expect(ids(moveStage(stages, 0, 2))).toBe("bca");
    expect(ids(moveStage(stages, 2, 0))).toBe("cab");
  });

  it("returns the same array when nothing moves", () => {
    expect(moveStage(stages, 1, 1)).toBe(stages);
    expect(moveStage(stages, 5, 0)).toBe(stages);
  });

  it("clamps a drop past the end instead of losing the card", () => {
    expect(ids(moveStage(stages, 0, 99))).toBe("bca");
    expect(ids(moveStage(stages, 2, -3))).toBe("cab");
  });
});

describe("isEmptyArg", () => {
  it("treats blanks and all-blank collections as unset", () => {
    expect(isEmptyArg("string", "  ")).toBe(true);
    expect(isEmptyArg("integer", "")).toBe(true);
    expect(isEmptyArg("stringList", ["", " "])).toBe(true);
    expect(isEmptyArg("stringMap", [["", "x"]])).toBe(true);
    expect(isEmptyArg("objectList", [{ path: "", key: "" }])).toBe(true);
  });

  it("never treats a boolean as unset", () => {
    expect(isEmptyArg("boolean", false)).toBe(false);
    expect(isEmptyArg("boolean", true)).toBe(false);
  });
});

describe("validatePipeline", () => {
  const withStage = (stage: JenkinsfileStage) => ({ ...newPipeline(), stages: [stage] });

  it("wants at least one stage", () => {
    expect(validatePipeline(newPipeline()).pipeline).toContain("A pipeline needs at least one stage.");
  });

  it("requires a title on a step that does not default one", () => {
    const errors = validatePipeline(withStage({ id: "s", step: "genStage", args: { image: "node20" } }));
    expect(errors.stages.s).toContain("title is required.");
  });

  it("accepts a step that fills in its own title and image", () => {
    expect(hasErrors(validatePipeline(withStage({ id: "s", step: "semVerStage", args: {} })))).toBe(false);
  });

  it("insists on exactly one of image and node", () => {
    const neither = validatePipeline(withStage({ id: "s", step: "genStage", args: { title: "T" } }));
    expect(neither.stages.s).toContain("Set exactly one of image or node.");

    const both = validatePipeline(withStage({ id: "s", step: "genStage", args: { title: "T", image: "i", node: "n" } }));
    expect(both.stages.s).toContain("Set image or node, not both.");

    const one = validatePipeline(withStage({ id: "s", step: "genStage", args: { title: "T", node: "windows" } }));
    expect(one.stages.s).toBeUndefined();
  });

  it("catches a node set on a step that already brings its own image", () => {
    const errors = validatePipeline(withStage({ id: "s", step: "sonarStage", args: { node: "linux" } }));
    expect(errors.stages.s?.[0]).toContain("already runs on image sonar");
  });

  it("leaves genStageWindows alone — the step forces node itself", () => {
    expect(hasErrors(validatePipeline(withStage({ id: "s", step: "genStageWindows", args: { title: "T" } })))).toBe(false);
  });

  it("requires every key of an object-list entry that has been started", () => {
    const errors = validatePipeline(
      withStage({ id: "s", step: "genStage", args: { title: "T", image: "i", secrets: [{ path: "secret/x" }] } })
    );
    expect(errors.stages.s).toEqual(expect.arrayContaining(["secrets #1 needs key.", "secrets #1 needs variableName."]));
  });
});

describe("catalog", () => {
  it("gives every step the common genStage arguments", () => {
    for (const step of STEPS) {
      const names = step.args.map((a) => a.name);
      expect(names).toContain("title");
      expect(names).toContain("commands");
      expect(new Set(names).size).toBe(names.length);
    }
  });

  it("drops the pod-only arguments from the Windows step", () => {
    const names = stepSpec("genStageWindows")!.args.map((a) => a.name);
    expect(names).not.toContain("image");
    expect(names).not.toContain("customPVC");
  });
});

describe("toInput", () => {
  it("turns the edited pairs back into the object the server stores", () => {
    const draft = { ...newPipeline(), name: " build ", envVars: [["SERVICE", "checkout"], ["", "ignored"]] as [string, string][] };
    expect(toInput(draft)).toMatchObject({ name: "build", envVars: { SERVICE: "checkout" } });
  });
});

describe("createStage", () => {
  it("mints a unique id per stage", () => {
    const made = Array.from({ length: 50 }, () => createStage("genStage").id);
    expect(new Set(made).size).toBe(50);
  });
});
