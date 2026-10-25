const crypto = require("crypto");
const { stableStringify } = require("../utils/crypto");
const { readCollection, writeCollection } = require("../db/store");
const { RentalEvidenceChain } = require("../chain/hashChain");
const { stepMessage, ZERO_HASH } = require("../utils/requestTrail");

const SAMPLE_ADDRESS = "221B, Sector 14, Jaipur";
const SOCIETY_NAME = "demo_society";

function isSample(lease) {
  return lease.address === SAMPLE_ADDRESS && lease.landlordUsername === "demo_landlord" && lease.tenantUsername === "demo_tenant";
}

async function repairSample() {
  const leases = await readCollection("leases");
  const chains = await readCollection("chains");
  const users = await readCollection("users");
  const allRequests = await readCollection("requests");
  const broken = Object.values(leases).filter((l) => {
    if (!isSample(l)) return false;
    if (!l.requireAgreement || l.societyUsername !== SOCIETY_NAME) return true;
    if (Object.values(allRequests).filter((r) => r.leaseId === l.id).length < 2) return true;
    if (!chains[l.id]) return false;
    const publicKeys = { [l.tenantUsername]: users[l.tenantUsername] && users[l.tenantUsername].publicKey, [l.landlordUsername]: users[l.landlordUsername] && users[l.landlordUsername].publicKey };
    return !RentalEvidenceChain.fromJSON(chains[l.id]).verifyChain({ parties: [l.tenantUsername, l.landlordUsername], publicKeys }).valid;
  });
  if (broken.length === 0) return;
  const pending = await readCollection("pendingEvents");
  const requests = allRequests;
  for (const l of broken) {
    delete leases[l.id];
    delete chains[l.id];
    delete pending[l.id];
    for (const r of Object.values(requests)) if (r.leaseId === l.id) delete requests[r.id];
  }
  await writeCollection("leases", leases);
  await writeCollection("chains", chains);
  await writeCollection("pendingEvents", pending);
  await writeCollection("requests", requests);
  console.log("Replaced an outdated or tampered sample lease.");
}

const PASSWORD = "demo1234";
const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

function seedFor(username) {
  return crypto.createHash("sha256").update("rev-demo-key:" + username).digest();
}

function keyFor(username) {
  const privateKey = crypto.createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, seedFor(username)]), format: "der", type: "pkcs8" });
  const publicHex = crypto.createPublicKey(privateKey).export({ type: "spki", format: "der" }).toString("hex");
  return { privateKey, publicHex };
}

async function call(base, method, url, token, body) {
  const headers = token ? { Authorization: "Bearer " + token } : {};
  if (body && !(body instanceof FormData)) headers["Content-Type"] = "application/json";
  const res = await fetch(base + url, { method, headers, body: body instanceof FormData ? body : body && JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${url}: ${json.error || res.status}`);
  return json;
}

async function loginOrRegister(base, username, role) {
  const key = keyFor(username);
  try {
    const login = await call(base, "POST", "/api/auth/login", null, { username, password: PASSWORD });
    return { username, key, token: login.token };
  } catch (e) {
    await call(base, "POST", "/api/auth/register", null, { username, password: PASSWORD, role, publicKey: key.publicHex });
    const login = await call(base, "POST", "/api/auth/login", null, { username, password: PASSWORD });
    return { username, key, token: login.token };
  }
}

function sign(user, leaseId, event, prevHash) {
  const payload = { v: 1, leaseId, eventId: event.id, type: event.type, data: event.data, proposedBy: event.proposedBy, createdAt: event.createdAt };
  const message = prevHash ? stableStringify({ payload, prevHash }) : stableStringify(payload);
  return crypto.sign(null, Buffer.from(message), user.key.privateKey).toString("hex");
}

function agreementPdf() {
  const text = "BT /F1 14 Tf 20 150 Td (Sample rental agreement) Tj 0 -24 Td (Rent 18000 per month, 11 months) Tj 0 -24 Td (Security deposit 36000) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += String(off).padStart(10, "0") + " 00000 n \n";
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out);
}

async function record(base, leaseId, proposer, confirmer, type, data, file, forcedId) {
  const event = {
    id: forcedId || "evt-" + crypto.randomBytes(4).toString("hex"),
    type,
    data: { ...data },
    proposedBy: proposer.username,
    createdAt: new Date(Date.now() - 1000).toISOString(),
  };
  if (file) event.data.photoHash = crypto.createHash("sha256").update(file.bytes).digest("hex");
  const signature = sign(proposer, leaseId, event);
  let body = { type, id: event.id, createdAt: event.createdAt, signature, data: event.data };
  if (file) {
    body = new FormData();
    body.append("type", type);
    body.append("id", event.id);
    body.append("createdAt", event.createdAt);
    body.append("signature", signature);
    body.append("data", JSON.stringify(event.data));
    body.append("photo", new Blob([file.bytes], { type: file.mime }), file.name);
  }
  const created = await call(base, "POST", `/api/leases/${leaseId}/events`, proposer.token, body);
  event.photoId = created.photoId;
  if (confirmer) {
    const detail = await call(base, "GET", `/api/leases/${leaseId}`, confirmer.token);
    const blocks = detail.chain.blocks;
    const prevHash = blocks.length ? blocks[blocks.length - 1].blockHash : "0".repeat(64);
    await call(base, "POST", `/api/leases/${leaseId}/events/${event.id}/confirm`, confirmer.token, { signature: sign(confirmer, leaseId, event, prevHash) });
  }
  return event.id;
}

function signStep(user, requestId, leaseId, kind, data, at, prevHash) {
  const message = stepMessage({ requestId, leaseId, kind, by: user.username, at, data, prevHash });
  return crypto.sign(null, Buffer.from(message), user.key.privateKey).toString("hex");
}

async function openRequest(base, leaseId, landlord, society, data) {
  const id = "req-" + crypto.randomBytes(4).toString("hex");
  const at = new Date(Date.now() - 1000).toISOString();
  const full = { ...data, society: society.username };
  const res = await call(base, "POST", "/api/requests", landlord.token, {
    leaseId,
    id,
    at,
    data: full,
    signature: signStep(landlord, id, leaseId, "REQUESTED", full, at, ZERO_HASH),
  });
  return { id, last: res.steps[res.steps.length - 1] };
}

async function takeStep(base, request, leaseId, user, kind, data) {
  const at = new Date(Date.now() - 500).toISOString();
  const res = await call(base, "POST", `/api/requests/${request.id}/steps`, user.token, {
    kind,
    at,
    data,
    signature: signStep(user, request.id, leaseId, kind, data, at, request.last.stepHash),
  });
  request.last = res.steps[res.steps.length - 1];
  return request.last;
}

async function ensureDemoData(base) {
  await repairSample();
  const tenant = await loginOrRegister(base, "demo_tenant", "tenant");
  const landlord = await loginOrRegister(base, "demo_landlord", "landlord");
  const society = await loginOrRegister(base, SOCIETY_NAME, "society");
  const leases = await call(base, "GET", "/api/leases", landlord.token);
  if ((Array.isArray(leases) ? leases : leases.leases || []).some(isSample)) return false;
  const lease = await call(base, "POST", "/api/leases", landlord.token, {
    address: SAMPLE_ADDRESS,
    tenantUsername: tenant.username,
    rentAmount: 18000,
    startDate: "2026-08-01",
    requireAgreement: true,
    societyUsername: society.username,
  });
  const id = lease.id;

  await record(base, id, tenant, landlord, "VERIFICATION", { description: "Identity and address proofs shown to each other. Police verification form submitted." });
  await record(base, id, landlord, tenant, "AGREEMENT", { description: "Rental agreement: ₹18,000 per month for 11 months, security deposit ₹36,000, 30 days notice.", amount: 18000 }, { bytes: agreementPdf(), mime: "application/pdf", name: "agreement.pdf" });
  await record(base, id, tenant, landlord, "DEPOSIT", { description: "Security deposit paid by bank transfer", amount: 36000 });
  await record(base, id, tenant, landlord, "MOVE_IN", { description: "Hairline crack on the bedroom window, walls otherwise clean" });
  await record(base, id, tenant, landlord, "PAYMENT", { description: "Rent for this month", amount: 18000 });
  await record(base, id, tenant, landlord, "MAINTENANCE", { description: "Kitchen tap is leaking" });

  const tap = await openRequest(base, id, landlord, society, { category: "Plumbing", description: "Kitchen tap is leaking, please send the society plumber", urgency: "Normal" });
  await takeStep(base, tap, id, society, "ACKNOWLEDGED", { note: "Plumber assigned", expectedBy: new Date(Date.now() + 86400000).toISOString().slice(0, 10) });
  const done = await takeStep(base, tap, id, society, "COMPLETED", { note: "Washer replaced and tap tested" });
  const ledgerId = "evt-" + crypto.randomBytes(4).toString("hex");
  await takeStep(base, tap, id, landlord, "CLOSED", { note: "Checked, no leak", ledgerEventId: ledgerId });
  await record(base, id, landlord, null, "MAINTENANCE_UPDATE", { description: `Society request ${tap.id} closed: plumbing, kitchen tap. Completion record ${done.stepHash.slice(0, 16)}.` }, null, ledgerId);

  await openRequest(base, id, landlord, society, { category: "Lift or common area", description: "The lift stops at the second floor, please check", urgency: "Urgent" });
  return true;
}

async function startDemoData(base) {
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const created = await ensureDemoData(base);
      console.log(created ? "Demo data created." : "Demo data already present.");
      return;
    } catch (err) {
      console.error(`demo data attempt ${attempt} failed:`, err.message);
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
}

module.exports = { startDemoData, isSample };
