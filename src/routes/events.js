const express = require("express");
const crypto = require("crypto");
const multer = require("multer");
const { readCollection, writeCollection, savePhoto } = require("../db/store");
const { RentalEvidenceChain, eventPayload } = require("../chain/hashChain");
const { hashFile, stableStringify, verifySignature } = require("../utils/crypto");
const { requireAuth } = require("./auth");
const { asyncHandler } = require("../utils/asyncHandler");
const { getLeaseForParty } = require("../utils/access");

const router = express.Router({ mergeParams: true });

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith("image/")) return cb(new Error("Only image files are allowed"));
    cb(null, true);
  },
});

const VALID_TYPES = ["MOVE_IN", "MOVE_OUT", "PAYMENT", "MAINTENANCE", "MAINTENANCE_UPDATE"];
const ALLOWED_DATA_KEYS = ["description", "amount", "photoHash"];
const ONE_DAY = 24 * 60 * 60 * 1000;

router.post("/", requireAuth, upload.single("photo"), asyncHandler(async (req, res) => {
  const lease = await getLeaseForParty(req, res, req.params.leaseId);
  if (!lease) return;
  if (lease.status !== "active") {
    return res.status(409).json({ error: "this lease has ended, no new events can be added" });
  }

  const { type, id, createdAt, signature } = req.body;
  let data;
  try {
    data = typeof req.body.data === "string" ? JSON.parse(req.body.data) : req.body.data;
  } catch {
    return res.status(400).json({ error: "data must be valid JSON" });
  }

  if (!VALID_TYPES.includes(type)) {
    return res.status(400).json({ error: `type must be one of ${VALID_TYPES.join(", ")}` });
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return res.status(400).json({ error: "data (object) is required" });
  }
  if (!Object.keys(data).every((k) => ALLOWED_DATA_KEYS.includes(k))) {
    return res.status(400).json({ error: `data may only contain ${ALLOWED_DATA_KEYS.join(", ")}` });
  }
  if (typeof id !== "string" || !/^evt-[0-9a-f]{8}$/.test(id)) {
    return res.status(400).json({ error: "a valid event id is required" });
  }
  const created = new Date(createdAt);
  if (typeof createdAt !== "string" || Number.isNaN(created.getTime()) || Math.abs(Date.now() - created.getTime()) > ONE_DAY) {
    return res.status(400).json({ error: "createdAt must be a current ISO timestamp" });
  }

  const pendingEvents = await readCollection("pendingEvents");
  const chains = await readCollection("chains");
  const leaseEvents = pendingEvents[lease.id] || [];
  const blocks = (chains[lease.id] && chains[lease.id].blocks) || [];
  if (leaseEvents.some((e) => e.id === id) || blocks.some((b) => b.eventId === id)) {
    return res.status(409).json({ error: "event id already used" });
  }

  const event = {
    id,
    type,
    data,
    photoId: null,
    proposedBy: req.user.username,
    createdAt,
    proposerSignature: signature,
    confirmedBy: [req.user.username],
  };

  const message = stableStringify(eventPayload(lease.id, event));
  if (!verifySignature(req.user.publicKey, message, signature)) {
    return res.status(400).json({ error: "signature does not verify against your registered key" });
  }

  if (req.file) {
    if (data.photoHash !== hashFile(req.file.buffer)) {
      return res.status(400).json({ error: "photo does not match the hash you signed" });
    }
    event.photoId = "ph-" + crypto.randomBytes(6).toString("hex");
    await savePhoto({
      id: event.photoId,
      leaseId: lease.id,
      mime: req.file.mimetype,
      hash: data.photoHash,
      uploadedBy: req.user.username,
      bytes: req.file.buffer,
    });
  } else if (data.photoHash !== undefined) {
    return res.status(400).json({ error: "photoHash was signed but no photo was uploaded" });
  }

  leaseEvents.push(event);
  pendingEvents[lease.id] = leaseEvents;
  await writeCollection("pendingEvents", pendingEvents);

  res.status(201).json(event);
}));

router.post("/:eventId/confirm", requireAuth, asyncHandler(async (req, res) => {
  const lease = await getLeaseForParty(req, res, req.params.leaseId);
  if (!lease) return;
  if (lease.status !== "active") {
    return res.status(409).json({ error: "this lease has ended, no new events can be added" });
  }

  const pendingEvents = await readCollection("pendingEvents");
  const leaseEvents = pendingEvents[lease.id] || [];
  const event = leaseEvents.find((e) => e.id === req.params.eventId);
  if (!event) return res.status(404).json({ error: "pending event not found" });

  if (event.proposedBy === req.user.username) {
    return res.status(400).json({ error: "the other party has to confirm this event" });
  }

  const message = stableStringify(eventPayload(lease.id, event));
  if (!verifySignature(req.user.publicKey, message, req.body.signature)) {
    return res.status(400).json({ error: "signature does not verify against your registered key" });
  }

  const chains = await readCollection("chains");
  const chain = RentalEvidenceChain.fromJSON(chains[lease.id] || { leaseId: lease.id, blocks: [] });
  const block = chain.addSignedEvent({
    event,
    confirmedBy: req.user.username,
    confirmerSignature: req.body.signature,
  });
  chains[lease.id] = chain.toJSON();
  await writeCollection("chains", chains);

  pendingEvents[lease.id] = leaseEvents.filter((e) => e.id !== event.id);
  await writeCollection("pendingEvents", pendingEvents);

  res.json({ status: "finalized", block });
}));

module.exports = router;
