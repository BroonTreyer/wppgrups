import test from "node:test";
import assert from "node:assert/strict";
import { ACHADINHOS_PRESET } from "../src/domain/audience.js";
import { PublicationService } from "../src/services/publication-service.js";

const AGORA = new Date("2026-09-02T16:00:00Z"); // 13h BRT, dentro de uma rajada
const OFFER = { id: "o1", title: "", currentPrice: 99, originalPrice: 199, soldCount: 900, url: "https://x", affiliateUrl: "https://x?matt_word=rocketplugins" };

const canal = {
  id: "isa", name: "Achadinhos", type: "channel", active: true, available: true,
  nicheIds: ["home", "beauty", "health", "fashion", "kids"],
  maxDailyPosts: 40, minMinutesBetweenPosts: 20, minDiscount: 5,
  ...ACHADINHOS_PRESET
};

const service = new PublicationService({
  store: { read: async () => ({ destinations: [canal], publications: [], deliveryEvents: [], offers: [], queue: [] }) },
  zapi: {}, config: { limits: {} }, clock: () => AGORA
});

const motivo = (title, nicheIds) => service.blockReason({
  destination: canal, offer: { ...OFFER, title }, nicheIds, publications: [], now: AGORA
});

test("o preset barra o que nao e do publico do canal", () => {
  for (const [titulo, nichos] of [
    ["Maquina De Cortar Cabelo Profissional Barbeiro", ["beauty"]],
    ["Cabeca Manequim Isopor Suporte Para Perucas", ["beauty"]],
    ["Kit 3 Sungas Masculinas Praia", ["fashion"]],
    ["Cadeira De Rodas Dobravel Aco 120kg", ["health"]],
    ["Colchao Antiescara Pneumatico Para Acamados", ["home"]],
    ["Andador Dobravel Aluminio 4 Rodas", ["health"]],
    ["Absorvente Geriatrico Incontinencia Adulto", ["health"]],
    ["Aparelho Auditivo Recarregavel Amplificador", ["health"]],
    ["Kit 100 Seringas Descartaveis 5ml", ["health"]],
    ["Estufa De Salgados Eletrica 3 Andares", ["home"]],
    ["Fritadeira Industrial Eletrica 8 Litros", ["home"]],
    ["Racao Premium Para Cachorro Adulto 15kg", ["home"]],
    ["Arranhador Para Gato Com Casinha", ["home"]]
  ]) {
    assert.match(String(motivo(titulo, nichos)), /publico deste canal/, titulo);
  }
});

test("o preset deixa passar o que e do publico", () => {
  for (const [titulo, nichos] of [
    ["Kerastase Nutritive Bain Satin 250ml", ["beauty"]],
    ["Base Liquida Vult Cobertura Alta", ["beauty"]],
    ["Vitamina C 1000mg Com Zinco 120 Capsulas", ["health"]],
    ["Colageno Verisol Com Acido Hialuronico 180 Capsulas", ["health"]],
    ["Jogo De Panelas Antiaderente 5 Pecas", ["home"]],
    ["Vestido Midi Floral Manga Bufante", ["fashion"]],
    ["Sandalia Rasteirinha Confortavel Nude", ["fashion"]]
  ]) {
    assert.equal(motivo(titulo, nichos), null, titulo);
  }
});

test("bloqueio errado e pior que bloqueio nenhum: nada de casar pedaco de palavra", () => {
  // Cada um destes contem uma palavra bloqueada como SUBSTRING e precisa passar.
  for (const [titulo, nichos] of [
    ["Barbante Colorido 200g Para Croche", ["home"]],       // barba
    ["Garrafa Pet 2 Litros Kit 10 Unidades", ["home"]],     // pet shop
    ["Kit 6 Potes Hermeticos Empilhaveis", ["home"]],       // pote / pos barba
    ["Sabonete Liquido Intimo 200ml", ["beauty"]],          // sonda? nao: guarda geral
    ["Manta Solteiro Microfibra Antialergica", ["home"]]
  ]) {
    assert.equal(motivo(titulo, nichos), null, titulo);
  }
});

// Os tenis que estavam aqui saem antes, pela saturacao — a exigencia de marcacao
// feminina continua sendo provada por pecas que nao caem naquela lista.
test("em vestuario o canal exige a marcacao feminina", () => {
  for (const titulo of [
    "Kit Camisetas Aramis Preta Branca Original",
    "Jaqueta Corta Vento Impermeavel Adulto",
    "Bermuda Sarja Slim Algodao",
    "Mochila Tatica Impermeavel Militar Reforcada"
  ]) {
    assert.match(String(motivo(titulo, ["fashion"])), /marcacao de publico/, titulo);
  }
  // ... e a exigencia nao vaza para fora de vestuario.
  assert.equal(motivo("Kerastase Nutritive Bain Satin 250ml", ["beauty"]), null);
});

test("o teto de preco do canal barra o eletrodomestico caro por regra", () => {
  // O teto subiu de 400 para 700 em 10/09/2026 a pedido do dono do canal, entao
  // o que prova a regra agora e um preco acima de 700 — 620 passa de proposito.
  const caro = service.blockReason({
    destination: canal, offer: { ...OFFER, title: "Air Fryer Digital 12 Litros", currentPrice: 820, originalPrice: 1200 },
    nicheIds: ["home"], publications: [], now: AGORA
  });
  assert.match(String(caro), /passa do teto/);

  const dentro = service.blockReason({
    destination: canal, offer: { ...OFFER, title: "Air Fryer Digital 12 Litros", currentPrice: 620, originalPrice: 900 },
    nicheIds: ["home"], publications: [], now: AGORA
  });
  assert.equal(dentro, null, "620 cabe no teto novo");
});

test("o veredito da IA barra o que nenhuma palavra pegaria", () => {
  // "Kit Camisetas Aramis" nao diz "masculino" em lugar nenhum: a lista de
  // palavras passa batido, a exigencia de marcacao feminina pega no fashion, e
  // fora do fashion so o julgamento pega.
  const comIa = (title, nicheIds, audience) => service.blockReason({
    destination: canal, offer: { ...OFFER, title, audience }, nicheIds, publications: [], now: AGORA
  });

  assert.match(
    String(comIa("Kit Ferramentas Bosch 100 Pecas", ["home"], { serve: false, motivo: "publico masculino" })),
    /IA nao ve publico deste canal: publico masculino/
  );
  assert.equal(comIa("Jogo De Panelas Antiaderente 5 Pecas", ["home"], { serve: true, motivo: "cozinha" }), null);
  // Sem julgamento (IA desligada ou item pela regra), nada muda.
  assert.equal(comIa("Jogo De Panelas Antiaderente 5 Pecas", ["home"], undefined), null);
});

test("destino que nao pediu o julgamento ignora o veredito", () => {
  const canalMasculino = { ...canal, requireAudienceFit: false, nicheIds: ["tools-auto", "home"] };
  const masculino = new PublicationService({
    store: { read: async () => ({ destinations: [canalMasculino], publications: [], deliveryEvents: [], offers: [], queue: [] }) },
    zapi: {}, config: { limits: {} }, clock: () => AGORA
  });
  const motivo = masculino.blockReason({
    destination: canalMasculino,
    offer: { ...OFFER, title: "Kit Ferramentas Bosch 100 Pecas", audience: { serve: false, motivo: "publico masculino" } },
    nicheIds: ["tools-auto"], publications: [], now: AGORA
  });
  assert.ok(!String(motivo).includes("IA nao ve publico"), `nao devia usar o veredito: ${motivo}`);
});

test("unissex barra roupa mas nao barra perfume", () => {
  // "unissex" saiu da lista de palavras em 08/09: barrava "Mawwal Malek Eau de
  // Parfum Unissex", perfume arabe que e item legitimo de canal feminino. Em
  // roupa nao faz falta — a exigencia de marcacao feminina continua pegando.
  assert.match(String(motivo("Moletom Canguru Liso Algodao Unissex", ["fashion"])), /marcacao de publico/);
  // Perfume nacional unissex: "unissex" nao pode barra-lo. (O arabe passa aqui
  // tambem, mas cai depois na regra de saturacao — sao dois filtros diferentes.)
  assert.equal(motivo("Egeo Dolce Colors Deo Colonia Unissex 90ml", ["beauty"]), null);
});

test("perfume arabe e barrado por saturacao, nao por publico", () => {
  // Seis dos vinte e tres posts do grupo #5 em 08/09 eram perfume arabe. Eles
  // SERVEM ao canal — o motivo do bloqueio precisa dizer saturacao, nao dizer
  // que o produto nao serve a quem le.
  for (const titulo of [
    "Perfume Árabe Durrat Al Aroos Feminino 85ml Edp Original",
    "Lattafa Bade'e Al Oud For Glory 100ml",
    "Mawwal Malek Eau De Parfum Unissex Perfume Arabe 100ml",
    "Perfume Sedutor Árabe Sabah 100ml Original Feminino"
  ]) {
    assert.match(String(motivo(titulo, ["beauty"])), /esta saturado neste canal/, titulo);
  }

  // Perfume nacional continua passando: a regra e sobre saturacao daquela linha,
  // nao sobre perfume.
  assert.equal(motivo("O Boticário Insensatez Deo Colônia 100ml", ["beauty"]), null);
  assert.equal(motivo("Natura Essencial Deo Parfum Feminino 100ml", ["beauty"]), null);
});

test("tenis tambem sai por saturacao", () => {
  // 3 dos 23 primeiros posts do grupo #5. E tenis se vende por tamanho: um
  // anuncio "37 Br" nao serve a quase ninguem da lista.
  for (const titulo of [
    "Tênis Feminino Delta 122 Olympikus Preto/chumbo Liso 37 Br",
    "Tenis Feminino Chunky Ramarim Casual Conforto Original",
    "Tenis Nyx Olympikus Cinza Liso 38"
  ]) {
    assert.match(String(motivo(titulo, ["fashion"])), /esta saturado neste canal/, titulo);
  }
  // O masculino nao chega na saturacao: o filtro de publico pega antes, e a
  // ordem importa — o motivo mais especifico e o mais util para quem le o log.
  assert.match(String(motivo("Tênis De Caminhada Masculino Zex 2 Olympikus 42 Br", ["fashion"])), /publico deste canal/);

  // Outros calcados femininos continuam entrando.
  assert.equal(motivo("Sandalia Rasteirinha Confortavel Nude", ["fashion"]), null);
  assert.equal(motivo("Scarpin Feminino Salto Baixo Bico Fino", ["fashion"]), null);
});

test("marca torta no titulo tambem e pega", () => {
  // "Perfume Asad Lataffa" chegou na fila em 08/09: e Lattafa escrito errado pelo
  // vendedor. Lista de marca tem que casar com o titulo real, nao com o correto.
  for (const titulo of [
    "Perfume Asad Lataffa 100ml Eau De Parfum Original Edp",
    "Perfume Latafa Asad 100ml"
  ]) {
    assert.match(String(motivo(titulo, ["beauty"])), /esta saturado neste canal/, titulo);
  }
});

test("eudora club e linha masculina, mesmo quando a IA hesita", () => {
  // A IA barrou este produto numa rodada e liberou na seguinte. A regra nao hesita.
  assert.match(String(motivo("Eudora Club 6 Cassino Deo-colônia 95ml", ["beauty"])), /publico deste canal/);
  // Eudora fora da linha Club continua passando.
  assert.equal(motivo("Eudora Siage Cachos Shampoo 250ml", ["beauty"]), null);
});

test("blusa nao e sinal de genero", () => {
  // Caso real de 08/09: "Jaqueta Puffer De Frio Blusa Impermeavel Inverno Intenso"
  // e peca masculina e entrou no canal so porque "blusa" contava como feminino.
  // Vendedor usa "blusa" para qualquer peca de cima.
  assert.match(
    String(motivo("Jaqueta Puffer De Frio Blusa Impermeavel Inverno Intenso", ["fashion"])),
    /marcacao de publico/
  );
  // O que tem marcacao de verdade continua entrando.
  assert.equal(motivo("Blusa Feminina Cropped Canelada Manga Longa", ["fashion"]), null);
  assert.equal(motivo("Vestido Midi Floral Manga Bufante", ["fashion"]), null);
});

test("aparelho de cabelo entra por saturacao, sem acusar o produto", () => {
  for (const titulo of [
    "Secador De Cabelo 2000 Watts - Style Pro Taiff",
    "Prancha Taiff Gloss Blue Ceramica com Macadamia",
    "Chapinha Lizze Profissional 480 Extreme",
    "Modelador De Cachos 3 Em 1 Gokoco Gd034",
    "Escova Rotativa Mondial Turbo 5 Em 1 Tourmaline",
    "Pente Alisador E Ondulador Gd040 Gokoco"
  ]) {
    const razao = motivo(titulo, ["beauty"]);
    assert.match(String(razao), /esta saturado neste canal/, titulo);
  }
});

test("silenciar aparelho de cabelo nao derruba cosmetico capilar", () => {
  for (const titulo of [
    "Wella Invigo Nutri Enrich Shampoo - 1000ml",
    "Oleo Capilar Elseve Extraordinario 100ml",
    "Mascara Keune Care Keratin Smooth 200ml",
    "Touca De Cetim Dupla Face Grande Anti Frizz"
  ]) {
    assert.equal(motivo(titulo, ["beauty"]), null, titulo);
  }
});

test("canal que exige loja oficial recusa vendedor comum", () => {
  const soOficial = { ...canal, requireOfficialStore: true };
  const service2 = new PublicationService({
    store: { read: async () => ({ destinations: [soOficial], publications: [], deliveryEvents: [], offers: [], queue: [] }) },
    zapi: {}, config: { limits: {} }, clock: () => AGORA
  });
  const avaliar = (offer) => service2.blockReason({
    destination: soOficial, offer: { ...OFFER, title: "Serum Facial Vitamina C", ...offer },
    nicheIds: ["beauty"], publications: [], now: AGORA
  });
  assert.match(String(avaliar({ officialStore: false, sellerName: "LOJA DO JOAO" })), /so publica de loja oficial/);
  assert.equal(avaliar({ officialStore: true, sellerName: "NATURA" }), null);
});

test("sem a exigencia, vendedor comum continua passando", () => {
  const avaliar = (offer) => service.blockReason({
    destination: canal, offer: { ...OFFER, title: "Serum Facial Vitamina C", ...offer },
    nicheIds: ["beauty"], publications: [], now: AGORA
  });
  assert.equal(avaliar({ officialStore: false, sellerName: "LOJA DO JOAO" }), null);
});
