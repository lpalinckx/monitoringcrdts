const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const net = require('net');
const { Docker } = require('node-docker-api');


// Docker image to use
const IMAGE = 'luat:latest'

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

// Server setup
const docker = new Docker({ socketPath: '/var/run/docker.sock' });


// =====================
//  Creating containers 
//  -------------------
//    Nodes & networks
// =====================

/**
 * Creates a container for a node 
 * 
 * @param {Key of the node} key 
 */
async function createNode(key) {
    nodeKeys.push(key);
    let containerName = 'node' + key;
    let container;
    // Create new Docker container
    try {
        container = await (docker.container.create({
            Image: IMAGE,
            name: containerName
        }))
        container.start();
        console.log('New container created: ' + containerName);
    } catch (error) {
        console.log(error)
    }
    // Return container
    return container
}

/**
 * Creates a docker network
 * Connects all the nodes passed in linkedContainers to the new network
 * @param {Key of the network} key 
 * @param {All linked containers to this network} linkedContainers 
 * @param {Boolean: true = network node, false = regular node} isNode 
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
 * @param {Array of objects} nodeProps 
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
 * @param {Array of objects, these objects have the from's and to's for each link} fromTo 
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

// =====================
//  Deleting containers
// =====================

/**
 * Stops and deletes the container, key is removed from the array 
 * @param {Key of the node to delete} key 
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
 * @param {Key of the network to remove} key 
 * @param {Boolean: True = network node, False = regular link} isNode 
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
 * @param {Key of the link to remove} key 
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

async function enableContainer(key) {
    try {
        let container = fetchNode(key);
        await container.unpause();
        console.log(`Enabled node${key}`)
    } catch (error) {
        console.log(error);
    }

}

async function disableContainer(key) {
    try {
        let container = fetchNode(key);
        await container.pause();
        console.log(`Disabled node${key}`)
    } catch (error) {
        console.log(error);
    }

}

/**
 * Disconnect the node from the networks
 * @param {Key of the node} key 
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
    } catch (error) {
        console.log(error)
    }

}

/**
 * Reconnect the node to the previously disconnected networks
 * @param {Key of the node} key 
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
    } catch (error) {
        console.log(error)
    }
}

// ==================
//  Small operations
// ==================

/**
 * Returns the container of the node 
 * @param {Key of the node} key 
 */
function fetchNode(key) {
    let nameToFind = 'node' + key;
    return docker.container.get(nameToFind)
}

/**
 * Returns the network container 
 * @param {key of the network to return} key 
 * @param {Boolean: true = return a network node, false = return a regular network} isNode 
 */
function fetchNetwork(key, isNode) {
    let name = (isNode ? 'networkNode' : 'network');
    let nameToFind = name + key;
    return docker.network.get(nameToFind)
}

/**
 * Checks if the given key is the key of a network node
 * @param {Key of the node} key 
 */
function isNetworkNode(key) {
    return (netNodeKeys.includes(key))
}

/**
 * Returns if either from or to is a network node 
 * @param {key} from 
 * @param {key} to 
 */
function isLinkToNetNode(from, to) {
    return (isNetworkNode(from) || isNetworkNode(to))
}

/**
 * 
 * @param {Key of the node} key 
 * @returns Array of networks to which the container is connected
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

// ================
//  Main operation 
// ================

/**
 * Handles whenever there is a new save
 * new nodes, networks and network node are created 
 * Nodes that are absent in the diagram and still have active containers, are removed.
 * @param {Diagram from the front-end} diagram 
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
        deleteNode(nodeKey);
    }

    // Create nodes
    await createNodes(nodeProps);

    // Create network nodes
    await createNetworkNode(nets);

    // Create links
    await createNetworks(fromTo);
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
    socket.on("reqImage", (fn) => fn(IMAGE)); 
})


http.listen(PORT, () => {
    console.log("Listening on port " + PORT);
})