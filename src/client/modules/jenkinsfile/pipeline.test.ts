import { describe, expect, it } from "vitest";
import { STEPS, stepSpec } from "./catalog";
import {
  closureOf,
  createStage,
  hasErrors,
  isEmptyArg,
  moveStage,
  newPipeline,
  toDraft,
  toInput,
  validatePipeline,
  type DraftPipeline,
} from "./pipeline";
import type { JenkinsfileParam, JenkinsfilePipeline, JenkinsfileStage } from "../../../server/types";

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

  it("reads a commands argument as unset whether it is an empty list or an empty closure", () => {
    expect(isEmptyArg("commands", [])).toBe(true);
    expect(isEmptyArg("commands", ["", " "])).toBe(true);
    expect(isEmptyArg("commands", { closure: "  \n" })).toBe(true);
    expect(isEmptyArg("commands", ["npm ci"])).toBe(false);
    expect(isEmptyArg("commands", { closure: "sh 'x'" })).toBe(false);
  });

  it("tells a closure from a shell list", () => {
    expect(closureOf(["npm ci"])).toBeNull();
    expect(closureOf(undefined)).toBeNull();
    expect(closureOf({ closure: "sh 'x'" })).toBe("sh 'x'");
  });

  it("reads a legacy boolean skip condition as set only when it is true", () => {
    expect(isEmptyArg("expression", "")).toBe(true);
    expect(isEmptyArg("expression", "params.skipImage")).toBe(false);
    expect(isEmptyArg("expression", true)).toBe(false);
    expect(isEmptyArg("expression", false)).toBe(true);
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
    // A gen stage also needs commands, so every case here carries them.
    const gen = (args: Record<string, unknown>) =>
      validatePipeline(withStage({ id: "s", step: "genStage", args: { commands: ["npm ci"], ...args } }));

    expect(gen({ title: "T" }).stages.s).toContain("Set exactly one of image or node.");
    expect(gen({ title: "T", image: "i", node: "n" }).stages.s).toContain("Set image or node, not both.");
    expect(gen({ title: "T", node: "windows" }).stages.s).toBeUndefined();
  });

  it("requires a title only where the step does not name one itself", () => {
    const gen = validatePipeline(withStage({ id: "s", step: "genStage", args: { image: "i", commands: ["x"] } }));
    expect(gen.stages.s).toContain("title is required.");

    // Every wrapper assigns `args.title = args.title ?: '…'` before validating.
    const sonar = validatePipeline(withStage({ id: "s", step: "sonarStage", args: {} }));
    expect(sonar.stages.s ?? []).not.toContain("title is required.");
  });

  it("requires commands on a gen stage — that is what the stage is", () => {
    const errors = validatePipeline(withStage({ id: "s", step: "genStage", args: { title: "T", image: "i" } }));
    expect(errors.stages.s).toContain("commands is required.");

    // A step that runs its own work takes none.
    expect(hasErrors(validatePipeline(withStage({ id: "s", step: "semVerStage", args: {} })))).toBe(false);
  });

  it("catches a node set on a step that already brings its own image", () => {
    const errors = validatePipeline(withStage({ id: "s", step: "sonarStage", args: { node: "linux" } }));
    expect(errors.stages.s?.[0]).toContain("already runs on image sonar");
  });

  it("leaves genStageWindows alone — the step forces node itself", () => {
    const stage = { id: "s", step: "genStageWindows", args: { title: "T", commands: ["dir"] } };
    expect(hasErrors(validatePipeline(withStage(stage)))).toBe(false);
  });

  it("holds populateEnvVars to neither a title nor a runtime — it is a call, not a stage", () => {
    const stage = { id: "s", step: "populateEnvVars", args: { envVars: [["SERVICE", "x"]] } };
    expect(hasErrors(validatePipeline(withStage(stage)))).toBe(false);
    // …but an empty one writes nothing, so it is not finished either.
    expect(validatePipeline(withStage({ id: "s", step: "populateEnvVars", args: {} })).stages.s).toContain(
      "envVars is required."
    );
  });

  it("rejects a parameter name Groovy cannot address, and a duplicate", () => {
    const params: JenkinsfileParam[] = [
      { name: "skip-image", type: "boolean", defaultValue: "false", description: "" },
      { name: "skipSonar", type: "string", defaultValue: "", description: "" },
      { name: "skipSonar", type: "boolean", defaultValue: "true", description: "" },
    ];
    const errors = validatePipeline({ ...newPipeline(), params, stages }).pipeline;
    expect(errors).toContain("Parameter skip-image is not a valid Groovy identifier.");
    expect(errors).toContain("Parameter skipSonar is declared twice.");
  });

  it("requires every key of an object-list entry that has been started", () => {
    const errors = validatePipeline(
      withStage({
        id: "s",
        step: "genStage",
        args: { title: "T", image: "i", commands: ["x"], secrets: [{ path: "secret/x" }] },
      })
    );
    expect(errors.stages.s).toEqual(expect.arrayContaining(["secrets #1 needs key.", "secrets #1 needs variableName."]));
  });
});

describe("catalog", () => {
  it("gives every step the common genStage arguments", () => {
    for (const step of STEPS.filter((s) => s.callStyle !== "bare")) {
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

describe("toDraft / toInput", () => {
  const stored: JenkinsfilePipeline = {
    id: "JF-0001",
    name: "build",
    library: "jenkins-k8s-shared-library",
    envVars: { SERVICE: "checkout" },
    stages: [{ id: "a", step: "semVerStage", args: {} }],
    createdBy: "u",
    createdByName: "U",
    createdAt: "",
    updatedAt: "",
  };

  it("migrates a legacy pipeline-level envVars map into a leading stage", () => {
    const draft = toDraft(stored);
    expect(draft.stages.map((s) => s.step)).toEqual(["populateEnvVars", "semVerStage"]);
    expect(draft.stages[0].args.envVars).toEqual([["SERVICE", "checkout"]]);
    expect("envVars" in draft).toBe(false);
  });

  it("writes the legacy map back empty, so the migration only ever runs once", () => {
    expect(toInput(toDraft(stored))).toMatchObject({ envVars: {} });
  });

  it("trims parameter names and drops the unnamed ones", () => {
    const draft: DraftPipeline = {
      ...newPipeline(),
      params: [
        { name: " skipImage ", type: "boolean", defaultValue: "true", description: "x" },
        { name: "  ", type: "boolean", defaultValue: "false", description: "" },
      ],
    };
    expect(toInput(draft).params).toEqual([
      { name: "skipImage", type: "boolean", defaultValue: "true", description: "x" },
    ]);
  });

  it("sends a blank name for an unnamed pipeline, so the server mints one", () => {
    expect(toInput(newPipeline()).name).toBe("");
    expect(toInput({ ...newPipeline(), name: "  Checkout release  " }).name).toBe("Checkout release");
  });

  it("normalises a parameter stored before the other types existed", () => {
    // Deliberately the pre-`type` shape, which is what is actually on disk.
    const legacy = { ...stored, params: [{ name: "skipImage", defaultValue: true, description: "x" }] };
    expect(toDraft(legacy as unknown as JenkinsfilePipeline).params).toEqual([
      { name: "skipImage", type: "boolean", defaultValue: "true", description: "x" },
    ]);
  });
});

describe("createStage", () => {
  it("mints a unique id per stage", () => {
    const made = Array.from({ length: 50 }, () => createStage("genStage").id);
    expect(new Set(made).size).toBe(50);
  });
});
