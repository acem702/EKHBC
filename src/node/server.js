"use strict";

const crypto = require("crypto"), SHA256 = message => crypto.createHash("sha256").update(message).digest("hex");
const WS = require("ws");
const EC = require("elliptic").ec, ec = new EC("secp256k1");
const { Level } = require('level');
const { fork } = require("child_process");

const Block = require("../core/block");
const Transaction = require("../core/transaction");
const changeState = require("../core/state");
const { BLOCK_REWARD, BLOCK_GAS_LIMIT } = require("../config.json");
const { produceMessage, sendMessage } = require("./message");
const generateGenesisBlock = require("../core/genesis");
const addTransaction = require("../core/txPool");
const rpc = require("../rpc/rpc");
const TYPE = require("./message-types");
const { verifyBlock, updateDifficulty } = require("../consensus/consensus");
const { parseJSON } = require("../utils/utils");

const MINT_PRIVATE_ADDRESS = "0000000000000000000000000000000000000000000000000000000000000001";
const MINT_KEY_PAIR = ec.keyFromPrivate(MINT_PRIVATE_ADDRESS, "hex");
const MINT_PUBLIC_ADDRESS = MINT_KEY_PAIR.getPublic("hex");

const opened    = [];  // Addresses and sockets from connected nodes.
const connected = [];  // Addresses from connected nodes.

let worker = fork(`${__dirname}/../miner/worker.js`); // Worker thread (for PoW mining).
let mined = false; // This will be used to inform the node that another node has already mined before it.

const chainInfo = {
    transactionPool: [],
    latestBlock: generateGenesisBlock(), 
    latestSyncBlock: null,
    difficulty: 1
};

const stateDB = new Level(__dirname + "/../log/stateStore", { valueEncoding: "json" });
const blockDB = new Level(__dirname + "/../log/blockStore", { valueEncoding: "json" });

async function startServer(options) {
    const PORT                 = options.PORT || 3000;                        // Node's PORT
    const RPC_PORT             = options.RPC_PORT || 5000;                    // RPC server's PORT
    const PEERS                = options.PEERS || [];                         // Peers to connect to
    const MY_ADDRESS           = options.MY_ADDRESS || "ws://localhost:3000"; // Node's address
    const ENABLE_MINING        = options.ENABLE_MINING ? true : false;        // Enable mining?
    const ENABLE_LOGGING       = options.ENABLE_LOGGING ? true : false;       // Enable logging?
    const ENABLE_RPC           = options.ENABLE_RPC ? true : false;           // Enable RPC server?
    let   ENABLE_CHAIN_REQUEST = options.ENABLE_CHAIN_REQUEST ? true : false; // Enable chain sync request?

    const privateKey = options.PRIVATE_KEY || ec.genKeyPair().getPrivate("hex");
    const keyPair = ec.keyFromPrivate(privateKey, "hex");
    const publicKey = keyPair.getPublic("hex");

    process.on("uncaughtException", err => console.log("LOG ::", err));

    const server = new WS.Server({ port: PORT });

    console.log("LOG :: Listening on PORT", PORT);

    server.on("connection", async (socket, req) => {
        // Message handler
        socket.on("message", async message => {
            const _message = parseJSON(message); // Parse binary message to JSON

            switch (_message.type) {
                // Below are handlers for every message types.

                case TYPE.NEW_BLOCK:
                    // "TYPE.NEW_BLOCK" is sent when someone wants to submit a new block.
                    // Its message body must contain the new block and the new difficulty.

                    const newBlock = _message.data;

                    // We will only continue checking the block if its parentHash is not the same as the latest block's hash.
                    // This is because the block sent to us is likely duplicated or from a node that has lost and should be discarded.

                    if (
                        newBlock.parentHash !== chainInfo.latestBlock.parentHash &&
                        (!ENABLE_CHAIN_REQUEST || (ENABLE_CHAIN_REQUEST && currentSyncBlock > 1))
                        // Only proceed if syncing is disabled or enabled but already synced at least the genesis block
                    ) {
                        if (await verifyBlock(newBlock, chainInfo, stateDB)) {
                            console.log("LOG :: New block received.");

                            // If mining is enabled, we will set mined to true, informing that another node has mined before us.
                            if (ENABLE_MINING) {
                                mined = true;

                                // Stop the worker thread
                                worker.kill();

                                worker = fork(`${__dirname}/../miner/worker.js`);
                            }

                            await updateDifficulty(newBlock, chainInfo, blockDB); // Update difficulty

                            await blockDB.put(newBlock.blockNumber.toString(), newBlock); // Add block to chain

                            chainInfo.latestBlock = newBlock; // Update chain info

                            await changeState(newBlock, stateDB, ENABLE_LOGGING); // Transist state

                            // Update the new transaction pool (remove all the transactions that are no longer valid).
                            const newTransactionPool = [];

                            for (const tx of chainInfo.transactionPool) {
                                if (await Transaction.isValid(tx, stateDB)) newTransactionPool.push(tx);
                            }

                            chainInfo.transactionPool = newTransactionPool;

                            console.log(`LOG :: Block #${newBlock.blockNumber} synced, state transisted.`);

                            sendMessage(produceMessage(TYPE.NEW_BLOCK, newBlock), opened); // Broadcast block to other nodes

                            if (ENABLE_CHAIN_REQUEST) {
                                ENABLE_CHAIN_REQUEST = false;
                            }
                        }
                    }

                    break;
                
                case TYPE.CREATE_TRANSACTION:
                    if (!ENABLE_CHAIN_REQUEST) { // Unsynced nodes should not be able to proceed
                        // TYPE.CREATE_TRANSACTION is sent when someone wants to submit a transaction.
                        // Its message body must contain a transaction.

                        // Transactions are added into "chainInfo.transactions", which is the transaction pool.
                        // To be added, transactions must be valid, and they are valid under these criterias:
                        // - They are valid based on Transaction.isValid
                        // - The balance of the sender is enough to make the transaction (based on his transactions in the pool).
                        // - Its timestamp are not already used.

                        const transaction = _message.data;

                        if (!(await Transaction.isValid(transaction, stateDB))) break;

                        // Get public key and address from sender
                        const txSenderPubkey = Transaction.getPubKey(transaction);
                        const txSenderAddress = SHA256(txSenderPubkey);

                        if (!(await stateDB.keys().all()).includes(txSenderAddress)) break;

                        // After transaction is added, the transaction must be broadcasted to others since the sender might only send it to a few nodes.
        
                        // This is pretty much the same as addTransaction, but we will send the transaction to other connected nodes if it's valid.

                        const dataFromSender = await stateDB.get(txSenderAddress); // Fetch sender's state object
                        const senderBalance = dataFromSender.balance; // Get sender's balance
                        
                        let balance = BigInt(senderBalance) - BigInt(transaction.amount) - BigInt(transaction.gas) - BigInt(transaction.additionalData.contractGas || 0);
        
                        chainInfo.transactionPool.forEach(tx => {
                            const _txSenderPubkey = Transaction.getPubKey(tx);
                            const _txSenderAddress = SHA256(_txSenderPubkey);

                            if (_txSenderAddress === txSenderAddress) {
                                balance -= BigInt(tx.amount) + BigInt(tx.gas) + BigInt(transaction.additionalData.contractGas || 0);
                            }
                        });
        
                        if (
                            balance >= 0 && 
                            !chainInfo.transactionPool.filter(_tx => SHA256(Transaction.getPubKey(_tx)) === txSenderAddress).some(_tx => _tx.timestamp === transaction.timestamp)
                        ) {
                            console.log("LOG :: New transaction received and added to pool.");
        
                            chainInfo.transactionPool.push(transaction);
                            // Broadcast the transaction
                            sendMessage(produceMessage(TYPE.CREATE_TRANSACTION, transaction), opened);
                        }
                    }
    
                    break;

                case TYPE.REQUEST_BLOCK:
                    if (!ENABLE_CHAIN_REQUEST) { // Unsynced nodes should not be able to send blocks
                        const { blockNumber, requestAddress } = _message.data;

                        const socket = opened.find(node => node.address === requestAddress).socket; // Get socket from address

                        const currentBlockNumber = Math.max(...(await blockDB.keys().all()).map(key => parseInt(key))); // Get latest block number

                        if (blockNumber > 0 && blockNumber <= currentBlockNumber) { // Check if block number is valid
                            const block = await blockDB.get( blockNumber.toString() ); // Get block

                            socket.send(produceMessage(TYPE.SEND_BLOCK, block)); // Send block
                        
                            console.log(`LOG :: Sent block at position ${blockNumber} to ${requestAddress}.`);
                        }
                    }
    
                    break;
                
                case TYPE.SEND_BLOCK:
                    const block = _message.data;

                    if (ENABLE_CHAIN_REQUEST && currentSyncBlock === block.blockNumber) {
                        if (
                            chainInfo.latestSyncBlock === null // If latest synced block is null then we immediately add the block into the chain without verification.
                            ||                                 // This happens due to the fact that the genesis block can discard every possible set rule ¯\_(ツ)_/¯
                            await verifyBlock(block, chainInfo, stateDB)
                        ) {
                            currentSyncBlock += 1;

                            await blockDB.put(block.blockNumber.toString(), block); // Add block to chain.
                    
                            if (!chainInfo.latestSyncBlock) {
                                chainInfo.latestSyncBlock = block; // Update latest synced block.
                            }

                            chainInfo.latestBlock = block; // Update latest block.
            
                            await changeState(block, stateDB); // Transist state

                            await updateDifficulty(block, chainInfo, blockDB); // Update difficulty.

                            console.log(`LOG :: Synced block at position ${block.blockNumber}.`);

                            // Continue requesting the next block
                            for (const node of opened) {
                                node.socket.send(
                                    produceMessage(
                                        TYPE.REQUEST_BLOCK,
                                        { blockNumber: currentSyncBlock, requestAddress: MY_ADDRESS }
                                    )
                                );

                                await new Promise(r => setTimeout(r, 5000)); // Delay for block verification
                            }
                        }
                    }

                    break;
                
                case TYPE.HANDSHAKE:
                    const address = _message.data;

                    connect(MY_ADDRESS, address);
            }
        });
    });

    if (!ENABLE_CHAIN_REQUEST) {
        if ((await blockDB.keys().all()).length === 0) {
            await blockDB.put(chainInfo.latestBlock.blockNumber.toString(), chainInfo.latestBlock);
    
            await changeState(chainInfo.latestBlock, stateDB);
        } else {
            chainInfo.latestBlock = await blockDB.get( Math.max(...(await blockDB.keys().all()).map(key => parseInt(key))).toString() );
            chainInfo.difficulty = chainInfo.latestBlock.difficulty;
        }
    }

    PEERS.forEach(peer => connect(MY_ADDRESS, peer)); // Connect to peerss

    // Sync chain
    let currentSyncBlock = 1;

    if (ENABLE_CHAIN_REQUEST) {
        const blockNumbers = await blockDB.keys().all();

        if (blockNumbers.length !== 0) {
            currentSyncBlock = Math.max(...blockNumbers.map(key => parseInt(key)));
        }

        setTimeout(async () => {
            for (const node of opened) {
                node.socket.send(
                    produceMessage(
                        TYPE.REQUEST_BLOCK,
                        { blockNumber: currentSyncBlock, requestAddress: MY_ADDRESS }
                    )
                );

                await new Promise(r => setTimeout(r, 5000)); // Delay for block verification
            }
        }, 5000);
    }

    if (ENABLE_MINING) loopMine(publicKey, ENABLE_CHAIN_REQUEST, ENABLE_LOGGING);
    if (ENABLE_RPC) rpc(RPC_PORT, { publicKey, mining: ENABLE_MINING }, sendTransaction, stateDB, blockDB);
}

// Function to connect to a node.
function connect(MY_ADDRESS, address) {
    if (!connected.find(peerAddress => peerAddress === address) && address !== MY_ADDRESS) {
        const socket = new WS(address); // Get address's socket.

        // Open a connection to the socket.
        socket.on("open", async () => {
            for (const _address of [MY_ADDRESS, ...connected]) socket.send(produceMessage(TYPE.HANDSHAKE, _address));
            for (const node of opened) node.socket.send(produceMessage(TYPE.HANDSHAKE, address));

            // If the address already existed in "connected" or "opened", we will not push, preventing duplications.
            if (!opened.find(peer => peer.address === address) && address !== MY_ADDRESS) {
                opened.push({ socket, address });
            }

            if (!connected.find(peerAddress => peerAddress === address) && address !== MY_ADDRESS) {
                connected.push(address);

                console.log(`LOG :: Connected to ${address}.`);

                // Listen for disconnection, will remove them from "opened" and "connected".
                socket.on("close", () => {
                    opened.splice(connected.indexOf(address), 1);
                    connected.splice(connected.indexOf(address), 1);

                    console.log(`LOG :: Disconnected from ${address}.`);
                });
            }
        });
    }

    return true;
}

// Function to broadcast a transaction.
async function sendTransaction(transaction) {
    sendMessage(produceMessage(TYPE.CREATE_TRANSACTION, transaction), opened);

    console.log("LOG :: Sent one transaction.");

    await addTransaction(transaction, chainInfo.transactionPool, stateDB);
}

function mine(publicKey, ENABLE_LOGGING) {
    function mine(block, difficulty) {
        return new Promise((resolve, reject) => {
            worker.addListener("message", message => resolve(message.result));

            worker.send({ type: "MINE", data: [block, difficulty] }); // Send a message to the worker thread, asking it to mine.
        });
    }

    // Collect a list of transactions to mine
    const transactionsToMine = [];
    let totalContractGas = 0n, totalTxGas = 0n;

    for (const tx of chainInfo.transactionPool) {
        if (totalContractGas + BigInt(tx.additionalData.contractGas || 0) >= BigInt(BLOCK_GAS_LIMIT)) break;

        transactionsToMine.push(tx);

        totalContractGas += BigInt(tx.additionalData.contractGas || 0);
        totalTxGas += BigInt(tx.gas) + BigInt(tx.additionalData.contractGas || 0);
    }

    // Mint transaction for miner's reward.
    const rewardTransaction = new Transaction(SHA256(publicKey), (BigInt(BLOCK_REWARD) + totalTxGas).toString());
    Transaction.sign(rewardTransaction, MINT_KEY_PAIR);

    // Create a new block.
    const block = new Block(
        chainInfo.latestBlock.blockNumber + 1, 
        Date.now(), 
        [rewardTransaction, ...transactionsToMine], 
        chainInfo.difficulty, 
        chainInfo.latestBlock.hash
    );

    // Mine the block.
    mine(block, chainInfo.difficulty)
        .then(async result => {
            // If the block is not mined before, we will add it to our chain and broadcast this new block.
            if (!mined) {
                await updateDifficulty(result, chainInfo, blockDB); // Update difficulty

                await blockDB.put(result.blockNumber.toString(), result); // Add block to chain

                chainInfo.latestBlock = result; // Update chain info

                await changeState(chainInfo.latestBlock, stateDB, ENABLE_LOGGING); // Transist state

                // Update the new transaction pool (remove all the transactions that are no longer valid).
                const newTransactionPool = [];

                for (const tx of chainInfo.transactionPool) {
                    if (await Transaction.isValid(tx, stateDB)) newTransactionPool.push(tx);
                }
                
                chainInfo.transactionPool = newTransactionPool;

                sendMessage(produceMessage(TYPE.NEW_BLOCK, chainInfo.latestBlock), opened); // Broadcast the new block

                console.log(`LOG :: Block #${chainInfo.latestBlock.blockNumber} mined and synced, state transisted.`);
            } else {
                mined = false;
            }

            // Re-create the worker thread
            worker.kill();

            worker = fork(`${__dirname}/../miner/worker.js`);
        })
        .catch(err => console.log(err));
}

// Function to mine continuously
function loopMine(publicKey, ENABLE_CHAIN_REQUEST, ENABLE_LOGGING, time = 1000) {
    let length = chainInfo.latestBlock.blockNumber;
    let mining = true;

    setInterval(() => {
        if (mining || length !== chainInfo.latestBlock.blockNumber) {
            mining = false;
            length = chainInfo.latestBlock.blockNumber;

            if (!ENABLE_CHAIN_REQUEST) mine(publicKey, ENABLE_LOGGING);
        }
    }, time);
}

module.exports = { startServer };