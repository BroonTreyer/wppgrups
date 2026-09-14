import { closingFor } from "../domain/closing.js";

const FUSO = "America/Sao_Paulo";
const diaDe = (date) => new Intl.DateTimeFormat("en-CA", { timeZone: FUSO }).format(date);
const horaMinuto = (date) => new Intl.DateTimeFormat("en-GB", { timeZone: FUSO, hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
  .format(date).split(":").map(Number);
const MAX_ATTEMPTS = 3;

/**
 * Manda o fechamento do dia (mensagem + enquete) quando a janela de publicacao
 * fecha. O gatilho e o `endHour` do agendador, nao uma hora fixa: mudou a janela,
 * o fechamento acompanha.
 *
 * Uma vez por grupo por dia, com os passos registrados um a um. Se o texto saiu e
 * a enquete falhou, a nova tentativa manda SO a enquete — repetir o "fechamos por
 * hoje" duas vezes no grupo e pior que atrasar a enquete.
 */
export class DailyClosingService {
  constructor({ store, zapi, operationService, config, clock = () => new Date(), pause = (ms) => new Promise((r) => setTimeout(r, ms)), logger = console }) {
    this.store = store;
    this.zapi = zapi;
    this.operationService = operationService;
    this.config = config;
    this.clock = clock;
    this.pause = pause;
    this.logger = logger;
  }

  isDue(now = this.clock()) {
    const [hora, minuto] = horaMinuto(now);
    return hora === this.config.scheduler.endHour && minuto < this.config.dailyClosing.graceMinutes;
  }

  async tick({ force = false, groupIds } = {}) {
    const alvos = groupIds ?? this.config.dailyClosing.groups;
    if (!alvos.length) return { skipped: "nenhum grupo configurado" };
    const now = this.clock();
    if (!force && !this.isDue(now)) return { skipped: "fora do horario de fechamento" };
    // Operacao pausada o dia todo e grupo mudo: "fechamos por hoje" soaria estranho.
    if (!force && this.operationService && !(await this.operationService.isRunning())) return { skipped: "operacao pausada" };

    const dia = diaDe(now);
    const state = await this.store.read();
    const { message, poll } = closingFor(now);
    const results = [];

    for (const groupId of alvos) {
      const destino = state.destinations.find((item) => item.id === groupId);
      if (!force && !destino?.active) {
        results.push({ groupId, skipped: "destino inativo" });
        continue;
      }
      const anterior = state.dailyClosings?.[groupId];
      const registro = anterior?.day === dia ? structuredClone(anterior) : { day: dia, steps: {}, attempts: 0, done: false };
      if (registro.done) {
        results.push({ groupId, skipped: "ja enviado hoje" });
        continue;
      }
      if (registro.attempts >= MAX_ATTEMPTS) {
        results.push({ groupId, skipped: `desistiu apos ${MAX_ATTEMPTS} tentativas`, lastError: registro.lastError });
        continue;
      }

      if (this.config.dryRun) {
        await this.save(groupId, { ...registro, done: true, dryRun: true, at: now.toISOString() });
        results.push({ groupId, dryRun: true });
        continue;
      }

      try {
        if (!registro.steps.message) {
          await this.zapi.sendText({ destinationId: groupId, message });
          registro.steps.message = this.clock().toISOString();
          await this.save(groupId, registro);
          // A enquete precisa chegar DEPOIS do texto que a apresenta.
          await this.pause(2000);
        }
        if (!registro.steps.poll) {
          await this.zapi.sendPoll({ destinationId: groupId, question: poll.question, options: poll.options, maxOptions: poll.options.length });
          registro.steps.poll = this.clock().toISOString();
        }
        registro.done = true;
        registro.lastError = null;
        await this.save(groupId, registro);
        results.push({ groupId, sent: true });
      } catch (error) {
        registro.attempts += 1;
        registro.lastError = error.message;
        await this.save(groupId, registro);
        results.push({ groupId, error: error.message, attempts: registro.attempts });
      }
    }
    return { day: dia, results };
  }

  async save(groupId, registro) {
    await this.store.update((state) => {
      state.dailyClosings ??= {};
      state.dailyClosings[groupId] = registro;
    });
  }

  async status() {
    return { groups: this.config.dailyClosing.groups, closeAtHour: this.config.scheduler.endHour, sent: (await this.store.read()).dailyClosings ?? {} };
  }
}
