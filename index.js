const http = require('http');
const fs = require('fs').promises;
const path = require('path');
const url = require('url');
const { randomUUID } = require('crypto');

const DATA_FILE = path.join(__dirname, 'items.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

const PORT = process.env.PORT || 3000;

// read/write items.json
async function readItems() {
  try {
    const txt = await fs.readFile(DATA_FILE, 'utf8');
    return JSON.parse(txt || '[]');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

async function writeItems(items) {
  // write atomically: write temp then rename
  const tmp = DATA_FILE + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(items, null, 2), 'utf8');
  await fs.rename(tmp, DATA_FILE);
}

// JSON body parsing
function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      if (!body) return resolve(null);
      try { resolve(JSON.parse(body)); }
      catch (e) { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

// Some Validation 
function validateItemPayload(payload, isPartial = false) {
  // Item attributes: name, price, size (s|m|l), id (created server-side)
  const allowedSizes = ['s','m','l','small','medium','large'];
  const errors = [];

  if (!isPartial || ('name' in payload)) {
    if (typeof payload.name !== 'string' || payload.name.trim() === '') errors.push('name must be a non-empty string');
  }
  if (!isPartial || ('price' in payload)) {
    if (typeof payload.price !== 'number' || !isFinite(payload.price) || payload.price < 0) errors.push('price must be a non-negative number');
  }
  if (!isPartial || ('size' in payload)) {
    if (typeof payload.size !== 'string' || !allowedSizes.includes(payload.size.toLowerCase()))
      errors.push('size must be one of s,m,l (or small,medium,large)');
  }

  return errors;
}

/* ---- Serve static html files ---- */
async function serveStaticHtml(req, res) {
  const parsed = url.parse(req.url).pathname;
  // Map root to /index.html
  let requested = parsed === '/' ? '/index.html' : parsed;

  // Only serve files ending with .html
  if (!requested.endsWith('.html')) return false;

  const safePath = path.normalize(requested).replace(/^(\.\.[/\\])+/, '');
  const filePath = path.join(PUBLIC_DIR, safePath);

  try {
    const content = await fs.readFile(filePath, 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(content);
    return true;
  } catch (err) {
    // If any other .html requested that doesn't exist then return 404 page
    const notFoundPath = path.join(PUBLIC_DIR, '404.html');
    try {
      const nf = await fs.readFile(notFoundPath, 'utf8');
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(nf);
      return true;
    } catch (e) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
      return true;
    }
  }
}

// API handlers
async function handleApi(req, res) {
  const parsed = url.parse(req.url, true);
  const segments = parsed.pathname.split('/').filter(Boolean); // e.g. ['api','items',':id']
  if (segments.length === 0 || segments[0] !== 'api') return false;

  // Only path root: /api/items or /api/items/:id
  if (segments[1] !== 'items') {
    res.writeHead(404, {'Content-Type':'application/json'});
    res.end(JSON.stringify({ success: false, error: 'Not found' }));
    return true;
  }

  const id = segments[2] ? segments[2] : null;

  try {
    if (req.method === 'GET' && !id) {
      // Get all items
      const items = await readItems();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, data: items }));
      return true;
    }

    if (req.method === 'GET' && id) {
      const items = await readItems();
      const item = items.find(i => i.id === id);
      if (!item) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Item not found' }));
        return true;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, data: item }));
      return true;
    }

    if (req.method === 'POST' && !id) {
      const payload = await parseJsonBody(req);
      if (!payload) {
        res.writeHead(400, {'Content-Type':'application/json'});
        res.end(JSON.stringify({ success:false, error:'Missing JSON body' }));
        return true;
      }
      const errors = validateItemPayload(payload, false);
      if (errors.length) {
        res.writeHead(422, {'Content-Type':'application/json'});
        res.end(JSON.stringify({ success:false, errors }));
        return true;
      }

      const items = await readItems();
      const newItem = {
        id: randomUUID(),
        name: payload.name,
        price: payload.price,
        size: payload.size.toLowerCase().replace('small','s').replace('medium','m').replace('large','l')
      };
      items.push(newItem);
      await writeItems(items);
      res.writeHead(201, {'Content-Type':'application/json'});
      res.end(JSON.stringify({ success:true, data: newItem }));
      return true;
    }

    if (req.method === 'PUT' && id) {
      const payload = await parseJsonBody(req);
      if (!payload) {
        res.writeHead(400, {'Content-Type':'application/json'});
        res.end(JSON.stringify({ success:false, error:'Missing JSON body' }));
        return true;
      }
      const errors = validateItemPayload(payload, true);
      if (errors.length) {
        res.writeHead(422, {'Content-Type':'application/json'});
        res.end(JSON.stringify({ success:false, errors }));
        return true;
      }
      const items = await readItems();
      const idx = items.findIndex(i => i.id === id);
      if (idx === -1) {
        res.writeHead(404, {'Content-Type':'application/json'});
        res.end(JSON.stringify({ success:false, error:'Item not found' }));
        return true;
      }
      const item = items[idx];
      if ('name' in payload) item.name = payload.name;
      if ('price' in payload) item.price = payload.price;
      if ('size' in payload) item.size = payload.size.toLowerCase().replace('small','s').replace('medium','m').replace('large','l');
      items[idx] = item;
      await writeItems(items);
      res.writeHead(200, {'Content-Type':'application/json'});
      res.end(JSON.stringify({ success:true, data: item }));
      return true;
    }

    if (req.method === 'DELETE' && id) {
      const items = await readItems();
      const idx = items.findIndex(i => i.id === id);
      if (idx === -1) {
        res.writeHead(404, {'Content-Type':'application/json'});
        res.end(JSON.stringify({ success:false, error:'Item not found' }));
        return true;
      }
      const removed = items.splice(idx, 1)[0];
      await writeItems(items);
      res.writeHead(200, {'Content-Type':'application/json'});
      res.end(JSON.stringify({ success:true, data: removed }));
      return true;
    }

    // Method not allowed
    res.writeHead(405, {'Content-Type':'application/json'});
    res.end(JSON.stringify({ success:false, error:'Method not allowed' }));
    return true;

  } catch (err) {
    console.error('API error:', err);
    res.writeHead(500, {'Content-Type':'application/json'});
    res.end(JSON.stringify({ success:false, error:'Internal server error' }));
    return true;
  }
}

// Create server 
const server = http.createServer(async (req, res) => {
  try {
    // First, try static html serving for paths ending in .html or root
    const servedStatic = await serveStaticHtml(req, res);
    if (servedStatic) return;

    // Then, check API paths
    const servedApi = await handleApi(req, res);
    if (servedApi) return;

    // Fallback: 404 for everything else
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: 'Not found' }));
  } catch (err) {
    console.error('Unhandled error:', err);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: 'Internal server error' }));
  }
});

server.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
