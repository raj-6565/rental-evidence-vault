# Rental Evidence Vault

Most rental disputes come down to one question: what did the flat look like, and who agreed to what? Rental Evidence Vault gives a tenant and a landlord one shared record to settle that. Every entry (move-in condition, a rent payment, a repair request, with an optional photo) has to be signed by both people before it counts. The signing keys are made in their own browsers and never reach the server, so nobody can change the history later without being caught, not even whoever runs the server.

Built for PBL-III at Manipal University Jaipur.

## How it works

1. You register. Your browser creates an Ed25519 key pair. The public key goes to the server and the private key stays in your browser.
2. You log an event, for example "scratch on the living room wall", and attach a photo if you like. Your browser signs it.
3. The other person opens the pending event. Their browser checks your signature and the photo, and only then do they sign the same event.
4. The server adds the event to the lease's chain as a block. Each block stores both signatures and the hash of the block before it.

If anyone edits an old block, its hash stops matching. If they recompute the hashes to hide it, the signatures stop matching, because only the two users can sign. Your browser re-checks all of this every time you open a lease, without trusting the server.

## Features

- Landlords create leases for tenant accounts. Each lease is visible only to its two people.
- Events: move-in or move-out condition, payment, maintenance. Photos are signed by hash, so a swapped photo is caught.
- Rent status (Paid, Due, Overdue) is calculated from confirmed payments.
- "Verify in my browser" checks every hash, signature and photo locally.
- Signed receipts. Download one now, check it later, and it tells you if history has changed.
- Key backup and import, plus fingerprints so the two people can confirm they hold the right keys.
- Export of all blocks and public keys as a dispute packet.
- Demo leases with a tamper simulator, so you can watch an attack get caught.

## Limits you should know about

- An administrator who deletes or reorders whole events and rebuilds the hashes leaves a chain that still looks valid, because each signature covers its own event, not its position. Deleting the newest block does the same. A saved receipt or the browser's remembered latest block catches all of these, so download a receipt now and then.
- Lose your key and that account can't sign anymore. Use "Back up key" and keep the file safe.
- The server hands out public keys, so the two people should compare the fingerprints once, on a call or in person.
- Sessions live in server memory, so a restart logs everyone out.
- This is a college project. It makes no claim that the records would be accepted as legal evidence.

## Run it on your computer

You need Node.js 18 or newer and a PostgreSQL database (a free Neon one works).

```
git clone <your repo url>
cd rental-evidence-vault
npm install
export DATABASE_URL="postgresql://user:password@host/dbname?sslmode=require"
npm start
```

Open http://localhost:3000. The tables are created on first use. Use a recent Chrome, Edge, Safari or Firefox; the browser must support Ed25519 in Web Crypto, and the page must be on HTTPS or localhost. `.env.example` shows the two settings the app reads, `DATABASE_URL` and `PORT`.

## Deploy on Render

1. Push the repo to GitHub.
2. In Render, create a new Web Service from the repo. Build command `npm install`, start command `npm start`.
3. Add the environment variable `DATABASE_URL` with your Neon connection string (just the URL, no `psql` and no quotes).
4. When the deploy finishes, open `/api/health`. You should see `{"status":"ok","database":"connected"}`.

## Demo data and tests

```
npm run seed -- https://your-app.onrender.com
npm run attacks
npm run compare
npm run test:api -- https://your-app.onrender.com
npm run demo
```

- `seed` creates `demo_tenant` and `demo_landlord` (password `demo1234`) with a demo lease and three signed events. Key files are written to `seed-keys/`; import the matching one after logging in.
- `attacks` tries ten kinds of tampering, 50 times each, on a 12-event chain and prints how many were caught, with timings. It needs no database.
- `compare` runs the same administrator attacks against a plain hash chain, a server-signed chain (the usual design) and this project, and prints how many each one catches.
- `test:api` runs 16 checks against a running server: bad signatures, duplicate events, outsiders, ended leases and more.
- `demo` is a short console walkthrough of the chain.

In my runs, the 10 in-place attacks in `attacks` were caught 450 of 500 times by the chain check alone, and 500 of 500 with a saved receipt. In `compare`, an administrator who has the server's signing key can edit or forge events in a plain or server-signed chain without being caught (0 of 100 caught by the chain check), while here edits and forged events are caught every time (100 of 100). Removing or reordering whole events is the one thing the chain check alone misses; a saved receipt catches it.

## API

Every route except register, login and health needs the header `Authorization: Bearer <token>`.

| Method and path | What it does |
|---|---|
| `POST /api/auth/register` | Create an account (username, password, role, publicKey) |
| `POST /api/auth/login` | Log in; returns a token and your public key |
| `GET /api/leases` | Your leases, with rent status |
| `POST /api/leases` | Landlord creates a lease |
| `GET /api/leases/:id` | Lease, chain, pending events, public keys |
| `POST /api/leases/:id/end` | End a lease |
| `POST /api/leases/:id/events` | Propose a signed event (JSON, or multipart with a photo) |
| `POST /api/leases/:id/events/:eventId/confirm` | Sign and finalize a pending event |
| `GET /api/leases/:id/chain/verify` | Verify the chain on the server |
| `GET /api/leases/:id/chain/export` | Download the dispute packet |
| `POST /api/leases/:id/chain/demo-tamper` | Simulate an attack (demo leases only) |
| `GET /api/leases/:id/photos/:photoId` | Get a photo (the two parties only) |
| `GET /api/leases/:id/photos/:photoId/verify` | Re-hash a stored photo against the chain |
| `GET /api/health` | Check the database connection |

## Project layout

```
src/server.js            app setup
src/db/store.js          PostgreSQL access and photo storage
src/chain/hashChain.js   block format and verification
src/utils/crypto.js      hashing, canonical JSON, Ed25519 checks
src/utils/access.js      who can see which lease
src/utils/rent.js        rent status
src/routes/              auth, leases, events, chain, photos
public/index.html        the whole front end
scripts/seed.js          demo data
tests/                   attack simulation and API checks
```

Made with Node.js, Express, PostgreSQL (Neon), multer and plain JavaScript, and hosted on Render.
