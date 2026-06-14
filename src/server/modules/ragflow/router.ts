import express from "express";
import { z } from "zod";
import { config } from "../../config";

const chatSchema = z.object({
  messages: z
    .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().min(1) }))
    .min(1),
});

export function createRagflowRouter(): express.Router {
  const router = express.Router();

  router.post("/api/ragflow/chat", async (req, res, next) => {
    try {
      if (!config.chat.enabled) {
        res.status(503).json({ error: "Chat is not configured" });
        return;
      }

      const { messages } = chatSchema.parse(req.body);

      const upstream = await fetch(`${config.chat.apiUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.chat.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ model: config.chat.model, messages, stream: true }),
      });

      if (!upstream.ok) {
        const text = await upstream.text();
        res.status(502).json({ error: `Upstream error ${upstream.status}`, details: text });
        return;
      }

      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");

      const reader = upstream.body!.getReader();
      const decoder = new TextDecoder();

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(decoder.decode(value, { stream: true }));
        }
      } finally {
        reader.releaseLock();
      }

      res.end();
    } catch (err) {
      next(err);
    }
  });

  return router;
}
