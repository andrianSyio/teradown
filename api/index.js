// api/index.js
const express = require('express');
const fetch = require('node-fetch');
const cheerio = require('cheerio');
const { v4: uuidv4 } = require('uuid');
const serverless = require('serverless-http');
const url = require('url');

const app = express();
app.use(express.json());
app.use(express.static('public'));

const logs = new Map();
function addLog(id, message) {
  if (!logs.has(id)) logs.set(id, []);
  logs.get(id).push({ ts: new Date().toISOString(), msg: message });
}

async function extractMetadataFromShare(shareUrl) {
  const res = await fetch(shareUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  const text = await res.text();

  const regexes = [
    /window\.__INITIAL_STATE__\s*=\s*(\{[\s\S]*?\});/,
    /window\.__INITIAL_DATA__\s*=\s*(\{[\s\S]*?\});/,
    /var\s+shareinfo\s*=\s*(\{[\s\S]*?\});/,
    /<script[^>]*>[\s\S]*?({\s*"file_list"[\s\S]*?})[\s\S]*?<\/script>/i
  ];

  for (const r of regexes) {
    const m = text.match(r);
    if (m && m[1]) {
      try {
        const parsed = JSON.parse(m[1]);
        return { success: true, source: 'embedded-json', data: parsed };
      } catch (e) {}
    }
  }

  const $ = cheerio.load(text);
  const possibleFiles = [];
  $('a, li, div, span').each((i, el) => {
    const t = $(el).text().trim();
    if (!t) return;
    if (t.match(/\.\w{2,5}$/) && t.length < 200) {
      possibleFiles.push(t);
    }
  });
  if (possibleFiles.length) {
    return { success: true, source: 'heuristic-dom', data: { files: possibleFiles } };
  }

  return { success: false, source: 'raw', html: text.slice(0, 20000) };
}

app.post('/api/metadata', async (req, res) => {
  try {
    const { url: shareUrl } = req.body;
    if (!shareUrl) return res.status(400).json({ error: 'Missing url in body' });
    const meta = await extractMetadataFromShare(shareUrl);
    return res.json(meta);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
});

app.get('/api/proxy', async (req, res) => {
  const remote = req.query.url;
  const logId = req.query.id || uuidv4();
  addLog(logId, `Starting proxy for ${remote}`);

  if (!remote) {
    addLog(logId, 'No remote URL provided');
    return res.status(400).json({ error: 'Missing url query param', id: logId });
  }

  try {
    const parsed = url.parse(remote);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      addLog(logId, 'Invalid protocol');
      return res.status(400).json({ error: 'Invalid URL protocol', id: logId });
    }

    addLog(logId, `Fetching remote resource...`);
    const r = await fetch(remote, { headers: { 'User-Agent': 'Mozilla/5.0' } });

    if (!r.ok) {
      addLog(logId, `Remote responded with status ${r.status}`);
      return res.status(502).json({ error: 'Remote fetch failed', status: r.status, id: logId });
    }

    addLog(logId, `Remote OK. Content-Type: ${r.headers.get('content-type')}`);
    res.setHeader('content-type', r.headers.get('content-type') || 'application/octet-stream');
    const cd = r.headers.get('content-disposition');
    if (cd) res.setHeader('content-disposition', cd);

    // Vercel serverless streaming caveat: large streams may be cut by platform
    r.body.pipe(res);
    r.body.on('data', (c) => addLog(logId, `streamed ${c.length} bytes`));
    r.body.on('end', () => addLog(logId, 'stream end'));
  } catch (err) {
    addLog(logId, 'Error: ' + err.message);
    console.error(err);
    if (!res.headersSent) res.status(500).json({ error: err.message, id: logId });
  }
});

app.get('/api/logs', (req, res) => {
  const id = req.query.id;
  if (!id) return res.status(400).json({ error: 'Missing id' });
  const l = logs.get(id) || [];
  return res.json({ id, logs: l });
});

// export for serverless
module.exports = app;
module.exports.handler = serverless(app);
