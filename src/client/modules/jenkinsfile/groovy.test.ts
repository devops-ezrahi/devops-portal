import { describe, expect, it } from "vitest";
import { stageToGroovy, toGroovy } from "./groovy";
import { newPipeline } from "./pipeline";
import type { JenkinsfileStage } from "../../../server/types";

function stage(step: string, args: Record<string, unknown>): JenkinsfileStage {
  return { id: "s-1", step, args };
}

describe("stageToGroovy", () => {
  it("collapses a single short argument onto one line", () => {
    expect(stageToGroovy(stage("sonarStage", { projectKey: "checkout" }))).toBe("sonarStage(projectKey: 'checkout')");
  });

  it("emits no argument list at all when nothing is set", () => {
    expect(stageToGroovy(stage("semVerStage", {}))).toBe("semVerStage()");
  });

  it("keeps catalog order regardless of the order the args were added", () => {
    const code = stageToGroovy(stage("genStage", { commands: ["npm ci"], image: "node20", title: "Build" }));
    expect(code).toBe(["genStage(", "    title: 'Build',", "    image: 'node20',", "    commands: ['npm ci']", ")"].join("\n"));
  });

  it("drops arguments that would render empty", () => {
    const code = stageToGroovy(
      stage("genStage", { title: "Build", image: "node20", commands: ["", "  "], junitTestResults: "  ", envVars: [] })
    );
    expect(code).not.toContain("commands");
    expect(code).not.toContain("junitTestResults");
    expect(code).not.toContain("envVars");
  });

  it("keeps a false boolean — the library treats it as set", () => {
    expect(stageToGroovy(stage("genStage", { title: "T", image: "i", skipStage: false }))).toContain("skipStage: false");
  });

  it("renders integers bare", () => {
    expect(stageToGroovy(stage("genStage", { title: "T", image: "i", requestStorage: "20" }))).toContain(
      "requestStorage: 20"
    );
  });

  it("keeps an interpolated string a GString, and single-quotes everything else", () => {
    const code = stageToGroovy(stage("genStage", { title: "Build ${env.SERVICE}", image: "node20" }));
    expect(code).toContain(`title: "Build \${env.SERVICE}"`);
    expect(code).toContain("image: 'node20'");
  });

  it("escapes a quote inside a single-quoted string", () => {
    const code = stageToGroovy(stage("AIStage", { prompt: "don't fail" }));
    expect(code).toBe("AIStage(prompt: 'don\\'t fail')");
  });

  it("keeps a short list inline", () => {
    const code = stageToGroovy(stage("genStage", { title: "Build", image: "node20", commands: ["npm ci", "npm run build"] }));
    expect(code).toContain("commands: ['npm ci', 'npm run build']");
  });

  it("breaks a list that would run long one entry per line", () => {
    const code = stageToGroovy(
      stage("genStage", {
        title: "Build",
        image: "node20",
        commands: ["npm ci --registry https://artifactory.example.com/api/npm/npm-remote", "npm run build -- --mode production"],
      })
    );
    expect(code).toContain(
      [
        "    commands: [",
        "        'npm ci --registry https://artifactory.example.com/api/npm/npm-remote',",
        "        'npm run build -- --mode production'",
        "    ]",
      ].join("\n")
    );
  });

  it("renders a map with bare keys and quotes the ones that are not identifiers", () => {
    const code = stageToGroovy(
      stage("genStage", { title: "T", image: "i", envVars: [["FOO", "bar"], ["a-b", "c"], ["", "dropped"]] })
    );
    expect(code).toContain("envVars: [FOO: 'bar', 'a-b': 'c']");
  });

  it("accepts a map that came back from the server as an object", () => {
    const code = stageToGroovy(stage("genStage", { title: "T", image: "i", stash: { dist: "dist/**" } }));
    expect(code).toContain("stash: [dist: 'dist/**']");
  });

  it("renders a list of maps, skipping blank entries", () => {
    const code = stageToGroovy(
      stage("genStage", {
        title: "T",
        image: "i",
        secrets: [
          { path: "secret/team", key: "token", variableName: "TOKEN" },
          { path: "", key: "", variableName: "" },
        ],
      })
    );
    expect(code).toContain("secrets: [[path: 'secret/team', key: 'token', variableName: 'TOKEN']]");
  });

  it("ignores keys the step does not accept", () => {
    expect(stageToGroovy(stage("semVerStage", { nonsense: "x" }))).toBe("semVerStage()");
  });
});

describe("toGroovy", () => {
  it("writes the library line and nothing else for an empty pipeline", () => {
    expect(toGroovy(newPipeline())).toBe("@Library('jenkins-k8s-shared-library') _\n");
  });

  it("honours a pinned library version", () => {
    expect(toGroovy({ ...newPipeline(), library: "jenkins-k8s-shared-library@dev-v2" })).toContain(
      "@Library('jenkins-k8s-shared-library@dev-v2') _"
    );
  });

  it("emits populateEnvVars ahead of the stages, and skips it when there are none", () => {
    const stages = [stage("semVerStage", {})];
    expect(toGroovy({ ...newPipeline(), stages })).toBe(
      "@Library('jenkins-k8s-shared-library') _\n\nsemVerStage()\n"
    );
    expect(toGroovy({ ...newPipeline(), envVars: [["SERVICE", "checkout"]], stages })).toBe(
      [
        "@Library('jenkins-k8s-shared-library') _",
        "",
        "populateEnvVars([",
        "    SERVICE: 'checkout'",
        "])",
        "",
        "semVerStage()",
        "",
      ].join("\n")
    );
  });

  it("keeps stage order", () => {
    const code = toGroovy({
      ...newPipeline(),
      stages: [
        { id: "a", step: "semVerStage", args: {} },
        { id: "b", step: "sonarStage", args: {} },
      ],
    });
    expect(code.indexOf("semVerStage")).toBeLessThan(code.indexOf("sonarStage"));
  });
});
