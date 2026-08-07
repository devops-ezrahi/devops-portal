import request from "supertest";
import { describe, expect, it } from "vitest";
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
      priority: "High",
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
    expect(first.body.ticket.priority).toBe("High");

    await request(app)
      .post("/api/tickets")
      .set("x-user-id", "u-alex")
      .set("x-user-name", "Alex Morgan")
      .set("x-user-groups", "team-alpha")
      .send({ ...payload, priority: "Urgent", idempotencyKey: "key-124" })
      .expect(400);
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

  it("blocks closing a ticket until story points are recorded", async () => {
    const app = ticketingApp();
    const admin = (r: request.Test) =>
      r.set("x-user-id", "u-admin").set("x-user-name", "Morgan Admin").set("x-user-groups", "portal-admins");

    // DEVOPS-1001 has no story points in the fixture.
    await admin(request(app).patch("/api/admin/tickets/DEVOPS-1001")).send({ stage: "Closed" }).expect(400);

    // Cancelling is exempt — abandoned work has no effort to estimate.
    await admin(request(app).patch("/api/admin/tickets/DEVOPS-1001")).send({ stage: "Cancelled" }).expect(200);

    // Points supplied in the same request are enough to let it close.
    const closed = await admin(request(app).patch("/api/admin/tickets/DEVOPS-1001"))
      .send({ stage: "Closed", storyPoints: 5 })
      .expect(200);
    expect(closed.body.ticket).toMatchObject({ stage: "Closed", storyPoints: 5 });

    // DEVOPS-1003 already carries points, so it closes without resupplying them.
    await admin(request(app).patch("/api/admin/tickets/DEVOPS-1003")).send({ stage: "Closed" }).expect(200);
  });
});
