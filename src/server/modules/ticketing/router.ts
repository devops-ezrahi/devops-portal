import express from "express";
import { z } from "zod";
import { requestCatalog } from "./catalog";
import { requireAdmin } from "../../auth";
import { customerStages } from "./status";
import type { CustomerStage, TicketingApi } from "../../types";

const createTicketSchema = z.object({
  requestType: z.string().min(1),
  fields: z.record(z.string(), z.string()),
  idempotencyKey: z.string().optional()
});

const commentSchema = z.object({
  body: z.string().trim().min(1).max(5000)
});

const adminUpdateSchema = z.object({
  stage: z.enum(customerStages as [CustomerStage, ...CustomerStage[]]).optional(),
  rawStatus: z.string().trim().min(1).optional(),
  title: z.string().trim().min(1).optional(),
  description: z.string().trim().optional(),
  teamGroups: z.array(z.string().trim().min(1)).optional(),
  assigneeId: z.string().optional()
});

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
      res.json({ tickets });
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
      res.json({ ticket });
    } catch (error) {
      next(error);
    }
  });

  router.post("/api/tickets", async (req, res, next) => {
    try {
      const payload = createTicketSchema.parse(req.body);
      const ticket = await ticketingApi.createTicket(payload, req.user!);
      res.status(201).json({ ticket });
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

  router.get("/api/admin/tickets", requireAdmin, async (req, res, next) => {
    try {
      const tickets = await ticketingApi.listAdminTickets({
        status: parseCustomerStage(req.query.status),
        query: typeof req.query.query === "string" ? req.query.query : undefined
      });
      res.json({ tickets });
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
      res.json({ ticket });
    } catch (error) {
      next(error);
    }
  });

  router.patch("/api/admin/tickets/:id", requireAdmin, async (req, res, next) => {
    try {
      const payload = adminUpdateSchema.parse(req.body);
      const ticket = await ticketingApi.updateAdminTicket(String(req.params.id), req.user!, payload);
      res.json({ ticket });
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
