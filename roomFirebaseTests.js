// roomFirebaseTests.js — tests the Firebase transport logic against an in-memory fake of the Realtime Database.
import { FirebaseRoomClient } from "./roomClientFirebase.js";

function createFakeServer() {
  const tree = {};
  const listeners = []; // {path, type, cb, client}
  const seg = (p) => p.split("/").filter(Boolean);
  const getAt = (path) => seg(path).reduce((n, k) => (n == null ? undefined : n[k]), tree);
  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  const snap = (path) => {
    const v = getAt(path);
    return {
      key: seg(path).at(-1) ?? null, ref: { path },
      exists: () => v !== undefined && v !== null, val: () => clone(v),
      forEach(fn) { if (v && typeof v === "object") for (const k of Object.keys(v)) fn(snap(`${path}/${k}`)); },
    };
  };
  const setAt = (path, val) => {
    const parts = seg(path);
    let n = tree;
    for (const k of parts.slice(0, -1)) n = n[k] ??= {};
    if (val === undefined || val === null) delete n[parts.at(-1)]; else n[parts.at(-1)] = clone(val);
  };
  const notifyValue = (path) => {
    for (const l of [...listeners]) {
      if (l.type !== "value" || l.path.startsWith(".info")) continue;
      if (l.path === path || l.path.startsWith(path + "/") || path.startsWith(l.path + "/")) l.cb(snap(l.path));
    }
  };
  let counter = 0;
  const disconnectOps = new Map();
  const connListeners = new Map();

  function client(id) {
    disconnectOps.set(id, []);
    connListeners.set(id, new Set());
    return {
      ref: (path) => ({ path }),
      get: async (r) => snap(r.path),
      set: async (r, v) => { setAt(r.path, v); notifyValue(r.path); },
      remove: async (r) => { setAt(r.path, undefined); notifyValue(r.path); },
      push: (r, v) => {
        const key = `k${String(++counter).padStart(6, "0")}`;
        const path = `${r.path}/${key}`;
        setAt(path, v);
        for (const l of [...listeners]) if (l.type === "child" && l.path === r.path) l.cb(snap(path));
        const p = Promise.resolve({ key, path });
        return p;
      },
      onValue: (r, cb) => {
        if (r.path === ".info/connected") {
          connListeners.get(id).add(cb);
          queueMicrotask(() => cb({ val: () => true }));
          return () => connListeners.get(id).delete(cb);
        }
        const l = { path: r.path, type: "value", cb };
        listeners.push(l);
        queueMicrotask(() => cb(snap(r.path)));
        return () => listeners.splice(listeners.indexOf(l), 1);
      },
      onChildAdded: (r, cb) => {
        const l = { path: r.path, type: "child", cb };
        listeners.push(l);
        queueMicrotask(() => snap(r.path).forEach((c) => cb(c)));
        return () => listeners.splice(listeners.indexOf(l), 1);
      },
      onDisconnect: (r) => ({ remove: async () => { disconnectOps.get(id).push(r.path); } }),
    };
  }
  return {
    client,
    drop(id) { // abrupt connection loss: server runs onDisconnect ops
      for (const p of disconnectOps.get(id)) { setAt(p, undefined); notifyValue(p); }
      disconnectOps.set(id, []);
      connListeners.get(id).forEach((cb) => cb({ val: () => false }));
    },
    restore(id) { connListeners.get(id).forEach((cb) => cb({ val: () => true })); },
    tree,
  };
}

const tick = () => new Promise((r) => setTimeout(r, 5));
const tests = [];
const test = (n, f) => tests.push({ n, f });
const eq = (a, b, l) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${l}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };

function pair() {
  const srv = createFakeServer();
  const host = new FirebaseRoomClient({ backend: srv.client("h"), sid: "sid-host" });
  const guest = new FirebaseRoomClient({ backend: srv.client("g"), sid: "sid-guest" });
  const log = { h: [], g: [] };
  for (const [k, c] of [["h", host], ["g", guest]]) {
    c.on("peer_connected", () => log[k].push("connected"));
    c.on("peer_disconnected", () => log[k].push("disconnected"));
    c.on("message", (m) => log[k].push(m));
  }
  return { srv, host, guest, log };
}

test("create + join connects both sides", async () => {
  const { host, guest, log } = pair();
  const code = await host.createRoom("ABC123");
  eq(code, "ABC123", "code");
  await tick();
  eq(log.h, [], "host before guest");
  await guest.joinRoom("abc123");
  await tick();
  eq(log.h, ["connected"], "host sees guest");
  eq(log.g, ["connected"], "guest sees host");
});

test("messages flow both ways, once, in order, and are cleaned up", async () => {
  const { srv, host, guest, log } = pair();
  await host.createRoom("ROOM1"); await guest.joinRoom("ROOM1"); await tick();
  log.h.length = 0; log.g.length = 0;
  host.send({ type: "A", n: 1 }); host.send({ type: "A", n: 2 });
  guest.send({ type: "B", n: 1 });
  await tick();
  eq(log.g, [{ type: "A", n: 1 }, { type: "A", n: 2 }], "guest got");
  eq(log.h, [{ type: "B", n: 1 }], "host got");
  eq(Object.keys(srv.tree.rooms.ROOM1.msgs ?? {}).length, 0, "mailbox emptied");
});

test("old messages are not replayed to a late joiner", async () => {
  const { host, guest, log } = pair();
  await host.createRoom("LATE1");
  host.send({ type: "OLD" });
  await tick();
  await guest.joinRoom("LATE1"); await tick();
  eq(log.g.filter((m) => m.type === "OLD").length, 0, "no replay");
});

test("duplicate code, missing room, full room, bad code", async () => {
  const { srv, host, guest } = pair();
  await host.createRoom("DUPE1");
  const other = new FirebaseRoomClient({ backend: srv.client("x"), sid: "sid-stranger" });
  let e1 = ""; try { await other.createRoom("DUPE1"); } catch (e) { e1 = e.message; }
  if (!/already in use/.test(e1)) throw new Error("expected in-use error: " + e1);
  let e2 = ""; try { await guest.joinRoom("NOPE99"); } catch (e) { e2 = e.message; }
  if (!/not found/.test(e2)) throw new Error("expected not-found error: " + e2);
  await guest.joinRoom("DUPE1");
  let e3 = ""; try { await other.joinRoom("DUPE1"); } catch (e) { e3 = e.message; }
  if (!/two players/.test(e3)) throw new Error("expected full error: " + e3);
  let e4 = ""; try { await other.createRoom("bad code!"); } catch (e) { e4 = e.message; }
  if (!/3-8/.test(e4)) throw new Error("expected bad-code error: " + e4);
});

test("connection drop -> peer_disconnected, reconnect -> peer_connected again", async () => {
  const { srv, host, guest, log } = pair();
  await host.createRoom("DROP1"); await guest.joinRoom("DROP1"); await tick();
  log.h.length = 0;
  srv.drop("g"); await tick();
  eq(log.h, ["disconnected"], "host notices drop");
  srv.restore("g"); await tick();
  eq(log.h, ["disconnected", "connected"], "host notices return");
  guest.send({ type: "BACK" }); await tick();
  eq(log.h.at(-1), { type: "BACK" }, "messages flow after reconnect");
});

test("disconnect() leaves the room cleanly", async () => {
  const { host, guest, log } = pair();
  await host.createRoom("BYE11"); await guest.joinRoom("BYE11"); await tick();
  guest.disconnect(); await tick();
  eq(log.h.at(-1), "disconnected", "host sees guest leave");
});

test("refreshed host reclaims its room and resumes its saved match", async () => {
  const srv = createFakeServer();
  const mk = (id, sid) => new FirebaseRoomClient({ backend: srv.client(id), sid });
  const host1 = mk("h1", "sid-host");
  await host1.createRoom("SAVE1");
  await host1.saveState({ turn: 4, status: "IN_PROGRESS", hp: 77 });
  srv.drop("h1"); // tab closed: server removes host presence, state stays
  host1.disconnect();
  const host2 = mk("h2", "sid-host"); // same browser, new page load
  await host2.createRoom("SAVE1");
  eq(await host2.loadState(), { turn: 4, status: "IN_PROGRESS", hp: 77 }, "resumed state");
});

test("a stranger cannot load or take over someone else's saved match", async () => {
  const srv = createFakeServer();
  const host = new FirebaseRoomClient({ backend: srv.client("h"), sid: "sid-host" });
  await host.createRoom("PRIV1");
  await host.saveState({ turn: 2 });
  srv.drop("h"); host.disconnect();
  const thief = new FirebaseRoomClient({ backend: srv.client("t"), sid: "sid-thief" });
  await thief.createRoom("PRIV1"); // free code for a stranger, but the old room is wiped
  eq(await thief.loadState(), null, "no access to old state");
});

test("refreshed guest reclaims its seat immediately (no 'two players' error)", async () => {
  const { srv, host, guest, log } = pair();
  await host.createRoom("SEAT1"); await guest.joinRoom("SEAT1"); await tick();
  // Tab refresh: old page's listeners die, but its seat (presence node) lingers on the server.
  for (const u of guest._unsubs) u();
  const guest2 = new FirebaseRoomClient({ backend: srv.client("g2"), sid: "sid-guest" });
  await guest2.joinRoom("SEAT1"); // seat exists, same sid -> allowed
  await tick();
  const got = []; guest2.on("message", (m) => got.push(m));
  host.send({ type: "X" }); await tick();
  eq(got.some((m) => m.type === "X"), true, "new guest session receives messages");
});

test("clearState removes the saved match", async () => {
  const { host } = pair();
  await host.createRoom("CLR11");
  await host.saveState({ a: 1 });
  await host.clearState();
  eq(await host.loadState(), null, "cleared");
});

let failed = 0;
for (const { n, f } of tests) {
  try { await f(); console.log(`PASS  ${n}`); } catch (e) { failed++; console.log(`FAIL  ${n}\n      ${e.message}`); }
}
console.log(`\n${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
