import test from "node:test";
import assert from "node:assert/strict";
import { AiClassifier } from "../src/services/ai-classifier.js";
import { productKey } from "../src/domain/offer.js";

const AGORA = new Date("2026-09-08T12:00:00Z");
const CONFIG = { ai: { enabled: true, apiKey: "chave-de-teste", model: "claude-opus-5", effort: "low", batchSize: 3, memoryDays: 30 } };

// marketplace + externalId sao o que forma o productKey — sem eles todas as
// ofertas virariam a mesma chave e o cache pareceria funcionar por acidente.
const oferta = (title, extra = {}) => ({
  id: title, title, marketplace: "Mercado Livre", externalId: `MLB-${title}`,
  url: `https://produto/${encodeURIComponent(title)}`,
  currentPrice: 99, originalPrice: 199, soldCount: 900, ...extra
});

const storeFalso = (estado = {}) => {
  const state = { destinations: [], publications: [], deliveryEvents: [], offers: [], queue: [], sources: [], seenProducts: [], classifications: [], ...estado };
  return {
    state,
    read: async () => structuredClone(state),
    update: async (mutator) => { const resultado = await mutator(state); return resultado; }
  };
};

// Devolve o que o modelo devolveria, e registra o que foi perguntado.
const clienteFalso = (responder) => {
  const chamadas = [];
  return {
    chamadas,
    messages: {
      create: async (params) => {
        chamadas.push(params);
        return { stop_reason: "tool_use", content: [{ type: "tool_use", name: "classificar_anuncios", input: { itens: responder(params) } }] };
      }
    }
  };
};

test("classifica pelo modelo e carimba nicho e publico", async () => {
  const store = storeFalso();
  const client = clienteFalso(() => [
    { i: 1, nicheIds: ["beauty"], servePublico: true, motivo: "skincare feminino" },
    { i: 2, nicheIds: ["fashion"], servePublico: false, motivo: "tenis masculino sem marcacao" }
  ]);
  const classifier = new AiClassifier({ store, config: CONFIG, client, clock: () => AGORA });

  const ofertas = [oferta("Serum Vitamina C 30ml"), oferta("Tenis Smash V2 Puma 41 Br")];
  const decisoes = await classifier.classify(ofertas);

  assert.deepEqual(decisoes.get(productKey(ofertas[0])), { nicheIds: ["beauty"], servePublico: true, motivo: "skincare feminino", por: "ia" });
  assert.equal(decisoes.get(productKey(ofertas[1])).servePublico, false);
});

test("o mesmo produto nao se paga duas vezes", async () => {
  const store = storeFalso();
  const client = clienteFalso(() => [{ i: 1, nicheIds: ["home"], servePublico: true, motivo: "panela para a casa" }]);
  const classifier = new AiClassifier({ store, config: CONFIG, client, clock: () => AGORA });

  const ofertas = [oferta("Jogo De Panelas Antiaderente 5 Pecas")];
  await classifier.classify(ofertas);
  const segunda = await classifier.classify(ofertas);

  assert.equal(client.chamadas.length, 1, "a segunda passada nao pode chamar o modelo");
  assert.equal(segunda.get(productKey(ofertas[0])).por, "cache");
  assert.deepEqual(segunda.get(productKey(ofertas[0])).nicheIds, ["home"]);
});

test("quebra em lotes do tamanho configurado", async () => {
  const store = storeFalso();
  const client = clienteFalso((params) => {
    const quantos = params.messages[0].content.match(/Classifique os (\d+)/)[1];
    return Array.from({ length: Number(quantos) }, (_, i) => ({ i: i + 1, nicheIds: ["home"], servePublico: true, motivo: "ok" }));
  });
  const classifier = new AiClassifier({ store, config: CONFIG, client, clock: () => AGORA });

  const ofertas = Array.from({ length: 7 }, (_, i) => oferta(`Produto ${i}`));
  const decisoes = await classifier.classify(ofertas);

  assert.equal(client.chamadas.length, 3, "7 ofertas em lotes de 3 sao 3 chamadas");
  assert.equal(decisoes.size, 7);
});

test("o prompt estavel vai marcado para cache e o volatil fica fora dele", async () => {
  const store = storeFalso();
  const client = clienteFalso(() => [{ i: 1, nicheIds: ["home"], servePublico: true, motivo: "ok" }]);
  const classifier = new AiClassifier({ store, config: CONFIG, client, clock: () => AGORA });
  await classifier.classify([oferta("Manta Solteiro Microfibra")]);

  const [params] = client.chamadas;
  assert.deepEqual(params.system[0].cache_control, { type: "ephemeral" });
  assert.equal(params.output_config.effort, "low");
  assert.equal(params.model, "claude-opus-5");
  assert.equal(params.tools[0].strict, true, "sem strict o schema nao e garantido");
  // O titulo muda a cada chamada: se entrasse no system, jogaria o cache fora.
  assert.ok(!params.system[0].text.includes("Manta Solteiro"));
  assert.ok(params.messages[0].content.includes("Manta Solteiro"));
});

test("quando o modelo falha, a fila nao para: cai na regra", async () => {
  const store = storeFalso();
  const avisos = [];
  const client = { messages: { create: async () => { throw new Error("503 sobrecarregado"); } } };
  const classifier = new AiClassifier({ store, config: CONFIG, client, clock: () => AGORA, onAlert: (m) => avisos.push(m) });

  const ofertas = [oferta("Jogo De Panelas Antiaderente 5 Pecas")];
  const decisoes = await classifier.classify(ofertas);

  const decisao = decisoes.get(productKey(ofertas[0]));
  assert.equal(decisao.por, "regra");
  assert.ok(decisao.nicheIds.includes("home"), "a regra ainda classifica panela como casa");
  assert.match(avisos[0], /503 sobrecarregado/);
  assert.deepEqual(store.state.classifications, [], "resposta que falhou nao vira cache");
});

test("item que o modelo pulou volta para a regra, nao vira buraco", async () => {
  const store = storeFalso();
  const client = clienteFalso(() => [{ i: 1, nicheIds: ["beauty"], servePublico: true, motivo: "ok" }]);
  const classifier = new AiClassifier({ store, config: CONFIG, client, clock: () => AGORA });

  const ofertas = [oferta("Base Liquida Vult"), oferta("Jogo De Panelas Antiaderente 5 Pecas")];
  const decisoes = await classifier.classify(ofertas);

  assert.equal(decisoes.size, 2);
  assert.equal(decisoes.get(productKey(ofertas[1])).por, "regra");
});

test("resposta sem chamada de ferramenta e tratada como falha", async () => {
  const store = storeFalso();
  const client = { messages: { create: async () => ({ stop_reason: "end_turn", content: [{ type: "text", text: "nao sei" }] }) } };
  const avisos = [];
  const classifier = new AiClassifier({ store, config: CONFIG, client, clock: () => AGORA, onAlert: (m) => avisos.push(m) });

  const decisoes = await classifier.classify([oferta("Base Liquida Vult")]);
  assert.equal([...decisoes.values()][0].por, "regra");
  assert.match(avisos[0], /sem chamar a ferramenta/);
});

test("desligado, nao chama nada e devolve a regra para todas", async () => {
  const store = storeFalso();
  const client = clienteFalso(() => { throw new Error("nao deveria ser chamado"); });
  const classifier = new AiClassifier({ store, config: { ai: { ...CONFIG.ai, enabled: false } }, client, clock: () => AGORA });

  const decisoes = await classifier.classify([oferta("Base Liquida Vult")]);
  assert.equal(client.chamadas.length, 0);
  assert.equal([...decisoes.values()][0].por, "regra");
});

test("classificacao velha expira e o produto e reavaliado", async () => {
  const antiga = new Date(AGORA.getTime() - 31 * 86400000).toISOString();
  const ofertas = [oferta("Base Liquida Vult")];
  const store = storeFalso({ classifications: [{ key: productKey(ofertas[0]), decisao: { nicheIds: ["general"], servePublico: true, motivo: "velha" }, at: antiga }] });
  const client = clienteFalso(() => [{ i: 1, nicheIds: ["beauty"], servePublico: true, motivo: "maquiagem" }]);
  const classifier = new AiClassifier({ store, config: CONFIG, client, clock: () => AGORA });

  const decisoes = await classifier.classify(ofertas);
  assert.equal(client.chamadas.length, 1);
  assert.deepEqual(decisoes.get(productKey(ofertas[0])).nicheIds, ["beauty"]);
});

test("general nao convive com nicho de verdade", async () => {
  const store = storeFalso();
  const client = clienteFalso(() => [
    { i: 1, nicheIds: ["general", "home"], servePublico: true, motivo: "artesanato" },
    { i: 2, nicheIds: ["general"], servePublico: true, motivo: "nao coube" },
    { i: 3, nicheIds: ["home", "beauty", "kids"], servePublico: true, motivo: "varios" },
    { i: 4, nicheIds: ["inventado", "home"], servePublico: true, motivo: "nicho que nao existe" }
  ]);
  // Lote de 4 para os quatro casos irem numa chamada so.
  const classifier = new AiClassifier({ store, config: { ai: { ...CONFIG.ai, batchSize: 4 } }, client, clock: () => AGORA });

  const ofertas = ["Barbante Croche", "Coisa Estranha", "Kit Variado", "Produto X"].map((t) => oferta(t));
  const decisoes = await classifier.classify(ofertas);

  assert.deepEqual(decisoes.get(productKey(ofertas[0])).nicheIds, ["home"], "general cai quando ha nicho de verdade");
  assert.deepEqual(decisoes.get(productKey(ofertas[1])).nicheIds, ["general"], "sozinho, general fica");
  assert.deepEqual(decisoes.get(productKey(ofertas[2])).nicheIds, ["home", "beauty"], "no maximo dois");
  assert.deepEqual(decisoes.get(productKey(ofertas[3])).nicheIds, ["home"], "nicho inexistente e descartado");
});

test("os lotes vao em paralelo, respeitando o teto de chamadas simultaneas", async () => {
  const titulos = Array.from({ length: 12 }, (_, i) => oferta(`Produto ${i}`));
  let emVoo = 0;
  let pico = 0;
  const client = {
    messages: {
      create: async ({ messages }) => {
        emVoo += 1;
        pico = Math.max(pico, emVoo);
        await new Promise((r) => setTimeout(r, 20));
        emVoo -= 1;
        const quantos = (messages[0].content.match(/^\d+\./gm) ?? []).length;
        return {
          content: [{
            type: "tool_use", name: "classificar_anuncios",
            input: { itens: Array.from({ length: quantos }, (_, i) => ({ i: i + 1, nicheIds: ["home"], servePublico: true, motivo: "ok" })) }
          }]
        };
      }
    }
  };
  const config = { ai: { ...CONFIG.ai, batchSize: 3, concurrency: 2 } };
  const classifier = new AiClassifier({ store: storeFalso(), config, client, clock: () => AGORA });

  const inicio = Date.now();
  const resultado = await classifier.classify(titulos);
  const duracao = Date.now() - inicio;

  assert.equal(resultado.size, 12);
  assert.equal(pico, 2, "nao pode passar do teto de simultaneas");
  // Quatro lotes de 20ms: em fila indiana seriam ~80ms; a dois por vez, ~40ms.
  assert.ok(duracao < 75, `esperava ganho de paralelismo, levou ${duracao}ms`);
});

test("sem teto configurado os lotes voltam a ser um de cada vez", async () => {
  const titulos = Array.from({ length: 6 }, (_, i) => oferta(`Item ${i}`));
  let emVoo = 0;
  let pico = 0;
  const client = {
    messages: {
      create: async ({ messages }) => {
        emVoo += 1;
        pico = Math.max(pico, emVoo);
        await new Promise((r) => setTimeout(r, 5));
        emVoo -= 1;
        const quantos = (messages[0].content.match(/^\d+\./gm) ?? []).length;
        return {
          content: [{
            type: "tool_use", name: "classificar_anuncios",
            input: { itens: Array.from({ length: quantos }, (_, i) => ({ i: i + 1, nicheIds: ["home"], servePublico: true, motivo: "ok" })) }
          }]
        };
      }
    }
  };
  const config = { ai: { ...CONFIG.ai, batchSize: 2 } };
  const classifier = new AiClassifier({ store: storeFalso(), config, client, clock: () => AGORA });
  await classifier.classify(titulos);
  assert.equal(pico, 1, "um undefined em concurrency nao pode virar paralelismo ilimitado");
});

test("o cache guarda o motivo so de quem foi barrado", async () => {
  const store = storeFalso();
  const client = {
    messages: {
      create: async ({ messages }) => {
        const quantos = (messages[0].content.match(/^\d+\./gm) ?? []).length;
        return {
          content: [{
            type: "tool_use", name: "classificar_anuncios",
            input: {
              itens: Array.from({ length: quantos }, (_, i) => ({
                i: i + 1, nicheIds: ["home"],
                servePublico: i === 0,
                motivo: i === 0 ? "serve ao canal" : "produto masculino"
              }))
            }
          }]
        };
      }
    }
  };
  const config = { ai: { ...CONFIG.ai, batchSize: 10, concurrency: 1 } };
  const classifier = new AiClassifier({ store, config, client, clock: () => AGORA });
  await classifier.classify([oferta("Aprovado"), oferta("Barrado")]);

  const guardadas = store.state.classifications;
  assert.equal(guardadas.length, 2);
  const aprovado = guardadas.find((c) => c.decisao.servePublico === true);
  const barrado = guardadas.find((c) => c.decisao.servePublico === false);
  assert.equal(aprovado.decisao.motivo, undefined, "aprovado nao precisa de motivo guardado");
  assert.ok(barrado.decisao.motivo, "o bloqueio precisa poder se explicar");
});

test("o teto do cache e configuravel e nao descarta cedo demais", async () => {
  const store = storeFalso();
  store.state.classifications = Array.from({ length: 50 }, (_, i) => ({
    key: `antiga-${i}`, decisao: { nicheIds: ["home"], servePublico: true }, at: AGORA.toISOString()
  }));
  const client = {
    messages: {
      create: async ({ messages }) => {
        const quantos = (messages[0].content.match(/^\d+\./gm) ?? []).length;
        return { content: [{ type: "tool_use", name: "classificar_anuncios",
          input: { itens: Array.from({ length: quantos }, (_, i) => ({ i: i + 1, nicheIds: ["home"], servePublico: true, motivo: "ok" })) } }] };
      }
    }
  };
  const config = { ai: { ...CONFIG.ai, batchSize: 5, concurrency: 1, memoryEntries: 52 } };
  const classifier = new AiClassifier({ store, config, client, clock: () => AGORA });
  await classifier.classify([oferta("Nova A"), oferta("Nova B")]);
  assert.equal(store.state.classifications.length, 52, "respeita o teto configurado");
  // As duas novas sobrevivem; o teto corta as mais antigas.
  assert.ok(store.state.classifications.some((c) => c.key.includes("Nova A")));
});
