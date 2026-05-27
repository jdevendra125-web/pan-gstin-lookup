// Vercel Serverless Function — GST Portal Proxy
// Calls taxpayer.gst.gov.in server-side (no CORS issues)

export default async function handler(req, res) {
  // CORS headers so the frontend can call this
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { pan } = req.query;

  // Validate PAN format
  if (!pan || !/^[A-Z]{5}[0-9]{4}[A-Z]$/i.test(pan)) {
    return res.status(400).json({ error: 'Invalid PAN format' });
  }

  const panUpper = pan.toUpperCase();

  try {
    // Call the GST portal search-by-PAN API
    const gstRes = await fetch(
      `https://taxpayer.gst.gov.in/taxpayerservice/v2/tp/search/${panUpper}`,
      {
        headers: {
          'Accept': 'application/json, text/plain, */*',
          'Accept-Language': 'en-US,en;q=0.9',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Referer': 'https://www.gst.gov.in/',
          'Origin': 'https://www.gst.gov.in',
        },
      }
    );

    if (!gstRes.ok) {
      // Try alternate endpoint
      const alt = await fetch(
        `https://taxpayer.gst.gov.in/taxpayerservice/tp/search/${panUpper}`,
        {
          headers: {
            'Accept': 'application/json',
            'User-Agent': 'Mozilla/5.0',
            'Referer': 'https://www.gst.gov.in/',
          },
        }
      );
      if (!alt.ok) throw new Error(`GST portal returned ${gstRes.status}`);
      const altData = await alt.json();
      return res.status(200).json(normalise(panUpper, altData));
    }

    const data = await gstRes.json();
    return res.status(200).json(normalise(panUpper, data));

  } catch (err) {
    // Try the public search endpoint as fallback
    try {
      const fallback = await fetch(
        `https://services.gst.gov.in/services/api/search?action=TP&pan=${panUpper}`,
        {
          headers: {
            'Accept': 'application/json',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
            'Referer': 'https://services.gst.gov.in/services/searchtpbypan',
          },
        }
      );
      const fallbackData = await fallback.json();
      return res.status(200).json(normalise(panUpper, fallbackData));
    } catch (err2) {
      return res.status(502).json({ error: 'GST portal unavailable. Please try again shortly.', detail: err.message });
    }
  }
}

// Normalise various GST API response shapes into a clean array
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
    '38':'Ladakh','97':'Other Territory','99':'Centre Jurisdiction'
  };

  function stateFromGstin(gstin) {
    const code = (gstin || '').substring(0, 2);
    return STATE_CODES[code] || `State (${code})`;
  }

  function parseItem(item) {
    if (!item || typeof item !== 'object') return null;
    const gstin = item.gstin || item.GSTIN || '';
    if (!gstin) return null;
    return {
      gstin,
      legalName: item.lgnm || item.legalName || '',
      tradeName: item.tradeNam || item.tradeName || item.lgnm || '',
      state: item.pradr?.addr?.stcd || item.pradr?.loc || stateFromGstin(gstin),
      status: item.sts || item.status || 'Active',
      regDate: item.rgdt || '',
      businessType: item.ctb || '',
      taxpayerType: item.dty || '',
    };
  }

  // Handle different response shapes
  let items = [];

  if (Array.isArray(raw)) {
    items = raw;
  } else if (Array.isArray(raw?.data)) {
    // { data: [...] }
    items = raw.data.map(d => d?.data || d).filter(Boolean);
  } else if (raw?.data && typeof raw.data === 'object' && !Array.isArray(raw.data)) {
    // { data: { "GSTIN1": "{...}", "GSTIN2": "{...}" } } — Vayana style
    items = Object.values(raw.data).map(v => {
      try { return typeof v === 'string' ? JSON.parse(v) : v; } catch { return null; }
    }).filter(Boolean);
  } else if (raw?.taxpayerInfo) {
    items = Array.isArray(raw.taxpayerInfo) ? raw.taxpayerInfo : [raw.taxpayerInfo];
  } else if (raw?.gstin) {
    items = [raw];
  }

  const gstins = items.map(parseItem).filter(Boolean);
  return { pan, gstins, count: gstins.length };
}
