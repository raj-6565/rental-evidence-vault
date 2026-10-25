const { Pool } = require("pg");

const url = process.env.DATABASE_URL;
const isLocal = !url || url.includes("localhost") || url.includes("127.0.0.1");

const pool = new Pool({
  connectionString: url,
  ssl: isLocal ? false : { rejectUnauthorized: false },
  max: 5,
  idleTimeoutMillis: 20000,
  connectionTimeoutMillis: 10000,
});

pool.on("error", (err) => {
  console.error("database connection dropped, a new one will be opened:", err.message);
});

let initPromise = null;

function init() {
  if (!url) return Promise.reject(new Error("DATABASE_URL is not set"));
  if (!initPromise) {
    initPromise = pool
      .query(`
        CREATE TABLE IF NOT EXISTS collections (
          collection TEXT NOT NULL,
          key TEXT NOT NULL,
          data JSONB NOT NULL,
          PRIMARY KEY (collection, key)
        );
        CREATE TABLE IF NOT EXISTS photos (
          id TEXT PRIMARY KEY,
          lease_id TEXT NOT NULL,
          mime TEXT NOT NULL,
          hash TEXT NOT NULL,
          uploaded_by TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          bytes BYTEA NOT NULL
        )
      `)
      .catch((err) => {
        initPromise = null;
        throw err;
      });
  }
  return initPromise;
}

function isTransient(err) {
  const msg = String(err && err.message);
  return (
    err.code === "ECONNRESET" ||
    err.code === "57P01" ||
    msg.includes("Connection terminated") ||
    msg.includes("terminating connection")
  );
}

async function withRetry(fn) {
  try {
    return await fn();
  } catch (err) {
    if (!isTransient(err)) throw err;
    return await fn();
  }
}

async function readCollection(collection, fallback = {}) {
  return withRetry(async () => {
    await init();
    const res = await pool.query("SELECT key, data FROM collections WHERE collection = $1", [collection]);
    if (res.rows.length === 0) return fallback;
    const out = {};
    for (const row of res.rows) out[row.key] = row.data;
    return out;
  });
}

async function writeCollection(collection, dataObj) {
  return withRetry(async () => {
    await init();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM collections WHERE collection = $1", [collection]);
      for (const key of Object.keys(dataObj)) {
        await client.query(
          "INSERT INTO collections (collection, key, data) VALUES ($1, $2, $3)",
          [collection, key, JSON.stringify(dataObj[key])]
        );
      }
      await client.query("COMMIT");
    } catch (err) {
      try { await client.query("ROLLBACK"); } catch (e) {}
      throw err;
    } finally {
      client.release();
    }
  });
}

async function savePhoto({ id, leaseId, mime, hash, uploadedBy, bytes }) {
  return withRetry(async () => {
    await init();
    await pool.query(
      "INSERT INTO photos (id, lease_id, mime, hash, uploaded_by, bytes) VALUES ($1, $2, $3, $4, $5, $6)",
      [id, leaseId, mime, hash, uploadedBy, bytes]
    );
  });
}

async function getPhoto(id) {
  return withRetry(async () => {
    await init();
    const res = await pool.query(
      "SELECT id, lease_id, mime, hash, uploaded_by, bytes FROM photos WHERE id = $1",
      [id]
    );
    return res.rows[0] || null;
  });
}

async function ping() {
  await init();
  await pool.query("SELECT 1");
}

module.exports = { readCollection, writeCollection, savePhoto, getPhoto, ping };
