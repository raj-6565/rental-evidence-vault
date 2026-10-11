# Rental Evidence Vault

Most rental disputes come down to one question: what did the flat look like, and who agreed to what? Rental Evidence Vault gives a tenant and a landlord one shared record to settle that. Every entry (move-in condition, a rent payment, a repair request, with an optional photo) has to be signed by both people before it counts. The signing keys are made in their own browsers and never reach the server, so nobody can change the history later without being caught, not even whoever runs the server.

Built for PBL-III at Manipal University Jaipur.

## How it works

1. You register. Your browser creates an Ed25519 key pair. The public key goes to the server and the private key stays in your browser.
2. You log an event, for example "scratch on the living room wall", and attach a photo if you like. Your browser signs it.
3. The other person opens the pending event. Their browser checks your signature and the photo, and only then do they sign the same event.
4. The server adds the event to the lease's chain as a block. The second person signs the event together with the hash of the block before it, so the signature also fixes the event's place in the record. Each block stores both signatures and the hash of the block before it.

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

- An administrator who deletes the newest events leaves a shorter chain that still looks valid, because nothing after it points back. A saved receipt or the browser's remembered latest block catches this, so download a receipt now and then.
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

## Demo data

You do not need to run anything to get demo data. When the server starts it creates two sample accounts, `demo_tenant` and `demo_landlord`, and a sample lease with signed entries and one entry waiting for the tenant to confirm. On the login page, "Explore as tenant" and "Explore as landlord" open that lease directly, with the signing key already in place, so you can confirm an entry, verify the record or try the tamper simulator.

The sample accounts and their keys are fixed and public, because they are for exploring only. Do not use them for real records. Set `DEMO_DATA=off` to stop the server from creating them. The code is in `src/demo/demo.js`.

## Checks used for the report

These scripts are for developers and are not needed to use the app. Their results are in the report and the presentation.

```
npm run attacks
npm run compare
npm run test:api -- https://your-app.onrender.com
```

- `attacks` tries ten kinds of tampering, 50 times each, on a 12-event chain. It needs no database.
- `compare` runs the same administrator attacks against a plain hash chain, a server-signed chain and this project.
- `test:api` runs 16 checks against a running server: bad signatures, duplicate events, outsiders, ended leases and more.

The `attacks` script covers tampering in place: nine of the ten attacks are exposed by the chain check alone, and the tenth, deleting the newest block, needs a saved receipt. The `compare` script shows how this differs from a plain or server-signed chain when the administrator holds the server's key. There, edits and forged events are exposed by the chain itself, while the other designs need the user to have kept a copy of the latest block, and cannot expose a forged addition at all. Because the second signer also signs the hash of the previous block, removing or reordering events in the middle breaks a signature in this project. Removing the newest events is caught only with a saved receipt in all three designs. These are simulated attacks under a stated threat model, not a claim of real-world security.

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
public/index.html        the page and all front-end logic
public/styles.css        design tokens and styles
src/demo/                sample rental created at start-up
tests/                   attack simulation and API checks
```

## Why not a blockchain?

A blockchain helps many strangers agree on one order of records. A tenancy has two known people, and every record already needs both of their signatures, so that agreement is built in. Leaving out the chain means no wallet, no transaction fees, no waiting for confirmations, data that stays in a private database, and an app that looks like any other rental app. The trade-off is that the record depends on one server for availability and has no built-in public timestamp. Receipts and the export cover the first, and anchoring the chain head with OpenTimestamps could add the second later.

Made with Node.js, Express, PostgreSQL (Neon), multer and plain JavaScript, and hosted on Render.
