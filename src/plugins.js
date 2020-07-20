let cache = {}

/**
 * Possible operations for a certain application
 * Define procedures and reference them in this object
 * 
 * Procedures get an array as parameters
 */
const plugins = {
    "general": {
        "reset": reset, 
    },

    "orset": {
        "init": init, 
        "addItem": addItem, 
        "removeItem": removeItem,
        "returnList": returnList
    },

    "counter": {
        "inc": inc
    }

}

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

// ===================
//  General functions
// ===================
function reset() {
    cache = {}; 
}

// =================
//  Orset functions
// =================

function init(name, client) {
    cache[name] = {
        "list": [], 
        "client": client, 
    }
}

/**
 * Adds item to the list
 * @param {Array} params [item, nodeKey]
 */
function addItem(params) {
    let item = params[0]; 
    let key =  params[1]; 

    let name = "node" + key; 
    let node = cache[name];
    let client = node.client; 
    let lst = node.list; 
    lst.push(item); 
    cache[name].list = lst; 
    doRPCCommand(client, 'add', [item])
}

function removeItem(params) {
    let item = params[0]; 
    let key = params[1]; 

    let name = "node" + key;
    let node = cache[name];
    let client = node.client;
    let list = node.list;
    const idx = list.indexOf(item);
    node.list = list.splice(idx, 1);
    doRPCCommand(client, 'remove', [item]);
}

function returnList(params) {
    let name = "node"+params[0];
    let list = cache[name].list;
    let str = `Items in set: `
    for(i of list) {
        str += `${i}, `; 
    }
    return str; 
}


// ===================
//  Counter functions
//  note: no counter crdt yet in luat
// ===================

function inc(key, val){
    let name = "node"+key; 
    let node = cache[name];
    let client = node.client;
    let counter = node.count; 
    counter += val; 

}



exports.plugins = plugins; 