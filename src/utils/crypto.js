const crypto = require("crypto");

const SPKI_PREFIX = "302a300506032b6570032100";

function stableStringify(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const keys = Object.keys(value).sort();
  const entries = keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`);
  return `{${entries.join(",")}}`;
}

function sha256(value) {
  return crypto.createHash("sha256").update(stableStringify(value)).digest("hex");
}

function hashFile(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function isValidPublicKey(publicKeyHex) {
  if (typeof publicKeyHex !== "string" || !/^[0-9a-f]{88}$/.test(publicKeyHex)) return false;
  if (!publicKeyHex.startsWith(SPKI_PREFIX)) return false;
  try {
    const key = crypto.createPublicKey({ key: Buffer.from(publicKeyHex, "hex"), format: "der", type: "spki" });
    return key.asymmetricKeyType === "ed25519";
  } catch {
    return false;
  }
}

function verifySignature(publicKeyHex, message, signatureHex) {
  if (!isValidPublicKey(publicKeyHex)) return false;
  if (typeof signatureHex !== "string" || !/^[0-9a-f]{128}$/.test(signatureHex)) return false;
  const key = crypto.createPublicKey({ key: Buffer.from(publicKeyHex, "hex"), format: "der", type: "spki" });
  return crypto.verify(null, Buffer.from(message), key, Buffer.from(signatureHex, "hex"));
}

function fingerprint(publicKeyHex) {
  const digest = crypto.createHash("sha256").update(Buffer.from(publicKeyHex, "hex")).digest("hex");
  return digest.slice(0, 16).toUpperCase().match(/.{4}/g).join("-");
}

module.exports = { sha256, hashFile, stableStringify, isValidPublicKey, verifySignature, fingerprint };
