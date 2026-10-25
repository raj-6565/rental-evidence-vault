const express = require("express");
const { getPhoto, readCollection } = require("../db/store");
const { hashFile } = require("../utils/crypto");
const { requireAuth } = require("./auth");
const { asyncHandler } = require("../utils/asyncHandler");
const { getLeaseForParty } = require("../utils/access");

const router = express.Router({ mergeParams: true });

async function loadPhoto(req, res) {
  const lease = await getLeaseForParty(req, res, req.params.leaseId);
  if (!lease) return null;
  const photo = await getPhoto(req.params.photoId);
  if (!photo || photo.lease_id !== lease.id) {
    res.status(404).json({ error: "photo not found" });
    return null;
  }
  return { lease, photo };
}

router.get("/:photoId", requireAuth, asyncHandler(async (req, res) => {
  const found = await loadPhoto(req, res);
  if (!found) return;
  res.setHeader("Content-Type", found.photo.mime);
  res.setHeader("Cache-Control", "private, max-age=3600");
  res.send(found.photo.bytes);
}));

router.get("/:photoId/verify", requireAuth, asyncHandler(async (req, res) => {
  const found = await loadPhoto(req, res);
  if (!found) return;
  const { lease, photo } = found;
  const recomputedHash = hashFile(photo.bytes);
  const chains = await readCollection("chains");
  const blocks = (chains[lease.id] && chains[lease.id].blocks) || [];
  const block = blocks.find((b) => b.photoId === photo.id);
  res.json({
    recomputedHash,
    matchesStoredHash: recomputedHash === photo.hash,
    inChain: Boolean(block),
    blockIndex: block ? block.index : null,
    matchesChainHash: block ? block.data.photoHash === recomputedHash : null,
  });
}));

module.exports = router;
