import express from "express";
import { getBranchDiffDashboard } from "./service";

export function createBranchDiffRouter(): express.Router {
  const router = express.Router();

  router.get("/api/git-repo-diff", (_req, res, next) => {
    try {
      res.json(getBranchDiffDashboard());
    } catch (error) {
      next(error);
    }
  });

  return router;
}
