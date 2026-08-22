import cors from "cors";
import express from "express";

import { errorHandler } from "./middleware/error.middleware";
import { runsRouter } from "./modules/runs/runs.routes";

const app = express();

app.use(cors());
app.use(express.json());

app.get("/health", (_request, response) => {
  response.status(200).json({ status: "ok" });
});

app.use("/runs", runsRouter);

app.use(errorHandler);

export { app };
