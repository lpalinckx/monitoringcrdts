function init() {
    if (window.goSamples) goSamples();  // init for these samples -- you don't need to call this
    var $ = go.GraphObject.make;  // for conciseness in defining templates

    myDiagram =
        $(go.Diagram, "myDiagramDiv",  // must name or refer to the DIV HTML element
            {
                grid: $(go.Panel, "Grid",
                    $(go.Shape, "LineH", { stroke: "lightgray", strokeWidth: 0.5 }),
                    $(go.Shape, "LineH", { stroke: "gray", strokeWidth: 0.5, interval: 10 }),
                    $(go.Shape, "LineV", { stroke: "lightgray", strokeWidth: 0.5 }),
                    $(go.Shape, "LineV", { stroke: "gray", strokeWidth: 0.5, interval: 10 })
                ),
                "draggingTool.isGridSnapEnabled": true,
                "linkingTool.portGravity": 20,
                "relinkingTool.portGravity": 20,
                "relinkingTool.toHandleArchetype":
                    $(go.Shape, "Diamond", { segmentIndex: -1, cursor: "pointer", desiredSize: new go.Size(8, 8), fill: "darkred", stroke: "tomato" }),
                "linkReshapingTool.handleArchetype":
                    $(go.Shape, "Diamond", { desiredSize: new go.Size(7, 7), fill: "lightblue", stroke: "deepskyblue" }),
                "undoManager.isEnabled": true
            });

    // Checks link constraint
    myDiagram.addDiagramListener("LinkDrawn", (e) => {
        const sub = e.subject;
        const from = sub.fromNode;
        const to = sub.toNode;
        const fromNode = myDiagram.findNodeForKey(from.key);
        const linkIterator = fromNode.findLinksBetween(to);

        // Removes the link if there already exists one
        if (linkIterator.count > 1) myDiagram.remove(sub);
    })

    myDiagram.addDiagramListener("ChangedSelection", (e) => {
        console.log(`changed selection: ${e.subject}`)
    })

    // when the document is modified, add a "*" to the title and enable the "Save" button
    myDiagram.addDiagramListener("Modified", function (e) {
        var button = document.getElementById("SaveButton");
        if (button) button.disabled = !myDiagram.isModified;
        var idx = document.title.indexOf("*");
        if (myDiagram.isModified) {
            if (idx < 0) document.title += "*";
        } else {
            if (idx >= 0) document.title = document.title.substr(0, idx);
        }
    });

    // Define a function for creating a "port" that is normally transparent.
    // The "name" is used as the GraphObject.portId, the "spot" is used to control how links connect
    // and where the port is positioned on the node, and the boolean "output" and "input" arguments
    // control whether the user can draw links from or to the port.
    function makePort(name, spot, output, input) {
        // the port is basically just a small transparent square
        return $(go.Shape, "Circle",
            {
                fill: null,  // not seen, by default; set to a translucent gray by showSmallPorts, defined below
                stroke: null,
                desiredSize: new go.Size(7, 7),
                alignment: spot,  // align the port on the main Shape
                alignmentFocus: spot,  // just inside the Shape
                portId: name,  // declare this object to be a "port"
                fromSpot: spot, toSpot: spot,  // declare where links may connect at this port
                fromLinkable: output, toLinkable: input,  // declare whether the user may draw links to/from here
                cursor: "pointer"  // show a different cursor to indicate potential link point
            });
    }

    var nodeSelectionAdornmentTemplate =
        $(go.Adornment, "Auto",
            $(go.Shape, { fill: null, stroke: "deepskyblue", strokeWidth: 1.5, strokeDashArray: [4, 2] }),
            $(go.Placeholder)
        );

    var nodeResizeAdornmentTemplate =
        $(go.Adornment, "Spot",
            { locationSpot: go.Spot.Right },
            $(go.Placeholder),
            $(go.Shape, { alignment: go.Spot.TopLeft, cursor: "nw-resize", desiredSize: new go.Size(6, 6), fill: "lightblue", stroke: "deepskyblue" }),
            $(go.Shape, { alignment: go.Spot.Top, cursor: "n-resize", desiredSize: new go.Size(6, 6), fill: "lightblue", stroke: "deepskyblue" }),
            $(go.Shape, { alignment: go.Spot.TopRight, cursor: "ne-resize", desiredSize: new go.Size(6, 6), fill: "lightblue", stroke: "deepskyblue" }),

            $(go.Shape, { alignment: go.Spot.Left, cursor: "w-resize", desiredSize: new go.Size(6, 6), fill: "lightblue", stroke: "deepskyblue" }),
            $(go.Shape, { alignment: go.Spot.Right, cursor: "e-resize", desiredSize: new go.Size(6, 6), fill: "lightblue", stroke: "deepskyblue" }),

            $(go.Shape, { alignment: go.Spot.BottomLeft, cursor: "se-resize", desiredSize: new go.Size(6, 6), fill: "lightblue", stroke: "deepskyblue" }),
            $(go.Shape, { alignment: go.Spot.Bottom, cursor: "s-resize", desiredSize: new go.Size(6, 6), fill: "lightblue", stroke: "deepskyblue" }),
            $(go.Shape, { alignment: go.Spot.BottomRight, cursor: "sw-resize", desiredSize: new go.Size(6, 6), fill: "lightblue", stroke: "deepskyblue" })
        );

    myDiagram.nodeTemplate =
        $(go.Node, "Spot",
            { locationSpot: go.Spot.Center },
            new go.Binding("location", "loc", go.Point.parse).makeTwoWay(go.Point.stringify),
            { selectable: true, selectionAdornmentTemplate: nodeSelectionAdornmentTemplate },
            { resizable: false, resizeObjectName: "PANEL", resizeAdornmentTemplate: nodeResizeAdornmentTemplate },
            { click: nodeClicked },
            new go.Binding("angle").makeTwoWay(),
            // the main object is a Panel that surrounds a TextBlock with a Shape
            $(go.Panel, "Auto",
                { name: "PANEL" },
                new go.Binding("desiredSize", "size", go.Size.parse).makeTwoWay(go.Size.stringify),
                $(go.Shape, "Rectangle",  // default figure
                    {
                        portId: "", // the default port: if no spot on link data, use closest side
                        fromLinkable: true, toLinkable: true, cursor: "pointer",
                        fill: "white",  // default color
                        strokeWidth: 2
                    },
                    new go.Binding("figure"),
                    new go.Binding("fill")),
                $(go.TextBlock,
                    {
                        font: "bold 11pt Helvetica, Arial, sans-serif",
                        margin: 12,
                        maxSize: new go.Size(160, NaN),
                        wrap: go.TextBlock.WrapFit,
                        editable: true
                    },
                    new go.Binding("text").makeTwoWay())
            ),
            // four small named ports, one on each side:
            makePort("T", go.Spot.Top, false, true),
            makePort("L", go.Spot.Left, true, true),
            makePort("R", go.Spot.Right, true, true),
            makePort("B", go.Spot.Bottom, true, false),
            { // handle mouse enter/leave events to show/hide the ports
                mouseEnter: function (e, node) { showSmallPorts(node, true); },
                mouseLeave: function (e, node) { showSmallPorts(node, false); }
            }
        );

    function showSmallPorts(node, show) {
        node.ports.each(function (port) {
            if (port.portId !== "") {  // don't change the default port, which is the big shape
                port.fill = show ? "rgba(0,0,0,.3)" : null;
            }
        });
    }

    var linkSelectionAdornmentTemplate =
        $(go.Adornment, "Link",
            $(go.Shape,
                // isPanelMain declares that this Shape shares the Link.geometry
                { isPanelMain: true, fill: null, stroke: "deepskyblue", strokeWidth: 0 })  // use selection object's strokeWidth
        );

    myDiagram.linkTemplate =
        $(go.Link,  // the whole link panel
            { selectable: true, selectionAdornmentTemplate: linkSelectionAdornmentTemplate },
            { relinkableFrom: true, relinkableTo: true, reshapable: true },
            { click: linkClicked },
            {
                routing: go.Link.AvoidsNodes,
                curve: go.Link.JumpOver,
                corner: 5,
                toShortLength: 4
            },
            new go.Binding("points").makeTwoWay(),
            $(go.Shape,  // the link path shape
                { isPanelMain: true, strokeWidth: 2 }),
            $(go.Panel, "Auto",
                new go.Binding("visible", "isSelected").ofObject(),
                $(go.Shape, "RoundedRectangle",  // the link shape
                    { fill: "#F8F8F8", stroke: null }),
                $(go.TextBlock,
                    {
                        textAlign: "center",
                        font: "10pt helvetica, arial, sans-serif",
                        stroke: "#919191",
                        margin: 2,
                        minSize: new go.Size(10, NaN),
                        editable: true
                    },
                    new go.Binding("text").makeTwoWay())
            )
        );



    // initialize the Palette that is on the left side of the page
    myPalette =
        $(go.Palette, "myPaletteDiv",  // must name or refer to the DIV HTML element
            {
                maxSelectionCount: 1,
                nodeTemplateMap: myDiagram.nodeTemplateMap,  // share the templates used by myDiagram
                model: new go.GraphLinksModel([  // specify the contents of the Palette
                    { text: "Node", figure: "Circle", fill: "#00AD5F" },
                    { text: "Network", figure: "Border", fill: "#f2805a" },
                ])
            });
    load();  // load an initial diagram from some JSON text
}


//
// Functions
//

// Show the diagram's model in JSON format that the user may edit
function save() {
    saveDiagramProperties();  // do this first, before writing to JSON
    document.getElementById("mySavedModel").value = myDiagram.model.toJson();
    myDiagram.isModified = false;
}

function load() {
    myDiagram.model = go.Model.fromJson(document.getElementById("mySavedModel").value);
    loadDiagramProperties();  // do this after the Model.modelData has been brought into memory
    popupDisplay('none');
    save();
    let inp = document.getElementById("mySavedModel").value;
    socket.emit("saved", JSON.parse(inp));
}

function saveDiagramProperties() {
    myDiagram.model.modelData.position = go.Point.stringify(myDiagram.position);
}

function loadDiagramProperties(e) {
    // set Diagram.initialPosition, not Diagram.position, to handle initialization side-effects
    var pos = myDiagram.model.modelData.position;
    if (pos) myDiagram.initialPosition = go.Point.parse(pos);
}

/**
 * Disables any input to the diagram
 */
function disable() {
    myDiagram.startTransaction();
    myDiagram.opacity = 0.0;
    myDiagram.isEnabled = false;
    myDiagram.commitTransaction();
    myPalette.startTransaction();
    myPalette.opacity = 0.0;
    myPalette.isEnabled = false;
    myPalette.commitTransaction();
}

/**
 * Re-enables input for diagram
 */
function enable() {
    myDiagram.startTransaction();
    myDiagram.opacity = 1.0;
    myDiagram.isEnabled = true;
    myDiagram.commitTransaction();
    myPalette.startTransaction();
    myPalette.opacity = 1.0;
    myPalette.isEnabled = true;
    myPalette.commitTransaction();
}

function popupDisplay(val) {
    let popup = document.getElementById("popup");
    popup.style.display = val;
    (val == 'none') ? enable() : disable()
}

function mySave() {
    let header = document.getElementById("popup-title");
    let text = document.getElementById("popup-text");
    let button = document.getElementById("LoadButton");
    save();
    let inp = document.getElementById("mySavedModel").value;
    header.innerText = "Save configuration";
    text.innerText = "Save the current configuration as a JSON object."
    button.style.visibility = 'hidden';
    popupDisplay('block');
    showInfo("Processing...", 1)
    socket.emit("saved", JSON.parse(inp));
}

function myLoad() {
    let header = document.getElementById("popup-title");
    let text = document.getElementById("popup-text");
    let button = document.getElementById("LoadButton");
    header.innerText = "Load configuration";
    text.innerText = "Load a new configuration into the diagram by pasting a JSON object in the textfield."
    button.style.visibility = 'visible';
    save();
    popupDisplay('block');
}

function hidePopup() {
    popupDisplay('none');
}

window.onclick = (e) => {
    let popup = document.getElementById("popup");
    if (e.target == popup) {
        popupDisplay('none');
    }
}


let infoColor = '#24af29';      // Green
let warningColor = '#ff801f';   // Orange
let errorColor = '#b61010';     // Red
/**
 * Severity = 0: info
 * Severity = 1: warning
 * Severity = 2: error
 * @param {String} msg 
 * @param {Number} severity 
 */
function showInfo(msg, severity) {
    let snackbar = document.getElementById("snackbar");
    let color = errorColor;
    switch (severity) {
        case 0:
            color = infoColor;
            break;

        case 1:
            color = warningColor;
        default:
            break;
    }
    snackbar.style.backgroundColor = color;
    snackbar.className = "show";
    let tag = ""
    if (severity == 2) {
        tag = "Error: "
    }
    snackbar.innerText = tag + msg;
    setTimeout(() => { snackbar.className = snackbar.className.replace("show", "") }, 3000);
}

function myClear() {
    myDiagram.clear();
    myDiagram.isModified = true;
    clearClicked();
}

function nodeClicked(e, obj) {
    let node = obj.part;
    let name1 = document.getElementById("nodeName1");
    let name2 = document.getElementById("nodeName2");
    let title = document.getElementById("settingsTitle");
    let enable = document.getElementById("cEnabled");
    let connect = document.getElementById("cConnected");

    let ip = document.getElementById("ip");
    let port = document.getElementById("port");
    let dns = document.getElementById("dns");
    let gateway = document.getElementById("gateway");
    let hostname = document.getElementById("hostname");

    let data = node.data;
    let networkNode = (data.figure == "Border")
    let name = (networkNode ? "networkNode" : "node") + node.key
    socket.emit("reqNode", name, networkNode, (connected, enabled, internet) => {
        if (typeof connected == 'undefined') {
            clearClicked();
        } else if (networkNode) {
            title.innerText = "Network settings"
            enable.disabled = true;
            connect.checked = connected;
            name2.innerText = name;
        } else {
            console.dir(internet);
            title.innerText = "Node settings"
            enable.disabled = false;
            enable.checked = enabled;
            connect.checked = connected;
            name1.innerText = name2.innerText = name;
            ip.value = internet.ip;
            port.value = internet.port;
            dns.value = internet.dns;
            gateway.value = internet.gateway;
            hostname.value = internet.hostname;
        }
    })
}

function linkClicked(e, obj) {
    let link = obj.part;
    let name2 = document.getElementById("nodeName2");
    let key = link.key;
    let name = "network" + key;
    let enable = document.getElementById("cEnabled");
    let connect = document.getElementById("cConnected");
    let title = document.getElementById("settingsTitle");
    socket.emit("reqNet", key, (connected) => {
        if (typeof connected == 'undefined') {
            clearClicked();
        } else {
            name2.innerText = name;
            connect.checked = connected;
            enable.disabled = true;
            title.innerText = "Network settings"
        }
    })

}

function clearClicked() {
    let name1 = document.getElementById("nodeName1");
    let name2 = document.getElementById("nodeName2");
    let enable = document.getElementById("cEnabled");
    let connect = document.getElementById("cConnected");

    let ip = document.getElementById("ip");
    let port = document.getElementById("port");
    let dns = document.getElementById("dns");
    let gateway = document.getElementById("gateway");
    let hostname = document.getElementById("hostname");

    let val = "None";
    name1.innerText = name2.innerText = val;
    enable.checked = connect.checked = true;
    ip.value = port.value = dns.value = gateway.value = hostname.value = "";
}

function getKey() {
    let node = document.getElementById("nodeName2").innerText;
    let key = node.substring(node.indexOf("-"));
    return key;
}

function isNetwork() {
    let name = document.getElementById("nodeName2").innerText;
    return (name.substring(0, 7) == 'network');
}

function isNetNode() {
    let name = document.getElementById("nodeName2").innerText;
    return (name.substring(0, 11) == 'networkNode');
}

function internetOptions() {
    if (isNodeSelected() && !isNetNode()) {
        let ip = document.getElementById("ip").value;
        let port = document.getElementById("port").value;
        let dns = document.getElementById("dns").value;
        let gateway = document.getElementById("gateway").value;
        let hostname = document.getElementById("hostname").value;

        let obj = {
            "ip": ip,
            "port": port,
            "dns": dns,
            "gateway": gateway,
            "hostname": hostname
        }

        let key = getKey();
        socket.emit("internetOpts", key, obj, (ret) => {
            if (ret) {
                showInfo(`Updated internet settings for ${nodeName}!`, 0);
            } else showInfo(`Something went wrong!`, 2)
        });
    }
}

// --------------------------
//  Functions for checkboxes
// --------------------------
function isNodeSelected() {
    if (getKey() == "None") {
        return false;
    } else return true;
}

function checkEnabled() {
    if (isNodeSelected()) {
        let checkbox = document.getElementById("cEnabled");
        let key = getKey();
        let msg = (checkbox.checked ? "enable" : "disable");
        let data = myDiagram.model.findNodeDataForKey(key);
        let color = (checkbox.checked ? "#00AD5F" : "#cf382d")
        myDiagram.startTransaction();
        myDiagram.model.setDataProperty(data, "fill", color);
        myDiagram.commitTransaction();
        socket.emit("toggleContainer", key, msg);
    }
}

function checkConnected() {
    if (isNodeSelected()) {
        let checkbox = document.getElementById("cConnected");
        let key = getKey();
        let type = (isNetwork()) ? "Net" : "Container"
        let msg = (!checkbox.checked ? "disconnect" + type : "reconnect" + type);
        let isNode = isNetNode();
        socket.emit(msg, key, isNode);
    }
}

socket.on('allDone', () => {
    idx = document.title.indexOf("*");
    if (idx >= 0) document.title = document.title.substr(0, idx);
    showInfo("All done!", 0);
})