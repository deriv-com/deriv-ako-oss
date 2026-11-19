// Slack's Socket Mode: AKO opens a WebSocket to Slack and receives events and
// button clicks over it, so Slack never has to reach AKO. That is why the bot
// needs no public URL, open port or tunnel.
//
// Every envelope is acknowledged straight away (Slack retries after three
// seconds otherwise), then handled. When Slack asks to reconnect, or the
// socket drops, a new connection is opened with growing back-off.

import { createSlackClient } from "./slack.js";

export function connectSocketMode({
  appToken,
  onEnvelope,
  log = () => {},
  fetch = globalThis.fetch,
  WebSocketImpl = globalThis.WebSocket,
  setTimer = setTimeout,
}) {
  if (!WebSocketImpl) throw new Error("This Node.js has no WebSocket. AKO needs Node.js 22 or later.");
  let socket = null;
  let stopped = false;
  let attempt = 0;

  async function open() {
    const { url } = await createSlackClient({ token: appToken, fetch }).call("apps.connections.open");
    socket = new WebSocketImpl(url);
    socket.addEventListener("message", (event) => receive(event.data));
    socket.addEventListener("close", () => {
      if (!stopped) reconnect();
    });
    socket.addEventListener("error", () => {});
  }

  async function receive(data) {
    let envelope;
    try {
      envelope = JSON.parse(String(data));
    } catch {
      return;
    }
    if (envelope.type === "hello") {
      attempt = 0;
      log("Connected to Slack.");
      return;
    }
    if (envelope.type === "disconnect") {
      log("Slack asked AKO to reconnect.");
      socket?.close();
      return;
    }
    if (envelope.envelope_id) socket.send(JSON.stringify({ envelope_id: envelope.envelope_id }));
    try {
      await onEnvelope(envelope);
    } catch (error) {
      log(`Couldn't handle a Slack ${envelope.type} event: ${error.message}`);
    }
  }

  function reconnect() {
    attempt += 1;
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5));
    log(`Slack connection closed. Reconnecting in ${Math.round(delay / 1000)}s.`);
    setTimer(() => open().catch((error) => {
      log(`Couldn't reconnect to Slack: ${error.message}`);
      reconnect();
    }), delay);
  }

  return {
    start: open,
    stop() {
      stopped = true;
      socket?.close();
    },
    receive, // for tests
  };
}
