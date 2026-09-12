import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { DEFAULT_NICHES } from "../domain/niches.js";
import { ML_CATEGORIES } from "../sources/mercado-livre.js";
import { SAMPLE_OFFER } from "../mock/sample-offer.js";

async function jsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1_000_000) {
      const error = new Error("Corpo da requisicao excede 1 MB");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function send(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body, null, 2));
}

export function createApp({ config, destinationService, publicationService, queueService, productLinkService, ingestionService, affiliateLinkService, operationService }) {
  return createServer(async (request, response) => {
    const url = new URL(request.url, config.appBaseUrl);
    try {
      if (request.method === "GET" && url.pathname === "/health") {
        return send(response, 200, { status: "ok", dryRun: config.dryRun, timestamp: new Date().toISOString() });
      }
      if (request.method === "GET" && url.pathname === "/") {
        const html = await readFile(new URL("../../public/index.html", import.meta.url), "utf8");
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        return response.end(html);
      }
      if (request.method === "POST" && url.pathname === "/webhooks/zapi/status") {
        if (url.searchParams.get("secret") !== config.zapi.webhookSecret) return send(response, 401, { error: "Webhook nao autorizado" });
        await publicationService.recordDeliveryEvent(await jsonBody(request));
        return send(response, 202, { accepted: true });
      }
      if (request.headers.authorization !== `Bearer ${config.adminToken}`) return send(response, 401, { error: "Nao autorizado" });
      if (request.method === "GET" && url.pathname === "/api/readiness") {
        const destinations = await destinationService.list();
        const affiliate = await affiliateLinkService.status();
        const alerts = await ingestionService.alerts();
        return send(response, 200, {
          readyForRealSending: !config.dryRun && Boolean(config.zapi.instanceId && config.zapi.instanceToken && config.zapi.clientToken) && affiliate.mode !== "none",
          affiliate,
          alerts: alerts.slice(-10).toReversed(),
          dryRun: config.dryRun,
          zapiConfigured: Boolean(config.zapi.instanceId && config.zapi.instanceToken && config.zapi.clientToken),
          channelImageEnabled: config.zapi.channelImageEnabled,
          activeChannels: destinations.filter((item) => item.type === "channel" && item.active && item.available !== false).length,
          channels: destinations.filter((item) => item.type === "channel").map(({ id, name, active, available, nicheIds, minDiscount, maxDailyPosts, minMinutesBetweenPosts }) => ({ id, name, active, available, nicheIds, minDiscount, maxDailyPosts, minMinutesBetweenPosts }))
        });
      }
      if (request.method === "GET" && url.pathname === "/api/affiliate/pending") {
        // A extensao manda o proprio ultimo erro no ping. Sem isso o servidor ve
        // "extensao viva" e "zero link" ao mesmo tempo e nao sabe por que — foi
        // exatamente o buraco de 12/09/2026, depois que erro de ambiente deixou
        // (com razao) de ser reportado como falha do produto. Nao culpar o
        // produto nao pode significar ficar cego.
        await affiliateLinkService.touchExtension(url.searchParams.get("erro"));
        return send(response, 200, { pending: await affiliateLinkService.pending(url.searchParams.get("limit") ?? 5) });
      }
      if (request.method === "POST" && url.pathname === "/api/affiliate/link") {
        await affiliateLinkService.touchExtension();
        return send(response, 200, await affiliateLinkService.resolve(await jsonBody(request)));
      }
      if (request.method === "POST" && url.pathname === "/api/affiliate/retry") return send(response, 200, await affiliateLinkService.retryFailed());
      if (request.method === "GET" && url.pathname === "/api/affiliate/status") return send(response, 200, await affiliateLinkService.status());
      if (request.method === "GET" && url.pathname === "/api/operation") return send(response, 200, await operationService.status());
      if (request.method === "POST" && url.pathname === "/api/operation") {
        const body = await jsonBody(request);
        await operationService.setRunning(body.running);
        if (body.running) await ingestionService.run().catch(() => ({}));
        return send(response, 200, await operationService.status());
      }
      if (request.method === "POST" && url.pathname === "/api/operation/window") {
        return send(response, 200, await operationService.setWindow(await jsonBody(request)));
      }
      if (request.method === "POST" && url.pathname === "/api/operation/daily-limit") {
        return send(response, 200, await operationService.setDailyLimit((await jsonBody(request)).maxDailyPosts));
      }
      if (request.method === "GET" && url.pathname === "/api/niches") return send(response, 200, DEFAULT_NICHES);
      if (request.method === "GET" && url.pathname === "/api/sources") return send(response, 200, { sources: await ingestionService.list(), categories: ML_CATEGORIES });
      if (request.method === "POST" && url.pathname === "/api/sources/run") return send(response, 200, await ingestionService.run(await jsonBody(request)));
      // Colheita da extensao: produtos lidos da tela do navegador do dono, de
      // paginas que o servidor nao alcanca (loja oficial de marca, busca).
      if (request.method === "POST" && url.pathname === "/api/sources/harvest") {
        const corpo = await jsonBody(request);
        const resultado = await ingestionService.harvest(corpo);
        // Log de uma linha por colheita. Sem isto nao ha como saber, do lado do
        // servidor, se a extensao chegou a rodar — e o primeiro diagnostico
        // quando o dono pergunta "colhi, e ai?".
        const pagina = String(corpo?.produtos?.[0]?.pageUrl ?? "?").replace("https://www.mercadolivre.com.br/loja/", "");
        const porQue = Object.entries(resultado.rejectedBy ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 3)
          .map(([motivo, quantos]) => `${quantos} ${motivo}`).join("; ");
        // A paginacao so pode ser diagnosticada de dentro do navegador: estas
        // paginas respondem anti-bot para o servidor. Sem registrar o que a
        // extensao viu, "a colheita nao passa da pagina 1" fica sem evidencia —
        // foi assim que 990 colheitas rodaram sem ninguem notar o teto de 48.
        const d = corpo?.diagnostico;
        const paginacao = d
          ? ` [pag: offset ${d.offset}, botao ${d.botaoSeguinte ? "sim" : "NAO"}, links _Desde_ ${d.linksDesde}, proxima ${d.paginacaoNaTela ? "sim" : "NAO"}]`
          : "";
        console.log(`Colheita ${pagina}: ${resultado.collected ?? 0} lidos, ${resultado.enqueued ?? 0} na fila, ${resultado.rejected ?? 0} filtrados${porQue ? " (" + porQue + ")" : ""}${paginacao}`);
        return send(response, 200, resultado);
      }
      const sourceMatch = url.pathname.match(/^\/api\/sources\/(.+)$/);
      if (request.method === "PATCH" && sourceMatch) return send(response, 200, await ingestionService.configure(decodeURIComponent(sourceMatch[1]), await jsonBody(request)));
      if (request.method === "GET" && url.pathname === "/api/destinations") return send(response, 200, await destinationService.list());
      if (request.method === "POST" && url.pathname === "/api/destinations/sync") return send(response, 200, await destinationService.sync());
      if (request.method === "POST" && url.pathname === "/api/destinations/test") return send(response, 201, await destinationService.addTestDestination(await jsonBody(request)));
      const destinationMatch = url.pathname.match(/^\/api\/destinations\/(.+)$/);
      if (request.method === "PATCH" && destinationMatch) return send(response, 200, await destinationService.configure(decodeURIComponent(destinationMatch[1]), await jsonBody(request)));
      if (request.method === "GET" && url.pathname === "/api/queue") return send(response, 200, await queueService.list());
      if (request.method === "POST" && url.pathname === "/api/products/preview") return send(response, 200, await productLinkService.preview(await jsonBody(request)));
      if (request.method === "POST" && url.pathname === "/api/queue/process") return send(response, 200, await queueService.processNext());
      if (request.method === "POST" && url.pathname === "/api/offers") return send(response, 202, await queueService.enqueue(await jsonBody(request)));
      if (request.method === "POST" && url.pathname === "/api/demo/enqueue") return send(response, 202, await queueService.enqueue(SAMPLE_OFFER));
      if (request.method === "POST" && url.pathname === "/api/offers/publish-now") return send(response, 200, await publicationService.publish(await jsonBody(request)));
      return send(response, 404, { error: "Rota nao encontrada" });
    } catch (error) {
      const clientError = error instanceof SyntaxError || /inval|obrigat|deve|Selecione|Sincronize/.test(error.message);
      return send(response, error.statusCode ?? (clientError ? 400 : 500), { error: error.message });
    }
  });
}
