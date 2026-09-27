import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseJenkinsfile } from "../../parse";
import { toGroovy } from "../../groovy";
import { createStage, newPipeline, validatePipeline } from "../../pipeline";

/**
 * The shared library as real teams abuse it: every step, every argument shape,
 * helpers, wrappers, comments in odd places — and a declarative file beside it.
 * What the reader cannot take it must name, precisely; what it takes must come
 * back out meaning the same Groovy.
 */
const fixture = (name: string) => readFileSync(join(__dirname, name), "utf8");
const only = (text: string) => parseJenkinsfile(text);
const args = (text: string, i = 0) => only(text).pipeline.stages[i]?.args;

describe("the chaos Jenkinsfile", () => {
  const { pipeline, warnings } = parseJenkinsfile(fixture("scripted.Jenkinsfile"));

  it("takes every library step it can reach, in file order", () => {
    expect(pipeline.library).toBe("jenkins-k8s-shared-library@release/2.x");
    expect(pipeline.stages.map((s) => s.step)).toEqual([
      "populateEnvVars",
      "semVerStage",
      "genStage",
      "sonarStage",
      "genStage",
      "genStage",
      "genStage",
      "genStageWindows",
      "buildAndUploadImageStage",
      "buildAndUploadJarStage",
      "buildAndUploadRpmStage",
      "buildAndUploadWhlStage",
      "AIStage",
      "smartReleaseStage",
      "mirrorBranchStage",
      "sleep",
      "sleep",
      "genStage",
    ]);
    expect(pipeline.params.map((p) => [p.name, p.type])).toEqual([
      ["skipImage", "boolean"],
      ["RUN_SONAR", "boolean"],
      ["IMAGE_TAG", "string"],
      ["RELEASE_NOTES", "text"],
      ["TARGET_ENV", "choice"],
      ["LOG_LEVEL", "choice"],
      ["DEPLOY_TOKEN", "password"],
    ]);
  });

  it("names everything it left out, and nothing else", () => {
    expect(warnings).toEqual([
      "Moved `def version = env.VERSION` above the stages — it came after one, so it now runs earlier than it did.",
      "properties: skipped `buildDiscarder(logRotator(numToKeepStr: '30', artifactNumTo…` — only the parameters are read, so this job property will not be written back",
      "properties: skipped `disableConcurrentBuilds(abortPrevious: true)` — only the parameters are read, so this job property will not be written back",
      "properties: skipped `pipelineTriggers([cron('H 2 * * 1-5'), pollSCM('H/15 * * * …` — only the parameters are read, so this job property will not be written back",
      "parallel: ignored `failFast: true` — only branches written out as { … } closures can be read",
      "parallel: branch Lint + audit runs 2 steps in a row; each became its own parallel branch",
      "parallel: in branch Notify — Skipped `echo 'parallel started'` — the builder reads step calls, not the Groovy wrapped around them.",
      "parallel: ignored `buildMatrix(['billing-core', 'billing-api'])` — only branches written out as { … } closures can be read",
      "buildAndUploadImageStage: distributeToN is `isRelease`, which a flag field cannot hold — it came in as false",
      "Skipped `if (params.TARGET_ENV == 'prod') { genStage(title: 'Deploy …` — the builder reads step calls, not the Groovy wrapped around them. It holds genStage(), which only becomes a card when called at the top level.",
      "Skipped `try { genStage(title: 'Smoke', image: 'ubi8', commands: ['.…` — the builder reads step calls, not the Groovy wrapped around them. It holds genStage(), which only becomes a card when called at the top level.",
      "Skipped `timeout(time: 1, unit: 'HOURS') { AIStage(title: 'Release n…` — the builder reads step calls, not the Groovy wrapped around them. It holds AIStage(), which only becomes a card when called at the top level.",
      "Skipped `node('built-in') { stage('Cleanup') { cleanWs() } }` — the builder reads step calls, not the Groovy wrapped around them.",
      "Skipped `stage('Report') { echo \"Done — ${currentBuild.currentResult…` — the builder reads step calls, not the Groovy wrapped around them.",
      "Skipped `errorStage('Guard', 'this should never run')` — a helper the library's own steps call, which the builder has no card for.",
      "Skipped `skipStage('Skipped on purpose')` — a helper the library's own steps call, which the builder has no card for.",
      "Skipped `notify('SUCCESS')` — not a step in the shared library.",
    ]);
  });

  it("keeps the Groovy each argument means", () => {
    const build = pipeline.stages[2].args;
    expect(build.title).toBe("Build ${env.SERVICE} — ${params.TARGET_ENV == 'prod' ? \"PRD\" : 'non-prd'}");
    expect(build.commands).toEqual([
      "mvn -B -ntp clean package -DskipTests",
      'echo built ${modules.join(",")}',
      "printf 'line1\\nline2\\n' > out.txt",
      `echo "it's done"`,
    ]);
    expect(pipeline.stages[0].args.envVars).toContainEqual(["BRANCH_TYPE", "${isRelease ? 'release' : 'development'}"]);
    expect(pipeline.stages[1].args.postCommands).toEqual(['echo "VERSION=$VERSION"', "echo branch type $BRANCH_TYPE"]);
    expect(pipeline.stages[4].args.image).toBe("${DEFAULT_IMAGE}");
    expect(pipeline.stages[15].args).toEqual({ time: 30 });
    expect(pipeline.stages[17].args.skipStage).toBe("shouldSkip('tag')");
    expect(pipeline.params[3].defaultValue).toBe("First line\nsecond line with a 'quote' ");
    expect(pipeline.params[5].choices).toEqual(["info", "debug", "warn"]);
    expect(pipeline.groovy).toContain("final String DEFAULT_IMAGE = 'mvn353-jdk17'");
    expect(pipeline.groovy).toContain("String timestamp() {");
  });

  it("writes a file that reads back to itself, byte for byte, with nothing to report", () => {
    const text = toGroovy(pipeline);
    expect(text).toContain(`title: "Build \${env.SERVICE} — \${params.TARGET_ENV == 'prod' ? "PRD" : 'non-prd'}"`);
    expect(text).toContain(`"echo built \${modules.join(",")}"`);
    expect(text).toContain("text(name: 'RELEASE_NOTES', defaultValue: 'First line\\nsecond line with a \\'quote\\' '");
    expect(text).toContain("password(name: 'DEPLOY_TOKEN', defaultValue: ''");
    const back = parseJenkinsfile(text);
    expect(back.warnings).toEqual([]);
    expect(toGroovy(back.pipeline)).toBe(text);
    expect(validatePipeline(pipeline)).toEqual({ stages: {}, pipeline: [] });
  });
});

describe("the declarative chaos file", () => {
  it("says what it is, and which library steps are inside it", () => {
    const { pipeline, warnings } = parseJenkinsfile(fixture("declarative.Jenkinsfile"));
    expect(pipeline.stages).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("declarative pipeline");
    expect(warnings[0]).toContain("It holds genStage(), sonarStage()");
  });
});

describe("strings keep their Groovy meaning", () => {
  it("does not end a GString at a quote inside its ${…}", () => {
    expect(args(`genStage(title: 'T', image: 'x', commands: ["echo \${xs.join(",")}", 'b'])`)?.commands).toEqual([
      'echo ${xs.join(",")}',
      "b",
    ]);
  });

  it("keeps a single-quoted ${f} a shell variable", () => {
    const text = toGroovy(only("genStage(title: 'T', image: 'x', commands: ['for f in *; do echo ${f}; done'])").pipeline);
    expect(text).toContain('"for f in *; do echo \\${f}; done"');
  });

  it("reads $VAR, \\$ and \\n as Groovy does", () => {
    const c = args(`genStage(title: "Tag $VERSION", image: 'x', commands: ["echo \\$HOME", "printf 'a\\nb'"])`)!;
    expect(c.title).toBe("Tag ${VERSION}");
    expect(c.commands).toEqual(["echo $HOME", "printf 'a\nb'"]);
    expect(toGroovy(only(`genStage(title: 'T', image: 'x', commands: ["echo \\$HOME"])`).pipeline)).toContain("'echo $HOME'");
  });

  it("holds Groovy standing in for a string as the GString of it", () => {
    const { pipeline, warnings } = only("genStage(title: stageTitle, image: IMAGE, commands: [cmd])");
    expect(warnings).toEqual([]);
    expect(pipeline.stages[0].args).toEqual({ title: "${stageTitle}", image: "${IMAGE}", commands: ["${cmd}"] });
  });

  it("keeps a call as a skip condition", () => {
    expect(args("genStage(title: 'T', image: 'x', skipStage: shouldSkip('tag'))")?.skipStage).toBe("shouldSkip('tag')");
  });

  it("says when a flag, number or list is Groovy it cannot hold", () => {
    const { warnings } = only("genStage(title: 'T', image: 'x', unshallow: isRelease, requestStorage: SIZE, unstash: STASHES)");
    expect(warnings).toEqual([
      "genStage: unshallow is `isRelease`, which a flag field cannot hold — it came in as false",
      "genStage: requestStorage is `SIZE`, which a number field cannot hold — it came in empty",
      "genStage: unstash is `STASHES`, which a list field cannot hold — it came in empty",
    ]);
  });
});

describe("statements that are not step calls", () => {
  it("reads the parenthesis-free form of a known call", () => {
    expect(only("sleep 30").pipeline.stages[0].args).toEqual({ time: 30 });
  });

  it("names a wrapper and the library steps inside it", () => {
    expect(only("node('x') {\n  genStage(title: 'T', image: 'x')\n}").warnings).toEqual([
      "Skipped `node('x') { genStage(title: 'T', image: 'x') }` — the builder reads step calls, not the Groovy wrapped around them. It holds genStage(), which only becomes a card when called at the top level.",
    ]);
  });

  it("keeps } else { and a .chain on the next line in one statement", () => {
    const { warnings } = only("if (a) {\n  sleep(time: 1)\n}\nelse {\n  sleep(time: 2)\n}\nfoo\n  .bar()");
    expect(warnings).toHaveLength(2);
  });

  it("names a parallel branch that holds no step", () => {
    expect(only("parallel(a: { sleep(time: 1) }, b: { echo 'x' })").warnings).toEqual([
      "parallel: in branch b — Skipped `echo 'x'` — the builder reads step calls, not the Groovy wrapped around them.",
    ]);
  });
});

describe("properties", () => {
  it("names a job property as one, not as an unknown parameter type", () => {
    const { pipeline, warnings } = only("properties([disableConcurrentBuilds(), parameters([text(name: 'N', defaultValue: 'a')])])");
    expect(pipeline.params.map((p) => p.type)).toEqual(["text"]);
    expect(warnings).toEqual([
      "properties: skipped `disableConcurrentBuilds()` — only the parameters are read, so this job property will not be written back",
    ]);
  });
});

describe("top-level declarations", () => {
  it("lifts one declared by type, not only by def", () => {
    const { pipeline, warnings } = only("final String IMG = 'x'\nList<String> MODS = ['a']\nString stamp() {\n  'now'\n}\nsleep(time: 1)");
    expect(warnings).toEqual([]);
    expect(pipeline.groovy).toBe("final String IMG = 'x'\nList<String> MODS = ['a']\nString stamp() {\n  'now'\n}");
  });

  it("says when a variable that came after a stage is moved above it — but not a function", () => {
    expect(only("sleep(time: 1)\ndef f() { 1 }\ndef v = env.VERSION").warnings).toEqual([
      "Moved `def v = env.VERSION` above the stages — it came after one, so it now runs earlier than it did.",
    ]);
  });

  it("says when an @Library it cannot read was left out", () => {
    expect(only("@Library(['a', 'b']) _\nsleep(time: 1)").warnings).toEqual([
      "@Library: only one quoted library name can be read, so the import line was left out.",
    ]);
  });
});

describe("library checks the builder repeats", () => {
  const stage = (a: Record<string, unknown>) => ({ ...createStage("genStage"), args: { title: "T", image: "x", commands: ["a"], ...a } });
  const errorsOf = (a: Record<string, unknown>) => Object.values(validatePipeline({ ...newPipeline(), stages: [stage(a)] }).stages).flat();

  it("refuses a workspace outside 1..100 Gi, as podLauncher does", () => {
    expect(errorsOf({ requestStorage: 500 })).toEqual(["requestStorage must be between 1 and 100."]);
    expect(errorsOf({ requestStorage: 100 })).toEqual([]);
  });

  it("names a resources key the editor does not show and the library rejects", () => {
    expect(errorsOf({ resources: [["requestMemory", "2Gi"]] })).toEqual([
      "resources has requestMemory, which the library rejects — it takes requestCpu, requestmemory, limitCpu, limitMemory.",
    ]);
  });

  it("imports smartReleaseStage", () => {
    expect(only("smartReleaseStage(postCommands: ['echo $VERSION'])").warnings).toEqual([]);
  });
});
