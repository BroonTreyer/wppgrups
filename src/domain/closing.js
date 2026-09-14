/**
 * O fechamento do dia no grupo: a mensagem de "vitrine fechada" e a enquete.
 *
 * Existe porque o grupo parava de publicar no meio da noite sem dizer nada — e
 * silencio sem aviso parece grupo abandonado. O fechamento transforma a pausa em
 * compromisso ("amanha as 5h tem mais") e da a quem so observa um motivo para
 * interagir.
 *
 * A mensagem roda entre variantes para nao virar texto que o olho pula. A enquete
 * NAO roda: pergunta e opcoes iguais todo dia deixam os votos comparaveis entre
 * dias — e so assim eles dizem alguma coisa sobre o que o grupo quer.
 *
 * O horario de volta ("5h") esta escrito no texto. Mudou a janela do agendador,
 * muda aqui tambem — senao o grupo promete o que nao cumpre.
 */

const FUSO = "America/Sao_Paulo";

export const CLOSING_MESSAGES = [
  "🌙 *Vitrine fechada por hoje!*\n\nObrigada por garimpar com a gente 💕\nQuem não aproveitou hoje, sem problema: amanhã, a partir das 5h, tem oferta nova chegando.\n\n👇 Antes de dormir, vota na enquete e conta o que você quer ver amanhã.",
  "✨ *Encerramos as ofertas de hoje!*\n\nSe alguma passou batido, fica tranquila: amanhã cedinho, às 5h, a gente recomeça com achado novo.\n\n👇 Ajuda a gente a escolher o que garimpar: vota aqui embaixo.",
  "💄 *Por hoje é só, gente!*\n\nAmanhã às 5h tem mais — e quem perdeu alguma oferta hoje ganha uma nova chance.\n\n👇 Vota na enquete: o que não pode faltar amanhã?",
  "🌙 *Fim das ofertas de hoje!*\n\nDescansa que amanhã, a partir das 5h, tem mais beleza com desconto por aqui.\n\n💡 Dica: pode deixar o grupo silenciado, as ofertas ficam te esperando.\n\n👇 Conta pra gente na enquete o que você quer ver.",
  "💕 *Fechamos a vitrine de hoje!*\n\nObrigada por estar aqui. Quem não aproveitou hoje, amanhã tem mais: às 5h a gente volta.\n\n👇 Vota rapidinho: o que você mais quer encontrar em promoção?"
];

export const CLOSING_POLL = {
  question: "🗳️ Pra amanhã: o que você quer ver mais por aqui? (pode marcar mais de uma)",
  options: ["🧴 Skincare e rosto", "💇‍♀️ Cabelo", "🌸 Perfumes", "💄 Maquiagem", "🛁 Corpo e banho", "💅 Unhas e mãos"]
};

const diaDoCalendario = (date) => Math.floor(Date.parse(new Intl.DateTimeFormat("en-CA", { timeZone: FUSO }).format(date)) / 86_400_000);

export function closingFor(date = new Date()) {
  return { message: CLOSING_MESSAGES[diaDoCalendario(date) % CLOSING_MESSAGES.length], poll: CLOSING_POLL };
}
