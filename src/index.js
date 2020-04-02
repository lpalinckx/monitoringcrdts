const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const net = require('net');
const { Docker } = require('node-docker-api');


// Keep track of what nodes in the network already connected to the server
const connectedClientsKeys = [];

// Server setup
const docker = new Docker({socketPath: '/var/run/docker.sock'});

// Main server 
docker.network.create({
    name: 'server-hub',
    Image: 'nginx:latest',
    attachable: true, 
})
.catch(error => console.log(error));


// Webpage setup
const PORT = 3000;

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
    nodeKeys.forEach(key => {
        if(!connectedClientsKeys.includes(key)){
            console.log(`New node with key ${key} added to the diagram`);
            let containerName = 'node' + key;
            // Create new Docker container
            docker.container.create({
                Image: 'nginx:latest',
                name: containerName,             
                Cmd: ['echo', 'hello']
            })
            .then(container => container.attach('server-hub'))            
            .catch(error => console.log(error));
        } else console.log(`Node with key ${key} already added`);
    });
}

app.use(express.static('src/public'));

app.get('/', (req, res) => {
    res.sendFile(__dirname + '/public/html/index.html');
})

io.on('connection', (socket) => {
    socket.on("saved", (diagramJson) => {handleSave(diagramJson)})
})

http.listen(PORT, () => {
    console.log("Listening on port " + PORT);
})