function leasePhase(lease, blocks) {
  if (lease.status === "ended") return "ended";
  const has = (type) => blocks.some((b) => b.type === type);
  if (has("MOVE_OUT")) return "move-out";
  if (has("MOVE_IN")) return "tenancy";
  if (lease.requireAgreement && !has("AGREEMENT")) return "agreement";
  return "move-in";
}

module.exports = { leasePhase };
