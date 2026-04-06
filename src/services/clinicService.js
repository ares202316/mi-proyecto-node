const pool = require("../db");

async function listSpecialties() {
  const r = await pool.query(
    `SELECT DISTINCT specialty
     FROM doctors
     WHERE active = true
       AND specialty IS NOT NULL
       AND TRIM(specialty) <> ''
     ORDER BY specialty`
  );
  return r.rows.map((row) => row.specialty);
}

async function listDoctors(specialty = null) {
  const params = [];
  let sql =
    `SELECT id, full_name, specialty
     FROM doctors
     WHERE active = true`;

  if (specialty) {
    params.push(specialty);
    sql += ` AND specialty = $${params.length}`;
  }

  sql += ` ORDER BY specialty, full_name`;

  const r = await pool.query(sql, params);
  return r.rows;
}

async function getDoctorById(doctor_id) {
  const r = await pool.query(
    `SELECT id, full_name, specialty
     FROM doctors
     WHERE id = $1 AND active = true`,
    [doctor_id]
  );
  return r.rows[0] || null;
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

async function findNextAvailableDate(doctor_id, fromDate) {
  const r = await pool.query(
    `SELECT slot_date
     FROM doctor_slots
     WHERE doctor_id = $1
       AND slot_date >= $2
       AND status = 'FREE'
     ORDER BY slot_date ASC, slot_time ASC
     LIMIT 1`,
    [doctor_id, fromDate]
  );

  if (!r.rowCount) return null;
  return r.rows[0].slot_date;
}

async function getPatientByWaId(wa_id) {
  const r = await pool.query(
    `SELECT id, wa_id, full_name, identity_number
     FROM patients
     WHERE wa_id=$1`,
    [wa_id]
  );
  return r.rows[0] || null;
}

async function upsertPatient({ wa_id, full_name = null, identity_number = null }) {
  const r = await pool.query(
    `INSERT INTO patients (wa_id, full_name, identity_number)
     VALUES ($1,$2,$3)
     ON CONFLICT (wa_id)
     DO UPDATE SET
       full_name = COALESCE(EXCLUDED.full_name, patients.full_name),
       identity_number = COALESCE(EXCLUDED.identity_number, patients.identity_number)
     RETURNING id, wa_id, full_name, identity_number`,
    [wa_id, full_name, identity_number]
  );
  return r.rows[0];
}

async function bookAppointment({ wa_id, full_name, identity_number, doctor_id, slot_id, reason }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const p = await client.query(
      `INSERT INTO patients (wa_id, full_name, identity_number)
       VALUES ($1, $2, $3)
       ON CONFLICT (wa_id)
       DO UPDATE SET
         full_name = COALESCE(EXCLUDED.full_name, patients.full_name),
         identity_number = COALESCE(EXCLUDED.identity_number, patients.identity_number)
       RETURNING id, wa_id, full_name, identity_number`,
      [wa_id, full_name || null, identity_number || null]
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

async function listMyAppointments(wa_id) {
  const r = await pool.query(
    `SELECT 
        a.id,
        a.appt_date,
        a.appt_time,
        a.status,
        a.slot_id,
        d.full_name AS doctor_name,
        d.specialty
     FROM appointments a
     JOIN patients p ON p.id = a.patient_id
     JOIN doctors d ON d.id = a.doctor_id
     WHERE p.wa_id = $1
       AND a.status <> 'CANCELLED'
     ORDER BY a.appt_date, a.appt_time`,
    [wa_id]
  );
  return r.rows;
}

async function cancelAppointment(wa_id, appointment_id) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const a = await client.query(
      `SELECT a.id, a.slot_id, a.status
       FROM appointments a
       JOIN patients p ON p.id = a.patient_id
       WHERE a.id = $1 AND p.wa_id = $2
       FOR UPDATE`,
      [appointment_id, wa_id]
    );

    if (a.rowCount === 0) throw new Error("APPOINTMENT_NOT_FOUND");
    if (a.rows[0].status === "CANCELLED") throw new Error("APPOINTMENT_ALREADY_CANCELLED");

    await client.query(
      `UPDATE appointments
       SET status = 'CANCELLED'
       WHERE id = $1`,
      [appointment_id]
    );

    if (a.rows[0].slot_id) {
      await client.query(
        `UPDATE doctor_slots
         SET status = 'FREE'
         WHERE id = $1`,
        [a.rows[0].slot_id]
      );
    }

    await client.query("COMMIT");
    return true;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

module.exports = {
  listSpecialties,
  listDoctors,
  getDoctorById,
  listFreeSlots,
  findNextAvailableDate,
  getPatientByWaId,
  upsertPatient,
  bookAppointment,
  listMyAppointments,
  cancelAppointment
};
