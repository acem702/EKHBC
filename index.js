
const { startServer } = require("./src/node/server");
const config = require("./config.json");
const http = require('http');
const fs = require('fs');
const path = require('path');

(async () => {
    // Start the blockchain node
    await startServer(config);
    
    // Start the explorer web server on port 8080
    const explorerPort = 8080;
    
    const explorerServer = http.createServer((req, res) => {
        // Enable CORS
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

        if (req.method === 'OPTIONS') {
            res.writeHead(200);
            res.end();
            return;
        }

        let filePath = './explorer.html';

        // Route handling
        if (req.url === '/' || req.url === '/explorer' || req.url === '/dashboard') {
            filePath = './explorer.html';
        } else if (req.url.startsWith('/rpc/')) {
            // Proxy RPC requests
            const rpcPath = req.url.replace('/rpc', '');
            const options = {
                hostname: 'localhost',
                port: 3000,
                path: rpcPath,
                method: req.method,
                headers: req.headers
            };

            const proxy = require('http').request(options, (proxyRes) => {
                res.writeHead(proxyRes.statusCode, proxyRes.headers);
                proxyRes.pipe(res, { end: true });
            });

            proxy.on('error', (err) => {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: { message: 'RPC server unavailable' } }));
            });

            req.pipe(proxy, { end: true });
            return;
        } else {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('404 Not Found');
            return;
        }

        // Read and serve the file
        fs.readFile(filePath, (err, content) => {
            if (err) {
                res.writeHead(500, { 'Content-Type': 'text/plain' });
                res.end('500 Internal Server Error');
                return;
            }

            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(content);
        });
    });

    explorerServer.listen(explorerPort, '0.0.0.0', () => {
        console.log(`LOG :: Ekehi Network Explorer running on http://0.0.0.0:${explorerPort}`);
        console.log('LOG :: You can access the explorer dashboard at the URL above');
    });
})();
