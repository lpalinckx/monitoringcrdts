const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const net = require('net');
const { Docker } = require('node-docker-api');



// Docker image to use
const IMAGE = 'luat'

// Keep track of the keys of all the nodes and links in the diagram
const nodeKeys = [];
const netNodeKeys = [];
const networkKeys = [];
// Keys of the links that do not create a network (= are connected to a network node)
const nonNetworkLinksKeys = [];
const nonNetworkLinks = {};

// Whenever a node is disconnected from a network, 
// we need to keep track of what networks it was connected to, 
// to make sure it is able to reconnect to the networks.
const networkConnections = {};

// Docker setup
const docker = new Docker({ socketPath: '/var/run/docker.sock' });

/**
 * "client"   : socket
 * "enabled"  : if the container is running 
 * "connected": is the container connected
 * "ip"       : ip address
 * "port"     : port
 * "list"     : list of items in the set
 */
const nodes = {}

let APPLICATIONPORT = 5678;


// =================
//  LuAT connection
// =================

function b64encode(str) {
    let buff = new Buffer(str);
    return buff.toString('base64');
}

function makeRPCCommand(cmd, args) {
    let payload = JSON.stringify({
        key: cmd,
        args: args
    });

    return b64encode("JSN" + payload) + "\n";
}

function doRPCCommand(client, cmd, args) {
    client.write(makeRPCCommand(cmd, args || []));
}

const promisifyStream = (stream) => new Promise((resolve, reject) => {
    stream.on('data', (d) => console.log(d.toString()))
    stream.on('end', resolve)
    stream.on('error', reject)
})

// =====================
//  Creating containers 
//  -------------------
//    Nodes & networks
// =====================

/**
 * Creates a container for a node 
 * 
 * @param {String} key 
 */
async function createNode(key) {
    nodeKeys.push(key);
    let containerName = 'node' + key;
    let container;
    // Create new Docker container
    try {
        container = await (docker.container.create({
            Image: IMAGE,
            name: containerName,
            Cmd: ['tail', '-f', '/dev/null'],
            "HostConfig": {
                "Mounts": [
                    {
                        "Target": "/luat",
                        "Source": "luatVolume",
                        "Type": "volume",
                        "ReadOnly": false
                    }
                ]
            },
            "WorkingDir": "/luat"
        }))

        // Start the container
        await container.start();

        let p = APPLICATIONPORT.toString();

        // Start LuAT
        let luat = await container.exec.create({
            AttachStdout: true,
            AttachStderr: true,
            Cmd: ['lua', 'nswitchboard.lua', 'test_orset_rpc.lua', p]
        })

        let output = await luat.start({ Detach: false });
        promisifyStream(output);

        // Connect
        await sleep(2000);
        let IP = (await container.status()).data.NetworkSettings.IPAddress;

        let client = new net.Socket();
        connectClient(client, APPLICATIONPORT, IP, containerName);
        APPLICATIONPORT++;
        console.log('New container created: ' + containerName);
    } catch (error) {
        console.log(error)
    }
    // Return container
    return container
}

function sleep(ms) {
    return new Promise(reslove => setTimeout(reslove, ms));
}

function connectClient(client, port, ip, containerName) {
    console.log(`Connecting ${containerName} to ${ip}:${port}`);
    client.connect(port, ip, () => {
        client.write("HELLO\n");
        client.write("RPC\n");
        doRPCCommand(client, 'register');
        doRPCCommand(client, 'update');
    })

    client.on('data', data => {
        console.log(`${containerName} received: ${data}`)
        let list = JSON.parse(data);
        pushItem(containerName, list); 
    })

    client.on('close', () => {
        console.log(`${containerName} closed connection to LuAT`);
    })

    nodes[containerName] = {
        "client": client,
        "enabled": true,
        "connected": true,
        "ip": ip,
        "port": port,  
        "list": [], 
    }
}

/**
 * Creates a docker network
 * Connects all the nodes passed in linkedContainers to the new network
 * isNode: true = network node
 * isNode: false = regular node
 * @param {String} key 
 * @param {Array} linkedContainers 
 * @param {Boolean} isNode 
 * @returns Created network 
 */
async function createNetwork(key, linkedContainers, isNode) {
    (isNode) ? netNodeKeys.push(key) : networkKeys.push(key);
    let name = (isNode) ? 'networkNode' : 'network';
    let containerName = name + key;
    // Create new network
    const net = await (docker.network.create({
        name: containerName,
        Driver: "bridge"
    }));

    console.log(`New network ${(isNode) ? "node " : ""} created: ${containerName}`);

    // Link the containers to the network
    for (let container of linkedContainers) {
        try {
            net.connect({ Container: container.id })
            console.log(`Connected a container to ${containerName}`);
        } catch (error) {
            console.log(error)
        }
    }

    // Return container
    return net;
}

/**
 * Creates the containers for all the new nodes in the network
 * @param {Object[]} nodeProps 
 */
async function createNodes(nodeProps) {
    for (let props of nodeProps) {
        let key = props.key;
        await createNode(key);
    }
}

/**
 * Creates links in bulk, the links are passed as objects in an array.
 * The objects contain the key of the link and the from and to node
 * Links to network nodes do not create a new network, but simply link the node to the network
 * @param {Object[]} fromTo 
 */
async function createNetworks(fromTo) {
    for (let link of fromTo) {
        let from = link.from;
        let to = link.to;
        let key = link.key;
        // Check if the link is connected to a network node,
        // if so it doesn't need to create a new network but rather link the node to the network node
        if (isLinkToNetNode(from, to)) {
            // Link is connected to a network node 
            try {
                let net = (isNetworkNode(from) ? fetchNetwork(from, true) : fetchNetwork(to, true))
                let node = (isNetworkNode(from) ? fetchNode(to) : fetchNode(from))

                net.connect({ Container: node.id })

                nonNetworkLinksKeys.push(key);
                nonNetworkLinks[key] = { "from": from, "to": to };
            } catch (error) {
                console.log(error)
            }
        } else {
            // Not connected to a network node, so it is a link connected between 2 regular nodes 
            await createNetwork(key, [fetchNode(from), fetchNode(to)], false);
        }
    }
}

async function createNetworkNode(nodes) {
    for (netNode of nodes) {
        await createNetwork(netNode.key, [], true);
    }
}

// ================
//  Set operations
// ================

/**
 * Pushes item(s) to the list of the node 
 */
function pushItem(node, items){
    let empty = []; 
    for(item of items){
        empty.push(item)
    }
    nodes[node].list = empty; 
}

function addItem(item, key) {
    let name = "node" + key;
    let node = nodes[name]; 
    let client = node.client;
    let lst = node.list; 
    console.log(typeof lst);
    lst.push(item); 
    nodes[name].list = lst;
    doRPCCommand(client, 'add', [item]);
}

function removeItem(item, key) {
    let name = "node" + key;
    let node = nodes[name];
    let client = node.client;
    let list = node.list; 
    const idx = list.indexOf(item); 
    node.list = list.splice(idx, 1); 
    doRPCCommand(client, 'remove', [item]);
}

function returnList(nodeName){
    let node = nodes[nodeName]
    return node.list; 
}

// =====================
//  Deleting containers
// =====================

/**
 * Stops and deletes the container, key is removed from the array 
 * @param {String} key - key of the node to delete
 */
async function deleteNode(key) {
    let container = fetchNode(key);
    let name = 'node' + key;
    try {
        await container.stop();
        await container.delete();
        console.log(`Removed ${name}`);
    } catch (error) {
        console.log(error)
    }
    let idx = nodeKeys.indexOf(key);
    if (idx > -1) {
        nodeKeys.splice(idx, 1);
    }
}

/**
 * Removes a network
 * It first disconnects all connected containers, then the network is removed 
 * @param {String} key 
 * @param {Boolean} isNode - True = network node, False = regular link
 */
async function deleteNetwork(key, isNode) {
    let network = fetchNetwork(key, isNode);
    let name;
    try {
        let status = await network.status();
        name = status.data.Name;
        // Ids of the connected nodes to this network
        let clientIds = Object.keys(status.data.Containers);
        for (id of clientIds) {
            // disconnect all the connected nodes 
            await network.disconnect({ Container: id });
        }
        // Remove the network
        await network.remove()
        console.log(`Removed ${name}`);
    } catch (error) {
        console.log(error)
    }
    // Remove key from the array
    let arr = (isNode ? netNodeKeys : networkKeys)
    let idx = arr.indexOf(key);
    if (idx > -1) {
        arr.splice(idx, 1);
    }
}

/**
 * Removes a link between a network node and a node
 * Used whenever the link is removed, but the network node itself isn't removed
 * Disconnects the connected node from the network
 * @param {String} key 
 */
async function disconnectSingle(key) {
    let net = nonNetworkLinks[key];
    let from = net.from;
    let to = net.to;
    try {
        let netNode = fetchNetwork((isNetworkNode(from) ? from : to), true)
        let node = fetchNode((isNetworkNode(from) ? to : from))
        await netNode.disconnect({ Container: node.id });
    } catch (error) {
        console.log(error)
    }
    delete nonNetworkLinks[key];
    let idx = nonNetworkLinksKeys.indexOf(nonNetwork);
    nonNetworkLinksKeys.splice(idx, 1);
}

// =========================
//  Manipulating containers
//  -----------------------
//    Enabling/Disabling, 
//   disconnect/reconnect
// =========================

/**
 * Unpause container
 * @param {String} key 
 */
async function enableContainer(key) {
    try {
        let name = "node" + key;
        let container = fetchNode(key);
        let paused = (await container.status()).data.State.Paused
        if (paused) {
            await container.unpause();
            console.log(`Unpaused ${name}`);
            nodes[name].enabled = true;
        } else {
            console.log(`Node${key} is not paused`);
        }
    } catch (error) {
        console.log(error);
    }

}

/**
 * Pause container
 * @param {String} key 
 */
async function disableContainer(key) {
    try {
        let name = "node" + key;
        let container = fetchNode(key);
        let running = (await container.status()).data.State.Running
        if (running) {
            await container.pause();
            console.log(`Disabled ${name}`);
            nodes[name].enabled = false;
        } else {
            console.log(`Node${key} is already paused or not running`)
        }
    } catch (error) {
        console.log(error);
    }

}

/**
 * Disconnect the node from the networks
 * @param {String} key 
 */
async function disconnectNode(key) {
    let node = fetchNode(key);
    let containerId = (await node.status()).data.Id;
    let connections = connectedTo(key);

    networkConnections[node.id] = connections;
    try {
        console.log(`Disconnecting ${node.id} from network(s): `)
        for (n of connections) {
            n.disconnect({ Container: containerId });
            console.log(n.id);
        }
        nodes[node.id].connected = false;
    } catch (error) {
        console.log(error)
    }

}

/**
 * Reconnect the node to the previously disconnected networks
 * @param {String} key 
 */
async function reconnectNode(key) {
    let node = fetchNode(key);
    let containerId = (await node.status()).data.Id;
    let prevConnections = networkConnections[node.id];
    try {
        console.log(`Reconnecting ${node.id} to network(s): `)
        for (n of prevConnections) {
            n.connect({ Container: containerId });
            console.log(n.id);
        }
        nodes[node.id].connected = true;
    } catch (error) {
        console.log(error)
    }
}

// ==================
//  Small operations
// ==================

/**
 * Returns the container of the node 
 * @param {String} key 
 */
function fetchNode(key) {
    let nameToFind = 'node' + key;
    return docker.container.get(nameToFind)
}

/**
 * Returns the network container 
 * @param {String} key 
 * @param {Boolean} isNode - true = network node, false = regular network
 */
function fetchNetwork(key, isNode) {
    let name = (isNode ? 'networkNode' : 'network');
    let nameToFind = name + key;
    return docker.network.get(nameToFind)
}

/**
 * Checks if the given key is the key of a network node
 * @param {String} key 
 */
function isNetworkNode(key) {
    return (netNodeKeys.includes(key))
}

/**
 * Returns if either from or to is a network node 
 * @param {String} from 
 * @param {String} to 
 */
function isLinkToNetNode(from, to) {
    return (isNetworkNode(from) || isNetworkNode(to))
}

/**
 * 
 * @param {String} key 
 * @returns {Array} Array of networks to which the container is connected
 */
async function connectedTo(key) {
    let node = fetchNode(key);
    let status = await node.status();
    let id = status.data.Id;

    let connections = []
    for (netKey of networkKeys) {
        let network = fetchNetwork(netKey, false);
        let status = await network.status();
        let keys = Object.keys(status.data.Containers);
        if (keys.includes(id)) {
            connections.push(network);
        }
    }
    return connections;
}

function exists(nodeName) {
    let node = nodes[nodeName];
    return (typeof node != 'undefined');
}

// ================
//  Main operation 
// ================

/**
 * Handles whenever there is a new save
 * new nodes, networks and network node are created 
 * Nodes that are absent in the diagram and still have active containers, are removed.
 * @param {JSON} diagram 
 */
async function handleSave(diagram) {
    console.log('\n======= Diagram saved ======= ')
    // Gets the nodes out of the diagram and immediatly filter out the network nodes
    const nodes = (diagram.nodeDataArray).filter(node => !(node.figure === "Border"));
    const links = (diagram.linkDataArray)
    const netNodes = (diagram.nodeDataArray).filter(node => (node.figure === "Border"))

    // Filter out the new nodes
    const newNodes = nodes.filter(node => !nodeKeys.includes(node.key));
    const newLinks = links.filter(link => !networkKeys.includes(link.key) && !nonNetworkLinksKeys.includes(link.key));
    const newNetNodes = netNodes.filter(node => !netNodeKeys.includes(node.key));

    // Filter out the missing ones
    const missingNodes = nodeKeys.filter(k => !(nodes.map(n => n.key).includes(k)));
    const missingLinks = networkKeys.filter(k => {
        let keys = links.map(l => l.key);
        return (!keys.includes(k))
    })
    // nonNetworks are links between a node and a network node 
    const missingNonNetworks = nonNetworkLinksKeys.filter(k => !(links.map(l => l.key).includes(k)));
    const missingNetNodes = netNodeKeys.filter(k => !(netNodes.map(n => n.key).includes(k)));

    // Keys of the nodes in the diagram
    const nodeProps = newNodes.map((node) => {
        return {
            "key": node.key
        }
    });

    // From and To nodes for each link
    const fromTo = newLinks.map(link => {
        return {
            "from": link.from,
            "to": link.to,
            "key": link.key
        }
    });

    // Network nodes
    const nets = newNetNodes.map((netNode) => {
        return {
            "key": netNode.key
        }
    })

    // Delete removed networks
    for (networkKey of missingLinks) {
        await deleteNetwork(networkKey, false);
    }

    // Delete links between nodes and network nodes
    // Needed when the link is removed, but not the network node itself
    for (nonNetwork of missingNonNetworks) {
        console.log(`Removing nonnetwork ${nonNetwork}`)
        await disconnectSingle(nonNetwork);
    }

    // Delete removed network nodes 
    for (netNodeKey of missingNetNodes) {
        await deleteNetwork(netNodeKey, true)
    }

    // Delete removed nodes
    for (nodeKey of missingNodes) {
        console.log(`Removing node${nodeKey}...`)
        await deleteNode(nodeKey);
    }

    // Create nodes
    await createNodes(nodeProps);

    // Create network nodes
    await createNetworkNode(nets);

    // Create links
    await createNetworks(fromTo);

    io.emit('allDone');
}

// =============== 
//  Webpage setup
// ===============
const PORT = 3000;

app.use(express.static('src/public'));

app.get('/', (req, res) => {
    res.sendFile(__dirname + '/public/html/index.html');
    console.log(`Using docker image: ${IMAGE}`);
})

io.on('connection', (socket) => {
    socket.on("saved", (diagramJson) => { handleSave(diagramJson) });
    socket.on("nodeClicked", () => console.log('received click'));
    socket.on("toggleContainer", (key, evt) => {
        let proc = (evt == 'enable' ? enableContainer : disableContainer)
        proc(key);
    });
    socket.on("disconnectContainer", (key) => disconnectNode(key));
    socket.on("reconnectContainer", (key) => reconnectNode(key));
    socket.on("reqImage", (ret) => ret(IMAGE));
    socket.on("reqState", (name, ret) => {
        if (exists(name)) {
            let node = nodes[name]; 
            ret(node.enabled, node.connected, node.ip, node.port);
        } else ret();

    });

    // Set manipulation
    socket.on("addItem", (item, key) => addItem(item, key));
    socket.on("removeItem", (item, key) => removeItem(item, key));
    socket.on("reqList", async (nodeName, ret) => {
        if (exists(nodeName)) {
            let lst = returnList(nodeName);
            ret(lst);
        } else ret();
    })
})


http.listen(PORT, () => {
    console.log("Listening on port " + PORT);
})