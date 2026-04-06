const fs = require("fs");
const myConsole = new console.Console(fs.createWriteStream("./logs.txt"));

const { getState, setState, clearState } = require("../services/stateService");
const {
  listSpecialties,
  listDoctors,
  listFreeSlots,
  findNextAvailableDate,
  getPatientByWaId,
  upsertPatient,
  bookAppointment,
  listMyAppointments,
  cancelAppointment,
} = require("../services/clinicService");
const { sendText } = require("../services/whatsappSend");

const MENU_TEXT =
  "Hola 👋 Soy DocBot Citas, asistente del hospital 🏥.\n\n¿En qué le puedo ayudar hoy?\n\n1) Agendar cita\n2) Consultar citas\n3) Cancelar cita\n0) Reiniciar";

const GOODBYE_TEXT =
  "Entendido 👍\nHa sido un gusto atenderle.\nPuede escribirnos nuevamente cuando lo necesite.";

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

function normalizeText(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ");
}

function parseNumericOption(text) {
  const n = parseInt(String(text || "").trim(), 10);
  return Number.isNaN(n) ? null : n;
}

function isYes(text) {
  const normalized = normalizeText(text);
  return ["1", "si", "sí", "s", "confirmar", "ok", "claro"].includes(normalized);
}

function isNo(text) {
  const normalized = normalizeText(text);
  return ["2", "no", "n", "cancelar", "salir", "finalizar"].includes(normalized);
}

function isAnotherDay(text) {
  const normalized = normalizeText(text);
  return [
    "9",
    "otro",
    "otra",
    "otro dia",
    "otra fecha",
    "ver otra opcion",
    "ver otro dia",
    "otro horario",
    "agendar otro",
  ].includes(normalized);
}

function titleCase(value) {
  return String(value || "")
    .split(" ")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function getTegucigalpaTodayISO() {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Tegucigalpa",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return formatter.format(new Date());
}

function getNextDateISO(dateText) {
  const [year, month, day] = String(dateText).split("-").map(Number);
  const utcDate = new Date(Date.UTC(year, month - 1, day));
  utcDate.setUTCDate(utcDate.getUTCDate() + 1);
  return utcDate.toISOString().slice(0, 10);
}

function formatDateHuman(dateText) {
  if (!dateText) return "";
  const date = new Date(`${String(dateText).slice(0, 10)}T12:00:00Z`);
  const formatted = new Intl.DateTimeFormat("es-HN", {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: "UTC",
  }).format(date);
  return titleCase(formatted);
}

function formatTimeHuman(timeText) {
  if (!timeText) return "";
  const raw = String(timeText).slice(0, 8);
  const date = new Date(`1970-01-01T${raw}Z`);
  return new Intl.DateTimeFormat("es-HN", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: "UTC",
  }).format(date);
}

function buildNumberedLines(items, formatter) {
  return items.map((item, index) => `${index + 1}) ${formatter(item)}`).join("\n");
}

async function safeSendText(to, text) {
  const token = process.env.WHATSAPP_TOKEN;
  const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID;

  console.log("DEBUG TOKEN:", token ? "OK" : "UNDEFINED");
  console.log("DEBUG PHONE_ID:", phoneId ? phoneId : "UNDEFINED");

  if (!token || !phoneId) {
    console.log("BOT (no-send mode) ->", to, ":", text);
    myConsole.log({ to, text });
    return;
  }

  await sendText(to, text);
}

async function sendSpecialtiesMenu(wa_id) {
  const specialties = await listSpecialties();

  if (!specialties.length) {
    await clearState(wa_id);
    await safeSendText(
      wa_id,
      "En este momento no encontramos especialidades disponibles. Por favor intente nuevamente más tarde."
    );
    return false;
  }

  const lines = buildNumberedLines(specialties, (specialty) => specialty);
  await setState(wa_id, "PICK_SPECIALTY", { specialties });
  await safeSendText(
    wa_id,
    `Perfecto 😊\nSeleccione la especialidad que necesita:\n\n${lines}\n\nResponda con el número de la opción.`
  );
  return true;
}

async function sendDoctorsMenu(wa_id, specialty) {
  const doctors = await listDoctors(specialty);

  if (!doctors.length) {
    await sendSpecialtiesMenu(wa_id);
    await safeSendText(
      wa_id,
      `No encontré médicos disponibles para *${specialty}* en este momento. Le muestro nuevamente las especialidades disponibles.`
    );
    return false;
  }

  const lines = buildNumberedLines(doctors, (doctor) => doctor.full_name);
  await setState(wa_id, "PICK_DOCTOR", { specialty, doctors });
  await safeSendText(
    wa_id,
    `Muy bien. Para *${specialty}* estos son los médicos disponibles:\n\n${lines}\n\nResponda con el número del médico.`
  );
  return true;
}

async function suggestNearestAvailability(wa_id, temp) {
  const searchFrom = temp.search_from || getTegucigalpaTodayISO();
  const date = await findNextAvailableDate(temp.doctor_id, searchFrom);

  if (!date) {
    await setState(wa_id, "PICK_DOCTOR", {
      specialty: temp.specialty,
      doctors: temp.doctors || [],
    });
    await safeSendText(
      wa_id,
      `En este momento no encontré horarios disponibles para *${temp.doctor_name}*.\n\nPuede elegir otro médico o escribir 0 para volver al menú.`
    );
    return false;
  }

  const slots = await listFreeSlots(temp.doctor_id, date);
  if (!slots.length) {
    return suggestNearestAvailability(wa_id, {
      ...temp,
      search_from: getNextDateISO(date),
    });
  }

  const slotOptions = slots.map((slot) => ({
    slot_id: slot.id,
    time: String(slot.slot_time).slice(0, 8),
  }));

  const lines = buildNumberedLines(slotOptions, (slot) => formatTimeHuman(slot.time));
  const nextSearchFrom = getNextDateISO(date);

  await setState(wa_id, "PICK_TIME", {
    specialty: temp.specialty,
    doctors: temp.doctors || [],
    doctor_id: temp.doctor_id,
    doctor_name: temp.doctor_name,
    suggested_date: String(date).slice(0, 10),
    slotOptions,
    next_search_from: nextSearchFrom,
  });

  await safeSendText(
    wa_id,
    `Encontré la fecha más cercana disponible con *${temp.doctor_name}* 😊\n\n📅 ${formatDateHuman(date)}\n\nEstas son las horas disponibles:\n${lines}\n\nResponda con el número de la hora que prefiera.\nSi desea que le busque otro día cercano, escriba 9.`
  );
  return true;
}

function appointmentSummary(temp) {
  return `📅 ${formatDateHuman(temp.selected_date)}\n⏰ ${formatTimeHuman(temp.selected_time)}\n👨‍⚕️ ${temp.doctor_name}\n🩺 ${temp.specialty}${temp.reason ? `\n📝 Motivo: ${temp.reason}` : ""}`;
}

function formatAppointmentsList(appts) {
  return appts
    .map((appt, index) => {
      return `${index + 1}) ${formatDateHuman(appt.appt_date)} — ${formatTimeHuman(appt.appt_time)} — ${appt.doctor_name} (${appt.specialty})`;
    })
    .join("\n");
}

const ReceiveMessage = async (req, res) => {
  try {
    const entry = req.body?.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;

    const message = value?.messages?.[0];
    const wa_id = message?.from;

    res.send("EVENT_RECEIVED");

    if (!wa_id || !message) return;

    const text = getUserText(message);
    if (!text) return;

    console.log("FROM:", wa_id, "TEXT:", text);

    if (normalizeText(text) === "0") {
      await clearState(wa_id);
      await safeSendText(wa_id, `✅ Conversación reiniciada.\n\n${MENU_TEXT}`);
      return;
    }

    let current = await getState(wa_id);
    if (!current) {
      await setState(wa_id, "MENU", {});
      await safeSendText(wa_id, MENU_TEXT);
      return;
    }

    if (current.state === "MENU") {
      if (text === "1") {
        const patient = await getPatientByWaId(wa_id);

        if (!patient?.full_name) {
          await setState(wa_id, "REGISTER_NAME", {});
          await safeSendText(wa_id, "Antes de continuar, por favor escriba su nombre completo.");
          return;
        }

        if (!patient?.identity_number) {
          await setState(wa_id, "REGISTER_IDENTITY", { full_name: patient.full_name });
          await safeSendText(wa_id, "Gracias. Ahora escriba su número de identidad.");
          return;
        }

        await sendSpecialtiesMenu(wa_id);
        return;
      }

      if (text === "2") {
        const appts = await listMyAppointments(wa_id);

        if (!appts.length) {
          await safeSendText(
            wa_id,
            "No encontré citas registradas a su nombre.\n\nSi desea agendar una, escriba 1."
          );
          return;
        }

        await safeSendText(
          wa_id,
          `Estas son sus citas activas:\n\n${formatAppointmentsList(appts)}\n\nSi desea volver al menú, escriba 0.`
        );
        return;
      }

      if (text === "3") {
        const appts = await listMyAppointments(wa_id);

        if (!appts.length) {
          await safeSendText(
            wa_id,
            "No tiene citas activas para cancelar en este momento.\n\nSi desea agendar una nueva, escriba 1."
          );
          return;
        }

        await setState(wa_id, "CANCEL_PICK", { appointments: appts });
        await safeSendText(
          wa_id,
          `Seleccione la cita que desea cancelar:\n\n${formatAppointmentsList(appts)}\n\nResponda con el número de la cita.`
        );
        return;
      }

      await safeSendText(wa_id, `No entendí esa opción.\n\n${MENU_TEXT}`);
      return;
    }

    if (current.state === "REGISTER_NAME") {
      await setState(wa_id, "REGISTER_IDENTITY", { full_name: text });
      await safeSendText(wa_id, "Perfecto. Ahora escriba su número de identidad.");
      return;
    }

    if (current.state === "REGISTER_IDENTITY") {
      const full_name = current.temp.full_name || null;
      const identity_number = text;

      await upsertPatient({ wa_id, full_name, identity_number });
      await safeSendText(wa_id, "Sus datos fueron guardados correctamente ✅");
      await sendSpecialtiesMenu(wa_id);
      return;
    }

    if (current.state === "PICK_SPECIALTY") {
      const option = parseNumericOption(text);
      const specialties = current.temp.specialties || [];
      const specialty = specialties[option - 1];

      if (!option || !specialty) {
        await safeSendText(wa_id, "Especialidad inválida. Por favor responda con uno de los números mostrados.");
        return;
      }

      await sendDoctorsMenu(wa_id, specialty);
      return;
    }

    if (current.state === "PICK_DOCTOR") {
      const option = parseNumericOption(text);
      const doctors = current.temp.doctors || [];
      const doctor = doctors[option - 1];

      if (!option || !doctor) {
        await safeSendText(wa_id, "Médico inválido. Por favor responda con el número correcto.");
        return;
      }

      await suggestNearestAvailability(wa_id, {
        specialty: current.temp.specialty,
        doctors,
        doctor_id: doctor.id,
        doctor_name: doctor.full_name,
        search_from: getTegucigalpaTodayISO(),
      });
      return;
    }

    if (current.state === "PICK_TIME") {
      if (isAnotherDay(text)) {
        await suggestNearestAvailability(wa_id, {
          specialty: current.temp.specialty,
          doctors: current.temp.doctors || [],
          doctor_id: current.temp.doctor_id,
          doctor_name: current.temp.doctor_name,
          search_from: current.temp.next_search_from,
        });
        return;
      }

      const option = parseNumericOption(text);
      const slot = (current.temp.slotOptions || [])[option - 1];

      if (!option || !slot) {
        await safeSendText(
          wa_id,
          "Hora inválida. Responda con el número de la hora o escriba 9 para que le busque otro día cercano."
        );
        return;
      }

      await setState(wa_id, "PICK_REASON", {
        specialty: current.temp.specialty,
        doctors: current.temp.doctors || [],
        doctor_id: current.temp.doctor_id,
        doctor_name: current.temp.doctor_name,
        selected_date: current.temp.suggested_date,
        selected_time: slot.time,
        slot_id: slot.slot_id,
        next_search_from: current.temp.next_search_from,
      });

      await safeSendText(
        wa_id,
        `Ha elegido:\n\n📅 ${formatDateHuman(current.temp.suggested_date)}\n⏰ ${formatTimeHuman(slot.time)}\n👨‍⚕️ ${current.temp.doctor_name}\n\nSi desea, puede escribir brevemente el motivo de la cita.\nSi prefiere omitirlo, escriba NO.`
      );
      return;
    }

    if (current.state === "PICK_REASON") {
      const normalized = normalizeText(text);
      const reason = ["no", "na", "ninguno", "omitir"].includes(normalized) ? null : text;

      const nextTemp = {
        ...current.temp,
        reason,
      };

      await setState(wa_id, "CONFIRM", nextTemp);
      await safeSendText(
        wa_id,
        `Por favor confirme su cita:\n\n${appointmentSummary(nextTemp)}\n\n1) Confirmar cita\n2) Ver otro día cercano\n3) Cancelar solicitud`
      );
      return;
    }

    if (current.state === "CONFIRM") {
      if (text === "3" || normalizeText(text) === "cancelar") {
        await clearState(wa_id);
        await safeSendText(wa_id, `Solicitud cancelada.\n\n${MENU_TEXT}`);
        return;
      }

      if (text === "2" || isAnotherDay(text)) {
        await suggestNearestAvailability(wa_id, {
          specialty: current.temp.specialty,
          doctors: current.temp.doctors || [],
          doctor_id: current.temp.doctor_id,
          doctor_name: current.temp.doctor_name,
          search_from: current.temp.next_search_from,
        });
        return;
      }

      if (!isYes(text)) {
        await safeSendText(wa_id, "Por favor responda 1 para confirmar, 2 para ver otro día o 3 para cancelar.");
        return;
      }

      const patient = await getPatientByWaId(wa_id);

      const result = await bookAppointment({
        wa_id,
        full_name: patient?.full_name || null,
        identity_number: patient?.identity_number || null,
        doctor_id: current.temp.doctor_id,
        slot_id: current.temp.slot_id,
        reason: current.temp.reason,
      });

      await setState(wa_id, "AFTER_BOOKING", {});
      await safeSendText(
        wa_id,
        `Su cita fue agendada con éxito ✅\n\n📅 ${formatDateHuman(result.appointment.appt_date)}\n⏰ ${formatTimeHuman(result.appointment.appt_time)}\n👨‍⚕️ ${current.temp.doctor_name}\n\nLe recomendamos llegar 15 minutos antes.\n\n¿Desea agendar otra cita?\n1) Sí\n2) No`
      );
      return;
    }

    if (current.state === "AFTER_BOOKING") {
      if (isYes(text)) {
        await sendSpecialtiesMenu(wa_id);
        return;
      }

      if (isNo(text)) {
        await clearState(wa_id);
        await safeSendText(wa_id, GOODBYE_TEXT);
        return;
      }

      await safeSendText(wa_id, "Por favor responda 1 para agendar otra cita o 2 para finalizar.");
      return;
    }

    if (current.state === "CANCEL_PICK") {
      const option = parseNumericOption(text);
      const appointment = (current.temp.appointments || [])[option - 1];

      if (!option || !appointment) {
        await safeSendText(wa_id, "Opción inválida. Responda con el número de la cita que desea cancelar.");
        return;
      }

      try {
        await cancelAppointment(wa_id, appointment.id);
        await clearState(wa_id);
        await safeSendText(
          wa_id,
          `La cita fue cancelada correctamente ✅\n\n📅 ${formatDateHuman(appointment.appt_date)}\n⏰ ${formatTimeHuman(appointment.appt_time)}\n👨‍⚕️ ${appointment.doctor_name}`
        );
      } catch (e) {
        await safeSendText(wa_id, "No pude cancelar esa cita en este momento. Intente nuevamente o escriba 0 para volver al menú.");
      }
      return;
    }

    await clearState(wa_id);
    await safeSendText(wa_id, `Reinicié la conversación para ayudarle mejor.\n\n${MENU_TEXT}`);
  } catch (e) {
    console.log("Webhook error:", e?.response?.data || e);
  }
};

module.exports = { VerifyToken, ReceiveMessage, getUserText };
