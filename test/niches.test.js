import test from "node:test";
import assert from "node:assert/strict";
import { inferNiches } from "../src/domain/niches.js";

test("classifica uma TV em eletronicos e ofertas gerais", () => {
  assert.deepEqual(inferNiches({ title: "Smart TV 4K", category: "TV" }), ["electronics", "general"]);
});

test("sempre inclui ofertas gerais", () => {
  assert.deepEqual(inferNiches({ title: "Produto desconhecido" }), ["general"]);
});

test("classifica titulos reais de marketplace nos nichos certos", () => {
  const niche = (title) => inferNiches({ title });
  assert.deepEqual(niche("Fritadeira Air Fryer 4,5l Widemax 1500w Midea"), ["home", "general"]);
  assert.deepEqual(niche("Kit 10 Cuecas Boxer Lisa Polo Wear Sortido"), ["fashion", "general"]);
  assert.deepEqual(niche("Whey Protein 900g Growth"), ["sports", "general"]);
  assert.deepEqual(niche("Fralda Pampers Confort Sec XG"), ["kids", "general"]);
});

test("nao confunde palavra contida em outra com o nicho", () => {
  assert.deepEqual(inferNiches({ title: "Celular Motorola Moto G54 5G 256gb" }), ["electronics", "general"]);
  assert.deepEqual(inferNiches({ title: "Capacete Para Motocicleta Pro Tork" }), ["tools-auto", "general"]);
});

test("separa o publico de mamaes, casa e saude do publico masculino", () => {
  const niche = (title) => inferNiches({ title }).filter((item) => item !== "general");
  assert.deepEqual(niche("Cinta Pos Parto Modeladora Gestante"), ["kids"]);
  assert.deepEqual(niche("Jogo de Toalhas Buddemeyer Fio Penteado Banho"), ["home"]);
  assert.deepEqual(niche("Colageno Verisol 300g Vitamina C"), ["health"]);
  assert.deepEqual(niche("Furadeira Parafusadeira 12v Bosch"), ["tools-auto"]);
  assert.deepEqual(niche("Batom Matte Ruby Rose Kit"), ["beauty"]);
});

test("palavra de formato nao rouba o produto do nicho certo", () => {
  // Caso real de 04/09: "pote" jogou creatina no nicho de casa, e ela foi
  // publicada num canal de kids/casa/beleza em vez do de esportes.
  const nichos = inferNiches({ title: "Creatina Monohidratada em Pote 300g 100% Pura" });
  assert.ok(nichos.includes("sports"), "creatina e sinal forte de esportes");
  assert.ok(!nichos.includes("home"), "'pote' sozinho nao faz de um suplemento item de casa");
});

test("sem sinal forte, a palavra fraca ainda vale", () => {
  // Um pote que e so um pote continua sendo item de casa: a regra descarta o
  // sinal fraco apenas quando existe um forte competindo.
  const nichos = inferNiches({ title: "Pote Organizador Empilhavel 2 Litros" });
  assert.ok(nichos.includes("home"), nichos.join(","));
});

test("produto de casa de verdade nao e afetado", () => {
  const nichos = inferNiches({ title: "Jogo De Toalhas Buddemeyer Bella Extra Macia" });
  assert.ok(nichos.includes("home"));
  assert.ok(!nichos.includes("sports"));
});

test("o nucleo do titulo manda: atributo nao rouba o produto", () => {
  // Titulo de marketplace comeca pelo TIPO do produto; o resto e atributo,
  // acessorio ou marca. Ignorar isso trocava o canal de destino.
  const casos = [
    ["Mochila Viagem Executiva Grande Notebook Masculina", "fashion"],   // carrega notebook, nao e um
    ["Creatina Monohidratada em Pote 300g 100% Pura", "sports"],         // pote e embalagem
    ["Cadeira Gamer ThunderX3 Reclinavel", "computing-gaming"],          // "cadeira" sozinha seria casa
    ["Notebook Dell Inspiron 15 i5 8GB", "computing-gaming"],
    ["Air Fryer Fritadeira Eletrica 5L Mondial", "home"],
    ["Fralda Pampers Premium Care XG 60un", "kids"],
    ["Chinelo Havaianas Masculino Top Max", "fashion"]
  ];
  for (const [titulo, esperado] of casos) {
    const nichos = inferNiches({ title: titulo }).filter((id) => id !== "general");
    assert.deepEqual(nichos, [esperado], `${titulo} -> ${nichos.join(",")}`);
  }
});

test("marca com nome de palavra comum nao cria nicho", () => {
  // "Mercado Pago" fazia a maquininha virar oferta de mercado (alimentos).
  const nichos = inferNiches({ title: "Maquininha De Cartao Pro 3 Mercado Pago Point" });
  assert.ok(!nichos.includes("market"), nichos.join(","));
});

test("perfume e reconhecido como beleza", () => {
  // "Deo Colonia" nao existia na lista: o produto saia sem nicho nenhum e nao
  // chegava a canal algum.
  assert.ok(inferNiches({ title: "O Boticario Insensatez Deo Colonia 100ml" }).includes("beauty"));
  assert.ok(inferNiches({ title: "Perfume Malbec Eau De Parfum 100ml" }).includes("beauty"));
});

test("contexto veta o nicho que so parecia certo", () => {
  // Todos vieram da auditoria de 07/09: estavam sendo publicados errado.
  const casos = [
    // "monitor" e informatica; "monitor de pressao" e saude.
    ["Monitor De Pressao Arterial De Braco Comfort Hem-712", "health", "computing-gaming"],
    ["Monitor Gamer LG Ultragear 24 180hz 1ms Full Hd", "computing-gaming", "health"],
    // "manta" e cobertor; "manta liquida" e impermeabilizante de obra.
    ["Manta Cobertor Casal Microfibra Toque Macio", "home", null],
    // "colchao" e casa; "colchao antiescara" e equipamento hospitalar.
    ["Colchao Antiescara Pneumatico De Ar Para Acamados", "health", "home"],
    ["Colchao Casal Ortobom Physical D33", "home", "health"],
    // "canguru" e carregador de bebe; "moletom canguru" e o bolso da blusa.
    ["Moletom Canguru Liso Algodao Unissex Termico", "fashion", "kids"],
    ["Canguru Sling Bebe Ergonomico Carregador", "kids", null]
  ];
  for (const [titulo, esperado, vetado] of casos) {
    const nichos = inferNiches({ title: titulo });
    assert.ok(nichos.includes(esperado), `${titulo} -> ${nichos.join(",")} (faltou ${esperado})`);
    if (vetado) assert.ok(!nichos.includes(vetado), `${titulo} nao deveria cair em ${vetado}`);
  }
});

test("produto de obra nao vira achadinho de casa", () => {
  // Impermeabilizante de 18kg foi publicado num canal de achadinhos.
  for (const titulo of ["Manta Liquida 18kg Para Uso Residencial E Comercial",
                        "Argamassa Colante AC3 Interno 20kg",
                        "Tinta Acrilica Fosca Branca 18 Litros"]) {
    const nichos = inferNiches({ title: titulo }).filter((id) => id !== "general");
    assert.deepEqual(nichos, [], `${titulo} -> ${nichos.join(",")}`);
  }
});

test("a categoria do marketplace decide quando o titulo nao decide", () => {
  const B = "Beleza e cuidado pessoal";
  // Coletados na vitrine de beleza e classificados fora dela na auditoria de 07/09.
  assert.equal(inferNiches({ title: "Mascara Medicube Facial Gel Colageno Salmon", category: B })[0], "beauty");
  assert.equal(inferNiches({ title: "Poltrona Cadeira Reclinavel Hidraulica De Barbeiro", category: B })[0], "beauty");
  assert.equal(inferNiches({ title: "Kit Manicure 3 Pcs Alicate De Cuticula", category: B })[0], "beauty");
});

test("a categoria nao atropela o titulo", () => {
  // O ML lista papel higienico em beleza; o nucleo do titulo e mais especifico.
  const nichos = inferNiches({ title: "Papel Higienico Supra Folha Tripla 24 Rolos", category: "Beleza e cuidado pessoal" });
  assert.equal(nichos[0], "market");
  // Ferramenta de verdade continua ferramenta, mesmo com o veto de manicure.
  assert.deepEqual(inferNiches({ title: "Alicate Universal Isolado 1000v" }).filter((id) => id !== "general"), ["tools-auto"]);
});

test("marca multicategoria nao decide sozinha o nicho", () => {
  // "philco" como palavra-chave de casa fazia a TV virar eletrodomestico. E "tv"
  // tem 2 letras: o nucleo exigia 3 e deixava de fora a palavra que define o produto.
  assert.equal(inferNiches({ title: "Smart Tv Philco 40 P40vik Led Roku" })[0], "electronics");
});

test("auditoria 07/09: nada de material medico, comercial, pet ou obra", () => {
  // Cada um destes chegou a um canal de achadinhos, ou chegaria.
  const forade = [
    "Balanca De Plataforma Digital 200kg Com Coluna",
    "Brightpet Probioticos Para Caes Flora Intestinal",
    "Auto transformador bivolt 110v 220v Techmax 7000VA ar condicionado",
    "Manta Liquida 18kg Para Uso Residencial",
    "Argamassa Colante AC3 Interno 20kg"
  ];
  for (const titulo of forade) {
    const nichos = inferNiches({ title: titulo }).filter((id) => id !== "general");
    assert.deepEqual(nichos, [], `${titulo} -> ${nichos.join(",")}`);
  }
  // E o legitimo continua passando.
  assert.ok(inferNiches({ title: "Balanca Digital Corporal Bioimpedancia Relaxmedic" }).includes("health"));
  assert.ok(inferNiches({ title: "Ar Condicionado Split LG Inverter 12000 Btu" }).includes("home"));
});

test("lavar roupa nao e comprar roupa", () => {
  // Moda casava com lavadora, tanquinho e tabua de passar por "roupa".
  for (const titulo of ["Lavadora de roupas Electrolux Efficient 18kg",
                        "Tanquinho De Lavar Roupa Mueller 20 Kg",
                        "Tabua De Passar Roupa Reforcada",
                        "Sapateira Organizador De Sapatos 7 Prateleiras"]) {
    const nichos = inferNiches({ title: titulo }).filter((id) => id !== "general");
    assert.ok(nichos.includes("home"), `${titulo} -> ${nichos.join(",")}`);
    assert.ok(!nichos.includes("fashion"), `${titulo} nao e moda`);
  }
});

test("body de bebe e body spray de perfumaria sao coisas diferentes", () => {
  assert.ok(inferNiches({ title: "Body Spray Carolina Herrera 212 Vip Rose Feminino 250ml" }).includes("beauty"));
  assert.ok(inferNiches({ title: "Body Bebe Manga Longa Algodao Menino" }).includes("kids"));
});

test("movel de setup nao e movel de casa", () => {
  // "Escrivaninha Gamer Mesa Para Computador" saiu quatro vezes num canal
  // feminino de achadinhos: "escrivaninha" e "mesa" estao no NUCLEO e venciam
  // "computador", que aparece depois.
  for (const titulo of ["Escrivaninha Gamer Mesa Para Computador Com Suporte Para Cpu Preto",
                        "Cadeira Gamer ThunderX3 Reclinavel",
                        "Mesa Gamer Com Suporte Para CPU e Headset"]) {
    const nichos = inferNiches({ title: titulo }).filter((id) => id !== "general");
    assert.ok(!nichos.includes("home"), `${titulo} -> ${nichos.join(",")}`);
  }
  // Movel comum de casa continua em casa.
  for (const titulo of ["Escrivaninha Mesa De Estudos Branca 90cm",
                        "Mesa De Jantar 6 Lugares Madeira",
                        "Cadeira De Escritorio Ergonomica Apoio Lombar"]) {
    assert.ok(inferNiches({ title: titulo }).includes("home"), titulo);
  }
});
