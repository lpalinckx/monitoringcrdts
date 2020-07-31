# A monitoring tool (for CRDTs in LuAT)

This is a project for my Bachelor thesis sciences at the VUB (Vrije Universiteit Brussel). 

## Installation
This project uses npm to install various packages. 

To install all the dependencies for this project execute the following in your terminal: 

```
npm install
```

In order to start the application, execute the following command in the /code directory: 

```
node src/index.js
```

## Usage
### Setup

This tool has not one single usage. 
It is possible to add plugins to the tool.
This is done by changing the ``` src/plugins.js ``` file. 
The ```plugins``` object defines all the possible applications and its funtions that are available to use in the tool.

Here you can define new plugins and functions as you wish.
Keep in mind, the docker image used is stated in the ```IMAGE``` variable. 

__Important__
* Every entry in the ```plugins``` object needs a ```"file"``` entry. 
This is the file that is supposed to run whenever the application is executed. 

* If an application needs a special initialisation, call it ```"init"```. 
These procedures are automatically called after the application is started. 

### The tool 
The tool has several panels that can be used. 
In the main panel, the user can draw networks with nodes and edges. 
Nodes are created by dragging the node template to the diagram. 
In order to create a link (network) between two nodes, hover your mouse over one of the outer points of a node and drag to another point of a different node.

Changes made to the diagram need to be saved first. 
Once everything is saved, all the docker containers and networks will be created. 

### Starting applications
To start and manage applications the tool provides a terminal to execute commands.
The commands are all taken from the ```plugins``` object. 

* ```help``` returns a list of possible commands
* ```help 'app'``` gives a list of possible commands for application 'app'
* ```load 'app'``` starts the application 'app' on the docker containers
* ```'app' 'command'``` executes 'command' on for application 'app'. For some operations, you need to select a node first. The key of the selected node is always passed as an argument to the command. 
* ```reset``` stops all applications 
* ```clear``` clears the terminal

