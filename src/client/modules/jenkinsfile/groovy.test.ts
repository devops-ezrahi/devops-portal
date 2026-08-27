import { describe, expect, it } from "vitest";
import { stageToGroovy, toGroovy } from "./groovy";
import { newPipeline } from "./pipeline";
import type { JenkinsfileParam, JenkinsfileStage } from "../../../server/types";

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

  it("writes a skip condition raw, so it stays a Groovy expression", () => {
    const code = stageToGroovy(stage("genStage", { title: "T", image: "i", skipStage: "params.skipImage" }));
    expect(code).toContain("skipStage: params.skipImage");
    // A record written before the field became an expression still holds a boolean.
    expect(stageToGroovy(stage("genStage", { title: "T", image: "i", skipStage: true }))).toContain("skipStage: true");
    // …and `false` there meant "not set", so it drops out rather than pinning the stage on.
    expect(stageToGroovy(stage("genStage", { title: "T", image: "i", skipStage: false }))).not.toContain("skipStage");
  });

  it("writes commands as a shell list or as a closure, whichever the stage holds", () => {
    const shell = stageToGroovy(stage("genStage", { title: "T", image: "i", commands: ["npm ci", "npm test"] }));
    expect(shell).toContain("commands: ['npm ci', 'npm test']");

    const closure = stageToGroovy(
      stage("genStage", {
        title: "T",
        image: "i",
        commands: { closure: "\nsh 'npm ci'\njunit '**/*.xml'\n" },
      })
    );
    expect(closure).toContain(
      ["    commands: {", "        sh 'npm ci'", "        junit '**/*.xml'", "    }"].join("\n")
    );
    // Nothing is quoted or escaped — it is Groovy, not a value.
    expect(closure).not.toContain("\\'");
  });

  it("drops an empty closure the same way it drops an empty list", () => {
    expect(stageToGroovy(stage("genStage", { title: "T", image: "i", commands: { closure: "  \n " } }))).not.toContain(
      "commands"
    );
  });

  it("keeps a false boolean — the library treats it as set", () => {
    expect(stageToGroovy(stage("genStage", { title: "T", image: "i", unshallow: false }))).toContain("unshallow: false");
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
  it("writes nothing at all for an empty pipeline — the import is optional", () => {
    expect(toGroovy(newPipeline())).toBe("");
  });

  it("writes the import only once one has been asked for, branch and all", () => {
    expect(toGroovy({ ...newPipeline(), library: "jenkins-k8s-shared-library" })).toBe(
      "@Library('jenkins-k8s-shared-library') _\n"
    );
    expect(toGroovy({ ...newPipeline(), library: "jenkins-k8s-shared-library@dev-v2" })).toContain(
      "@Library('jenkins-k8s-shared-library@dev-v2') _"
    );
  });

  it("takes the quotes and commas off a list pasted out of an existing Jenkinsfile", () => {
    const pasted = ['"npm install",', "'npm run dev',", '  "npm test"  '];
    expect(stageToGroovy(stage("genStage", { title: "T", image: "i", commands: pasted }))).toContain(
      "commands: ['npm install', 'npm run dev', 'npm test']"
    );
  });

  it("leaves a line whose quotes are part of the command alone", () => {
    const commands = ['echo "hello"', '"$A" = "$B"', "\"unbalanced"];
    const code = stageToGroovy(stage("genStage", { title: "T", image: "i", commands }));
    expect(code).toContain(`'echo "hello"'`);
    expect(code).toContain(`'"$A" = "$B"'`);
    expect(code).toContain(`'"unbalanced'`);
  });

  it("calls populateEnvVars with its map bare, not under an envVars key", () => {
    const stages = [stage("semVerStage", {})];
    expect(toGroovy({ ...newPipeline(), stages })).toBe("semVerStage()\n");
    expect(
      toGroovy({
        ...newPipeline(),
        library: "jenkins-k8s-shared-library",
        stages: [{ id: "e", step: "populateEnvVars", args: { envVars: [["SERVICE", "checkout"]] } }, ...stages],
      })
    ).toBe(
      [
        "@Library('jenkins-k8s-shared-library') _",
        "",
        "populateEnvVars([SERVICE: 'checkout'])",
        "",
        "semVerStage()",
        "",
      ].join("\n")
    );
  });

  it("declares parameters in a properties block before the stages", () => {
    const code = toGroovy({
      ...newPipeline(),
      params: [{ name: "skipImage", type: "boolean", defaultValue: "false", description: "Skip the image build" }],
      stages: [stage("semVerStage", {})],
    });
    expect(code).toContain(
      [
        "properties([",
        "    parameters([",
        "        booleanParam(name: 'skipImage', defaultValue: false, description: 'Skip the image build')",
        "    ])",
        "])",
      ].join("\n")
    );
    expect(code.indexOf("properties([")).toBeLessThan(code.indexOf("semVerStage"));
  });

  it("drops a parameter with no name, and the whole block when none are named", () => {
    const params = [{ name: "  ", type: "boolean" as const, defaultValue: "true", description: "" }];
    expect(toGroovy({ ...newPipeline(), params })).not.toContain("properties([");
  });

  it("writes each parameter type with the function Jenkins names it by", () => {
    const lines = (params: JenkinsfileParam[]) => toGroovy({ ...newPipeline(), params });

    expect(lines([{ name: "tag", type: "string", defaultValue: "latest", description: "Image tag" }])).toContain(
      "string(name: 'tag', defaultValue: 'latest', description: 'Image tag')"
    );
    // A choice takes its options, not a default — Jenkins uses the first.
    expect(
      lines([{ name: "env", type: "choice", defaultValue: "", description: "Target", choices: ["dev", " ", "prod"] }])
    ).toContain("choice(name: 'env', choices: ['dev', 'prod'], description: 'Target')");
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
