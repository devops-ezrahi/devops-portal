import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ArgocdTree } from "../../../server/types";

const listTrees = vi.fn();
const createTree = vi.fn();
const updateTree = vi.fn();
const deleteTree = vi.fn();

vi.mock("./api", () => ({ listTrees, createTree, updateTree, deleteTree }));

const { ArgocdView } = await import("./ArgocdView");

const defaults = {
  chartRepoUrl: "https://github.com/devops-ezrahi/universal-chart.git",
  chartPath: ".",
  appsetChartPath: "ms-applicationSet",
  chartRevision: "main",
  valuesRepoUrl: "https://git.example.com/gitops/values.git",
  valuesRevision: "main",
};

const saved = (over: Partial<ArgocdTree> = {}): ArgocdTree => ({
  id: "AG-0001",
  name: "Dev User #1",
  chart: { repoUrl: defaults.chartRepoUrl, path: ".", appsetPath: "ms-applicationSet", revision: "main" },
  values: { repoUrl: defaults.valuesRepoUrl, revision: "main", path: "" },
  rootAppName: "platform-root",
  releases: [],
  namespaces: [],
  createdBy: "dev",
  createdByName: "Dev User",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...over,
});

function view() {
  return render(
    <ArgocdView
      user={{ id: "dev", displayName: "Dev User", email: "dev@example.com", groups: [] }}
      isAdmin={false}
      refreshKey={0}
      onError={() => {}}
    />
  );
}

/** The catalog card for one feature, found by its name rather than its blurb. */
const feature = (name: string) =>
  screen.getByText(name, { selector: ".ag-feature-name" }).closest(".ag-feature") as HTMLElement;

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  listTrees.mockResolvedValue({ trees: [], defaults });
  createTree.mockImplementation((input) => Promise.resolve({ tree: { ...saved(), ...input } }));
  updateTree.mockImplementation((id, input) => Promise.resolve({ tree: { ...saved(), ...input, id } }));
});

describe("ArgocdView", () => {
  it("pre-fills a new tree from the configured repositories", async () => {
    view();
    await waitFor(() => expect(listTrees).toHaveBeenCalled());
    // The collapsed summary names both repos, so the reader can tell which
    // branch belongs to which without opening the box.
    const toggle = screen.getByRole("button", { name: /Chart.*universal-chart.*Values.*values/s });
    fireEvent.click(toggle);
    expect(screen.getByDisplayValue(defaults.chartRepoUrl)).toBeInTheDocument();
    expect(screen.getByDisplayValue(defaults.valuesRepoUrl)).toBeInTheDocument();
  });

  it("shows the required features without a tick, and defaulted fields only on request", async () => {
    view();
    await waitFor(() => expect(listTrees).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: /Release/ }));

    // Workload and image are on screen before any category is opened, and there
    // is nothing to untick them with.
    expect(screen.getByLabelText("workload.type")).toBeInTheDocument();
    expect(feature("Image & pull secrets").querySelector("input[type=checkbox]")).toBeNull();

    // pullPolicy is one the chart already answers, so it waits on the add list.
    expect(screen.queryByLabelText("image.pullPolicy")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /image\.pullPolicy/ }));
    expect(screen.getByLabelText("image.pullPolicy")).toBeInTheDocument();
  });

  it("generates the tree from what is typed, and saves it once", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    view();
    await waitFor(() => expect(listTrees).toHaveBeenCalled());

    fireEvent.click(screen.getByRole("button", { name: /Release/ }));
    fireEvent.change(screen.getByLabelText("Release name"), { target: { value: "api-gateway" } });
    fireEvent.change(screen.getByLabelText("image.repository"), { target: { value: "nginx" } });

    expect(screen.getByLabelText("base/api-gateway.yaml")).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(createTree).toHaveBeenCalledTimes(1);
    expect(createTree.mock.calls[0][0].releases[0]).toMatchObject({ name: "api-gateway" });
    vi.useRealTimers();
  });

  it("writes a namespace edit into that namespace, not into the base", async () => {
    view();
    await waitFor(() => expect(listTrees).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: /Release/ }));
    fireEvent.change(screen.getByLabelText("Release name"), { target: { value: "api-gateway" } });
    fireEvent.change(screen.getByLabelText("image.tag"), { target: { value: "1.0.0" } });

    fireEvent.click(screen.getByRole("button", { name: /Namespace/ }));
    fireEvent.change(screen.getByLabelText("Namespace name"), { target: { value: "shop-web" } });
    // The namespace layer starts empty — it holds overrides, not a copy.
    fireEvent.change(screen.getByLabelText("image.tag"), { target: { value: "1.4.2" } });

    fireEvent.click(screen.getByLabelText("shop-web/values/api-gateway.yaml"));
    const shown = document.querySelector(".ag-file-body")!.textContent!;
    expect(shown).toContain("tag: 1.4.2");
    expect(shown).not.toContain("1.0.0");

    fireEvent.click(screen.getByLabelText("base/api-gateway.yaml"));
    expect(document.querySelector(".ag-file-body")!.textContent).toContain("tag: 1.0.0");
  });

  it("shows the checks against the document that scope actually deploys", async () => {
    view();
    await waitFor(() => expect(listTrees).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: /Release/ }));
    // A workload with no image is what the chart's own schema refuses, and the
    // workload defaults to a Deployment whether or not anything was typed.
    expect(await screen.findByText(/No image.repository/)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("image.repository"), { target: { value: "nginx" } });
    await waitFor(() => expect(screen.queryByText(/No image.repository/)).not.toBeInTheDocument());
  });

  it("opens the tree the list row names", async () => {
    const tree = saved({ releases: [{ id: "r1", name: "storefront", features: {} }] });
    listTrees.mockResolvedValue({ trees: [tree], defaults });
    view();
    fireEvent.click(await screen.findByText("Dev User #1"));
    expect(screen.getByLabelText("Release name")).toHaveValue("storefront");
  });
});
