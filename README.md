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
- Deduplicação por marketplace, produto e preço durante 24 horas.

Enquanto `DRY_RUN=true`, nenhuma mensagem é enviada ao WhatsApp. Troque para `false` somente depois de revisar os destinos.

O envio para canais permanece protegido por `ZAPI_CHANNEL_IMAGE_ENABLED=false`. Depois de homologar uma imagem em um destino `@newsletter`, altere para `true`.

## Próxima etapa

Os marketplaces entram como adaptadores que convertem produtos para o formato comum de oferta. Credenciais reais e identificadores de afiliado devem ser configurados apenas no ambiente de execução.
