// VOD — ローカル用の小さな静的ファイルサーバー（依存パッケージなし）
// YouTube / Twitch の埋め込みプレーヤーは file:// では動かないため、http://localhost で配信する。
const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const PORT = Number(process.env.PORT) || 5178;
const ROOT = path.join(__dirname, 'docs');
const URL_ = `http://localhost:${PORT}/`;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function openBrowser() {
  if (!process.argv.includes('--open')) return;
  const cmd = process.platform === 'win32' ? `start "" "${URL_}"`
    : process.platform === 'darwin' ? `open "${URL_}"` : `xdg-open "${URL_}"`;
  exec(cmd);
}

const server = http.createServer((req, res) => {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, URL_).pathname);
  } catch {
    res.writeHead(400);
    return res.end();
  }
  if (pathname === '/') pathname = '/index.html';
  const file = path.join(ROOT, path.normalize(pathname));
  if (!file.startsWith(ROOT + path.sep)) {
    res.writeHead(403);
    return res.end();
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('見つかりません');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.log(`ポート ${PORT} は使用中です。すでに起動している場合は ${URL_} を開いてください。`);
    openBrowser();
  } else {
    console.error(e);
  }
});

server.listen(PORT, 'localhost', () => {
  console.log(`VODを起動しました: ${URL_}`);
  console.log('終了するときはこのウィンドウを閉じてください。');
  openBrowser();
});
