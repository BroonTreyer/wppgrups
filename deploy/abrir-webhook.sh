#!/bin/sh
# Expoe na internet SO o webhook de mensagens recebidas da Z-API (conversa por
# audio), com HTTPS automatico do Caddy. O painel continua so em 127.0.0.1.
# Rodar do PC:  ssh root@2.28.102.201 'sh -s' < deploy/abrir-webhook.sh
set -e
cp -p /etc/caddy/Caddyfile /etc/caddy/Caddyfile.original 2>/dev/null || true
cat > /etc/caddy/Caddyfile <<'EOF'
# OfertaFlow: a UNICA coisa exposta na internet e o webhook de mensagens
# recebidas da Z-API (conversa por audio). Qualquer outro caminho: 404.
2-28-102-201.sslip.io {
	@webhook {
		method POST
		path /webhooks/zapi/received
	}
	handle @webhook {
		request_body {
			max_size 2MB
		}
		reverse_proxy 127.0.0.1:3000
	}
	handle {
		respond 404
	}
	log {
		output file /var/log/caddy/ofertaflow.log
	}
}
EOF
mkdir -p /var/log/caddy && chown caddy: /var/log/caddy
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
ufw allow 80/tcp     # o Let's Encrypt valida o certificado por aqui
ufw allow 443/tcp
systemctl enable --now caddy
systemctl reload caddy
sleep 20
echo "--- teste (esperado 404 na raiz e 401 no webhook sem senha):"
curl -s -o /dev/null -w "raiz %{http_code}\n" https://2-28-102-201.sslip.io/
curl -s -o /dev/null -w "webhook sem senha %{http_code}\n" -X POST https://2-28-102-201.sslip.io/webhooks/zapi/received
