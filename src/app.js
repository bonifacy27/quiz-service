const fs = require("fs");
const path = require("path");
const http = require("http");
const express = require("express");
const session = require("express-session");
const { Server } = require("socket.io");

const config = require("./config");
const webRoutes = require("./routes/web");
const apiRoutes = require("./routes/api");
const registerGameSocket = require("./sockets/gameSocket");
const { ensureExtendedGameSchema } = require("./services/schemaGuard");

fs.mkdirSync(path.resolve(process.cwd(), "public"), { recursive: true });
fs.mkdirSync(path.resolve(process.cwd(), "uploads"), { recursive: true });
fs.mkdirSync(path.resolve(process.cwd(), "data"), { recursive: true });

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.set("io", io);
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(session({
  secret: config.sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true }
}));

app.use(express.static(path.resolve(process.cwd(), "public")));
app.use("/uploads", express.static(config.uploadDir));

app.use(webRoutes);
app.use("/api", apiRoutes);

registerGameSocket(io);

ensureExtendedGameSchema()
  .then(() => {
    server.listen(config.port, () => {
      console.log(`Quiz service started on http://localhost:${config.port}`);
    });
  })
  .catch((error) => {
    console.error("Failed to ensure extended DB schema:", error);
    process.exit(1);
  });
