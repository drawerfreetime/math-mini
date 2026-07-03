/**
 * 개발 서버 프록시: Claude API (로컬 Python 백엔드 없음 — API는 REACT_APP_API_BASE 원격 호출)
 */
const fs = require('fs');
const https = require('https');
const path = require('path');

function readApiKey() {
  const envPath = path.resolve(__dirname, '../.env');
  if (!fs.existsSync(envPath)) return '';
  const content = fs.readFileSync(envPath, 'utf-8').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  for (const line of content.split('\n')) {
    const t = line.trim();
    if (t.startsWith('REACT_APP_CLAUDE_API_KEY=')) {
      return t.slice('REACT_APP_CLAUDE_API_KEY='.length).replace(/\s/g, '');
    }
  }
  return '';
}

const apiKey = readApiKey();
console.log('\n[Proxy] Claude 키 길이:', apiKey.length, '| math-mini (프론트엔드 전용)');

function copyDownstreamHeaders(proxyRes, res) {
  res.status(proxyRes.statusCode);
  Object.entries(proxyRes.headers).forEach(([k, v]) => {
    if (k !== 'content-encoding') res.setHeader(k, v);
  });
}

module.exports = function proxy(app) {
  app.use('/api/claude', (req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const bodyStr = Buffer.concat(chunks).toString('utf-8');
      const targetPath = req.path || '/v1/messages';
      console.log('[Claude]', req.method, targetPath, 'len:', bodyStr.length);

      const opts = {
        hostname: 'api.anthropic.com',
        port: 443,
        path: targetPath,
        method: req.method,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(bodyStr),
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
      };

      const pReq = https.request(opts, (pRes) => {
        console.log('[Claude] ←', pRes.statusCode);
        copyDownstreamHeaders(pRes, res);
        pRes.pipe(res);
      });

      pReq.on('error', (err) => {
        console.error('[Claude]', err.message);
        res.status(500).json({ error: err.message });
      });

      pReq.write(bodyStr);
      pReq.end();
    });
  });
};
