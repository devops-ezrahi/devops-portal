import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JenkinsfilePipeline, PortalUser } from "../../../server/types";

/** Mirrors the view's own debounce — there is no Save button to press instead. */
const AUTOSAVE_MS = 800;

const saved: JenkinsfilePipeline = {
  id: "JF-0001",
  name: "Alex Morgan #1",
  library: "jenkins-k8s-shared-library",
  envVars: { SERVICE: "checkout" },
  stages: [{ id: "s-1", step: "semVerStage", args: {}, collapsed: true }],
  createdBy: "u-alex",
  createdByName: "Alex Morgan",
  createdAt: "2026-08-27T09:00:00.000Z",
  updatedAt: "2026-08-27T09:00:00.000Z",
};

const createPipeline = vi.fn((input: unknown) =>
  Promise.resolve({ pipeline: { ...saved, ...(input as object), id: "JF-0002" } as JenkinsfilePipeline })
);
const updatePipeline = vi.fn((id: string, input: unknown) =>
  Promise.resolve({ pipeline: { ...saved, ...(input as object), id } as JenkinsfilePipeline })
);

vi.mock("./api", () => ({
  listPipelines: () => Promise.resolve({ pipelines: [saved] }),
  getImages: () =>
    Promise.resolve({ images: [{ name: "python311", info: "JDK=17" }, { name: "ubi8", info: "OS=ubi8" }] }),
  createPipeline,
  updatePipeline,
  deletePipeline: vi.fn(),
}));

const { JenkinsfileView } = await import("./JenkinsfileView");

// An expanded stage card is the whole catalog for that step — some thirty
// fields and add-rows — re-rendered on every keystroke. That is fast in a
// browser and slow in jsdom, and the default 5s is not enough for it once the
// rest of the suite is running in parallel.
vi.setConfig({ testTimeout: 30_000 });

const user: PortalUser = { id: "dev", email: "dev@example.com", displayName: "Dev User", groups: [] };

function renderView() {
  const view = render(<JenkinsfileView user={user} isAdmin={false} refreshKey={0} onError={() => {}} />);
  const code = () => view.container.querySelector(".jf-code")?.textContent ?? "";
  return { ...view, code };
}

/**
 * Types a value into one of the open stage's arguments, adding it first when it
 * is one of the optional ones — the required three are always on screen.
 */
function setArg(name: string, value: string) {
  const add = screen.queryByRole("button", { name: `Add ${name}` });
  if (add) fireEvent.click(add);
  fireEvent.change(screen.getByLabelText(name), { target: { value } });
}

/**
 * Fills a list argument, one box per entry — Enter is what opens the next one.
 */
function setList(name: string, entries: string[]) {
  const add = screen.queryByRole("button", { name: `Add ${name}` });
  if (add) fireEvent.click(add);
  entries.forEach((entry, i) => {
    const box = i === 0 ? screen.getByLabelText(name) : screen.getByLabelText(`${name} ${i + 1}`);
    fireEvent.change(box, { target: { value: entry } });
    if (i < entries.length - 1) fireEvent.keyDown(box, { key: "Enter" });
  });
}

/**
 * The palette is a popover under the Add stage button at the foot of the list.
 * Cards arrive minimized, so this opens the one it just added — every test
 * below goes on to edit it.
 */
function addStage(label: string) {
  fireEvent.click(screen.getByRole("button", { name: "Add stage" }));
  fireEvent.click(screen.getByRole("button", { name: `Add ${label}` }));
  const expand = screen.getAllByRole("button", { name: /^Expand / });
  fireEvent.click(expand[expand.length - 1]);
}

/**
 * Press somewhere outside every stage, which is what reveals their problems.
 * A press *inside* the card — moving between its own fields — must not.
 */
function pressOutsideStages() {
  fireEvent.pointerDown(document.body);
}

function pressInsideStage() {
  fireEvent.pointerDown(document.querySelector(".jf-card")!);
}

/** Autosave sits on a change for 800ms; this is how a test gets past that. */
async function settle() {
  await act(async () => {
    vi.advanceTimersByTime(AUTOSAVE_MS);
  });
}

describe("JenkinsfileView", () => {
  // The mocks are module-level, so without this `calls[0]` belongs to whichever
  // test saved first rather than to the one asserting on it.
  beforeEach(() => {
    createPipeline.mockClear();
    updatePipeline.mockClear();
    // The view reopens the last pipeline it was left on; each test starts fresh.
    localStorage.clear();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => vi.useRealTimers());

  it("builds, reorders and previews a pipeline", async () => {
    const { code } = renderView();

    addStage("Gen stage");
    setArg("title", "Build");
    setArg("image", "node20");
    setList("commands", ["npm ci", "npm run build"]);

    // Done with it: the card folds back to its header and the arguments go away.
    fireEvent.click(screen.getByRole("button", { name: "Collapse Build" }));
    expect(screen.queryByLabelText("commands")).not.toBeInTheDocument();

    addStage("Sonar scan");

    expect(code()).toContain("genStage(");
    expect(code()).toContain("commands: [\n        'npm ci',\n        'npm run build'\n    ]");
    expect(code().indexOf("genStage")).toBeLessThan(code().indexOf("sonarStage"));
  });

  it("says nothing about a stage until you leave it", () => {
    renderView();
    addStage("Gen stage");

    // Empty, but you are still in the middle of it.
    expect(screen.queryByText("title is required.")).not.toBeInTheDocument();

    // Moving between fields of the same stage is not leaving it.
    pressInsideStage();
    expect(screen.queryByText("title is required.")).not.toBeInTheDocument();

    pressOutsideStages();
    expect(screen.getByText("title is required.")).toBeInTheDocument();
    expect(screen.getByText("Set exactly one of image or node.")).toBeInTheDocument();
    expect(screen.getByText("commands is required.")).toBeInTheDocument();

    // From then on they track what you type.
    setArg("title", "Build");
    // image and node are one choice, not two fields — the segmented control swaps them.
    fireEvent.click(screen.getByRole("button", { name: "node" }));
    setArg("node", "windows");
    setList("commands", ["npm ci"]);
    expect(screen.queryByText("title is required.")).not.toBeInTheDocument();
    expect(screen.queryByText("Set exactly one of image or node.")).not.toBeInTheDocument();
  });

  it("migrates a saved pipeline's envVars map into a populateEnvVars card", async () => {
    const { code } = renderView();
    await waitFor(() => expect(screen.getByText("Alex Morgan #1")).toBeInTheDocument());

    fireEvent.click(screen.getByText("Alex Morgan #1"));

    expect(code()).toContain("populateEnvVars([SERVICE: 'checkout'])");
    expect(code()).toContain("semVerStage()");
    // Opened collapsed — the card is on screen, its arguments are not.
    expect(screen.getByRole("button", { name: "Expand Populate env vars" })).toBeInTheDocument();
    expect(screen.queryByLabelText("envVars key 1")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Expand Populate env vars" }));
    expect(screen.getByLabelText("envVars key 1")).toHaveValue("SERVICE");
  });

  it("creates the pipeline on its own, then updates it in place", async () => {
    renderView();
    addStage("Sonar scan");

    await settle();
    await waitFor(() => expect(createPipeline).toHaveBeenCalledTimes(1));
    const input = createPipeline.mock.calls[0][0] as Record<string, unknown>;
    // No @Library line was asked for, so none is sent.
    expect(input).toMatchObject({ library: "", stages: [{ step: "sonarStage" }] });
    // Nothing was typed in the name field, so it goes up blank and the server
    // mints one — the field is a rename, not a required step before saving.
    expect(input.name).toBe("");
    expect(screen.getByRole("status")).toHaveTextContent("");

    // A second change goes to the id the create handed back, not to a new record.
    setArg("projectKey", "checkout");
    await settle();
    await waitFor(() => expect(updatePipeline).toHaveBeenCalledTimes(1));
    expect(updatePipeline.mock.calls[0][0]).toBe("JF-0002");
    expect(createPipeline).toHaveBeenCalledTimes(1);
  });

  it("writes nothing for an untouched draft, or for one that ends up unchanged", async () => {
    renderView();
    await settle();
    expect(createPipeline).not.toHaveBeenCalled();

    addStage("Sonar scan");
    await settle();
    await waitFor(() => expect(createPipeline).toHaveBeenCalledTimes(1));

    // Nothing changed since, so nothing is written again.
    await settle();
    expect(updatePipeline).not.toHaveBeenCalled();
  });

  it("minimizes a stage and reopens it with Edit, and saves which", async () => {
    renderView();
    addStage("Sonar scan");

    // sonarStage names its own image, so that is the argument it always shows.
    fireEvent.click(screen.getByRole("button", { name: "Minimize Sonar Scanning" }));
    expect(screen.queryByRole("button", { name: "Add projectKey" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Edit Sonar Scanning" }));
    expect(screen.getByRole("button", { name: "Add projectKey" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Minimize Sonar Scanning" }));
    await settle();
    await waitFor(() => expect(createPipeline).toHaveBeenCalled());
    expect(createPipeline.mock.calls[0][0]).toMatchObject({ stages: [{ collapsed: true }] });
  });

  it("writes commands as a closure when the switch says so", () => {
    const { code } = renderView();
    addStage("Gen stage");
    setArg("title", "Build");
    setArg("image", "node20");

    fireEvent.click(screen.getByRole("button", { name: "Closure" }));
    fireEvent.change(screen.getByLabelText("commands"), { target: { value: "sh 'npm ci'\njunit '**/*.xml'" } });

    expect(code()).toContain("commands: {");
    expect(code()).toContain("sh 'npm ci'");
    expect(code()).not.toContain("commands: ['sh");
  });

  it("gives each list entry its own box, added with Enter and removed with Backspace", () => {
    const { code } = renderView();
    addStage("Gen stage");
    setArg("title", "Build");
    setArg("image", "node20");

    setList("commands", ["npm ci", "npm test"]);
    expect(code()).toContain("commands: [\n        'npm ci',\n        'npm test'\n    ]");

    // An empty box is not a mistake to be swept up under the cursor — it stays
    // until Backspace takes it, and the generator is what drops it.
    fireEvent.keyDown(screen.getByLabelText("commands 2"), { key: "Enter" });
    expect(screen.getByLabelText("commands 3")).toHaveValue("");
    expect(code()).toContain("commands: [\n        'npm ci',\n        'npm test'\n    ]");

    fireEvent.keyDown(screen.getByLabelText("commands 3"), { key: "Backspace" });
    expect(screen.queryByLabelText("commands 3")).toBeNull();
  });

  it("splits a multi-line paste across boxes instead of joining it into one", () => {
    const { code } = renderView();
    addStage("Gen stage");
    setArg("title", "Build");
    setArg("image", "node20");

    fireEvent.paste(screen.getByLabelText("commands"), {
      clipboardData: { getData: () => "mvn -B package\nmvn -B verify" },
    });
    expect(code()).toContain("commands: [\n        'mvn -B package',\n        'mvn -B verify'\n    ]");
  });

  it("drops an argument when the last entry of it is removed", () => {
    renderView();
    addStage("Gen stage");

    fireEvent.click(screen.getByRole("button", { name: "Add customPVC" }));
    expect(screen.getByLabelText("customPVC #1 claimName")).toBeInTheDocument();

    // The one entry is the argument: taking it away stops using customPVC,
    // rather than leaving the same blank row behind.
    fireEvent.click(screen.getByRole("button", { name: "Remove customPVC #1" }));
    expect(screen.queryByLabelText("customPVC #1 claimName")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add customPVC" })).toBeInTheDocument();
  });

  it("shows the open pipeline's name and renames it in the list too", async () => {
    renderView();
    await act(async () => {});

    // Opening a saved pipeline puts its name in the bar.
    fireEvent.click(screen.getByText("Alex Morgan #1"));
    // Shown as text first — the heading, not a field.
    expect(screen.getByRole("heading", { name: "Alex Morgan #1" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Rename this pipeline" }));
    const title = screen.getByLabelText("Pipeline name");
    expect(title).toHaveValue("Alex Morgan #1");
    fireEvent.change(title, { target: { value: "Checkout release" } });
    await settle();
    await waitFor(() => expect(updatePipeline).toHaveBeenCalled());
    expect((updatePipeline.mock.calls[0][1] as { name: string }).name).toBe("Checkout release");
    // The side list is the same record, so it follows.
    await waitFor(() => expect(screen.getByText("Checkout release")).toBeTruthy());
  });

  it("reopens the pipeline it was left on", async () => {
    const first = renderView();
    await act(async () => {});
    fireEvent.click(screen.getByText("Alex Morgan #1"));
    first.unmount();

    // A refresh remounts the view; the last pipeline opened comes back with it.
    renderView();
    await waitFor(() => expect(screen.getByRole("heading", { name: "Alex Morgan #1" })).toBeTruthy());
  });

  it("keeps typing in the name field over a slow save's response", async () => {
    renderView();
    await act(async () => {});
    addStage("Gen stage");

    fireEvent.click(screen.getByRole("button", { name: "Rename this pipeline" }));
    fireEvent.change(screen.getByLabelText("Pipeline name"), { target: { value: "Mine" } });
    await settle();
    await waitFor(() => expect(createPipeline).toHaveBeenCalled());
    // The response carries the stored name; what is in the field wins.
    expect(screen.getByLabelText("Pipeline name")).toHaveValue("Mine");
  });

  it("asks whether to start empty or import, and imports a pasted Jenkinsfile", async () => {
    const { code } = renderView();
    await act(async () => {});

    fireEvent.click(screen.getByRole("button", { name: /New/ }));
    fireEvent.click(screen.getByRole("button", { name: /Import an existing Jenkinsfile/ }));
    fireEvent.change(screen.getByLabelText("Or paste it here"), {
      target: {
        value: `@Library('jenkins-k8s-shared-library@main') _

genStage(title: 'Build', image: 'python311', commands: ['npm ci'])`,
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "Import" }));

    // The cards are the file: the stage is on screen and the preview matches.
    expect(screen.getByDisplayValue("python311")).toBeTruthy();
    expect(code()).toContain("@Library('jenkins-k8s-shared-library@main') _");
    expect(code()).toContain("genStage(");
    expect(code()).toContain("'npm ci'");
  });

  it("says what it could not read before importing, and imports the rest anyway", async () => {
    const { code } = renderView();
    await act(async () => {});

    fireEvent.click(screen.getByRole("button", { name: /New/ }));
    fireEvent.click(screen.getByRole("button", { name: /Import an existing Jenkinsfile/ }));
    fireEvent.change(screen.getByLabelText("Or paste it here"), {
      target: { value: "genStage(title: 'Build', image: 'ubi8')\ndeployToMars(title: 'Launch')" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Import" }));
    // Held back once — a stage that vanishes without a word is worse than one
    // the user has to re-add by hand.
    expect(screen.getByText(/Skipped deployToMars/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Import anyway" }));
    expect(code()).toContain("genStage(");
    expect(code()).not.toContain("deployToMars");
  });

  it("starts an empty pipeline when that is the choice", async () => {
    const { code } = renderView();
    await act(async () => {});
    addStage("Gen stage");
    expect(code()).toContain("genStage(");

    fireEvent.click(screen.getByRole("button", { name: /New/ }));
    fireEvent.click(screen.getByRole("button", { name: /Start from scratch/ }));
    expect(code()).toBe("");
  });

  it("drops a list of images, each with its labels beside it", async () => {
    renderView();
    // The list arrives from its own request, so let that resolve first.
    await act(async () => {});
    addStage("Gen stage");

    expect(screen.queryByRole("listbox")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show images" }));

    const options = screen.getAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual(["python311JDK=17", "ubi8OS=ubi8"]);
    fireEvent.pointerDown(options[1]);
    expect((screen.getByLabelText("image") as HTMLInputElement).value).toBe("ubi8");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("filters the list as you type, and still takes an image that is not on it", async () => {
    renderView();
    await act(async () => {});
    addStage("Gen stage");

    const image = screen.getByLabelText("image");
    fireEvent.change(image, { target: { value: "py" } });
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["python311JDK=17"]);

    // Free text: an image nobody has published still goes through to the file.
    fireEvent.change(image, { target: { value: "something-else" } });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect((screen.getByLabelText("image") as HTMLInputElement).value).toBe("something-else");
  });

  it("picks off the list with the keyboard", async () => {
    renderView();
    await act(async () => {});
    addStage("Gen stage");

    const image = screen.getByLabelText("image");
    fireEvent.keyDown(image, { key: "ArrowDown" });
    fireEvent.keyDown(image, { key: "ArrowDown" });
    fireEvent.keyDown(image, { key: "Enter" });
    expect((image as HTMLInputElement).value).toBe("ubi8");
  });

  it("offers only what an earlier stage stashed to unstash", () => {
    renderView();
    addStage("Gen stage");
    setArg("title", "Build");
    setArg("image", "node20");
    fireEvent.click(screen.getByRole("button", { name: "Add stash" }));
    fireEvent.change(screen.getByLabelText("stash key 1"), { target: { value: "ByteCode" } });
    fireEvent.change(screen.getByLabelText("stash value 1"), { target: { value: "**/target/**" } });
    fireEvent.click(screen.getByRole("button", { name: "Collapse Build" }));

    addStage("Gen stage");
    fireEvent.click(screen.getByRole("button", { name: "Add unstash" }));
    // The stash belongs to the stage before it, so it is on offer here.
    fireEvent.click(screen.getByLabelText("unstash ByteCode"));
    expect(screen.getByLabelText("unstash ByteCode")).toBeChecked();
  });

  it("adds the @Library line only when asked, and only takes a branch", () => {
    const { code } = renderView();
    expect(code()).not.toContain("@Library");

    fireEvent.click(screen.getByRole("button", { name: /Import the shared library/ }));
    expect(code()).toContain("@Library('jenkins-k8s-shared-library') _");

    fireEvent.change(screen.getByLabelText("jenkins-k8s-shared-library"), { target: { value: "dev-v2" } });
    expect(code()).toContain("@Library('jenkins-k8s-shared-library@dev-v2') _");

    fireEvent.click(screen.getByRole("button", { name: "Remove the shared library import" }));
    expect(code()).not.toContain("@Library");
  });

  it("offers boolean, string and choice parameters, and writes the one picked", () => {
    const { code } = renderView();

    fireEvent.click(screen.getByRole("button", { name: /Add pipeline parameters/ }));
    expect(
      [...screen.getByLabelText("Parameter 1 type").querySelectorAll("option")].map((o) => o.value)
    ).toEqual(["boolean", "string", "choice"]);

    fireEvent.change(screen.getByLabelText("Parameter 1 name"), { target: { value: "target" } });
    fireEvent.change(screen.getByLabelText("Parameter 1 type"), { target: { value: "choice" } });
    fireEvent.change(screen.getByLabelText("Parameter 1 choices"), { target: { value: "dev\nprod" } });

    expect(code()).toContain("choice(name: 'target', choices: ['dev', 'prod'], description: '')");
  });
});
