const express = require('express');
const fetch = require('node-fetch');
const cheerio = require('cheerio');
const { URL } = require('url');

const app = express();
app.use(express.json());

// Logging sederhana biar keliatan di Vercel Logs
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// ─────────────────────────────────────────────
// FUNGSI: Ekstrak metadata dari link Terabox
// ─────────────────────────────────────────────
async function extractMetadataFromShare(shareUrl) {
  try {
    const res = await fetch(shareUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const text = await res.text();

    // Coba cari JSON embedded dalam halaman
    const regexJson = /(window\.__INITIAL_STATE__|window\.__INITIAL_DATA__|var\s+shareinfo)\s*=\s*(\{[\s\S]*?\});/;
    const m = text.match(regexJson);

    if (m && m[2]) {
      try {
        const parsed = JSON.parse(m[2]);
        const pcftoken = parsed.pcftoken || parsed.data?.pcftoken || '';
        let jsTokenRaw = parsed.jsToken || parsed.data?.jsToken || '';
        try { jsTokenRaw = decodeURIComponent(jsTokenRaw); } catch (e) {}

        // Ambil token hex panjang
        const mTok = jsTokenRaw.match(/["']([A-F0-9]{40,})["']/i);
        const jsToken = mTok ? mTok[1] : null;

        const newDomain = parsed.newDomain || parsed.data?.newDomain || null;

        const base = {
          success: true,
          source: 'embedded-json',
          rawParsed: parsed,
          pcftoken,
          jsToken,
          newDomain
        };

        // Coba ambil daftar file langsung dari endpoint internal
        const u = new URL(shareUrl);
        const surl = u.searchParams.get('surl') || u.searchParams.get('shareid') || null;
        if (surl && (pcftoken || jsToken) && newDomain && newDomain.origin) {
          try {
            const tryPaths = [
              `${newDomain.origin}/wap/share/filelist?surl=${surl}`,
              `${newDomain.origin}/share/list?surl=${surl}`,
              `${newDomain.origin}/api/share/list?surl=${surl}`
            ];
            for (const tryUrl of tryPaths) {
              console.log(`🔍 Trying endpoint: ${tryUrl}`);
              const r = await fetch(tryUrl, {
                headers: {
                  'User-Agent': 'Mozilla/5.0',
                  'Referer': shareUrl,
                  'X-Requested-With': 'XMLHttpRequest',
                  ...(pcftoken ? { 'pcftoken': pcftoken } : {}),
                  ...(jsToken ? { 'jsToken': jsToken } : {})
                }
              });
              if (!r.ok) continue;

              const ct = (r.headers.get('content-type') || '').toLowerCase();
              if (ct.includes('application/json')) {
                const json = await r.json();
                base.guessFileList = { url: tryUrl, json };
                return base;
              } else {
                const txt = await r.text();
                if (txt && (txt.includes('file_list') || txt.includes('.mp4'))) {
                  base.guessFileList = { url: tryUrl, htmlSnippet: txt.slice(0, 20000) };
                  return base;
                }
              }
            }
          } catch (e) {
            base.fetchFileListError = e.message;
          }
        }

        return base;
      } catch (e) {
        console.log('⚠️ JSON parse error:', e.message);
      }
    }

    // Fallback: cari manual di DOM
    const $ = cheerio.load(text);
    const possibleFiles = [];
    $('a, li, div, span').each((i, el) => {
      const t = $(el).text().trim();
      if (!t) return;
      if (t.match(/\.\w{2,6}$/) && t.length < 200) possibleFiles.push(t);
    });
    if (possibleFiles.length) {
      return { success: true, source: 'heuristic-dom', data: { files: possibleFiles } };
    }

    return { success: false, source: 'raw', html: text.slice(0, 20000) };
  } catch (err) {
    console.error('❌ Error extracting metadata:', err);
    return { success: false, error: err.message };
  }
}

// ─────────────────────────────────────────────
// ENDPOINT: POST /api/metadata
// ─────────────────────────────────────────────
app.post('/api/metadata', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'Missing URL' });

  console.log(`📥 Extracting metadata from: ${url}`);
  const data = await extractMetadataFromShare(url);
  res.json(data);
});

// ─────────────────────────────────────────────
// ENDPOINT: POST /api/extract-files
// ─────────────────────────────────────────────
app.post('/api/extract-files', async (req, res) => {
  const { metadata, shareUrl } = req.body;
  if (!metadata) return res.status(400).json({ error: 'Missing metadata' });

  if (metadata.guessFileList && metadata.guessFileList.json) {
    const j = metadata.guessFileList.json;
    const candidates = j.list || j.file_list || j.items || j.data || j.files;
    if (Array.isArray(candidates)) {
      const files = candidates.map(f => ({
        name: f.filename || f.name || f.path || f.server_filename || null,
        size: f.size || f.filesize || f.size_byte || null,
        directUrl: f.url || f.download_url || f.dlink || null
      }));
      return res.json({ ok: true, from: metadata.guessFileList.url, files });
    }
    return res.json({ ok: true, from: metadata.guessFileList.url, raw: j });
  }

  if (metadata.rawParsed) {
    const p = metadata.rawParsed;
    const fc = p.file_list || p.files || p.data?.file_list || p.data?.files;
    if (Array.isArray(fc)) {
      return res.json({
        ok: true,
        files: fc.map(f => ({
          name: f.server_filename || f.name,
          size: f.size,
          directUrl: f.dlink || null
        }))
      });
    }
  }

  return res.json({
    ok: false,
    message: 'Could not extract file list automatically',
    metadataSnapshot: metadata
  });
});

// ─────────────────────────────────────────────
// DEFAULT (GET /)
// ─────────────────────────────────────────────
app.get('/', (req, res) => {
  res.send(`
    <html>
      <head><title>Terabox Downloader</title></head>
      <body style="font-family: sans-serif; padding: 20px;">
        <h2>🧩 Terabox Downloader Test</h2>
        <form id="f">
          <input type="text" id="url" placeholder="Masukkan URL Terabox" style="width: 80%; padding: 8px;">
          <button type="submit">Get Metadata</button>
        </form>
        <pre id="out" style="white-space: pre-wrap; margin-top: 20px; background: #f3f3f3; padding: 10px;"></pre>
        <script>
          const f = document.getElementById('f');
          const out = document.getElementById('out');
          f.onsubmit = async (e) => {
            e.preventDefault();
            out.textContent = 'Loading...';
            const url = document.getElementById('url').value;
            const r = await fetch('/api/metadata', {
              method: 'POST',
              headers: {'Content-Type': 'application/json'},
              body: JSON.stringify({ url })
            });
            const j = await r.json();
            out.textContent = JSON.stringify(j, null, 2);
          };
        </script>
      </body>
    </html>
  `);
});

// ─────────────────────────────────────────────
// EXPORT (untuk Vercel)
// ─────────────────────────────────────────────
module.exports = app;
