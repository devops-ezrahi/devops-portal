import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ArgocdTree } from "../../../server/types";
import { buildTree } from "./tree";
import { defaultValues } from "./catalog";

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
    const listed = () => document.querySelector(".ag-problems")?.textContent ?? "";
    const onCard = () => document.querySelector('[data-feature-card="image"] .ag-feature-problems')?.textContent ?? "";
    // Base is not what deploys — the converter writes the repository beside
    // each namespace's tag — so base alone missing one is not a problem.
    expect(listed()).not.toMatch(/No image.repository/);

    // A namespace is: a workload with no image is what the chart's own schema
    // refuses, and the workload defaults to a Deployment whether or not
    // anything was typed. It is said twice on purpose — once in the list under
    // the form, once on the Image card itself — so both places are asserted.
    fireEvent.click(screen.getByRole("button", { name: /Namespace/ }));
    rename("namespace", "shop-web");
    await waitFor(() => expect(listed()).toMatch(/No image.repository/));
    expect(onCard()).toMatch(/No image.repository/);

    fireEvent.change(screen.getByLabelText("image.repository"), { target: { value: "nginx" } });
    await waitFor(() => expect(listed()).not.toMatch(/No image.repository/));
    expect(onCard()).toBe("");
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
    // A Route only prod sets is prod's one source of truth, not a second copy
    // of anything base says — so it is not counted as an override.
    expect(tile).not.toHaveTextContent("overridden in");

    // The Route exists only in prod, so it is on the card as an override —
    // dashed, and naming the namespace that adds it.
    const route = [...tile.querySelectorAll(".ag-chip")].find((c) => c.textContent === "Route")!;
    expect(route).toHaveClass("added");
    expect(route).toHaveAttribute("title", expect.stringContaining("prod"));
    // From base there is nothing of it to open, so it is not pressable there…
    expect(route).not.toHaveClass("linked");

    // …but it is from prod, where the Route's fields are.
    fireEvent.click(card("Layers", /prod/));
    const inProd = card("Microservices", /storefront/);
    expect([...inProd.querySelectorAll(".ag-chip")].find((c) => c.textContent === "Route")).toHaveClass("linked");
    // prod deploys base's tag; a namespace is where the tag is worth showing.
    expect(inProd).toHaveTextContent("ghcr.io/shop/storefront:2.1.0");
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

    // On a namespace layer, the features that actually differ from base are
    // outlined, and carry the override tag that opens the way back out.
    fireEvent.click(card("Layers", /prod/));
    const imageCard = screen.getByText("Image & pull secrets", { selector: ".ag-feature-name" }).closest(".ag-feature")!;
    expect(imageCard.classList.contains("overridden")).toBe(true);
    expect(imageCard.querySelector(".ag-override-tag")).not.toBeNull();
  });

  it("says what the override light means, and takes the override back out", async () => {
    const tree = saved({
      releases: [{ id: "r1", name: "storefront", features: { image: { on: true, v: { repository: "nginx", tag: "1.0.0" } } } }],
      namespaces: [{ name: "prod", releases: [{ release: "r1", features: { image: { on: true, v: { tag: "2.0.0", pullPolicy: "Always" } } } }] }],
    });
    listTrees.mockResolvedValue({ trees: [tree], defaults, gitEnabled: true });
    view();
    fireEvent.click(await screen.findByText("Dev User #1"));
    fireEvent.click(card("Layers", /prod/));

    const imageCard = feature("Image & pull secrets");
    // The light is the button — the explanation and the way out hang off it.
    fireEvent.click(within(imageCard).getByRole("button", { name: /What is the override on Image & pull secrets/ }));
    expect(within(imageCard).getByText(/two sources for one value/)).toBeInTheDocument();

    fireEvent.click(within(imageCard).getByRole("button", { name: "Remove override" }));

    // The light goes out, and prod's file no longer carries the tag.
    expect(feature("Image & pull secrets").querySelector(".ag-override-tag")).toBeNull();
    fireEvent.click(screen.getByLabelText("prod/values/storefront.yaml"));
    expect(document.querySelector(".ag-file-body")!.textContent).not.toContain("2.0.0");
    // Only the second copy went: a value only prod sets is not an override.
    expect(document.querySelector(".ag-file-body")!.textContent).toContain("pullPolicy: Always");
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
    // Not a tag: those stay per namespace even when every namespace agrees.
    const pinned = { on: true, v: { pullPolicy: "Always" } };
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
    expect(document.querySelector(".ag-file-body")!.textContent).toContain("Always");
    fireEvent.click(screen.getByLabelText("prod/values/storefront.yaml"));
    expect(document.querySelector(".ag-file-body")!.textContent).not.toContain("Always");
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
  it("opens the preview on what this tree would change in the repository", async () => {
    const tree = saved({
      releases: [{ id: "r1", name: "storefront", features: { image: { on: true, v: { repository: "nginx" } } } }],
    });
    // The branch as it stands: this tree's own files, one of them stale. What
    // the preview must say is "one file moves", not "here are three files".
    const generated = buildTree(tree);
    const repo = generated.map((f, i) => ({ path: f.path, text: i === 0 ? "# stale\n" : f.text }));
    listTrees.mockResolvedValue({ trees: [tree], defaults, gitEnabled: true });
    pullValues.mockResolvedValue({ files: repo, repoUrl: tree.values.repoUrl });

    vi.useFakeTimers({ shouldAdvanceTime: true });
    view();
    fireEvent.click(await screen.findByText("Dev User #1"));
    // The baseline clone is debounced — one per connection, not one per keystroke.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });

    expect(pullValues).toHaveBeenCalledWith(tree.values.repoUrl, "main", "");
    expect(screen.getByRole("heading", { name: /Changes vs the repository \(1\)/ })).toBeInTheDocument();
    expect(document.querySelectorAll(".ag-file")).toHaveLength(1);
    expect(screen.getByLabelText(`${generated[0].path} (modified)`)).toBeInTheDocument();
    // The pane is a diff, not the file: the line the repo has, and the ones it gains.
    const pane = document.querySelector(".ag-diff")!;
    expect(pane.textContent).toContain("-# stale");
    expect(pane.textContent).toContain("+# Generated by the portal");

    // The button names the list it switches to; the heading says which is on screen.
    fireEvent.click(screen.getByRole("button", { name: `All files (${generated.length})` }));
    expect(screen.getByRole("heading", { name: `All files (${generated.length})` })).toBeInTheDocument();
    expect(document.querySelectorAll(".ag-file")).toHaveLength(generated.length);
    vi.useRealTimers();
  });
  it("wires a claim into the pod in one press, and then suggests it to a mount", async () => {
    view();
    await waitFor(() => expect(listTrees).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: /Microservice/ }));
    fireEvent.click(screen.getByRole("button", { name: /Storage/ }));

    const pvc = feature("PersistentVolumeClaims");
    fireEvent.click(pvc.querySelector("input[type=checkbox]")!);
    // `name` is the entry's first column.
    fireEvent.change(pvc.querySelector(".ag-entry input")!, { target: { value: "app-data" } });

    // A claim nothing mounts is storage the pod never sees, and wiring it up by
    // hand is a volume in one feature and a mount in another.
    fireEvent.click(within(feature("PersistentVolumeClaims")).getByRole("button", { name: /Mount this/ }));

    const volume = within(feature("Volumes"));
    expect(volume.getByText("app-data", { selector: ".ag-entry-title" })).toBeInTheDocument();
    expect(volume.getByDisplayValue("persistentVolumeClaim")).toBeInTheDocument();

    const mount = within(feature("Volume mounts"));
    expect(mount.getByText("app-data", { selector: ".ag-entry-title" })).toBeInTheDocument();
    // Once taken the offer stays, disabled, saying it was — and a claim is not
    // settings, so it is never offered as env vars.
    expect(within(feature("PersistentVolumeClaims")).queryByRole("button", { name: /Mount this/ })).toBeNull();
    expect(within(feature("PersistentVolumeClaims")).getByRole("button", { name: /Mounted/ })).toBeDisabled();
    expect(within(feature("PersistentVolumeClaims")).queryByRole("button", { name: /env vars/ })).toBeNull();

    // And the mount's name offers what this release declares — a suggestion, so
    // an object the chart does not create can still be typed in.
    const name = mount.getAllByDisplayValue("app-data")[0] as HTMLInputElement;
    const list = document.getElementById(name.getAttribute("list") ?? "");
    expect([...(list?.querySelectorAll("option") ?? [])].map((o) => o.getAttribute("value"))).toEqual(["app-data"]);
  });

  it("pulls a ConfigMap in as env vars in one press, and says when it already is", async () => {
    view();
    await waitFor(() => expect(listTrees).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: /Microservice/ }));
    fireEvent.click(
      screen.getAllByRole("button", { name: /Config/ }).find((b) => b.classList.contains("ag-category-head"))!
    );
    const maps = feature("ConfigMaps");
    fireEvent.click(maps.querySelector("input[type=checkbox]")!);
    fireEvent.change(maps.querySelector(".ag-entry input")!, { target: { value: "app-config" } });

    fireEvent.click(within(feature("ConfigMaps")).getByRole("button", { name: /Use as env vars/ }));

    expect(within(feature("envFrom")).getByText("app-config", { selector: ".ag-entry-title" })).toBeInTheDocument();
    expect(within(feature("envFrom")).getByDisplayValue("configMapRef")).toBeInTheDocument();
    expect(within(feature("ConfigMaps")).getByRole("button", { name: /In env/ })).toBeDisabled();
  });

  it("says a per-namespace value on the field it is about, and jumps there once", async () => {
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    const tree = saved({
      releases: [{ id: "r1", name: "storefront", features: { image: { on: true, v: { repository: "nginx", tag: "1.0.0" } } } }],
      namespaces: [{ name: "prod", releases: [] }],
    });
    listTrees.mockResolvedValue({ trees: [tree], defaults, gitEnabled: true });
    view();
    fireEvent.click(await screen.findByText("Dev User #1"));

    // The card up top used to be the only place this was said.
    const imageCard = document.querySelector('[data-feature-card="image"]')!;
    expect(imageCard.querySelector(".ag-feature-problems")!.textContent).toMatch(/image\.tag is set in base/);
    expect(imageCard.classList.contains("has-warn")).toBe(true);

    // Pressing it in the list scrolls to that card — once. Selecting a layer
    // remounts the editor, and must not replay the jump.
    fireEvent.click(within(document.querySelector(".ag-problems") as HTMLElement).getByRole("button", { name: /image\.tag/ }));
    await waitFor(() => expect(scroll).toHaveBeenCalledTimes(1));
    fireEvent.click(card("Layers", /prod/));
    await new Promise((r) => setTimeout(r, 150));
    expect(scroll).toHaveBeenCalledTimes(1);

    // The card's own warning takes you back to base, where the warning is.
    fireEvent.click(document.querySelector(".ag-card-warn")!);
    expect(screen.getByText("Base — storefront", { selector: "h3" })).toBeInTheDocument();
    await waitFor(() => expect(scroll).toHaveBeenCalledTimes(2));
    delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  });

  it("adds the shared release once, and it runs no pods", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    view();
    await waitFor(() => expect(listTrees).toHaveBeenCalled());

    fireEvent.click(screen.getByRole("button", { name: /Shared/ }));
    // Its name is the convention — the converter writes `shared`, and the
    // microservices beside it reference those objects by that name.
    expect(screen.getByLabelText("workload.type")).toHaveValue("none");
    expect(screen.queryByRole("button", { name: /Shared/ })).toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(createTree.mock.calls[0][0].releases[0]).toMatchObject({
      name: "shared",
      features: { workload: { on: true, v: { type: "none" } }, service: { on: true, v: { enabled: false } } },
    });
    vi.useRealTimers();
  });

  it("sets a namespace's defaults once, for every microservice in it", async () => {
    view();
    await waitFor(() => expect(listTrees).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: /Microservice/ }));
    rename("microservice", "checkout");
    // Leave the name field, or the card is still an <input> and not a button.
    fireEvent.blur(screen.getByLabelText("Microservice name"));
    // Base is the same everywhere, so it has no defaults to offer.
    expect(screen.queryByRole("button", { name: /defaults/ })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Namespace/ }));
    rename("namespace", "prod");
    fireEvent.blur(screen.getByLabelText("Namespace name"));

    // One bar above the microservices, for every one of them in prod.
    fireEvent.click(screen.getByRole("button", { name: /^prod defaults/ }));
    expect(screen.getByText("prod defaults", { selector: "h3" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Identity & Observability/ }));
    const sa = feature("ServiceAccount");
    fireEvent.click(sa.querySelector("input[type=checkbox]")!);
    fireEvent.click(within(feature("ServiceAccount")).getByRole("button", { name: /imagePullSecrets/ }));
    fireEvent.change(screen.getByLabelText("imagePullSecrets"), { target: { value: "regcred" } });

    // It lands in prod's own defaults.yaml, not in the microservice's base.
    const shown = () => document.querySelector(".ag-file-body")?.textContent ?? "";
    fireEvent.click(screen.getByLabelText("base/checkout.yaml"));
    expect(shown()).not.toContain("regcred");
    fireEvent.click(screen.getByLabelText("prod/defaults.yaml"));
    expect(shown()).toContain("regcred");

    // ...and checkout in prod shows it greyed, with the way back to where it is set.
    fireEvent.click(card("Microservices", /checkout/));
    const inherited = feature("ServiceAccount").querySelector(".ag-inherited")!;
    expect(inherited.textContent).toContain("regcred");
    fireEvent.click(within(inherited as HTMLElement).getByRole("button", { name: /prod defaults/ }));
    expect(screen.getByText("prod defaults", { selector: "h3" })).toBeInTheDocument();

    // Choosing Base leaves the defaults, which base does not have.
    fireEvent.click(card("Layers", /Base/));
    expect(screen.queryByRole("button", { name: /^prod defaults/ })).toBeNull();
  });

  it("moves Defaults saved tree-wide onto each namespace", async () => {
    const tree = saved({
      releases: [{ id: "r1", name: "checkout", features: { workload: { on: true, v: { type: "deployment" } } } }],
      namespaces: [
        { name: "dev", releases: [] },
        { name: "prod", releases: [] },
      ],
      defaults: { features: { serviceaccount: { on: true, v: { create: true, imagePullSecrets: "regcred" } } } },
    });
    listTrees.mockResolvedValue({ trees: [tree], defaults, gitEnabled: true });
    view();
    fireEvent.click(await screen.findByText("Dev User #1"));
    const shown = () => document.querySelector(".ag-file-body")?.textContent ?? "";
    ["dev", "prod"].forEach((ns) => {
      fireEvent.click(screen.getByLabelText(`${ns}/defaults.yaml`));
      expect(shown()).toContain("regcred");
    });
  });

  it("puts a field back on the optional list", async () => {
    view();
    await waitFor(() => expect(listTrees).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: /Microservice/ }));
    rename("microservice", "storefront");

    fireEvent.click(screen.getByRole("button", { name: /image\.pullPolicy/ }));
    fireEvent.change(screen.getByLabelText("image.pullPolicy"), { target: { value: "Always" } });

    // Removing it is the way back out: the field goes, and so does what was
    // typed into it — otherwise it would still be emitting from a field nobody
    // can see.
    fireEvent.click(screen.getByRole("button", { name: "Remove image.pullPolicy" }));
    expect(screen.queryByLabelText("image.pullPolicy")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /image\.pullPolicy/ })).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("base/storefront.yaml"));
    expect(document.querySelector(".ag-file-body")!.textContent).not.toContain("Always");
  });

  it("lights a namespace override only when it puts something in the file", async () => {
    const tree = saved({
      releases: [
        {
          id: "r1",
          name: "storefront",
          features: {
            image: { on: true, v: { repository: "ghcr.io/shop/storefront" } },
            route: { on: true, v: { ...defaultValues("route"), host: "shop.example.com" } },
          },
        },
      ],
      namespaces: [{ name: "prod", releases: [] }],
    });
    listTrees.mockResolvedValue({ trees: [tree], defaults, gitEnabled: true });
    view();
    fireEvent.click(await screen.findByText("Dev User #1"));
    fireEvent.click(card("Layers", /prod/));
    // Networking is already open: the greyed base values under this layer are
    // what decides which categories a namespace override lands on.

    // Ticking a feature on writes the chart's own answers into the layer, and
    // every one of them is already what base says — so the override file is
    // empty and there is nothing to warn about.
    const route = () => feature("OpenShift Route");
    fireEvent.click(route().querySelector("input[type=checkbox]")!);
    const light = () => within(route()).queryByRole("button", { name: /override on OpenShift Route/ });
    expect(light()).toBeNull();

    // A value that really differs is a second copy to keep in step, and says so.
    fireEvent.change(within(route()).getByLabelText("host"), { target: { value: "shop.prod.example.com" } });
    expect(light()).not.toBeNull();
  });

  it("offers nameOverride per namespace, not in base — but still shows one base already has", async () => {
    const tree = saved({
      releases: [{ id: "r1", name: "storefront", features: { identity: { on: true, v: {} } } }],
      namespaces: [{ name: "prod", releases: [] }],
    });
    listTrees.mockResolvedValue({ trees: [tree], defaults, gitEnabled: true });
    view();
    fireEvent.click(await screen.findByText("Dev User #1"));

    // Base cannot set it at all — not on screen, and not on the add list
    // either. The object names belong to an environment.
    const identity = () => document.querySelector('[data-feature-card="identity"]')!;
    expect(identity().textContent).not.toContain("nameOverride");

    fireEvent.click(card("Layers", /prod/));
    expect(identity().textContent).toContain("nameOverride");

    // An imported tree can still carry one in base, and a value that deploys
    // while nothing on screen admits to it is worse than a field in an odd place.
    const withOne = saved({
      id: "AG-0002",
      name: "Imported",
      releases: [{ id: "r1", name: "storefront", features: { identity: { on: true, v: { nameOverride: "checkout-api" } } } }],
      namespaces: [{ name: "prod", releases: [] }],
    });
    listTrees.mockResolvedValue({ trees: [withOne], defaults, gitEnabled: true });
    view();
    fireEvent.click(await screen.findByText("Imported"));
    expect(identity().textContent).toContain("nameOverride");
    expect(screen.getByDisplayValue("checkout-api")).toBeInTheDocument();
  });
});
