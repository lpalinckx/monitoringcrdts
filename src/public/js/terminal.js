const socket = io();

let term = new Terminal({
    'theme': { foreground: '#000', background: '#e8e8e8', cursor: '#000' }
});
term.open(document.getElementById("terminal"));
let currLine = "";

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
                console.log(currLine);
                socket.emit('term', currLine, (result) => {
                    out(result)
                    currLine = "";
                    prompt(term);
                });
                break;
            case '\u0003': // Ctrl+C
                currLine = "";
                prompt(term);
                break;
            case '\u007F': // Backspace (DEL)
                // Do not delete the prompt
                if (term._core.buffer.x > 2) {
                    term.write('\b \b');
                }
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

function out(output) {
    term.write(`\r\n${output}`)
}

runTerminal(); 