const fs = require("fs");
const myConsole = new console.Console(fs.createWriteStream("./logs.txt"));

const { getState, setState, clearState } = require("../services/stateService");
const { listDoctors, listFreeSlots, bookAppointment } = require("../services/clinicService");
const { sendText } = require("../services/whatsappSend");

const VerifyToken = (req, res) => {
  const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN;

  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  console.log("mode:", mode);
  console.log("token:", token);
  console.log("challenge:", challenge);
  console.log("env:", VERIFY_TOKEN);

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
};

function getUserText(message) {
  if (!message) return "";
  if (message.type === "text") return (message.text?.body || "").trim();
  if (message.type === "interactive") {
    return (
      message.interactive?.list_reply?.id ||
      message.interactive?.button_reply?.id ||
      message.interactive?.list_reply?.title ||
      message.interactive?.button_reply?.title ||
      ""
    ).trim();
  }
  return "";
}

// ✅ Si no tienes token/phoneId, no truena: solo loggea.
async function safeSendText(to, text) {
  const token = process.env.WHATSAPP_TOKEN;
  const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID;

  if (!token || !phoneId) {
    console.log("BOT (no-send mode) ->", to, ":", text);
    myConsole.log({ to, text });
    return;
  }

  await sendText(to, text);
}

const ReceiveMessage = async (req, res) => {
  try {
    const entry = req.body?.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;

    const message = value?.messages?.[0];
    const wa_id = message?.from;

    // Responder rápido a Meta
    res.send("EVENT_RECEIVED");

    // A veces llegan eventos de status, no mensajes
    if (!wa_id) return;

    const text = getUserText(message);
    console.log("FROM:", wa_id, "TEXT:", text);

    // Reinicio
    if (text === "0") {
      await clearState(wa_id);
      await safeSendText(
        wa_id,
        "✅ Reiniciado.\n\n1) Agendar cita\n2) Consultar cita\n3) Cancelar/Reprogramar"
      );
      return;
    }

    // ✅ Arreglo clave: si no hay estado, lo creamos PERO seguimos procesando el mensaje
    let current = await getState(wa_id);
    if (!current) {
      current = await setState(wa_id, "MENU", {});
      // NO return
      await safeSendText(
        wa_id,
        "Hola 👋\n\n1) Agendar cita\n2) Consultar cita\n3) Cancelar/Reprogramar\n\nResponde con un número."
      );
      // seguimos procesando abajo (por si el texto ya era "1")
    }

    // MENU
    if (current.state === "MENU") {
      if (text === "1") {
        const doctors = await listDoctors();
        const lines = doctors.map(d => `${d.id}) ${d.full_name} - ${d.specialty}`).join("\n");
        await setState(wa_id, "PICK_DOCTOR", {});
        await safeSendText(wa_id, `👨‍⚕️ Elige un doctor:\n${lines}\n\nResponde con el número.`);
        return;
      }

      await safeSendText(
        wa_id,
        "Opción inválida. Responde:\n1) Agendar\n2) Consultar\n3) Cancelar/Reprogramar\n0) Reiniciar"
      );
      return;
    }

    // PICK_DOCTOR
    if (current.state === "PICK_DOCTOR") {
      const doctor_id = parseInt(text, 10);
      if (!doctor_id) {
        await safeSendText(wa_id, "❌ Doctor inválido. Responde con el número del doctor.");
        return;
      }
      await setState(wa_id, "PICK_DATE", { doctor_id });
      await safeSendText(wa_id, "📅 Escribe la fecha (YYYY-MM-DD). Ej: 2026-03-04");
      return;
    }

    // PICK_DATE
    if (current.state === "PICK_DATE") {
      const date = text;
      const doctor_id = current.temp.doctor_id;

      const slots = await listFreeSlots(doctor_id, date);
      if (!slots.length) {
        await safeSendText(
          wa_id,
          "❌ No hay cupos para esa fecha. Prueba otra fecha (YYYY-MM-DD) o escribe 0 para reiniciar."
        );
        return;
      }

      const lines = slots.map(s => `${s.id}) ${String(s.slot_time).slice(0, 5)}`).join("\n");
      await setState(wa_id, "PICK_SLOT", { doctor_id, date });
      await safeSendText(wa_id, `⏰ Cupos disponibles:\n${lines}\n\nResponde con el ID del cupo.`);
      return;
    }

    // PICK_SLOT
    if (current.state === "PICK_SLOT") {
      const slot_id = parseInt(text, 10);
      if (!slot_id) {
        await safeSendText(wa_id, "❌ Cupo inválido. Responde con el ID del cupo.");
        return;
      }
      await setState(wa_id, "PICK_REASON", { ...current.temp, slot_id });
      await safeSendText(wa_id, "📝 ¿Motivo de la cita? (ej: dolor de cabeza). Si no, responde: NA");
      return;
    }

    // PICK_REASON
    if (current.state === "PICK_REASON") {
      const reason = text === "NA" ? null : text;
      await setState(wa_id, "CONFIRM", { ...current.temp, reason });
      await safeSendText(wa_id, "✅ Confirmar cita?\nResponde:\n1) Sí\n2) No (cancelar)\n0) Reiniciar");
      return;
    }

    // CONFIRM
    if (current.state === "CONFIRM") {
      if (text === "2") {
        await clearState(wa_id);
        await safeSendText(wa_id, "❌ Cancelado.\n\n1) Agendar cita\n2) Consultar cita\n3) Cancelar/Reprogramar");
        return;
      }

      if (text !== "1") {
        await safeSendText(wa_id, "Responde 1 (Sí) o 2 (No).");
        return;
      }

      const { doctor_id, slot_id, reason } = current.temp;

      const result = await bookAppointment({
        wa_id,
        full_name: null,
        doctor_id,
        slot_id,
        reason,
      });

      await clearState(wa_id);

      const time = String(result.appointment.appt_time).slice(0, 5);
      const date = String(result.appointment.appt_date).slice(0, 10);

      await safeSendText(wa_id, `✅ Cita agendada!\n📅 ${date}\n⏰ ${time}\n\nEscribe 0 para menú.`);
      return;
    }

    // fallback
    await clearState(wa_id);
    await safeSendText(wa_id, "⚠️ Reinicié el flujo. Escribe 0 para empezar.");
  } catch (e) {
    console.log("Webhook error:", e);
  }
};

module.exports = { VerifyToken, ReceiveMessage, getUserText };