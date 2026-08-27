/**
 * The `jenkins-k8s-shared-library` surface, transcribed by hand from its
 * `vars/*.groovy` files.
 *
 * Every step there takes one Groovy `Map args` and validates it at runtime
 * against an `@Field <name>ArgsSpec` map, merged with `genStage.genStageArgsSpec`
 * — so the common args below apply to all of them, exactly as
 * `sonarArgsSpec + genStage.genStageArgsSpec` does in the library.
 *
 * This file is the one place that knows the library's shape. **When the library
 * adds or renames an argument, update it here** — nothing reads the library repo
 * at runtime, which is deliberate: no clone step, no Groovy parser, no way for a
 * network hiccup to empty the builder.
 */

export type ArgKind =
  | "string"
  | "boolean"
  | "integer"
  /** A Groovy List of Strings, edited as a textarea — one entry per line. */
  | "stringList"
  /** A Groovy Map of String → String, edited as key/value rows. */
  | "stringMap"
  /** A Groovy List of Maps with a fixed set of keys, edited as repeated groups. */
  | "objectList";

export type ObjectField = {
  name: string;
  required?: boolean;
  placeholder?: string;
};

export type ArgSpec = {
  name: string;
  kind: ArgKind;
  hint: string;
  /** Overrides `name` as the field's caption. Only the pipeline-level fields use it. */
  label?: string;
  placeholder?: string;
  /** stringMap only: the library rejects any other key (see `resourcesValidator`). */
  allowedKeys?: string[];
  /** objectList only. */
  fields?: ObjectField[];
};

export type StepSpec = {
  /** The `vars/<step>.groovy` name, emitted verbatim into the Jenkinsfile. */
  step: string;
  label: string;
  description: string;
  /** What the step fills in when the arg is left off — shown as input placeholders. */
  defaults?: Record<string, string>;
  args: ArgSpec[];
};

/** `genStage.genStageArgsSpec` — merged into every step. */
const COMMON_ARGS: ArgSpec[] = [
  { name: "title", kind: "string", hint: "Stage name shown in Jenkins. Required.", placeholder: "Build" },
  {
    name: "image",
    kind: "string",
    hint:
      "Container image for the pod agent. A bare name resolves against the Artifactory image path; " +
      "`[name]` reuses a container from the inherited pod template instead of adding one.",
    placeholder: "python311",
  },
  {
    name: "node",
    kind: "string",
    hint: "Run on a labelled Jenkins node instead of a k8s pod. Exactly one of image or node.",
    placeholder: "windows",
  },
  { name: "skipStage", kind: "boolean", hint: "Mark the stage skipped in Jenkins without running it." },
  { name: "commands", kind: "stringList", hint: "Shell commands, one per line. Joined with && inside the container." },
  { name: "envVars", kind: "stringMap", hint: "Environment for this stage only (withEnv) — not the whole pipeline." },
  { name: "stash", kind: "stringMap", hint: "Stash name → include pattern. Stashed after the commands run." },
  { name: "unstash", kind: "stringList", hint: "Stash names to restore before the commands run, one per line." },
  { name: "unshallow", kind: "boolean", hint: "Fetch the full git history instead of the shallow clone." },
  {
    name: "junitTestResults",
    kind: "string",
    hint: "Ant-style path to JUnit XML. Published even when the stage fails.",
    placeholder: "**/target/surefire-reports/*.xml",
  },
  {
    name: "secrets",
    kind: "objectList",
    hint: "Vault secrets (engine v2) exposed to the stage as environment variables.",
    fields: [
      { name: "path", required: true, placeholder: "secret/team/service" },
      { name: "key", required: true, placeholder: "token" },
      { name: "variableName", required: true, placeholder: "SERVICE_TOKEN" },
    ],
  },
  {
    name: "additionalRepos",
    kind: "objectList",
    hint: "Extra repos cloned into sub-directories before the commands run.",
    fields: [
      { name: "dir", required: true, placeholder: "tools" },
      { name: "repoURL", required: true, placeholder: "https://bitbucket/scm/team/tools.git" },
      { name: "branch", required: true, placeholder: "master" },
      { name: "files", placeholder: "(sparse checkout, optional)" },
    ],
  },
  { name: "requestStorage", kind: "integer", hint: "Gi of dynamic nfs-premium workspace storage to request." },
  {
    name: "resources",
    kind: "stringMap",
    hint: "Container requests/limits. Defaults: 10m / 1Gi requested, 3 / 20Gi limit.",
    // Verbatim from the library's resourcesValidator — including the lowercase
    // `m` in requestmemory, which is what it actually accepts.
    allowedKeys: ["requestCpu", "requestmemory", "limitCpu", "limitMemory"],
  },
  { name: "runAsUser", kind: "string", hint: "UID inside the container. Default 1000.", placeholder: "1000" },
  {
    name: "customPVC",
    kind: "objectList",
    hint: "Existing PersistentVolumeClaims to mount into the pod.",
    fields: [
      { name: "claimName", required: true, placeholder: "team-cache" },
      { name: "mountPath", required: true, placeholder: "/cache" },
      { name: "readOnly", required: true, placeholder: "false" },
    ],
  },
];

const POST_COMMANDS: ArgSpec = {
  name: "postCommands",
  kind: "stringList",
  hint: "Shell commands run after the step's own work, one per line.",
};

/** Windows stages run through nodeExecutor, so the pod-only args do not exist. */
const POD_ONLY = ["image", "node", "requestStorage", "resources", "runAsUser", "customPVC"];

function common(exclude: string[] = []): ArgSpec[] {
  return COMMON_ARGS.filter((a) => !exclude.includes(a.name));
}

export const STEPS: StepSpec[] = [
  {
    step: "genStage",
    label: "Generic stage",
    description: "Runs shell commands in a container or on a node. Everything else is a wrapper around this.",
    args: common(),
  },
  {
    step: "genStageWindows",
    label: "Generic stage (Windows)",
    description: "Same as a generic stage, on the Windows node. The step forces node = 'windows'.",
    args: common(POD_ONLY),
  },
  {
    step: "buildAndUploadImageStage",
    label: "Build & upload image",
    description: "Builds the Dockerfile with buildkit and pushes it to Artifactory.",
    defaults: { title: "Build and Upload Image - ${env.SERVICE}", image: "[buildkit-rootful]" },
    args: [
      ...common(),
      { name: "dockerfile", kind: "string", hint: "Path to the Dockerfile.", placeholder: "Dockerfile" },
      { name: "context", kind: "string", hint: "Build context directory.", placeholder: "." },
      { name: "labels", kind: "stringMap", hint: "Labels baked into the image." },
      { name: "buildArgs", kind: "stringMap", hint: "--build-arg values passed to the build." },
      { name: "cache", kind: "boolean", hint: "Use the buildkit layer cache." },
      { name: "overwritePrd", kind: "boolean", hint: "Allow overwriting an existing production tag." },
      { name: "distributeToN", kind: "boolean", hint: "Distribute the pushed image onwards to N." },
      { name: "repoName", kind: "string", hint: "Target Artifactory docker repo." },
      POST_COMMANDS,
    ],
  },
  {
    step: "buildAndUploadJarStage",
    label: "Build & upload jar",
    description: "Maven deploy of the project's jar to Artifactory.",
    defaults: { title: "Build and Upload Jar - ${env.SERVICE}", image: "mvn353-jdk17" },
    args: [
      ...common(),
      { name: "flags", kind: "stringList", hint: "Extra maven flags, one per line.", },
      {
        name: "deployerPomLocation",
        kind: "string",
        hint: "Directory of the pom carrying the distributionManagement.",
        placeholder: ".",
      },
      { name: "parentPomLocation", kind: "string", hint: "Directory of the parent pom to version alongside it." },
      { name: "repoName", kind: "string", hint: "Target Artifactory maven repo." },
      POST_COMMANDS,
    ],
  },
  {
    step: "buildAndUploadRpmStage",
    label: "Build & upload RPM",
    description: "rpmbuild from a spec file, then upload to Artifactory.",
    defaults: { title: "Build and Upload RPM - ${env.SERVICE}", image: "rpmbuild" },
    args: [
      ...common(),
      { name: "specFile", kind: "string", hint: "Path to the .spec file.", placeholder: "service.spec" },
      { name: "macros", kind: "stringMap", hint: "rpmbuild --define macros." },
      { name: "flags", kind: "stringList", hint: "Extra rpmbuild flags, one per line." },
      { name: "rpmName", kind: "string", hint: "Override the built RPM's name." },
      { name: "path", kind: "string", hint: "Path inside the target repo to upload into." },
      { name: "repoName", kind: "string", hint: "Target Artifactory rpm repo." },
      POST_COMMANDS,
    ],
  },
  {
    step: "buildAndUploadWhlStage",
    label: "Build & upload wheel",
    description: "Builds the Python wheel and uploads it to Artifactory.",
    defaults: { title: "Build and Upload Whl - ${env.SERVICE}", image: "python311" },
    args: [...common(), { name: "repoName", kind: "string", hint: "Target Artifactory pypi repo." }, POST_COMMANDS],
  },
  {
    step: "semVerStage",
    label: "Semantic release",
    description:
      "Runs semantic-release, then publishes VERSION / BRANCH_TYPE for later stages. " +
      "Dry-run on pull requests, skipped on development branches.",
    defaults: { title: "semantic-release", image: "semantic-release" },
    args: [...common(), POST_COMMANDS],
  },
  {
    step: "sonarStage",
    label: "Sonar scan",
    description:
      "Generates sonar-project.properties (unless the repo already has one) and runs sonar-scanner.",
    defaults: { title: "Sonar Scanning", image: "sonar" },
    args: [
      ...common(),
      { name: "projectKey", kind: "string", hint: "sonar.projectKey. Defaults to $SERVICE." },
      { name: "projectName", kind: "string", hint: "sonar.projectName. Defaults to $SERVICE." },
      { name: "projectVersion", kind: "string", hint: "sonar.projectVersion. Defaults to $VERSION, else 1.0.0." },
      { name: "extraProps", kind: "stringMap", hint: "Extra lines appended to the generated properties file." },
      {
        name: "propertiesFile",
        kind: "string",
        hint: "Name of the properties file. One already in the repo is used unchanged.",
        placeholder: "sonar-project.properties",
      },
      { name: "flags", kind: "stringList", hint: "Extra maven flags for the verify run (MAVEN projects), one per line." },
      { name: "modulePath", kind: "string", hint: "Run the scan from this sub-directory." },
      POST_COMMANDS,
    ],
  },
  {
    step: "AIStage",
    label: "AI stage",
    description: "Runs `opencode run <prompt>` in the workspace with the AI key from Vault.",
    defaults: { title: "AI Stage", image: "opencode" },
    args: [
      ...common(),
      {
        name: "prompt",
        kind: "string",
        hint: "Prompt passed to `opencode run`.",
        placeholder: "Review the diff and fail on any hardcoded secret",
      },
      POST_COMMANDS,
    ],
  },
  {
    step: "mirrorBranchStage",
    label: "Mirror branch",
    description: "Force-pushes the current branch and its tags to another repo.",
    defaults: { title: "Mirror Branch ${BRANCH_NAME}", image: "ubi8" },
    args: [
      ...common(),
      { name: "destRepo", kind: "string", hint: "HTTPS URL of the repo to mirror into.", placeholder: "https://…/mirror.git" },
      {
        name: "allowedBranches",
        kind: "stringList",
        hint: "Branch patterns to mirror (* wildcards), one per line. Omit to mirror every branch.",
      },
      { name: "flags", kind: "stringList", hint: "Declared by the step's spec but currently unused by it." },
      POST_COMMANDS,
    ],
  },
];

/** Which of a step's arguments come from genStage rather than the step itself — used to group the picker. */
export const COMMON_ARG_NAMES: string[] = COMMON_ARGS.map((a) => a.name);

export function stepSpec(step: string): StepSpec | undefined {
  return STEPS.find((s) => s.step === step);
}

export function argSpec(step: string, arg: string): ArgSpec | undefined {
  return stepSpec(step)?.args.find((a) => a.name === arg);
}
