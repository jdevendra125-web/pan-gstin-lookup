// Vercel Serverless Function — Sandbox.co.in GST API Proxy
// Step 1: Authenticate to get JWT token
// Step 2: POST to /gst/compliance/public/pan/search with PAN

const API_KEY    = process.env.SANDBOX_API_KEY    || 'key_live_ae23886229304be5a95ac383378efd81';
const API_SECRET = process.env.SANDBOX_API_SECRET || 'secret_live_facb091e7ab448bab08327062b78663b';
const BASE_URL   = 'https://api.sandbox.co.in';

const STATE_CODES = {
  '01':'Jammu & Kashmir','02':'Himachal Pradesh','03':'Punjab','04':'Chandigarh',
  '05':'Uttarakhand','06':'Haryana','07':'Delhi','08':'Rajasthan','09':'Uttar Pradesh',
  '10':'Bihar','11':'Sikkim','12':'Arunachal Pradesh','13':'Nagaland','14':'Manipur',
  '15':'Mizoram','16':'Tripura','17':'Meghalaya','18':'Assam','19':'West Bengal',
  '20':'Jharkhand','21':'Odisha','22':'Chhattisgarh','23':'Madhya Pradesh',
  '24':'Gujarat','26':'Dadra & Nagar Haveli','27':'Maharashtra','28':'Andhra Pradesh (Old)',
  '29':'Karnataka','30':'Goa','31':'Lakshadweep','32':'Kerala','33':'Tamil Nadu',
  '34':'Puducherry','35':'Andaman & Nicobar','36':'Telangana','37':'Andhra Pradesh',
  '38':'Ladakh','97':'Other Territory','99':'Centre Jurisdiction',
};

function stateFromGstin(gstin) {
  const code = String(gstin || '').substring(0, 2);
  return STATE_CODES[code] || `State ${code}`;
}

// Simple in-memory token cache (per function instance lifetime)
let cachedToken = null;
let tokenExpiry = 0;

async function getToken() {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;

  const res = await fetch(`${BASE_URL}/authenticate`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': API_KEY,
      'x-api-secret': API_SECRET,
    },
    body: JSON.stringify({}),
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Auth failed: ${res.status} — ${txt}`);
  }

  const data = await res.json();
  // Sandbox returns { access_token, ... } or { data: { access_token } }
  const token = data?.data?.access_token || data?.access_token;
  if (!token) throw new Error(`No token in auth response: ${JSON.stringify(data)}`);

  cachedToken = token;
  tokenExpiry = Date.now() + 55 * 60 * 1000; // cache for 55 min
  return token;
}

async function searchByPan(pan, token) {
  const res = await fetch(`${BASE_URL}/gst/compliance/public/pan/search`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': API_KEY,
      'authorization': token,   // Sandbox: NO "Bearer" prefix
    },
    body: JSON.stringify({ pan }),
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Sandbox API error: ${res.status} — ${txt}`);
  }

  return res.json();
}

function parseItem(item) {
  // item = { gstin: "...", data: { lgnm, tradeNam, sts, ... } }
  const d = item?.data || item || {};
  const gstin = d.gstin || item?.gstin || '';
  if (!gstin) return null;

  return {
    gstin,
    tradeName:    d.tradeNam    || d.tradeName    || d.lgnm || '',
    legalName:    d.lgnm        || d.legalName    || '',
    state:        (d.pradr?.addr?.stcd) || stateFromGstin(gstin),
    status:       d.sts         || d.status       || '',
    regDate:      d.rgdt        || '',
    businessType: d.ctb         || '',
    taxpayerType: d.dty         || '',
    lastUpdated:  d.lstupdt     || '',
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET')    return res.status(405).json({ error: 'Method not allowed' });

  const { pan } = req.query;
  if (!pan || !/^[A-Z]{5}[0-9]{4}[A-Z]$/i.test(pan)) {
    return res.status(400).json({ error: 'Invalid PAN format. Expected 10-char alphanumeric like ABCDE1234F.' });
  }

  const panUpper = pan.toUpperCase();

  try {
    const token  = await getToken();
    const raw    = await searchByPan(panUpper, token);

    // raw.data = array of { gstin, data: { ... } }
    const items  = Array.isArray(raw?.data) ? raw.data : [];
    const gstins = items.map(parseItem).filter(Boolean);

    return res.status(200).json({ pan: panUpper, gstins, count: gstins.length });

  } catch (err) {
    console.error('GSTIN lookup error:', err.message);
    return res.status(502).json({
      error: err.message || 'Lookup failed. Please try again.',
      pan: panUpper,
      gstins: [],
    });
  }
}
