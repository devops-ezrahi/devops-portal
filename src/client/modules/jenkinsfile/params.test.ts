import { describe, expect, it } from "vitest";
import { usedParamNames } from "./params";
import { createStage } from "./pipeline";
import type { JenkinsfileStage } from "../../../server/types";

function stage(args: Record<string, unknown>): JenkinsfileStage {
  return { ...createStage("genStage"), args };
}

describe("usedParamNames", () => {
  it("finds a reference in a skip expression, which is the whole point of a parameter", () => {
    expect(usedParamNames([stage({ skipStage: "params.skipImage" })])).toEqual(new Set(["skipImage"]));
  });

  it("reaches into nested argument shapes, not just top-level strings", () => {
    const used = usedParamNames([
      stage({ commands: ["echo ${params.branch}"] }),
      stage({ envVars: [["TAG", "params.tag"]] }),
      stage({ commands: { closure: "if (params.deploy) { sh 'x' }" } }),
    ]);
    expect(used).toEqual(new Set(["branch", "tag", "deploy"]));
  });

  it("takes the bracket form in either quote, since JSON escapes the double one", () => {
    expect(usedParamNames([stage({ skipStage: "params['a'] || params[\"b\"]" })])).toEqual(
      new Set(["a", "b"])
    );
  });

  it("is empty when nothing reads a parameter", () => {
    expect(usedParamNames([stage({ title: "Build", image: "node:20" })])).toEqual(new Set());
  });
});
