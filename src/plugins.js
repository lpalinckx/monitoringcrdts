let cache = {}

const IMAGE = 'luat'; 
/**
 * Possible operations for a certain application
 * Define procedures and reference them in this object
 * 
 * -- IMPORTANT -- 
 * Every entry in this object *needs* a "file" entry
 * This should represent the application that is supposed to run
 * e.g. test_orset_rpc.lua for the OR-set CRDT
 * 
 * If an application needs a special initialisation, call it "init"
 * "init" procedures are automatically called after the application is started
 * 
 * Procedures get an array as parameters
 * The last parameter is always the id of the selected node
 */
const plugins = {
    "general": {
        "docker-image": IMAGE, 
        "reset": reset, 
    },

    "orset": {
        "file": 'test_orset_rpc.lua',
        "init": init, 
        "update": update, 
        "addItem": addItem, 
        "removeItem": removeItem,
        "returnList": returnList
    },

    "counter": {
        "file": "tbd", 
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

/**
 * Initializes the set for a node 
 * @param {String} name Name of the node
 * @param {Socket} client Socket client
 */
function init(name, client) {
    cache[name] = {
        "list": [], 
        "client": client, 
    }
}

/**
 * Updates the data in a set of a node
 * Not to be used manually, it is used in connectClient() (see index.js)
 * @param {String} name 
 * @param {Object} list 
 */
function update(name, list){
    let lst = []; 
    for (item of list) {
        lst.push(item); 
    }
    cache[name].list = lst; 
}

/**
 * Adds item to the set
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
    return `Added ${item} to ${name}`;
}

/**
 * Removes item from the set
 * @param {Array} params [item, nodeKey]
 */
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
    return `Removed ${item} from ${name}`;
}

/**
 * Returns the items in the set in a string format to output in the terminal
 * @param {Array} params [nodeKey]
 */
function returnList(params) {
    let name = "node"+params[0];
    let list = cache[name].list;
    let str = `Items in set of ${name}: `
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