require('dotenv').config();
const express = require('express');
const Stripe = require('stripe');
const QRCode = require('qrcode');
const crypto = require('crypto');

const app = express();
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// In-memory store (one-scan protection). NOTE: resets if the server restarts.
const ticketsCreated = new Set(); // valid ticket ids
const ticketsUsed = new Set();    // redeemed ticket ids

// Home page: simple “Buy Ticket” button (uses your Payment Link)
app.get('/', (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(`<!doctype html><html><head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Tickets</title>
<style>body{margin:0;display:grid;place-items:center;min-height:100vh;background:#0b0b10;color:#fff;font-family:ui-sans-serif,-apple-system,Segoe UI,Roboto}
.card{background:#161621;border:1px solid #2a2a3a;border-radius:16px;padding:24px;box-shadow:0 12px 32px rgba(0,0,0,.35);width:min(560px,92vw)}
button{font-weight:700;border:0;background:#6b8cff;color:#fff;padding:12px 16px;border-radius:12px;box-shadow:0 8px 20px rgba(107,140,255,.35);cursor:pointer}
p{color:#c8c8d6}</style></head><body>
  <div class="card">
    <h1>${process.env.EVENT_NAME || 'Event'}</h1>
    <p>${process.env.EVENT_DATETIME || ''} · ${process.env.EVENT_LOCATION || ''}</p>
    <p>Address revealed after purchase.</p>
    <button id="pay">Buy Ticket</button>
  </div>
  <script>
    document.getElementById('pay').onclick = () => {
      // YOUR Stripe Payment Link:
      window.location.href = 'https://book.stripe.com/7sY5kE5LT76o6s6cXyd7q00';
    };
  </script>
</body></html>`);
});

// Ticket page: Stripe redirects here after payment
// Set Payment Link “After payment redirect” to:
// https://qr-ticket-yy10.onrender.com/ticket?session_id={CHECKOUT_SESSION_ID}
app.get('/ticket', async (req, res) => {
  const sessionId = req.query.session_id;
  if (!sessionId) return res.status(400).send('Missing session_id');

  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    if (session.payment_status !== 'paid') {
      return res.status(402).send('Payment not completed');
    }

    // Use session.id as ticketId (prevents duplicates on refresh)
    const ticketId = session.id;
    ticketsCreated.add(ticketId);

    const checkinUrl = `${process.env.BASE_URL}/checkin?code=${encodeURIComponent(ticketId)}`;
    const qrDataUrl = await QRCode.toDataURL(checkinUrl, { margin: 0 });

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(`<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${process.env.EVENT_NAME || 'Your Ticket'}</title>
<style>
  :root { --bg:#0b0b10; --card:#15151c; --ink:#fff; --muted:#a6a6b3; --accent:#6b8cff; --line:#252533; }
  body{margin:0;background:var(--bg);color:var(--ink);font-family:ui-sans-serif,-apple-system,Segoe UI,Roboto,Helvetica,Arial}
  .wrap{min-height:100svh;display:grid;place-items:center;padding:24px}
  .ticket{width:min(440px,92vw);background:linear-gradient(180deg,#161621,#13131b);border:1px solid var(--line);border-radius:24px;box-shadow:0 12px 40px rgba(0,0,0,.45);padding:18px 18px 24px}
  .row{display:flex;align-items:center;justify-content:space-between;gap:12px}
  .meta{font-size:12px;color:var(--muted)} .meta b{color:var(--ink)}
  .title{margin:12px 0 8px;text-align:center}
  .title .main{font-size:22px;font-weight:800}.title .sub{font-size:12px;color:var(--muted)}
  .qrbox{margin:16px auto 12px;width:min(280px,70vw);aspect-ratio:1/1;background:#fff;border-radius:18px;padding:14px;display:grid;place-items:center}
  .qrbox img{width:100%;height:100%;object-fit:contain;image-rendering:pixelated}
  .code{text-align:center;font-size:12px;color:var(--muted);margin-top:6px}
  .badge{padding:4px 10px;border:1px solid var(--line);border-radius:999px;background:#0f0f16;color:#cfd8ff;font-weight:600;display:inline-block;margin-top:8px}
  @media print { body{background:#fff}.wrap{padding:0}.ticket{width:100%!important;border:none;border-radius:0;box-shadow:none;background:#fff} }
</style></head>
<body>
  <div class="wrap">
    <article class="ticket" role="main" aria-label="Event ticket">
      <div class="row">
        <div class="meta">DATE & TIME<br><b>${process.env.EVENT_DATETIME || ''}</b></div>
        <div class="meta" style="text-align:right">LOCATION<br><b>${process.env.EVENT_LOCATION || ''}</b></div>
      </div>
      <h1 class="title">
        <div class="main">${process.env.EVENT_NAME || ''}</div>
        <div class="sub">${process.env.EVENT_ADDRESS || ''}</div>
      </h1>
      <div class="qrbox"><img alt="QR" src="${qrDataUrl}"></div>
      <div class="code">Ticket ID: ${ticketId}</div>
      <div style="text-align:center"><span class="badge">Admit One</span></div>
    </article>
  </div>
</body></html>`);
  } catch (e) {
    console.error('Error generating ticket:', e);
    res.status(500).send('Error generating ticket');
  }
});

// One-time check-in (first scan admits, next scan rejected)
app.get('/checkin', (req, res) => {
  const code = req.query.code;
  if (!code) return res.status(400).send('Missing code');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');

  if (!ticketsCreated.has(code)) {
    return res.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"/><title>Unknown</title>
<style>body{margin:0;display:grid;place-items:center;min-height:100svh;font-family:system-ui,-apple-system,Segoe UI,Roboto}.box{padding:28px;border-radius:16px;border:1px solid #e1e1e1;background:#fafafa}h1{color:#333;margin:0 0 8px}</style>
</head><body><div class="box"><h1>❓ UNKNOWN TICKET</h1><p>No ticket found for ${code}.</p></div></body></html>`);
  }
  if (ticketsUsed.has(code)) {
    return res.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"/><title>Already Used</title>
<style>body{margin:0;display:grid;place-items:center;min-height:100svh;font-family:system-ui,-apple-system,Segoe UI,Roboto}.box{padding:28px;border-radius:16px;border:1px solid #f3d0d0;background:#fff0f0}h1{color:#a40000;margin:0 0 8px}</style>
</head><body><div class="box"><h1>⛔ ALREADY USED</h1><p>Ticket ${code} has already been scanned.</p></div></body></html>`);
  }

  ticketsUsed.add(code);
  return res.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"/><title>Admit</title>
<style>body{margin:0;display:grid;place-items:center;min-height:100svh;font-family:system-ui,-apple-system,Segoe UI,Roboto}.box{padding:28px;border-radius:16px;border:1px solid #d1f2da;background:#eafaf0}h1{color:#0a7f45;margin:0 0 8px}</style>
</head><body><div class="box"><h1>✅ OK — ADMIT</h1><p>Ticket ${code} redeemed.</p></div></body></html>`);
});

// Web scanner (no app needed)
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
        window.location.href = decodedText; // should be /checkin?code=...
      };
      const onScanFailure = () => {};
      reader.start({ facingMode:"environment" }, { fps:10, qrbox: {width:250, height:250} }, onScanSuccess, onScanFailure);
    });
  </script>
</body></html>`);
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server running on', PORT));
