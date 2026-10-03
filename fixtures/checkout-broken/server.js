import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('./index.html', import.meta.url));
const home = await readFile(new URL('./home.html', import.meta.url));
const server = createServer((request, response) => {
  if (request.method === 'POST' && request.url === '/checkout') {
    request.resume();
    response.writeHead(402, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ code: 'PAYMENT_DECLINED', message: 'Payment declined. Please try again.' }));
  } else if (request.method === 'GET' && request.url === '/') {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(html);
  } else if (request.method === 'GET' && (request.url === '/home' || request.url === '/home/')) {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(home);
  } else {
    response.writeHead(404);
    response.end();
  }
});

server.listen(Number(process.env.PORT ?? 3000), process.env.HOST ?? '127.0.0.1', () => {
  console.log(`Checkout fixture listening on http://${server.address().address}:${server.address().port}`);
});
