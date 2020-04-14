const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const net = require('net');
const { Docker } = require('node-docker-api');


// Keep track of what nodes in the network already connected to the server
let lastKey = 0;
const nodeKeys = [];
const networkKeys = [];

const containers = {};
const networks = {};
const netNodes = {};

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
    (isNode) ? nodeKeys.push(key) : networkKeys.push(key);
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
    return containers[nameToFind];
}

function fetchNetwork(key, isNode) {
    let name = (isNode ? 'netNode' : 'network');
    let obj = (isNode ? netNodes : networks);
    let nameToFind = name + key;
    return obj[nameToFind];
}

async function createNodes(nodeProps) {
    for (let props of nodeProps) {
        let key = props.key;
        let containerName = 'node' + key;
        const container = await createNode(key);
        containers[containerName] = container
    }
}

async function createNetworks(fromTo) {
    for (let obj of fromTo) {
        let networkName = 'network' + obj.key
        let from = obj.from;
        let to = obj.to;
        // Check if either from or to is a network node,
        // if so it doesn't need to create a new network but rather link it to the network node
        if (isNetworkNode(from) || isNetworkNode(to)) {
            // Link is connected to a network node 
            let net = (isNetworkNode(from) ? fetchNetwork(from, true) : fetchNetwork(to, true))
            let node = (isNetworkNode(from) ? fetchNode(to) : fetchNode(from))

            net.connect({ Container: node.id })
                .catch(error => console.log(error));

            networkKeys.push(obj.key);
        } else {
            // Not connected to a network node, so it is a link connected between 2 regular nodes 
            const network = await createNetwork(obj.key, [fetchNode(from), fetchNode(to)], false);
            networks[networkName] = network;
        }
    }
}

async function createNetworkNode(nodes) {
    for (netNode of nodes) {
        const network = await createNetwork(netNode.key, [], true);
        let name = 'netNode' + netNode.key;
        netNodes[name] = network;
    }
}

function isNetworkNode(key) {
    let nameToFind = 'netNode' + key;
    let res = typeof netNodes[nameToFind] !== 'undefined';
    return res
}

/**
 * Handles whenever there is a new save
 * new nodes, networks and network node are created 
 * @param {Diagram from the front-end} diagram 
 */
async function handleSave(diagram) {
    // Gets the nodes out of the diagram and immediatly filters out the network nodes
    const nodeArray = (diagram.nodeDataArray).filter(node => (!nodeKeys.includes(node.key) && !(node.text === "Network")));
    const links = ((diagram.linkDataArray).filter(link => (!networkKeys.includes(link.key))));
    const networkNodes = (diagram.nodeDataArray).filter(node => (node.text === "Network") && !(nodeKeys.includes(node.key)))

    // Keys of the nodes in the diagram
    const nodeProps = nodeArray.map((node) => {
        return {
            "key": node.key
        }
    });

    // From and To nodes for each link
    const fromTo = links.map(link => {
        return {
            "from": link.from,
            "to": link.to,
            "key": link.key
        }
    });

    const nets = networkNodes.map((netNode) => {
        return {
            "key": netNode.key
        }
    })

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
    socket.on("nodeClicked", (node) => console.log('received click'))
})


http.listen(PORT, () => {
    console.log("Listening on port " + PORT);
})