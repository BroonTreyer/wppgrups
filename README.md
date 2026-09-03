# OfertaFlow Bot

Bot de ofertas por nicho. Ele sincroniza grupos e canais administrados na Z-API, classifica ofertas, aplica limites e envia a foto do produto com a mensagem na legenda.

## Requisitos e inicializacao

- Node.js 22 ou superior
- Uma instancia Z-API conectada para sincronizacao e envio real

Copie os valores de `.env.example` para variaveis de ambiente e execute:

```powershell
$env:ADMIN_TOKEN = "uma-chave-local"
$env:DRY_RUN = "true"
node src/index.js
```

Abra `http://localhost:3000` para acessar o painel. Todas as rotas administrativas usam o header `Authorization: Bearer <ADMIN_TOKEN>`.

## Fluxo inicial

- `POST /api/destinations/sync`: sincroniza grupos e canais próprios da Z-API.
- `GET /api/destinations`: lista grupos, canais e destinos de teste.
- `GET /api/niches`: lista os nichos disponíveis.
- `PATCH /api/destinations/{id}`: configura nichos e limites do destino.
- `GET /api/sources`: lista as fontes de ofertas, seus filtros e a última execução.
- `PATCH /api/sources/{id}`: configura filtros e ativa uma fonte.
- `POST /api/sources/run`: força uma busca de ofertas agora.
- `GET /api/readiness`: modo de atribuição do link, alertas e estado dos canais.
- `GET /api/operation` e `POST /api/operation`: estado e liga/desliga da operação automática.
- `POST /api/offers`: valida, classifica e coloca uma oferta na fila.
- `GET /api/queue`: acompanha a fila priorizada.
- `POST /api/queue/process`: força um ciclo do processador.
- `POST /api/demo/enqueue`: adiciona uma oferta simulada.
- `POST /webhooks/zapi/status?secret=<ZAPI_WEBHOOK_SECRET>`: recebe eventos de entrega.

Exemplo de configuração de grupo:

```json
{
  "nicheIds": ["electronics", "computing-gaming"],
  "minDiscount": 15,
  "maxDailyPosts": 6,
  "active": true
}
```

Exemplo de oferta:

```json
{
  "externalId": "produto-123",
  "marketplace": "Loja",
  "title": "Smartphone 256 GB",
  "category": "Celulares",
  "originalPrice": 1999,
  "currentPrice": 1499,
  "affiliateUrl": "https://loja.example/produto?afiliado=seu-id",
  "imageUrl": "https://cdn.example/produto.jpg"
}
```

## Configuração operacional adotada

- Canal: até 40 publicações por dia, com intervalo mínimo de 20 minutos.
- Grupo: até 12 publicações por dia, com intervalo mínimo de 45 minutos.
- Janela de publicação: 08:00–23:00 no horário de São Paulo.
- Fila priorizada por desconto, avaliação, volume de avaliações e frete grátis.
- Três tentativas antes de mover uma oferta para falha.
- Um produto nunca se repete no mesmo destino por 30 dias.
- Preço revalidado na vitrine antes de cada publicação (máximo 25 minutos de defasagem).
- Ingestão automática a cada 30 minutos, no máximo 8 ofertas por fonte a cada rodada.

Enquanto `DRY_RUN=true`, nenhuma mensagem é enviada ao WhatsApp. Troque para `false` somente depois de revisar os destinos.

O envio para canais permanece protegido por `ZAPI_CHANNEL_IMAGE_ENABLED=false`. Depois de homologar uma imagem em um destino `@newsletter`, altere para `true`.

## Operação: ligar e deixar rodando

O painel tem um botão único de operação. Enquanto ele estiver **pausado**, o bot não busca nem publica nada, mesmo com fontes e destinos ativos.

Ao clicar em **LIGAR OPERAÇÃO** o bot faz uma busca imediata e passa a repetir o ciclo sozinho:

1. A cada `INGESTION_INTERVAL_MINUTES` (padrão 30) cada fonte ativa varre a próxima categoria do rodízio e enfileira as melhores ofertas.
2. A cada `SCHEDULER_INTERVAL_SECONDS` (padrão 60) o bot tenta publicar a próxima oferta da fila, respeitando por destino: limite diário, intervalo mínimo entre posts, nicho, desconto mínimo e a carência de 30 dias por produto.
3. Fora da janela `PUBLISHING_START_HOUR`–`PUBLISHING_END_HOUR` nada é publicado.

A busca respeita a capacidade: se a fila já cobre o que ainda cabe hoje nos destinos ativos, a rodada é pulada em vez de acumular oferta que vai envelhecer. Sem destino ativo, a fila enche normalmente.

O campo **Posts por dia** aplica o volume a todos os destinos ativos e **ajusta o intervalo entre posts para caber esse volume na janela** (por exemplo, 70 posts numa janela de 8h–23h viram um post a cada 12 minutos, respeitando o piso de `MIN_MINUTES_BETWEEN_POSTS_FLOOR`). Se o volume pedido não couber nem no piso, o painel avisa quanto realmente cabe.

Quando nada é publicado, o painel mostra o motivo **por destino**: aguardando intervalo (com o horário de liberação), limite diário atingido, nicho incompatível, desconto abaixo do mínimo ou produto já publicado ali. O quadro de operação mostra publicados hoje, fila, destinos ativos e, para cada destino, quanto ainda cabe hoje e a que horas o próximo post fica liberado.

Se algo não sai, o painel diz o motivo: sem destino ativo, fila vazia, fora da janela.

A **janela de publicação** também é editável no painel (campos *Publicar das … até as*), inclusive 0h–24h. Ela é persistida e sobrevive a reinícios.

Rotas: `GET /api/operation`, `POST /api/operation` (`{"running": true}`), `POST /api/operation/daily-limit` (`{"maxDailyPosts": 12}`), `POST /api/operation/window` (`{"start": 8, "end": 23}`).

## Fontes automáticas de ofertas

O bot busca ofertas sozinho, filtra, confirma o preço e publica. Fonte disponível: **Mercado Livre — Ofertas do dia** (`mercado-livre`), que lê a vitrine pública (48 produtos por página) e entende preço atual, preço anterior, nota, frete, Pix e imagem em JPG.

### Como o bot evita repetir oferta

Três travas independentes:

1. **Carência por destino** (`REPUBLISH_COOLDOWN_DAYS`, padrão 30 dias): o mesmo produto não volta para o mesmo grupo ou canal, mesmo que o preço mude. A comparação é por produto, não por preço.
2. **Memória de menor preço** (`INGESTION_MEMORY_HOURS`, padrão 72 h): um produto já enfileirado só entra de novo se bater o **menor preço já visto** com folga de `INGESTION_PRICE_DROP_TOLERANCE` (padrão 5%). Voltar ao preço antigo não gera post novo.
3. **Rodízio de categorias**: cada fonte varre uma categoria por rodada, em rodízio. Com 5 categorias e 2 páginas, o bot passa por ~480 produtos diferentes antes de repetir a vitrine.

Na hora de escolher o que entra na fila, os candidatos são ordenados por desconto, nota, volume de vendas e frete grátis. `maxPerNiche` impede que uma rodada inteira saia só de eletrônicos.

### Como o bot evita publicar preço velho

Uma oferta pode esperar na fila (grupo publica a cada 45 min). Antes de enviar:

- Se a confirmação de preço tem mais de `PRICE_FRESHNESS_MINUTES` (padrão 25), o bot relê a vitrine e revalida **toda a fila de uma vez**, com poucas requisições.
- Preço caiu: atualiza a legenda. Preço subiu mais que `PRICE_RISE_TOLERANCE` (padrão 2%): descarta. Produto saiu da vitrine: descarta.
- Se o desconto deixou de compensar (`MIN_DISCOUNT_AFTER_REFRESH`), descarta.
- Oferta parada há mais de `QUEUE_MAX_AGE_HOURS` (padrão 6) é expirada sem ir ao ar.

### Validade da promoção

Ofertas relâmpago do Mercado Livre trazem o horário exato de término, e o bot usa isso:

- Oferta que acaba em menos de  (padrão 30) não entra na fila.
- Na fila, quem está **prestes a acabar** fura a ordem de score e é publicado primeiro (, padrão 120).
- Item cuja promoção terminou enquanto esperava é descartado, nunca publicado.
- A legenda ganha  (ou ) quando há prazo conhecido.

E, para nada envelhecer na fila: a ingestão só mantém enfileirado o que será publicado nas próximas  (padrão 2), calculado pelo intervalo real entre posts. Fila curta significa oferta sempre recente.

### Filtros por fonte

| Campo | O que faz |
| --- | --- |
| `categories` | Categorias do marketplace varridas em rodízio (vazio = vitrine geral). |
| `pages` | Páginas por rodada (48 produtos por página). |
| `minDiscount` | Desconto mínimo sobre o preço anterior. |
| `minRating` | Nota mínima do produto. |
| `minPrice` / `maxPrice` | Faixa de preço aceita (`0` desliga o limite). |
| `maxPerRun` | Máximo de ofertas enfileiradas por rodada. |
| `maxPerNiche` | Máximo de ofertas do mesmo nicho na mesma rodada. |
| `blockedKeywords` | Palavras que reprovam o produto pelo título. |
| `enabled` | Liga a fonte no ciclo automático. |

A fonte nasce desativada, como os destinos. Rotas: `GET /api/sources`, `PATCH /api/sources/{id}`, `POST /api/sources/run`.

## Link de afiliado

**Nada é publicado sem link com atribuição.** O `PublicationService` recusa qualquer oferta cujo link não seja reconhecido como link de afiliado — `meli.la/...`, `/sec/...`, `/social/...?ref=...` ou uma URL com `matt_word` + `matt_tool`.

O Mercado Livre não publica API de afiliados: o link oficial só nasce no painel, logado. Por isso a forma recomendada é a extensão.

### Extensão do Chrome (recomendado)

A pasta `extension/` traz uma extensão que roda no seu Chrome já logado, gera o link no próprio painel e devolve para o OfertaFlow.

1. Abra `chrome://extensions`, ligue **Modo do desenvolvedor**.
2. **Carregar sem compactação** e escolha a pasta `C:Usersmathewppgrupsextension`.
3. Clique no ícone da extensão e preencha: endereço do OfertaFlow, o `ADMIN_TOKEN` e a página do gerador de links. Salve — ela testa a conexão na hora.
4. Deixe aberta uma aba logada no painel de afiliados.

A partir daí: a cada 30 s a extensão pergunta ao OfertaFlow quais produtos precisam de link, gera cada um no painel e devolve. Ela também captura links que **você** gerar manualmente, por um hook nas requisições da página.

Enquanto a extensão não responde, o modo cai para `none` e **nada é publicado** — a oferta espera na fila com status `awaiting-link` em vez de sair com link sem comissão.

### Gerador por HTTP (alternativa sem extensão)

Se preferir, copie do DevTools a requisição que o painel faz ao gerar um link (**Copy as cURL**) e rode:

```powershell
node scripts/import-linkbuilder.js curl.txt "https://www.mercadolivre.com.br/produto/p/MLB123"
```

Isso grava `data/linkbuilder.json` e o bot passa a gerar os links sozinho por HTTP, com cache e detecção de sessão expirada.

### Parâmetros de atribuição (só emergência)

`MELI_AFFILIATE_PARAMS` aplica `matt_word`/`matt_tool` na URL do produto. Não é o link canônico do painel, então fica desligado por padrão (`ALLOW_PARAM_LINKS=false`).

## Saúde e limpeza

- `GET /api/readiness` mostra o modo de atribuição, links em cache, validade da sessão e os alertas recentes.
- Alertas cobrem fonte vazia (sinal de que o marketplace mudou a página), erro de coleta e sessão de afiliado expirada.
- A cada 6 horas o histórico é podado: publicações e eventos além de `RETENTION_PUBLICATION_DAYS`, itens de fila encerrados além de `RETENTION_QUEUE_DAYS` e ofertas acima de `RETENTION_MAX_OFFERS`.

## Próxima etapa

Novos marketplaces entram como adaptadores em `src/sources/`: basta expor `id`, `label`, `marketplace` e um `collect()` que devolva ofertas no formato comum. Credenciais e identificadores de afiliado ficam apenas no ambiente de execução.

## Colocar os primeiros canais em operacao

1. Mantenha `DRY_RUN=true`, configure as credenciais da Z-API e inicie o painel.
2. Clique em **Sincronizar Z-API**. Canais novos são importados desativados por segurança.
3. Confirme se **Achadinhos da Isa** e **Achados Pro** aparecem como sincronizados.
4. Ajuste desconto mínimo, limite diário e intervalo de cada canal; salve-os ainda desativados.
5. Adicione uma oferta de demonstração e processe a fila para validar legenda e classificação sem enviar mensagens.
6. Homologue o envio de imagem para um canal de teste antes de definir `ZAPI_CHANNEL_IMAGE_ENABLED=true`.
7. Somente depois da homologação, defina `DRY_RUN=false` e ative um canal por vez no painel.

O endpoint administrativo `GET /api/readiness` mostra, sem revelar credenciais, se a Z-API está configurada, se imagens em canais estão liberadas e quais canais estão ativos.
