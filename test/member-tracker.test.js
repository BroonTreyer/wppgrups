import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { MemberTracker } from "../src/services/member-tracker.js";

class MemoryStore {
  constructor(state = {}) { this.state = structuredClone(state); }
  async read() { return structuredClone(this.state); }
  async update(mutator) { return mutator(this.state); }
}

const GROUP = "120363431078469154-group";
const config = { meta: { trackedGroups: [GROUP], eventName: "Subscribe", eventSourceUrl: "https://ponte/", testEventCode: "" } };
const sha = (value) => createHash("sha256").update(value).digest("hex");
const people = (...phones) => ({ subject: "Achadinhos da Isa #5", participants: phones.map((phone) => ({ phone })) });

function setup({ members = people("5562911110001", "5562911110002", "5562911110003", "5562911110004"), capi, now = "2026-09-14T03:00:00Z" } = {}) {
  const store = new MemoryStore();
  const zapi = { current: members, async getGroupMetadata() { return this.current; } };
  const sent = [];
  const client = capi ?? { configured: true, async send(events) { sent.push(...events); return { events_received: events.length }; } };
  const clock = { now: new Date(now) };
  const tracker = new MemberTracker({ store, zapi, capi: client, config, clock: () => clock.now });
  return { store, zapi, sent, tracker, clock };
}

test("a primeira leitura so fotografa: quem ja estava no grupo nao vira conversao", async () => {
  const { tracker, sent, store } = setup();
  const result = await tracker.tick();
  assert.equal(result.groups[0].baseline, 4);
  assert.equal(sent.length, 0);
  assert.equal(store.state.memberTracking.joins.length, 0);
});

test("quem entra vira evento com telefone em hash, nunca o numero cru", async () => {
  const { tracker, zapi, sent, store } = setup();
  await tracker.tick();
  zapi.current = people("5562911110001", "5562911110002", "5562911110003", "5562911110004", "5521999990005");
  const result = await tracker.tick();

  assert.equal(result.groups[0].joined, 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].event_name, "Subscribe");
  assert.deepEqual(sent[0].user_data.ph, [sha("5521999990005")]);
  assert.deepEqual(sent[0].user_data.country, [sha("br")]);
  assert.equal(sent[0].action_source, "website");
  assert.doesNotMatch(JSON.stringify(store.state), /5521999990005/, "o store nao guarda telefone");
  assert.equal(store.state.memberTracking.joins[0].status, "sent");
});

test("sair e voltar nao conta de novo", async () => {
  const { tracker, zapi, sent } = setup();
  await tracker.tick();
  const base = ["5562911110001", "5562911110002", "5562911110003", "5562911110004"];
  zapi.current = people(...base, "5521999990005");
  await tracker.tick();
  zapi.current = people(...base);
  await tracker.tick();
  zapi.current = people(...base, "5521999990005");
  const result = await tracker.tick();
  assert.equal(result.groups[0].joined, 0);
  assert.equal(sent.length, 1);
});

test("retencao: marca quem entrou e saiu, e desmarca quem voltou", async () => {
  const { tracker, zapi, store } = setup();
  const base = ["5562911110001", "5562911110002", "5562911110003", "5562911110004"];
  await tracker.tick();
  zapi.current = people(...base, "5521999990005", "5521999990006");
  await tracker.tick();
  zapi.current = people(...base, "5521999990006");
  await tracker.tick();

  let status = await tracker.status();
  assert.equal(status.joins.total, 2);
  assert.equal(status.joins.stillIn, 1);
  assert.equal(status.joins.left, 1);
  const saiu = store.state.memberTracking.joins.find((join) => join.phoneHash === sha("5521999990005"));
  assert.ok(saiu.leftAt);

  zapi.current = people(...base, "5521999990005", "5521999990006");
  await tracker.tick();
  status = await tracker.status();
  assert.equal(status.joins.stillIn, 2, "voltou, conta como presente");
  assert.equal(status.joins.total, 2, "e nao vira entrada nova");
});

test("leitura que encolhe o grupo de repente e ignorada, senao a seguinte viraria leva falsa de entradas", async () => {
  const { tracker, zapi, sent, store } = setup();
  await tracker.tick();
  zapi.current = people("5562911110001");
  const ruim = await tracker.tick();
  assert.equal(ruim.groups[0].ignored, true);
  assert.equal(store.state.memberTracking.groups[GROUP].members.length, 4);

  zapi.current = people("5562911110001", "5562911110002", "5562911110003", "5562911110004");
  const boa = await tracker.tick();
  assert.equal(boa.groups[0].joined, 0);
  assert.equal(sent.length, 0);
});

test("lista vazia e erro, nao debandada", async () => {
  const { tracker, zapi } = setup();
  await tracker.tick();
  zapi.current = { participants: [] };
  const result = await tracker.tick();
  assert.match(result.groups[0].error, /sem participantes/);
});

test("sem token a entrada e medida e fica pendente para enviar depois", async () => {
  const { tracker, zapi, store } = setup({ capi: { configured: false, async send() { throw new Error("nao devia enviar"); } } });
  await tracker.tick();
  zapi.current = people("5562911110001", "5562911110002", "5562911110003", "5562911110004", "5521999990005");
  const result = await tracker.tick();
  assert.equal(result.pending, 1);
  assert.equal(store.state.memberTracking.joins[0].status, "pending");
});

test("falha do Meta mantem pendente e conta a tentativa", async () => {
  const { tracker, zapi, store } = setup({ capi: { configured: true, async send() { throw new Error("Meta 400: token invalido"); } } });
  await tracker.tick();
  zapi.current = people("5562911110001", "5562911110002", "5562911110003", "5562911110004", "5521999990005");
  const result = await tracker.tick();
  assert.match(result.error, /token invalido/);
  const join = store.state.memberTracking.joins[0];
  assert.equal(join.status, "pending");
  assert.equal(join.attempts, 1);
});

test("entrada com mais de 7 dias expira em vez de ser recusada pelo Meta", async () => {
  const { tracker, zapi, store, sent, clock } = setup({ capi: { configured: false } });
  await tracker.tick();
  zapi.current = people("5562911110001", "5562911110002", "5562911110003", "5562911110004", "5521999990005");
  await tracker.tick();
  clock.now = new Date("2026-09-22T03:00:00Z");
  tracker.capi = { configured: true, async send(events) { sent.push(...events); } };
  const result = await tracker.tick();
  assert.equal(result.expired, 1);
  assert.equal(sent.length, 0);
  assert.equal(store.state.memberTracking.joins[0].status, "expired");
});
