import express from "express";
import { listArgoCdProjects } from "./service";

export function createArgoCdRouter(): express.Router {
  const router = express.Router();

  router.get("/api/argocd/projects", async (req, res, next) => {
    try {
      const dashboard = await listArgoCdProjects(req);
      res.json(dashboard);
    } catch (error) {
      next(error);
    }
  });

  return router;
}
