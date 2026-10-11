// Single WebSocket connection to the server, shared by lobby and game.
// The first message after connecting is the login token.

function serverUrl() {
    // Optional override for testing, e.g. ?server=192.168.0.10:8000
    const override = new URLSearchParams(location.search).get("server");
    const host = override || location.host;
    const protocol = location.protocol === "https:" ? "wss" : "ws";
    return `${protocol}://${host}/ws`;
}

export class Connection {
    constructor({ onMessage, onStatus }) {
        this.onMessage = onMessage;
        this.onStatus = onStatus;
        this.socket = null;
    }

    connect(token) {
        this.close();
        const socket = new WebSocket(serverUrl());
        this.socket = socket;
        this.onStatus("connecting");
        socket.addEventListener("open", () => {
            socket.send(JSON.stringify({ type: "auth", token }));
            this.onStatus("open");
        });
        socket.addEventListener("close", () => {
            // Ignore sockets we closed on purpose (logout, reconnect).
            if (this.socket === socket) {
                this.socket = null;
                this.onStatus("closed");
            }
        });
        socket.addEventListener("message", (event) => {
            let data;
            try {
                data = JSON.parse(event.data);
            } catch {
                return;
            }
            this.onMessage(data);
        });
    }

    close() {
        const socket = this.socket;
        this.socket = null;
        socket?.close();
    }

    send(message) {
        if (this.socket && this.socket.readyState === WebSocket.OPEN) {
            this.socket.send(JSON.stringify(message));
        }
    }
}
