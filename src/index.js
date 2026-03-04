require("dotenv").config();
const express = require("express");
const apiRoute = require("./routes/routes");
const { sendText } = require("./services/whatsappSend");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use("/whatsapp", apiRoute);

app.listen(PORT, () => {
  console.log("el puerto es: " + PORT);
});

const pool = require("./db");

app.get("/db-test", async (req, res) => {
  try {
    const r = await pool.query("SELECT NOW() as now");
    res.json(r.rows[0]);
  } catch (e) {
    console.log(e);
    res.status(500).json({ error: "DB connection failed" });
  }
});

app.get("/doctors", async (req, res) => {
  const r = await pool.query("SELECT * FROM doctors WHERE active=true ORDER BY id");
  res.json(r.rows);
});



// Slots libres de un doctor por fecha (YYYY-MM-DD)
app.get("/doctors/:id/slots", async (req, res) => {
  try {
    const doctorId = parseInt(req.params.id, 10);
    const date = req.query.date; // ej: 2026-03-04

    if (!date) return res.status(400).json({ error: "date is required (YYYY-MM-DD)" });

    const r = await pool.query(
      `SELECT id, slot_date, slot_time, status
       FROM doctor_slots
       WHERE doctor_id = $1 AND slot_date = $2 AND status = 'FREE'
       ORDER BY slot_time`,
      [doctorId, date]
    );

    res.json(r.rows);
  } catch (e) {
    console.log(e);
    res.status(500).json({ error: "failed" });
  }
});

app.post("/patients", async (req, res) => {
  try {
    const { wa_id, full_name } = req.body;
    if (!wa_id) return res.status(400).json({ error: "wa_id required" });

    const r = await pool.query(
      `INSERT INTO patients (wa_id, full_name)
       VALUES ($1, $2)
       ON CONFLICT (wa_id) DO UPDATE SET full_name = COALESCE(EXCLUDED.full_name, patients.full_name)
       RETURNING *`,
      [wa_id, full_name || null]
    );

    res.json(r.rows[0]);
  } catch (e) {
    console.log(e);
    res.status(500).json({ error: "failed" });
  }
});



app.get("/send-test", async (req, res) => {
  try {
    const to = req.query.to; // 504xxxxxxxx
    await sendText(to, "✅ Mensaje de prueba desde mi bot (Railway)");
    res.send("OK");
  } catch (e) {
    console.log(e?.response?.data || e);
    res.status(500).json(e?.response?.data || { error: String(e) });
  }
});

app.post("/appointments", async (req, res) => {
  const client = await pool.connect();
  try {
    const { wa_id, full_name, doctor_id, slot_id, reason } = req.body;

    if (!wa_id || !doctor_id || !slot_id) {
      return res.status(400).json({ error: "wa_id, doctor_id, slot_id required" });
    }

    await client.query("BEGIN");

    // 1) Crear/actualizar paciente
    const p = await client.query(
      `INSERT INTO patients (wa_id, full_name)
       VALUES ($1, $2)
       ON CONFLICT (wa_id) DO UPDATE SET full_name = COALESCE(EXCLUDED.full_name, patients.full_name)
       RETURNING id, wa_id, full_name`,
      [wa_id, full_name || null]
    );
    const patientId = p.rows[0].id;

    // 2) Bloquear el slot para evitar doble reserva
    const s = await client.query(
      `SELECT id, doctor_id, slot_date, slot_time, status
       FROM doctor_slots
       WHERE id = $1 AND doctor_id = $2
       FOR UPDATE`,
      [slot_id, doctor_id]
    );

    if (s.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "slot not found" });
    }

    if (s.rows[0].status !== "FREE") {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "slot already booked" });
    }

    // 3) Marcar como BOOKED
    await client.query(`UPDATE doctor_slots SET status='BOOKED' WHERE id=$1`, [slot_id]);

    // 4) Crear cita
    const a = await client.query(
      `INSERT INTO appointments (patient_id, doctor_id, slot_id, appt_date, appt_time, reason)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [patientId, doctor_id, slot_id, s.rows[0].slot_date, s.rows[0].slot_time, reason || null]
    );

    await client.query("COMMIT");
    return res.json({ patient: p.rows[0], appointment: a.rows[0] });
  } catch (e) {
    await client.query("ROLLBACK");
    console.log(e);
    return res.status(500).json({ error: "failed" });
  } finally {
    client.release();
  }
});