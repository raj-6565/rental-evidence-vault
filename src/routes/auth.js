const express = require("express");
const crypto = require("crypto");
const { readCollection, writeCollection } = require("../db/store");
const { isValidPublicKey, fingerprint } = require("../utils/crypto");
const { asyncHandler } = require("../utils/asyncHandler");

const router = express.Router();
const sessions = new Map();

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString("hex");
}

router.post("/register", asyncHandler(async (req, res) => {
  const { username, password, role, publicKey } = req.body;
  if (!username || !password || !role) {
    return res.status(400).json({ error: "username, password, and role are required" });
  }
  if (!isValidPublicKey(publicKey)) {
    return res.status(400).json({ error: "a valid Ed25519 public key is required" });
  }
  if (!["tenant", "landlord", "society"].includes(role)) {
    return res.status(400).json({ error: "role must be 'tenant', 'landlord' or 'society'" });
  }

  const users = await readCollection("users");
  if (users[username]) {
    return res.status(409).json({ error: "username already taken" });
  }

  const salt = crypto.randomBytes(16).toString("hex");
  const passwordHash = hashPassword(password, salt);

  users[username] = {
    username,
    role,
    salt,
    passwordHash,
    publicKey,
    createdAt: new Date().toISOString(),
  };
  await writeCollection("users", users);

  res.status(201).json({ username, role });
}));

router.post("/login", asyncHandler(async (req, res) => {
  const { username, password } = req.body;
  const users = await readCollection("users");
  const user = users[username];
  if (!user) return res.status(401).json({ error: "invalid username or password" });

  const hash = hashPassword(password, user.salt);
  if (hash !== user.passwordHash) {
    return res.status(401).json({ error: "invalid username or password" });
  }
  if (!user.publicKey) {
    return res.status(409).json({ error: "this account was made before signing keys existed, please register a new account" });
  }

  const token = crypto.randomBytes(24).toString("hex");
  sessions.set(token, username);

  res.json({ token, username, role: user.role, publicKey: user.publicKey, fingerprint: fingerprint(user.publicKey) });
}));

const requireAuth = asyncHandler(async (req, res, next) => {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  const username = token && sessions.get(token);
  if (!username) return res.status(401).json({ error: "not authenticated" });

  const users = await readCollection("users");
  req.user = users[username];
  next();
});

module.exports = { router, requireAuth };
