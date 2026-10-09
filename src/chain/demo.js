const crypto = require("crypto");
const { RentalEvidenceChain, eventPayload } = require("./hashChain");
const { stableStringify } = require("../utils/crypto");

function newKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  return { privateKey, publicKeyHex: publicKey.export({ type: "spki", format: "der" }).toString("hex") };
}

function sign(privateKey, message) {
  return crypto.sign(null, Buffer.from(message), privateKey).toString("hex");
}

const tenant = newKeyPair();
const landlord = newKeyPair();
const keys = { priya: tenant.publicKeyHex, ravi: landlord.publicKeyHex };
const parties = ["priya", "ravi"];
const chain = new RentalEvidenceChain("lease-demo");

function record(type, data, proposer, proposerKey, confirmer, confirmerKey) {
  const event = {
    id: "evt-" + crypto.randomBytes(4).toString("hex"),
    type,
    data,
    proposedBy: proposer,
    createdAt: new Date().toISOString(),
  };
  const message = stableStringify(eventPayload(chain.leaseId, event));
  event.proposerSignature = sign(proposerKey, message);
  chain.addSignedEvent({ event, confirmedBy: confirmer, confirmerSignature: sign(confirmerKey, message) });
}

record("MOVE_IN", { description: "Small crack near window, otherwise clean" }, "priya", tenant.privateKey, "ravi", landlord.privateKey);
record("PAYMENT", { description: "October rent", amount: 18000 }, "priya", tenant.privateKey, "ravi", landlord.privateKey);

console.log("Fresh chain:", chain.verifyChain({ parties, publicKeys: keys }));

chain.blocks[0].data = { description: "No damage at all" };
console.log("After editing block 0:", chain.verifyChain({ parties, publicKeys: keys }));

chain.tamperForDemo(0, { description: "No damage at all" }, true);
console.log("After editing and recomputing every hash:", chain.verifyChain({ parties, publicKeys: keys }));
