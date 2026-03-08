const fs = require("fs");
const myConsole = new console.Console(fs.createWriteStream("./logs.txt"));

const { getState, setState, clearState } = require("../services/stateService");
const {
  listDoctors,
  listFreeSlots,
  getPatientByWaId,
  upsertPatient,
  bookAppointment,
  listMyAppointments,
  cancelAppointment
} = require("../services/clinicService");
const { sendText } = require("../services/whatsappSend");

const VerifyToken = (req, res) => {
  const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN;

  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

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

    res.send("EVENT_RECEIVED");

    if (!wa_id) return;

    const text = getUserText(message);
    console.log("FROM:", wa_id, "TEXT:", text);

    if (text === "0") {
      await clearState(wa_id);
      await safeSendText(
        wa_id,
        "✅ Reiniciado.\n\n1) Agendar cita\n2) Consultar cita\n3) Cancelar cita"
      );
      return;
    }

    let current = await getState(wa_id);
    if (!current) {
      current = await setState(wa_id, "MENU", {});
      await safeSendText(
        wa_id,
        "Hola 👋\n\n1) Agendar cita\n2) Consultar cita\n3) Cancelar cita\n\nResponde con un número."
      );
    }

    // MENU
    if (current.state === "MENU") {
      if (text === "1") {
        const patient = await getPatientByWaId(wa_id);

        if (!patient?.full_name) {
          await setState(wa_id, "REGISTER_NAME", {});
          await safeSendText(wa_id, "🧑 Antes de agendar, escribe tu nombre completo.");
          return;
        }

        if (!patient?.identity_number) {
          await setState(wa_id, "REGISTER_IDENTITY", { full_name: patient.full_name });
          await safeSendText(wa_id, "🪪 Escribe tu número de identidad.");
          return;
        }

        const doctors = await listDoctors();
        const lines = doctors.map(d => `${d.id}) ${d.full_name} - ${d.specialty}`).join("\n");
        await setState(wa_id, "PICK_DOCTOR", {});
        await safeSendText(wa_id, `👨‍⚕️ Elige un doctor:\n${lines}\n\nResponde con el número.`);
        return;
      }

      if (text === "2") {
        const appts = await listMyAppointments(wa_id);

        if (!appts.length) {
          await safeSendText(wa_id, "📋 No tienes citas registradas.\n\nEscribe 1 para agendar o 0 para reiniciar.");
          return;
        }

        const lines = appts.map(a => {
          const date = String(a.appt_date).slice(0, 10);
          const time = String(a.appt_time).slice(0, 5);
          return `ID ${a.id} | ${date} ${time} | ${a.doctor_name} (${a.specialty}) | ${a.status}`;
        }).join("\n");

        await safeSendText(wa_id, `📋 Tus citas:\n${lines}\n\nEscribe 0 para menú.`);
        return;
      }

      if (text === "3") {
        const appts = await listMyAppointments(wa_id);

        if (!appts.length) {
          await safeSendText(wa_id, "❌ No tienes citas para cancelar.\n\nEscribe 1 para agendar o 0 para reiniciar.");
          return;
        }

        const lines = appts.map(a => {
          const date = String(a.appt_date).slice(0, 10);
          const time = String(a.appt_time).slice(0, 5);
          return `ID ${a.id} | ${date} ${time} | ${a.doctor_name}`;
        }).join("\n");

        await setState(wa_id, "CANCEL_PICK", {});
        await safeSendText(wa_id, `🗑 Elige el ID de la cita que deseas cancelar:\n${lines}`);
        return;
      }

      await safeSendText(
        wa_id,
        "Opción inválida.\n\n1) Agendar cita\n2) Consultar cita\n3) Cancelar cita\n0) Reiniciar"
      );
      return;
    }

    // REGISTRO NOMBRE
    if (current.state === "REGISTER_NAME") {
      await setState(wa_id, "REGISTER_IDENTITY", { full_name: text });
      await safeSendText(wa_id, "🪪 Ahora escribe tu número de identidad.");
      return;
    }

    // REGISTRO IDENTIDAD
    if (current.state === "REGISTER_IDENTITY") {
      const full_name = current.temp.full_name || null;
      const identity_number = text;

      await upsertPatient({ wa_id, full_name, identity_number });

      const doctors = await listDoctors();
      const lines = doctors.map(d => `${d.id}) ${d.full_name} - ${d.specialty}`).join("\n");
      await setState(wa_id, "PICK_DOCTOR", {});
      await safeSendText(
        wa_id,
        `✅ Datos guardados.\n\n👨‍⚕️ Elige un doctor:\n${lines}\n\nResponde con el número.`
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
      await safeSendText(wa_id, "📝 ¿Motivo de la cita? Si no, responde: NA");
      return;
    }

    // PICK_REASON
    if (current.state === "PICK_REASON") {
      const reason = text === "NA" ? null : text;
      await setState(wa_id, "CONFIRM", { ...current.temp, reason });
      await safeSendText(wa_id, "✅ Confirmar cita?\n1) Sí\n2) No\n0) Reiniciar");
      return;
    }

    // CONFIRM
    if (current.state === "CONFIRM") {
      if (text === "2") {
        await clearState(wa_id);
        await safeSendText(wa_id, "❌ Cancelado.\n\n1) Agendar cita\n2) Consultar cita\n3) Cancelar cita");
        return;
      }

      if (text !== "1") {
        await safeSendText(wa_id, "Responde 1 (Sí) o 2 (No).");
        return;
      }

      const patient = await getPatientByWaId(wa_id);

      const { doctor_id, slot_id, reason } = current.temp;

      const result = await bookAppointment({
        wa_id,
        full_name: patient?.full_name || null,
        identity_number: patient?.identity_number || null,
        doctor_id,
        slot_id,
        reason,
      });

      await clearState(wa_id);

      const time = String(result.appointment.appt_time).slice(0, 5);
      const date = String(result.appointment.appt_date).slice(0, 10);

      await safeSendText(
        wa_id,
        `✅ Cita agendada!\n📅 ${date}\n⏰ ${time}\n\nEscribe 0 para menú.`
      );
      return;
    }

    // CANCELAR
    if (current.state === "CANCEL_PICK") {
      const appointment_id = parseInt(text, 10);
      if (!appointment_id) {
        await safeSendText(wa_id, "❌ ID inválido. Escribe el ID de la cita a cancelar.");
        return;
      }

      try {
        await cancelAppointment(wa_id, appointment_id);
        await clearState(wa_id);
        await safeSendText(
          wa_id,
          "✅ Cita cancelada correctamente.\nEl horario volvió a quedar disponible.\n\nEscribe 0 para menú."
        );
      } catch (e) {
        await safeSendText(wa_id, "❌ No pude cancelar esa cita. Verifica el ID o escribe 0 para reiniciar.");
      }
      return;
    }

    await clearState(wa_id);
    await safeSendText(wa_id, "⚠️ Reinicié el flujo. Escribe 0 para empezar.");
  } catch (e) {
    console.log("Webhook error:", e?.response?.data || e);
  }
};

module.exports = { VerifyToken, ReceiveMessage, getUserText };