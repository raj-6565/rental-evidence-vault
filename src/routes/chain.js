const express = require("express");
const { readCollection, writeCollection } = require("../db/store");
const { RentalEvidenceChain } = require("../chain/hashChain");
const { requireAuth } = require("./auth");
const { getLeaseForParty, getPartyKeys } = require("../utils/access");
const { asyncHandler } = require("../utils/asyncHandler");
const { isSample } = require("../demo/demo");
const { societyOf } = require("../utils/requestTrail");

const router = express.Router({ mergeParams: true });

async function loadChainAndLease(req, res) {
  const lease = await getLeaseForParty(req, res, req.params.leaseId);
  if (!lease) return null;
  const chains = await readCollection("chains");
  const chain = RentalEvidenceChain.fromJSON(chains[lease.id] || { leaseId: lease.id, blocks: [] });
  const keys = await getPartyKeys(lease);
  return { lease, chain, keys };
}

router.get("/verify", requireAuth, asyncHandler(async (req, res) => {
  const result = await loadChainAndLease(req, res);
  if (!result) return;
  const { chain, keys } = result;
  res.json(chain.verifyChain(keys));
}));

router.post("/demo-tamper", requireAuth, asyncHandler(async (req, res) => {
  const result = await loadChainAndLease(req, res);
  if (!result) return;
  const { lease, chain } = result;

  if (isSample(lease)) {
    return res.status(403).json({ error: "the shared sample lease cannot be tampered with. Create your own lease with the demo option ticked to try the simulator." });
  }
  if (!lease.demo) {
    return res.status(403).json({ error: "tampering can only be simulated on a lease created as a demo lease" });
  }
  if (chain.blocks.length === 0) {
    return res.status(400).json({ error: "no blocks to tamper with yet - log and confirm an event first" });
  }

  const { blockIndex, newData, rehash } = req.body;
  const idx = blockIndex ?? 0;
  if (!chain.blocks[idx]) return res.status(400).json({ error: `no block at index ${idx}` });

  const original = chain.blocks[idx].data;
  const replacement = newData || { ...original, description: "TAMPERED: this was secretly edited after the fact" };
  chain.tamperForDemo(idx, replacement, rehash === true);

  const chains = await readCollection("chains");
  chains[lease.id] = chain.toJSON();
  await writeCollection("chains", chains);

  const message = rehash === true
    ? `Block ${idx} was edited and every hash after it was recomputed, like a dishonest admin would do. Verify to see the signatures catch it.`
    : `Block ${idx}'s data was edited. Verify to see it get caught.`;
  res.json({ message, block: chain.blocks[idx] });
}));

router.get("/export", requireAuth, asyncHandler(async (req, res) => {
  const result = await loadChainAndLease(req, res);
  if (!result) return;
  const { lease, chain, keys } = result;

  const users = await readCollection("users");
  const allRequests = await readCollection("requests");
  const requests = Object.values(allRequests)
    .filter((r) => r.leaseId === lease.id)
    .map((r) => ({
      id: r.id,
      landlord: r.landlordUsername,
      society: societyOf(r),
      publicKeys: { [r.landlordUsername]: users[r.landlordUsername].publicKey, [societyOf(r)]: users[societyOf(r)] && users[societyOf(r)].publicKey },
      steps: r.steps,
    }));

  const packet = {
    generatedAt: new Date().toISOString(),
    lease: { id: lease.id, address: lease.address, tenant: lease.tenantUsername, landlord: lease.landlordUsername },
    publicKeys: keys.publicKeys,
    fingerprints: keys.fingerprints,
    integrityCheck: chain.verifyChain(keys),
    blocks: chain.blocks,
    societyRequests: requests,
    howToVerifyRequests:
      "For each request, go through its steps in order. The first step has prevHash of 64 zeros, every later step has prevHash equal to the stepHash before it. Check that SHA-256 of the serialised object {requestId, index, kind, by, at, data, prevHash, signature} (keys sorted) equals stepHash. Check the signature over the serialised object {v:1, requestId, leaseId, kind, by, at, data, prevHash} using the public key listed for the person in the by field. Requests and ledger entries are linked: a CLOSED step names the ledger event id (ledgerEventId) it created.",
    howToVerify:
      "For each block: rebuild the payload {v:1, leaseId, eventId, type, data, proposedBy, createdAt}, serialise it with keys sorted, and check its SHA-256 equals dataHash. Check the proposerSignature over that serialised payload, and the confirmerSignature over the serialised object {payload, prevHash} (the payload plus the previous block's hash), using the listed public keys. Check blockHash and that prevHash equals the previous blockHash.",
  };

  res.setHeader("Content-Disposition", `attachment; filename="dispute-export-${lease.id}.json"`);
  res.json(packet);
}));

module.exports = router;
