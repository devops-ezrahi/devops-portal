import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ArgocdTree } from "../../../server/types";

const listTrees = vi.fn();
const createTree = vi.fn();
const updateTree = vi.fn();
const deleteTree = vi.fn();
const pullValues = vi.fn();
const pushTree = vi.fn();

vi.mock("./api", () => ({ listTrees, createTree, updateTree, deleteTree, pullValues, pushTree }));

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

/**
 * A tile in one of the two grids. Its own pencil and × carry the same name, so
 * the role query alone matches three buttons — the card is the one with the
 * card class on it.
 */
const card = (grid: "Microservices" | "Layers", name: RegExp) =>
  within(screen.getByLabelText(grid))
    .getAllByRole("button", { name })
    .find((b) => b.classList.contains("ag-card")) as HTMLElement;

/**
 * Name a card. A card's name is text with a pencil beside it, so it has to be
 * opened before it can be typed into — the same shape the tree's own name and a
 * ticket's title use.
 */
function rename(what: "microservice" | "namespace", value: string, current = `this ${what}`) {
  fireEvent.click(screen.getByRole("button", { name: `Rename ${current}` }));
  const label = what === "microservice" ? "Microservice name" : "Namespace name";
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  listTrees.mockResolvedValue({ trees: [], defaults, gitEnabled: true });
  createTree.mockImplementation((input) => Promise.resolve({ tree: { ...saved(), ...input } }));
  updateTree.mockImplementation((id, input) => Promise.resolve({ tree: { ...saved(), ...input, id } }));
});

describe("ArgocdView", () => {
  it("pre-fills a new tree from the configured repositories", async () => {
    view();
    await waitFor(() => expect(listTrees).toHaveBeenCalled());
    // The values repo is the panel — it is where a commit goes — and opening it
    // shows the destination fields.
    fireEvent.click(screen.getByRole("button", { name: /Values.*values.*@main/s }));
    expect(screen.getByDisplayValue(defaults.valuesRepoUrl)).toBeInTheDocument();

    // The chart is one line with a pencil, not an equal half of a disclosure:
    // it is set once per organisation and read forever.
    expect(screen.queryByDisplayValue(defaults.chartRepoUrl)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Change the chart/ }));
    expect(screen.getByDisplayValue(defaults.chartRepoUrl)).toBeInTheDocument();
  });

  it("shows the required features without a tick, and defaulted fields only on request", async () => {
    view();
    await waitFor(() => expect(listTrees).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: /Microservice/ }));

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

    fireEvent.click(screen.getByRole("button", { name: /Microservice/ }));
    rename("microservice", "api-gateway");
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
    fireEvent.click(screen.getByRole("button", { name: /Microservice/ }));
    rename("microservice", "api-gateway");
    fireEvent.change(screen.getByLabelText("image.tag"), { target: { value: "1.0.0" } });

    fireEvent.click(screen.getByRole("button", { name: /Namespace/ }));
    rename("namespace", "shop-web");
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
    fireEvent.click(screen.getByRole("button", { name: /Microservice/ }));
    // A workload with no image is what the chart's own schema refuses, and the
    // workload defaults to a Deployment whether or not anything was typed.
    expect(await screen.findByText(/No image.repository/)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("image.repository"), { target: { value: "nginx" } });
    await waitFor(() => expect(screen.queryByText(/No image.repository/)).not.toBeInTheDocument());
  });

  it("says on the card what each release deploys, and what only a namespace adds", async () => {
    const tree = saved({
      releases: [
        {
          id: "r1",
          name: "storefront",
          features: {
            image: { on: true, v: { repository: "ghcr.io/shop/storefront", tag: "2.1.0" } },
            service: { on: true, v: {} },
            configmaps: { on: true, v: { items: [{ name: "app-config", data: "LOG_LEVEL=info" }] } },
          },
        },
      ],
      namespaces: [{ name: "prod", releases: [{ release: "r1", features: { route: { on: true, v: { host: "shop.example.com" } } } }] }],
    });
    listTrees.mockResolvedValue({ trees: [tree], defaults, gitEnabled: true });
    view();
    fireEvent.click(await screen.findByText("Dev User #1"));

    // Scoped to the grid: the file preview lists a `storefront.yaml` per layer.
    const tile = card("Microservices", /storefront/);
    expect(tile).toHaveTextContent("ghcr.io/shop/storefront:2.1.0");
    // The workload nobody typed: the chart defaults to a Deployment.
    ["Deployment", "Service", "ConfigMap"].forEach((kind) => expect(tile).toHaveTextContent(kind));
    expect(tile).toHaveTextContent("overridden in 1 of 1 namespaces");

    // The Route exists only in prod, so it is on the card as an override —
    // dashed, and naming the namespace that adds it.
    const route = [...tile.querySelectorAll(".ag-chip")].find((c) => c.textContent === "Route")!;
    expect(route).toHaveClass("added");
    expect(route).toHaveAttribute("title", expect.stringContaining("prod"));
  });

  it("connects a repository, reads the chart out of it, and commits back", async () => {
    // A minimal values repo: one release, and the root ApplicationSet that
    // records which chart renders it.
    const files = [
      {
        path: "base/checkout.yaml",
        text: ["image:", "  repository: ghcr.io/shop/checkout", "  tag: 3.0.0", ""].join("\n"),
      },
      {
        path: "root-applicationSet.yaml",
        text: [
          "apiVersion: argoproj.io/v1alpha1",
          "kind: ApplicationSet",
          "metadata:",
          "  name: shop-root-set",
          "spec:",
          "  generators:",
          "    - git:",
          "        repoURL: https://github.com/org/values.git",
          "        revision: main",
          "  template:",
          "    spec:",
          "      sources:",
          "        - repoURL: https://github.com/org/universal-chart.git",
          "          targetRevision: v2.1.0",
          "          path: ms-applicationSet",
          "",
        ].join("\n"),
      },
    ];
    // The server rewrote the SSH URL it was given before cloning, and hands
    // back the one that actually worked.
    pullValues.mockResolvedValue({ files, repoUrl: "https://github.com/org/values.git" });
    pushTree.mockResolvedValue({ branch: "portal/argocd-ag-0001", changed: true, prUrl: "https://github.com/org/values/pull/7" });

    vi.useFakeTimers({ shouldAdvanceTime: true });
    view();
    await waitFor(() => expect(listTrees).toHaveBeenCalled());

    fireEvent.click(screen.getByRole("button", { name: /New/ }));
    fireEvent.click(screen.getByRole("button", { name: /Connect a repository/ }));
    fireEvent.change(screen.getByLabelText(/Repository URL/), {
      target: { value: "git@github.com:org/values.git" },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    });

    // What was pasted is SSH; what is sent is the https form, because the
    // portal authenticates with a token rather than a key.
    expect(pullValues).toHaveBeenCalledWith("https://github.com/org/values.git", "main", "");

    // The release came out of base/, and the chart came out of the root
    // ApplicationSet — nobody typed either.
    const tile = card("Microservices", /checkout/);
    expect(tile).toHaveTextContent("ghcr.io/shop/checkout:3.0.0");
    expect(screen.getByText(/universal-chart/)).toHaveTextContent("@v2.1.0");

    // Committing waits for the autosave that mints the id — the push writes the
    // stored tree, so it cannot run before there is one.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Commit/ }));
    });
    expect(pushTree).toHaveBeenCalledTimes(1);
    expect(pushTree.mock.calls[0][0]).toBe("AG-0001");
    expect(pushTree.mock.calls[0][1].map((f: { path: string }) => f.path)).toContain("base/checkout.yaml");
    expect(await screen.findByText(/Open the pull request/)).toHaveAttribute(
      "href",
      "https://github.com/org/values/pull/7"
    );
    vi.useRealTimers();
  });

  it("takes you to the fields a chip is about, and marks what a namespace overrides", async () => {
    const tree = saved({
      releases: [
        {
          id: "r1",
          name: "storefront",
          features: {
            image: { on: true, v: { repository: "nginx", tag: "1.0.0" } },
            hpa: { on: true, v: { minReplicas: "2", maxReplicas: "8" } },
          },
        },
      ],
      namespaces: [
        { name: "prod", releases: [{ release: "r1", features: { image: { on: true, v: { tag: "2.0.0" } } } }] },
      ],
    });
    listTrees.mockResolvedValue({ trees: [tree], defaults, gitEnabled: true });
    view();
    fireEvent.click(await screen.findByText("Dev User #1"));

    // Scrolling is jsdom's blind spot, so what is asserted is the half that
    // makes the scroll possible: the chip reopens the category holding it.
    // A category that already holds something opens on mount, so collapse it
    // first — which is exactly the state someone tidying the page leaves.
    fireEvent.click(screen.getByRole("button", { name: /Scaling & Availability/ }));
    expect(screen.queryByText("HorizontalPodAutoscaler", { selector: ".ag-feature-name" })).not.toBeInTheDocument();

    const grid = screen.getByLabelText("Microservices");
    fireEvent.click(within(grid).getByText("HorizontalPodAutoscaler"));
    expect(await screen.findByText("HorizontalPodAutoscaler", { selector: ".ag-feature-name" })).toBeInTheDocument();

    // On a namespace layer, the features that actually differ from base carry
    // the same dot the namespace tile does.
    fireEvent.click(card("Layers", /prod/));
    const dotted = document.querySelectorAll(".ag-feature .ag-dot");
    expect(dotted.length).toBeGreaterThan(0);
    const imageCard = screen.getByText("Image & pull secrets", { selector: ".ag-feature-name" }).closest(".ag-feature")!;
    expect(imageCard.querySelector(".ag-dot")).not.toBeNull();
  });

  it("says what the override light means, and takes the override back out", async () => {
    const tree = saved({
      releases: [{ id: "r1", name: "storefront", features: { image: { on: true, v: { repository: "nginx", tag: "1.0.0" } } } }],
      namespaces: [{ name: "prod", releases: [{ release: "r1", features: { image: { on: true, v: { tag: "2.0.0" } } } }] }],
    });
    listTrees.mockResolvedValue({ trees: [tree], defaults, gitEnabled: true });
    view();
    fireEvent.click(await screen.findByText("Dev User #1"));
    fireEvent.click(card("Layers", /prod/));

    const imageCard = feature("Image & pull secrets");
    // The light is the button — the explanation and the way out hang off it.
    fireEvent.click(within(imageCard).getByRole("button", { name: /What is the override on Image & pull secrets/ }));
    expect(within(imageCard).getByText(/deploys its own value instead of the base one/)).toBeInTheDocument();

    fireEvent.mouseDown(within(imageCard).getByRole("button", { name: "Remove override" }));

    // The light goes out, and prod's file no longer carries the tag.
    expect(feature("Image & pull secrets").querySelector(".ag-dot")).toBeNull();
    fireEvent.click(screen.getByLabelText("prod/values/storefront.yaml"));
    expect(document.querySelector(".ag-file-body")!.textContent).not.toContain("2.0.0");
  });

  it("never offers `enabled` as an optional field — ticking the feature is what sets it", async () => {
    view();
    await waitFor(() => expect(listTrees).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: /Microservice/ }));
    rename("microservice", "api-gateway");

    fireEvent.click(screen.getByRole("button", { name: /Networking/ }));
    fireEvent.click(within(feature("Service")).getByRole("checkbox"));

    expect(within(feature("Service")).queryByRole("button", { name: /enabled/ })).toBeNull();
    expect(within(feature("Service")).getByRole("checkbox")).toBeChecked();
    fireEvent.click(screen.getByLabelText("base/api-gateway.yaml"));
    expect(document.querySelector(".ag-file-body")!.textContent).toContain("enabled: true");
  });

  it("clears a stale `enabled: false` when the feature is ticked back on", async () => {
    // An imported document can carry one, and a feature switched on while it
    // sits underneath renders nothing at all.
    const tree = saved({
      releases: [
        {
          id: "r1",
          name: "storefront",
          features: { service: { on: true, v: { enabled: false, ports: "http=80:http" } } },
        },
      ],
    });
    listTrees.mockResolvedValue({ trees: [tree], defaults, gitEnabled: true });
    view();
    fireEvent.click(await screen.findByText("Dev User #1"));

    const tick = () => within(feature("Service")).getAllByRole("checkbox")[0] as HTMLInputElement;
    // The false itself stays on screen — an invisible one is worse than a wrong one.
    expect(within(feature("Service")).getByLabelText("enabled")).not.toBeChecked();
    fireEvent.click(tick());
    fireEvent.click(tick());

    // Back to the chart's own answer, so the field drops off the card entirely
    // — and the file says what the tick means.
    expect(within(feature("Service")).queryByLabelText("enabled")).toBeNull();
    fireEvent.click(screen.getByLabelText("base/storefront.yaml"));
    const yaml = document.querySelector(".ag-file-body")!.textContent!;
    expect(yaml).toContain("enabled: true");
    expect(yaml).not.toContain("enabled: false");
  });

  it("offers to move a value every namespace repeats down into the base", async () => {
    const pinned = { on: true, v: { tag: "9.9.9" } };
    const tree = saved({
      releases: [{ id: "r1", name: "storefront", features: { image: { on: true, v: { repository: "nginx" } } } }],
      namespaces: [
        { name: "dev", releases: [{ release: "r1", features: { image: pinned } }] },
        { name: "prod", releases: [{ release: "r1", features: { image: pinned } }] },
      ],
    });
    listTrees.mockResolvedValue({ trees: [tree], defaults, gitEnabled: true });
    view();
    fireEvent.click(await screen.findByText("Dev User #1"));

    expect(await screen.findByText(/written out 2 times/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Move to base" }));

    // The base file gained it and both namespace files lost it.
    fireEvent.click(screen.getByLabelText("base/storefront.yaml"));
    expect(document.querySelector(".ag-file-body")!.textContent).toContain("9.9.9");
    fireEvent.click(screen.getByLabelText("prod/values/storefront.yaml"));
    expect(document.querySelector(".ag-file-body")!.textContent).not.toContain("9.9.9");
    // ...and the offer is gone, because there is nothing left to move.
    expect(screen.queryByText(/written out 2 times/)).not.toBeInTheDocument();
  });

  it("opens the tree the list row names", async () => {
    const tree = saved({ releases: [{ id: "r1", name: "storefront", features: {} }] });
    listTrees.mockResolvedValue({ trees: [tree], defaults, gitEnabled: true });
    view();
    fireEvent.click(await screen.findByText("Dev User #1"));
    fireEvent.click(screen.getByRole("button", { name: "Rename storefront" }));
    expect(screen.getByLabelText("Microservice name")).toHaveValue("storefront");
  });
});
