import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { JenkinsfilePipeline, PortalUser } from "../../../server/types";

const saved: JenkinsfilePipeline = {
  id: "JF-0001",
  name: "checkout release",
  library: "jenkins-k8s-shared-library",
  envVars: { SERVICE: "checkout" },
  stages: [{ id: "s-1", step: "semVerStage", args: {} }],
  createdBy: "u-alex",
  createdByName: "Alex Morgan",
  createdAt: "2026-08-27T09:00:00.000Z",
  updatedAt: "2026-08-27T09:00:00.000Z",
};

const createPipeline = vi.fn((input: unknown) =>
  Promise.resolve({ pipeline: { ...saved, ...(input as object), id: "JF-0002" } as JenkinsfilePipeline })
);

vi.mock("./api", () => ({
  listPipelines: () => Promise.resolve({ pipelines: [saved] }),
  createPipeline,
  updatePipeline: vi.fn(),
  deletePipeline: vi.fn(),
}));

const { JenkinsfileView } = await import("./JenkinsfileView");

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

describe("JenkinsfileView", () => {
  it("builds, reorders and previews a pipeline", async () => {
    const { code } = renderView();

    fireEvent.click(screen.getByRole("button", { name: "Add Generic stage" }));
    setArg("title", "Build");
    setArg("image", "node20");
    setArg("commands", "npm ci\nnpm run build");

    fireEvent.click(screen.getByRole("button", { name: "Add Sonar scan" }));

    expect(code()).toContain("genStage(");
    expect(code()).toContain("commands: ['npm ci', 'npm run build']");
    expect(code().indexOf("genStage")).toBeLessThan(code().indexOf("sonarStage"));

    // Dragging is mouse-only; the same reorder runs through the arrow buttons.
    fireEvent.click(screen.getByRole("button", { name: "Move Build down" }));
    expect(code().indexOf("sonarStage")).toBeLessThan(code().indexOf("genStage"));
  });

  it("surfaces the library's own validation before the build does", async () => {
    renderView();
    fireEvent.click(screen.getByRole("button", { name: "Add Generic stage" }));

    expect(screen.getByText("title is required.")).toBeInTheDocument();
    expect(screen.getByText("Set exactly one of image or node.")).toBeInTheDocument();

    setArg("title", "Build");
    // image and node are one choice, not two fields — the segmented control swaps them.
    fireEvent.click(screen.getByRole("button", { name: "Jenkins node" }));
    setArg("node", "windows");
    expect(screen.queryByText("Set exactly one of image or node.")).not.toBeInTheDocument();
  });

  it("opens a saved pipeline, envVars included", async () => {
    const { code } = renderView();
    await waitFor(() => expect(screen.getByText("checkout release")).toBeInTheDocument());

    fireEvent.click(screen.getByText("checkout release"));

    expect(code()).toContain("populateEnvVars([");
    expect(code()).toContain("SERVICE: 'checkout'");
    expect(code()).toContain("semVerStage()");
  });

  it("will not save an unnamed pipeline, and posts the input once it has a name", async () => {
    renderView();
    expect(screen.getByRole("button", { name: /Save as new/ })).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Pipeline name"), { target: { value: "my pipeline" } });
    fireEvent.click(screen.getByRole("button", { name: "Add Sonar scan" }));
    fireEvent.click(screen.getByRole("button", { name: /Save as new/ }));

    await waitFor(() => expect(createPipeline).toHaveBeenCalled());
    expect(createPipeline.mock.calls[0][0]).toMatchObject({
      name: "my pipeline",
      library: "jenkins-k8s-shared-library",
      stages: [{ step: "sonarStage", args: {} }],
    });
  });
});
