import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { DEFAULT_NICHES } from "../domain/niches.js";
import { SAMPLE_OFFER } from "../mock/sample-offer.js";

async function jsonBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function send(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body, null, 2));
}

export function createApp({ config, destinationService, publicationService, queueService }) {
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
      if (request.method === "GET" && url.pathname === "/api/niches") return send(response, 200, DEFAULT_NICHES);
      if (request.method === "GET" && url.pathname === "/api/destinations") return send(response, 200, await destinationService.list());
      if (request.method === "POST" && url.pathname === "/api/destinations/sync") return send(response, 200, await destinationService.sync());
      if (request.method === "POST" && url.pathname === "/api/destinations/test") return send(response, 201, await destinationService.addTestDestination(await jsonBody(request)));
      const destinationMatch = url.pathname.match(/^\/api\/destinations\/(.+)$/);
      if (request.method === "PATCH" && destinationMatch) return send(response, 200, await destinationService.configure(decodeURIComponent(destinationMatch[1]), await jsonBody(request)));
      if (request.method === "GET" && url.pathname === "/api/queue") return send(response, 200, await queueService.list());
      if (request.method === "POST" && url.pathname === "/api/queue/process") return send(response, 200, await queueService.processNext());
      if (request.method === "POST" && url.pathname === "/api/offers") return send(response, 202, await queueService.enqueue(await jsonBody(request)));
      if (request.method === "POST" && url.pathname === "/api/demo/enqueue") return send(response, 202, await queueService.enqueue(SAMPLE_OFFER));
      if (request.method === "POST" && url.pathname === "/api/offers/publish-now") return send(response, 200, await publicationService.publish(await jsonBody(request)));
      return send(response, 404, { error: "Rota nao encontrada" });
    } catch (error) {
      return send(response, error instanceof SyntaxError ? 400 : 500, { error: error.message });
    }
  });
}
