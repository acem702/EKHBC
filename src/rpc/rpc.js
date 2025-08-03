
"use strict";

const fastify = require("fastify")({ logger: false });

class RPCServer {
    constructor(PORT, client, transactionHandler, stateDB, blockDB) {
        this.PORT = PORT;
        this.client = client;
        this.transactionHandler = transactionHandler;
        this.stateDB = stateDB;
        this.blockDB = blockDB;
        
        this.setupMiddleware();
        this.setupRoutes();
    }

    setupMiddleware() {
        // CORS middleware
        fastify.register(async function (fastify) {
            fastify.addHook('preHandler', async (request, reply) => {
                reply.header('Access-Control-Allow-Origin', '*');
                reply.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
                reply.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
            });

            fastify.options('/*', async (request, reply) => {
                return reply.status(200).send();
            });
        });

        // Error handler
        fastify.setErrorHandler((error, request, reply) => {
            console.error('RPC Error:', error);
            reply.status(500).send({
                success: false,
                payload: null,
                error: { message: 'Internal server error' }
            });
        });
    }

    setupRoutes() {
        // GET routes for simple queries
        fastify.get('/', this.handleStatus.bind(this));
        fastify.get('/status', this.handleStatus.bind(this));
        fastify.get('/blockNumber', this.handleGetBlockNumber.bind(this));
        fastify.get('/address', this.handleGetAddress.bind(this));
        fastify.get('/mining', this.handleGetMining.bind(this));
        fastify.get('/networkStats', this.handleGetNetworkStats.bind(this));
        fastify.get('/work', this.handleGetWork.bind(this));

        // Legacy GET routes for compatibility
        fastify.get('/get_blockNumber', this.handleGetBlockNumber.bind(this));
        fastify.get('/get_address', this.handleGetAddress.bind(this));
        fastify.get('/get_networkStats', this.handleGetNetworkStats.bind(this));
        fastify.get('/get_work', this.handleGetWork.bind(this));

        // POST routes for complex queries
        fastify.post('/getBlockByHash', this.handleGetBlockByHash.bind(this));
        fastify.post('/getBlockByNumber', this.handleGetBlockByNumber.bind(this));
        fastify.post('/getBalance', this.handleGetBalance.bind(this));
        fastify.post('/getCode', this.handleGetCode.bind(this));
        fastify.post('/getStorage', this.handleGetStorage.bind(this));
        fastify.post('/getTransactionByBlockNumberAndIndex', this.handleGetTransactionByBlockNumberAndIndex.bind(this));
        fastify.post('/getTransactionByBlockHashAndIndex', this.handleGetTransactionByBlockHashAndIndex.bind(this));
        fastify.post('/sendTransaction', this.handleSendTransaction.bind(this));
        fastify.post('/getBlockTransactionCountByHash', this.handleGetBlockTransactionCountByHash.bind(this));
        fastify.post('/getBlockTransactionCountByNumber', this.handleGetBlockTransactionCountByNumber.bind(this));

        // Legacy POST routes for compatibility
        fastify.post('/get_blockByHash', this.handleGetBlockByHash.bind(this));
        fastify.post('/get_blockByNumber', this.handleGetBlockByNumber.bind(this));
        fastify.post('/get_balance', this.handleGetBalance.bind(this));
        fastify.post('/get_code', this.handleGetCode.bind(this));
        fastify.post('/get_storage', this.handleGetStorage.bind(this));
        fastify.post('/get_transactionByBlockNumberAndIndex', this.handleGetTransactionByBlockNumberAndIndex.bind(this));
        fastify.post('/get_transactionByBlockHashAndIndex', this.handleGetTransactionByBlockHashAndIndex.bind(this));
        fastify.post('/get_blockTransactionCountByHash', this.handleGetBlockTransactionCountByHash.bind(this));
        fastify.post('/get_blockTransactionCountByNumber', this.handleGetBlockTransactionCountByNumber.bind(this));
    }

    // Utility methods
    respondSuccess(reply, payload) {
        reply.send({
            success: true,
            payload
        });
    }

    respondError(reply, message, status = 400) {
        reply.status(status).send({
            success: false,
            payload: null,
            error: { message }
        });
    }

    async getCurrentBlockNumber() {
        try {
            const keys = await this.blockDB.keys().all();
            const blockNumbers = keys.map(key => parseInt(key)).filter(num => !isNaN(num));
            return blockNumbers.length > 0 ? Math.max(...blockNumbers) : 0;
        } catch (error) {
            return 0;
        }
    }

    // Route handlers
    async handleStatus(request, reply) {
        this.respondSuccess(reply, {
            status: "Ekehi Network RPC Server is running",
            version: "2.0.0",
            network: "Ekehi Network",
            coin: "EKH",
            timestamp: Date.now()
        });
    }

    async handleGetBlockNumber(request, reply) {
        try {
            const blockNumber = await this.getCurrentBlockNumber();
            this.respondSuccess(reply, { blockNumber });
        } catch (error) {
            this.respondError(reply, "Failed to get block number", 500);
        }
    }

    async handleGetAddress(request, reply) {
        this.respondSuccess(reply, { address: this.client.publicKey });
    }

    async handleGetMining(request, reply) {
        this.respondSuccess(reply, { mining: this.client.mining });
    }

    async handleGetWork(request, reply) {
        try {
            const currentBlockNumber = await this.getCurrentBlockNumber();
            if (currentBlockNumber === 0) {
                return this.respondError(reply, "No blocks available");
            }
            
            const latestBlock = await this.blockDB.get(currentBlockNumber.toString());
            this.respondSuccess(reply, {
                hash: latestBlock.hash,
                nonce: latestBlock.nonce,
                blockNumber: currentBlockNumber
            });
        } catch (error) {
            this.respondError(reply, "Failed to get work", 500);
        }
    }

    async handleGetNetworkStats(request, reply) {
        try {
            const currentBlockNumber = await this.getCurrentBlockNumber();
            let stateKeys = [];
            
            try {
                stateKeys = await this.stateDB.keys().all();
            } catch (e) {
                console.log('State DB error:', e.message);
            }
            
            // Calculate total transactions with better error handling
            let totalTransactions = 0;
            if (currentBlockNumber > 0) {
                // Sample recent blocks for estimation to avoid timeout
                const sampleSize = Math.min(20, currentBlockNumber);
                const startBlock = Math.max(1, currentBlockNumber - sampleSize + 1);
                
                for (let i = startBlock; i <= currentBlockNumber; i++) {
                    try {
                        const block = await this.blockDB.get(i.toString());
                        if (block && Array.isArray(block.transactions)) {
                            totalTransactions += block.transactions.length;
                        }
                    } catch (e) {
                        // Skip missing blocks
                        console.log(`Block ${i} error:`, e.message);
                    }
                }
                
                // Estimate total based on sample
                if (sampleSize < currentBlockNumber) {
                    totalTransactions = Math.round(totalTransactions * (currentBlockNumber / sampleSize));
                }
            }
            
            // Get difficulty from latest block
            let difficulty = 1;
            if (currentBlockNumber > 0) {
                try {
                    const latestBlock = await this.blockDB.get(currentBlockNumber.toString());
                    if (latestBlock && latestBlock.difficulty) {
                        difficulty = latestBlock.difficulty;
                    }
                } catch (e) {
                    console.log('Latest block error:', e.message);
                }
            }
            
            this.respondSuccess(reply, {
                totalBlocks: currentBlockNumber,
                totalTransactions,
                totalAccounts: stateKeys.length,
                networkHashRate: "Calculating...",
                difficulty
            });
        } catch (error) {
            console.log('Network stats error:', error.message);
            this.respondSuccess(reply, {
                totalBlocks: 0,
                totalTransactions: 0,
                totalAccounts: 0,
                networkHashRate: "Unknown",
                difficulty: 1
            });
        }
    }

    async handleGetBlockByHash(request, reply) {
        const { hash } = request.body?.params || {};
        
        if (!hash || typeof hash !== "string") {
            return this.respondError(reply, "Invalid request: hash parameter required");
        }

        try {
            const keys = await this.blockDB.keys().all();
            
            for (const key of keys) {
                const block = await this.blockDB.get(key);
                if (block.hash === hash) {
                    return this.respondSuccess(reply, { block });
                }
            }
            
            this.respondError(reply, "Block not found");
        } catch (error) {
            this.respondError(reply, "Failed to retrieve block", 500);
        }
    }

    async handleGetBlockByNumber(request, reply) {
        const { blockNumber } = request.body?.params || {};
        
        if (typeof blockNumber !== "number" || blockNumber < 0) {
            return this.respondError(reply, "Invalid request: valid blockNumber parameter required");
        }

        try {
            const currentBlockNumber = await this.getCurrentBlockNumber();
            
            if (blockNumber > currentBlockNumber) {
                return this.respondError(reply, "Block number too high");
            }
            
            const block = await this.blockDB.get(blockNumber.toString());
            this.respondSuccess(reply, { block });
        } catch (error) {
            this.respondError(reply, "Block not found");
        }
    }

    async handleGetBalance(request, reply) {
        const { address } = request.body?.params || {};
        
        if (!address || typeof address !== "string") {
            return this.respondError(reply, "Invalid request: address parameter required");
        }

        try {
            const stateKeys = await this.stateDB.keys().all();
            
            if (!stateKeys.includes(address)) {
                return this.respondError(reply, "Address not found");
            }
            
            const accountData = await this.stateDB.get(address);
            this.respondSuccess(reply, { balance: accountData.balance || 0 });
        } catch (error) {
            this.respondError(reply, "Failed to retrieve balance", 500);
        }
    }

    async handleGetCode(request, reply) {
        const { address } = request.body?.params || {};
        
        if (!address || typeof address !== "string") {
            return this.respondError(reply, "Invalid request: address parameter required");
        }

        try {
            const stateKeys = await this.stateDB.keys().all();
            
            if (!stateKeys.includes(address)) {
                return this.respondError(reply, "Address not found");
            }
            
            const accountData = await this.stateDB.get(address);
            this.respondSuccess(reply, { code: accountData.body || "" });
        } catch (error) {
            this.respondError(reply, "Failed to retrieve code", 500);
        }
    }

    async handleGetStorage(request, reply) {
        const { address } = request.body?.params || {};
        
        if (!address || typeof address !== "string") {
            return this.respondError(reply, "Invalid request: address parameter required");
        }

        try {
            const stateKeys = await this.stateDB.keys().all();
            
            if (!stateKeys.includes(address)) {
                return this.respondError(reply, "Address not found");
            }
            
            const accountData = await this.stateDB.get(address);
            this.respondSuccess(reply, { storage: accountData.storage || {} });
        } catch (error) {
            this.respondError(reply, "Failed to retrieve storage", 500);
        }
    }

    async handleGetTransactionByBlockNumberAndIndex(request, reply) {
        const { blockNumber, index } = request.body?.params || {};
        
        if (typeof blockNumber !== "number" || typeof index !== "number") {
            return this.respondError(reply, "Invalid request: blockNumber and index parameters required");
        }

        try {
            const currentBlockNumber = await this.getCurrentBlockNumber();
            
            if (blockNumber <= 0 || blockNumber > currentBlockNumber) {
                return this.respondError(reply, "Invalid block number");
            }
            
            const block = await this.blockDB.get(blockNumber.toString());
            
            if (index < 0 || index >= block.transactions.length) {
                return this.respondError(reply, "Invalid transaction index");
            }
            
            this.respondSuccess(reply, { transaction: block.transactions[index] });
        } catch (error) {
            this.respondError(reply, "Failed to retrieve transaction", 500);
        }
    }

    async handleGetTransactionByBlockHashAndIndex(request, reply) {
        const { hash, index } = request.body?.params || {};
        
        if (!hash || typeof hash !== "string" || typeof index !== "number") {
            return this.respondError(reply, "Invalid request: hash and index parameters required");
        }

        try {
            const keys = await this.blockDB.keys().all();
            
            for (const key of keys) {
                const block = await this.blockDB.get(key);
                if (block.hash === hash) {
                    if (index < 0 || index >= block.transactions.length) {
                        return this.respondError(reply, "Invalid transaction index");
                    }
                    return this.respondSuccess(reply, { transaction: block.transactions[index] });
                }
            }
            
            this.respondError(reply, "Block not found");
        } catch (error) {
            this.respondError(reply, "Failed to retrieve transaction", 500);
        }
    }

    async handleGetBlockTransactionCountByHash(request, reply) {
        const { hash } = request.body?.params || {};
        
        if (!hash || typeof hash !== "string") {
            return this.respondError(reply, "Invalid request: hash parameter required");
        }

        try {
            const keys = await this.blockDB.keys().all();
            
            for (const key of keys) {
                const block = await this.blockDB.get(key);
                if (block.hash === hash) {
                    return this.respondSuccess(reply, { count: block.transactions.length });
                }
            }
            
            this.respondError(reply, "Block not found");
        } catch (error) {
            this.respondError(reply, "Failed to retrieve block", 500);
        }
    }

    async handleGetBlockTransactionCountByNumber(request, reply) {
        const { blockNumber } = request.body?.params || {};
        
        if (typeof blockNumber !== "number") {
            return this.respondError(reply, "Invalid request: blockNumber parameter required");
        }

        try {
            const currentBlockNumber = await this.getCurrentBlockNumber();
            
            if (blockNumber <= 0 || blockNumber > currentBlockNumber) {
                return this.respondError(reply, "Invalid block number");
            }
            
            const block = await this.blockDB.get(blockNumber.toString());
            this.respondSuccess(reply, { count: block.transactions.length });
        } catch (error) {
            this.respondError(reply, "Failed to retrieve block", 500);
        }
    }

    async handleSendTransaction(request, reply) {
        const { transaction } = request.body?.params || {};
        
        if (!transaction || typeof transaction !== "object") {
            return this.respondError(reply, "Invalid request: transaction parameter required");
        }

        try {
            this.respondSuccess(reply, { message: "Transaction received and queued for processing" });
            await this.transactionHandler(transaction);
        } catch (error) {
            console.error("Transaction handling error:", error);
            // Don't change the response since we already sent success
        }
    }

    start() {
        return new Promise((resolve, reject) => {
            fastify.listen({ port: this.PORT, host: 'localhost' }, (err, address) => {
                if (err) {
                    console.error("RPC Server Error:", err);
                    reject(err);
                } else {
                    console.log(`LOG :: Ekehi Network RPC Server running on ${address}`);
                    resolve(address);
                }
            });
        });
    }
}

// Export function for backwards compatibility
function rpc(PORT, client, transactionHandler, stateDB, blockDB) {
    const server = new RPCServer(PORT, client, transactionHandler, stateDB, blockDB);
    
    // Handle uncaught exceptions
    process.on("uncaughtException", err => {
        console.error("RPC Uncaught Exception:", err);
    });
    
    server.start().catch(err => {
        console.error("Failed to start RPC server:", err);
        process.exit(1);
    });
    
    return server;
}

module.exports = rpc;
