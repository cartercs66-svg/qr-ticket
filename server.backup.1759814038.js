require('dotenv').config();
const express = require('express');
const Stripe = require('stripe');
const QRCode = require('qrcode');

const app = express();
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// ───────────────────────────── DB (Postgres) ─────────────────────────────
const { Client } = (() => { try { return require('pg'); } catch { return {}; } })();
const hasDb = !!(process.env.DATABASE_URL && Client);
let db = null;

let memCreated = new Set(); // fallback if no DB
let memUsed = new Set();

async function dbInit() {
  if (!hasDb) return;
  db = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });
  await db.connect();
  await db.query(`
    CREATE TABLE IF NOT EXISTS tickets (
      ticket_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      redeemed_at TIMESTAMPTZ,
      redeemed_by TEXT
    );
  `);
}

async function ensureTicket(sessionId) {
  const ticketId = sessionId; // one ticket per successful checkout session
  if (hasDb) {
    await db.query(
      `INSERT INTO tickets (ticket_id, session_id)
       VALUES ($1, $2)
       ON CONFLICT (ticket_id) DO NOTHING;`,
      [ticketId, sessionId]
    );
  } else {
    memCreated.add(ticketId);
  }
  return ticketId;
}

async function redeemTicket(ticketId, who = 'door') {
  if (hasDb) {
    const res = await db.query(
      `UPDATE tickets
         SET redeemed_at = NOW(), redeemed_by = $2
       WHERE ticket_id = $1 AND redeemed_at IS NULL
       RETURNING ticket_id, session_id, redeemed_at, redeemed_by;`,
      [ticketId, who]
    );
    if (res.rows.length) return { ok: true };
    const exists = await db.query(`SELECT 1 FROM tickets WHERE ticket_id=$1`, [ticketId]);
    if (!exists.rows.length) return { ok: false, reason: 'NOT_FOUND' };
    return { ok: false, reason: 'ALREADY_USED' };
  } else {
    if (!memCreated.has(ticketId)) return { ok: false, reason: 'NOT_FOUND' };
    if (memUsed.has(ticketId)) return { ok: false, reason: 'ALREADY_USED' };
    memUsed.add(ticketId);
    return { ok: true };
  }
}

// ───────────────────────────── App setup ─────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Simple home page (optional, just a link to your Stripe Payment Link)
app.get('/', (_req, res) => {
  const price = '$' + (0).toFixed(2);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(`<!doctype html><html><head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Tickets</title>
<style>body{margin:0;display:grid;place-items:center;min-height:100vh;background:#0b0b10;color:#fff;font-family:ui-sans-serif,-apple-system,Segoe UI,Roboto}
.card{background:#161621;border:1px solid #2a2a3a;border-radius:16px;padding:24px;box-shadow:0 12px 32px rgba(0,0,0,.35);width:min(560px,92vw)}
button{font-weight:700;border:0;background:#6b8cff;color:#fff;padding:12px 16px;border-radius:12px;box-shadow:0 8px 20px rgba(107,140,255,.35);cursor:pointer}
p{color:#c8c8d6}</style></head><body>
  <div class="card">
    <h1>${process.env.EVENT_NAME}</h1>
    <p>${process.env.EVENT_DATETIME} · ${process.env.EVENT_LOCATION}</p>
    <p>Address revealed after purchase.</p>
    <button id="pay">Buy Ticket</button>
  </div>
  <script>
    document.getElementById('pay').onclick = () => {
      // Replace this with YOUR Payment Link (book.stripe.com/...)
      window.location.href = 'https://book.stripe.com/7sY5kE5LT76o6s6cXyd7q00';
    };
  </script>
</body></html>`);
});

// Ticket page: Stripe redirects here with ?session_id={CHECKOUT_SESSION_ID}
app.get('/ticket', async (req, res) => {
  const sessionId = req.query.session_id;
  if (!sessionId) return res.status(400).send('Missing session_id');

  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    if (session.payment_status !== 'paid') {
      return res.status(402).send('Payment not completed');
    }

    const ticketId = await ensureTicket(session.id);
    const qrPayload = `${process.env.BASE_URL}/checkin?code=${encodeURIComponent(ticketId)}`;
    const qrDataUrl = await QRCode.toDataURL(qrPayload, { margin: 0 });

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(`<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${process.env.EVENT_NAME} Ticket</title>
<style>
  :root { --bg:#0b0b10; --card:#15151c; --ink:#fff; --muted:#a6a6b3; --accent:#6b8cff; --line:#252533; }
  body{margin:0;background:var(--bg);color:var(--ink);font-family:ui-sans-serif,-apple-system,Segoe UI,Roboto,Helvetica,Arial}
  .wrap{min-height:100svh;display:grid;place-items:center;padding:24px}
  .ticket{width:min(440px,92vw);background:linear-gradient(180deg,#161621,#13131b);border:1px solid var(--line);border-radius:24px;box-shadow:0 12px 40px rgba(0,0,0,.45);padding:18px 18px 24px;position:relative;overflow:hidden}
  .ticket::before{content:"";position:absolute;inset:0;background:radial-gradient(1200px 400px at 50% -5%,rgba(107,140,255,.15),transparent 60%)}
  .row{display:flex;align-items:center;justify-content:space-between;gap:12px}
  .meta{font-size:12px;color:var(--muted);letter-spacing:.02em}.meta b{color:var(--ink);font-weight:600}
  .title{margin:12px 0 8px;font-weight:800;letter-spacing:.04em;text-align:center}
  .title .main{font-size:22px}.title .sub{font-size:12px;color:var(--muted)}
  .qrbox{margin:16px auto 12px;width:min(280px,70vw);aspect-ratio:1/1;background:#fff;border-radius:18px;padding:14px;display:grid;place-items:center;box-shadow:inset 0 0 0 1px #e5e5e5,0 10px 24px rgba(0,0,0,.35)}
  .qrbox img{width:100%;height:100%;object-fit:contain;image-rendering:pixelated}
  .code{text-align:center;font-size:12px;color:var(--muted);margin-top:6px}
  .footer{display:flex;justify-content:space-between;align-items:center;margin-top:12px;font-size:12px;color:var(--muted)}
  .badge{padding:4px 10px;border:1px solid var(--line);border-radius:999px;background:#0f0f16;color:#cfd8ff;font-weight:600}
  .btns{display:flex;gap:10px;margin-top:16px;justify-content:center}
  .btn{text-decoration:none;color:#fff;background:var(--accent);padding:10px 14px;border-radius:12px;font-weight:700;box-shadow:0 6px 20px rgba(107,140,255,.35)}
  @media print { body{background:#fff}.wrap{padding:0}.ticket{width:100%!important;border:none;border-radius:0;box-shadow:none;background:#fff}.ticket::before{display:none}.btns,.footer span:last-child{display:none!important} }
</style></head>
<body>
  <div class="wrap">
    <article class="ticket" role="main" aria-label="Event ticket">
      <div class="row">
        <div class="meta">DATE & TIME<br><b>${process.env.EVENT_DATETIME}</b></div>
        <div class="meta" style="text-align:right">LOCATION<br><b>${process.env.EVENT_LOCATION}</b></div>
      </div>
      <h1 class="title">
        <div class="main">${process.env.EVENT_NAME}</div>
        <div class="sub">${process.env.EVENT_ADDRESS}</div>
      </h1>
      <div class="qrbox" aria-label="QR code"><img alt="QR" src="${qrDataUrl}"></div>
      <div class="code">Ticket ID: ${ticketId}</div>
      <div class="footer">
        <span class="badge">Admit One</span>
        <span>Save a screenshot or keep this page open</span>
      </div>
      <div class="btns">
  <button id="printBtn" class="btn" type="button">Save / Print</button>
  <a id="downloadQr" class="btn" download="ticket-qr.png" href="">Download QR</a>
</div>
<script>
  document.getElementById("printBtn")?.addEventListener("click", function(){ try{ window.print(); } catch(e) { alert("Use your browser’s Print/Share option."); } });
</script>
    </article>
  </div>
  <script>
    document.getElementById('printBtn')?.addEventListener('click', () => {
      try { window.print(); } catch(e) { alert('Use your browser’s Print/Share option.'); }
    });
  </script>
</body></html>`);
  } catch (e) {
    console.error(e);
    res.status(500).send('Something went wrong');
  }
});

// One-time door check-in (atomic)
app.get('/checkin', async (req, res) => {
  const code = req.query.code;
  if (!code) return res.status(400).send('Missing code');
  try {
    const result = await redeemTicket(code, 'door');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (result.ok) {
      return res.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"/><title>Admit</title>
<style>body{margin:0;display:grid;place-items:center;min-height:100svh;font-family:system-ui,-apple-system,Segoe UI,Roboto}.box{padding:28px;border-radius:16px;border:1px solid #d1f2da;background:#eafaf0}h1{color:#0a7f45;margin:0 0 8px}p{margin:0}</style>
</head><body><div class="box"><h1>✅ OK — ADMIT</h1><p>Ticket ${code} redeemed.</p></div></body></html>`);
    }
    if (result.reason === 'ALREADY_USED') {
      return res.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"/><title>Already Used</title>
<style>body{margin:0;display:grid;place-items:center;min-height:100svh;font-family:system-ui,-apple-system,Segoe UI,Roboto}.box{padding:28px;border-radius:16px;border:1px solid #f3d0d0;background:#fff0f0}h1{color:#a40000;margin:0 0 8px}p{margin:0}</style>
</head><body><div class="box"><h1>⛔ ALREADY USED</h1><p>Ticket ${code} has already been scanned.</p></div></body></html>`);
    }
    return res.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"/><title>Not Found</title>
<style>body{margin:0;display:grid;place-items:center;min-height:100svh;font-family:system-ui,-apple-system,Segoe UI,Roboto}.box{padding:28px;border-radius:16px;border:1px solid #e1e1e1;background:#fafafa}h1{color:#333;margin:0 0 8px}p{margin:0}</style>
</head><body><div class="box"><h1>❓ UNKNOWN TICKET</h1><p>No ticket found for ${code}.</p></div></body></html>`);
  } catch (e) {
    console.error(e);
    res.status(500).send('Error during check-in');
  }
});

// Free browser scanner for staff (no app install)
app.get('/scanner', (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(`<!doctype html><html><head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Scanner</title>
<script src="https://unpkg.com/html5-qrcode" defer></script>
<style>body{margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto;display:grid;place-items:center;min-height:100svh;padding:16px}
h1{margin:0 0 12px}#reader{width:min(520px,92vw)}</style></head>
<body>
  <div>
    <h1>Scan Ticket</h1>
    <div id="reader"></div>
    <p id="status"></p>
  </div>
  <script>
    window.addEventListener('load', () => {
      const reader = new Html5Qrcode("reader");
      const onScanSuccess = (decodedText) => {
        document.getElementById('status').textContent = 'Opening: ' + decodedText;
        window.location.href = 'https://book.stripe.com/7sY5kE5LT76o6s6cXyd7q00';
      };
      const onScanFailure = () => {};
      reader.start({ facingMode:"environment" }, { fps:10, qrbox: {width:250, height:250} }, onScanSuccess, onScanFailure);
    });
  </script>
</body></html>`);
});

// Boot
const PORT = process.env.PORT || 3000;
dbInit().then(() => app.listen(PORT, () => console.log('Server running on', PORT)))
       .catch(err => { console.error('DB init failed:', err); process.exit(1); });
