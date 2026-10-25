# Rental Evidence Vault

Most rental disputes come down to one question: what did the flat look like, and who agreed to what? Rental Evidence Vault gives a tenant and a landlord one shared record to settle that. Every entry (identity checks, the signed agreement, the deposit, move-in condition, a rent payment, a repair, with an optional photo or document) has to be signed by both people before it counts. The signing keys are made in their own browsers and never reach the server, so nobody can change the history later without being caught, not even whoever runs the server.

In technical terms it is a dual-signature hash chain for tenancy records that can be verified without trusting the server: every block carries both parties' Ed25519 signatures, and the second signature covers the previous block's hash.

Built for PBL-III at Manipal University Jaipur.

## How it works

1. You register. Your browser creates an Ed25519 key pair. The public key goes to the server and the private key stays in your browser.
2. You log an event, for example "scratch on the living room wall", and attach a photo if you like. Your browser signs it.
3. The other person opens the pending event. Their browser checks your signature and the photo, and only then do they sign the same event.
4. The server adds the event to the lease's chain as a block. The second person signs the event together with the hash of the block before it, so the signature also fixes the event's place in the record. Each block stores both signatures and the hash of the block before it.

If anyone edits an old block, its hash stops matching. If they recompute the hashes to hide it, the signatures stop matching, because only the two users can sign. Your browser re-checks all of this every time you open a lease, without trusting the server.

## Features

- Landlords create leases for tenant accounts. Each lease is visible only to its two people.
- Events: verification, agreement, deposit, move-in or move-out condition, payment, maintenance. Photos and documents are signed by hash, so a swapped file is caught.
- Before move-in: a lease can require the agreement first. The tenancy runs in phases (agreement, move-in, tenancy, move-out), worked out from the signed record itself. The agreement entry carries the agreement document (PDF or photo) and the monthly rent, and both people sign its fingerprint. Until it is signed, only verification entries are accepted. It records who agreed to which document; it does not claim legal validity.
- Society maintenance requests: a landlord names a society office (its own account type) and sends signed requests such as "kitchen tap leaking". The society office acknowledges, declines or marks the work completed, each step signed with its own key. The landlord accepts and closes, or reopens or cancels. Each request keeps its own signed trail, and closing it also proposes a linked entry on the lease's ledger for the tenant to sign. The society office sees the property and the request, never the lease record or the tenant.
- Rent status (Paid, Due, Overdue) is calculated from confirmed payments.
- "Verify in my browser" checks every hash, signature and photo locally.
- Signed receipts. Download one now, check it later, and it tells you if history has changed.
- Key backup and import, plus fingerprints so the two people can confirm they hold the right keys.
- Export of all blocks and public keys as a dispute packet.
- Demo leases with a tamper simulator, so you can watch an attack get caught.
- An attack lab at `/lab.html` that runs the same administrator attacks on a plain chain, a server-signed chain and this design, side by side in the browser.

## Limits you should know about

- An administrator who deletes the newest events leaves a shorter chain that still looks valid, because nothing after it points back. A saved receipt or the browser's remembered latest block catches this, so download a receipt now and then.
- Lose your key and that account can't sign anymore. Use "Back up key" and keep the file safe.
- The server hands out public keys, so the two people should compare the fingerprints once, on a call or in person.
- Sessions live in server memory, so a restart logs everyone out.
- A society office signs only its own statements. A signed "completed" step proves the society said the work was done, not that it was done well. Requests carry text only, no attachments, and there is no email or SMS notification.
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

You do not need to run anything to get demo data. When the server starts it creates three sample accounts, `demo_tenant`, `demo_landlord` and `demo_society`, and a sample lease with a verification entry, a signed agreement with a PDF, the deposit, move-in, rent and a repair, two society requests (one finished and closed, one still open) and one entry waiting for the tenant to confirm. On the login page, "Explore as tenant", "Explore as landlord" and "Explore as society office" open that data directly, with the signing key already in place, so you can confirm an entry, verify the record or try the tamper simulator.

The sample accounts and their keys are fixed and public, because they are for exploring only. Do not use them for real records. Set `DEMO_DATA=off` to stop the server from creating them. The code is in `src/demo/demo.js`.

## How it was checked

The tampering experiments and the comparison with a plain and a server-signed chain are described, with their results, in the project report and presentation. They are simulated attacks under a stated threat model, not a claim of real-world security. Because the second signer also signs the hash of the previous block, removing or reordering events in the middle breaks a signature. Removing the newest events leaves a valid shorter chain, so that is caught only with a saved receipt.

## API

Every route except register, login and health needs the header `Authorization: Bearer <token>`.

| Method and path | What it does |
|---|---|
| `POST /api/auth/register` | Create an account (username, password, role, publicKey) |
| `POST /api/auth/login` | Log in; returns a token and your public key |
| `GET /api/leases` | Your leases, with rent status |
| `POST /api/leases` | Landlord creates a lease (optionally `requireAgreement` and `societyUsername`) |
| `POST /api/leases/:id/society` | Landlord sets or clears the society office |
| `GET /api/requests` | Society office: requests addressed to it. Others: `?leaseId=` for one lease |
| `POST /api/requests` | Landlord sends a signed maintenance request |
| `POST /api/requests/:id/steps` | Add a signed step (acknowledge, decline, complete, reopen, cancel, close) |
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
src/utils/phase.js       lease phase, derived from the chain
src/utils/requestTrail.js  signed step trail for society requests
src/routes/              auth, leases, events, chain, photos, requests
public/index.html        the page and all front-end logic
public/lab.html          the attack lab (standalone page)
public/styles.css        design tokens and styles
src/demo/                sample rental created at start-up
```

## Why not a blockchain?

A blockchain helps many strangers agree on one order of records. A tenancy has two known people, and every record already needs both of their signatures, so that agreement is built in. Leaving out the chain means no wallet, no transaction fees, no waiting for confirmations, data that stays in a private database, and an app that looks like any other rental app. The trade-off is that the record depends on one server for availability and has no built-in public timestamp. Receipts and the export cover the first, and anchoring the chain head with OpenTimestamps could add the second later.

Made with Node.js, Express, PostgreSQL (Neon), multer and plain JavaScript, and hosted on Render.
