const crypto = require("crypto");
const { webcrypto } = crypto;
const B = process.argv[2] || process.env.BASE_URL || "http://localhost:3000";
const tag = Date.now().toString(36);
let fails = 0;
const check = (n, ok, x = "") => { console.log((ok ? "PASS " : "FAIL ") + n + (x ? " | " + x : "")); if (!ok) fails++; };
const hex = (b) => Buffer.from(b).toString("hex");
function stable(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(stable).join(",") + "]";
  return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + stable(v[k])).join(",") + "}";
}
async function newUser(name, role) {
  const kp = await webcrypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const publicKey = hex(await webcrypto.subtle.exportKey("spki", kp.publicKey));
  const r = await post("/api/auth/register", { username: name, password: "pass1234", role, publicKey });
  const l = await post("/api/auth/login", { username: name, password: "pass1234" });
  return { name, kp, publicKey, token: l.body.token, regStatus: r.status };
}
async function post(path, body, token, raw) {
  const r = await fetch(B + path, { method: "POST", headers: Object.assign(raw ? {} : { "content-type": "application/json" }, token ? { authorization: "Bearer " + token } : {}), body: raw ? body : JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}
async function get(path, token) {
  const r = await fetch(B + path, { headers: { authorization: "Bearer " + token } });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}
const sign = async (u, msg) => hex(await webcrypto.subtle.sign({ name: "Ed25519" }, u.kp.privateKey, Buffer.from(msg)));
const payload = (leaseId, e) => ({ v: 1, leaseId, eventId: e.id, type: e.type, data: e.data, proposedBy: e.proposedBy, createdAt: e.createdAt });
const evId = () => "evt-" + crypto.randomBytes(4).toString("hex");

(async () => {
  const bad = await post("/api/auth/register", { username: "x" + tag, password: "pass1234", role: "tenant" });
  check("register without public key rejected", bad.status === 400);
  const t = await newUser("t" + tag, "tenant"), l = await newUser("l" + tag, "landlord"), s = await newUser("s" + tag, "tenant");
  const mk = async (demo) => (await post("/api/leases", { address: "A", tenantUsername: t.name, rentAmount: 1000, startDate: "2026-09-05", demo }, l.token)).body.id;
  const lid = await mk(false);
  const propose = async (user, leaseId, over = {}) => {
    const e = { id: evId(), type: "MOVE_IN", data: { description: "ok" }, proposedBy: user.name, createdAt: new Date().toISOString(), ...over };
    const sig = over.sig || (await sign(user, stable(payload(leaseId, e))));
    return { e, res: await post(`/api/leases/${leaseId}/events`, { type: e.type, id: e.id, createdAt: e.createdAt, signature: sig, data: e.data }, user.token) };
  };

  const good = await propose(t, lid);
  check("valid signed proposal accepted", good.res.status === 201);
  const forged = await propose(t, lid, { sig: await sign(l, "whatever") });
  check("signature from wrong key rejected", forged.res.status === 400, forged.res.body.error);
  const e2 = { id: evId(), type: "MOVE_IN", data: { description: "A" }, proposedBy: t.name, createdAt: new Date().toISOString() };
  const sigA = await sign(t, stable(payload(lid, e2)));
  const swapped = await post(`/api/leases/${lid}/events`, { type: "MOVE_IN", id: e2.id, createdAt: e2.createdAt, signature: sigA, data: { description: "B" } }, t.token);
  check("signed text swapped for different text rejected", swapped.status === 400);
  const dup = await post(`/api/leases/${lid}/events`, { type: "MOVE_IN", id: good.e.id, createdAt: good.e.createdAt, signature: await sign(t, stable(payload(lid, good.e))), data: good.e.data }, t.token);
  check("duplicate event id rejected", dup.status === 409);
  const unknownKey = await propose(t, lid, { data: { description: "x", photoId: "ph-evil" } });
  check("unknown data keys rejected", unknownKey.res.status === 400);
  const fakeHash = await propose(t, lid, { data: { description: "x", photoHash: "0".repeat(64) } });
  check("photoHash without photo rejected", fakeHash.res.status === 400);
  const stranger = await post(`/api/leases/${lid}/events`, { type: "MOVE_IN", id: evId(), createdAt: new Date().toISOString(), signature: "0".repeat(128), data: {} }, s.token);
  check("stranger gets 403", stranger.status === 403);

  const selfConfirm = await post(`/api/leases/${lid}/events/${good.e.id}/confirm`, { signature: await sign(t, stable(payload(lid, good.e))) }, t.token);
  check("proposer cannot confirm own event", selfConfirm.status === 400);
  const badConfirm = await post(`/api/leases/${lid}/events/${good.e.id}/confirm`, { signature: await sign(l, "other message") }, l.token);
  check("confirm with signature over wrong message rejected", badConfirm.status === 400);
  const okConfirm = await post(`/api/leases/${lid}/events/${good.e.id}/confirm`, { signature: await sign(l, stable(payload(lid, good.e))) }, l.token);
  check("valid confirmation finalizes", okConfirm.status === 200 && okConfirm.body.status === "finalized");

  const nd = await mk(false);
  const nt = await post(`/api/leases/${nd}/chain/demo-tamper`, { blockIndex: 0 }, l.token);
  check("tamper refused on non-demo lease", nt.status === 403);

  const pend = await propose(t, lid);
  await post(`/api/leases/${lid}/end`, {}, l.token);
  const ended = await propose(t, lid);
  check("new event on ended lease rejected", ended.res.status === 409);
  const endedConfirm = await post(`/api/leases/${lid}/events/${pend.e.id}/confirm`, { signature: await sign(l, stable(payload(lid, pend.e))) }, l.token);
  check("confirm on ended lease rejected", endedConfirm.status === 409);

  const list = await get("/api/leases", l.token);
  check("lease list carries server-side rent status", list.body.every((x) => x.rent && x.rent.status));
  const detail = await get(`/api/leases/${lid}`, t.token);
  check("detail carries public keys and fingerprints", detail.body.publicKeys[t.name] === t.publicKey && /^[0-9A-F]{4}-/.test(detail.body.fingerprints[t.name]));
  console.log(fails ? "FAILURES " + fails : "ALL PASSED");
  process.exit(fails ? 1 : 0);
})();
