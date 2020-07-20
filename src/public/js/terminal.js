const socket = io();

let term = new Terminal({
    'theme': { foreground: '#000', background: '#e8e8e8', cursor: '#000' }
});
term.open(document.getElementById("terminal"));
let currLine = "";

function getKey() {
    let node = document.getElementById("nodeName2").innerText;
    let key = node.substring(node.indexOf("-"));
    return key;
}

function runTerminal() {
    if (term._initialized) {
        return;
    }

    term._initialized = true;
    term.prompt = () => {
        term.write("\r\n$ ");
    }

    term.writeln('\x1B[1;3;31mxterm.js\x1B[0m: Monitoring tool control');
    term.writeln('Type "help" for a list of possible commands')
    prompt(term);

    term.onData(e => {
        switch (e) {
            case '\r': // Enter
                let words = (currLine.split(" ")).filter(e => e != '');
                if(typeof words[0] == 'undefined') {
                    prompt(term);
                    return;
                }
                switch (words[0]) {
                    case "clear":
                        currLine = "";
                        clearTerminal();
                        return;
                        
                    case "help":
                        currLine = "";
                        returnHelp(words[1]);
                        return;

                    case "list": 
                        currLine = ""; 
                        returnApplications(); 
                        return;

                    default:
                        let key = getKey();
                        socket.emit('term', currLine, key, (result) => {
                            out(result)
                            currLine = "";
                            prompt(term);
                        });
                        return;
                }

            case '\u0003': // Ctrl+C
                currLine = "";
                prompt(term);
                break;

            case '\u007F': // Backspace (DEL)
                // Do not delete the prompt
                if (term._core.buffer.x > 2) {
                    term.write('\b \b');
                }
                currLine = currLine.slice(0, -1)
                break;
            default:
                term.write(e);
                currLine += e;
        }
    });
}

function prompt(t) {
    term.write('\r\n$ ');
}

function clearTerminal() {
    term.write('\x1bc')
    term.writeln('\x1B[1;3;31mxterm.js\x1B[0m: Monitoring tool control');
    term.writeln('Type "help" for a list of possible commands')
    prompt(term);
}

function out(output) {
    term.write(`\r\n${output}`)
}

function returnApplications() {
    socket.emit('possible', (possibilities) => {
        out("Applications:")
        for (app of possibilities) {
            out(`  ${app}`);
        }
        prompt(term); 
    })
}

function returnHelp(arg) {
    // italic: out(\x1B[3mtext\x1B[m)

    if (typeof arg == 'undefined') {
        out("clear          \x1B[3mClears the terminal\x1B[m")
        out("reset ##TODO   \x1B[3mApplications are stopped and cleared\x1B[m");
        out("'app' arg1     \x1B[3mExecute command arg1 on application 'app'\x1B[m")
        out("load arg1      \x1B[3mLoads application arg1 to the tool\x1B[m");
        out("list           \x1B[3mLists all the possible applications\x1B[m ")

        out("")
        out("Use 'help app' for more information for application 'app'");
        prompt(term);
    } else {
        // Get info of plugin obj
        socket.emit("functions", arg, (result) => {
            if (result.length == 0) {
                out(`Application ${arg} does not exist or has no possible commands`)
            } else {
                out("Possible commands for application '" + arg + "'")
                for (f of result) {
                    out(`   ${f}`)
                }
            }
            prompt(term);
        })
    }

}

runTerminal(); 