import test from "node:test";
import assert from "node:assert/strict";
import { PublicationService } from "../src/services/publication-service.js";
import { SAMPLE_OFFER } from "../src/mock/sample-offer.js";

class MemoryStore {
  constructor(state) { this.state = structuredClone(state); }
  async read() { return structuredClone(this.state); }
  async update(mutator) { return mutator(this.state); }
}

const OFFER = { ...SAMPLE_OFFER, affiliateUrl: "https://meli.la/AbC123" };
const config = { dryRun: true, allowUntaggedLinks: false, zapi: { channelImageEnabled: false }, limits: { deduplicationHours: 24, republishCooldownDays: 30 } };
const build = (state, overrides = {}) => new PublicationService({
  store: new MemoryStore(state),
  zapi: { sendImage: async () => ({ messageId: "sent" }) },
  config: { ...config, ...overrides },
  clock: () => new Date("2026-09-02T16:00:00Z")
});

const destination = (id, nicheIds, extra = {}) => ({ id, name: id, type: "group", nicheIds, active: true, minDiscount: 0, maxDailyPosts: 12, minMinutesBetweenPosts: 0, ...extra });

test("publica somente nos grupos com nicho correspondente", async () => {
  const service = build({
    destinations: [destination("tv-group", ["electronics"], { minDiscount: 10 }), destination("beauty-group", ["beauty"])],
    publications: [], deliveryEvents: [], offers: [], queue: []
  });
  const result = await service.publish(OFFER);
  assert.equal(result.matchedDestinations, 1);
  assert.equal(result.results[0].destinationId, "tv-group");
});

test("nao repete o mesmo produto no destino mesmo com preco diferente", async () => {
  const service = build({
    destinations: [destination("tv-group", ["electronics"])],
    publications: [{
      id: "anterior", productKey: "Marketplace Demo:demo-smart-tv-50", destinationId: "tv-group",
      status: "sent", createdAt: "2026-08-20T17:00:00Z"
    }],
    deliveryEvents: [], offers: [], queue: []
  });
  const result = await service.publish({ ...OFFER, currentPrice: 2098, originalPrice: 2899 });
  assert.equal(result.matchedDestinations, 0);
});

test("libera o produto depois do periodo de carencia", async () => {
  const service = build({
    destinations: [destination("tv-group", ["electronics"])],
    publications: [{
      id: "antigo", productKey: "Marketplace Demo:demo-smart-tv-50", destinationId: "tv-group",
      status: "sent", createdAt: "2026-06-01T17:00:00Z"
    }],
    deliveryEvents: [], offers: [], queue: []
  });
  const result = await service.publish(OFFER);
  assert.equal(result.matchedDestinations, 1);
});

test("reconhece publicacoes antigas gravadas so com fingerprint", async () => {
  const service = build({
    destinations: [destination("tv-group", ["electronics"])],
    publications: [{
      id: "legado", offerFingerprint: "Marketplace Demo:demo-smart-tv-50:2199.00", destinationId: "tv-group",
      status: "sent", createdAt: "2026-08-30T17:00:00Z"
    }],
    deliveryEvents: [], offers: [], queue: []
  });
  const result = await service.publish({ ...OFFER, currentPrice: 1999 });
  assert.equal(result.matchedDestinations, 0);
});

test("bloqueia publicacao de oferta sem link de afiliado atribuido", async () => {
  const service = build({ destinations: [destination("tv-group", ["electronics"])], publications: [], deliveryEvents: [], offers: [], queue: [] });
  await assert.rejects(
    () => service.publish({ ...OFFER, affiliateUrl: "https://www.mercadolivre.com.br/p/MLB1" }),
    /sem link de afiliado atribuido/
  );
});

test("guarda a chave do produto na publicacao", async () => {
  const store = new MemoryStore({ destinations: [destination("tv-group", ["electronics"])], publications: [], deliveryEvents: [], offers: [], queue: [] });
  const service = new PublicationService({ store, zapi: { sendImage: async () => ({ messageId: "x" }) }, config, clock: () => new Date("2026-09-02T16:00:00Z") });
  await service.publish(OFFER);
  assert.equal(store.state.publications[0].productKey, "Marketplace Demo:demo-smart-tv-50");
});

test("nao manda produto caro demais para o publico do destino", async () => {
  const service = build({
    destinations: [destination("tv-group", ["electronics"], { maxPrice: 300 })],
    publications: [], deliveryEvents: [], offers: [], queue: []
  });
  const result = await service.publish({ ...OFFER, currentPrice: 2199 });
  assert.equal(result.matchedDestinations, 0);
  assert.match(result.blocked[0].reason, /passa do teto/);
});

test("exige procura minima quando o destino pede", async () => {
  const service = build({
    destinations: [destination("tv-group", ["electronics"], { minSold: 5000 })],
    publications: [], deliveryEvents: [], offers: [], queue: []
  });
  const result = await service.publish({ ...OFFER, soldCount: 120 });
  assert.equal(result.matchedDestinations, 0);
  assert.match(result.blocked[0].reason, /pouca procura/);
});

// --- curva de cadencia -------------------------------------------------------

const naHora = (state, isoUtc, overrides = {}) => new PublicationService({
  store: new MemoryStore(state),
  zapi: { sendImage: async () => ({ messageId: "sent" }) },
  config: { ...config, ...overrides },
  clock: () => new Date(isoUtc)
});

test("destino que exige nicho confiavel barra palpite de palavra e aceita colheita, IA e categoria", () => {
  const destino = destination("g5", ["beauty"], { requireTrustedNiche: true });
  const estado = { destinations: [destino], publications: [], deliveryEvents: [], offers: [], queue: [] };
  const service = build(estado);
  const motivo = (offer) => service.permanentBlockReason({ destination: destino, offer: { ...OFFER, ...offer }, nicheIds: ["beauty", "general"] });

  // O caso real de 14/09/2026: vitrine de outra categoria, nicho so pela regra.
  assert.match(String(motivo({ title: "Coletor De Urina Portatil Para Carro", category: "Saude", nicheSource: "regra" })), /fonte confiavel/);
  assert.match(String(motivo({ title: "Touca Rede De Cozinha", category: null })), /fonte confiavel/);

  assert.equal(motivo({ nicheSource: "colheita" }), null, "colheita das lojas de beleza");
  assert.equal(motivo({ sourceContext: { origem: "extensao" } }), null, "colheita antiga, anterior ao nicheSource");
  assert.equal(motivo({ nicheSource: "ia" }), null, "decisao da IA (inclusive cache)");
  assert.equal(motivo({ category: "Beleza e Cuidado Pessoal", nicheSource: "regra" }), null, "categoria do marketplace");

  const semExigencia = destination("g4", ["beauty"]);
  assert.equal(service.permanentBlockReason({ destination: semExigencia, offer: { ...OFFER, nicheSource: "regra" }, nicheIds: ["beauty"] }), null, "destino que nao pediu segue como antes");
});

test("a madrugada nao publica; as 5h volta", async () => {
  const estado = { destinations: [destination("g", ["electronics"])], publications: [], deliveryEvents: [], offers: [], queue: [] };
  // 06:00 UTC = 03:00 em Brasilia. Foi 24h de 11/09 a 14/09/2026; o dono do canal
  // fechou a noite de novo (5h-22h) depois de ver 139 mensagens por hora de madrugada.
  const motivo = (iso) => naHora(estado, iso).blockReason({
    destination: estado.destinations[0], offer: OFFER, nicheIds: ["electronics"], publications: [], now: new Date(iso)
  });
  assert.notEqual(motivo("2026-09-02T06:00:00Z"), null, "3h fechado");
  assert.equal(motivo("2026-09-02T08:00:00Z"), null, "5h aberto");
});

test("o teto diario barra quando cheio e libera quando ha vaga", () => {
  const destino = destination("g", ["electronics"], { maxDailyPosts: 3 });
  const estado = { destinations: [destino], publications: [], deliveryEvents: [], offers: [], queue: [] };
  const hoje = (quantos) => Array.from({ length: quantos }, (_, i) => ({
    destinationId: "g", status: "sent", createdAt: `2026-09-02T1${i}:00:00Z`, title: `Item ${i}`, nicheIds: ["home"]
  }));
  const motivo = (quantos) => naHora(estado, "2026-09-02T23:30:00Z").blockReason({
    destination: destino, offer: OFFER, nicheIds: ["electronics"],
    publications: hoje(quantos), now: new Date("2026-09-02T23:30:00Z")
  });
  assert.equal(motivo(2), null);
  assert.match(String(motivo(3)), /limite diario atingido \(3\/3\)/);
});

test("destino SEM teto diario nunca e barrado por limite", () => {
  // Em JS `n >= null` vira `n >= 0` e e sempre verdadeiro: lendo o campo cru,
  // um destino sem teto era barrado ja na PRIMEIRA publicacao do dia, e a
  // mensagem dizia "limite diario atingido (0/null)". O destino emudecia por
  // completo, com a fila cheia e sem erro em lugar nenhum.
  const destino = destination("g", ["electronics"], { maxDailyPosts: null });
  const estado = { destinations: [destino], publications: [], deliveryEvents: [], offers: [], queue: [] };
  const comHistorico = (quantos) => Array.from({ length: quantos }, (_, i) => ({
    destinationId: "g", status: "sent", createdAt: `2026-09-02T0${i % 10}:00:00Z`, title: `Item ${i}`, nicheIds: ["home"]
  }));
  const motivo = (quantos) => naHora(estado, "2026-09-02T23:30:00Z").blockReason({
    destination: destino, offer: OFFER, nicheIds: ["electronics"],
    publications: comHistorico(quantos), now: new Date("2026-09-02T23:30:00Z")
  });
  assert.equal(motivo(0), null, "barrou logo na primeira do dia");
  assert.equal(motivo(5000), null, "barrou depois de 5000 no dia");
});

test("dentro da rajada vale o intervalo do destino; fora, nada sai", () => {
  const destino = destination("g", ["electronics"], { minMinutesBetweenPosts: 12 });
  const estado = { destinations: [destino], publications: [], deliveryEvents: [], offers: [], queue: [] };
  const publicacoes = (iso) => [{ destinationId: "g", status: "sent", createdAt: iso, title: "Outro", nicheIds: ["home"] }];
  const motivo = (agoraIso, ultimaIso) => naHora(estado, agoraIso).blockReason({
    destination: destino, offer: OFFER, nicheIds: ["electronics"],
    publications: publicacoes(ultimaIso), now: new Date(agoraIso)
  });

  // 22:13 UTC = 19:13 BRT, rajada da noite: 13 min depois do ultimo, ja pode.
  assert.equal(motivo("2026-09-02T22:13:00Z", "2026-09-02T22:00:00Z"), null);
  // 22:05 UTC: ainda dentro dos 12 min.
  assert.match(String(motivo("2026-09-02T22:05:00Z", "2026-09-02T22:00:00Z")), /aguardando o intervalo de 12 min/);
  // A noite fechou de novo (14/09/2026): 23:13 BRT bloqueia mesmo com o intervalo cumprido.
  assert.notEqual(motivo("2026-09-03T02:13:00Z", "2026-09-03T02:00:00Z"), null);
});

test("com a curva desligada o intervalo volta a ser fixo", () => {
  const destino = destination("g", ["electronics"], { minMinutesBetweenPosts: 12 });
  const estado = { destinations: [destino], publications: [], deliveryEvents: [], offers: [], queue: [] };
  const madrugada = new Date("2026-09-02T06:00:00Z"); // 3h BRT
  const motivo = naHora(estado, madrugada.toISOString(), { timingCurve: false }).blockReason({
    destination: destino, offer: OFFER, nicheIds: ["electronics"], publications: [], now: madrugada
  });
  assert.equal(motivo, null, "sem curva, a madrugada nao bloqueia");
});

test("o canal recusa o que nao serve ao publico dele", () => {
  // O nicho diz o assunto, nao para quem. Maquina de cortar cabelo, peruca,
  // cabeca de manequim e tenis masculino sao todos "beleza" ou "moda", e
  // nenhum serve a um canal feminino.
  const isa = destination("isa", ["beauty", "fashion"], {
    blockedKeywords: ["masculino", "unissex", "peruca", "manequim", "maquina de cortar cabelo", "barba"]
  });
  const estado = { destinations: [isa], publications: [], deliveryEvents: [], offers: [], queue: [] };
  const service = naHora(estado, "2026-09-02T16:00:00Z"); // 13h BRT, rajada
  const recusa = (title, nicheIds) => service.blockReason({
    destination: isa, offer: { ...OFFER, title }, nicheIds,
    publications: [], now: new Date("2026-09-02T16:00:00Z")
  });

  for (const [titulo, nichos] of [
    ["Maquina De Cortar Cabelo Profissional Barbeiro", ["beauty"]],
    ["Cabeca Manequim Isopor Branco Suporte Perucas", ["beauty"]],
    ["Tenis Aramis Masculino Casual Couro", ["fashion"]],
    ["Moletom Canguru Liso Algodao Unissex", ["fashion"]]
  ]) {
    assert.match(String(recusa(titulo, nichos)), /publico deste canal/, titulo);
  }

  // E deixa passar o que e do publico.
  assert.equal(recusa("Kerastase Nutritive Bain Satin 250ml", ["beauty"]), null);
  assert.equal(recusa("Base Liquida Vult Cobertura Alta", ["beauty"]), null);
});

test("o bloqueio casa palavra inteira, nao pedaco", () => {
  const isa = destination("isa", ["home"], { blockedKeywords: ["barba", "sunga"] });
  const estado = { destinations: [isa], publications: [], deliveryEvents: [], offers: [], queue: [] };
  const service = naHora(estado, "2026-09-02T16:00:00Z");
  const motivo = (title) => service.blockReason({
    destination: isa, offer: { ...OFFER, title }, nicheIds: ["home"],
    publications: [], now: new Date("2026-09-02T16:00:00Z")
  });
  // "barbante" contem "barba" mas nao e produto de barba.
  assert.equal(motivo("Barbante Colorido 200g Para Croche"), null);
  assert.match(String(motivo("Kit 3 Sungas Masculinas")), /publico deste canal/);
});

test("em roupa e calcado o canal exige marcacao feminina", () => {
  // Bloquear marca masculina uma a uma e enxugar gelo: nenhum destes diz
  // "masculino", e todos chegaram ao canal.
  const isa = destination("isa", ["fashion"], {
    requireAnyByNiche: { fashion: ["feminino", "feminina", "vestido", "calcinha", "sandalia"] }
  });
  const estado = { destinations: [isa], publications: [], deliveryEvents: [], offers: [], queue: [] };
  const service = naHora(estado, "2026-09-02T16:00:00Z");
  const motivo = (title) => service.blockReason({
    destination: isa, offer: { ...OFFER, title }, nicheIds: ["fashion"],
    publications: [], now: new Date("2026-09-02T16:00:00Z")
  });

  for (const titulo of ["Kit Camisetas Aramis Preta Branca Original",
                        "Tenis Reserva Go Troy Leve Confortavel",
                        "Tenis Smash V2 Puma Preto E Branco 41 Br",
                        "Mochila Tatica Impermeavel Militar Reforcada"]) {
    assert.match(String(motivo(titulo)), /marcacao de publico/, titulo);
  }
  for (const titulo of ["Tenis Feminino Vizzano Branco Casual",
                        "Calca Jeans Feminina Cos Alto",
                        "Sandalia Rasterinha Confortavel"]) {
    assert.equal(motivo(titulo), null, titulo);
  }
});

test("a exigencia so vale no nicho declarado", () => {
  const isa = destination("isa", ["fashion", "beauty"], {
    requireAnyByNiche: { fashion: ["feminino"] }
  });
  const estado = { destinations: [isa], publications: [], deliveryEvents: [], offers: [], queue: [] };
  const service = naHora(estado, "2026-09-02T16:00:00Z");
  // Beleza nao exige a marcacao: shampoo nao e peca de vestuario.
  assert.equal(service.blockReason({
    destination: isa, offer: { ...OFFER, title: "Kerastase Nutritive Bain Satin 250ml" },
    nicheIds: ["beauty"], publications: [], now: new Date("2026-09-02T16:00:00Z")
  }), null);
});

test("nada da linha de terceira idade e enfermagem", () => {
  // Pedido explicito do usuario. Doze destes estavam barrados apenas por FALTA
  // de nicho — frageis: bastaria preencher uma lacuna de vocabulario para
  // voltarem a passar. O bloqueio no destino e o que garante.
  const isa = destination("isa", ["home", "health", "beauty", "kids"], {
    blockedKeywords: ["idoso", "geriatrico", "andador", "muleta", "bengala",
      "cadeira de rodas", "cadeira de banho", "antiescara", "acamado",
      "incontinencia", "protese dentaria", "aparelho auditivo", "hospitalar"]
  });
  const estado = { destinations: [isa], publications: [], deliveryEvents: [], offers: [], queue: [] };
  const service = naHora(estado, "2026-09-02T16:00:00Z");
  const motivo = (title, nicheIds = ["health"]) => service.blockReason({
    destination: isa, offer: { ...OFFER, title }, nicheIds,
    publications: [], now: new Date("2026-09-02T16:00:00Z")
  });

  for (const titulo of [
    "Cadeira De Banho Dobravel Higienica Rodas Sanitaria Idoso",
    "Cadeira De Rodas Dobravel Aco Resistente 120kg",
    "Colchao Antiescara Pneumatico Para Acamados",
    "Andador Dobravel Aluminio Para Idosos 4 Rodas",
    "Muleta Axilar Regulavel Aluminio Par",
    "Absorvente Geriatrico Incontinencia Adulto",
    "Aparelho Auditivo Recarregavel Amplificador Surdez"
  ]) {
    assert.match(String(motivo(titulo)), /publico deste canal/, titulo);
  }

  // Saude legitima para o publico do canal continua entrando.
  assert.equal(motivo("Vitamina C 1000mg Com Zinco 120 Capsulas"), null);
  assert.equal(motivo("Colageno Verisol Com Acido Hialuronico 180 Capsulas"), null);
});

test("o mesmo titulo de outro vendedor nao sai duas vezes no mesmo canal", () => {
  const destino = destination("g", ["beauty"], { minMinutesBetweenPosts: 0 });
  const estado = { destinations: [destino], publications: [], deliveryEvents: [], offers: [], queue: [] };
  const titulo = "Secador Taiff Tourmaline Íon 2100W – Alta Performance Preto";
  // Publicado ontem sob o anuncio de um vendedor.
  const publicacoes = [{
    destinationId: "g", status: "sent", createdAt: "2026-09-09T16:00:00Z",
    productKey: "Mercado Livre:MLB5720580194", title: titulo, nicheIds: ["beauty"]
  }];
  const agora = "2026-09-10T16:00:00Z";
  // Hoje a vitrine traz o MESMO produto sob outro codigo, de outro vendedor.
  const motivo = naHora(estado, agora).blockReason({
    destination: destino,
    offer: { ...OFFER, title: titulo, externalId: "MLB5720592886", marketplace: "Mercado Livre" },
    nicheIds: ["beauty"], publications: publicacoes, now: new Date(agora)
  });
  assert.match(String(motivo), /titulo identico ja publicado/);
});

test("titulo diferente do mesmo tipo de produto continua passando", () => {
  const destino = destination("g", ["beauty"], { minMinutesBetweenPosts: 0 });
  const estado = { destinations: [destino], publications: [], deliveryEvents: [], offers: [], queue: [] };
  const publicacoes = [{
    destinationId: "g", status: "sent", createdAt: "2026-09-09T16:00:00Z",
    productKey: "Mercado Livre:MLB1", title: "Secador Taiff Style 2000w Preto", nicheIds: ["beauty"]
  }];
  const agora = "2026-09-10T16:00:00Z";
  const motivo = naHora(estado, agora).blockReason({
    destination: destino,
    offer: { ...OFFER, title: "Secador Taiff Vulcan 2500w Cinza", externalId: "MLB2", marketplace: "Mercado Livre" },
    nicheIds: ["beauty"], publications: publicacoes, now: new Date(agora)
  });
  assert.equal(motivo, null);
});

// --- rajada (burstSize) -----------------------------------------------------
// O intervalo sempre significou "um post e espere". Com `burstSize` ele passa a
// significar "N posts e espere", que e o que o grupo #5 pediu em 11/09/2026:
// 15 de uma vez a cada 10 min, em vez de um a cada 2.

const postEm = (createdAt, n) => ({
  destinationId: "g", status: "sent", createdAt,
  productKey: `Mercado Livre:MLB${n}`, title: `Serum Facial Modelo ${n}`, nicheIds: ["beauty"]
});

test("dentro da rajada o destino publica de novo sem esperar o intervalo", () => {
  const destino = destination("g", ["beauty"], { minMinutesBetweenPosts: 10, burstSize: 15, maxDailyPosts: 600 });
  const estado = { destinations: [destino], publications: [], deliveryEvents: [], offers: [], queue: [] };
  const agora = "2026-09-11T16:00:00Z";
  // Catorze ja sairam nos ultimos segundos; o decimo quinto e da mesma rajada.
  const publicacoes = Array.from({ length: 14 }, (_, i) => postEm("2026-09-11T15:59:30Z", i));
  const motivo = naHora(estado, agora).blockReason({
    destination: destino, offer: { ...OFFER, title: "Serum Facial Novo", externalId: "MLBX", marketplace: "Mercado Livre" },
    nicheIds: ["beauty"], publications: publicacoes, now: new Date(agora)
  });
  assert.equal(motivo, null);
});

test("fechada a rajada, o destino espera o intervalo inteiro", () => {
  const destino = destination("g", ["beauty"], { minMinutesBetweenPosts: 10, burstSize: 15, maxDailyPosts: 600 });
  const estado = { destinations: [destino], publications: [], deliveryEvents: [], offers: [], queue: [] };
  const agora = "2026-09-11T16:00:00Z";
  const publicacoes = Array.from({ length: 15 }, (_, i) => postEm("2026-09-11T15:59:30Z", i));
  const motivo = naHora(estado, agora).blockReason({
    destination: destino, offer: { ...OFFER, title: "Serum Facial Novo", externalId: "MLBX", marketplace: "Mercado Livre" },
    nicheIds: ["beauty"], publications: publicacoes, now: new Date(agora)
  });
  assert.match(String(motivo), /15\/15 da rajada/);
});

test("a janela da rajada conta do primeiro post, nao do ultimo", () => {
  // Sem esta ancora a rajada nunca fecharia: cada post novo empurraria a
  // liberacao para a frente e o grupo publicaria sem parar.
  const destino = destination("g", ["beauty"], { minMinutesBetweenPosts: 10, burstSize: 3 });
  const estado = { destinations: [destino], publications: [], deliveryEvents: [], offers: [], queue: [] };
  const agora = "2026-09-11T16:00:00Z";
  const publicacoes = [
    postEm("2026-09-11T15:49:00Z", 1), // 11 min atras: ja saiu da janela
    postEm("2026-09-11T15:52:00Z", 2),
    postEm("2026-09-11T15:53:00Z", 3)
  ];
  const motivo = naHora(estado, agora).blockReason({
    destination: destino, offer: { ...OFFER, title: "Serum Facial Novo", externalId: "MLBX", marketplace: "Mercado Livre" },
    nicheIds: ["beauty"], publications: publicacoes, now: new Date(agora)
  });
  assert.equal(motivo, null, "so dois posts continuam na janela de 10 min");
});

test("destino sem burstSize mantem o gotejamento de um post por intervalo", () => {
  const destino = destination("g", ["beauty"], { minMinutesBetweenPosts: 10 });
  const estado = { destinations: [destino], publications: [], deliveryEvents: [], offers: [], queue: [] };
  const agora = "2026-09-11T16:00:00Z";
  const motivo = naHora(estado, agora).blockReason({
    destination: destino, offer: { ...OFFER, title: "Serum Facial Novo", externalId: "MLBX", marketplace: "Mercado Livre" },
    nicheIds: ["beauty"], publications: [postEm("2026-09-11T15:59:00Z", 1)], now: new Date(agora)
  });
  assert.match(String(motivo), /aguardando o intervalo de 10 min: liberado as/);
});

// --- intercalar marcas ------------------------------------------------------

const postDaMarca = (createdAt, marca, n) => ({
  destinationId: "g", status: "sent", createdAt, sellerName: marca,
  productKey: `Mercado Livre:MLB${n}`, title: `Batom Liquido Modelo ${n}`, nicheIds: ["beauty"]
});

test("a mesma marca nao sai duas vezes seguidas no destino", async () => {
  // A colheita traz a loja inteira de uma vez: sem regra dura, a rajada de 15 sai
  // com 13 VULT em sequencia.
  const destino = destination("g", ["beauty"], { minMinutesBetweenPosts: 10, burstSize: 15, maxDailyPosts: 600 });
  const estado = { destinations: [destino], publications: [], deliveryEvents: [], offers: [], queue: [] };
  const agora = "2026-09-11T16:00:00Z";
  const motivo = naHora(estado, agora).blockReason({
    destination: destino,
    offer: { ...OFFER, title: "Batom Liquido Matte Novo", externalId: "MLBX", marketplace: "Mercado Livre", sellerName: "VULT" },
    nicheIds: ["beauty"], publications: [postDaMarca("2026-09-11T15:59:30Z", "VULT", 1)], now: new Date(agora)
  });
  assert.match(String(motivo), /intercalando com outra/);
});

test("outra marca passa na hora, sem esperar o intervalo", async () => {
  const destino = destination("g", ["beauty"], { minMinutesBetweenPosts: 10, burstSize: 15, maxDailyPosts: 600 });
  const estado = { destinations: [destino], publications: [], deliveryEvents: [], offers: [], queue: [] };
  const agora = "2026-09-11T16:00:00Z";
  const motivo = naHora(estado, agora).blockReason({
    destination: destino,
    offer: { ...OFFER, title: "Serum Facial Avon Renew", externalId: "MLBX", marketplace: "Mercado Livre", sellerName: "AVON" },
    nicheIds: ["beauty"], publications: [postDaMarca("2026-09-11T15:59:30Z", "VULT", 1)], now: new Date(agora)
  });
  assert.equal(motivo, null);
});

test("a loja operada pela marca conta como a propria marca", async () => {
  // "NIINA SECRETS por Eudora" seguida de "EUDORA" e Eudora duas vezes na tela.
  const destino = destination("g", ["beauty"], { minMinutesBetweenPosts: 10, burstSize: 15, maxDailyPosts: 600 });
  const estado = { destinations: [destino], publications: [], deliveryEvents: [], offers: [], queue: [] };
  const agora = "2026-09-11T16:00:00Z";
  const motivo = naHora(estado, agora).blockReason({
    destination: destino,
    offer: { ...OFFER, title: "Perfume Eudora Siage", externalId: "MLBX", marketplace: "Mercado Livre", sellerName: "EUDORA" },
    nicheIds: ["beauty"], publications: [postDaMarca("2026-09-11T15:59:30Z", "NIINA SECRETS por Eudora", 1)], now: new Date(agora)
  });
  assert.match(String(motivo), /intercalando com outra/);
});

test("brandCooldownPosts 3 exige tres outras marcas antes de repetir", async () => {
  const destino = destination("g", ["beauty"], { minMinutesBetweenPosts: 10, burstSize: 15, maxDailyPosts: 600, brandCooldownPosts: 3 });
  const estado = { destinations: [destino], publications: [], deliveryEvents: [], offers: [], queue: [] };
  const agora = "2026-09-11T16:00:00Z";
  const vult = { ...OFFER, title: "Batom Vult Novo", externalId: "MLBX", marketplace: "Mercado Livre", sellerName: "VULT" };
  const comDuasNoMeio = [
    postDaMarca("2026-09-11T15:57:00Z", "VULT", 1),
    postDaMarca("2026-09-11T15:58:00Z", "AVON", 2),
    postDaMarca("2026-09-11T15:59:00Z", "WELLA", 3)
  ];
  assert.match(String(naHora(estado, agora).blockReason({
    destination: destino, offer: vult, nicheIds: ["beauty"], publications: comDuasNoMeio, now: new Date(agora)
  })), /intercalando com outra/, "VULT ainda esta dentro dos 3 ultimos");

  const comTresNoMeio = [...comDuasNoMeio, postDaMarca("2026-09-11T15:59:30Z", "NATURA", 4)];
  assert.equal(naHora(estado, agora).blockReason({
    destination: destino, offer: vult, nicheIds: ["beauty"], publications: comTresNoMeio, now: new Date(agora)
  }), null, "com tres outras marcas depois dela, VULT volta");
});

test("fechada a rajada, a marca volta a poder sair", async () => {
  // Um destino cuja fila so tem uma marca nao pode ficar mudo para sempre: o
  // certo e espacar a marca, nao calar o grupo.
  const destino = destination("g", ["beauty"], { minMinutesBetweenPosts: 10, burstSize: 15, maxDailyPosts: 600 });
  const estado = { destinations: [destino], publications: [], deliveryEvents: [], offers: [], queue: [] };
  const agora = "2026-09-11T16:00:00Z";
  const motivo = naHora(estado, agora).blockReason({
    destination: destino,
    offer: { ...OFFER, title: "Batom Liquido Matte Novo", externalId: "MLBX", marketplace: "Mercado Livre", sellerName: "VULT" },
    nicheIds: ["beauty"],
    publications: [postDaMarca("2026-09-11T15:45:00Z", "VULT", 1)], // 15 min atras: fora da janela
    now: new Date(agora)
  });
  assert.equal(motivo, null);
});
