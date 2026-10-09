const express = require("express");
const crypto = require("crypto");
const { readCollection, writeCollection } = require("../db/store");
const { RentalEvidenceChain } = require("../chain/hashChain");
const { requireAuth } = require("./auth");
const { getLeaseForParty, getPartyKeys } = require("../utils/access");
const { computeRentStatus } = require("../utils/rent");
const { asyncHandler } = require("../utils/asyncHandler");

const router = express.Router();

router.post("/", requireAuth, asyncHandler(async (req, res) => {
  if (req.user.role !== "landlord") {
    return res.status(403).json({ error: "only a landlord can create a lease" });
  }

  const { address, tenantUsername, rentAmount, startDate, demo } = req.body;
  const landlordUsername = req.user.username;
  if (!address || !tenantUsername) {
    return res.status(400).json({ error: "address and tenantUsername are required" });
  }

  const users = await readCollection("users");
  if (!users[tenantUsername] || users[tenantUsername].role !== "tenant") {
    return res.status(400).json({ error: `no tenant account found for "${tenantUsername}"` });
  }

  const leases = await readCollection("leases");
  const id = "lease-" + crypto.randomBytes(4).toString("hex");
  leases[id] = {
    id,
    address,
    tenantUsername,
    landlordUsername,
    rentAmount: rentAmount || null,
    startDate: startDate || null,
    status: "active",
    demo: demo === true,
    createdAt: new Date().toISOString(),
  };
  await writeCollection("leases", leases);

  const chains = await readCollection("chains");
  chains[id] = new RentalEvidenceChain(id).toJSON();
  await writeCollection("chains", chains);

  const pendingEvents = await readCollection("pendingEvents");
  pendingEvents[id] = [];
  await writeCollection("pendingEvents", pendingEvents);

  res.status(201).json(leases[id]);
}));

router.get("/", requireAuth, asyncHandler(async (req, res) => {
  const leases = await readCollection("leases");
  const mine = Object.values(leases).filter(
    (l) => l.tenantUsername === req.user.username || l.landlordUsername === req.user.username
  );
  const chains = await readCollection("chains");
  res.json(mine.map((l) => {
    const blocks = (chains[l.id] && chains[l.id].blocks) || [];
    return { ...l, rent: computeRentStatus(l, blocks) };
  }));
}));

router.get("/:id", requireAuth, asyncHandler(async (req, res) => {
  const lease = await getLeaseForParty(req, res, req.params.id);
  if (!lease) return;

  const chains = await readCollection("chains");
  const pendingEvents = await readCollection("pendingEvents");

  const chain = chains[lease.id] || { leaseId: lease.id, blocks: [] };
  const keys = await getPartyKeys(lease);

  res.json({
    lease,
    chain,
    pendingEvents: pendingEvents[lease.id] || [],
    rent: computeRentStatus(lease, chain.blocks),
    publicKeys: keys.publicKeys,
    fingerprints: keys.fingerprints,
  });
}));

router.post("/:id/end", requireAuth, asyncHandler(async (req, res) => {
  const lease = await getLeaseForParty(req, res, req.params.id);
  if (!lease) return;

  const leases = await readCollection("leases");
  lease.status = "ended";
  lease.endedAt = new Date().toISOString();
  leases[lease.id] = lease;
  await writeCollection("leases", leases);

  res.json(lease);
}));

module.exports = router;
