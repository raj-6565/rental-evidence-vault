const crypto = require("crypto");
const fs = require("fs");
const zlib = require("zlib");
const path = require("path");
const { stableStringify } = require("../src/utils/crypto");

const BASE = process.argv[2] || "http://localhost:3000";
const PASSWORD = "demo1234";
const OUT = path.join(__dirname, "..", "seed-keys");

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function samplePhoto(r, g, b) {
  const size = 96;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: size }, () => [r, g, b]).flat())]);
  const raw = Buffer.concat(Array.from({ length: size }, () => row));
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

async function call(method, url, token, body) {
  const headers = token ? { Authorization: "Bearer " + token } : {};
  if (body && !(body instanceof FormData)) headers["Content-Type"] = "application/json";
  const res = await fetch(BASE + url, { method, headers, body: body instanceof FormData ? body : body && JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${url}: ${json.error || res.status}`);
  return json;
}

async function makeUser(username, role) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const publicHex = publicKey.export({ type: "spki", format: "der" }).toString("hex");
  await call("POST", "/api/auth/register", null, { username, password: PASSWORD, role, publicKey: publicHex });
  const login = await call("POST", "/api/auth/login", null, { username, password: PASSWORD });
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(
    path.join(OUT, `rev-key-${username}.json`),
    JSON.stringify({ app: "rental-evidence-vault", username, publicKey: publicHex, jwk: privateKey.export({ format: "jwk" }) }, null, 2)
  );
  return { username, privateKey, token: login.token };
}

function sign(user, leaseId, event) {
  const payload = { v: 1, leaseId, eventId: event.id, type: event.type, data: event.data, proposedBy: event.proposedBy, createdAt: event.createdAt };
  return crypto.sign(null, Buffer.from(stableStringify(payload)), user.privateKey).toString("hex");
}

async function record(leaseId, proposer, confirmer, type, data, photo) {
  const event = {
    id: "evt-" + crypto.randomBytes(4).toString("hex"),
    type,
    data: { ...data },
    proposedBy: proposer.username,
    createdAt: new Date().toISOString(),
  };
  if (photo) event.data.photoHash = crypto.createHash("sha256").update(photo).digest("hex");
  const signature = sign(proposer, leaseId, event);
  let body = { type, id: event.id, createdAt: event.createdAt, signature, data: event.data };
  if (photo) {
    body = new FormData();
    body.append("type", type);
    body.append("id", event.id);
    body.append("createdAt", event.createdAt);
    body.append("signature", signature);
    body.append("data", JSON.stringify(event.data));
    body.append("photo", new Blob([photo], { type: "image/png" }), "photo.png");
  }
  const created = await call("POST", `/api/leases/${leaseId}/events`, proposer.token, body);
  event.photoId = created.photoId;
  await call("POST", `/api/leases/${leaseId}/events/${event.id}/confirm`, confirmer.token, { signature: sign(confirmer, leaseId, event) });
}

(async () => {
  const tenant = await makeUser("demo_tenant", "tenant");
  const landlord = await makeUser("demo_landlord", "landlord");
  const lease = await call("POST", "/api/leases", landlord.token, {
    address: "221B, Sector 14, Jaipur",
    tenantUsername: tenant.username,
    rentAmount: 18000,
    startDate: "2026-08-01",
    demo: true,
  });
  await record(lease.id, tenant, landlord, "MOVE_IN", { description: "Small crack near the bedroom window, walls otherwise clean" }, samplePhoto(200, 190, 170));
  await record(lease.id, landlord, tenant, "PAYMENT", { description: "Rent for this month", amount: 18000 });
  await record(lease.id, tenant, landlord, "MAINTENANCE", { description: "Kitchen tap is leaking" }, samplePhoto(90, 120, 160));
  console.log("Demo data ready.");
  console.log("Logins: demo_tenant / demo_landlord, password " + PASSWORD);
  console.log("Key files written to seed-keys/. Log in, then import the matching key file when the banner asks.");
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
