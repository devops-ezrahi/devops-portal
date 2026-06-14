import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "./app";
import { InMemoryTicketingApi } from "./modules/ticketing/InMemoryTicketingApi";
import { seedTickets } from "./modules/ticketing/__tests__/seedTickets";

function ticketingApp() {
  return createApp(new InMemoryTicketingApi(seedTickets()));
}

function authed() {
  return request(createApp())
    .get("/api/me")
    .set("x-user-id", "u-alex")
    .set("x-user-name", "Alex Morgan")
    .set("x-user-email", "alex@example.com")
    .set("x-user-groups", "team-alpha");
}

describe("portal API", () => {
  afterEach(() => {
    delete process.env.ARGOCD_URL;
    delete process.env.ARGOCD_AUTH_TOKEN;
    delete process.env.ARGOCD_USERNAME;
    delete process.env.ARGOCD_PASSWORD;
    delete process.env.ARGOCD_INSECURE;
  });

  it("returns the SSO-backed current user", async () => {
    const response = await authed().expect(200);
    expect(response.body.user).toMatchObject({
      id: "u-alex",
      displayName: "Alex Morgan",
      groups: ["team-alpha"]
    });
  });

  it("lists own and team-visible tickets", async () => {
    const app = ticketingApp();

    const mine = await request(app)
      .get("/api/tickets?scope=mine")
      .set("x-user-id", "u-alex")
      .set("x-user-groups", "team-alpha")
      .expect(200);
    expect(mine.body.tickets.map((ticket: { id: string }) => ticket.id)).toEqual(["DEVOPS-1001"]);

    const team = await request(app)
      .get("/api/tickets?scope=team")
      .set("x-user-id", "u-alex")
      .set("x-user-groups", "team-alpha")
      .expect(200);
    expect(team.body.tickets.map((ticket: { id: string }) => ticket.id)).toEqual(["DEVOPS-1001", "DEVOPS-1002"]);
  });

  it("denies unauthorized ticket detail access", async () => {
    await request(ticketingApp())
      .get("/api/tickets/DEVOPS-1003")
      .set("x-user-id", "u-alex")
      .set("x-user-groups", "team-alpha")
      .expect(404);
  });

  it("creates tickets with catalog validation and supports idempotency", async () => {
    const app = createApp();
    const payload = {
      requestType: "ci-cd-pipeline",
      idempotencyKey: "key-123",
      fields: {
        title: "Add smoke tests",
        application: "portal",
        repository: "https://git.example.com/portal",
        environment: "Staging",
        description: "Run smoke tests after deploy"
      }
    };

    const first = await request(app)
      .post("/api/tickets")
      .set("x-user-id", "u-alex")
      .set("x-user-name", "Alex Morgan")
      .set("x-user-groups", "team-alpha")
      .send(payload)
      .expect(201);

    const second = await request(app)
      .post("/api/tickets")
      .set("x-user-id", "u-alex")
      .set("x-user-name", "Alex Morgan")
      .set("x-user-groups", "team-alpha")
      .send(payload)
      .expect(201);

    expect(second.body.ticket.id).toBe(first.body.ticket.id);
  });

  it("adds comments to visible tickets", async () => {
    const app = ticketingApp();
    const response = await request(app)
      .post("/api/tickets/DEVOPS-1001/comments")
      .set("x-user-id", "u-alex")
      .set("x-user-name", "Alex Morgan")
      .set("x-user-groups", "team-alpha")
      .send({ body: "Thanks for the update." })
      .expect(201);

    expect(response.body.comment).toMatchObject({
      authorId: "u-alex",
      body: "Thanks for the update."
    });
  });

  it("blocks admin routes for non-admin users", async () => {
    await request(createApp())
      .get("/api/admin/tickets")
      .set("x-user-id", "u-alex")
      .set("x-user-groups", "team-alpha")
      .expect(403);
  });

  it("returns the fake Git repo branch diff dashboard", async () => {
    const response = await request(createApp())
      .get("/api/git-repo-diff")
      .set("x-user-id", "u-alex")
      .set("x-user-groups", "team-alpha")
      .expect(200);

    expect(response.body).toMatchObject({
      app: "payments-app",
      baselineBranch: "payments-prd"
    });
    expect(response.body.branches).toContain("payments-secure-prd");
    expect(response.body.microservices.map((service: { name: string }) => service.name)).toContain("reports-api");
    expect(
      response.body.microservices.find((service: { name: string }) => service.name === "reports-api").missingBranches
    ).toContain("payments-secure-prd");
    expect(
      response.body.microservices
        .find((service: { name: string }) => service.name === "payment-api")
        .templateDiffs.some((diff: { field: string }) => diff.field.includes("livenessProbe.httpGet.path"))
    ).toBe(true);
  });

  it("returns a clear Argo CD error when the configured server is unavailable", async () => {
    process.env.ARGOCD_URL = "https://127.0.0.1:1";
    process.env.ARGOCD_INSECURE = "true";

    const response = await request(createApp())
      .get("/api/argocd/projects")
      .set("x-user-id", "u-alex")
      .set("x-user-groups", "team-alpha")
      .expect(502);

    expect(response.body.error).toContain("Argo CD");
  });

  it("lets admins list, update, and respond to any ticket", async () => {
    const app = ticketingApp();

    const list = await request(app)
      .get("/api/admin/tickets")
      .set("x-user-id", "u-admin")
      .set("x-user-name", "Morgan Admin")
      .set("x-user-groups", "portal-admins")
      .expect(200);
    expect(list.body.tickets.map((ticket: { id: string }) => ticket.id)).toContain("DEVOPS-1003");

    const update = await request(app)
      .patch("/api/admin/tickets/DEVOPS-1003")
      .set("x-user-id", "u-admin")
      .set("x-user-name", "Morgan Admin")
      .set("x-user-groups", "portal-admins")
      .send({
        stage: "In Progress",
        rawStatus: "Reopened",
        title: "Investigate failed nightly deployment again",
        teamGroups: ["team-beta", "devops-support"]
      })
      .expect(200);
    expect(update.body.ticket).toMatchObject({
      id: "DEVOPS-1003",
      stage: "In Progress",
      rawStatus: "Reopened",
      title: "Investigate failed nightly deployment again"
    });

    const comment = await request(app)
      .post("/api/admin/tickets/DEVOPS-1003/comments")
      .set("x-user-id", "u-admin")
      .set("x-user-name", "Morgan Admin")
      .set("x-user-groups", "portal-admins")
      .send({ body: "We reopened this and are investigating the latest failure." })
      .expect(201);
    expect(comment.body.comment).toMatchObject({
      authorId: "u-admin",
      body: "We reopened this and are investigating the latest failure."
    });
  });
});
