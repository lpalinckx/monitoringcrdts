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
async function createNetwork(key, linkedContainers) {
    lastKey = key;
    networkKeys.push(key);
    let containerName = 'network' + key;

    // Create new network
    const net = await (docker.network.create({
        name: containerName,
        Driver: "bridge"
    }));

    console.log(`New network created: ${containerName}`);

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
        const network = await createNetwork(obj.key, [fetchNode(obj.from), fetchNode(obj.to)]);
        networks[networkName] = network;
    }
}

async function handleSave(diagram) {
    // Gets the nodes out of the diagram and immediatly filters out the network nodes
    const nodeArray = (diagram.nodeDataArray).filter(node => (!nodeKeys.includes(node.key) && !(node.text === "Network")));
    const links = ((diagram.linkDataArray).filter(link => (!networkKeys.includes(link.key))));
    
    const networkNodes = (diagram.nodeDataArray).filter(node => (node.text === "Network"))
    // Keys of the nodes in the diagram
    const nodeProps = nodeArray.map((node) => {
        return {
            "key": node.key,
            "text": node.text
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

    // TODO: add network nodes

    // Create nodes
    console.log('creating nodes')
    await createNodes(nodeProps);
    console.log('creating networks')
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
})


http.listen(PORT, () => {
    console.log("Listening on port " + PORT);
})