import { Router } from "express";

export const runsRouter = Router();

runsRouter.get("/", (_request, response) => {
  response.status(200).json({ message: "Runs route working" });
});
