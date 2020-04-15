const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const net = require('net');
const { Docker } = require('node-docker-api');


// Keep track of the keys of all the nodes and links in the diagram
const nodeKeys = [];
const netNodeKeys = [];
const networkKeys = [];
// Keys of the links that do not create a network (= are connected to a network node)
const nonNetworkLinks = [];

// Server setup
const docker = new Docker({ socketPath: '/var/run/docker.sock' });

// Instantiates the Docker containers for each new node
async function createNode(key) {
    nodeKeys.push(key);
    let containerName = 'node' + key;

    // Create new Docker container
    const container = await (docker.container.create({
        Image: 'nginx:latest',
        name: containerName,
    })
        .catch(error => console.log(error)))
    container.start();

    console.log('New container created: ' + containerName);

    // Return container
    return container
}

/**
 * 
 * @param {Key of the new network} key 
 * @param {All the containers linked to this network} linkedContainers 
 */
async function createNetwork(key, linkedContainers, isNode) {
    lastKey = key;
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
        net.connect({ Container: container.id })
            .catch(error => console.log(error))
        console.log(`Connected a container to network ${containerName}`);
    }

    // Return container
    return net;
}

function fetchNode(key) {    
    let nameToFind = 'node' + key;
    return docker.container.get(nameToFind)
}

function fetchNetwork(key, isNode) {
    let name = (isNode ? 'networkNode' : 'network');
    let nameToFind = name + key;
    return docker.network.get(nameToFind)
}

async function createNodes(nodeProps) {
    for (let props of nodeProps) {
        let key = props.key;    
        await createNode(key);
    }
}

async function createNetworks(fromTo) {
    for (let link of fromTo) {
        let from = link.from;
        let to = link.to;
        let key = link.key;
        // Check if the link is connected to a network node,
        // if so it doesn't need to create a new network but rather link the node to the network node
        if (isLinkToNetNode(from, to)) {
            // Link is connected to a network node 
            let net = (isNetworkNode(from) ? fetchNetwork(from, true) : fetchNetwork(to, true))
            let node = (isNetworkNode(from) ? fetchNode(to) : fetchNode(from))

            net.connect({ Container: node.id })
                .catch(error => console.log(error));

            nonNetworkLinks.push(key);
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

function isNetworkNode(key) {
    return (netNodeKeys.includes(key))
}

function isLinkToNetNode(from, to) {
    return (isNetworkNode(from) || isNetworkNode(to))
}

/**
 * 
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
            await network.disconnect({Container: id});
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
 * Handles whenever there is a new save
 * new nodes, networks and network node are created 
 * @param {Diagram from the front-end} diagram 
 */
async function handleSave(diagram) {
    console.log('\n======= NEW SAVE ======= ')
    // Gets the nodes out of the diagram and immediatly filters out the network nodes
    const nodes = (diagram.nodeDataArray).filter(node => !(node.text === "Network"));
    const links = (diagram.linkDataArray)
    const netNodes = (diagram.nodeDataArray).filter(node => (node.text === "Network"))

    const newNodes = nodes.filter(node => !nodeKeys.includes(node.key));
    const newLinks = links.filter(link => !networkKeys.includes(link.key) && !nonNetworkLinks.includes(link.key));
    const newNetNodes = netNodes.filter(node => !netNodeKeys.includes(node.key));

    const missingNodes = nodeKeys.filter(k => !(nodes.map(n => n.key).includes(k)));
    const missingLinks = networkKeys.filter(k => {
        let keys = links.map(l => l.key);
        return (!keys.includes(k))
    })
    const missingNonNetworks = nonNetworkLinks.filter(k => !(links.map(l => l.key).includes(k)));
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

    const nets = newNetNodes.map((netNode) => {
        return {
            "key": netNode.key
        }
    })

    // Delete removed networks
    for (networkKey of missingLinks) {
        await deleteNetwork(networkKey, false); 
    }

    for (netNodeKey of missingNetNodes) {
        await deleteNetwork(netNodeKey, true)
    }

    // Delete removed nodes
    for (nodeKey of missingNodes) {
        deleteNode(nodeKey);
    }

    for (nonNetwork of missingNonNetworks) {
        let idx = nonNetworkLinks.indexOf(nonNetwork);
        nonNetworkLinks.splice(idx, 1);
    }

    // Create nodes
    await createNodes(nodeProps);

    // Create network nodes
    await createNetworkNode(nets);

    // Create links
    await createNetworks(fromTo);
}

// Webpage setup
const PORT = 3000;

app.use(express.static('src/public'));

app.get('/', (req, res) => {
    res.sendFile(__dirname + '/public/html/index.html');
})

io.on('connection', (socket) => {
    socket.on("saved", (diagramJson) => { handleSave(diagramJson) });
    socket.on("nodeClicked", () => console.log('received click'));
})


http.listen(PORT, () => {
    console.log("Listening on port " + PORT);
})