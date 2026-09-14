import { zipSync, strToU8 } from "fflate";
import {
  ArrowDownToLine,
  Check,
  ChevronDown,
  ChevronRight,
  FileUp,
  Pencil,
  Plus,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ModuleViewProps } from "../../moduleTypes";
import type { ArgocdTree } from "../../../server/types";
import { log, error as logError } from "../../log";
import {
  createTree,
  deleteTree,
  listTrees,
  pullValues,
  pushTree,
  updateTree,
  type RepoFile,
  type TreeDefaults,
} from "./api";
import { buildValues, extraValuesError, parseValues } from "./build";
import { checkValues } from "./checks";
import { BY_ID, featureForPath } from "./catalog";
import { deepMerge, obj, subtractDefaults } from "./values";
import { buildTree } from "./tree";
import {
  SHARED_RELEASE_NAME,
  isEmptyTree,
  newNamespace,
  newRelease,
  newSharedRelease,
  newTree,
  toInput,
  type DraftTree,
} from "./document";
import { Help } from "../../Help";
import { addedKinds, resourcesOf } from "./resources";
import { applyPromotion, findEnvSpecific, findPromotions } from "./promote";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { FeatureEditor, type Inherited } from "./components/FeatureEditor";
import { FilePreview } from "./components/FilePreview";
import { ImportDialog } from "./components/ImportDialog";
import { ChartLine } from "./components/ChartLine";
import { LayerGrid, type LayerCard } from "./components/LayerGrid";
import { NewTreeDialog } from "./components/NewTreeDialog";
import { CommitButton, PushResult, RepoPanel, repoName, type PushState } from "./components/RepoPanel";
import { ReleaseGrid, type ReleaseCard } from "./components/ReleaseGrid";
import { TreeList } from "./components/TreeList";
import type { FeatureState } from "./catalog";
import type { ImportResult } from "./import";
import { importTree, type TreeImport } from "./importTree";
import { toYaml } from "./yaml";

/** The tree the Refresh button (and a page reload) reopens. */
const LAST_OPENED_KEY = "argocd.lastOpened";

/** How long to sit on a change before writing it. One keystroke is not an edit. */
const AUTOSAVE_MS = 800;

type SaveState = "idle" | "saving" | "saved" | "error";

/**
 * Which layer the form is editing: the release's base, or one namespace's
 * overrides. It is the namespace's *index*, not its name — a namespace is named
 * after it is added, and an unnamed one has to be selectable to be named.
 */
const BASE = -1;

/**
 * `releaseId` when the form is editing the tree's defaults rather than a
 * microservice. A sentinel rather than a third piece of state: the defaults are
 * a scope like any other to everything downstream of `patchScope`, and a second
 * flag would have to be cleared everywhere the release is set.
 */
const DEFAULTS = "__defaults";

/** The repo's own name, and nothing if it has none to give. */
const repoLabel = (url: string): string => {
  const name = repoName(url);
  return name === "not set" ? "" : name;
};

export function ArgocdView({ user, isAdmin, refreshKey, onError }: ModuleViewProps) {
  const [trees, setTrees] = useState<ArgocdTree[]>([]);
  const [defaults, setDefaults] = useState<TreeDefaults | undefined>();
  const [draft, setDraft] = useState<DraftTree>(() => newTree());
  const [releaseId, setReleaseId] = useState("");
  const [layer, setLayer] = useState<number>(BASE);
  const [showAll, setShowAll] = useState(true);
  const [naming, setNaming] = useState(false);
  const [repoOpen, setRepoOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  const [gitEnabled, setGitEnabled] = useState(false);
  const [pulling, setPulling] = useState(false);
  const [push, setPush] = useState<PushState>({ kind: "idle" });
  /** What the connected branch holds right now — the preview diffs against it. */
  const [repoFiles, setRepoFiles] = useState<RepoFile[] | undefined>();
  const [comparing, setComparing] = useState(false);
  /** Why there is no diff, when there was meant to be one. */
  const [baselineError, setBaselineError] = useState("");
  /** Set by a press on a card's chip; the editor opens that feature and scrolls to it. */
  const [jump, setJump] = useState<{ feature: string; n: number } | undefined>();
  /** A delete that would lose values, held until it is confirmed. */
  const [confirm, setConfirm] = useState<{ title: string; detail: string; run: () => void } | undefined>();
  const [saveState, setSaveState] = useState<SaveState>("idle");
  /** The id the next write should PUT to. A ref, because the write queue reads it after an await. */
  const idRef = useRef("");
  /** The JSON of what is already on the server, so a write that lands back in the same shape is not repeated. */
  const persisted = useRef("");
  /** One write at a time: a create must finish and hand back an id before the next PUT. */
  const queue = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    log("argocd", "view mounted / refreshed", { isAdmin, refreshKey });
    listTrees()
      .then((result) => {
        log("argocd", `trees loaded: ${result.trees.length}`);
        setTrees(result.trees);
        setDefaults(result.defaults);
        setGitEnabled(result.gitEnabled);
        // Reopen whatever was last open, so Refresh lands back where you were —
        // but never over a tree already opened by hand while this was in flight.
        const last = result.trees.find((t) => t.id === localStorage.getItem(LAST_OPENED_KEY));
        if (last && !idRef.current) handleOpen(last);
        else if (!idRef.current) setDraft((prev) => (prev.chart.repoUrl ? prev : newTree(result.defaults)));
      })
      .catch((err: Error) => {
        logError("argocd", "listTrees failed", err);
        onError(err.message);
      });
  }, [refreshKey]);

  /**
   * Read the connected branch so the preview can say what this tree would
   * actually change. It is the Pull button's clone, without the import: the
   * files come back and nothing in the draft is touched.
   *
   * Keyed on the connection rather than on the draft, so editing values does
   * not re-clone — and debounced, because the repo URL is a text field and one
   * clone per keystroke is not a thing to do to a git server.
   *
   * Deliberately *not* gated on `gitEnabled`, unlike the two buttons: reading a
   * public repo needs no credential, and gating it meant a portal with no
   * `ARGOCD_VALUES_TOKEN` never diffed anything. A read that fails carries its
   * reason to the preview — a diff that silently is not there reads as a
   * feature that does not work.
   */
  const { repoUrl, revision } = draft.values;
  const subPath = draft.values.path ?? "";
  useEffect(() => {
    setRepoFiles(undefined);
    setBaselineError("");
    if (!repoUrl.trim() || !revision.trim()) {
      setComparing(false);
      return;
    }
    setComparing(true);
    let live = true;
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const result = await pullValues(repoUrl, revision, subPath);
          if (live) setRepoFiles(result.files);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log("argocd", "no baseline to diff against", { message });
          if (live) setBaselineError(message);
        } finally {
          if (live) setComparing(false);
        }
      })();
    }, AUTOSAVE_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [repoUrl, revision, subPath]);

  // Admins get every tree from the server; the toggle narrows it back
  // client-side, same as every other list in the portal.
  const visibleTrees = useMemo(
    () => (isAdmin && !showAll ? trees.filter((t) => t.createdBy === user.id) : trees),
    [trees, showAll, isAdmin, user.id]
  );
  const files = useMemo(() => buildTree(draft), [draft]);
  const editingDefaults = releaseId === DEFAULTS;
  const release = editingDefaults ? undefined : (draft.releases.find((r) => r.id === releaseId) ?? draft.releases[0]);
  const namespace = layer === BASE ? undefined : draft.namespaces[layer];
  const nsEntry = namespace?.releases.find((e) => e.release === release?.id);
  const features =
    (editingDefaults ? draft.defaults?.features : layer === BASE ? release?.features : nsEntry?.features) ?? {};
  const extraValues =
    (editingDefaults ? draft.defaults?.extraValues : layer === BASE ? release?.extraValues : nsEntry?.extraValues) ?? "";
  const extraError = extraValuesError(extraValues);
  const scopeLabel = editingDefaults
    ? "every microservice"
    : layer === BASE
      ? "base"
      : namespace?.name.trim() || "this namespace";
  /** The tree's defaults as values — the bottom layer of every namespace's defaults.yaml. */
  const treeDefaultValues = useMemo(
    () => buildValues(draft.defaults?.features ?? {}, draft.defaults?.extraValues),
    [draft.defaults]
  );
  const defaultsCount = Object.keys(treeDefaultValues).length;

  /**
   * What each release rectangle says. Every figure on it comes from the *built*
   * document rather than from catalog state — a feature can be switched on and
   * still emit nothing, and an imported value has no feature state at all.
   * `resources.ts` carries that argument in full.
   */
  /**
   * Values *in* base that only an environment can answer. There
   * is no button on these — see the note on `findEnvSpecific` for why moving one
   * value into N namespaces unchanged would only be a promotion waiting to be
   * offered back.
   */
  const envSpecific = useMemo(() => findEnvSpecific(draft), [draft.releases, draft.namespaces]);

  const releaseCards = useMemo<ReleaseCard[]>(
    () =>
      draft.releases.map((r) => {
        const env = envSpecific.find((e) => e.releaseId === r.id);
        const base = buildValues(r.features, r.extraValues);
        const resources = resourcesOf(base);
        const image = obj(base.image);
        // Which namespaces add an object the base does not have. The card draws
        // those chips dashed rather than counting them as the release's own.
        const extras = new Map<string, string[]>();
        let overridden = 0;
        draft.namespaces.forEach((ns) => {
          const entry = ns.releases.find((e) => e.release === r.id);
          const override = entry ? buildValues(entry.features, entry.extraValues) : {};
          // An entry exists from the first keystroke in that layer; an empty
          // one writes an empty file and overrides nothing.
          if (!Object.keys(override).length) return;
          overridden += 1;
          const nsName = ns.name.trim() || "unnamed";
          addedKinds(resources, resourcesOf(deepMerge(base, override))).forEach((kind) =>
            extras.set(kind, [...(extras.get(kind) ?? []), nsName])
          );
        });
        return {
          id: r.id,
          name: r.name,
          image: [image.repository, image.tag].filter(Boolean).join(":"),
          resources,
          extras: [...extras].map(([kind, namespaces]) => ({ kind, namespaces })),
          overrides: { count: overridden, total: draft.namespaces.length },
          envSpecific: env && { paths: env.paths, namespaces: env.namespaces },
        };
      }),
    [draft.releases, draft.namespaces, envSpecific]
  );

  const layerCards = useMemo<LayerCard[]>(
    () =>
      draft.namespaces.map((ns) => {
        const overriding = ns.releases.filter((e) => Object.keys(buildValues(e.features, e.extraValues)).length);
        return {
          name: ns.name,
          overrides: overriding.length,
          overridesSelected: !!release && overriding.some((e) => e.release === release.id),
        };
      }),
    [draft.namespaces, release?.id]
  );
  /**
   * Values every namespace sets the same way. They are not overrides — they are
   * the base, written out once per namespace — so the page offers to move them
   * down a layer rather than leaving the same line to be edited N times.
   */
  const promotions = useMemo(() => findPromotions(draft), [draft.releases, draft.namespaces]);

  /**
   * Which features this layer actually changes. A namespace entry holds only
   * overrides by design, but a value typed and then typed back is still in the
   * map, and `subtractDefaults` drops it from the file — so "is in the entry"
   * is not the same question as "differs from base". This asks the second one,
   * against each feature's own emitted fragment.
   */
  const overriding = useMemo<Set<string>>(() => {
    const out = new Set<string>();
    if (layer === BASE || !release) return out;
    // Everything below this layer, in the order the chart reads it: the tree's
    // defaults, then this microservice's base over them.
    const below = deepMerge(treeDefaultValues, buildValues(release.features, release.extraValues));
    Object.entries(features).forEach(([id, state]) => {
      if (!state?.on) return;
      // The light means "this feature puts something in the override file",
      // never "this feature is ticked here". Ticking one on writes the chart's
      // own defaults into the layer, and `subtractDefaults` — the same call
      // that writes the file — drops every one of them again when what is
      // below already says so. A light on a feature whose override file is
      // empty warns about a second copy that does not exist.
      if (Object.keys(subtractDefaults(buildValues({ [id]: state }), below)).length) out.add(id);
    });
    return out;
  }, [features, release, layer, treeDefaultValues]);

  /**
   * What this layer inherits from the ones under it, so the whole deployed
   * document is readable in one place: base inherits the tree's defaults, a
   * namespace override inherits those *and* the microservice's base.
   */
  const inherited = useMemo<Record<string, Inherited> | undefined>(() => {
    if (editingDefaults) return undefined;
    const out: Record<string, Inherited> = {};
    Object.entries(draft.defaults?.features ?? {}).forEach(([id, state]) => {
      out[id] = { state, from: "defaults" };
    });
    if (layer === BASE) return out;
    if (!release) return undefined;
    // Each fragment says where it is editable, rather than the layer saying it
    // once: in a namespace override most of what shows comes from base, but a
    // feature only the tree's defaults set is not base's to change, and a link
    // that lands on the wrong scope is worse than no link.
    Object.entries(release.features).forEach(([id, state]) => {
      const under = out[id];
      out[id] = under ? { state: { on: under.state.on || state.on, v: deepMerge(under.state.v, state.v) }, from: "base" } : { state, from: "base" };
    });
    return out;
  }, [editingDefaults, layer, draft.defaults, release]);

  /**
   * The checks run on the document that is actually deployed for this scope —
   * base alone, or base with the namespace's overrides merged over it — and on
   * the *parsed* form of it, so a raw block and extra values are checked
   * exactly like a value typed into a field.
   */
  const problems = useMemo(() => {
    if (!release) return [];
    // The tree's defaults are under the base file in the chart's chain, so they
    // deploy here too — a check run without them misses the one nobody typed
    // on this card, which is exactly the kind this list exists to catch.
    const base = deepMerge(treeDefaultValues, buildValues(release.features, release.extraValues));
    const effective = layer === BASE ? base : deepMerge(base, buildValues(features, extraValues));
    const found = checkValues(parseValues(toYaml(effective)) ?? {});
    // Cluster-scoped objects belong to one release in the cluster, so a tree
    // that fans the same release out over several namespaces owns them twice.
    const clusterIds = Object.entries(release.features)
      .filter(([id, state]) => state.on && BY_ID[id]?.cluster)
      .map(([id]) => id);
    const clusterFeatures = clusterIds.map((id) => BY_ID[id].name);
    if (clusterFeatures.length && draft.namespaces.length > 1)
      found.push({
        level: "warn",
        text: `${clusterFeatures.join(", ")} are cluster-scoped, and this tree deploys ${release.name || "this release"} into ${draft.namespaces.length} namespaces — every one of them would own the same object.`,
        feature: clusterIds[0],
      });
    // Base values only an environment can answer. They used to be said only on
    // the microservice's card above, never beside the field holding them — so
    // they are problems like any other, shown in base and in each namespace
    // still taking base's value, which are the layers they are true of.
    const env = envSpecific.find((e) => e.releaseId === release.id);
    const nsName = namespace?.name.trim();
    if (env && (layer === BASE || (nsName && env.namespaces.includes(nsName))))
      env.paths.forEach((path) =>
        found.push({
          level: "warn",
          text: `${path} is set in base, so ${env.namespaces.join(", ")} ${
            env.namespaces.length === 1 ? "takes" : "take"
          } it as-is. Base is environment-agnostic — this usually belongs in each namespace's own file.`,
          feature: featureForPath(path),
        })
      );
    return found;
  }, [release, features, extraValues, layer, draft.namespaces.length, treeDefaultValues, envSpecific, namespace?.name]);

  function handleOpen(tree: ArgocdTree) {
    log("argocd", "opening tree", tree.id);
    localStorage.setItem(LAST_OPENED_KEY, tree.id);
    setDraft(tree);
    setReleaseId(tree.releases[0]?.id ?? "");
    setLayer(BASE);
    // It came from the server, so it is already written — otherwise merely
    // opening one would write it straight back.
    idRef.current = tree.id;
    persisted.current = JSON.stringify(toInput(tree));
    setSaveState("idle");
    setPush({ kind: "idle" });
  }

  function handleScratch() {
    log("argocd", "new tree");
    setNewOpen(false);
    setPush({ kind: "idle" });
    setDraft(newTree(defaults));
    setReleaseId("");
    setLayer(BASE);
    idRef.current = "";
    persisted.current = "";
    setSaveState("idle");
    localStorage.removeItem(LAST_OPENED_KEY);
  }

  /**
   * A repository the dialog just read. The tree it returns is the repo's own —
   * releases, namespaces, and the chart, which `importTree` recovers from
   * `root-applicationSet.yaml` rather than asking anybody to retype.
   *
   * Where to commit back to is the connection that was actually made, not the
   * one the root app records: the two normally agree, and when they do not, the
   * repo that was just cloned is the one this tree came out of.
   */
  function handleConnect(imported: TreeImport, repoUrl: string, revision: string, path: string) {
    log("argocd", "connected a repository", {
      repoUrl,
      releases: imported.releases.length,
      namespaces: imported.namespaces.length,
      warnings: imported.warnings.length,
    });
    setNewOpen(false);
    setPush({ kind: "idle" });
    const base = newTree(defaults);
    setDraft({
      ...base,
      // Named after the repository it came from. The server mints
      // `<author> #<n>` when a tree arrives without a name, and a list of
      // `Dev User #6` says nothing about what any of them deploy — where a
      // connected tree can say `argocd-example-values` outright.
      name: repoLabel(repoUrl),
      ...(imported.chart ? { chart: imported.chart } : {}),
      ...(imported.rootAppName ? { rootAppName: imported.rootAppName } : {}),
      values: { repoUrl, revision, path },
      releases: imported.releases,
      namespaces: imported.namespaces,
    });
    setReleaseId(imported.releases[0]?.id ?? "");
    setLayer(BASE);
    idRef.current = "";
    persisted.current = "";
    setSaveState("idle");
    localStorage.removeItem(LAST_OPENED_KEY);
    if (imported.warnings.length)
      onError(`Imported with ${imported.warnings.length} warning(s). First: ${imported.warnings[0]}`);
  }

  /** Re-read the connected repo, replacing this tree's contents with what is in it. */
  async function handlePull() {
    setPulling(true);
    try {
      const result = await pullValues(draft.values.repoUrl, draft.values.revision, draft.values.path ?? "");
      const imported = importTree(result.files);
      // The clone the preview diffs against, already in hand — no second one.
      setRepoFiles(result.files);
      log("argocd", "pulled", { releases: imported.releases.length, warnings: imported.warnings.length });
      // The repo replaces what this tree holds, but not which repo it is: the
      // connection is the user's, and a pull must not be able to redirect where
      // the next commit lands.
      setDraft((prev) => ({
        ...prev,
        ...(imported.chart ? { chart: imported.chart } : {}),
        releases: imported.releases,
        namespaces: imported.namespaces,
      }));
      setReleaseId(imported.releases[0]?.id ?? "");
      setLayer(BASE);
      if (imported.warnings.length)
        onError(`Pulled with ${imported.warnings.length} warning(s). First: ${imported.warnings[0]}`);
    } catch (err) {
      logError("argocd", "pull failed", err);
      onError(err instanceof Error ? err.message : "Could not read that repository");
    } finally {
      setPulling(false);
    }
  }

  /**
   * Commit the generated files and open a pull request.
   *
   * The server pushes the *stored* tree's files to the *stored* tree's repo, so
   * anything still sitting in the autosave debounce has to land first —
   * otherwise the commit describes the tree as it was one keystroke ago. It
   * goes through the same queue rather than around it, so it cannot race the
   * write that is already scheduled.
   */
  async function handleCommit() {
    setPush({ kind: "busy" });
    try {
      const input = toInput(draft);
      queue.current = queue.current.then(() => write(input, JSON.stringify(input)));
      await queue.current;
      const id = idRef.current;
      if (!id) throw new Error("This tree has not been saved yet — try again in a moment.");
      const result = await pushTree(
        id,
        files.map((f) => ({ path: f.path, text: f.text }))
      );
      log("argocd", "pushed", { id, branch: result.branch, changed: result.changed });
      setPush({ kind: "done", ...result });
    } catch (err) {
      logError("argocd", "push failed", err);
      setPush({ kind: "error", message: err instanceof Error ? err.message : "Could not commit to that repository" });
    }
  }

  /** Write the edited feature map back into whichever layer is on screen. */
  function setFeatures(next: Record<string, FeatureState>) {
    patchScope((current) => ({ ...current, features: next }));
  }
  function setExtra(text: string) {
    patchScope((current) => ({ ...current, extraValues: text }));
  }

  function patchScope(fn: (scope: { features: Record<string, FeatureState>; extraValues?: string }) => {
    features: Record<string, FeatureState>;
    extraValues?: string;
  }) {
    if (editingDefaults) {
      return setDraft((prev) => ({ ...prev, defaults: { ...fn(prev.defaults ?? { features: {} }) } }));
    }
    if (!release) return;
    setDraft((prev) => {
      if (layer === BASE) {
        return {
          ...prev,
          releases: prev.releases.map((r) => (r.id === release.id ? { ...r, ...fn(r) } : r)),
        };
      }
      return {
        ...prev,
        namespaces: prev.namespaces.map((ns, i) => {
          if (i !== layer) return ns;
          const existing = ns.releases.find((e) => e.release === release.id);
          // A namespace entry is created the moment something is typed into it,
          // not when the namespace is added — an untouched namespace deploys the
          // base as-is and needs no override file of its own.
          const entry = existing ?? { release: release.id, features: {} };
          const updated = { ...entry, ...fn(entry) };
          return {
            ...ns,
            releases: existing
              ? ns.releases.map((e) => (e.release === release.id ? updated : e))
              : [...ns.releases, updated],
          };
        }),
      };
    });
  }

  function handleImport(result: ImportResult, name: string) {
    log("argocd", "imported values", { warnings: result.warnings.length });
    patchScope(() => ({ features: result.features, extraValues: result.extraValues }));
    // A file that names itself names the release too, but only when there is
    // nothing to overwrite.
    if (layer === BASE && name && release && !release.name.trim())
      setDraft((prev) => ({ ...prev, releases: prev.releases.map((r) => (r.id === release.id ? { ...r, name } : r)) }));
    setImportOpen(false);
  }

  function addRelease(): string {
    const created = newRelease("");
    setDraft((prev) => ({ ...prev, releases: [...prev.releases, created] }));
    setReleaseId(created.id);
    setLayer(BASE);
    // Returned so the grid opens the new card's name field straight away.
    return created.id;
  }

  /**
   * The shared release. Not returned for renaming like the one above: its name
   * is the convention — the converter writes `shared` and the consumers of
   * those objects reference it by that name — so it opens on its fields.
   */
  function addSharedRelease() {
    const created = newSharedRelease();
    setDraft((prev) => ({ ...prev, releases: [...prev.releases, created] }));
    setReleaseId(created.id);
    setLayer(BASE);
  }

  /**
   * Open the tree's defaults. They are merged into the *base* file, so the
   * layer follows — editing "every microservice" from inside one namespace's
   * override would be two different scopes claiming one form.
   */
  function openDefaults() {
    setReleaseId(DEFAULTS);
    setLayer(BASE);
  }

  function renameRelease(id: string, name: string) {
    setDraft((prev) => ({ ...prev, releases: prev.releases.map((r) => (r.id === id ? { ...r, name } : r)) }));
  }

  /**
   * The × on a card deletes. It asks first only when there is something to
   * lose — an empty namespace or microservice goes with no ceremony, which is
   * what keeps the question meaningful on the one that is not empty.
   *
   * "Holds values" is asked of the *built* document rather than of the feature
   * map, for the same reason the cards are: a feature can be switched on and
   * still emit nothing, so `{ service: { on: true } }` is not work.
   */
  function askRemoveRelease(id: string) {
    const target = draft.releases.find((r) => r.id === id);
    if (!target) return;
    const name = target.name.trim() || "this microservice";
    const values = Object.keys(buildValues(target.features, target.extraValues)).length;
    const overriding = draft.namespaces.filter((ns) =>
      ns.releases.some((e) => e.release === id && Object.keys(buildValues(e.features, e.extraValues)).length)
    ).length;
    if (!values && !overriding) return removeRelease(id);
    setConfirm({
      title: `Delete ${name}?`,
      detail: [
        values && `its base file sets ${values} top-level value(s)`,
        overriding && `${overriding} namespace(s) override it`,
      ]
        .filter(Boolean)
        .join(", and ")
        .replace(/^./, (c) => c.toUpperCase())
        .concat(". Both go with it, and there is no undo."),
      run: () => removeRelease(id),
    });
  }

  function askRemoveNamespace(index: number) {
    const target = draft.namespaces[index];
    if (!target) return;
    const name = target.name.trim() || "this namespace";
    const overriding = target.releases.filter((e) => Object.keys(buildValues(e.features, e.extraValues)).length).length;
    if (!overriding) return removeNamespace(index);
    setConfirm({
      title: `Delete ${name}?`,
      detail: `${name} overrides ${overriding} microservice(s). Those override files go with it, and there is no undo.`,
      run: () => removeNamespace(index),
    });
  }

  function removeRelease(id: string) {
    setDraft((prev) => ({
      ...prev,
      releases: prev.releases.filter((r) => r.id !== id),
      // A namespace's override of a release that no longer exists would generate
      // a values file nothing reads.
      namespaces: prev.namespaces.map((ns) => ({ ...ns, releases: ns.releases.filter((e) => e.release !== id) })),
    }));
    if (releaseId === id) setReleaseId("");
  }

  function addNamespace() {
    // Selected straight away: a namespace is named after it is added, and the
    // name field only exists on the layer that is open.
    setDraft((prev) => ({ ...prev, namespaces: [...prev.namespaces, newNamespace("")] }));
    setLayer(draft.namespaces.length);
  }

  function renameNamespace(index: number, name: string) {
    setDraft((prev) => ({ ...prev, namespaces: prev.namespaces.map((ns, i) => (i === index ? { ...ns, name } : ns)) }));
  }

  function removeNamespace(index: number) {
    setDraft((prev) => ({ ...prev, namespaces: prev.namespaces.filter((_, i) => i !== index) }));
    // Indexes below the removed one shift up, so anything at or after it would
    // now be pointing at a different namespace.
    setLayer((current) => (current === index || current > index ? BASE : current));
  }

  /**
   * Autosave. There is no Save button — a tree is a document, and the list is
   * where you come back to it. A tree nobody has touched is never written:
   * opening the module must not litter the list with empty trees.
   */
  useEffect(() => {
    const input = toInput(draft);
    const json = JSON.stringify(input);
    if (json === persisted.current) return;
    if (!idRef.current && isEmptyTree(draft)) return;

    const timer = setTimeout(() => {
      queue.current = queue.current.then(() => write(input, json));
    }, AUTOSAVE_MS);
    return () => clearTimeout(timer);
  }, [draft]);

  async function write(input: ReturnType<typeof toInput>, json: string) {
    if (json === persisted.current) return;
    setSaveState("saving");
    try {
      // `id` is read at write time rather than captured: the create that ran
      // just before this one in the queue is what put it there.
      const id = idRef.current;
      const { tree } = id ? await updateTree(id, input) : await createTree(input);
      idRef.current = tree.id;
      localStorage.setItem(LAST_OPENED_KEY, tree.id);
      persisted.current = JSON.stringify(toInput(tree));
      log("argocd", id ? "autosaved" : "created", tree.id);
      // Only the server's own fields are taken back — merging the whole record
      // would stamp on whatever was typed while the request was in flight.
      setDraft((prev) => ({
        ...prev,
        id: tree.id,
        updatedAt: tree.updatedAt,
        name: prev.name.trim() ? prev.name : tree.name,
      }));
      setTrees((prev) => [tree, ...prev.filter((t) => t.id !== tree.id)]);
      setSaveState("saved");
    } catch (err) {
      logError("argocd", "autosave failed", err);
      onError(err instanceof Error ? err.message : "Failed to save");
      setSaveState("error");
    }
  }

  async function handleDelete() {
    if (!draft.id) return;
    const id = draft.id;
    try {
      await deleteTree(id);
      log("argocd", "deleted", id);
      setTrees((prev) => prev.filter((t) => t.id !== id));
      handleScratch();
    } catch (err) {
      logError("argocd", "delete failed", err);
      onError(err instanceof Error ? err.message : "Failed to delete");
    }
  }

  function handleDownload() {
    const entries = Object.fromEntries(files.map((f) => [f.path, strToU8(f.text)]));
    const blob = new Blob([zipSync(entries) as unknown as BlobPart], { type: "application/zip" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${(draft.name || "gitops-tree").replace(/[^\w.-]+/g, "-")}.zip`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <>
      <header className="topbar">
        <h1>ArgoCD</h1>
        <div className="ag-topbar-actions">
          <span className={`ag-save-state ${saveState}`} role="status">
            {saveState === "saving" && "Saving…"}
            {saveState === "error" && (
              <>
                <TriangleAlert size={15} aria-hidden="true" /> Not saved
              </>
            )}
          </span>
          {draft.id && (
            <button type="button" className="ghost-button" onClick={() => void handleDelete()}>
              <Trash2 size={18} aria-hidden="true" /> Delete
            </button>
          )}
          <button type="button" className="primary" onClick={() => setNewOpen(true)}>
            <Plus size={18} aria-hidden="true" /> New
          </button>
        </div>
      </header>

      <div className="workspace-grid">
        <div className="ticket-column">
          <div className="ticket-list-header">
            <h2>{isAdmin && showAll ? "All Trees" : "My Trees"}</h2>
            {isAdmin && (
              <button className="ghost-button" onClick={() => setShowAll((v) => !v)}>
                {showAll ? "My trees" : "All trees"}
              </button>
            )}
          </div>
          <section className="ticket-list-panel" aria-label="Saved trees">
            <div className="ticket-list">
              <TreeList
                trees={visibleTrees}
                selectedId={draft.id}
                isAdmin={isAdmin}
                onSelect={(id) => {
                  const tree = visibleTrees.find((t) => t.id === id);
                  if (tree) handleOpen(tree);
                }}
              />
            </div>
          </section>
        </div>

        <div className="content-column">
          <section className="detail-panel ag-editor" aria-label="GitOps tree editor">
            <div className="ag-section detail-title-row">
              {naming ? (
                <input
                  className="title-edit-input"
                  aria-label="Tree name"
                  value={draft.name}
                  placeholder="Untitled tree"
                  autoFocus
                  onChange={(e) => setDraft((prev) => ({ ...prev, name: e.target.value }))}
                  onBlur={() => setNaming(false)}
                  onKeyDown={(e) => {
                    // Enter and Escape both just leave the field — every keystroke
                    // is already in the draft, and autosave is what writes it.
                    if (e.key === "Enter" || e.key === "Escape") e.currentTarget.blur();
                  }}
                />
              ) : (
                <h2 className="ag-title">{draft.name.trim() || "Untitled tree"}</h2>
              )}
              <button
                type="button"
                className="icon-button edit-toggle"
                aria-label={naming ? "Done editing the name" : "Rename this tree"}
                onClick={() => setNaming((v) => !v)}
              >
                {naming ? <Check size={16} aria-hidden="true" /> : <Pencil size={16} aria-hidden="true" />}
              </button>
            </div>

            <div className="ag-section ag-wiring">
              {/* Read top to bottom: what renders this tree, then where the
                  tree goes. The chart comes first because it is the input and
                  the repo is the destination — but it is one quiet line,
                  because it is set once per organisation, while the repo is the
                  panel that carries the two git buttons. They used to share a
                  disclosure as equals, which made the rarely-touched one as
                  loud as the live one. */}
              <ChartLine
                tree={draft}
                onChange={(chart) => setDraft((p) => ({ ...p, chart }))}
                onRootAppName={(rootAppName) => setDraft((p) => ({ ...p, rootAppName }))}
              />
              <RepoPanel
                tree={draft}
                open={repoOpen}
                onToggle={() => setRepoOpen((v) => !v)}
                onChange={(values) => setDraft((p) => ({ ...p, values }))}
                onPull={() => void handlePull()}
                pulling={pulling}
                gitEnabled={gitEnabled}
                releaseCount={draft.releases.length}
              />
            </div>
            {/* Namespaces first, microservices second. The namespace is the
                wider choice — it says which environment everything below is
                about — and a microservice card read differently depending on a
                layer selected further down the page. */}
            <div className="ag-section">
              <h3 className="ag-grid-head">
                Namespaces
                <Help label="a namespace">
                  <p>Which layer the form below edits: the shared base, or one namespace's overrides.</p>
                  <p>A namespace runs every microservice in the tree; its entry carries only what it changes.</p>
                  <p>A dot marks a namespace that overrides the microservice you have open.</p>
                </Help>
              </h3>
              {/* Renamed and removed on the tile itself. The strip that used to
                  do both sat under the grid and acted on whatever was selected,
                  so the name being typed was one row away from the tile showing
                  it — and deleting meant selecting first, which is two presses
                  to undo one mistake. A pencil and an × on the card say which
                  one they are about without being told. */}
              <LayerGrid
                layer={layer}
                namespaces={layerCards}
                releaseCount={draft.releases.length}
                // Picking a namespace is asking to edit an override, which the
                // defaults are not — so it leaves them for the first release.
                onSelect={(next) => {
                  setLayer(next);
                  if (editingDefaults && next !== BASE) setReleaseId("");
                }}
                onRename={renameNamespace}
                onRemove={askRemoveNamespace}
                onAdd={addNamespace}
              />
            </div>

            <div className="ag-section">
              <h3 className="ag-grid-head">
                Microservices
                <Help label="a microservice card">
                  <p>One card per microservice, listing the Kubernetes objects it puts in the cluster.</p>
                  <p>
                    A chip set back behind <code>↳</code> is part of the workload's pod template rather than an object
                    of its own; an amber one is cluster-scoped, so only one microservice may own it.
                  </p>
                  <p>A dashed chip is added by a namespace override, not by the base file.</p>
                  <p>Press any chip to jump to the fields that set it.</p>
                </Help>
              </h3>
              <ReleaseGrid
                cards={releaseCards}
                selectedId={release?.id}
                onSelect={setReleaseId}
                onJump={(id, feature, toBase) => {
                  setReleaseId(id);
                  if (toBase) setLayer(BASE);
                  setJump({ feature, n: Date.now() });
                }}
                onRename={renameRelease}
                onRemove={askRemoveRelease}
                onAdd={addRelease}
                onOpenDefaults={openDefaults}
                defaultsOpen={editingDefaults}
                defaultsCount={defaultsCount}
                defaultsDisabled={layer !== BASE}
                onAddShared={
                  draft.releases.some((r) => r.name.trim() === SHARED_RELEASE_NAME) ? undefined : addSharedRelease
                }
              />


              {promotions.map((p) => (
                <div className="ag-promote" key={p.releaseId}>
                  <ArrowDownToLine size={15} aria-hidden="true" />
                  <span>
                    Every namespace sets{" "}
                    {p.paths.slice(0, 4).map((path, i) => (
                      <span key={path}>
                        {i > 0 && ", "}
                        <code>{path}</code>
                      </span>
                    ))}
                    {p.paths.length > 4 && ` and ${p.paths.length - 4} more`} the same way on{" "}
                    <strong>{p.releaseName}</strong>. That is the base, written out {p.namespaces.length} times.
                  </span>
                  <button
                    type="button"
                    className="ghost-button"
                    onClick={() => {
                      log("argocd", "promoted to base", { release: p.releaseName, paths: p.paths });
                      setDraft((prev) => applyPromotion(prev, p));
                    }}
                  >
                    Move to base
                  </button>
                </div>
              ))}

            </div>

            {(release || editingDefaults) && (
              <div className="ag-section">
                <div className="ag-scope-actions">
                  <h3 className="ag-grid-head">
                    {editingDefaults ? "Defaults for every microservice" : layer === BASE ? "Base values" : `${scopeLabel} overrides`}
                    <Help
                      label={
                        editingDefaults
                          ? "the tree's defaults"
                          : layer === BASE
                            ? "the base values"
                            : "this namespace's overrides"
                      }
                    >
                      {editingDefaults ? (
                        <p>
                          Written into every namespace's <code>defaults.yaml</code>, the first file the chart layers. A
                          microservice that sets the same thing wins, and what it takes from here shows greyed on its
                          own card.
                        </p>
                      ) : layer === BASE ? (
                        <p>Environment-agnostic values, shared by every namespace that runs this microservice.</p>
                      ) : (
                        <p>Only what differs in {scopeLabel} — anything identical to base is left out of the file.</p>
                      )}
                    </Help>
                  </h3>
                  <button type="button" className="ghost-button" onClick={() => setImportOpen(true)}>
                    <FileUp size={16} aria-hidden="true" /> Import values
                  </button>
                </div>


                <FeatureEditor
                  // Remounted per scope, so which categories are open is
                  // decided by what that layer actually holds.
                  key={`${editingDefaults ? DEFAULTS : release!.id}:${layer}`}
                  features={features}
                  scopeLabel={layer === BASE ? "the base file" : `${scopeLabel}'s override file`}
                  extraValues={extraValues}
                  isBase={layer === BASE}
                  extraError={extraError}
                  overriding={overriding}
                  jump={jump}
                  onJumped={() => setJump(undefined)}
                  inherited={inherited}
                  onOpenInherited={(from) => (from === "defaults" ? openDefaults() : setLayer(BASE))}
                  problems={problems}
                  onChange={setFeatures}
                  onExtraChange={setExtra}
                />
              </div>
            )}

            <div className="ag-section">
              {problems.length > 0 && (
                <ul className="ag-problems">
                  {problems.map((p) => (
                    // A problem is about a field, and reading it used to leave
                    // you scrolling forty-five collapsed cards for the one it
                    // names. Pressing it opens that feature — the same jump a
                    // release card's chip makes, so there is one way to get to
                    // a field from something that mentions it.
                    <li key={p.text} className={`${p.level}${p.feature ? " linked" : ""}`}>
                      {p.feature ? (
                        <button type="button" onClick={() => setJump({ feature: p.feature!, n: Date.now() })}>
                          <TriangleAlert size={14} aria-hidden="true" /> {p.text}
                        </button>
                      ) : (
                        <>
                          <TriangleAlert size={14} aria-hidden="true" /> {p.text}
                        </>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              <FilePreview
                files={files}
                onDownload={handleDownload}
                repo={repoFiles}
                comparing={comparing}
                error={baselineError}
                deletes={!!subPath.trim()}
                actions={
                  <CommitButton
                    tree={draft}
                    gitEnabled={gitEnabled}
                    saved={!!draft.id}
                    push={push}
                    onCommit={() => void handleCommit()}
                  />
                }
                notice={<PushResult push={push} />}
              />
            </div>
          </section>
        </div>
      </div>

      {importOpen && release && (
        <ImportDialog scopeLabel={scopeLabel} onImport={handleImport} onClose={() => setImportOpen(false)} />
      )}

      {newOpen && (
        <NewTreeDialog onScratch={handleScratch} onConnect={handleConnect} onClose={() => setNewOpen(false)} />
      )}

      {confirm && (
        <ConfirmDialog
          title={confirm.title}
          detail={confirm.detail}
          onConfirm={() => {
            confirm.run();
            setConfirm(undefined);
          }}
          onClose={() => setConfirm(undefined)}
        />
      )}
    </>
  );
}
