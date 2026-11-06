import { configuration } from "./config.js";
import { createApp } from "./app.js";
const config = configuration(),
  { app, store } = createApp(config);
const server = app.listen(config.port, config.host, () =>
  console.log("KagNode Media web server started."),
);
server.requestTimeout = 60000;
server.headersTimeout = 15000;
server.maxRequestsPerSocket = 200;
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () =>
    server.close(() => {
      store.close();
      process.exit(0);
    }),
  );
