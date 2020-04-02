const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const net = require('net');
const { Docker } = require('node-docker-api');


// Keep track of what nodes in the network already connected to the server
const connectedClientsKeys = [];

// Server setup
const docker = new Docker({ socketPath: '/var/run/docker.sock' });

// Main server 
const network = (docker.network.create({
    name: 'server-hub',
    Driver: 'bridge',
})
    .catch(error => console.log(error)))



function handleSave(diagram) {
    const nodes = diagram.nodeDataArray;
    // Keys of the nodes in the diagram
    const nodeKeys = nodes.map((node) => {
        return node.key;
    });

    // debug
    console.log('Keys of the nodes in the current configuration');
    console.table(nodeKeys);


    // Add to the server 
    nodeKeys.forEach(async (key) => {
        if (!connectedClientsKeys.includes(key)) {
            connectedClientsKeys.push(key);
            console.log(`New node with key ${key} added to the diagram`);
            let containerName = 'node' + key;

            // Create new Docker container
            const container = await (docker.container.create({
                Image: 'nginx:latest',
                name: containerName,
            })
                .catch(error => console.log(error)))
            container.start();
            console.log(`Adding container with id ${container.id}`)

            // Add to network 
            network.then(net => net.connect({Container: container.id}))
            .catch(error => console.log(error));

        }
    });
}

// Webpage setup
const PORT = 3000;

app.use(express.static('src/public'));

app.get('/', (req, res) => {
    res.sendFile(__dirname + '/public/html/index.html');
})

io.on('connection', (socket) => {
    socket.on("saved", (diagramJson) => { handleSave(diagramJson) })
})

http.listen(PORT, () => {
    console.log("Listening on port " + PORT);
})