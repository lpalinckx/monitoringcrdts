const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const net = require('net');
const fs = require('fs')
const path = require('path')
const { Docker } = require('node-docker-api');

// Applications
const plugins = require('./plugins').plugins
const validLoads = Object.keys(plugins).filter(e => e != "general")

// TODO 
// Apply net changes to container!

// Docker image to use
const IMAGE = plugins.general["docker-image"];

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
const networkContainerCache = {};

// Nodes that have not yet started running an application
const unloadedNodes = [];

// Docker setup
const docker = new Docker({ socketPath: '/var/run/docker.sock' });

const diagramPath = __dirname + '/public/data/diagram.json';

// Indicates whether an application is loaded 
let appStarted = false;
let APP = 'test_orset_rpc.lua'
let APPLICATIONPORT = 5678;

/**
 * Initialize the network to connect containers to
 * Prevents containers to connect to default bridge network & communicate
 */
async function init() {
    let icc;
    try {
        icc = await (docker.network.get("noCommsNet")).status();
    } catch (error) { }

    if (typeof icc == 'undefined') {
        n = await docker.network.create({
            name: "noCommsNet",
            Driver: "bridge",
            Options: {
                "com.docker.network.bridge.enable_icc": "false",
            }
        });
    }
}
let icc = init();

/**
 * "client"   : socket
 * "enabled"  : if the container is running 
 * "connected": is the container connected
 * "internet" : {
 *      "ip",
 *      "port",
 *      "dns",
 *      "gateway",
 *      "hostname"
 *  }
 */
const nodes = {}

/**
 * "connected" : if the network is online
 */
const networks = {}

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

    try {
        container = await (docker.container.get(containerName)).status();
    } catch (error) { }

    if (typeof container != 'undefined') {
        console.log('Container with the same name found; Removing dupe');
        await container.stop();
        await container.delete();
        console.log("Removed dupe!");
    }

    // Create new Docker container
    try {
        console.log("Starting create");
        container = await (docker.container.create({
            Image: IMAGE,
            name: containerName,
            Cmd: ['tail', '-f', '/dev/null'],
            "HostConfig": {
                "NetworkMode": "noCommsNet",
                "Mounts": [
                    {
                        "Target": "/luat",
                        "Source": "luatVolume",
                        "Type": "volume",
                        "ReadOnly": false
                    }
                ]
            },
            "WorkingDir": "/luat",
        }))

        // Start the container
        await container.start();

        // Connect
        let status = await container.status();
        let networkSettings = status.data.NetworkSettings.Networks["noCommsNet"]
        let cfg = status.data.Config;

        let ip = networkSettings.IPAddress;
        let port = APPLICATIONPORT;
        let dns = cfg.Domainname;
        let gateway = networkSettings.Gateway;
        let hostname = cfg.Hostname;

        let client = new net.Socket();

        APPLICATIONPORT++;

        let internetOpts = {
            "ip": ip,
            "port": port,
            "dns": dns,
            "gateway": gateway,
            "hostname": hostname
        }

        nodes[containerName] = {
            "client": client,
            "enabled": true,
            "connected": true,
            "internet": internetOpts
        }

        if (appStarted) {
            console.log('app started, loading app');
            startApplication(key)
        } else {
            console.log('app not started, pushing key');
            unloadedNodes.push(key);
        }

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

async function connectClient(port, ip, key) {
    let containerName = "node" + key;
    let client = nodes[containerName].client;
    console.log(`Connecting ${containerName} to ${ip}:${port}`);
    await client.connect(port, ip, () => {
        client.write("HELLO\n");
        client.write("RPC\n");
        doRPCCommand(client, 'register');
        doRPCCommand(client, 'update');
    })

    client.on('data', data => {
        console.log(`${containerName} received: ${data}`)
        let list = JSON.parse(data);
        let app = plugins[appStarted];
        app.update(containerName, list);
    })

    client.on('close', () => {
        console.log(`${containerName} closed connection to LuAT`);
    })
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

    // Check for dupe
    let exists;
    try {
        exists = await docker.network.get(containerName).status();
    } catch (error) { }

    if (typeof exists != 'undefined') {
        await exists.remove();
    }

    // Create new network
    const net = await (docker.network.create({
        name: containerName,
        Driver: "bridge",
        Options: {
            "com.docker.network.bridge.enable_icc": "true",
        },
    }));

    console.log(`New network ${(isNode) ? "node " : ""} created: ${containerName}`);

    // Link the containers to the network
    for (let container of linkedContainers) {
        try {
            await net.connect({ Container: container.id })
            console.log(`Connected a container to ${containerName}`);
        } catch (error) {
            console.log(error)
        }
    }

    networks[containerName] = { "connected": true };
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

/**
 * Starts either the application on all the nodes or 
 * on a specific node that is specified by nodeKey parameter
 * @param {String} nodeKey (Optional) start application on specific node 
 */
async function startApplication(nodeKey) {
    let typ = typeof nodeKey; 

    if (typ == 'string' || typ == 'number' ) {
        console.log("Single key, pushing");
        unloadedNodes.push(nodeKey);
    }

    for (key of unloadedNodes) {
        let name = "node" + key;
        let internet = nodes[name].internet;
        let container = fetchNode(key)
        let port = internet.port.toString();

        let luat = await container.exec.create({
            AttachStderr: true,
            AttachStdout: true,
            Cmd: ['lua', 'nswitchboard.lua', APP, port]
        })

        let output = await luat.start({ Detach: false })
        promisifyStream(output);

        await sleep(2000);
        await connectClient(internet.port, internet.ip, key);

        let app = plugins[appStarted]
        if (typeof app["init"] != 'undefined') {
            let initialise = app["init"];
            initialise(name, nodes[name].client)
        }

        console.log(`Application ${APP} succesfully loaded on ${name}`);
    }
    unloadedNodes.splice(0, unloadedNodes.length);
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

    let unl = unloadedNodes.includes(key); 
    if(unl > -1) {
        unloadedNodes.splice(unl, 1); 
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
        let clientIds = await connectedContainers(network);
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
    delete networks[name];
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
            nodes[name].enabled = true;
            console.log(`Unpaused ${name}`);
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
            nodes[name].enabled = false;
            console.log(`Disabled ${name}`);
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
    let connections = await connectedTo(key);

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
        delete networkConnections[node.id];
        nodes[node.id].connected = true;
    } catch (error) {
        console.log(error)
    }
}


async function disconnectNetwork(key, isNode) {
    let net = fetchNetwork(key, isNode);
    let name = (await net.status()).data.Name;
    let containers = await connectedContainers(net);
    try {
        for (c of containers) {
            await net.disconnect({ Container: c });
        }
        networkContainerCache[name] = containers;
        networks[name].connected = false;
        console.log(`Disconnected ${name}`);
    } catch (error) {
        console.log(error);
    }
}

async function reconnectNetwork(key, isNode) {
    let net = fetchNetwork(key, isNode);
    let name = (await net.status()).data.Name;
    // All the containers that were previously connected to this network
    let containers = networkContainerCache[name];
    try {
        for (c of containers) {
            await net.connect({ Container: c });
        }
        delete networkContainerCache[name];
        networks[name].connected = true;
        console.log(`Reconnected ${name}`);
    } catch (error) {
        console.log(error);
    }
}

/**
 * @param {docker.network} network 
 * @returns Array of ids of the containers connected to this newtork
 */
async function connectedContainers(network) {
    let s = await network.status();
    return Object.keys(s.data.Containers);
}

/**
 * Changes the IP properties of a container 
 * TODO: Apply changes to the containers!
 * @param {Integer} key 
 * @param {Object} options 
 */
async function changeInternetOpts(key, options) {
    let node = fetchNode(key);
    let name = "node" + key;
    let status = (await node.status()).data;
    let networkSettings = status.NetworkSettings;
    let cfg = status.Config;

    await node.stop(); 

    let opts = Object.keys(options);

    // Change the options in the container
    try {
        for (option of opts) {
            let val = options[option];
            console.log(`Changing ${option} to ${val}`);
            // Change option in the object 
            nodes[name].internet[option] = val;

            // Change option in the container
            if (!(typeof val == 'undefined')) {
                switch (option) {
                    case "ip":
                        networkSettings.IPAddress = val;
                        break;
                    case "port":
                        // todo update port
                        console.log(val);
                        break;
                    case "dns":
                        cfg.Domainname = val;
                        break;
                    case "gateway":
                        networkSettings.Gateway = val;
                        break;
                    case "hostname":
                        cfg.Hostname = val;
                        break;
                    default:
                        console.log(`Unknown property: ${option}`);
                        break;
                }
            }
        }
    } catch (error) {
        console.log(error);
        return false;
    }
    await node.start(); 
    return true;
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
    for (netKey of netNodeKeys) {
        let network = fetchNetwork(netKey, true);
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

function writeToFile(json) {
    fs.writeFile(diagramPath, JSON.stringify(json), (err) => {
        if (err) throw err;
        console.log('Diagram saved to diagram.json');
    })
}


// =====================
//  Terminal operations
// =====================

/**
 * Parses the input from the terminal
 * Always returns a string as output 
 * @param {String} input -- Input from the terminal 
 */
function parseCMDinput(input, key) {
    let words = input.split(" ");
    let keyword = words[0]
    switch (keyword) {
        case "help":
            return "this should return a list of available functions!";

        case "load":
            if (appStarted) {
                return "Error: another application is still running"
            }
            let app = words[1];
            if (typeof app == 'undefined' || app == " ") {
                return "Error: load requires an argument"
            }
            if (validLoads.includes(app)) {
                return loadApp(app);
            } else return "No such application: " + app;

        default:
            if (validLoads.includes(keyword)) {
                let app = plugins[keyword];
                let fun = app[words[1]]
                let args = words.splice(2);

                // Add node key to arg list as last argument
                if (key == "None") {
                    return "Error: You must select a node"
                } else args.push(key);

                if (typeof fun != 'function') {
                    return `${words[1]} is not a function`
                } else {
                    try {
                        return fun(args);
                    } catch (error) {
                        console.log(error);
                        return "Something went wrong!"
                    }
                }
            } else {
                return `${keyword}: command not found`;
            }
    }
}


function loadApp(app) {
    appStarted = app;
    APP = plugins[app].file;

    startApplication();
    return `Started ${APP}`
}

function unloadApp() {
    appStarted = false;
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

    writeToFile(diagram);

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

let xtermpath = path.join(__dirname, '..', 'node_modules', 'xterm')
app.use('/xtermfiles', express.static(xtermpath))

app.get('/', (req, res) => {
    res.sendFile(__dirname + '/public/html/index.html');
    console.log(`Using docker image: ${IMAGE}`);
})

app.get('/download', (req, res) => {
    res.download(diagramPath);
})

io.on('connection', (socket) => {
    socket.on("saved", (diagramJson) => { handleSave(diagramJson) });
    socket.on("toggleContainer", (key, evt) => {
        let proc = (evt == 'enable' ? enableContainer : disableContainer)
        proc(key);
    });

    socket.on("disconnectContainer", (key) => disconnectNode(key));
    socket.on("reconnectContainer", (key) => reconnectNode(key));

    socket.on("disconnectNet", (key, isNode) => disconnectNetwork(key, isNode));
    socket.on("reconnectNet", (key, isNode) => reconnectNetwork(key, isNode));

    socket.on("reqNode", (name, isNetwork, ret) => {
        let key = parseInt(name.substring(name.indexOf("-")));
        if (isNetwork && isNetworkNode(key)) {
            let net = networks[name];
            ret(net.connected);
        } else if (exists(name)) {
            let node = nodes[name];
            ret(node.connected, node.enabled, node.internet);
        } else ret();

    });

    socket.on("reqNet", (key, ret) => {
        if (networkKeys.includes(key)) {
            let name = "network" + key
            let net = networks[name]
            ret(net.connected);
        } else ret();
    })

    socket.on("internetOpts", (key, obj, ret) => {
        let name = 'node' + key;
        if (exists(name)) {
            (changeInternetOpts(key, obj)) ? ret(true) : ret(false)
        } else ret(false);
    })

    // Set manipulation
    socket.on("addItem", (item, key) => addItem(item, key));
    socket.on("removeItem", (item, key) => removeItem(item, key));
    socket.on("reqList", async (nodeName, ret) => {
        if (exists(nodeName)) {
            let lst = returnList(nodeName);
            ret(lst);
        } else ret();
    })

    // Terminal input
    socket.on("term", (input, key, ret) => {
        let val = parseCMDinput(input, key)
        ret(val);
    })

    socket.on("possible", (ret) => {
        ret(validLoads);
    })

    socket.on("functions", (inp, ret) => {
        if (validLoads.includes(inp)) {
            ret(Object.keys(plugins[inp]).filter(e => e != "file"));
        } else ret([]);
    })
})


http.listen(PORT, () => {
    console.log("Listening on port " + PORT);
})