import express from "express";
import { z } from "zod";
import { requestCatalog } from "./catalog";
import { displayNameFor, listAdminCandidates, portalIdFor, requireAdmin } from "../../auth";
import { ticketPriorities } from "./priority";
import { customerStages } from "./status";
import type { CustomerStage, TicketDetail, TicketPriority, TicketSummary, TicketingApi } from "../../types";

const createTicketSchema = z.object({
  requestType: z.string().min(1),
  priority: z.enum(ticketPriorities as [TicketPriority, ...TicketPriority[]]),
  fields: z.record(z.string(), z.string()),
  idempotencyKey: z.string().optional()
});

const commentSchema = z.object({
  body: z.string().trim().min(1).max(5000)
});

const adminUpdateSchema = z.object({
  stage: z.enum(customerStages as [CustomerStage, ...CustomerStage[]]).optional(),
  // Half points (0.5, 1.5) are normal estimation practice, so not .int().
  // Bounded rather than free-form: z.number() alone would accept Infinity.
  storyPoints: z.number().min(0).max(1000).optional(),
  rawStatus: z.string().trim().min(1).optional(),
  title: z.string().trim().min(1).optional(),
  description: z.string().trim().optional(),
  teamGroups: z.array(z.string().trim().min(1)).optional(),
  assigneeId: z.string().optional(),
  assigneeName: z.string().optional()
});

// Names go out resolved, not as the backend stored them, so the queue's
// assignee label, the owner dropdown and the header all read the same string
// for the same person. Applied on the way out rather than at write time
// because it also repairs rows the backend (Jira, or an older assignment)
// already holds.
// Ids are normalised on the same pass: a Jira-backed ticket carries Jira
// usernames, while the client only ever holds the proxy's id for a person
// (that's what /api/me reports and what the assignee dropdown is keyed by).
function withResolvedNames<T extends TicketSummary>(ticket: T): T {
  const requesterId = portalIdFor(ticket.requesterId);
  const assigneeId = portalIdFor(ticket.assigneeId);
  return {
    ...ticket,
    requesterId,
    assigneeId,
    requesterName: displayNameFor(requesterId, ticket.requesterName),
    assigneeName: displayNameFor(assigneeId, ticket.assigneeName)
  };
}

function detailWithResolvedNames(ticket: TicketDetail): TicketDetail {
  return {
    ...withResolvedNames(ticket),
    comments: ticket.comments.map((comment) => ({
      ...comment,
      authorId: portalIdFor(comment.authorId),
      authorName: displayNameFor(comment.authorId, comment.authorName)
    }))
  };
}

function parseCustomerStage(status: unknown): CustomerStage | undefined {
  if (!status || typeof status !== "string") {
    return undefined;
  }
  return customerStages.includes(status as CustomerStage) ? (status as CustomerStage) : undefined;
}

export function createTicketingRouter(ticketingApi: TicketingApi) {
  const router = express.Router();

  router.get("/api/request-types", (_req, res) => {
    res.json({ requestTypes: requestCatalog });
  });

  router.get("/api/tickets", async (req, res, next) => {
    try {
      const scope = req.query.scope === "team" ? "team" : "mine";
      const tickets = await ticketingApi.listTickets(req.user!, {
        scope,
        status: parseCustomerStage(req.query.status),
        query: typeof req.query.query === "string" ? req.query.query : undefined
      });
      res.json({ tickets: tickets.map(withResolvedNames) });
    } catch (error) {
      next(error);
    }
  });

  router.get("/api/tickets/:id", async (req, res, next) => {
    try {
      const ticket = await ticketingApi.getTicket(req.params.id, req.user!);
      if (!ticket) {
        res.status(404).json({ error: "Ticket not found" });
        return;
      }
      res.json({ ticket: detailWithResolvedNames(ticket) });
    } catch (error) {
      next(error);
    }
  });

  router.post("/api/tickets", async (req, res, next) => {
    try {
      const payload = createTicketSchema.parse(req.body);
      const ticket = await ticketingApi.createTicket(payload, req.user!);
      res.status(201).json({ ticket: detailWithResolvedNames(ticket) });
    } catch (error) {
      next(error);
    }
  });

  router.post("/api/tickets/:id/comments", async (req, res, next) => {
    try {
      const payload = commentSchema.parse(req.body);
      const comment = await ticketingApi.addComment(req.params.id, req.user!, payload.body);
      res.status(201).json({ comment });
    } catch (error) {
      next(error);
    }
  });

  router.get("/api/admin/assignees", requireAdmin, (_req, res) => {
    res.json({ assignees: listAdminCandidates() });
  });

  router.get("/api/admin/tickets", requireAdmin, async (req, res, next) => {
    try {
      const tickets = await ticketingApi.listAdminTickets({
        status: parseCustomerStage(req.query.status),
        query: typeof req.query.query === "string" ? req.query.query : undefined
      });
      res.json({ tickets: tickets.map(withResolvedNames) });
    } catch (error) {
      next(error);
    }
  });

  router.get("/api/admin/tickets/:id", requireAdmin, async (req, res, next) => {
    try {
      const ticket = await ticketingApi.getAdminTicket(String(req.params.id));
      if (!ticket) {
        res.status(404).json({ error: "Ticket not found" });
        return;
      }
      res.json({ ticket: detailWithResolvedNames(ticket) });
    } catch (error) {
      next(error);
    }
  });

  router.patch("/api/admin/tickets/:id", requireAdmin, async (req, res, next) => {
    try {
      const payload = adminUpdateSchema.parse(req.body);
      // Effort has to be recorded before work is signed off. Checked here and
      // not just in the UI — the dropdown is not the only way to reach this.
      // Cancelled is exempt: abandoned work has no effort to estimate.
      if (payload.stage === "Closed") {
        const current = await ticketingApi.getAdminTicket(String(req.params.id));
        if ((payload.storyPoints ?? current?.storyPoints) === undefined) {
          res.status(400).json({ error: "Story points are required before a ticket can be closed." });
          return;
        }
      }
      const ticket = await ticketingApi.updateAdminTicket(String(req.params.id), req.user!, payload);
      res.json({ ticket: detailWithResolvedNames(ticket) });
    } catch (error) {
      next(error);
    }
  });

  router.post("/api/admin/tickets/:id/comments", requireAdmin, async (req, res, next) => {
    try {
      const payload = commentSchema.parse(req.body);
      const comment = await ticketingApi.addAdminComment(String(req.params.id), req.user!, payload.body);
      res.status(201).json({ comment });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
