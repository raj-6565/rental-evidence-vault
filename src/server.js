const express = require("express");
const path = require("path");
const { ping } = require("./db/store");
const { router: authRouter } = require("./routes/auth");
const leasesRouter = require("./routes/leases");
const eventsRouter = require("./routes/events");
const chainRouter = require("./routes/chain");
const photosRouter = require("./routes/photos");

process.on("unhandledRejection", (err) => {
  console.error("unhandled rejection:", err && err.message ? err.message : err);
});

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "public")));

app.use("/api/auth", authRouter);
app.use("/api/leases", leasesRouter);
app.use("/api/leases/:leaseId/events", eventsRouter);
app.use("/api/leases/:leaseId/chain", chainRouter);
app.use("/api/leases/:leaseId/photos", photosRouter);

app.get("/api/health", async (req, res) => {
  try {
    await ping();
    res.json({ status: "ok", database: "connected" });
  } catch (err) {
    res.status(503).json({ status: "degraded", database: "unreachable", reason: err.message });
  }
});

app.use((err, req, res, next) => {
  if (err.code === "LIMIT_FILE_SIZE") {
    return res.status(400).json({ error: "photo must be under 5MB" });
  }
  if (err.message === "Only image files are allowed") {
    return res.status(400).json({ error: err.message });
  }
  console.error(err);
  res.status(500).json({ error: "something went wrong" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Rental Evidence Vault running on port ${PORT}`);
  console.log("DATABASE_URL:", process.env.DATABASE_URL ? "set" : "NOT SET");
});
