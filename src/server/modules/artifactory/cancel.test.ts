import { describe, expect, it } from "vitest";
import { RealArtifactoryApi } from "./RealArtifactoryApi";
import type { PortalUser } from "../../types";

const owner: PortalUser = { id: "u-alex", email: "alex@example.com", displayName: "Alex Morgan", groups: [] };
const other: PortalUser = { id: "u-rin", email: "rin@example.com", displayName: "Rin Alvarez", groups: [] };

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("cancelJob", () => {
  it("stops a running job and keeps it aborted", async () => {
    const api = new RealArtifactoryApi();
    const job = await api.simulate(owner);

    await tick(1200); // past the first couple of beats — the job is moving
    await api.cancelJob(job.id, owner);
    expect((await api.getJob(job.id))?.status).toBe("aborted");

    const linesAtCancel = (await api.getJob(job.id))!.log.length;
    // The rest of the script would have run by now had the abort not landed.
    await tick(1500);
    const after = (await api.getJob(job.id))!;
    expect(after.status).toBe("aborted");
    expect(after.log.length).toBe(linesAtCancel);
    expect(after.log.at(-1)).toBe("Aborted by Alex Morgan.");
  });

  it("refuses someone else's job unless the caller is an admin", async () => {
    const api = new RealArtifactoryApi();
    const job = await api.simulate(owner);

    await expect(api.cancelJob(job.id, other)).rejects.toThrow("Forbidden");
    expect((await api.getJob(job.id))?.status).not.toBe("aborted");

    await api.cancelJob(job.id, other, true);
    expect((await api.getJob(job.id))?.status).toBe("aborted");
  });

  it("leaves a finished job alone and reports an unknown one", async () => {
    const api = new RealArtifactoryApi();
    expect(await api.cancelJob("ART-9999", owner)).toBeNull();

    const job = await api.simulate(owner);
    await api.cancelJob(job.id, owner);
    const updatedAt = (await api.getJob(job.id))!.updatedAt;

    await api.cancelJob(job.id, owner);
    expect((await api.getJob(job.id))!.updatedAt).toBe(updatedAt);
  });
});
