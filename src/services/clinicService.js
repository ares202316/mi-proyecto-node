const pool = require("../db");

async function listDoctors() {
  const r = await pool.query(
    "SELECT id, full_name, specialty FROM doctors WHERE active=true ORDER BY id"
  );
  return r.rows;
}

async function listFreeSlots(doctor_id, date) {
  const r = await pool.query(
    `SELECT id, slot_time
     FROM doctor_slots
     WHERE doctor_id=$1 AND slot_date=$2 AND status='FREE'
     ORDER BY slot_time`,
    [doctor_id, date]
  );
  return r.rows;
}

async function ensurePatient(wa_id, full_name = null) {
  const r = await pool.query(
    `INSERT INTO patients (wa_id, full_name)
     VALUES ($1,$2)
     ON CONFLICT (wa_id) DO UPDATE SET full_name = COALESCE(EXCLUDED.full_name, patients.full_name)
     RETURNING id, wa_id, full_name`,
    [wa_id, full_name]
  );
  return r.rows[0];
}

async function bookAppointment({ wa_id, full_name, doctor_id, slot_id, reason }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const p = await client.query(
      `INSERT INTO patients (wa_id, full_name)
       VALUES ($1, $2)
       ON CONFLICT (wa_id) DO UPDATE SET full_name = COALESCE(EXCLUDED.full_name, patients.full_name)
       RETURNING id, wa_id, full_name`,
      [wa_id, full_name || null]
    );
    const patientId = p.rows[0].id;

    const s = await client.query(
      `SELECT id, doctor_id, slot_date, slot_time, status
       FROM doctor_slots
       WHERE id=$1 AND doctor_id=$2
       FOR UPDATE`,
      [slot_id, doctor_id]
    );

    if (s.rowCount === 0) throw new Error("SLOT_NOT_FOUND");
    if (s.rows[0].status !== "FREE") throw new Error("SLOT_NOT_FREE");

    await client.query(`UPDATE doctor_slots SET status='BOOKED' WHERE id=$1`, [slot_id]);

    const a = await client.query(
      `INSERT INTO appointments (patient_id, doctor_id, slot_id, appt_date, appt_time, reason)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING id, appt_date, appt_time, status`,
      [patientId, doctor_id, slot_id, s.rows[0].slot_date, s.rows[0].slot_time, reason || null]
    );

    await client.query("COMMIT");
    return { patient: p.rows[0], appointment: a.rows[0], slot: s.rows[0] };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { listDoctors, listFreeSlots, ensurePatient, bookAppointment };