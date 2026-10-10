const crypto = require("crypto");
const { RentalEvidenceChain, eventPayload } = require("../src/chain/hashChain");
const { stableStringify } = require("../src/utils/crypto");

const ATTEMPTS = 50;
const CHAIN_LENGTH = 12;

function newKey() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  return { privateKey, publicHex: publicKey.export({ type: "spki", format: "der" }).toString("hex") };
}

const keys = { a: newKey(), b: newKey(), outsider: newKey() };
const publicKeys = { a: keys.a.publicHex, b: keys.b.publicHex };
const parties = ["a", "b"];

function sign(key, message) {
  return crypto.sign(null, Buffer.from(message), key.privateKey).toString("hex");
}

function buildChain(length) {
  const chain = new RentalEvidenceChain("lease-test");
  for (let i = 0; i < length; i++) {
    const [proposer, confirmer] = i % 2 ? ["b", "a"] : ["a", "b"];
    const event = {
      id: "evt-" + crypto.randomBytes(4).toString("hex"),
      type: i % 3 ? "PAYMENT" : "MOVE_IN",
      data: { description: "event " + i, amount: 1000 + i, photoHash: crypto.randomBytes(32).toString("hex") },
      photoId: "ph-" + i,
      proposedBy: proposer,
      createdAt: new Date().toISOString(),
    };
    const message = stableStringify(eventPayload(chain.leaseId, event));
    event.proposerSignature = sign(keys[proposer], message);
    chain.addSignedEvent({ event, confirmedBy: confirmer, confirmerSignature: sign(keys[confirmer], message) });
  }
  return chain;
}

const pick = (n) => Math.floor(Math.random() * n);

const attacks = {
  "Edit the data of one event": (c) => c.tamperForDemo(pick(c.blocks.length), { description: "changed" }, false),
  "Edit one event and recompute every hash": (c) => c.tamperForDemo(pick(c.blocks.length), { description: "changed", amount: 1 }, true),
  "Swap two neighbouring events": (c) => {
    const i = pick(c.blocks.length - 1);
    [c.blocks[i], c.blocks[i + 1]] = [c.blocks[i + 1], c.blocks[i]];
  },
  "Delete an event from the middle": (c) => c.blocks.splice(1 + pick(c.blocks.length - 2), 1),
  "Change a timestamp": (c) => { c.blocks[pick(c.blocks.length)].finalizedAt = "2020-01-01T00:00:00.000Z"; },
  "Replace a signature with the other party's": (c) => {
    const b = c.blocks[pick(c.blocks.length)];
    b.proposerSignature = b.confirmerSignature;
  },
  "Change who signed": (c) => {
    const b = c.blocks[pick(c.blocks.length)];
    b.proposedBy = b.confirmedBy;
  },
  "Point an event at a different photo": (c) => { c.blocks[pick(c.blocks.length)].photoId = "ph-other"; },
  "Append a forged event signed by an outsider": (c) => {
    const event = { id: "evt-deadbeef", type: "PAYMENT", data: { description: "fake", amount: 1 }, proposedBy: "a", createdAt: new Date().toISOString() };
    const message = stableStringify(eventPayload(c.leaseId, event));
    event.proposerSignature = sign(keys.outsider, message);
    c.addSignedEvent({ event, confirmedBy: "b", confirmerSignature: sign(keys.outsider, message) });
  },
  "Delete the newest event": (c) => c.blocks.pop(),
};

const rows = [];
for (const [name, attack] of Object.entries(attacks)) {
  let byChain = 0;
  let withHead = 0;
  for (let i = 0; i < ATTEMPTS; i++) {
    const chain = buildChain(CHAIN_LENGTH);
    const lastIndex = chain.blocks.length - 1;
    const lastHash = chain.blocks[lastIndex].blockHash;
    attack(chain);
    const result = chain.verifyChain({ parties, publicKeys });
    const headStillThere = chain.blocks[lastIndex] && chain.blocks[lastIndex].blockHash === lastHash;
    if (!result.valid) byChain++;
    if (!result.valid || !headStillThere) withHead++;
  }
  rows.push({ name, byChain, withHead });
}

console.log(`Each attack was tried ${ATTEMPTS} times on a chain of ${CHAIN_LENGTH} events.\n`);
console.log("Attack".padEnd(48) + "Chain check".padEnd(14) + "With saved head");
for (const r of rows) {
  console.log(r.name.padEnd(48) + `${r.byChain}/${ATTEMPTS}`.padEnd(14) + `${r.withHead}/${ATTEMPTS}`);
}

console.log("\nVerification time on the server");
for (const n of [10, 100, 500]) {
  const chain = buildChain(n);
  const times = [];
  for (let i = 0; i < 5; i++) {
    const start = process.hrtime.bigint();
    chain.verifyChain({ parties, publicKeys });
    times.push(Number(process.hrtime.bigint() - start) / 1e6);
  }
  times.sort((x, y) => x - y);
  console.log(`${String(n).padStart(4)} events: ${times[2].toFixed(1)} ms (median of 5)`);
}

const missed = rows.filter((r) => r.withHead !== ATTEMPTS);
process.exit(missed.length ? 1 : 0);
