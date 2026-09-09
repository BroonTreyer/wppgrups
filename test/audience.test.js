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

test("em vestuario o canal exige a marcacao feminina", () => {
  for (const titulo of [
    "Kit Camisetas Aramis Preta Branca Original",
    "Tenis Reserva Go Troy Leve Confortavel",
    "Tenis Smash V2 Puma Preto E Branco 41 Br",
    "Mochila Tatica Impermeavel Militar Reforcada"
  ]) {
    assert.match(String(motivo(titulo, ["fashion"])), /marcacao de publico/, titulo);
  }
  // ... e a exigencia nao vaza para fora de vestuario.
  assert.equal(motivo("Kerastase Nutritive Bain Satin 250ml", ["beauty"]), null);
});

test("o teto de preco do canal barra o eletrodomestico caro por regra", () => {
  const caro = service.blockReason({
    destination: canal, offer: { ...OFFER, title: "Air Fryer Digital 12 Litros", currentPrice: 620, originalPrice: 900 },
    nicheIds: ["home"], publications: [], now: AGORA
  });
  assert.match(String(caro), /passa do teto/);
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
  assert.equal(motivo("Mawwal Malek Eau De Parfum Unissex Perfume Arabe 100ml", ["beauty"]), null);
});
