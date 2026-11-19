import { test } from "node:test";
import assert from "node:assert/strict";
import { connectSocketMode } from "../../src/chat/socketMode.js";
import { fakeFetch } from "../helpers/fakes.js";

class FakeSocket {
  static opened = [];
  constructor(url) {
    this.url = url;
    this.sent = [];
    this.listeners = {};
    FakeSocket.opened.push(this);
  }
  addEventListener(type, fn) {
    this.listeners[type] = fn;
  }
  send(data) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.listeners.close?.();
  }
  emit(data) {
    return this.listeners.message({ data: JSON.stringify(data) });
  }
}

test("Socket Mode acknowledges every envelope before handling it, and reconnects when asked", async () => {
  FakeSocket.opened = [];
  let n = 0;
  const fetch = fakeFetch([["POST", /apps\.connections\.open$/, () => ({ ok: true, url: `wss://slack.test/${++n}` })]]);
  const handled = [];
  const timers = [];
  const logs = [];
  const socket = connectSocketMode({
    appToken: "xapp-test",
    fetch,
    WebSocketImpl: FakeSocket,
    setTimer: (fn, ms) => timers.push({ fn, ms }),
    log: (line) => logs.push(line),
    onEnvelope: async (envelope) => {
      assert.deepEqual(FakeSocket.opened[0].sent.at(-1), { envelope_id: envelope.envelope_id }, "acknowledged first");
      handled.push(envelope.type);
      if (envelope.payload?.fail) throw new Error("boom");
    },
  });
  await socket.start();
  assert.equal(fetch.calls[0].url, "https://slack.com/api/apps.connections.open");
  const first = FakeSocket.opened[0];
  assert.equal(first.url, "wss://slack.test/1");

  await first.emit({ type: "hello" });
  await first.emit({ type: "events_api", envelope_id: "e1", payload: {} });
  await first.emit({ type: "interactive", envelope_id: "e2", payload: { fail: true } });
  await first.emit("not json");
  assert.deepEqual(handled, ["events_api", "interactive"]);
  assert.deepEqual(first.sent, [{ envelope_id: "e1" }, { envelope_id: "e2" }]);
  assert.match(logs.join("\n"), /Couldn't handle a Slack interactive event: boom/);

  // Slack asks to reconnect: a new connection after a back-off
  await first.emit({ type: "disconnect" });
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, 2000);
  timers[0].fn();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(FakeSocket.opened.length, 2);
  assert.equal(FakeSocket.opened[1].url, "wss://slack.test/2");

  // Stopping closes without reconnecting
  socket.stop();
  assert.equal(timers.length, 1);
});

test("Socket Mode needs a WebSocket, which Node.js has from version 22", () => {
  assert.throws(() => connectSocketMode({ appToken: "xapp", onEnvelope() {}, WebSocketImpl: null }), /Node.js 22 or later/);
});
