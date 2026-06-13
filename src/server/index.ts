import "./env.js";
import { createApp } from "./app";

const port = Number(process.env.PORT ?? 8080);

createApp().listen(port, () => {
  console.log(`DevOps customer portal API listening on port ${port}`);
});
