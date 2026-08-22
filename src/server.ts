import "dotenv/config";

import { app } from "./app";

const DEFAULT_PORT = 4000;

function getPort(): number {
  const configuredPort = process.env.PORT;

  if (configuredPort === undefined) {
    return DEFAULT_PORT;
  }

  const port = Number(configuredPort);

  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid PORT value: ${configuredPort}`);
  }

  return port;
}

function startServer(): void {
  const port = getPort();

  app.listen(port, () => {
    console.log(`AgentTrace API listening on port ${port}`);
  });
}

startServer();
