function computeRentStatus(lease, blocks, now = new Date()) {
  if (!lease.rentAmount || !lease.startDate) {
    return { status: "Not tracked", paidThisMonth: 0, dueDay: null };
  }
  const dueDay = new Date(lease.startDate).getUTCDate();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const paidThisMonth = blocks
    .filter((b) => b.type === "PAYMENT" && b.data.amount && new Date(b.finalizedAt) >= monthStart)
    .reduce((sum, b) => sum + Number(b.data.amount), 0);

  let status = "Overdue";
  if (paidThisMonth >= Number(lease.rentAmount)) status = "Paid";
  else if (now.getUTCDate() <= dueDay) status = "Due";
  return { status, paidThisMonth, dueDay };
}

module.exports = { computeRentStatus };
