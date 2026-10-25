const express = require("express");
const { readCollection, writeCollection } = require("../db/store");
const { requireAuth } = require("./auth");
const { asyncHandler } = require("../utils/asyncHandler");
const { getLeaseForParty } = require("../utils/access");
const {
  ZERO_HASH,
  KINDS,
  validateData,
  stepMessage,
  stepHash,
  lastStep,
  statusOf,
  societyOf,
  verifyTrail,
} = require("../utils/requestTrail");
const { verifySignature } = require("../utils/crypto");

const router = express.Router();
const ONE_DAY = 24 * 60 * 60 * 1000;

function validTime(at) {
  const d = new Date(at);
  return typeof at === "string" && !Number.isNaN(d.getTime()) && Math.abs(Date.now() - d.getTime()) <= ONE_DAY;
}

function present(request, lease, users, viewer) {
  const society = societyOf(request);
  const keys = {};
  for (const name of [request.landlordUsername, society]) {
    if (name && users[name]) keys[name] = users[name].publicKey;
  }
  const closed = request.steps.find((s) => s.kind === "CLOSED");
  return {
    id: request.id,
    leaseId: request.leaseId,
    leaseAddress: lease ? lease.address : null,
    landlordUsername: request.landlordUsername,
    tenantUsername: viewer.role === "society" ? null : request.tenantUsername,
    societyUsername: society,
    status: statusOf(request),
    lastKind: lastStep(request).kind,
    ledgerEventId: closed ? closed.data.ledgerEventId : null,
    steps: request.steps,
    publicKeys: keys,
    check: verifyTrail(request, keys),
  };
}

router.get("/", requireAuth, asyncHandler(async (req, res) => {
  const requests = await readCollection("requests");
  const leases = await readCollection("leases");
  const users = await readCollection("users");
  let mine;

  if (req.user.role === "society") {
    mine = Object.values(requests).filter((r) => societyOf(r) === req.user.username);
  } else {
    const lease = await getLeaseForParty(req, res, req.query.leaseId);
    if (!lease) return;
    mine = Object.values(requests).filter((r) => r.leaseId === lease.id);
  }

  mine.sort((a, b) => b.steps[0].at.localeCompare(a.steps[0].at));
  res.json({ requests: mine.map((r) => present(r, leases[r.leaseId], users, req.user)) });
}));

router.post("/", requireAuth, asyncHandler(async (req, res) => {
  const { leaseId, id, at, data, signature } = req.body;
  const lease = await getLeaseForParty(req, res, leaseId);
  if (!lease) return;
  if (lease.landlordUsername !== req.user.username) {
    return res.status(403).json({ error: "only the landlord can send a request to the society office" });
  }
  if (lease.status !== "active") return res.status(409).json({ error: "this lease has ended" });
  if (!lease.societyUsername) return res.status(400).json({ error: "choose the society office for this lease first" });
  if (typeof id !== "string" || !/^req-[0-9a-f]{8}$/.test(id)) return res.status(400).json({ error: "a valid request id is required" });
  if (!validTime(at)) return res.status(400).json({ error: "the time must be a current ISO timestamp" });

  const problem = validateData("REQUESTED", data);
  if (problem) return res.status(400).json({ error: problem });
  if (data.society !== lease.societyUsername) return res.status(400).json({ error: "the request must be addressed to this lease's society office" });

  const chains = await readCollection("chains");
  const blocks = (chains[lease.id] && chains[lease.id].blocks) || [];
  if (lease.requireAgreement && !blocks.some((b) => b.type === "AGREEMENT")) {
    return res.status(409).json({ error: "record and sign the agreement first" });
  }

  const requests = await readCollection("requests");
  if (requests[id]) return res.status(409).json({ error: "request id already used" });

  const message = stepMessage({ requestId: id, leaseId: lease.id, kind: "REQUESTED", by: req.user.username, at, data, prevHash: ZERO_HASH });
  if (!verifySignature(req.user.publicKey, message, signature)) {
    return res.status(400).json({ error: "signature does not verify against your registered key" });
  }

  const step = { index: 0, kind: "REQUESTED", by: req.user.username, at, data, prevHash: ZERO_HASH, signature };
  step.stepHash = stepHash({ requestId: id, ...step });
  requests[id] = {
    id,
    leaseId: lease.id,
    landlordUsername: lease.landlordUsername,
    tenantUsername: lease.tenantUsername,
    steps: [step],
  };
  await writeCollection("requests", requests);

  const users = await readCollection("users");
  res.status(201).json(present(requests[id], lease, users, req.user));
}));

router.post("/:id/steps", requireAuth, asyncHandler(async (req, res) => {
  const requests = await readCollection("requests");
  const request = requests[req.params.id];
  if (!request) return res.status(404).json({ error: "request not found" });

  const { kind, at, data, signature } = req.body;
  const spec = KINDS[kind];
  if (!spec || kind === "REQUESTED") return res.status(400).json({ error: "unknown step" });

  const society = societyOf(request);
  const expectedActor = spec.actor === "landlord" ? request.landlordUsername : society;
  if (req.user.username !== expectedActor) {
    return res.status(403).json({ error: spec.actor === "landlord" ? "only the landlord can do this" : "only the society office can do this" });
  }
  if (!spec.from.includes(lastStep(request).kind)) {
    return res.status(409).json({ error: `this can't be done while the request is ${statusOf(request).toLowerCase()}` });
  }
  if (!validTime(at)) return res.status(400).json({ error: "the time must be a current ISO timestamp" });

  const problem = validateData(kind, data);
  if (problem) return res.status(400).json({ error: problem });

  const leases = await readCollection("leases");
  const lease = leases[request.leaseId];
  if (spec.actor === "landlord" && kind !== "CANCELLED" && (!lease || lease.status !== "active")) {
    return res.status(409).json({ error: "this lease has ended" });
  }

  const prev = lastStep(request);
  const message = stepMessage({ requestId: request.id, leaseId: request.leaseId, kind, by: req.user.username, at, data, prevHash: prev.stepHash });
  if (!verifySignature(req.user.publicKey, message, signature)) {
    return res.status(400).json({ error: "signature does not verify against your registered key, or the request changed while you were signing. Refresh and try again." });
  }

  const step = { index: request.steps.length, kind, by: req.user.username, at, data, prevHash: prev.stepHash, signature };
  step.stepHash = stepHash({ requestId: request.id, ...step });
  request.steps.push(step);
  requests[request.id] = request;
  await writeCollection("requests", requests);

  const users = await readCollection("users");
  res.json(present(request, lease, users, req.user));
}));

module.exports = router;
