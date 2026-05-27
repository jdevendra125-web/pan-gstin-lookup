// Vercel Serverless Function — GST Portal Proxy
// Uses the public GSTN taxpayer search API with correct headers

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { pan } = req.query;
  if (!pan || !/^[A-Z]{5}[0-9]{4}[A-Z]$/i.test(pan)) {
    return res.status(400).json({ error: 'Invalid PAN format' });
  }

  const panUpper = pan.toUpperCase();
  const headers = {
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9,hi;q=0.8',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Origin': 'https://services.gst.gov.in',
    'Referer': 'https://services.gst.gov.in/services/searchtpbypan',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'sec-ch-ua': '"Chromium";v="124", "Google Chrome";v="124"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
  };

  // Try all known GSTN endpoints in order
  const endpoints = [
    `https://services.gst.gov.in/services/api/search?action=TP&pan=${panUpper}`,
    `https://taxpayer.gst.gov.in/taxpayerservice/tp/search/${panUpper}`,
    `https://taxpayer.gst.gov.in/taxpayerservice/v2/tp/search/${panUpper}`,
  ];

  let lastError = '';
  for (const url of endpoints) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      const r = await fetch(url, { headers, signal: controller.signal });
      clearTimeout(timeout);

      if (!r.ok) { lastError = `HTTP ${r.status} from ${url}`; continue; }

      const raw = await r.json();
      const result = normalise(panUpper, raw);
      if (result.gstins.length > 0 || result.notFound) {
        return res.status(200).json(result);
      }
      lastError = 'Empty response';
    } catch (e) {
      lastError = e.name === 'AbortError' ? 'Timeout' : e.message;
      continue;
    }
  }

  return res.status(502).json({
    error: 'GST portal did not return data. It may be temporarily down or the PAN has no GST registrations.',
    detail: lastError,
    pan: panUpper,
    gstins: [],
  });
}

function normalise(pan, raw) {
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

  function parseOne(item) {
    if (!item || typeof item !== 'object') return null;
    const gstin = item.gstin || item.GSTIN || '';
    if (!gstin) return null;
    return {
      gstin,
      tradeName:    item.tradeNam   || item.tradeName   || item.lgnm || '',
      legalName:    item.lgnm       || item.legalName   || '',
      state:        (item.pradr?.addr?.stcd) || (item.pradr?.loc) || stateFromGstin(gstin),
      status:       item.sts        || item.status      || '',
      regDate:      item.rgdt       || '',
      businessType: item.ctb        || '',
      taxpayerType: item.dty        || '',
    };
  }

  // Handle { errorCode: "SWEB_9035" } — PAN not found
  if (raw?.errorCode || raw?.error_code) {
    return { pan, gstins: [], notFound: true, count: 0 };
  }

  let items = [];

  if (Array.isArray(raw)) {
    items = raw;
  } else if (Array.isArray(raw?.data)) {
    // [{ data: {...}, gstin: "..." }] or [{ ... }]
    items = raw.data.map(d => d?.data || d).filter(Boolean);
  } else if (raw?.data && typeof raw.data === 'object') {
    // Vayana style: { data: { "GSTIN": "{...json...}" } }
    items = Object.values(raw.data).map(v => {
      try { return typeof v === 'string' ? JSON.parse(v) : v; } catch { return null; }
    }).filter(Boolean);
  } else if (raw?.gstin) {
    items = [raw];
  } else if (Array.isArray(raw?.taxpayerInfo)) {
    items = raw.taxpayerInfo;
  }

  const gstins = items.map(parseOne).filter(Boolean);
  return { pan, gstins, count: gstins.length };
}
