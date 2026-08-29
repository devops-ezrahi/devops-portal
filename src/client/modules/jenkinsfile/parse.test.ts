import { describe, expect, it } from "vitest";
import { parseJenkinsfile, readValue, stripComments } from "./parse";
import { toGroovy } from "./groovy";
import { createStage, newPipeline } from "./pipeline";
import { newParam } from "./params";

describe("stripComments", () => {
  it("drops line and block comments", () => {
    expect(stripComments("a // gone\nb /* also\ngone */ c").replace(/\s+/g, " ")).toBe("a b c");
  });

  it("leaves a // that is inside a string alone", () => {
    expect(stripComments("genStage(title: 'https://example.com')")).toBe("genStage(title: 'https://example.com')");
  });
});

describe("readValue", () => {
  it("reads the literals the generator emits", () => {
    expect(readValue("'hi'")).toEqual({ t: "str", v: "hi" });
    expect(readValue('"Build ${env.SERVICE}"')).toEqual({ t: "str", v: "Build ${env.SERVICE}" });
    expect(readValue("true")).toEqual({ t: "bool", v: true });
    expect(readValue("12")).toEqual({ t: "num", v: 12 });
    expect(readValue("params.skipImage")).toEqual({ t: "expr", v: "params.skipImage" });
  });

  it("tells a map from a list, and an empty one from the other", () => {
    expect(readValue("['a', 'b']")).toEqual({ t: "list", v: [{ t: "str", v: "a" }, { t: "str", v: "b" }] });
    expect(readValue("[JDK: '17']")).toEqual({ t: "map", v: [["JDK", { t: "str", v: "17" }]] });
    expect(readValue("[:]")).toEqual({ t: "map", v: [] });
    expect(readValue("[]")).toEqual({ t: "list", v: [] });
  });

  it("does not split on a comma inside a nested value or a string", () => {
    const value = readValue("[[secret: 'a,b', token: 't'], [secret: 'c']]");
    expect(value.t).toBe("list");
    expect(value.t === "list" && value.v.length).toBe(2);
  });

  it("keeps a closure body verbatim", () => {
    expect(readValue("{\n  sh 'a && b'\n}")).toEqual({ t: "closure", v: "\n  sh 'a && b'\n" });
  });
});

describe("parseJenkinsfile", () => {
  it("round-trips what the generator writes", () => {
    const original = {
      ...newPipeline(),
      library: "jenkins-k8s-shared-library@main",
      params: [
        { ...newParam(), name: "skipImage", type: "boolean" as const, defaultValue: "true", description: "Skip it" },
        { ...newParam(), name: "target", type: "choice" as const, choices: ["dev", "prod"], description: "Where" },
        { ...newParam(), name: "tag", type: "string" as const, defaultValue: "latest", description: "Tag" },
      ],
      stages: [
        { ...createStage("populateEnvVars"), args: { envVars: [["SERVICE", "billing"]] } },
        {
          ...createStage("genStage"),
          args: {
            title: "Build ${env.SERVICE}",
            image: "python311",
            commands: ["npm ci", "npm run build"],
            skipStage: "params.skipImage",
            unshallow: true,
            requestStorage: 20,
            stash: [["ByteCode", "**/*.class"]],
            secrets: [{ secret: "secret/team/svc", token: "tok", envVar: "SVC_TOKEN" }],
          },
        },
        { ...createStage("sonarStage"), args: { title: "Sonar" } },
      ],
    };

    const { pipeline, warnings } = parseJenkinsfile(toGroovy(original));
    expect(warnings).toEqual([]);
    expect(pipeline.library).toBe("jenkins-k8s-shared-library@main");
    expect(pipeline.params.map((p) => [p.name, p.type, p.defaultValue, p.choices ?? []])).toEqual([
      ["skipImage", "boolean", "true", []],
      ["target", "choice", "", ["dev", "prod"]],
      ["tag", "string", "latest", []],
    ]);
    // Ids are minted per stage, so compare everything else.
    expect(pipeline.stages.map((s) => ({ step: s.step, args: s.args }))).toEqual(
      original.stages.map((s) => ({ step: s.step, args: s.args }))
    );
    // The real proof: the file it generates again is the file it read.
    expect(toGroovy(pipeline)).toBe(toGroovy(original));
  });

  it("round-trips a closure-shaped commands argument", () => {
    const original = {
      ...newPipeline(),
      stages: [{ ...createStage("genStage"), args: { title: "T", image: "ubi8", commands: { closure: "sh 'a'\njunit '**/x.xml'" } } }],
    };
    const { pipeline } = parseJenkinsfile(toGroovy(original));
    expect(pipeline.stages[0].args.commands).toEqual({ closure: "sh 'a'\njunit '**/x.xml'" });
  });

  it("reads a hand-written file that is spaced and ordered differently", () => {
    const { pipeline, warnings } = parseJenkinsfile(`
      @Library('jenkins-k8s-shared-library') _

      // build it
      genStage(
        image : 'mvn353-jdk17',
        title : 'Build',
        commands: [ "mvn -B package" ],
      )
    `);
    expect(warnings).toEqual([]);
    expect(pipeline.library).toBe("jenkins-k8s-shared-library");
    expect(pipeline.stages[0].args).toEqual({ image: "mvn353-jdk17", title: "Build", commands: ["mvn -B package"] });
  });

  it("reports what it could not take rather than dropping it silently", () => {
    const { pipeline, warnings } = parseJenkinsfile(`
      genStage(title: 'Build', image: 'ubi8', somethingNew: 'x')
      deployToMars(title: 'Launch')
    `);
    expect(pipeline.stages).toHaveLength(1);
    expect(warnings).toEqual([
      "genStage: ignored an argument the builder does not know — somethingNew",
      "Skipped deployToMars() — not a step in the shared library.",
    ]);
  });

  it("names a declarative pipeline for what it is instead of importing nothing", () => {
    const { warnings } = parseJenkinsfile(`
      pipeline {
        agent any
        stages { stage('Build') { steps { sh 'make' } } }
      }
    `);
    expect(warnings[0]).toContain("declarative pipeline");
  });

  it("says what it knows when the file has no library steps at all", () => {
    const { pipeline, warnings } = parseJenkinsfile("echo 'nothing here'");
    expect(pipeline.stages).toEqual([]);
    expect(warnings[0]).toContain("No library steps found");
  });
});
