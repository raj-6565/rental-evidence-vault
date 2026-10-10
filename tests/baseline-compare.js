const crypto = require("crypto");
const { RentalEvidenceChain, eventPayload, GENESIS_HASH } = require("../src/chain/hashChain");
const { stableStringify, sha256 } = require("../src/utils/crypto");

const ATTEMPTS = 50;
const LENGTH = 12;

function newKey() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  return { privateKey, publicHex: publicKey.export({ type: "spki", format: "der" }).toString("hex") };
}
const sign = (key, message) => crypto.sign(null, Buffer.from(message), key.privateKey).toString("hex");
const verify = (hex, message, sig) =>
  crypto.verify(null, Buffer.from(message), crypto.createPublicKey({ key: Buffer.from(hex, "hex"), format: "der", type: "spki" }), Buffer.from(sig, "hex"));
const pick = (n) => Math.floor(Math.random() * n);
const record = (i) => ({ description: "event " + i, amount: 1000 + i });

const users = { a: newKey(), b: newKey() };
const serverKey = newKey();
const parties = ["a", "b"];
const publicKeys = { a: users.a.publicHex, b: users.b.publicHex };

function baseHash(block) {
  return sha256({ index: block.index, data: block.data, prevHash: block.prevHash });
}

function buildBase(signed) {
  const blocks = [];
  for (let i = 0; i < LENGTH; i++) {
    const block = { index: i, data: record(i), prevHash: i ? blocks[i - 1].hash : GENESIS_HASH };
    block.hash = baseHash(block);
    if (signed) block.serverSignature = sign(serverKey, block.hash);
    blocks.push(block);
  }
  return { blocks, signed };
}

function relinkBase(chain, from) {
  for (let i = from; i < chain.blocks.length; i++) {
    const b = chain.blocks[i];
    b.index = i;
    b.prevHash = i ? chain.blocks[i - 1].hash : GENESIS_HASH;
    b.hash = baseHash(b);
    if (chain.signed) b.serverSignature = sign(serverKey, b.hash);
  }
}

function verifyBase(chain) {
  let prev = GENESIS_HASH;
  for (const b of chain.blocks) {
    if (b.prevHash !== prev || baseHash(b) !== b.hash) return false;
    if (chain.signed && !verify(serverKey.publicHex, b.hash, b.serverSignature)) return false;
    prev = b.hash;
  }
  return true;
}

function buildOurs() {
  const chain = new RentalEvidenceChain("lease-test");
  for (let i = 0; i < LENGTH; i++) {
    const [p, c] = i % 2 ? ["b", "a"] : ["a", "b"];
    const event = { id: "evt-" + crypto.randomBytes(4).toString("hex"), type: "PAYMENT", data: record(i), proposedBy: p, createdAt: new Date().toISOString() };
    const message = stableStringify(eventPayload(chain.leaseId, event));
    event.proposerSignature = sign(users[p], message);
    chain.addSignedEvent({ event, confirmedBy: c, confirmerSignature: sign(users[c], message) });
  }
  return chain;
}

function relinkOurs(chain, from) {
  for (let i = from; i < chain.blocks.length; i++) {
    const b = chain.blocks[i];
    b.index = i;
    b.prevHash = i ? chain.blocks[i - 1].blockHash : GENESIS_HASH;
    b.blockHash = sha256({
      index: b.index, finalizedAt: b.finalizedAt, photoId: b.photoId, confirmedBy: b.confirmedBy,
      proposerSignature: b.proposerSignature, confirmerSignature: b.confirmerSignature, prevHash: b.prevHash, dataHash: b.dataHash,
    });
  }
}

const systems = {
  "Plain hash chain": {
    build: () => buildBase(false),
    check: verifyBase,
    headHash: (c) => (i) => (c.blocks[i] ? c.blocks[i].hash : null),
    attacks: {
      "Edit an event, hashes not fixed": (c) => { c.blocks[pick(LENGTH)].data = { description: "changed" }; },
      "Edit an event and rebuild the chain": (c) => { const i = pick(LENGTH); c.blocks[i].data = { description: "changed" }; relinkBase(c, i); },
      "Add a forged event": (c) => { c.blocks.push({ index: LENGTH, data: { description: "fake", amount: 1 }, prevHash: c.blocks[LENGTH - 1].hash }); relinkBase(c, LENGTH); },
      "Delete a middle event and rebuild": (c) => { const i = 1 + pick(LENGTH - 2); c.blocks.splice(i, 1); relinkBase(c, i); },
      "Reorder two events and rebuild": (c) => { const i = pick(LENGTH - 1); [c.blocks[i], c.blocks[i + 1]] = [c.blocks[i + 1], c.blocks[i]]; relinkBase(c, i); },
      "Delete the newest event": (c) => { c.blocks.pop(); },
    },
  },
  "Server-signed chain": {
    build: () => buildBase(true),
    check: verifyBase,
    headHash: (c) => (i) => (c.blocks[i] ? c.blocks[i].hash : null),
    attacks: null,
  },
  "Rental Evidence Vault": {
    build: buildOurs,
    check: (c) => c.verifyChain({ parties, publicKeys }).valid,
    headHash: (c) => (i) => (c.blocks[i] ? c.blocks[i].blockHash : null),
    attacks: {
      "Edit an event, hashes not fixed": (c) => c.tamperForDemo(pick(LENGTH), { description: "changed" }, false),
      "Edit an event and rebuild the chain": (c) => c.tamperForDemo(pick(LENGTH), { description: "changed" }, true),
      "Add a forged event": (c) => {
        const outsider = newKey();
        const event = { id: "evt-deadbeef", type: "PAYMENT", data: { description: "fake", amount: 1 }, proposedBy: "a", createdAt: new Date().toISOString() };
        const message = stableStringify(eventPayload(c.leaseId, event));
        event.proposerSignature = sign(outsider, message);
        c.addSignedEvent({ event, confirmedBy: "b", confirmerSignature: sign(outsider, message) });
      },
      "Delete a middle event and rebuild": (c) => { const i = 1 + pick(LENGTH - 2); c.blocks.splice(i, 1); relinkOurs(c, i); },
      "Reorder two events and rebuild": (c) => { const i = pick(LENGTH - 1); [c.blocks[i], c.blocks[i + 1]] = [c.blocks[i + 1], c.blocks[i]]; relinkOurs(c, i); },
      "Delete the newest event": (c) => { c.blocks.pop(); },
    },
  },
};
systems["Server-signed chain"].attacks = systems["Plain hash chain"].attacks;

console.log(`A dishonest administrator has full database access and the server's signing key, but no user private keys.`);
console.log(`Each attack: ${ATTEMPTS} tries on a chain of ${LENGTH} events. Chains are rebuilt where possible.\n`);

const summary = {};
for (const [name, sys] of Object.entries(systems)) {
  summary[name] = { chain: 0, head: 0, total: 0 };
  console.log(name);
  console.log("  " + "Attack".padEnd(40) + "Chain check".padEnd(14) + "With saved head");
  for (const [attackName, attack] of Object.entries(sys.attacks)) {
    let byChain = 0;
    let withHead = 0;
    for (let t = 0; t < ATTEMPTS; t++) {
      const chain = sys.build();
      const last = LENGTH - 1;
      const before = sys.headHash(chain)(last);
      attack(chain);
      const caught = !sys.check(chain);
      const headMoved = sys.headHash(chain)(last) !== before;
      if (caught) byChain++;
      if (caught || headMoved) withHead++;
    }
    summary[name].chain += byChain;
    summary[name].head += withHead;
    summary[name].total += ATTEMPTS;
    console.log("  " + attackName.padEnd(40) + `${byChain}/${ATTEMPTS}`.padEnd(14) + `${withHead}/${ATTEMPTS}`);
  }
  console.log("");
}

console.log("Totals".padEnd(26) + "Chain check".padEnd(14) + "With saved head");
for (const [name, s] of Object.entries(summary)) {
  console.log(name.padEnd(26) + `${s.chain}/${s.total}`.padEnd(14) + `${s.head}/${s.total}`);
}
