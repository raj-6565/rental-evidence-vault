const crypto = require("crypto");
const { stableStringify } = require("../utils/crypto");
const { readCollection, writeCollection } = require("../db/store");
const { RentalEvidenceChain } = require("../chain/hashChain");

const SAMPLE_ADDRESS = "221B, Sector 14, Jaipur";

function isSample(lease) {
  return lease.address === SAMPLE_ADDRESS && lease.landlordUsername === "demo_landlord" && lease.tenantUsername === "demo_tenant";
}

async function repairSample() {
  const leases = await readCollection("leases");
  const chains = await readCollection("chains");
  const users = await readCollection("users");
  const broken = Object.values(leases).filter((l) => {
    if (!isSample(l) || !chains[l.id]) return false;
    const publicKeys = { [l.tenantUsername]: users[l.tenantUsername] && users[l.tenantUsername].publicKey, [l.landlordUsername]: users[l.landlordUsername] && users[l.landlordUsername].publicKey };
    return !RentalEvidenceChain.fromJSON(chains[l.id]).verifyChain({ parties: [l.tenantUsername, l.landlordUsername], publicKeys }).valid;
  });
  if (broken.length === 0) return;
  const pending = await readCollection("pendingEvents");
  for (const l of broken) {
    delete leases[l.id];
    delete chains[l.id];
    delete pending[l.id];
  }
  await writeCollection("leases", leases);
  await writeCollection("chains", chains);
  await writeCollection("pendingEvents", pending);
  console.log("Repaired a tampered sample lease.");
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

async function record(base, leaseId, proposer, confirmer, type, data, image) {
  const event = {
    id: "evt-" + crypto.randomBytes(4).toString("hex"),
    type,
    data: { ...data },
    proposedBy: proposer.username,
    createdAt: new Date(Date.now() - 1000).toISOString(),
  };
  if (image) event.data.photoHash = crypto.createHash("sha256").update(image).digest("hex");
  const signature = sign(proposer, leaseId, event);
  let body = { type, id: event.id, createdAt: event.createdAt, signature, data: event.data };
  if (image) {
    body = new FormData();
    body.append("type", type);
    body.append("id", event.id);
    body.append("createdAt", event.createdAt);
    body.append("signature", signature);
    body.append("data", JSON.stringify(event.data));
    body.append("photo", new Blob([image], { type: "image/jpeg" }), "photo.jpg");
  }
  const created = await call(base, "POST", `/api/leases/${leaseId}/events`, proposer.token, body);
  event.photoId = created.photoId;
  if (confirmer) {
    const detail = await call(base, "GET", `/api/leases/${leaseId}`, confirmer.token);
    const blocks = detail.chain.blocks;
    const prevHash = blocks.length ? blocks[blocks.length - 1].blockHash : "0".repeat(64);
    await call(base, "POST", `/api/leases/${leaseId}/events/${event.id}/confirm`, confirmer.token, { signature: sign(confirmer, leaseId, event, prevHash) });
  }
}

async function ensureDemoData(base) {
  await repairSample();
  const tenant = await loginOrRegister(base, "demo_tenant", "tenant");
  const landlord = await loginOrRegister(base, "demo_landlord", "landlord");
  const leases = await call(base, "GET", "/api/leases", landlord.token);
  if ((Array.isArray(leases) ? leases : leases.leases || []).some(isSample)) return false;
  const lease = await call(base, "POST", "/api/leases", landlord.token, {
    address: SAMPLE_ADDRESS,
    tenantUsername: tenant.username,
    rentAmount: 18000,
    startDate: "2026-08-01",
  });
  await record(base, lease.id, tenant, landlord, "MOVE_IN", { description: "Hairline crack on the bedroom window, walls otherwise clean" }, null);
  await record(base, lease.id, tenant, landlord, "PAYMENT", { description: "Rent for this month", amount: 18000 }, null);
  await record(base, lease.id, tenant, landlord, "MAINTENANCE", { description: "Kitchen tap is leaking" }, null);
  await record(base, lease.id, landlord, null, "MAINTENANCE_UPDATE", { description: "Plumber fixed the kitchen tap" }, null);
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
