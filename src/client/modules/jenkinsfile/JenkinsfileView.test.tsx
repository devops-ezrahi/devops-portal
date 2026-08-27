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

/** The palette is a popover under the Add stage button at the foot of the list. */
function addStage(label: string) {
  fireEvent.click(screen.getByRole("button", { name: "Add stage" }));
  fireEvent.click(screen.getByRole("button", { name: `Add ${label}` }));
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
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => vi.useRealTimers());

  it("builds, reorders and previews a pipeline", async () => {
    const { code } = renderView();

    addStage("Gen stage");
    setArg("title", "Build");
    setArg("image", "node20");
    setArg("commands", "npm ci\nnpm run build");

    // Done with it: the card folds back to its header and the arguments go away.
    fireEvent.click(screen.getByRole("button", { name: "Collapse Build" }));
    expect(screen.queryByLabelText("commands")).not.toBeInTheDocument();

    addStage("Sonar scan");

    expect(code()).toContain("genStage(");
    expect(code()).toContain("commands: ['npm ci', 'npm run build']");
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
    setArg("commands", "npm ci");
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
    // The server names it, so the builder sends none.
    expect("name" in input).toBe(false);
    expect(screen.getByRole("status")).toHaveTextContent("Saved");

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

  it("lets Enter add a line to commands instead of swallowing it", () => {
    const { code } = renderView();
    addStage("Gen stage");
    setArg("title", "Build");
    setArg("image", "node20");

    // A trailing newline is the state right after pressing Enter — it has to
    // survive the round trip, or the cursor jumps back up a row.
    fireEvent.change(screen.getByLabelText("commands"), { target: { value: "npm ci\n" } });
    expect(screen.getByLabelText("commands")).toHaveValue("npm ci\n");

    fireEvent.change(screen.getByLabelText("commands"), { target: { value: "npm ci\nnpm test" } });
    expect(code()).toContain("commands: ['npm ci', 'npm test']");
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

    fireEvent.click(screen.getByRole("button", { name: /Add parameter/ }));
    expect(
      [...screen.getByLabelText("Parameter 1 type").querySelectorAll("option")].map((o) => o.value)
    ).toEqual(["boolean", "string", "choice"]);

    fireEvent.change(screen.getByLabelText("Parameter 1 name"), { target: { value: "target" } });
    fireEvent.change(screen.getByLabelText("Parameter 1 type"), { target: { value: "choice" } });
    fireEvent.change(screen.getByLabelText("Parameter 1 choices"), { target: { value: "dev\nprod" } });

    expect(code()).toContain("choice(name: 'target', choices: ['dev', 'prod'], description: '')");
  });
});
