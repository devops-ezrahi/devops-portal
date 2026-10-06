import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const convertManifests = vi.fn();
const listWorkloads = vi.fn();
vi.mock("../api", () => ({ convertManifests, listWorkloads }));

const { ConvertDialog } = await import("./ConvertDialog");

const chart = { repoUrl: "https://git.example.com/universal-chart.git", path: ".", appsetPath: "ms-applicationSet", revision: "main" };

function open() {
  const onConvert = vi.fn();
  render(<ConvertDialog chart={chart} namespace="shop" onConvert={onConvert} onClose={() => undefined} />);
  fireEvent.change(screen.getByLabelText("Kubernetes YAML"), { target: { value: "kind: Deployment\nmetadata:\n  name: web\n" } });
  return onConvert;
}

beforeEach(() => {
  vi.clearAllMocks();
  listWorkloads.mockResolvedValue({
    workloads: [
      { kind: "Deployment", name: "web", namespace: "shop" },
      { kind: "StatefulSet", name: "db", namespace: "shop" },
      { kind: "CronJob", name: "report", namespace: "shop" },
    ],
  });
  convertManifests.mockResolvedValue({ files: [], warnings: [] });
});

describe("ConvertDialog's workload picker", () => {
  it("lists what the paste holds, all ticked, and converts everything untouched", async () => {
    open();
    const list = await screen.findByRole("list", { name: "Workloads to convert" });
    const boxes = list.querySelectorAll<HTMLInputElement>("input[type=checkbox]");
    expect([...boxes].map((b) => b.checked)).toEqual([true, true, true]);
    fireEvent.click(screen.getByRole("button", { name: "Convert" }));
    await waitFor(() => expect(convertManifests).toHaveBeenCalled());
    expect(convertManifests.mock.calls[0][0]).not.toHaveProperty("include");
  });

  it("sends only the ticked workloads", async () => {
    open();
    fireEvent.click(await screen.findByRole("checkbox", { name: /db/ }));
    expect(screen.getByText(/2 of 3/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Convert" }));
    await waitFor(() => expect(convertManifests).toHaveBeenCalled());
    expect(convertManifests.mock.calls[0][0].include).toEqual(["web", "report"]);
  });

  it("will not convert nothing", async () => {
    open();
    await screen.findByRole("list", { name: "Workloads to convert" });
    fireEvent.click(screen.getByRole("button", { name: "None" }));
    expect(screen.getByRole("button", { name: "Convert" })).toBeDisabled();
    expect(screen.getByText(/Tick at least one workload/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "All" }));
    expect(screen.getByRole("button", { name: "Convert" })).toBeEnabled();
  });

  it("converts everything when the list cannot be read", async () => {
    listWorkloads.mockRejectedValue(new Error("helm template failed"));
    open();
    expect(await screen.findByText(/Convert takes all of them/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Convert" }));
    await waitFor(() => expect(convertManifests).toHaveBeenCalled());
    expect(convertManifests.mock.calls[0][0]).not.toHaveProperty("include");
  });
});
