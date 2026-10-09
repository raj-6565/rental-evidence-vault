const { readCollection } = require("../db/store");
const { fingerprint } = require("./crypto");

async function getLeaseForParty(req, res, leaseId) {
  const leases = await readCollection("leases");
  const lease = leases[leaseId];
  if (!lease) {
    res.status(404).json({ error: "lease not found" });
    return null;
  }
  if (![lease.tenantUsername, lease.landlordUsername].includes(req.user.username)) {
    res.status(403).json({ error: "you are not a party to this lease" });
    return null;
  }
  return lease;
}

async function getPartyKeys(lease) {
  const users = await readCollection("users");
  const parties = [lease.tenantUsername, lease.landlordUsername];
  const publicKeys = {};
  const fingerprints = {};
  for (const name of parties) {
    publicKeys[name] = users[name].publicKey;
    fingerprints[name] = fingerprint(users[name].publicKey);
  }
  return { parties, publicKeys, fingerprints };
}

module.exports = { getLeaseForParty, getPartyKeys };
